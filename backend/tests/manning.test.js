// Manning a unit: a vehicle goes with the crew. Through the real HTTP API against a real database.
//   - an unmanned unit can't be given a vehicle; the vehicle picker lists only vehicles that are in
//     service and free
//   - one person leaving keeps the vehicle; the last person leaving releases it (and the history says why)
//   - taking someone off the unit by deactivating them, or by taking them off the field, does the same
//     (and puts the unit back out of service: it used to stay "available" with nobody aboard)
//   - a unit that is mid-call is left alone, and a vehicle can always be taken off by hand
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import pg from "pg";
import { applyMigrations, ensureRuntimeRole } from "../migrate.js";
import { hashPassword } from "../backend_passwords.js";
import { hotp, base32Decode, stepAt } from "../backend_mfa.js";

const ADMIN_URL = process.env.TEST_DATABASE_URL || "postgres://ems_app:dev_only_change_me@localhost:5432/ems_dispatch_test";
const RUNTIME_PASSWORD = "test_runtime_password";
const TA = "aaaaaaaa-1111-4111-8111-111111111111", UA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PW = "correct-horse-battery";

// A code works once and the server remembers the last step used, so sign-ins move the clock forward.
const realNow = Date.now.bind(Date);
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const advance = () => { skewMs += 61_000; };
const codeFor = (secret) => hotp(base32Decode(secret), stepAt(Date.now()));

let server, base, admin, boss;
const secrets = new Map();

async function call(method, path, body, token) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function signIn(email) {
  const first = await call("POST", "/auth/login", { email, password: PW });
  if (first.status !== 200) return first;
  advance();
  if (first.body.step === "mfa_setup") {
    const setup = await call("POST", "/auth/mfa/setup", { challenge: first.body.challenge });
    secrets.set(email, setup.body.secret);
    return call("POST", "/auth/mfa/enable", { challenge: first.body.challenge, code: codeFor(setup.body.secret) });
  }
  return call("POST", "/auth/mfa/verify", { challenge: first.body.challenge, code: codeFor(secrets.get(email)) });
}
const q = async (sql, params) => (await admin.query(sql, params)).rows;

before(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query("DROP SCHEMA public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await applyMigrations(admin, "./migrations");
  await ensureRuntimeRole(admin, RUNTIME_PASSWORD);
  const hash = await hashPassword(PW);
  await admin.query("INSERT INTO tenants (tenant_id, legal_name, display_name, regulatory_state, regulatory_region, encryption_key_ref) VALUES ($1,'Company A','Company A','NY','x','k')", [TA]);
  await admin.query("INSERT INTO protocol_sets (tenant_id, issuing_authority, version_label, effective_from) VALUES ($1,'REMAC','v1',CURRENT_DATE)", [TA]);
  await admin.query("SELECT seed_tenant_defaults($1)", [TA]);
  await admin.query("INSERT INTO users (user_id, tenant_id, email, display_name, role, extra_roles, password_hash) VALUES ($1,$2,'boss@a.test','Boss','supervisor','{}',$3)", [UA, TA, hash]);
  await admin.query("INSERT INTO crew_members (tenant_id, user_id, first_name, last_name) VALUES ($1,$2,'Boss','-')", [TA, UA]);

  process.env.DATABASE_URL = ADMIN_URL.replace(/\/\/[^@]+@/, `//ems_app_runtime:${RUNTIME_PASSWORD}@`);
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-12345";
  process.env.VERCEL = "1"; // import the app without it listening or exiting
  const { default: app } = await import("../server.js");
  server = http.createServer(app).listen(0);
  base = `http://localhost:${server.address().port}/api`;
  const r = await signIn("boss@a.test");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  boss = r.body.token;
});
after(async () => { server?.close(); await admin?.end(); Date.now = realNow; });

// ---- small builders ---------------------------------------------------------------------------
let n = 0;
const person = async (level) => (await call("POST", "/users", { email: `p${++n}@a.test`, displayName: `Person ${n}`, roles: ["crew"], fieldLevel: level, password: PW }, boss)).body;
const unitOf = async (designation) => (await call("POST", "/units", { designation, capabilityLevel: "BLS" }, boss)).body;
const vehicleOf = async (number) => (await call("POST", "/fleet", { vehicleNumber: number }, boss)).body;
const seat = (who, unit, role = "non_driver") => call("PUT", `/crew/${who.crew_member_id}/unit`, { unitId: unit ? unit.unit_id : null, seatRole: role }, boss);
const unitRow = async (designation) => (await call("GET", "/units", null, boss)).body.find((u) => u.unit_designation === designation);
const putVehicle = (unit, vehicle, extra = {}) => call("PUT", `/units/${unit.unit_id}/vehicle`, { fleetVehicleId: vehicle ? vehicle.fleet_vehicle_id : null, ...extra }, boss);
const freeNumbers = async () => (await call("GET", "/fleet?available=1", null, boss)).body.map((f) => f.vehicle_number).sort();

