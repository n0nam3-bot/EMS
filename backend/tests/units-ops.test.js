// Unit administration (rename, retire, vehicle numbers) and where a unit sits when its status is set by hand.
// Needs TEST_DATABASE_URL pointing at a DISPOSABLE database: this suite drops schema public.
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


const unitRow = async (token, id) => (await call("GET", "/units", null, token)).body.find((u) => u.unit_id === id);
const makeUnit = async (name, level = "BLS", token = tok.sup) => (await call("POST", "/units", { designation: name, capabilityLevel: level }, token)).body.unit_id;

test("a unit can be renamed; a name in use is refused; only supervisors can", async () => {
  const a = await makeUnit("Rename A"), b = await makeUnit("Rename B");
  const r = await call("PATCH", `/units/${a}`, { designation: "Medic 9" }, tok.sup);
  assert.equal(r.status, 200);
  assert.equal((await unitRow(tok.sup, a)).unit_designation, "Medic 9");
  assert.equal((await call("PATCH", `/units/${b}`, { designation: "medic 9" }, tok.sup)).status, 409, "case-insensitive duplicate");
  assert.equal((await call("PATCH", `/units/${a}`, { designation: "MEDIC 9" }, tok.sup)).status, 200, "changing only the case of its own name is fine");
  assert.equal((await call("PATCH", `/units/${a}`, { designation: "  " }, tok.sup)).status, 400);
  assert.equal((await call("PATCH", `/units/${a}`, { designation: "Nope" }, tok.disp)).status, 403);
});

test("changing a unit's level is refused while it has a crew", async () => {
  const u = await makeUnit("Level 1", "BLS");
  assert.equal((await call("PATCH", `/units/${u}`, { capabilityLevel: "ALS" }, tok.sup)).status, 200);
  assert.equal((await call("PATCH", `/units/${u}`, { capabilityLevel: "BLS" }, tok.sup)).status, 200);
  const cm = (await q("INSERT INTO crew_members (tenant_id, first_name, last_name, field_level) VALUES ($1,'Lee','Vel','emt') RETURNING crew_member_id", [TA]))[0];
  await q("INSERT INTO unit_crew_assignments (tenant_id, unit_id, crew_member_id, seat_role) VALUES ($1,$2,$3,'non_driver')", [TA, u, cm.crew_member_id]);
  const r = await call("PATCH", `/units/${u}`, { capabilityLevel: "ALS" }, tok.sup);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /crew/);
});

test("deleting a unit with no history removes it; one with history is retired and vanishes from the lists, and its name can be reused", async () => {
  const fresh = await makeUnit("Delete fresh");
  const r1 = await call("DELETE", `/units/${fresh}`, null, tok.sup);
  assert.deepEqual(r1.body, { removed: true, retired: false });
  assert.deepEqual(await q("SELECT 1 FROM units WHERE unit_id = $1", [fresh]), []);

  const used = await makeUnit("Delete used");
  await q("UPDATE units SET current_status = 'available' WHERE unit_id = $1", [used]);
  const inc = await newCall("Delete call");
  await call("POST", `/incidents/${inc}/assignments`, { unitId: used, role: "primary" }, tok.disp);
  assert.equal((await call("DELETE", `/units/${used}`, null, tok.sup)).status, 409, "on a call");
  await call("POST", `/incidents/${inc}/complete`, {}, tok.disp);
  const r2 = await call("DELETE", `/units/${used}`, null, tok.sup);
  assert.deepEqual(r2.body, { removed: true, retired: true });
  assert.equal(await unitRow(tok.sup, used), undefined, "gone from the unit list");
  assert.equal((await call("GET", "/unit-checks/status", null, tok.sup)).body.some((u) => u.unit_id === used), false);
  assert.equal((await call("GET", "/vehicles", null, tok.sup)).body.some((v) => v.unit_designation === "Delete used"), false);
  assert.ok((await q("SELECT 1 FROM unit_status_history WHERE unit_id = $1", [used])).length > 0, "history is kept");
  assert.notEqual((await call("POST", "/units", { designation: "Delete used", capabilityLevel: "BLS" }, tok.sup)).status, 409, "the name is free again");
  assert.equal((await call("DELETE", `/units/${used}`, null, tok.sup)).status, 404, "already gone");
  assert.equal((await call("DELETE", `/units/${used}`, null, tok.disp)).status, 403);
});

test("a unit with a crew on it can't be deleted", async () => {
  const u = await makeUnit("Delete crewed");
  const cm = (await q("INSERT INTO crew_members (tenant_id, first_name, last_name, field_level) VALUES ($1,'Del','Crew','emt') RETURNING crew_member_id", [TA]))[0];
  await q("INSERT INTO unit_crew_assignments (tenant_id, unit_id, crew_member_id, seat_role) VALUES ($1,$2,$3,'driver')", [TA, u, cm.crew_member_id]);
  const r = await call("DELETE", `/units/${u}`, null, tok.sup);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /crew/);
});

