// tests/api-client.test.js
// -----------------------------------------------------------------------
// Spins up the actual server.js as a child process and drives it
// through api-client.js with real HTTP requests — not a mock server
// standing in for the real one. The point is proving the client code
// that will eventually sit inside the React consoles correctly talks
// to the actual Express routes, not just that its syntax looks right.
//
// Requires the same TEST_DATABASE_URL setup as tests/isolation.test.js,
// plus a real RS256 keypair (generated fresh in before()) since this
// exercises the real auth middleware too, not a bypass of it.
// -----------------------------------------------------------------------

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { spawn } from "child_process";
import { applyMigrations, ensureRuntimeRole } from "../migrate.js";
import { createApiClient } from "../api-client.js";
import { io as ioClient } from "socket.io-client";

const ADMIN_URL = process.env.TEST_DATABASE_URL || "postgres://ems_app:dev_only_change_me@localhost:5432/ems_dispatch_test";
const RUNTIME_PASSWORD = "test_runtime_password";
const PORT = 3099;

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const USER_A_SUPERVISOR = "aaaaaaaa-0000-0000-0000-000000000002";
const PROTOCOL_SET_A = "aaaaaaaa-0000-0000-0000-000000000003";

let serverProcess;
let client;
let signToken;

function waitForServer(url, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      fetch(url)
        .then(() => resolve())
        .catch(() => {
          if (Date.now() - start > timeoutMs) reject(new Error("Server did not become ready in time"));
          else setTimeout(poll, 200);
        });
    })();
  });
}

