#!/usr/bin/env node
// Creates your first agency, an admin (supervisor) user, the active protocol
// set and your units on a fresh database — from environment variables, so it
// can run from a GitHub Action (no terminal needed). Safe to re-run: anything
// that already exists is left alone, and new units in UNITS are added.
//
//   MIGRATION_DATABASE_URL  owner connection string (direct, not pooled)
//   TENANT_ID, USER_ID      UUIDs of the company and its owner account
//   ADMIN_PASSWORD          the owner's sign-in password (10+ characters). Running this
//                           again with a new value resets it — the recovery path if it's forgotten.
//   AGENCY_NAME, AGENCY_STATE (e.g. NY), ADMIN_EMAIL, ADMIN_NAME
//   PROTOCOL_AUTHORITY      e.g. "NYC REMAC"
//   UNITS                   "Medic 1:ALS,Medic 2:BLS,Medic 3:CCT"
import "dotenv/config";
import pg from "pg";
import { hashPassword, passwordProblem } from "../backend_passwords.js";

const e = process.env;
const need = ["MIGRATION_DATABASE_URL", "TENANT_ID", "USER_ID", "AGENCY_NAME", "AGENCY_STATE", "ADMIN_EMAIL", "ADMIN_PASSWORD"];
const missing = need.filter((k) => !e[k]);
if (missing.length) {
  console.error("Missing: " + missing.join(", ") + "\nFill in the workflow boxes (company, state, your name and email) and make sure the ADMIN_PASSWORD, MIGRATION_DATABASE_URL secrets exist.");
  process.exit(1);
}

const pwProblem = passwordProblem(e.ADMIN_PASSWORD);
if (pwProblem) { console.error(pwProblem); process.exit(1); }
const passwordHash = await hashPassword(e.ADMIN_PASSWORD);

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
  // The owner account always reflects what was typed into the workflow,
  // so re-running it can fix a wrong email or a forgotten password.
  await client.query(
    `INSERT INTO users (user_id, tenant_id, email, display_name, role, password_hash)
     VALUES ($1, $2, lower($3), $4, 'supervisor', $5)
     ON CONFLICT (user_id) DO UPDATE SET
       email = EXCLUDED.email, display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash,
       failed_logins = 0, locked_until = NULL, is_active = TRUE`,
    [e.USER_ID, e.TENANT_ID, e.ADMIN_EMAIL.trim(), e.ADMIN_NAME || "Admin", passwordHash]
  );
  const [first, ...rest] = (e.ADMIN_NAME || "Admin").trim().split(/\s+/);
  await client.query(
    `INSERT INTO crew_members (tenant_id, user_id, first_name, last_name)
     SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM crew_members WHERE user_id = $2)`,
    [e.TENANT_ID, e.USER_ID, first, rest.join(" ") || "-"]
  );
  await client.query(
    `INSERT INTO certification_types (tenant_id, code, label, required_for_capability)
     VALUES ($1, 'EMT-B', 'EMT-Basic', NULL), ($1, 'PARAMEDIC', 'Paramedic', 'ALS')
     ON CONFLICT (tenant_id, code) DO NOTHING`,
    [e.TENANT_ID]
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
      "INSERT INTO units (tenant_id, vehicle_id, current_status) VALUES ($1, $2, 'out_of_service')",
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