// -----------------------------------------------------------------------------------------------
test("a vehicle goes with the crew: an unmanned unit can't be given one, the picker lists only free in-service vehicles, and the last person leaving releases it", async () => {
  const eli = await person("emt"), eve = await person("emt");
  const unit = await unitOf("BLS 9");
  const v1 = await vehicleOf("301"), v2 = await vehicleOf("302");

  // nobody aboard yet: refused, in words that point at the fix
  const early = await putVehicle(unit, v1);
  assert.equal(early.status, 409);
  assert.match(early.body.error, /crew/i);

  // an EMT in the driver seat is a full BLS crew
  assert.equal((await seat(eli, unit, "driver")).status, 200);
  assert.equal((await unitRow("BLS 9")).current_status, "available");
  assert.equal((await putVehicle(unit, v1)).status, 200);
  assert.equal((await unitRow("BLS 9")).vehicle_number, "301");

  // the picker's list: in service and not on a unit
  assert.deepEqual(await freeNumbers(), ["302"], "301 is on a unit");
  assert.equal((await call("POST", `/fleet/${v2.fleet_vehicle_id}/out-of-service`, { reason: "Brakes" }, boss)).status, 200);
  assert.deepEqual(await freeNumbers(), [], "302 is out of service, so it can't be picked");
  const refused = await putVehicle(unit, v2);
  assert.equal(refused.status, 409, "and the server refuses it too");
  assert.match(refused.body.error, /out of service/i);
  assert.equal((await call("POST", `/fleet/${v2.fleet_vehicle_id}/return-to-service`, {}, boss)).status, 200);

  // one person leaving keeps the vehicle: somebody is still aboard
  assert.equal((await seat(eve, unit)).status, 200);
  assert.equal((await seat(eve, null)).status, 200);
  assert.equal((await unitRow("BLS 9")).vehicle_number, "301");

  // the last person leaving releases it, frees it for others, and the history says who and why
  assert.equal((await seat(eli, null)).status, 200);
  const after = await unitRow("BLS 9");
  assert.deepEqual([after.current_status, after.fleet_vehicle_id, after.vehicle_number], ["out_of_service", null, null]);
  assert.deepEqual(await freeNumbers(), ["301", "302"], "the vehicle is free again");
  const log = (await q("SELECT from_vehicle_id, to_vehicle_id, reason, by_user_id FROM unit_vehicle_log WHERE unit_id = $1 ORDER BY log_id DESC LIMIT 1", [unit.unit_id]))[0];
  assert.equal(log.from_vehicle_id, v1.fleet_vehicle_id);
  assert.equal(log.to_vehicle_id, null);
  assert.match(log.reason, /crew/i);
  assert.equal(log.by_user_id, UA, "it records who took the crew off");
});

test("deactivating the only crew member, or taking them off the field, puts the unit out of service and frees its vehicle", async () => {
  const a = await person("emt"), b = await person("emt");
  const ua = await unitOf("BLS 10"), ub = await unitOf("BLS 11");
  const va = await vehicleOf("303"), vb = await vehicleOf("304");
  for (const [who, unit, veh] of [[a, ua, va], [b, ub, vb]]) {
    assert.equal((await seat(who, unit, "driver")).status, 200);
    assert.equal((await putVehicle(unit, veh)).status, 200);
  }
  assert.equal((await unitRow("BLS 10")).current_status, "available");

  assert.equal((await call("PATCH", `/users/${a.user_id}`, { isActive: false }, boss)).status, 200);
  const ra = await unitRow("BLS 10");
  assert.deepEqual([ra.current_status, ra.vehicle_number], ["out_of_service", null], "nobody is aboard, so it can't take calls and holds no vehicle");

  assert.equal((await call("PATCH", `/users/${b.user_id}`, { roles: ["dispatcher"], fieldLevel: null }, boss)).status, 200);
  const rb = await unitRow("BLS 11");
  assert.deepEqual([rb.current_status, rb.vehicle_number], ["out_of_service", null], "taking someone off the field takes them off the unit, and the vehicle goes with them");
  assert.ok((await freeNumbers()).includes("303") && (await freeNumbers()).includes("304"));
});

test("a unit that is mid-call is left alone, and a vehicle can always be taken off by hand", async () => {
  const d = await person("emt");
  const unit = await unitOf("BLS 12");
  const v = await vehicleOf("305");
  assert.equal((await seat(d, unit, "driver")).status, 200);
  assert.equal((await putVehicle(unit, v)).status, 200);
  const inc = await call("POST", "/incidents", { incidentType: "ift_on_demand", priority: "routine", sceneAddress: "1 Test St", capabilityNeeded: "BLS" }, boss);
  assert.equal(inc.status, 201, JSON.stringify(inc.body));
  assert.equal((await call("POST", `/incidents/${inc.body.incident_id}/assignments`, { unitId: unit.unit_id, role: "primary" }, boss)).status, 201);

  assert.equal((await seat(d, null)).status, 200);
  const mid = await unitRow("BLS 12");
  assert.deepEqual([mid.current_status, mid.vehicle_number], ["assigned", "305"], "mid-call: nothing changes under the crew's feet");

  assert.equal((await putVehicle(unit, null)).status, 200, "dispatch can always take the vehicle off by hand");
  assert.equal((await unitRow("BLS 12")).vehicle_number, null);
});