before(async () => {
  const adminClient = new pg.Client({ connectionString: ADMIN_URL });
  await adminClient.connect();
  await adminClient.query("DROP SCHEMA public CASCADE");
  await adminClient.query("CREATE SCHEMA public");
  await applyMigrations(adminClient, "./migrations");
  await ensureRuntimeRole(adminClient, RUNTIME_PASSWORD);

  await adminClient.query(
    `INSERT INTO tenants (tenant_id, legal_name, display_name, regulatory_state, encryption_key_ref)
     VALUES ($1, 'Tenant A', 'Tenant A', 'NY', 'test')`,
    [TENANT_A]
  );
  await adminClient.query(
    `INSERT INTO users (user_id, tenant_id, email, display_name, role)
     VALUES ($1, $2, 'supervisor@a.test', 'A Supervisor', 'supervisor')`,
    [USER_A_SUPERVISOR, TENANT_A]
  );
  await adminClient.query(
    `INSERT INTO protocol_sets (protocol_set_id, tenant_id, issuing_authority, version_label, effective_from)
     VALUES ($1, $2, 'Test REMAC', 'test-v1', CURRENT_DATE)`,
    [PROTOCOL_SET_A, TENANT_A]
  );
  await adminClient.end();

  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const token = jwt.sign(
    { sub: USER_A_SUPERVISOR, tenant_id: TENANT_A, role: "supervisor" },
    privateKey,
    { algorithm: "RS256", expiresIn: "10m" }
  );
  // Same keypair, other roles — for proving the role checks actually bite.
  signToken = (role, tenantId = TENANT_A, sub = USER_A_SUPERVISOR) => jwt.sign({ sub, tenant_id: tenantId, role }, privateKey, { algorithm: "RS256", expiresIn: "10m" });

  const runtimeUrl = ADMIN_URL.replace(/\/\/[^@]+@/, `//ems_app_runtime:${RUNTIME_PASSWORD}@`);
  serverProcess = spawn("node", ["server.js"], {
    env: {
      ...process.env,
      DATABASE_URL: runtimeUrl,
      JWT_PUBLIC_KEY: publicKey,
      ALLOWED_ORIGIN: "http://localhost:5173",
      PORT: String(PORT),
      WS_REVALIDATE_MS: "300", // re-check open sockets quickly so the test doesn't wait the production 30s
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  await waitForServer(`http://localhost:${PORT}/health`);
  client = createApiClient({ baseUrl: `http://localhost:${PORT}/api`, token });
});

after(() => {
  serverProcess?.kill();
});

test("creating an incident through the client returns a real, persisted record", async () => {
  const incident = await client.createIncident({
    incidentType: "emergency_911",
    priority: "critical",
    protocolSetId: PROTOCOL_SET_A,
    sceneAddress: "API client test address",
  });
  assert.ok(incident.incident_id, "server must return a real incident_id");
  assert.equal(incident.scene_address, "API client test address");

  const fetched = await client.getIncident(incident.incident_id);
  assert.equal(fetched.incident_id, incident.incident_id, "reading it back must return the same record just created");
});

test("the client surfaces a real 401 as a real thrown error, not a silent failure", async () => {
  const unauthenticatedClient = createApiClient({ baseUrl: `http://localhost:${PORT}/api`, token: null });
  await assert.rejects(
    () => unauthenticatedClient.getIncidents(),
    (err) => err.status === 401,
    "a request with no token must reject with status 401, not resolve with empty/undefined data"
  );
});

test("setUnitStatus round-trips through the real status + history write", async () => {
  // Create a unit directly via the admin connection — no POST /units
  // route exists yet (see README), so this seeds through SQL the same
  // way the earlier isolation tests do.
  const seedClient = new pg.Client({ connectionString: ADMIN_URL });
  await seedClient.connect();
  await seedClient.query("SELECT set_config('app.current_tenant_id', $1, false)", [TENANT_A]);
  const vehicle = await seedClient.query(
    "INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1, 'API Client Test Unit', 'BLS') RETURNING vehicle_id",
    [TENANT_A]
  );
  const unit = await seedClient.query(
    "INSERT INTO units (tenant_id, vehicle_id, current_status) VALUES ($1, $2, 'available') RETURNING unit_id",
    [TENANT_A, vehicle.rows[0].vehicle_id]
  );
  await seedClient.end();

  const updated = await client.setUnitStatus(unit.rows[0].unit_id, "en_route");
  assert.equal(updated.current_status, "en_route", "the client must return the server's updated record");

  const units = await client.getUnits();
  const found = units.find((u) => u.unit_id === unit.rows[0].unit_id);
  assert.ok(found, "the updated unit must appear in a subsequent GET /units call");
  assert.equal(found.current_status, "en_route");
});

// MARKER-contract-tests
// These pin the exact shapes the dispatch console reads. Both guard
// bugs that were real: incidents once returned raw PostGIS binary
// instead of lat/lon, and a plain LEFT JOIN through json_agg would
// have produced [{"name":null,...}] instead of [] for unstaffed units.
test("an incident created with coordinates reads back with real numeric lat/lon, not raw PostGIS", async () => {
  const created = await client.createIncident({
    incidentType: "emergency_911", priority: "urgent", protocolSetId: PROTOCOL_SET_A,
    sceneAddress: "Coordinate round-trip", lat: 40.8566, lon: -73.8472,
  });
  assert.ok(Math.abs(created.lat - 40.8566) < 0.0001, "POST must return a usable lat");
  assert.ok(Math.abs(created.lon - -73.8472) < 0.0001, "POST must return a usable lon");
  const fetched = await client.getIncident(created.incident_id);
  assert.ok(Math.abs(fetched.lat - 40.8566) < 0.0001, "GET /incidents/:id must extract lat from the geography column");
  assert.ok(Math.abs(fetched.lon - -73.8472) < 0.0001, "GET /incidents/:id must extract lon from the geography column");
  const listed = (await client.getIncidents()).find((i) => i.incident_id === created.incident_id);
  assert.ok(listed && Math.abs(listed.lat - 40.8566) < 0.0001, "GET /incidents must extract lat too");
});

test("GET /units returns crew in the shape the dispatch console reads, and an unstaffed unit gets an empty array", async () => {
  const seed = new pg.Client({ connectionString: ADMIN_URL });
  await seed.connect();
  const mk = async (designation) => {
    const v = await seed.query("INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1, $2, 'BLS') RETURNING vehicle_id", [TENANT_A, designation]);
    const u = await seed.query("INSERT INTO units (tenant_id, vehicle_id, current_status) VALUES ($1, $2, 'available') RETURNING unit_id", [TENANT_A, v.rows[0].vehicle_id]);
    return u.rows[0].unit_id;
  };
  const staffedId = await mk("Crew Shape Staffed");
  await mk("Crew Shape Unstaffed");
  const crew = await seed.query(
    "INSERT INTO crew_members (tenant_id, first_name, last_name, employee_number) VALUES ($1, 'Marcus', 'Alvarez', '4471') RETURNING crew_member_id",
    [TENANT_A]
  );
  await seed.query("INSERT INTO unit_crew_assignments (tenant_id, unit_id, crew_member_id, seat_role) VALUES ($1, $2, $3, 'driver')", [TENANT_A, staffedId, crew.rows[0].crew_member_id]);
  await seed.end();

  const units = await client.getUnits();
  const staffed = units.find((u) => u.unit_designation === "Crew Shape Staffed");
  assert.equal(staffed.crew.length, 1);
  assert.equal(staffed.crew[0].employeeId, "4471");
  assert.equal(staffed.crew[0].name, "Marcus Alvarez");
  assert.equal(staffed.crew[0].role, "driver");
  const unstaffed = units.find((u) => u.unit_designation === "Crew Shape Unstaffed");
  assert.deepEqual(unstaffed.crew, [], "an unstaffed unit must have [] — not an array holding one all-null crew object");
});

// MARKER-pcr-compliance-tests
// The PCR and compliance routes were written and mounted, and the
// server started with them — but no test had ever executed their SQL.
async function newIncidentId(label) {
  const i = await client.createIncident({ incidentType: "emergency_911", priority: "routine", protocolSetId: PROTOCOL_SET_A, sceneAddress: label });
  return i.incident_id;
}
const NO_VITALS = { bpSystolic: null, bpDiastolic: null, heartRate: null, respiratoryRate: null, spo2Percent: null, bloodGlucose: null, gcsTotal: null, painScale: null, temperatureF: null };

test("creating a PCR is idempotent — a retry returns the same chart instead of failing on the unique incident", async () => {
  const incidentId = await newIncidentId("PCR idempotency");
  const first = await client.createPcr(incidentId);
  const second = await client.createPcr(incidentId);
  assert.ok(first.pcr_id);
  assert.equal(second.pcr_id, first.pcr_id);
});

test("vitals, procedures, medications, narrative and disposition persist and read back, and disposition is a true upsert", async () => {
  const id = (await client.createPcr(await newIncidentId("PCR sub-resources"))).pcr_id;
  await client.addVitals(id, { ...NO_VITALS, bpSystolic: 120, bpDiastolic: 80, heartRate: 88, spo2Percent: 98, gcsTotal: 15 });
  await client.addVitals(id, { ...NO_VITALS, bpSystolic: 130, bpDiastolic: 84, heartRate: 92, respiratoryRate: 16, spo2Percent: 97, gcsTotal: 15, painScale: 4, temperatureF: 98.6 });
  const proc = await client.addProcedure(id, { procedureName: "IV Access", outcome: "Successful, 1st attempt", notes: null });
  assert.equal(proc.procedure_name, "IV Access");
  const med = await client.addMedication(id, { drugName: "Aspirin", dose: "324mg", route: "PO" });
  assert.equal(med.drug_name, "Aspirin");
  await client.saveNarrative(id, "Crew arrived to find patient seated.");
  const disp = (impression) => ({ dispositionType: "transported", destinationFacilityId: null, transferOfCareTo: "RN Smith", primaryImpression: impression, secondaryImpressions: null, mechanismOfInjury: null });
  await client.saveDisposition(id, disp("Chest pain"));
  await client.saveDisposition(id, disp("Acute coronary syndrome"));

  const chart = await client.getPcr(id);
  assert.equal(chart.clinical_narrative, "Crew arrived to find patient seated.");
  assert.equal(chart.vitals.length, 2);
  assert.equal(chart.vitals[0].heart_rate, 92, "newest reading first");
  assert.equal(chart.vitals[1].respiratory_rate, null, "an unrecorded field must stay null, not be coerced to 0");

  const check = new pg.Client({ connectionString: ADMIN_URL });
  await check.connect();
  const d = await check.query("SELECT primary_impression FROM pcr_disposition WHERE pcr_id = $1", [id]);
  await check.end();
  assert.equal(d.rows.length, 1, "saving disposition twice must update the one row, not add a second");
  assert.equal(d.rows[0].primary_impression, "Acute coronary syndrome");
});

test("GET /certifications and GET /vehicles return real rows with the day counts the compliance console reads", async () => {
  const seed = new pg.Client({ connectionString: ADMIN_URL });
  await seed.connect();
  const ct = await seed.query("INSERT INTO certification_types (tenant_id, code, label) VALUES ($1, 'EMT-B', 'EMT Basic') RETURNING certification_type_id", [TENANT_A]);
  const cm = await seed.query("INSERT INTO crew_members (tenant_id, first_name, last_name) VALUES ($1, 'Cert', 'Probe') RETURNING crew_member_id", [TENANT_A]);
  await seed.query(
    "INSERT INTO certifications (tenant_id, crew_member_id, certification_type_id, issuing_body, issued_on, expires_on) VALUES ($1, $2, $3, 'NYS DOH', CURRENT_DATE - 700, CURRENT_DATE + 10)",
    [TENANT_A, cm.rows[0].crew_member_id, ct.rows[0].certification_type_id]
  );
  await seed.query("INSERT INTO vehicles (tenant_id, unit_designation, capability_level, next_inspection_due) VALUES ($1, 'Inspection Probe', 'BLS', CURRENT_DATE + 5)", [TENANT_A]);
  await seed.end();

  const cert = (await client.getCertifications()).find((c) => c.last_name === "Probe");
  assert.ok(cert, "the seeded certification must be returned");
  assert.equal(cert.cert_type, "EMT-B");
  assert.equal(Number(cert.days_until_expiry), 10);
  const veh = (await client.getVehicles()).find((v) => v.unit_designation === "Inspection Probe");
  assert.ok(veh, "the seeded vehicle must be returned");
  assert.equal(Number(veh.days_until_due), 5);
});

test("a finalized chart refuses every further change with a clear 409 — not just edits to the chart row itself", async () => {
  const id = (await client.createPcr(await newIncidentId("PCR finalization"))).pcr_id;
  await client.addVitals(id, { ...NO_VITALS, bpSystolic: 118, bpDiastolic: 76, heartRate: 80 });
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query("UPDATE patient_care_records SET finalized_at = now() WHERE pcr_id = $1", [id]);
  await admin.end();

  // Collect every outcome instead of stopping at the first, so a failure
  // shows exactly which paths still accept changes.
  const attempts = {
    narrative: () => client.saveNarrative(id, "edited after finalization"),
    vitals: () => client.addVitals(id, { ...NO_VITALS, heartRate: 140 }),
    procedure: () => client.addProcedure(id, { procedureName: "Intubation", outcome: null, notes: null }),
    medication: () => client.addMedication(id, { drugName: "Epinephrine", dose: "0.3mg", route: "IM" }),
    disposition: () => client.saveDisposition(id, { dispositionType: "refused", destinationFacilityId: null, transferOfCareTo: null, primaryImpression: "changed", secondaryImpressions: null, mechanismOfInjury: null }),
  };
  const outcomes = {};
  for (const [name, attempt] of Object.entries(attempts)) {
    try { await attempt(); outcomes[name] = "ACCEPTED"; }
    catch (e) { outcomes[name] = /finalized/i.test(e.message) ? e.status : `${e.status}: ${e.message}`; }
  }
  assert.deepEqual(outcomes, { narrative: 409, vitals: 409, procedure: 409, medication: 409, disposition: 409 });
  assert.equal((await client.getPcr(id)).vitals.length, 1, "the finalized chart must contain exactly what was signed off");
});

// MARKER-route-flow-tests
// Until now these routes had only ever been tested as mirrored SQL —
// which proves the queries work, not that the handlers wrapped around
// them do. These drive the real handlers end to end.
async function seedUnit(designation, capability = "BLS") {
  const seed = new pg.Client({ connectionString: ADMIN_URL });
  await seed.connect();
  const v = await seed.query("INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1, $2, $3) RETURNING vehicle_id", [TENANT_A, designation, capability]);
  const u = await seed.query("INSERT INTO units (tenant_id, vehicle_id, current_status) VALUES ($1, $2, 'available') RETURNING unit_id", [TENANT_A, v.rows[0].vehicle_id]);
  await seed.end();
  return u.rows[0].unit_id;
}

test("assign, release and complete drive the unit's status and its history — not just the assignment row", async () => {
  const primary = await seedUnit("Flow Primary", "BLS");
  const intercept = await seedUnit("Flow Intercept", "ALS");
  const incidentId = await newIncidentId("Assignment flow");
  const seed = new pg.Client({ connectionString: ADMIN_URL });
  await seed.connect();
  const statusOf = async (id) => (await client.getUnits()).find((u) => u.unit_id === id).current_status;
  const historyOf = async (id, status) =>
    Number((await seed.query("SELECT count(*) FROM unit_status_history WHERE unit_id = $1 AND incident_id = $2 AND status = $3", [id, incidentId, status])).rows[0].count);

  const facts = {};
  await client.assignUnit(incidentId, primary, "primary");
  facts.primaryStatusAfterAssign = await statusOf(primary);
  facts.primaryAssignedHistoryRows = await historyOf(primary, "assigned");

  try { await client.assignUnit(incidentId, intercept, "primary"); facts.secondPrimary = "ACCEPTED"; } catch (e) { facts.secondPrimary = e.status; }
  facts.interceptStatusAfterRefusedPrimary = await statusOf(intercept); // the refused attempt must leave no trace at all

  await client.assignUnit(incidentId, intercept, "als_intercept");
  facts.interceptStatusAfterAssign = await statusOf(intercept);

  await client.releaseUnit(incidentId, primary);
  facts.primaryStatusAfterRelease = await statusOf(primary);
  facts.primaryAvailableHistoryRows = await historyOf(primary, "available");

  await client.completeIncident(incidentId);
  facts.interceptStatusAfterComplete = await statusOf(intercept);
  facts.interceptAvailableHistoryRows = await historyOf(intercept, "available");
  facts.incidentClosed = (await client.getIncident(incidentId)).closed_at !== null;
  await seed.end();

  assert.deepEqual(facts, {
    primaryStatusAfterAssign: "assigned", primaryAssignedHistoryRows: 1,
    secondPrimary: 409, interceptStatusAfterRefusedPrimary: "available",
    interceptStatusAfterAssign: "assigned",
    primaryStatusAfterRelease: "available", primaryAvailableHistoryRows: 1,
    interceptStatusAfterComplete: "available", interceptAvailableHistoryRows: 1,
    incidentClosed: true,
  });
});

test("a crew member can report their own unit's position, someone else's unit is refused, and the position reads back", async () => {
  const unitId = await seedUnit("Location Probe");
  const otherUnit = await seedUnit("Location Other");
  const seed = new pg.Client({ connectionString: ADMIN_URL });
  await seed.connect();
  const cm = await seed.query("INSERT INTO crew_members (tenant_id, user_id, first_name, last_name) VALUES ($1, $2, 'Loc', 'Probe') RETURNING crew_member_id", [TENANT_A, USER_A_SUPERVISOR]);
  await seed.query("INSERT INTO unit_crew_assignments (tenant_id, unit_id, crew_member_id, seat_role) VALUES ($1, $2, $3, 'driver')", [TENANT_A, unitId, cm.rows[0].crew_member_id]);
  await seed.end();

  const reported = await client.reportLocation(unitId, { lat: 40.8566, lon: -73.8472, headingDeg: 90, speedMph: 25, accuracyM: 8 });
  assert.equal(reported.unit_id, unitId);
  const unit = (await client.getUnits()).find((u) => u.unit_id === unitId);
  assert.ok(Math.abs(unit.lat - 40.8566) < 0.0001 && Math.abs(unit.lon - -73.8472) < 0.0001, "the reported position must read back as lat/lon");
  await assert.rejects(() => client.reportLocation(otherUnit, { lat: 40.8, lon: -73.9 }), (e) => e.status === 403, "a user not crewing that unit must not be able to move it on the board");
  await assert.rejects(() => client.reportLocation(unitId, { lat: "40.8", lon: -73.9 }), (e) => e.status === 400, "non-numeric coordinates must be rejected");
});

test("mutual-aid grant routes enforce the role check and the 72-hour cap, and revoking changes status", async () => {
  const seed = new pg.Client({ connectionString: ADMIN_URL });
  await seed.connect();
  await seed.query("INSERT INTO tenants (tenant_id, legal_name, display_name, regulatory_state, encryption_key_ref) VALUES ('22222222-2222-2222-2222-222222222222', 'B', 'B', 'NY', 'k') ON CONFLICT DO NOTHING");
  await seed.end();
  const TENANT_B_ID = "22222222-2222-2222-2222-222222222222";
  const incidentId = await newIncidentId("Grant route");
  const dispatcher = await asUser("dispatcher", TENANT_A, USER_A_DISPATCHER);
  const body = { assistingTenantId: TENANT_B_ID, incidentId, reason: "MCI mutual aid", expiresInHours: 12 };

  await assert.rejects(() => dispatcher.createMutualAidGrant(body), (e) => e.status === 403, "a dispatcher must not be able to grant another agency access");
  await assert.rejects(() => client.createMutualAidGrant({ ...body, expiresInHours: 100 }), (e) => e.status === 400, "the API must refuse anything over 72 hours with a clear error");
  const grant = await client.createMutualAidGrant(body);
  assert.equal(grant.status, "active");
  const revoked = await client.revokeMutualAidGrant(grant.link_id);
  assert.equal(revoked.status, "revoked");
  assert.ok(revoked.revoked_at, "revocation must be timestamped");
});

// MARKER-double-book
test("a unit can't be active on two incidents at once", async () => {
  const unit = await seedUnit("Double Book Probe");
  const first = await newIncidentId("Double book 1");
  const second = await newIncidentId("Double book 2");
  await client.assignUnit(first, unit, "primary");
  await assert.rejects(
    () => client.assignUnit(second, unit, "primary"),
    (e) => e.status === 409,
    "a unit already working one incident must be refused for a second, with a clear 409"
  );
  const seed = new pg.Client({ connectionString: ADMIN_URL });
  await seed.connect();
  const active = await seed.query("SELECT incident_id FROM incident_unit_assignments WHERE unit_id = $1 AND unassigned_at IS NULL", [unit]);
  await seed.end();
  assert.deepEqual(active.rows.map((r) => r.incident_id), [first], "and it must still be on the first incident, undisturbed");
});

// MARKER-console-contract
// Things the dispatch console needs from the API that no earlier test
// covered, found by re-reading the console against the routes rather
// than by any test failing on its own.
test("an incident gets the agency's active protocol set stamped by the server — a client can't pick or omit it", async () => {
  const omitted = await client.createIncident({ incidentType: "emergency_911", priority: "routine", sceneAddress: "No protocol supplied" });
  assert.equal(omitted.protocol_set_id, PROTOCOL_SET_A, "with none supplied, the active set is used");
  const bogus = await client.createIncident({ incidentType: "emergency_911", priority: "routine", sceneAddress: "Bogus protocol supplied", protocolSetId: "00000000-0000-0000-0000-000000000000" });
  assert.equal(bogus.protocol_set_id, PROTOCOL_SET_A, "a client-supplied one is ignored — a stale client must not stamp a call with an outdated protocol version");
});

test("an agency with no active protocol set gets a clear 409, not a crash", async () => {
  const TENANT_C = "33333333-3333-3333-3333-333333333333";
  const USER_C = "cccccccc-0000-0000-0000-000000000001";
  const seed = new pg.Client({ connectionString: ADMIN_URL });
  await seed.connect();
  await seed.query("INSERT INTO tenants (tenant_id, legal_name, display_name, regulatory_state, encryption_key_ref) VALUES ($1, 'C', 'C', 'NY', 'k')", [TENANT_C]);
  await seed.query("INSERT INTO users (user_id, tenant_id, email, display_name, role) VALUES ($1, $2, 'c@c.test', 'C Dispatcher', 'dispatcher')", [USER_C, TENANT_C]);
  await seed.end();
  const clientC = createApiClient({ baseUrl: `http://localhost:${PORT}/api`, token: signToken("dispatcher", TENANT_C, USER_C) });
  await assert.rejects(
    () => clientC.createIncident({ incidentType: "emergency_911", priority: "routine", sceneAddress: "No protocol set exists" }),
    (e) => e.status === 409 && /protocol set/i.test(e.message)
  );
});

test("incidents come back with their active assignments, so a console can show who is on a call", async () => {
  const unit = await seedUnit("Assignment Payload Probe");
  const incidentId = await newIncidentId("Assignment payload");
  assert.deepEqual((await client.getIncident(incidentId)).assigned_units, []);
  await client.assignUnit(incidentId, unit, "primary");
  assert.deepEqual((await client.getIncident(incidentId)).assigned_units, [{ unitId: unit, role: "primary" }]);
  const listed = (await client.getIncidents()).find((i) => i.incident_id === incidentId);
  assert.deepEqual(listed.assigned_units, [{ unitId: unit, role: "primary" }], "the list endpoint must carry them too — that's what the console loads");
  await client.releaseUnit(incidentId, unit);
  assert.deepEqual((await client.getIncident(incidentId)).assigned_units, [], "a released unit must drop off");
});

// MARKER-audit-api
const BASE = `http://localhost:${PORT}/api`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_A_DISPATCHER = "dddddddd-0000-0000-0000-0000000000d1";
// A token is only as good as the user row behind it: the database, not the
// token, decides role and whether someone is active. So a client for role X
// has to be backed by a real user who actually has role X. (Malformed ids
// are deliberately NOT provisioned — those tests want the 401.)
async function asUser(role, tenantId, sub) {
  if (UUID_RE.test(sub) && UUID_RE.test(tenantId)) {
    const a = new pg.Client({ connectionString: ADMIN_URL });
    await a.connect();
    try {
      await a.query(
        `INSERT INTO users (user_id, tenant_id, email, display_name, role) VALUES ($1, $2, $3, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, is_active = true`,
        [sub, tenantId, `${sub}@test.local`, role]
      );
    } finally {
      await a.end();
    }
  }
  return createApiClient({ baseUrl: BASE, token: signToken(role, tenantId, sub) });
}
async function adminQuery(sql, params) {
  const a = new pg.Client({ connectionString: ADMIN_URL });
  await a.connect();
  try { return await a.query(sql, params); } finally { await a.end(); }
}
const TENANT_B_ID = "22222222-2222-2222-2222-222222222222";
const TENANT_C_ID = "33333333-3333-3333-3333-333333333333";
async function seedTenants() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const [id, n] of [[TENANT_B_ID, "B"], [TENANT_C_ID, "C"]])
    await admin.query("INSERT INTO tenants (tenant_id, legal_name, display_name, regulatory_state, encryption_key_ref) VALUES ($1, $2, $2, 'NY', 'k') ON CONFLICT DO NOTHING", [id, n]);
  await admin.end();
}

test("every write is attributed to the user who made it, even with far more concurrent requests than pool connections", async () => {
  const users = Array.from({ length: 6 }, (_, i) => `eeeeeeee-0000-0000-0000-00000000000${i}`);
  const clients = await Promise.all(users.map((u) => asUser("supervisor", TENANT_A, u)));
  const jobs = [];
  users.forEach((_, ui) => { for (let k = 0; k < 12; k++) jobs.push(clients[ui].createIncident({ incidentType: "emergency_911", priority: "routine", sceneAddress: `attrib|${ui}|${k}` })); });
  await Promise.all(jobs); // 72 at once against a pool of 20
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const rows = (await admin.query("SELECT i.scene_address, a.actor_user_id FROM audit_log a JOIN incidents i ON i.incident_id = a.record_id WHERE a.table_name = 'incidents' AND a.action = 'insert' AND i.scene_address LIKE 'attrib|%'")).rows;
  await admin.end();
  assert.equal(rows.length, 72, "one entry per write");
  const wrong = rows.filter((r) => r.actor_user_id !== users[Number(r.scene_address.split("|")[1])]);
  assert.deepEqual(wrong, [], "an entry named the wrong person — request context leaked between concurrent requests");
});

test("viewing a chart or an incident is audited, and an assisting agency's views are visible to the agency that shared it", async () => {
  await seedTenants();
  const compliance = await asUser("compliance_officer", TENANT_A, "ffffffff-0000-0000-0000-000000000001");
  const incidentId = await newIncidentId("Audit views");
  const pcr = await client.createPcr(incidentId);
  await client.getPcr(pcr.pcr_id);
  await client.getIncident(incidentId);

  const pcrViews = await compliance.getAudit({ recordId: pcr.pcr_id, action: "view" });
  assert.equal(pcrViews.length, 1, "reading a patient chart must leave exactly one entry");
  assert.equal(pcrViews[0].table_name, "patient_care_records");
  assert.equal(pcrViews[0].actor_user_id, USER_A_SUPERVISOR);

  await client.createMutualAidGrant({ assistingTenantId: TENANT_B_ID, incidentId, reason: "audit visibility", expiresInHours: 6 });
  const B_USER = "bbbbbbbb-0000-0000-0000-000000000001";
  const agencyB = await asUser("dispatcher", TENANT_B_ID, B_USER);
  await agencyB.getIncident(incidentId);
  assert.ok((await agencyB.getIncidents()).some((i) => i.incident_id === incidentId), "the shared incident reaches the assisting agency's list too");

  const fromB = (await compliance.getAudit({ recordId: incidentId, action: "view" })).filter((r) => r.tenant_id === TENANT_B_ID && r.actor_user_id === B_USER);
  assert.ok(fromB.length >= 2, `the owning agency must see that another agency viewed its incident — both the direct read and the list (saw ${fromB.length})`);
  const agencyC = await asUser("compliance_officer", TENANT_C_ID, "cccccccc-0000-0000-0000-000000000002");
  assert.deepEqual(await agencyC.getAudit({ recordId: incidentId }), [], "an unrelated agency must see nothing about it");
});

test("the audit log is readable only by compliance roles, and a refused attempt is itself recorded", async () => {
  const nosy = "dddddddd-0000-0000-0000-0000000000aa";
  await assert.rejects(async () => (await asUser("dispatcher", TENANT_A, nosy)).getAudit({}), (e) => e.status === 403);
  const denied = await (await asUser("compliance_officer", TENANT_A, "ffffffff-0000-0000-0000-000000000001")).getAudit({ action: "denied", actorUserId: nosy });
  assert.ok(denied.length >= 1, "the refused attempt must leave an entry");
  assert.equal(denied[0].detail.actualRole, "dispatcher");
  assert.ok(denied[0].detail.requiredRoles.includes("compliance_officer"));
});

test("no audit, no access — if the entry can't be written, the chart isn't served", async () => {
  const id = (await client.createPcr(await newIncidentId("Fail closed"))).pcr_id;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query("REVOKE INSERT ON audit_log FROM ems_app_runtime");
  try {
    await assert.rejects(() => client.getPcr(id), (e) => e.status === 500, "a read that can't be logged must not succeed");
  } finally {
    await admin.query("GRANT INSERT ON audit_log TO ems_app_runtime");
    await admin.end();
  }
  assert.equal((await client.getPcr(id)).pcr_id, id, "and it works again once logging does");
});

test("GET /audit/verify reports a clean chain, then flags a tampered entry", async () => {
  const compliance = await asUser("compliance_officer", TENANT_A, "ffffffff-0000-0000-0000-000000000001");
  const clean = await compliance.verifyAuditChain();
  assert.equal(clean.ok, true);
  assert.ok(clean.entriesChecked > 0);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const victim = (await admin.query("SELECT audit_id, action FROM audit_log WHERE tenant_id = $1 AND action = 'insert' ORDER BY audit_id LIMIT 1", [TENANT_A])).rows[0];
  await admin.query("UPDATE audit_log SET action = 'view' WHERE audit_id = $1", [victim.audit_id]);
  const tampered = await compliance.verifyAuditChain();
  assert.equal(tampered.ok, false);
  assert.ok(tampered.problems.some((p) => String(p.audit_id) === String(victim.audit_id)), "the altered entry must be named");
  await admin.query("UPDATE audit_log SET action = $2 WHERE audit_id = $1", [victim.audit_id, victim.action]);
  await admin.end();
  assert.equal((await compliance.verifyAuditChain()).ok, true, "and restoring it restores the chain");
});

test("a token whose subject or tenant isn't a UUID is refused with 401, not a database error later", async () => {
  await assert.rejects(async () => (await asUser("supervisor", TENANT_A, "not-a-uuid")).getIncidents(), (e) => e.status === 401);
  await assert.rejects(async () => (await asUser("supervisor", "not-a-uuid", USER_A_SUPERVISOR)).getIncidents(), (e) => e.status === 401);
});

// MARKER-audit-coverage
test("every API write to an audited table leaves an entry attributed to the person who made it — and nothing goes unattributed", async () => {
  await seedTenants();
  const actor = "abababab-0000-0000-0000-000000000001";
  const me = await asUser("supervisor", TENANT_A, actor);
  const unit = await seedUnit("Audit Coverage Unit");
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
  const t0 = (await admin.query("SELECT clock_timestamp() AS t")).rows[0].t;

  const incidentId = (await me.createIncident({ incidentType: "emergency_911", priority: "routine", sceneAddress: "Audit coverage" })).incident_id;
  await me.assignUnit(incidentId, unit, "primary");
  await me.releaseUnit(incidentId, unit);
  const pcrId = (await me.createPcr(incidentId)).pcr_id;
  await me.addVitals(pcrId, { ...NO_VITALS, heartRate: 80 });
  await me.addProcedure(pcrId, { procedureName: "IV Access", outcome: null, notes: null });
  await me.addMedication(pcrId, { drugName: "Aspirin", dose: "324mg", route: "PO" });
  const disp = (impression) => ({ dispositionType: "transported", destinationFacilityId: null, transferOfCareTo: null, primaryImpression: impression, secondaryImpressions: null, mechanismOfInjury: null });
  await me.saveDisposition(pcrId, disp("first"));
  await me.saveDisposition(pcrId, disp("second"));
  await me.saveNarrative(pcrId, "Narrative text");
  const grant = await me.createMutualAidGrant({ assistingTenantId: TENANT_B_ID, incidentId, reason: "coverage", expiresInHours: 1 });
  await me.revokeMutualAidGrant(grant.link_id);
  await me.completeIncident(incidentId);

  const got = (await admin.query("SELECT DISTINCT table_name || ':' || action AS k FROM audit_log WHERE actor_user_id = $1", [actor])).rows.map((r) => r.k).sort();
  const unattributed = Number((await admin.query("SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND actor_user_id IS NULL AND occurred_at >= $2", [TENANT_A, t0])).rows[0].count);

  assert.deepEqual(got, [
    "incident_unit_assignments:insert", "incident_unit_assignments:update",
    "incidents:insert", "incidents:update",
    "mutual_aid_links:insert", "mutual_aid_links:update",
    "patient_care_records:insert", "patient_care_records:update",
    "pcr_disposition:insert", "pcr_disposition:update",
    "pcr_medications:insert", "pcr_procedures:insert", "pcr_vitals:insert",
  ], "each table's trigger must fire for each kind of change the API can make — and units/status history, deliberately unaudited here, must not appear");
  assert.equal(unattributed, 0, "an entry written through the API had no actor — the request context didn't reach the database");
  } finally {
    await admin.end();
  }
});