test("OPS can give a unit a vehicle number and swap it with a reason; the history is kept; one vehicle can't be on two units", async () => {
  const a = await makeUnit("Veh A"), b = await makeUnit("Veh B");
  assert.equal((await call("PUT", `/units/${a}/vehicle`, { vehicleNumber: "214" }, tok.disp)).status, 200, "a dispatcher can assign");
  assert.equal((await unitRow(tok.disp, a)).vehicle_number, "214");
  const clash = await call("PUT", `/units/${b}/vehicle`, { vehicleNumber: "214" }, tok.disp);
  assert.equal(clash.status, 409);
  assert.match(clash.body.error, /Veh A/);
  assert.equal((await call("PUT", `/units/${a}/vehicle`, { vehicleNumber: "310" }, tok.disp)).status, 400, "a swap needs a reason");
  const sw = await call("PUT", `/units/${a}/vehicle`, { vehicleNumber: "310", reason: "Mechanical: brakes" }, tok.disp);
  assert.equal(sw.status, 200);
  assert.equal(sw.body.previous_vehicle_number, "214");
  assert.equal((await call("PUT", `/units/${b}/vehicle`, { vehicleNumber: "214" }, tok.disp)).status, 200, "214 is free again");
  const hist = (await call("GET", `/units/${a}/vehicle-history`, null, tok.disp)).body;
  assert.deepEqual(hist.map((h) => [h.previous_vehicle_number, h.vehicle_number, h.reason]), [["214", "310", "Mechanical: brakes"], [null, "214", null]]);
  assert.equal((await call("PUT", `/units/${a}/vehicle`, { vehicleNumber: "999" }, tok.crew)).status, 403);
  assert.equal(await statusOf(a), "out_of_service", "swapping a vehicle doesn't touch the unit's service status");
});

test("vehicle numbers are per company", async () => {
  const a = await makeUnit("Veh iso");
  await call("PUT", `/units/${a}/vehicle`, { vehicleNumber: "777" }, tok.sup);
  const b = (await call("POST", "/units", { designation: "Veh iso", capabilityLevel: "BLS" }, tok.supB)).body.unit_id;
  assert.equal((await call("PUT", `/units/${b}/vehicle`, { vehicleNumber: "777" }, tok.supB)).status, 200);
  assert.equal((await call("PUT", `/units/${a}/vehicle`, { vehicleNumber: "1" }, tok.supB)).status, 404);
});

const withPins = async (name) => {
  const unit = await newUnit(name);
  const inc = (await call("POST", "/incidents", { incidentType: "ift_on_demand", priority: "urgent", sceneAddress: "Pickup Rd", lat: 40.80, lon: -73.90, destinationText: "Drop Hospital", destLat: 40.90, destLon: -73.80 }, tok.sup)).body.incident_id;
  await call("POST", `/incidents/${inc}/assignments`, { unitId: unit, role: "primary" }, tok.disp);
  return { unit, inc };
};
const where = async (unit) => (await q("SELECT ST_Y(current_location::geometry) AS lat, ST_X(current_location::geometry) AS lon, location_source FROM units WHERE unit_id = $1", [unit]))[0];

test("setting a status by hand puts the unit where it would be: pickup on scene, drop-off at destination", async () => {
  const { unit } = await withPins("Place 1");
  assert.equal((await where(unit)).lat, null, "no position before");
  await call("PATCH", `/units/${unit}/status`, { status: "en_route" }, tok.disp);
  assert.equal((await where(unit)).lat, null, "en route doesn't invent a position");
  const r = await call("PATCH", `/units/${unit}/status`, { status: "on_scene" }, tok.disp);
  assert.equal(r.body.moved_to, "pickup");
  let w = await where(unit);
  assert.ok(Math.abs(w.lat - 40.80) < 1e-6 && Math.abs(w.lon + 73.90) < 1e-6);
  assert.equal(w.location_source, "status");
  await call("PATCH", `/units/${unit}/status`, { status: "transporting" }, tok.disp);
  assert.ok(Math.abs((await where(unit)).lat - 40.80) < 1e-6, "still at the pickup as it leaves");
  const d = await call("PATCH", `/units/${unit}/status`, { status: "at_destination" }, tok.disp);
  assert.equal(d.body.moved_to, "drop-off");
  w = await where(unit);
  assert.ok(Math.abs(w.lat - 40.90) < 1e-6 && Math.abs(w.lon + 73.80) < 1e-6);
  assert.equal((await unitRow(tok.disp, unit)).location_source, "status", "the unit list says where the position came from");
});

test("a unit that is sending real GPS is not moved by a status change; a stale fix is", async () => {
  const { unit } = await withPins("Place GPS");
  await q("UPDATE units SET current_location = ST_SetSRID(ST_MakePoint(-73.5, 40.5), 4326)::geography, location_updated_at = now(), location_source = 'gps' WHERE unit_id = $1", [unit]);
  const r = await call("PATCH", `/units/${unit}/status`, { status: "on_scene" }, tok.disp);
  assert.equal(r.body.moved_to, null);
  assert.ok(Math.abs((await where(unit)).lat - 40.5) < 1e-6, "the GPS position stands");
  await q("UPDATE units SET location_updated_at = now() - interval '10 minutes' WHERE unit_id = $1", [unit]);
  await call("PATCH", `/units/${unit}/status`, { status: "transporting" }, tok.disp);
  assert.ok(Math.abs((await where(unit)).lat - 40.80) < 1e-6, "a fix 10 minutes old doesn't hold the unit away from the call");
});

test("no drop-off pin means no guessed position", async () => {
  const unit = await newUnit("Place none");
  const inc = (await call("POST", "/incidents", { incidentType: "emergency_911", priority: "urgent", sceneAddress: "Scene only", lat: 40.7, lon: -73.9 }, tok.sup)).body.incident_id;
  await call("POST", `/incidents/${inc}/assignments`, { unitId: unit, role: "primary" }, tok.disp);
  await call("PATCH", `/units/${unit}/status`, { status: "on_scene" }, tok.disp);
  await call("PATCH", `/units/${unit}/status`, { status: "transporting" }, tok.disp);
  const d = await call("PATCH", `/units/${unit}/status`, { status: "at_destination" }, tok.disp);
  assert.equal(d.body.moved_to, null);
  assert.ok(Math.abs((await where(unit)).lat - 40.7) < 1e-6, "stays at the pickup rather than being put somewhere invented");
});
