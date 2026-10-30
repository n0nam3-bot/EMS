#!/usr/bin/env node
// Adds what the sign-in system and the richer call record need to an
// EXISTING database. Every statement is idempotent, so it is safe to run
// on a fresh database (after the migrations) and again on every release.
// Runs as the owner role, like the migrations.
//
//   MIGRATION_DATABASE_URL  owner connection string (direct, not pooled)
import "dotenv/config";
import pg from "pg";

export const UPGRADE_SQL = `
-- ---- Sign-in ----------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- One login = one person at one company. Email is the login name, so it
-- must be unique across all companies.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));

-- Sign-in happens BEFORE we know which company the person belongs to, so
-- these two tiny functions run as the table owner (SECURITY DEFINER) to
-- look the account up by email. They return only what login needs, and
-- only the app's restricted role may call them. Everything else the app
-- does is still locked to one company by row-level security.
CREATE OR REPLACE FUNCTION auth_find_user(p_email TEXT)
RETURNS TABLE (user_id UUID, tenant_id UUID, password_hash TEXT, role user_role,
               is_active BOOLEAN, tenant_active BOOLEAN, locked_until TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT u.user_id, u.tenant_id, u.password_hash, u.role, u.is_active, t.is_active, u.locked_until
    FROM users u JOIN tenants t ON t.tenant_id = u.tenant_id
    WHERE lower(u.email) = lower(p_email)
    LIMIT 1
$$;

-- Counts failures and locks the account for 15 minutes after 8 in a row.
CREATE OR REPLACE FUNCTION auth_record_login(p_user UUID, p_ok BOOLEAN)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE users SET
        failed_logins = CASE WHEN p_ok THEN 0 ELSE failed_logins + 1 END,
        locked_until  = CASE WHEN p_ok THEN NULL
                             WHEN failed_logins + 1 >= 8 THEN now() + interval '15 minutes'
                             ELSE locked_until END
    WHERE user_id = p_user
$$;

REVOKE ALL ON FUNCTION auth_find_user(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_record_login(UUID, BOOLEAN) FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ems_app_runtime') THEN
        GRANT EXECUTE ON FUNCTION auth_find_user(TEXT) TO ems_app_runtime;
        GRANT EXECUTE ON FUNCTION auth_record_login(UUID, BOOLEAN) TO ems_app_runtime;
    END IF;
END $$;

-- ---- A call needs more than one line of text ---------------------------
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS capability_needed TEXT NOT NULL DEFAULT 'BLS';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS scene_detail TEXT;          -- room / floor / unit / cross street
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS destination_text TEXT;      -- where the patient is going
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS destination_location geography(Point, 4326);
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS patient_name TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- ---- Starter certification types for every company ----------------------
INSERT INTO certification_types (tenant_id, code, label, required_for_capability)
SELECT t.tenant_id, v.code, v.label, v.cap
FROM tenants t
CROSS JOIN (VALUES ('EMT-B', 'EMT-Basic', NULL), ('PARAMEDIC', 'Paramedic', 'ALS')) AS v(code, label, cap)
ON CONFLICT (tenant_id, code) DO NOTHING;
`;

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.MIGRATION_DATABASE_URL) { console.error("Missing MIGRATION_DATABASE_URL"); process.exit(1); }
  const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(UPGRADE_SQL);
    await client.query("COMMIT");
    console.log("Database upgrade applied.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Upgrade failed:", err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
