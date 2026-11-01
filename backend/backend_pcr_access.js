// backend_pcr_access.js
// -----------------------------------------------------------------------
// Who may open a patient care record, and what they may do with it.
//
//   A chart belongs to the unit that treated the patient. When it is started,
//   the EMTs / AEMTs / paramedics on that unit at the time are recorded
//   against it (pcr_crew). MVOs (drivers) and office staff are never on it.
//
//   draft      the crew on it can read and edit
//   submitted  LOCKED. The crew can no longer open it. Only QA/QI can, to review it.
//   reopened   QA/QI sent it back to ONE named crew member, who alone can edit
//   finalized  signed off by QA/QI; read-only for QA/QI; corrections are amendments
//
// QA/QI never reviews a chart they were themselves on.
// -----------------------------------------------------------------------

import { withTenant } from "./backend_db.js";
import { auditDenied } from "./backend_audit.js";

export const CLINICAL_LEVELS = ["emt", "aemt", "paramedic"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const effectiveStatus = (pcr) => (pcr.finalized_at ? "finalized" : pcr.status);

// 'edit' | 'review' | null
export async function accessLevel(client, user, pcr) {
  const st = effectiveStatus(pcr);
  const roles = user.roles || [user.role];
  const inCrew = (await client.query("SELECT 1 FROM pcr_crew WHERE pcr_id = $1 AND user_id = $2", [pcr.pcr_id, user.userId])).rows.length > 0;
  if (inCrew && CLINICAL_LEVELS.includes(user.fieldLevel)) {
    if (st === "draft") return "edit";
    if (st === "reopened" && pcr.assigned_to_user_id === user.userId) return "edit";
  }
  if (roles.includes("qa_qi") && !inCrew && st !== "draft") return "review";
  return null;
}

export function chartAccess(need) {
  return async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Not found" });
    const found = await withTenant(req.user.tenantId, async (c) => {
      const pcr = (await c.query(
        "SELECT pcr_id, tenant_id, incident_id, unit_id, status, finalized_at, assigned_to_user_id FROM patient_care_records WHERE pcr_id = $1",
        [req.params.id])).rows[0];
      if (!pcr) return null;
      const inCrew = (await c.query("SELECT 1 FROM pcr_crew WHERE pcr_id = $1 AND user_id = $2", [pcr.pcr_id, req.user.userId])).rows.length > 0;
      return { pcr, level: await accessLevel(c, req.user, pcr), inCrew };
    });
    if (!found) return res.status(404).json({ error: "Not found" });
    if (found.level && (need !== "edit" || found.level === "edit")) {
      req.pcr = found.pcr; req.pcrLevel = found.level;
      return next();
    }
    const st = effectiveStatus(found.pcr);
    let message = "You don't have access to this chart.";
    if (found.level === "review") message = "QA/QI reviews charts but doesn't edit them. Reopen it and assign it to a crew member to correct.";
    else if (found.inCrew && st !== "draft") message = "This chart has been submitted and is locked. Only QA/QI can open it.";
    auditDenied(req.user, { method: req.method, path: req.originalUrl, reason: "chart access", chartStatus: st }).catch(() => {});
    return res.status(403).json({ error: message });
  };
}