// =====================================================================
// MARKER-auth-authority
// The API used to verify a token's signature and then trust its claims:
// a deactivated user, a downgraded role, or a suspended agency all kept
// working until the token happened to expire. The database is the
// authority on who may do what; the token only says who is asking.
// =====================================================================
test("a deactivated user is refused even with a valid, unexpired token — and the refusal is recorded", async () => {
  const sub = "a1a1a1a1-0000-0000-0000-000000000001";
  const user = await asUser("dispatcher", TENANT_A, sub);
  await user.getIncidents(); // works while active
  await adminQuery("UPDATE users SET is_active = false WHERE user_id = $1", [sub]);
  try {
    await assert.rejects(() => user.getIncidents(), (e) => e.status === 401, "a terminated employee's token must stop working immediately, not at expiry");
  } finally {
    await adminQuery("UPDATE users SET is_active = true WHERE user_id = $1", [sub]);
  }
  await user.getIncidents(); // works again once reactivated — proves it was the flag, not a broken token
  const compliance = await asUser("compliance_officer", TENANT_A, "ffffffff-0000-0000-0000-000000000001");
  const denied = await compliance.getAudit({ action: "denied", actorUserId: sub });
  assert.ok(denied.some((r) => /deactivated/.test(r.detail.reason)), "the attempt must leave an entry saying why it was refused");
});

