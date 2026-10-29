// tests/isolation.test.js
// -----------------------------------------------------------------------
// This file exists because manual testing found a critical bug that
// code review missed entirely: connecting as the migration role (which
// owns every table) made every RLS policy silently inert. That bug had
// no test protecting against it coming back. These do.
//
// Uses node:test — no new dependency, built into Node 18+. Runs
// against a real database with the real migration files via
// applyMigrations() from migrate.js, not a hand-maintained mock of the
// schema that could quietly drift from what's actually deployed.
//
// Requires a Postgres reachable at TEST_DATABASE_URL (superuser or an
// existing owner role — this needs to run DDL) with the postgis
// extension available.
//
// Run with the exact file path, not the directory:
//   node --test tests/isolation.test.js
// (in the Node version this was built and verified against, passing
// the directory alone raised "Cannot find module" instead of
// discovering the file inside it — that cost real debugging time
// before turning out to be a one-word fix, not an issue with the
// tests themselves.)
// -----------------------------------------------------------------------

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { applyMigrations, ensureRuntimeRole } from "../migrate.js";

const ADMIN_URL = process.env.TEST_DATABASE_URL || "postgres://ems_app:dev_only_change_me@localhost:5432/ems_dispatch_test";
const RUNTIME_PASSWORD = "test_runtime_password";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const USER_A_SUPERVISOR = "aaaaaaaa-0000-0000-0000-000000000002";
const PROTOCOL_SET_A = "aaaaaaaa-0000-0000-0000-000000000003";

let adminClient;
let runtimePool;

