#!/usr/bin/env node
// Creates your first agency, an admin (supervisor) user, the active protocol
// set and your units on a fresh database — from environment variables, so it
// can run from a GitHub Action (no terminal needed). Safe to re-run: anything
// that already exists is left alone, and new units in UNITS are added.
//
//   MIGRATION_DATABASE_URL  owner connection string (direct, not pooled)
//   TENANT_ID, USER_ID      UUIDs (the token you paste must use these)
//   AGENCY_NAME, AGENCY_STATE (e.g. NY), ADMIN_EMAIL, ADMIN_NAME
//   PROTOCOL_AUTHORITY      e.g. "NYC REMAC"
//   UNITS                   "Medic 1:ALS,Medic 2:BLS,Medic 3:CCT"
import "dotenv/config";
import pg from "pg";

const e = process.env;
const need = ["MIGRATION_DATABASE_URL", "TENANT_ID", "USER_ID", "AGENCY_NAME", "AGENCY_STATE", "ADMIN_EMAIL"];
const missing = need.filter((k) => !e[k]);
if (missing.length) { console.error("Missing: " + missing.join(", ")); process.exit(1); }

const units = (e.UNITS || "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
  const [name, cap = "BLS"] = x.split(":").map((p) => p.trim());
  if (!["BLS", "ALS", "CCT"].includes(cap.toUpperCase())) { console.error(`Bad capability "${cap}" for "${name}" (use BLS, ALS or CCT)`); process.exit(1); }
  return { name, cap: cap.toUpperCase() };
});

const client = new pg.Client({ connectionString: e.MIGRATION_DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO tenants (tenant_id, legal_name, display_name, regulatory_state, regulatory_region, encryption_key_ref)
     VALUES ($1, $2, $2, $3, $4, 'not-yet-used') ON CONFLICT (tenant_id) DO NOTHING`,
    [e.TENANT_ID, e.AGENCY_NAME, e.AGENCY_STATE, e.REGULATORY_REGION || null]
  );
  const ps = await client.query("SELECT 1 FROM protocol_sets WHERE tenant_id = $1", [e.TENANT_ID]);
  if (!ps.rows.length) {
    await client.query(
      `INSERT INTO protocol_sets (tenant_id, issuing_authority, version_label, effective_from)
       VALUES ($1, $2, 'initial', CURRENT_DATE)`,
      [e.TENANT_ID, e.PROTOCOL_AUTHORITY || "Local protocols"]
    );
  }
  await client.query(
    `INSERT INTO users (user_id, tenant_id, email, display_name, role)
     VALUES ($1, $2, $3, $4, 'supervisor') ON CONFLICT (user_id) DO NOTHING`,
    [e.USER_ID, e.TENANT_ID, e.ADMIN_EMAIL, e.ADMIN_NAME || "Admin"]
  );
  let added = 0;
  for (const u of units) {
    const have = await client.query("SELECT 1 FROM vehicles WHERE tenant_id = $1 AND unit_designation = $2", [e.TENANT_ID, u.name]);
    if (have.rows.length) continue;
    const v = await client.query(
      "INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1, $2, $3) RETURNING vehicle_id",
      [e.TENANT_ID, u.name, u.cap]
    );
    await client.query(
      "INSERT INTO units (tenant_id, vehicle_id, current_status) VALUES ($1, $2, 'available')",
      [e.TENANT_ID, v.rows[0].vehicle_id]
    );
    added++;
  }
  await client.query("COMMIT");
  console.log(`Agency "${e.AGENCY_NAME}" ready. Units added: ${added}.`);
} catch (err) {
  await client.query("ROLLBACK");
  console.error("Bootstrap failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