test("a role change takes effect on the next request — the token's claim never outranks the database", async () => {
  await seedTenants();
  const sub = "a1a1a1a1-0000-0000-0000-000000000002";
  const user = await asUser("supervisor", TENANT_A, sub); // the token will keep saying "supervisor"
  const incidentId = await newIncidentId("Role change");
  const grant = () => user.createMutualAidGrant({ assistingTenantId: TENANT_B_ID, incidentId, reason: "role change", expiresInHours: 1 });
  await grant(); // supervisors may
  await adminQuery("UPDATE users SET role = 'dispatcher' WHERE user_id = $1", [sub]);
  await assert.rejects(grant, (e) => e.status === 403, "the token still claims supervisor but the database says dispatcher — the database wins");
});

test("a validly signed token for someone who isn't a user of that agency is refused — including a real user claiming another agency", async () => {
  await seedTenants();
  const stranger = createApiClient({ baseUrl: BASE, token: signToken("supervisor", TENANT_A, "a1a1a1a1-0000-0000-0000-000000000003") });
  await assert.rejects(() => stranger.getIncidents(), (e) => e.status === 401, "no such user");
  const ofAgencyB = "a1a1a1a1-0000-0000-0000-000000000004";
  await asUser("supervisor", TENANT_B_ID, ofAgencyB); // a real, active user — of agency B
  const claimsA = createApiClient({ baseUrl: BASE, token: signToken("supervisor", TENANT_A, ofAgencyB) });
  await assert.rejects(() => claimsA.getIncidents(), (e) => e.status === 401, "a real user must not be able to act inside an agency they don't belong to");
});

