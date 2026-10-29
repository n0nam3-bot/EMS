// backend_db.js
// -----------------------------------------------------------------------
// The piece every schema comment in this project has referenced but
// never shown: how the application actually sets app.current_tenant_id
// so the database's row-level security policies have something to
// check against.
//
// This matters more than it looks like it should. With a pooled
// connection, a naive `SET app.current_tenant_id = ...` on a shared
// connection can leak one user's tenant context onto a DIFFERENT
// user's request if that connection gets reused — a real, serious bug
// class in multi-tenant apps, not a hypothetical one. SET LOCAL scopes
// the value to the current transaction only, so it's structurally
// impossible for it to survive past COMMIT/ROLLBACK onto the next
// request that happens to grab the same pooled connection.
// -----------------------------------------------------------------------

import pg from "pg";
import { currentUserId } from "./backend_context.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  // Serverless: every function instance has its own pool, so keep it small.
  max: Number(process.env.PG_POOL_MAX) || (process.env.VERCEL ? 3 : 20),
});

/**
 * Runs `fn` inside a transaction scoped to one tenant. Every query
 * inside `fn` sees exactly what that tenant's RLS policies allow —
 * nothing more needs to happen in application code for isolation to
 * hold, because the database is doing the actual enforcement.
 *
 * @param {string} tenantId - UUID from the authenticated session,
 *   never from a client-supplied field. See backend_auth.js.
 * @param {(client: pg.PoolClient) => Promise<any>} fn
 */
export async function withTenant(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config, not a string-built SET LOCAL statement: SET doesn't
    // accept bind parameters, and string-concatenating tenant input
    // into SQL text is exactly the kind of thing that turns into an
    // injection vector later even if tenantId looks safe today.
    // set_config's third argument (true) means "local to this
    // transaction," equivalent to SET LOCAL.
    // The acting user rides along so the audit triggers can attribute
    // every change. One statement, one round trip, both transaction-local.
    await client.query(
      "SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_user_id', $2, true)",
      [tenantId, currentUserId() ?? ""]
    );
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

/**
 * The API refuses to run in any configuration where agencies' data would
 * merge. Row-level security is what keeps one agency's rows from another,
 * and Postgres EXEMPTS superusers, roles with BYPASSRLS, and table owners
 * from it. Connect as one of those and every agency can read every other
 * agency's data while nothing looks wrong — it is the single easiest way
 * to ruin this system's central promise, so it is checked at startup
 * instead of left to a line in a README. A table that holds agency data
 * but was created without row-level security (say, by a future
 * migration that forgot) is the same hazard and is caught the same way.
 */
export async function assertIsolationEnforced() {
  const role = (await pool.query(
    `SELECT r.rolsuper, r.rolbypassrls,
            EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns_tables
     FROM pg_roles r WHERE r.rolname = current_user`
  )).rows[0];
  const why = [];
  if (role.rolsuper) why.push("is a superuser");
  if (role.rolbypassrls) why.push("has BYPASSRLS");
  if (role.owns_tables) why.push("owns the tables");
  if (why.length) {
    throw new Error(
      `Refusing to start: the database role this API connects as ${why.join(" and ")}. ` +
      `Postgres exempts such roles from row-level security, so every agency would be able to read ` +
      `every other agency's data. Connect as the restricted role 'npm run migrate' creates (ems_app_runtime) instead.`
    );
  }
  const unprotected = (await pool.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname <> 'tenants'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     ORDER BY c.relname`
  )).rows.map((r) => r.relname);
  if (unprotected.length) {
    throw new Error(
      `Refusing to start: these tables hold agency data but row-level security is not enabled on them, ` +
      `so agencies could read each other's rows: ${unprotected.join(", ")}.`
    );
  }
}

export default pool;
