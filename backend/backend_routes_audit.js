// backend_routes_audit.js
// -----------------------------------------------------------------------
// An audit log nobody can read is a write-only file. These let
// compliance roles search it and check that it hasn't been tampered
// with. Reading the audit log is itself logged — who looked at the
// record of who looked is a question auditors do ask.
//
// Visibility is entirely the database's: a tenant sees its own entries,
// plus entries other agencies made about incidents it shared with them
// (the mutual_aid_read policy on audit_log). Nothing here decides that.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth, requireRole } from "./backend_auth.js";
import { auditView } from "./backend_audit.js";

const router = express.Router();
router.use(requireAuth);

const AUDIT_ROLES = ["compliance_officer", "read_only_auditor"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORD_RE = /^[a-z_]{1,64}$/;

router.get("/audit", requireRole(...AUDIT_ROLES), async (req, res) => {
  const { recordId, tableName, actorUserId, action, before } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const bad = (error) => res.status(400).json({ error });
  if (recordId && !UUID_RE.test(recordId)) return bad("recordId must be a UUID");
  if (actorUserId && !UUID_RE.test(actorUserId)) return bad("actorUserId must be a UUID");
  if (tableName && !WORD_RE.test(tableName)) return bad("tableName must be a table name");
  if (action && !WORD_RE.test(action)) return bad("action must be a single word");
  if (before && !/^\d+$/.test(before)) return bad("before must be an entry number");

  const rows = await withTenant(req.user.tenantId, async (client) => {
    const result = await client.query(
      `SELECT audit_id, tenant_id, actor_user_id, action, table_name, record_id, detail, occurred_at, row_hash
       FROM audit_log
       WHERE ($1::uuid IS NULL OR record_id = $1)
         AND ($2::text IS NULL OR table_name = $2)
         AND ($3::uuid IS NULL OR actor_user_id = $3)
         AND ($4::text IS NULL OR action = $4)
         AND ($5::bigint IS NULL OR audit_id < $5)
       ORDER BY audit_id DESC LIMIT $6`,
      [recordId || null, tableName || null, actorUserId || null, action || null, before || null, limit]
    );
    await auditView(client, req.user, "audit_log", null, { filters: { recordId, tableName, actorUserId, action, before } });
    return result.rows;
  });
  res.json(rows);
});

// Checks this agency's own chain. See audit_schema.sql for what this
// can and can't catch — notably, deleting the newest entry is invisible
// to the chain alone.
router.get("/audit/verify", requireRole(...AUDIT_ROLES), async (req, res) => {
  const out = await withTenant(req.user.tenantId, async (client) => {
    const problems = (await client.query("SELECT audit_id, problem FROM audit_chain_verify($1)", [req.user.tenantId])).rows;
    const checked = Number((await client.query("SELECT count(*) FROM audit_log WHERE tenant_id = $1", [req.user.tenantId])).rows[0].count);
    await auditView(client, req.user, "audit_log", null, { verify: true });
    return { ok: problems.length === 0, entriesChecked: checked, problems };
  });
  res.json(out);
});

export default router;