test("suspending an agency locks out all of its users at once", async () => {
  await seedTenants();
  const user = await asUser("dispatcher", TENANT_C_ID, "a1a1a1a1-0000-0000-0000-000000000005");
  await user.getIncidents();
  await adminQuery("UPDATE tenants SET is_active = false WHERE tenant_id = $1", [TENANT_C_ID]);
  try {
    await assert.rejects(() => user.getIncidents(), (e) => e.status === 401, "a suspended agency's users must all be refused");
  } finally {
    await adminQuery("UPDATE tenants SET is_active = true WHERE tenant_id = $1", [TENANT_C_ID]);
  }
  await user.getIncidents();
});

// =====================================================================
// MARKER-live-feed
// The WebSocket layer had no tests at all. Its handshake also carried a
// separate copy of the token check, so a deactivated user could still
// open a socket and receive live incident and unit updates.
// =====================================================================
function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://localhost:${PORT}`, { auth: { token }, transports: ["websocket"], reconnection: false, timeout: 4000 });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (err) => { socket.close(); reject(err); });
  });
}
const nextEvent = (socket, name, ms = 2500) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    socket.once(name, (data) => { clearTimeout(t); resolve(data); });
  });

test("the live feed applies the same authority check as the API: active users connect; bad tokens and deactivated users don't", async () => {
  const sub = "a2a2a2a2-0000-0000-0000-000000000001";
  await asUser("dispatcher", TENANT_A, sub);
  (await connectSocket(signToken("dispatcher", TENANT_A, sub))).close();
  await assert.rejects(() => connectSocket("not-a-token"), /Unauthorized/);
  await adminQuery("UPDATE users SET is_active = false WHERE user_id = $1", [sub]);
  try {
    await assert.rejects(() => connectSocket(signToken("dispatcher", TENANT_A, sub)), /Unauthorized/, "a valid token for a deactivated user must not get a live feed");
  } finally {
    await adminQuery("UPDATE users SET is_active = true WHERE user_id = $1", [sub]);
  }
});

