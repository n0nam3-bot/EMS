// migrate.js
// -----------------------------------------------------------------------
// Applies every schema file in the one order that's actually valid —
// most only depend on the core schema, but multi_unit_incidents_schema
// specifically has to run after mutual_aid_schema, since it rewrites a
// policy that file creates. Getting that order right by hand once here
// beats hoping whoever runs this remembers it.
//
// Each file runs in its own transaction: a failure partway through one
// file rolls back that file cleanly instead of leaving the database in
// a half-migrated state.
//
// Usage: place the eight .sql files from this project in a ./migrations
// folder using the exact filenames below, then `npm run migrate`.
// -----------------------------------------------------------------------

import "dotenv/config";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import pg from "pg";
import { UPGRADE_SQL } from "./scripts/upgrade.js";

const MIGRATION_ORDER = [
  "ems_dispatch_core_schema.sql",
  "epcr_clinical_schema.sql",
  "protocol_reference_schema.sql",
  "mutual_aid_schema.sql",
  "multi_unit_incidents_schema.sql", // must come after mutual_aid_schema
  "crew_seat_role_schema.sql",
  "pcr_finalization_schema.sql", // needs patient_care_records and the pcr_* tables
  "audit_schema.sql", // last: attaches triggers to tables the files above create
];

// Exported so tests/isolation.test.js can build a real test database
// against the real migration files instead of a hand-maintained copy
// of the schema that could quietly drift from what actually deploys.
export async function applyMigrations(client, migrationsDir = "./migrations") {
  for (const file of MIGRATION_ORDER) {
    const filePath = path.join(migrationsDir, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing migration file: ${filePath}`);
    }
    const sql = fs.readFileSync(filePath, "utf8");
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
      console.log(`  ${file} ... done`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.log(`  ${file} ... FAILED`);
      throw new Error(`${file} failed: ${err.message}`);
    }
  }
  // Sign-in and the richer call record. Also run on its own against existing
  // databases (scripts/upgrade.js); every statement is safe to repeat.
  try {
    await client.query("BEGIN");
    await client.query(UPGRADE_SQL);
    await client.query("COMMIT");
    console.log("  upgrade (sign-in, call details) ... done");
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`upgrade failed: ${err.message}`);
  }
}

// Confirmed necessary by actually testing this, not a theoretical
// precaution: the role that runs migrations OWNS every table it
// creates, and table owners bypass row-level security regardless of
// whether they're also a superuser — a separate bypass mechanism from
// the superuser one, and just as complete. A live test against this
// exact schema, connected as the migration role, showed one tenant
// reading another tenant's incident with zero mutual-aid grant in
// place. Every RLS policy was correctly defined and completely inert.
// The application must connect as a role that neither owns the tables
// nor has superuser — this creates that role. Exported for the same
// reason as applyMigrations: tests need the real role, not a
// hand-copied approximation of it.
export async function ensureRuntimeRole(client, password) {
  if (!password) {
    return { created: false, reason: "no password supplied" };
  }
  // CREATE/ALTER ROLE don't accept bind parameters the way DML does
  // (same underlying constraint as SET, see backend_db.js) — acceptable
  // here specifically because this password is an operator-or-test-
  // supplied value, not attacker-reachable request input the way
  // withTenant's tenantId is.
  const escaped = password.replace(/'/g, "''");
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'ems_app_runtime'");
  if (exists.rows.length === 0) {
    await client.query(`CREATE USER ems_app_runtime WITH PASSWORD '${escaped}'`);
  } else {
    await client.query(`ALTER USER ems_app_runtime WITH PASSWORD '${escaped}'`);
  }
  await client.query("GRANT USAGE ON SCHEMA public TO ems_app_runtime");
  await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ems_app_runtime");
  await client.query("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ems_app_runtime");
  // Evidence tables are append-only to the application role. The core
  // schema's own comment says UPDATE and DELETE on audit_log must be
  // revoked from the app role entirely — and the blanket grant above
  // gave it everything, so a buggy or compromised API process could
  // rewrite the very record meant to catch it. Same reasoning for the
  // other tables whose whole value is that nobody edits them after the
  // fact. Mutual-aid grants are revoked by changing status, never
  // deleted: deleting one destroys the proof that access was granted.
  // Found by a test, not by review.
  await client.query(
    "REVOKE UPDATE, DELETE ON audit_log, unit_status_history, pcr_amendments, controlled_substance_log, protocol_search_log FROM ems_app_runtime"
  );
  await client.query("REVOKE DELETE ON mutual_aid_links FROM ems_app_runtime");
  // The two sign-in lookup functions (see scripts/upgrade.js) — the only way
  // the app can find an account before it knows which company it belongs to.
  await client.query(`DO $$ BEGIN
    IF to_regprocedure('auth_find_user(text)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION auth_find_user(TEXT) TO ems_app_runtime;
      GRANT EXECUTE ON FUNCTION auth_record_login(UUID, BOOLEAN) TO ems_app_runtime;
    END IF;
  END $$`);
  return { created: true };
}

async function migrate() {
  const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL });
  await client.connect();
  console.log(`Connected. Applying ${MIGRATION_ORDER.length} migrations...\n`);

  try {
    await applyMigrations(client, "./migrations");
    console.log("\nAll migrations applied successfully.\n");
  } catch (err) {
    console.error(err.message);
    await client.end();
    process.exit(1);
  }

  const password = process.env.RUNTIME_DB_PASSWORD;
  if (!password) {
    console.log("RUNTIME_DB_PASSWORD not set — skipping runtime role creation.");
    console.log("The API must NOT use the same connection as migrations (that role owns");
    console.log("every table, and owners bypass RLS the same way superusers do). Set");
    console.log("RUNTIME_DB_PASSWORD and re-run `npm run migrate` to create ems_app_runtime,");
    console.log("then point the API's DATABASE_URL at that role instead — see .env.example.");
  } else {
    await ensureRuntimeRole(client, password);
    console.log("ems_app_runtime ready. Point the API's DATABASE_URL at this role.");
  }
  await client.end();
}

// Guarded so importing this file (as tests/isolation.test.js does, to
// reuse applyMigrations/ensureRuntimeRole against a real database)
// doesn't ALSO trigger this module's own top-level migration run in
// the background. Without this check, that's exactly what happens:
// the import fires migrate() against whatever MIGRATION_DATABASE_URL
// is in .env, which — if that database is already migrated — fails
// and calls process.exit(1), tearing down whatever process imported
// this file. The comparison goes through pathToFileURL because a plain
// `file://${argv[1]}` string never matches on Windows (backslashes, a drive
// letter) — which made `npm run migrate` do nothing there, silently.
// That's not hypothetical; it's the actual bug that showed
// up while building the test suite this guards, and it cost real time
// to trace before the cause turned out to be this one missing check.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  migrate().catch((err) => {
    console.error("Unexpected migration error:", err);
    process.exit(1);
  });
}
