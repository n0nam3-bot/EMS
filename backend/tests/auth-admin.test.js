// Sign-in, accounts, staffing and the call lifecycle, through the real
// HTTP API against a real database, plus the property that matters most:
// one company's people can't see or change another company's records.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import pg from "pg";
import { applyMigrations, ensureRuntimeRole } from "../migrate.js";
import { hashPassword } from "../backend_passwords.js";

const ADMIN_URL = process.env.TEST_DATABASE_URL || "postgres://ems_app:dev_only_change_me@localhost:5432/ems_dispatch_test";
const RUNTIME_PASSWORD = "test_runtime_password";
const TA = "aaaaaaaa-1111-4111-8111-111111111111", TB = "bbbbbbbb-2222-4222-8222-222222222222";
const UA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", UB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PW = "correct-horse-battery";

let server, base;
const tokens = {};
async function call(method, path, body, token) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const login = (email, password = PW) => call("POST", "/auth/login", { email, password });

before(async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query("DROP SCHEMA public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await applyMigrations(admin, "./migrations");
  await ensureRuntimeRole(admin, RUNTIME_PASSWORD);
  const hash = await hashPassword(PW);
  for (const [t, u, name, email] of [[TA, UA, "Company A", "boss@a.test"], [TB, UB, "Company B", "boss@b.test"]]) {
    await admin.query("INSERT INTO tenants (tenant_id, legal_name, display_name, regulatory_state, regulatory_region, encryption_key_ref) VALUES ($1,$2,$2,'NY','x','k')", [t, name]);
    await admin.query("INSERT INTO protocol_sets (tenant_id, issuing_authority, version_label, effective_from) VALUES ($1,'REMAC','v1',CURRENT_DATE)", [t]);
    await admin.query("INSERT INTO certification_types (tenant_id, code, label, required_for_capability) VALUES ($1,'EMT-B','EMT-Basic',NULL), ($1,'PARAMEDIC','Paramedic','ALS')", [t]);
    await admin.query("INSERT INTO users (user_id, tenant_id, email, display_name, role, password_hash) VALUES ($1,$2,$3,'Boss','supervisor',$4)", [u, t, email, hash]);
    await admin.query("INSERT INTO crew_members (tenant_id, user_id, first_name, last_name) VALUES ($1,$2,'Boss','-')", [t, u]);
  }
  await admin.end();

  process.env.DATABASE_URL = ADMIN_URL.replace(/\/\/[^@]+@/, `//ems_app_runtime:${RUNTIME_PASSWORD}@`);
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-12345";
  process.env.VERCEL = "1"; // import the app without it listening or exiting
  const { default: app } = await import("../server.js");
  server = http.createServer(app).listen(0);
  base = `http://localhost:${server.address().port}/api`;
  tokens.a = (await login("boss@a.test")).body.token;
  tokens.b = (await login("boss@b.test")).body.token;
});
after(() => server?.close());

