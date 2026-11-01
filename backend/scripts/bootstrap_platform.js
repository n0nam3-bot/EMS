#!/usr/bin/env node
// Creates (or resets) the PLATFORM administrator: the account that runs the
// service itself, creates companies and helps accounts with problems. It signs
// in on the same page as everyone else and is asked to set up two-step sign-in
// on its first login. Re-running with a new password is the way back in.
//
//   MIGRATION_DATABASE_URL    owner connection string (direct, not pooled)
//   PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_NAME, PLATFORM_ADMIN_PASSWORD (12+ characters)
import "dotenv/config";
import pg from "pg";
import { hashPassword } from "../backend_passwords.js";

const e = process.env;
const missing = ["MIGRATION_DATABASE_URL", "PLATFORM_ADMIN_EMAIL", "PLATFORM_ADMIN_PASSWORD"].filter((k) => !e[k]);
if (missing.length) { console.error("Missing: " + missing.join(", ")); process.exit(1); }
if (e.PLATFORM_ADMIN_PASSWORD.length < 12) { console.error("The platform admin password must be at least 12 characters"); process.exit(1); }

const client = new pg.Client({ connectionString: e.MIGRATION_DATABASE_URL });
await client.connect();
try {
  const email = e.PLATFORM_ADMIN_EMAIL.trim().toLowerCase();
  const clash = await client.query("SELECT 1 FROM users WHERE lower(email) = $1", [email]);
  if (clash.rows.length) throw new Error("That email already belongs to a company account. Use a different one for the platform admin.");
  await client.query(
    `INSERT INTO platform_admins (email, display_name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT ((lower(email))) DO UPDATE SET password_hash = EXCLUDED.password_hash, display_name = EXCLUDED.display_name,
       failed_logins = 0, locked_until = NULL, is_active = TRUE`,
    [email, e.PLATFORM_ADMIN_NAME || "Platform admin", await hashPassword(e.PLATFORM_ADMIN_PASSWORD)]
  );
  console.log(`Platform admin ${email} is ready.`);
} catch (err) {
  console.error("Platform admin setup failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