// Mirrors backend_db.js's withTenant exactly, against runtimePool
// specifically, because the entire point of this suite is proving the
// RESTRICTED role's queries are actually isolated — testing through
// the admin/owner connection would just reproduce the original bug.
async function withTenant(tenantId, fn, userId = null) {
  const client = await runtimePool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_user_id', $2, true)", [tenantId, userId ?? ""]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

before(async () => {
  adminClient = new pg.Client({ connectionString: ADMIN_URL });
  await adminClient.connect();
  // Unconditional reset rather than assuming a fresh database — a
  // before() hook shouldn't trust ambient state it didn't create
  // itself.
  await adminClient.query("DROP SCHEMA public CASCADE");
  await adminClient.query("CREATE SCHEMA public");
  await applyMigrations(adminClient, "./migrations");
  await ensureRuntimeRole(adminClient, RUNTIME_PASSWORD);

  const runtimeUrl = ADMIN_URL.replace(/\/\/[^@]+@/, `//ems_app_runtime:${RUNTIME_PASSWORD}@`);
  runtimePool = new pg.Pool({ connectionString: runtimeUrl });

  await adminClient.query(
    `INSERT INTO tenants (tenant_id, legal_name, display_name, regulatory_state, encryption_key_ref)
     VALUES ($1, 'Tenant A', 'Tenant A', 'NY', 'test'), ($2, 'Tenant B', 'Tenant B', 'NY', 'test')`,
    [TENANT_A, TENANT_B]
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
});

after(async () => {
  await runtimePool.end();
  await adminClient.end();
});

test("the runtime role is genuinely restricted, not just named differently", async () => {
  const result = await adminClient.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'ems_app_runtime'"
  );
  assert.equal(result.rows[0].rolsuper, false, "runtime role must not be superuser");
  assert.equal(result.rows[0].rolbypassrls, false, "runtime role must not have BYPASSRLS");

  const owner = await adminClient.query("SELECT tableowner FROM pg_tables WHERE tablename = 'incidents'");
  assert.notEqual(owner.rows[0].tableowner, "ems_app_runtime", "runtime role must not own the tables it queries");
});

test("a tenant cannot read another tenant's incident with no grant", async () => {
  const incident = await withTenant(TENANT_A, (client) =>
    client.query(
      `INSERT INTO incidents (tenant_id, incident_type, priority, protocol_set_id, scene_address)
       VALUES ($1, 'emergency_911', 'critical', $2, 'Isolation test') RETURNING incident_id`,
      [TENANT_A, PROTOCOL_SET_A]
    )
  );
  const incidentId = incident.rows[0].incident_id;

  const ownerRead = await withTenant(TENANT_A, (client) =>
    client.query("SELECT * FROM incidents WHERE incident_id = $1", [incidentId])
  );
  assert.equal(ownerRead.rows.length, 1, "the owning tenant must see its own incident");

  const otherRead = await withTenant(TENANT_B, (client) =>
    client.query("SELECT * FROM incidents WHERE incident_id = $1", [incidentId])
  );
  assert.equal(otherRead.rows.length, 0, "an unrelated tenant must see nothing — this is the exact property that silently failed under the owner role");
});

test("a mutual-aid grant makes the incident visible, and revoking it removes that visibility again", async () => {
  const incident = await withTenant(TENANT_A, (client) =>
    client.query(
      `INSERT INTO incidents (tenant_id, incident_type, priority, protocol_set_id, scene_address)
       VALUES ($1, 'emergency_911', 'critical', $2, 'Grant test') RETURNING incident_id`,
      [TENANT_A, PROTOCOL_SET_A]
    )
  );
  const incidentId = incident.rows[0].incident_id;

  const beforeGrant = await withTenant(TENANT_B, (client) =>
    client.query("SELECT * FROM incidents WHERE incident_id = $1", [incidentId])
  );
  assert.equal(beforeGrant.rows.length, 0);

  const grant = await withTenant(TENANT_A, (client) =>
    client.query(
      `INSERT INTO mutual_aid_links (requesting_tenant_id, assisting_tenant_id, incident_id, granted_by_user_id, reason, expires_at)
       VALUES ($1, $2, $3, $4, 'test grant', now() + interval '1 hour') RETURNING link_id`,
      [TENANT_A, TENANT_B, incidentId, USER_A_SUPERVISOR]
    )
  );
  const linkId = grant.rows[0].link_id;

  const afterGrant = await withTenant(TENANT_B, (client) =>
    client.query("SELECT * FROM incidents WHERE incident_id = $1", [incidentId])
  );
  assert.equal(afterGrant.rows.length, 1, "an active grant must make the incident visible to the assisting tenant");

  await withTenant(TENANT_A, (client) =>
    client.query("UPDATE mutual_aid_links SET status = 'revoked', revoked_at = now() WHERE link_id = $1", [linkId])
  );

  const afterRevoke = await withTenant(TENANT_B, (client) =>
    client.query("SELECT * FROM incidents WHERE incident_id = $1", [incidentId])
  );
  assert.equal(afterRevoke.rows.length, 0, "revoking the grant must remove visibility again, not just stop new grants");
});

test("a mutual-aid grant cannot exceed 72 hours — the database rejects it, not just the API", async () => {
  const incident = await withTenant(TENANT_A, (client) =>
    client.query(
      `INSERT INTO incidents (tenant_id, incident_type, priority, protocol_set_id, scene_address)
       VALUES ($1, 'emergency_911', 'routine', $2, '72-hour cap test') RETURNING incident_id`,
      [TENANT_A, PROTOCOL_SET_A]
    )
  );
  const incidentId = incident.rows[0].incident_id;

  await assert.rejects(
    () =>
      withTenant(TENANT_A, (client) =>
        client.query(
          `INSERT INTO mutual_aid_links (requesting_tenant_id, assisting_tenant_id, incident_id, granted_by_user_id, reason, expires_at)
           VALUES ($1, $2, $3, $4, 'too long', now() + interval '73 hours')`,
          [TENANT_A, TENANT_B, incidentId, USER_A_SUPERVISOR]
        )
      ),
    /max_grant_window/,
    "a grant longer than 72 hours must be rejected by the CHECK constraint, even if application code forgot to validate it"
  );
});

test("a crew member with no current ALS certification cannot be assigned to an ALS unit", async () => {
  const vehicle = await withTenant(TENANT_A, (client) =>
    client.query(
      `INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1, 'Test ALS Unit', 'ALS') RETURNING vehicle_id`,
      [TENANT_A]
    )
  );
  const unit = await withTenant(TENANT_A, (client) =>
    client.query(`INSERT INTO units (tenant_id, vehicle_id) VALUES ($1, $2) RETURNING unit_id`, [TENANT_A, vehicle.rows[0].vehicle_id])
  );
  const crewMember = await withTenant(TENANT_A, (client) =>
    client.query(
      `INSERT INTO crew_members (tenant_id, first_name, last_name) VALUES ($1, 'Test', 'EMT') RETURNING crew_member_id`,
      [TENANT_A]
    )
  );
  // Deliberately no row inserted into certifications for this crew
  // member — the point is proving the hard-block fires on absence,
  // not just on an expired one.

  await assert.rejects(
    () =>
      withTenant(TENANT_A, (client) =>
        client.query(`INSERT INTO unit_crew_assignments (tenant_id, unit_id, crew_member_id) VALUES ($1, $2, $3)`, [
          TENANT_A,
          unit.rows[0].unit_id,
          crewMember.rows[0].crew_member_id,
        ])
      ),
    /no current ALS-level certification/,
    "assigning an uncertified crew member to an ALS unit must be blocked at the database level, not just flagged in the UI"
  );
});

// ---- Coverage added for backend_routes_units.js and the incident
// completion route — none of this existed before, and it's the exact
// class of thing (a real column-extraction query, a multi-write
// transaction, a release-everything loop) that has already produced
// real bugs elsewhere in this project when it went untested.

test("the units listing query correctly extracts lat/lon from the PostGIS geography column", async () => {
  const vehicle = await withTenant(TENANT_A, (client) =>
    client.query(
      `INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1, 'Unit Location Test', 'BLS') RETURNING vehicle_id`,
      [TENANT_A]
    )
  );
  const KNOWN_LAT = 40.8566;
  const KNOWN_LON = -73.8472;
  await withTenant(TENANT_A, (client) =>
    client.query(
      `INSERT INTO units (tenant_id, vehicle_id, current_location)
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography)`,
      [TENANT_A, vehicle.rows[0].vehicle_id, KNOWN_LON, KNOWN_LAT]
    )
  );

  // Same query backend_routes_units.js's GET /units handler runs.
  const result = await withTenant(TENANT_A, (client) =>
    client.query(`
      SELECT ST_Y(u.current_location::geometry) AS lat, ST_X(u.current_location::geometry) AS lon, v.unit_designation
      FROM units u JOIN vehicles v ON v.vehicle_id = u.vehicle_id
      WHERE v.unit_designation = 'Unit Location Test'
    `)
  );
  assert.equal(result.rows.length, 1);
  assert.ok(Math.abs(result.rows[0].lat - KNOWN_LAT) < 0.0001, "extracted latitude must match what was stored, not be swapped with longitude");
  assert.ok(Math.abs(result.rows[0].lon - KNOWN_LON) < 0.0001, "extracted longitude must match what was stored, not be swapped with latitude");
});

test("changing unit status writes both the status and a history row in the same transaction", async () => {
  const vehicle = await withTenant(TENANT_A, (client) =>
    client.query(
      `INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1, 'Status Test Unit', 'BLS') RETURNING vehicle_id`,
      [TENANT_A]
    )
  );
  const unit = await withTenant(TENANT_A, (client) =>
    client.query(`INSERT INTO units (tenant_id, vehicle_id, current_status) VALUES ($1, $2, 'available') RETURNING unit_id`, [
      TENANT_A,
      vehicle.rows[0].vehicle_id,
    ])
  );
  const unitId = unit.rows[0].unit_id;

  // Mirrors backend_routes_units.js's PATCH /units/:id/status handler
  // exactly — both writes inside one withTenant call, not two.
  await withTenant(TENANT_A, async (client) => {
    await client.query("UPDATE units SET current_status = 'en_route' WHERE unit_id = $1", [unitId]);
    await client.query("INSERT INTO unit_status_history (tenant_id, unit_id, status) VALUES ($1, $2, 'en_route')", [TENANT_A, unitId]);
  });

  const unitCheck = await withTenant(TENANT_A, (client) => client.query("SELECT current_status FROM units WHERE unit_id = $1", [unitId]));
  assert.equal(unitCheck.rows[0].current_status, "en_route");

  const historyCheck = await withTenant(TENANT_A, (client) =>
    client.query("SELECT status FROM unit_status_history WHERE unit_id = $1", [unitId])
  );
  assert.equal(historyCheck.rows.length, 1, "unit_status_history must gain a row — it's the source of truth for response-time reporting, and a status change that doesn't write here is an incomplete one");
  assert.equal(historyCheck.rows[0].status, "en_route");
});

test("completing an incident releases every assigned unit and closes the incident, atomically", async () => {
  const v1 = await withTenant(TENANT_A, (client) =>
    client.query(`INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1, 'Complete Test Primary', 'BLS') RETURNING vehicle_id`, [TENANT_A])
  );
  const v2 = await withTenant(TENANT_A, (client) =>
    client.query(`INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1, 'Complete Test Intercept', 'ALS') RETURNING vehicle_id`, [TENANT_A])
  );
  const u1 = await withTenant(TENANT_A, (client) =>
    client.query(`INSERT INTO units (tenant_id, vehicle_id, current_status) VALUES ($1, $2, 'assigned') RETURNING unit_id`, [TENANT_A, v1.rows[0].vehicle_id])
  );
  const u2 = await withTenant(TENANT_A, (client) =>
    client.query(`INSERT INTO units (tenant_id, vehicle_id, current_status) VALUES ($1, $2, 'assigned') RETURNING unit_id`, [TENANT_A, v2.rows[0].vehicle_id])
  );
  const incident = await withTenant(TENANT_A, (client) =>
    client.query(
      `INSERT INTO incidents (tenant_id, incident_type, priority, protocol_set_id, scene_address)
       VALUES ($1, 'emergency_911', 'critical', $2, 'Complete test — two units') RETURNING incident_id`,
      [TENANT_A, PROTOCOL_SET_A]
    )
  );
  const incidentId = incident.rows[0].incident_id;
  await withTenant(TENANT_A, (client) =>
    client.query(`INSERT INTO incident_unit_assignments (tenant_id, incident_id, unit_id, role) VALUES ($1, $2, $3, 'primary')`, [TENANT_A, incidentId, u1.rows[0].unit_id])
  );
  await withTenant(TENANT_A, (client) =>
    client.query(`INSERT INTO incident_unit_assignments (tenant_id, incident_id, unit_id, role) VALUES ($1, $2, $3, 'als_intercept')`, [TENANT_A, incidentId, u2.rows[0].unit_id])
  );

  // Mirrors POST /incidents/:id/complete from backend_routes_example.js
  await withTenant(TENANT_A, async (client) => {
    const active = await client.query("SELECT unit_id FROM incident_unit_assignments WHERE incident_id = $1 AND unassigned_at IS NULL", [incidentId]);
    for (const row of active.rows) {
      await client.query("UPDATE incident_unit_assignments SET unassigned_at = now() WHERE incident_id = $1 AND unit_id = $2 AND unassigned_at IS NULL", [incidentId, row.unit_id]);
      await client.query("UPDATE units SET current_status = 'available' WHERE unit_id = $1", [row.unit_id]);
    }
    await client.query("UPDATE incidents SET closed_at = now() WHERE incident_id = $1", [incidentId]);
  });

  const incidentCheck = await withTenant(TENANT_A, (client) => client.query("SELECT closed_at FROM incidents WHERE incident_id = $1", [incidentId]));
  assert.ok(incidentCheck.rows[0].closed_at !== null, "the incident must be closed");

  const assignmentsCheck = await withTenant(TENANT_A, (client) =>
    client.query("SELECT unassigned_at FROM incident_unit_assignments WHERE incident_id = $1", [incidentId])
  );
  assert.equal(assignmentsCheck.rows.length, 2);
  assert.ok(assignmentsCheck.rows.every((r) => r.unassigned_at !== null), "both assignments must be released, not just the first one found");

  const unitsCheck = await withTenant(TENANT_A, (client) =>
    client.query("SELECT current_status FROM units WHERE unit_id = ANY($1)", [[u1.rows[0].unit_id, u2.rows[0].unit_id]])
  );
  assert.ok(unitsCheck.rows.every((r) => r.current_status === "available"), "both units — primary and intercept — must be returned to available, not just the primary");
});

// =====================================================================
// MARKER-hardening-tests
// Added after probing views, mutual-aid WRITE access, and audit-table
// grants directly. The original suite only proved tables isolate for
// reads; each of these was a "should be fine" nobody had actually run.
// =====================================================================

async function createIncidentFor(tenantId, address) {
  const r = await withTenant(tenantId, (c) =>
    c.query(
      `INSERT INTO incidents (tenant_id, incident_type, priority, protocol_set_id, scene_address)
       VALUES ($1, 'emergency_911', 'routine', $2, $3) RETURNING incident_id`,
      [tenantId, PROTOCOL_SET_A, address]
    )
  );
  return r.rows[0].incident_id;
}
async function grantAtoB(incidentId) {
  const r = await withTenant(TENANT_A, (c) =>
    c.query(
      `INSERT INTO mutual_aid_links (requesting_tenant_id, assisting_tenant_id, incident_id, granted_by_user_id, reason, expires_at)
       VALUES ($1, $2, $3, $4, 'hardening probe', now() + interval '1 hour') RETURNING link_id`,
      [TENANT_A, TENANT_B, incidentId, USER_A_SUPERVISOR]
    )
  );
  return r.rows[0].link_id;
}
async function createUnitFor(tenantId, designation) {
  const v = await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1, $2, 'BLS') RETURNING vehicle_id`, [tenantId, designation])
  );
  const u = await withTenant(tenantId, (c) =>
    c.query(`INSERT INTO units (tenant_id, vehicle_id) VALUES ($1, $2) RETURNING unit_id`, [tenantId, v.rows[0].vehicle_id])
  );
  return u.rows[0].unit_id;
}

test("views don't bypass row-level security — crew and assignments are invisible to other tenants through them", async () => {
  const unitId = await createUnitFor(TENANT_A, "View Leak Unit");
  const crew = await withTenant(TENANT_A, (c) =>
    c.query(`INSERT INTO crew_members (tenant_id, first_name, last_name, employee_number) VALUES ($1, 'View', 'Leak', '7777') RETURNING crew_member_id`, [TENANT_A])
  );
  await withTenant(TENANT_A, (c) =>
    c.query(`INSERT INTO unit_crew_assignments (tenant_id, unit_id, crew_member_id, seat_role) VALUES ($1, $2, $3, 'driver')`, [TENANT_A, unitId, crew.rows[0].crew_member_id])
  );
  const incidentId = await createIncidentFor(TENANT_A, "View leak test");
  await withTenant(TENANT_A, (c) =>
    c.query(`INSERT INTO incident_unit_assignments (tenant_id, incident_id, unit_id, role) VALUES ($1, $2, $3, 'primary')`, [TENANT_A, incidentId, unitId])
  );

  const ownerCrew = await withTenant(TENANT_A, (c) => c.query("SELECT * FROM unit_crew_display WHERE unit_id = $1", [unitId]));
  assert.equal(ownerCrew.rows.length, 1, "control: the owning tenant must still see its own crew through the view");
  const ownerPrimary = await withTenant(TENANT_A, (c) => c.query("SELECT * FROM incident_primary_unit WHERE incident_id = $1", [incidentId]));
  assert.equal(ownerPrimary.rows.length, 1, "control: the owning tenant must still see its own primary unit through the view");

  const otherCrew = await withTenant(TENANT_B, (c) => c.query("SELECT * FROM unit_crew_display WHERE unit_id = $1", [unitId]));
  assert.equal(otherCrew.rows.length, 0, "unit_crew_display leaked another tenant's crew — views run as their owner (who bypasses RLS) unless security_invoker is set");
  const otherPrimary = await withTenant(TENANT_B, (c) => c.query("SELECT * FROM incident_primary_unit WHERE incident_id = $1", [incidentId]));
  assert.equal(otherPrimary.rows.length, 0, "incident_primary_unit leaked another tenant's assignments");
});

test("every mutual-aid sharing policy is SELECT-only, so read-sharing can never confer write access", async () => {
  // Structural on purpose. A behavioral DELETE probe against incidents
  // can't tell a correct policy from a wrong one, because the grant row
  // itself holds a foreign key to the incident and blocks the delete
  // regardless — that's incidental protection, not the policy working.
  const r = await adminClient.query(
    `SELECT tablename, policyname, cmd FROM pg_policies
     WHERE schemaname = 'public' AND cmd <> 'SELECT'
       AND (coalesce(qual, '') ILIKE '%mutual_aid_links%' OR coalesce(qual, '') ILIKE '%incident_unit_assignments%')`
  );
  assert.deepEqual(r.rows, [], `these policies extend access through a mutual-aid grant but also apply to writes: ${JSON.stringify(r.rows)}`);
});

test("an assisting tenant cannot erase the owner's unit status history for a shared incident", async () => {
  // unit_status_history is a leaf table — nothing references it — so
  // unlike incidents there is no foreign key to mask a bad policy here.
  const unitId = await createUnitFor(TENANT_A, "History Probe Unit");
  const incidentId = await createIncidentFor(TENANT_A, "History tamper probe");
  await withTenant(TENANT_A, (c) =>
    c.query(`INSERT INTO unit_status_history (tenant_id, unit_id, incident_id, status) VALUES ($1, $2, $3, 'en_route')`, [TENANT_A, unitId, incidentId])
  );
  await grantAtoB(incidentId);

  const seen = await withTenant(TENANT_B, (c) => c.query("SELECT 1 FROM unit_status_history WHERE incident_id = $1", [incidentId]));
  assert.equal(seen.rows.length, 1, "control: the grant must make the owner's history readable to the assisting tenant");

  let deleted = 0;
  try {
    deleted = (await withTenant(TENANT_B, (c) => c.query("DELETE FROM unit_status_history WHERE incident_id = $1 RETURNING history_id", [incidentId]))).rows.length;
  } catch (e) {
    deleted = 0; // permission denied is an equally good outcome
  }
  assert.equal(deleted, 0, "the assisting tenant deleted the owning tenant's status history — response-time evidence erased by someone else's grant");

  const still = await withTenant(TENANT_A, (c) => c.query("SELECT 1 FROM unit_status_history WHERE incident_id = $1", [incidentId]));
  assert.equal(still.rows.length, 1, "the owner's history row must still exist");
});

test("mutual aid shares exactly the units active on the shared incident — not the owner's other units — and revoking removes them", async () => {
  const sharedUnit = await createUnitFor(TENANT_A, "Shared Unit Probe");
  const unsharedUnit = await createUnitFor(TENANT_A, "Unshared Unit Probe");
  const incidentId = await createIncidentFor(TENANT_A, "Shared unit visibility");
  await withTenant(TENANT_A, (c) =>
    c.query(`INSERT INTO incident_unit_assignments (tenant_id, incident_id, unit_id, role) VALUES ($1, $2, $3, 'primary')`, [TENANT_A, incidentId, sharedUnit])
  );
  const seeFromB = async () =>
    (await withTenant(TENANT_B, (c) => c.query("SELECT unit_id FROM units WHERE unit_id = ANY($1)", [[sharedUnit, unsharedUnit]]))).rows.map((r) => r.unit_id);

  assert.deepEqual(await seeFromB(), [], "before any grant, the assisting tenant must see neither unit");

  const linkId = await grantAtoB(incidentId);
  const during = await seeFromB();
  assert.deepEqual(during, [sharedUnit], "with an active grant the assisting tenant must see the unit on the shared incident, and ONLY that one");

  await withTenant(TENANT_A, (c) => c.query("UPDATE mutual_aid_links SET status = 'revoked', revoked_at = now() WHERE link_id = $1", [linkId]));
  assert.deepEqual(await seeFromB(), [], "after revoking, the assisting tenant must lose sight of the unit again");
});

test("the runtime role cannot rewrite or delete audit and chain-of-custody records", async () => {
  for (const table of ["audit_log", "unit_status_history", "pcr_amendments", "controlled_substance_log", "protocol_search_log"]) {
    await assert.rejects(
      () => withTenant(TENANT_A, (c) => c.query(`DELETE FROM ${table}`)),
      /permission denied/i,
      `the runtime role was able to DELETE from ${table} — the schema says this record must be append-only`
    );
    await assert.rejects(
      () => withTenant(TENANT_A, (c) => c.query(`UPDATE ${table} SET tenant_id = tenant_id`)),
      /permission denied/i,
      `the runtime role was able to UPDATE ${table} — the schema says this record must be append-only`
    );
  }
  await assert.rejects(
    () => withTenant(TENANT_A, (c) => c.query("DELETE FROM mutual_aid_links")),
    /permission denied/i,
    "grants are revoked by changing status, never deleted — deleting one destroys the evidence that access was ever given"
  );
});

// =====================================================================
// MARKER-claims-audit
// Claims the README made that no test had checked: the certification
// rule only ever had its BLOCK path tested (and only for a missing cert,
// never a lapsed one — nor the ALLOW path, so a trigger that refused
// everyone would have passed), and the audit log was called
// hash-chained without a single row ever being written to it.
// =====================================================================
test("an ALS unit accepts a crew member whose certification is current and refuses one whose has lapsed", async () => {
  const v = await withTenant(TENANT_A, (c) => c.query(`INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1, 'Cert Rule ALS', 'ALS') RETURNING vehicle_id`, [TENANT_A]));
  const u = await withTenant(TENANT_A, (c) => c.query(`INSERT INTO units (tenant_id, vehicle_id) VALUES ($1, $2) RETURNING unit_id`, [TENANT_A, v.rows[0].vehicle_id]));
  const ct = await withTenant(TENANT_A, (c) =>
    c.query(`INSERT INTO certification_types (tenant_id, code, label, required_for_capability) VALUES ($1, 'PARAMEDIC-T', 'Paramedic', 'ALS') RETURNING certification_type_id`, [TENANT_A])
  );
  const mkCrew = async (last, expiresExpr) => {
    const cm = await withTenant(TENANT_A, (c) => c.query(`INSERT INTO crew_members (tenant_id, first_name, last_name) VALUES ($1, 'Cert', $2) RETURNING crew_member_id`, [TENANT_A, last]));
    await withTenant(TENANT_A, (c) =>
      c.query(`INSERT INTO certifications (tenant_id, crew_member_id, certification_type_id, issuing_body, issued_on, expires_on) VALUES ($1, $2, $3, 'NYS DOH', CURRENT_DATE - 800, ${expiresExpr})`, [TENANT_A, cm.rows[0].crew_member_id, ct.rows[0].certification_type_id])
    );
    return cm.rows[0].crew_member_id;
  };
  const current = await mkCrew("Current", "CURRENT_DATE + 30");
  const lapsed = await mkCrew("Lapsed", "CURRENT_DATE - 1");
  const assign = (crewId) => withTenant(TENANT_A, (c) => c.query(`INSERT INTO unit_crew_assignments (tenant_id, unit_id, crew_member_id) VALUES ($1, $2, $3)`, [TENANT_A, u.rows[0].unit_id, crewId]));

  await assign(current); // must not throw — otherwise the rule just refuses everyone
  await assert.rejects(() => assign(lapsed), /no current ALS-level certification/, "a certification that expired yesterday must not count");
});

test("audit_log rows chain: each prev_hash is the previous row_hash, and other tenants can't see them", async () => {
  const lastBefore = (await withTenant(TENANT_A, (c) => c.query(`SELECT row_hash FROM audit_log WHERE tenant_id = $1 ORDER BY audit_id DESC LIMIT 1`, [TENANT_A]))).rows[0];
  for (const action of ["view", "update", "export"]) {
    await withTenant(TENANT_A, (c) =>
      c.query(`INSERT INTO audit_log (tenant_id, actor_user_id, action, table_name, detail) VALUES ($1, $2, $3, 'chain_probe', '{}')`, [TENANT_A, USER_A_SUPERVISOR, action])
    );
  }
  const rows = (await withTenant(TENANT_A, (c) => c.query(`SELECT prev_hash, row_hash FROM audit_log WHERE table_name = 'chain_probe' ORDER BY audit_id`))).rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].prev_hash, lastBefore ? lastBefore.row_hash : "GENESIS", "a new entry must chain onto whatever the log already held");
  assert.equal(rows[1].prev_hash, rows[0].row_hash);
  assert.equal(rows[2].prev_hash, rows[1].row_hash);
  assert.notEqual(rows[0].row_hash, rows[1].row_hash, "distinct entries must hash differently");
  const other = await withTenant(TENANT_B, (c) => c.query(`SELECT 1 FROM audit_log WHERE table_name = 'chain_probe'`));
  assert.equal(other.rows.length, 0, "another tenant must not see this tenant's audit entries");
});

// =====================================================================
// MARKER-audit-trail
// Until now nothing wrote to audit_log. These pin what "audited" means.
// =====================================================================
const ACTOR_1 = "dddddddd-0000-0000-0000-000000000001";
const ACTOR_2 = "dddddddd-0000-0000-0000-000000000002";
const insertIncident = (c, address) =>
  c.query(`INSERT INTO incidents (tenant_id, incident_type, priority, protocol_set_id, scene_address) VALUES ($1, 'emergency_911', 'routine', $2, $3) RETURNING incident_id`, [TENANT_A, PROTOCOL_SET_A, address]);
const verifyChain = (tz) =>
  withTenant(TENANT_A, async (c) => {
    if (tz) await c.query(`SET LOCAL TIME ZONE '${tz}'`);
    return (await c.query("SELECT audit_id, problem FROM audit_chain_verify($1)", [TENANT_A])).rows;
  });

test("every write to an audited table leaves an entry naming the actor and the changed columns — never the values", async () => {
  const id = (await withTenant(TENANT_A, (c) => insertIncident(c, "Audit probe 1234 Secret St"), ACTOR_1)).rows[0].incident_id;
  await withTenant(TENANT_A, (c) => c.query("UPDATE incidents SET priority = 'critical', scene_address = 'Changed 9999 Other St' WHERE incident_id = $1", [id]), ACTOR_1);
  await withTenant(TENANT_A, (c) => c.query("UPDATE incidents SET priority = 'critical' WHERE incident_id = $1", [id]), ACTOR_1); // changes nothing: must not log
  await withTenant(TENANT_A, (c) => c.query("DELETE FROM incidents WHERE incident_id = $1", [id]), ACTOR_1);

  const rows = (await withTenant(TENANT_A, (c) => c.query("SELECT action, actor_user_id, table_name, detail FROM audit_log WHERE record_id = $1 ORDER BY audit_id", [id]))).rows;
  assert.deepEqual(rows.map((r) => r.action), ["insert", "update", "delete"], "one entry per real change, none for the no-op update");
  assert.ok(rows.every((r) => r.actor_user_id === ACTOR_1 && r.table_name === "incidents"), "every entry names who did it and what it touched");
  assert.deepEqual(rows[1].detail.changed, ["priority", "scene_address"]);
  assert.ok(!/Secret St|Other St|critical/.test(JSON.stringify(rows.map((r) => r.detail))), "the trail records which fields changed, not what they contained — PHI must not be copied into the log");
});

test("the audit chain verifies when untouched, flags an entry altered after the fact, and doesn't depend on the session's time zone", async () => {
  const id = (await withTenant(TENANT_A, (c) => insertIncident(c, "Tamper probe"), ACTOR_1)).rows[0].incident_id;
  await withTenant(TENANT_A, (c) => c.query("UPDATE incidents SET priority = 'urgent' WHERE incident_id = $1", [id]), ACTOR_1);
  assert.deepEqual(await verifyChain(), [], "an untouched log must verify");
  assert.deepEqual(await verifyChain("Asia/Tokyo"), [], "verification must not change with the session time zone");

  const victim = (await adminClient.query("SELECT audit_id, detail FROM audit_log WHERE record_id = $1 AND action = 'update'", [id])).rows[0];
  await adminClient.query(`UPDATE audit_log SET detail = '{"changed":[]}' WHERE audit_id = $1`, [victim.audit_id]);
  const flagged = await verifyChain();
  assert.ok(flagged.some((r) => String(r.audit_id) === String(victim.audit_id)), "an entry whose contents were rewritten must be flagged");
  await adminClient.query("UPDATE audit_log SET detail = $2 WHERE audit_id = $1", [victim.audit_id, victim.detail]);
  assert.deepEqual(await verifyChain(), [], "restoring the original contents restores a valid chain");

  // The actor is in the digest too. Rewriting WHO did something has to be
  // caught as surely as rewriting WHAT — an audit trail that can be
  // quietly re-attributed doesn't establish accountability.
  await adminClient.query("UPDATE audit_log SET actor_user_id = $2 WHERE audit_id = $1", [victim.audit_id, "99999999-0000-0000-0000-000000000099"]);
  assert.ok((await verifyChain()).some((r) => String(r.audit_id) === String(victim.audit_id)), "an entry whose actor was rewritten must be flagged");
  await adminClient.query("UPDATE audit_log SET actor_user_id = $2 WHERE audit_id = $1", [victim.audit_id, ACTOR_1]);
  assert.deepEqual(await verifyChain(), [], "restoring the original actor restores a valid chain");
});

test("concurrent audited writes still produce one unbroken chain", async () => {
  const count = async () => Number((await adminClient.query("SELECT count(*) FROM audit_log WHERE tenant_id = $1", [TENANT_A])).rows[0].count);
  const before = await count();
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      withTenant(TENANT_A, async (c) => {
        await insertIncident(c, `Concurrent ${i}`);
        await c.query("SELECT pg_sleep(0.03)"); // keep the transaction open so the audit writes genuinely overlap
      }, ACTOR_2)
    )
  );
  assert.equal((await count()) - before, 30, "one entry per write");
  assert.deepEqual(await verifyChain(), [], "overlapping writes forked the chain");
  const forks = await adminClient.query("SELECT prev_hash FROM audit_log WHERE tenant_id = $1 GROUP BY prev_hash HAVING count(*) > 1", [TENANT_A]);
  assert.equal(forks.rows.length, 0, "two entries claim the same predecessor");
});