test("login: right password works, wrong or unknown fails with the same words", async () => {
  const ok = await login("BOSS@a.test");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.agency, "Company A");
  const wrong = await login("boss@a.test", "nope-nope-nope");
  const unknown = await login("nobody@a.test", "nope-nope-nope");
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test("requests without a session, or with a forged one, are refused", async () => {
  assert.equal((await call("GET", "/incidents")).status, 401);
  assert.equal((await call("GET", "/incidents", null, "not.a.token")).status, 401);
});

test("company A's admin sees and changes only company A's people", async () => {
  const a = await call("GET", "/users", null, tokens.a);
  const b = await call("GET", "/users", null, tokens.b);
  assert.deepEqual(a.body.map((u) => u.email), ["boss@a.test"]);
  assert.deepEqual(b.body.map((u) => u.email), ["boss@b.test"]);
  const poke = await call("PATCH", `/users/${UB}`, { role: "crew" }, tokens.a);
  assert.equal(poke.status, 404, "another company's user must look like it doesn't exist");
  const inc = await call("POST", "/incidents", { incidentType: "emergency_911", priority: "critical", sceneAddress: "1 A Street" }, tokens.a);
  assert.equal(inc.status, 201);
  assert.equal((await call("GET", "/incidents", null, tokens.b)).body.length, 0, "B must not see A's call");
  assert.equal((await call("PATCH", `/incidents/${inc.body.incident_id}`, { notes: "hijack" }, tokens.b)).status, 404);
  assert.equal((await call("POST", `/incidents/${inc.body.incident_id}/cancel`, { reason: "hijack" }, tokens.b)).status, 404);
});

test("staffing: ALS needs a certification; the crew member then knows their own unit and can report only its GPS", async () => {
  const made = await call("POST", "/users", { email: "crew@a.test", displayName: "Casey Medic", role: "crew", password: PW, employeeNumber: "4471" }, tokens.a);
  assert.equal(made.status, 201);
  const als = (await call("POST", "/units", { designation: "Medic 1", capabilityLevel: "ALS" }, tokens.a)).body;
  const bls = (await call("POST", "/units", { designation: "Ambulance 2", capabilityLevel: "BLS" }, tokens.a)).body;
  const put = (unitId) => call("PUT", `/crew/${made.body.crew_member_id}/unit`, { unitId, seatRole: "driver" }, tokens.a);
  assert.equal((await put(als.unit_id)).status, 409, "no ALS certification yet");
  const type = (await call("GET", "/certification-types", null, tokens.a)).body.find((t) => t.code === "PARAMEDIC");
  assert.equal((await call("POST", "/certifications", { crewMemberId: made.body.crew_member_id, certificationTypeId: type.certification_type_id, issuingBody: "NY DOH", issuedOn: "2025-01-01", expiresOn: "2030-01-01" }, tokens.a)).status, 201);
  assert.equal((await put(als.unit_id)).status, 200);

  const crew = (await login("crew@a.test")).body.token;
  const me = await call("GET", "/auth/me", null, crew);
  assert.equal(me.body.unit.unit_designation, "Medic 1");
  assert.equal((await call("PATCH", `/units/${als.unit_id}/location`, { lat: 40.85, lon: -73.89 }, crew)).status, 200);
  assert.equal((await call("PATCH", `/units/${bls.unit_id}/location`, { lat: 40.85, lon: -73.89 }, crew)).status, 403);
  assert.equal((await call("GET", "/users", null, crew)).status, 403, "crew can't manage accounts");
  assert.equal((await call("PATCH", `/units/${als.unit_id}/status`, { status: "en_route" }, crew)).status, 200, "crew can update their own unit");
  assert.equal((await call("PATCH", `/units/${bls.unit_id}/status`, { status: "en_route" }, crew)).status, 403, "...but not another unit");
  assert.equal((await call("PATCH", `/units/${als.unit_id}/status`, { status: "available" }, crew)).status, 200);
  const inc = (await call("POST", "/incidents", { incidentType: "emergency_911", priority: "urgent", sceneAddress: "9 Review St" }, tokens.a)).body;
  assert.equal((await call("POST", "/pcr", { incidentId: inc.incident_id }, crew)).status, 201);
  assert.equal((await call("GET", "/pcr-review", null, crew)).status, 403, "crew can't open the review queue");
  const queue = await call("GET", "/pcr-review", null, tokens.a);
  assert.equal(queue.status, 200);
  assert.equal(queue.body.length, 1);
  assert.ok(queue.body[0].failed.includes("has_vitals"));
  assert.equal((await call("GET", "/pcr-review", null, tokens.b)).body.length, 0, "B can't see A's charts");
});

test("a call can be corrected and cancelled; cancelling frees its units", async () => {
  const units = (await call("GET", "/units", null, tokens.a)).body;
  const medic = units.find((u) => u.unit_designation === "Medic 1");
  assert.equal((await call("POST", "/incidents", { incidentType: "ift_on_demand", priority: "urgent", sceneAddress: "" }, tokens.a)).status, 400);
  const inc = (await call("POST", "/incidents", { incidentType: "ift_on_demand", priority: "urgent", capabilityNeeded: "ALS", sceneAddress: "BronxCare", sceneDetail: "Room 412", patientName: "J. Doe", lat: 40.84, lon: -73.91 }, tokens.a)).body;
  const fixed = await call("PATCH", `/incidents/${inc.incident_id}`, { sceneAddress: "1650 Grand Concourse", sceneDetail: "Lobby", lat: 40.842, lon: -73.912 }, tokens.a);
  assert.equal(fixed.body.scene_address, "1650 Grand Concourse");
  assert.equal(fixed.body.patient_name, "J. Doe", "fields that weren't sent stay as they were");
  assert.equal((await call("POST", `/incidents/${inc.incident_id}/assignments`, { unitId: medic.unit_id, role: "primary" }, tokens.a)).status, 201);
  assert.equal((await call("POST", `/incidents/${inc.incident_id}/cancel`, { reason: "" }, tokens.a)).status, 400, "a reason is required");
  const cancelled = await call("POST", `/incidents/${inc.incident_id}/cancel`, { reason: "Facility cancelled" }, tokens.a);
  assert.ok(cancelled.body.cancelled_at);
  assert.equal((await call("PATCH", `/incidents/${inc.incident_id}`, { notes: "late" }, tokens.a)).status, 409);
  const after = (await call("GET", "/units", null, tokens.a)).body.find((u) => u.unit_designation === "Medic 1");
  assert.equal(after.current_status, "available");
});

test("deactivating someone ends their session at once, and 8 bad passwords lock the account", async () => {
  const t = (await login("crew@a.test")).body.token;
  const uid = (await call("GET", "/users", null, tokens.a)).body.find((u) => u.email === "crew@a.test").user_id;
  assert.equal((await call("PATCH", `/users/${uid}`, { isActive: false }, tokens.a)).status, 200);
  assert.equal((await call("GET", "/units", null, t)).status, 401);
  assert.equal((await login("crew@a.test")).status, 401);
  assert.equal((await call("PATCH", `/users/${UA}`, { isActive: false }, tokens.a)).status, 400, "can't lock yourself out");
  for (let i = 0; i < 8; i++) await login("boss@b.test", `bad-password-${i}`);
  assert.equal((await login("boss@b.test")).status, 429);
});
