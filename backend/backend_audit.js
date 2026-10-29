// backend_audit.js
// -----------------------------------------------------------------------
// The half of the audit trail that triggers can't do. Writes are logged
// by the database itself (audit_schema.sql); a read can't fire a
// trigger, so routes that expose protected records call auditView().
//
// Always call it INSIDE the same withTenant() transaction as the read.
// If the entry can't be written, the transaction rolls back and the
// request fails — no audit, no access. A system that serves patient
// data and shrugs when it can't record who saw it has an audit log in
// name only.
// -----------------------------------------------------------------------

import { withTenant } from "./backend_db.js";

export async function auditView(client, user, tableName, recordId, detail = {}) {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, table_name, record_id, detail)
     VALUES ($1, $2, 'view', $3, $4, $5)`,
    [user.tenantId, user.userId, tableName, recordId, JSON.stringify(detail)]
  );
}

// A refused attempt is security-relevant in its own right: someone with
// a valid session reaching for something their role doesn't allow.
// Runs in its own transaction because the request is already being
// refused — there is no read to fail closed on.
export function auditDenied(user, detail) {
  return withTenant(user.tenantId, (client) =>
    client.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, table_name, record_id, detail)
       VALUES ($1, $2, 'denied', 'api', NULL, $3)`,
      [user.tenantId, user.userId, JSON.stringify(detail)]
    )
  );
}
