// Dispatch reliability (Sprint 1): the call/unit lifecycle through the real HTTP API against a real
// database. Needs TEST_DATABASE_URL pointing at a DISPOSABLE database: this suite drops schema public.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import pg from "pg";
import { applyMigrations, ensureRuntimeRole } from "../migrate.js";

const ADMIN_URL = process.env.TEST_DATABASE_URL || "postgres://ems_app:dev_only_change_me@localhost:5432/ems_dispatch_test";
const RUNTIME_PASSWORD = "test_runtime_password";
const TA = "aaaaaaaa-1111-4111-8111-111111111111", TB = "bbbbbbbb-2222-4222-8222-222222222222";
const SUP = "aaaaaaaa-1111-4111-8111-00000000a001", DISP = "aaaaaaaa-1111-4111-8111-00000000a002", CREW = "aaaaaaaa-1111-4111-8111-00000000a003", SUP_B = "bbbbbbbb-2222-4222-8222-00000000b001";

let server, base, admin, signSession;
const tok = {};

async function call(method, path, body, token) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}
const q = async (sql, p) => (await admin.query(sql, p)).rows;
async function newUnit(name, cap = "BLS", status = "available", tenant = TA) {
  const v = (await q("INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1,$2,$3) RETURNING vehicle_id", [tenant, name, cap]))[0];
  return (await q("INSERT INTO units (tenant_id, vehicle_id, current_status) VALUES ($1,$2,$3) RETURNING unit_id", [tenant, v.vehicle_id, status]))[0].unit_id;
}
const newCall = async (addr = "1 Test St", token = tok.sup) => (await call("POST", "/incidents", { incidentType: "emergency_911", priority: "urgent", sceneAddress: addr }, token)).body.incident_id;
const statusOf = async (u) => (await q("SELECT current_status FROM units WHERE unit_id = $1", [u]))[0].current_status;

before(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query("DROP SCHEMA public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await applyMigrations(admin, "./migrations");
  await ensureRuntimeRole(admin, RUNTIME_PASSWORD);
  for (const [t, name] of [[TA, "Company A"], [TB, "Company B"]]) {
    await admin.query("INSERT INTO tenants (tenant_id, legal_name, display_name, regulatory_state, regulatory_region, encryption_key_ref) VALUES ($1,$2,$2,'NY','x','k')", [t, name]);
    await admin.query("INSERT INTO protocol_sets (tenant_id, issuing_authority, version_label, effective_from) VALUES ($1,'REMAC','v1',CURRENT_DATE)", [t]);
  }
  for (const [id, t, role, email] of [[SUP, TA, "supervisor", "s@a.test"], [DISP, TA, "dispatcher", "d@a.test"], [CREW, TA, "crew", "c@a.test"], [SUP_B, TB, "supervisor", "s@b.test"]]) {
    await admin.query("INSERT INTO users (user_id, tenant_id, email, display_name, role) VALUES ($1,$2,$3,$3,$4)", [id, t, email, role]);
  }
  process.env.DATABASE_URL = ADMIN_URL.replace(/\/\/[^@]+@/, `//ems_app_runtime:${RUNTIME_PASSWORD}@`);
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-12345";
  process.env.VERCEL = "1";
  ({ signSession } = await import("../backend_auth.js"));
  const { default: app } = await import("../server.js");
  server = http.createServer(app).listen(0);
  base = `http://localhost:${server.address().port}/api`;
  tok.sup = signSession({ userId: SUP, tenantId: TA }).token;
  tok.disp = signSession({ userId: DISP, tenantId: TA }).token;
  tok.crew = signSession({ userId: CREW, tenantId: TA }).token;
  tok.supB = signSession({ userId: SUP_B, tenantId: TB }).token;
});
after(async () => { server?.close(); await admin?.end(); });

