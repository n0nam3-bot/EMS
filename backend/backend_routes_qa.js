// backend_routes_qa.js
// -----------------------------------------------------------------------
// QA/QI review of submitted charts. Everything here needs the qa_qi role,
// and QA/QI never sees a chart they were on themselves.
//
//   GET  /qa/charts?status=submitted|reopened|finalized   the review queue
//   POST /pcr/:id/reopen    send it back to ONE named crew member, with a note
//   POST /pcr/:id/approve   sign it off (finalizes it: from then on only
//                           amendments can change it)
//
// Opening a chart to read it is GET /pcr/:id (backend_routes_pcr.js), which
// serves it to QA/QI once it's submitted and records the view in the audit log.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth, requireRole } from "./backend_auth.js";
import { CLINICAL_LEVELS } from "./backend_pcr_access.js";

const router = express.Router();
router.use(requireAuth);
const QA = requireRole("qa_qi");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/qa/charts", QA, async (req, res) => {
  const status = ["submitted", "reopened", "finalized"].includes(req.query.status) ? req.query.status : "submitted";
  const rows = await withTenant(req.user.tenantId, async (c) => (await c.query(
    `SELECT p.pcr_id, p.status, p.submitted_at, p.finalized_at, p.reopen_note, i.scene_address, i.priority, v.unit_designation,
            (SELECT string_agg(cm.first_name || ' ' || cm.last_name, ', ' ORDER BY cm.last_name)
               FROM pcr_crew pc JOIN crew_members cm ON cm.crew_member_id = pc.crew_member_id WHERE pc.pcr_id = p.pcr_id) AS crew,
            (SELECT display_name FROM users WHERE user_id = p.assigned_to_user_id) AS assigned_to,
            (SELECT count(*) FROM pcr_completeness_check(p.pcr_id) WHERE passed) AS passed,
            (SELECT count(*) FROM pcr_completeness_check(p.pcr_id)) AS total,
            COALESCE((SELECT array_agg(check_name) FROM pcr_completeness_check(p.pcr_id) WHERE NOT passed), '{}') AS failed
     FROM patient_care_records p
     JOIN incidents i ON i.incident_id = p.incident_id
     LEFT JOIN units un ON un.unit_id = p.unit_id LEFT JOIN vehicles v ON v.vehicle_id = un.vehicle_id
     WHERE NOT EXISTS (SELECT 1 FROM pcr_crew pc WHERE pc.pcr_id = p.pcr_id AND pc.user_id = $1)
       AND ( ($2 = 'finalized' AND p.finalized_at IS NOT NULL)
          OR ($2 <> 'finalized' AND p.finalized_at IS NULL AND p.status = $2) )
     ORDER BY COALESCE(p.submitted_at, p.created_at) DESC LIMIT 200`, [req.user.userId, status])).rows);
  res.json(rows);
});

router.post("/pcr/:id/reopen", QA, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Not found" });
  const { assignToUserId } = req.body || {};
  const note = String(req.body?.note ?? "").trim();
  if (!UUID_RE.test(String(assignToUserId ?? ""))) return res.status(400).json({ error: "Pick the crew member who will correct it" });
  if (note.length < 5) return res.status(400).json({ error: "Say what needs to be corrected" });
  const out = await withTenant(req.user.tenantId, async (c) => {
    const pcr = (await c.query("SELECT pcr_id, status, finalized_at FROM patient_care_records WHERE pcr_id = $1", [req.params.id])).rows[0];
    if (!pcr) return { status: 404, error: "Not found" };
    if ((await c.query("SELECT 1 FROM pcr_crew WHERE pcr_id = $1 AND user_id = $2", [req.params.id, req.user.userId])).rows.length) return { status: 403, error: "You were on this call, so you can't review its chart." };
    if (pcr.finalized_at || pcr.status !== "submitted") return { status: 409, error: "Only a submitted chart can be reopened." };
    const member = (await c.query(
      `SELECT cm.field_level FROM pcr_crew pc JOIN crew_members cm ON cm.crew_member_id = pc.crew_member_id
       WHERE pc.pcr_id = $1 AND pc.user_id = $2 AND cm.is_active`, [req.params.id, assignToUserId])).rows[0];
    if (!member || !CLINICAL_LEVELS.includes(member.field_level)) return { status: 400, error: "That person isn't on this chart's crew, or can't chart." };
    await c.query("UPDATE patient_care_records SET status = 'reopened', assigned_to_user_id = $2, reopen_note = $3 WHERE pcr_id = $1", [req.params.id, assignToUserId, note]);
    await c.query("INSERT INTO pcr_events (tenant_id, pcr_id, kind, actor_user_id, assigned_to_user_id, note) VALUES ($1, $2, 'reopened', $3, $4, $5)",
      [req.user.tenantId, req.params.id, req.user.userId, assignToUserId, note]);
    return { status: 200 };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json({ ok: true });
});

router.post("/pcr/:id/approve", QA, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Not found" });
  const out = await withTenant(req.user.tenantId, async (c) => {
    const pcr = (await c.query("SELECT pcr_id, status, finalized_at FROM patient_care_records WHERE pcr_id = $1", [req.params.id])).rows[0];
    if (!pcr) return { status: 404, error: "Not found" };
    if ((await c.query("SELECT 1 FROM pcr_crew WHERE pcr_id = $1 AND user_id = $2", [req.params.id, req.user.userId])).rows.length) return { status: 403, error: "You were on this call, so you can't approve its chart." };
    if (pcr.finalized_at || pcr.status !== "submitted") return { status: 409, error: "Only a submitted chart can be approved." };
    await c.query("UPDATE patient_care_records SET status = 'finalized', finalized_at = now(), finalized_by_user_id = $2 WHERE pcr_id = $1", [req.params.id, req.user.userId]);
    await c.query("INSERT INTO pcr_events (tenant_id, pcr_id, kind, actor_user_id) VALUES ($1, $2, 'approved', $3)", [req.user.tenantId, req.params.id, req.user.userId]);
    return { status: 200 };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.json({ ok: true });
});

export default router;