test("a unit status change is pushed to sockets in the same agency and to no one else", async () => {
  await seedTenants();
  const unitId = await seedUnit("Push Probe");
  const A_SUB = "a2a2a2a2-0000-0000-0000-000000000002";
  const B_SUB = "a2a2a2a2-0000-0000-0000-000000000003";
  await asUser("dispatcher", TENANT_A, A_SUB);
  await asUser("dispatcher", TENANT_B_ID, B_SUB);
  const sameAgency = await connectSocket(signToken("dispatcher", TENANT_A, A_SUB));
  const otherAgency = await connectSocket(signToken("dispatcher", TENANT_B_ID, B_SUB));
  try {
    const mine = nextEvent(sameAgency, "unit:status");
    const theirs = nextEvent(otherAgency, "unit:status", 700);
    await client.setUnitStatus(unitId, "en_route");
    const got = await mine;
    assert.ok(got && got.unit_id === unitId && got.current_status === "en_route", "the agency's own dispatchers must receive the change");
    assert.equal(await theirs, null, "another agency must never receive it");
  } finally {
    sameAgency.close();
    otherAgency.close();
  }
});

test("a user deactivated while connected is cut off, not left listening", async () => {
  const sub = "a2a2a2a2-0000-0000-0000-000000000004";
  await asUser("dispatcher", TENANT_A, sub);
  const socket = await connectSocket(signToken("dispatcher", TENANT_A, sub));
  const outcome = new Promise((resolve) => {
    const t = setTimeout(() => resolve("still connected"), 3000);
    socket.once("disconnect", () => { clearTimeout(t); resolve("disconnected"); });
  });
  await adminQuery("UPDATE users SET is_active = false WHERE user_id = $1", [sub]);
  try {
    assert.equal(await outcome, "disconnected", "a handshake check only covers the moment of connecting; an open socket must be re-checked");
  } finally {
    socket.close();
    await adminQuery("UPDATE users SET is_active = true WHERE user_id = $1", [sub]);
  }
});