test("a call's whole lifecycle: intake, assign, en route, on scene, transporting, at destination, clear, complete, with a timeline and incident-stamped history", async () => {
  const unit = await newUnit("Life 1");
  const inc = await newCall("Lifecycle Ave");
  assert.equal((await q("SELECT dispatched_at FROM incidents WHERE incident_id = $1", [inc]))[0].dispatched_at, null);
  assert.equal((await call("POST", `/incidents/${inc}/assignments`, { unitId: unit, role: "primary" }, tok.disp)).status, 201);
  assert.ok((await q("SELECT dispatched_at FROM incidents WHERE incident_id = $1", [inc]))[0].dispatched_at, "dispatched_at is set on the first assignment");
  for (const s of ["en_route", "on_scene", "transporting", "at_destination"]) {
    const r = await call("PATCH", `/units/${unit}/status`, { status: s }, tok.disp);
    assert.equal(r.status, 200, `${s}: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await call("PATCH", `/units/${unit}/status`, { status: "available" }, tok.disp)).status, 200, "clearing from at destination");
  assert.equal(await statusOf(unit), "available");
  assert.deepEqual(await q("SELECT 1 FROM incident_unit_assignments WHERE unit_id = $1 AND unassigned_at IS NULL", [unit]), [], "clearing ends the unit's assignment");
  assert.equal((await call("POST", `/incidents/${inc}/complete`, {}, tok.disp)).status, 200);

  const events = (await call("GET", `/incidents/${inc}/events`, null, tok.disp)).body;
  assert.deepEqual(events.map((e) => e.kind), ["call_received", "unit_assigned", "unit_en_route", "unit_on_scene", "unit_transporting", "unit_at_destination", "unit_cleared", "call_closed"]);
  assert.ok(events.every((e) => e.actor), "every event names who did it");
  assert.equal(events[1].unit_designation, "Life 1");
  const hist = await q("SELECT status, incident_id FROM unit_status_history WHERE unit_id = $1 ORDER BY recorded_at, history_id", [unit]);
  assert.deepEqual(hist.map((h) => h.status), ["assigned", "en_route", "on_scene", "transporting", "at_destination", "available"]);
  assert.ok(hist.every((h) => h.incident_id === inc), "field status changes carry the call, so response times can be reported per incident");
});

test("the server refuses to assign a unit that is out of service, busy, or to a call that is closed or not found", async () => {
  const oos = await newUnit("Guard OOS", "BLS", "out_of_service");
  const ok = await newUnit("Guard OK");
  const inc = await newCall("Guard St");
  assert.equal((await call("POST", `/incidents/${inc}/assignments`, { unitId: oos, role: "primary" }, tok.disp)).status, 409, "out of service");
  assert.equal(await statusOf(oos), "out_of_service", "a refusal leaves no trace");
  assert.equal((await call("POST", `/incidents/${inc}/assignments`, { unitId: ok, role: "primary" }, tok.disp)).status, 201);
  const other = await newCall("Other St");
  assert.equal((await call("POST", `/incidents/${other}/assignments`, { unitId: ok, role: "primary" }, tok.disp)).status, 409, "already on a call");
  assert.equal((await call("POST", `/incidents/${other}/assignments`, { unitId: "00000000-0000-4000-8000-000000000000", role: "primary" }, tok.disp)).status, 404, "no such unit");
  assert.equal((await call("POST", `/incidents/${other}/assignments`, { unitId: ok, role: "wizard" }, tok.disp)).status, 400, "bad role is a 400, not a 500");
  await call("POST", `/incidents/${inc}/complete`, {}, tok.disp);
  const free = await newUnit("Guard Free");
  assert.equal((await call("POST", `/incidents/${inc}/assignments`, { unitId: free, role: "support" }, tok.disp)).status, 409, "closed call");
});

test("two dispatchers racing for one unit: exactly one wins", async () => {
  const unit = await newUnit("Race 1");
  const a = await newCall("Race A"), b = await newCall("Race B");
  const [r1, r2] = await Promise.all([call("POST", `/incidents/${a}/assignments`, { unitId: unit, role: "primary" }, tok.disp), call("POST", `/incidents/${b}/assignments`, { unitId: unit, role: "primary" }, tok.sup)]);
  assert.deepEqual([r1.status, r2.status].sort(), [201, 409]);
  assert.equal((await q("SELECT count(*)::int AS n FROM incident_unit_assignments WHERE unit_id = $1 AND unassigned_at IS NULL", [unit]))[0].n, 1);
});

test("status rules: a unit on a call can't be freed by flipping its status; backwards needs an override with a reason, which is audited", async () => {
  const unit = await newUnit("Rules 1");
  const idle = await newUnit("Rules idle");
  assert.equal((await call("PATCH", `/units/${idle}/status`, { status: "on_scene" }, tok.disp)).status, 409, "no call, so no on-scene");
  assert.equal((await call("PATCH", `/units/${idle}/status`, { status: "en_route" }, tok.disp)).status, 200, "a unit may move itself en route");
  const inc = await newCall("Rules St");
  await call("POST", `/incidents/${inc}/assignments`, { unitId: unit, role: "primary" }, tok.disp);
  await call("PATCH", `/units/${unit}/status`, { status: "on_scene" }, tok.disp);
  const free = await call("PATCH", `/units/${unit}/status`, { status: "available" }, tok.disp);
  assert.equal(free.status, 409);
  assert.match(free.body.error, /Release it|complete the call/);
  assert.equal((await call("PATCH", `/units/${unit}/status`, { status: "out_of_service" }, tok.disp)).status, 409);
  assert.equal((await call("PATCH", `/units/${unit}/status`, { status: "en_route" }, tok.disp)).status, 409, "backwards");
  assert.equal((await call("PATCH", `/units/${unit}/status`, { status: "en_route", override: true }, tok.disp)).status, 400, "an override needs a reason");
  const ov = await call("PATCH", `/units/${unit}/status`, { status: "en_route", override: true, reason: "Wrong button pressed" }, tok.disp);
  assert.equal(ov.status, 200);
  assert.equal(await statusOf(unit), "en_route");
  const evs = (await call("GET", `/incidents/${inc}/events`, null, tok.disp)).body;
  assert.equal(evs.at(-1).override_reason, "Wrong button pressed");
  const audit = await q("SELECT detail FROM audit_log WHERE action = 'override' AND record_id = $1", [unit]);
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0].detail.from, audit[0].detail.to], ["on_scene", "en_route"]);
  assert.equal(JSON.stringify(audit[0].detail).includes("Rules St"), false, "no call details in the audit entry");
  await call("POST", `/incidents/${inc}/complete`, {}, tok.disp);
  assert.equal(await statusOf(unit), "available", "completing the call is how the unit is freed");
});

test("a crew member can't override, and can only move their own unit", async () => {
  const unit = await newUnit("Crewed 1");
  const other = await newUnit("Crewed other");
  const cm = (await q("INSERT INTO crew_members (tenant_id, user_id, first_name, last_name, field_level) VALUES ($1,$2,'Cee','Crew','emt') RETURNING crew_member_id", [TA, CREW]))[0];
  await q("INSERT INTO unit_crew_assignments (tenant_id, unit_id, crew_member_id, seat_role) VALUES ($1,$2,$3,'driver')", [TA, unit, cm.crew_member_id]);
  const inc = await newCall("Crew St");
  await call("POST", `/incidents/${inc}/assignments`, { unitId: unit, role: "primary" }, tok.disp);
  assert.equal((await call("PATCH", `/units/${unit}/status`, { status: "en_route" }, tok.crew)).status, 200);
  assert.equal((await call("PATCH", `/units/${unit}/status`, { status: "available" }, tok.crew)).status, 409, "can't free itself mid-call");
  assert.equal((await call("PATCH", `/units/${unit}/status`, { status: "available", override: true, reason: "because" }, tok.crew)).status, 403);
  assert.equal((await call("PATCH", `/units/${other}/status`, { status: "en_route" }, tok.crew)).status, 403, "not their unit");
});

test("bringing a unit back into service needs its crew", async () => {
  const unit = await newUnit("Bare 1", "BLS", "out_of_service");
  const r = await call("PATCH", `/units/${unit}/status`, { status: "available" }, tok.disp);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /crew/);
  assert.equal((await call("PATCH", `/units/${unit}/status`, { status: "available", override: true, reason: "Crew on the way" }, tok.sup)).status, 200);
});

test("the board lists every open call however old, plus recently closed ones, and says when it was served", async () => {
  const oldOpen = await newCall("Old open IFT");
  await q("UPDATE incidents SET call_received_at = now() - interval '3 days' WHERE incident_id = $1", [oldOpen]);
  const proto = (await q("SELECT protocol_set_id FROM incidents WHERE incident_id = $1", [oldOpen]))[0].protocol_set_id;
  await q(`INSERT INTO incidents (tenant_id, incident_type, priority, protocol_set_id, scene_address, closed_at)
           SELECT $1, 'emergency_911', 'routine', $2, 'Old closed ' || g, now() - interval '48 hours' FROM generate_series(1, 120) g`, [TA, proto]);
  await q("INSERT INTO incidents (tenant_id, incident_type, priority, protocol_set_id, scene_address, closed_at) VALUES ($1,'emergency_911','routine',$2,'Just closed', now() - interval '1 hour')", [TA, proto]);
  const r = await call("GET", "/incidents", null, tok.disp);
  const addrs = r.body.map((i) => i.scene_address);
  assert.ok(addrs.includes("Old open IFT"), "an old open call must never drop off the board");
  assert.ok(addrs.includes("Just closed"));
  assert.ok(!addrs.some((a) => a.startsWith("Old closed")), "calls closed two days ago aren't on the board");
  assert.ok(!Number.isNaN(Date.parse(r.headers.get("x-server-time"))));
});

test("completing or cancelling a closed call is refused, and doesn't rewrite when it closed", async () => {
  const inc = await newCall("Closed once");
  assert.equal((await call("POST", `/incidents/${inc}/complete`, {}, tok.disp)).status, 200);
  const first = (await q("SELECT closed_at FROM incidents WHERE incident_id = $1", [inc]))[0].closed_at;
  assert.equal((await call("POST", `/incidents/${inc}/complete`, {}, tok.disp)).status, 409);
  assert.equal((await call("POST", `/incidents/${inc}/cancel`, { reason: "too late" }, tok.disp)).status, 409);
  assert.deepEqual((await q("SELECT closed_at FROM incidents WHERE incident_id = $1", [inc]))[0].closed_at, first);
});

test("cancelling releases the units and writes the timeline", async () => {
  const unit = await newUnit("Cancel 1");
  const inc = await newCall("Cancel St");
  await call("POST", `/incidents/${inc}/assignments`, { unitId: unit, role: "primary" }, tok.disp);
  assert.equal((await call("POST", `/incidents/${inc}/cancel`, { reason: "Caller cancelled" }, tok.disp)).status, 200);
  assert.equal(await statusOf(unit), "available");
  assert.deepEqual((await call("GET", `/incidents/${inc}/events`, null, tok.disp)).body.map((e) => e.kind), ["call_received", "unit_assigned", "unit_released", "call_cancelled"]);
});

test("another company can't see, assign onto, or move anything of this company's", async () => {
  const unit = await newUnit("Iso 1");
  const inc = await newCall("Iso St");
  await call("POST", `/incidents/${inc}/assignments`, { unitId: unit, role: "primary" }, tok.disp);
  assert.deepEqual((await call("GET", `/incidents/${inc}/events`, null, tok.supB)).body, []);
  const unitB = await newUnit("B unit", "BLS", "available", TB);
  assert.equal((await call("POST", `/incidents/${inc}/assignments`, { unitId: unitB, role: "support" }, tok.supB)).status, 404);
  assert.equal((await call("PATCH", `/units/${unit}/status`, { status: "on_scene" }, tok.supB)).status, 404);
  assert.equal((await call("POST", `/incidents/${inc}/complete`, {}, tok.supB)).status, 404);
  assert.equal((await call("GET", "/incidents", null, tok.supB)).body.some((i) => i.incident_id === inc), false);
});

test("the call timeline is append-only for the app's database login", async () => {
  const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await app.connect();
  try {
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_tenant_id', $1, true)", [TA]);
    await assert.rejects(() => app.query("UPDATE incident_events SET note = 'x'"), /permission denied/i);
    await assert.rejects(() => app.query("DELETE FROM incident_events"), /permission denied/i);
    await app.query("ROLLBACK");
  } finally { await app.end(); }
});