// =====================================================================
// MARKER-startup-guard
// Agencies' data stays separate because of row-level security — and
// Postgres exempts superusers, table owners and BYPASSRLS roles from it.
// Connect the API as one of those and every agency can read every other
// agency's data, with nothing visibly wrong. That's the one way this
// system merges companies, so it must not be possible to start it that
// way. A new table that forgets row-level security is the same hazard.
// =====================================================================
function runServer(env, ms = 8000) {
  return new Promise((resolve) => {
    const child = spawn("node", ["server.js"], { env: { ...process.env, JWT_PUBLIC_KEY: "x", ALLOWED_ORIGIN: "http://localhost:5173", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const t = setTimeout(() => { child.kill(); resolve({ code: "still running", stderr }); }, ms);
    child.on("exit", (code) => { clearTimeout(t); resolve({ code, stderr }); });
  });
}
const runtimeUrlFor = () => ADMIN_URL.replace(/\/\/[^@]+@/, `//ems_app_runtime:${RUNTIME_PASSWORD}@`);

test("the API refuses to start as a database role that bypasses row-level security", async () => {
  const { code, stderr } = await runServer({ DATABASE_URL: ADMIN_URL, PORT: "3098" });
  assert.equal(code, 1, `it should have refused to start; instead: ${code}`);
  assert.match(stderr, /Refusing to start/);
  assert.match(stderr, /superuser/);
});

test("the API refuses to start if a table holding agency data lacks row-level security", async () => {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query("CREATE TABLE rls_probe (id int, tenant_id uuid)");
  try {
    const { code, stderr } = await runServer({ DATABASE_URL: runtimeUrlFor(), PORT: "3097" });
    assert.equal(code, 1, `it should have refused to start; instead: ${code}`);
    assert.match(stderr, /rls_probe/);
  } finally {
    await admin.query("DROP TABLE rls_probe");
    await admin.end();
  }
});
