// backend_routes_pcr.js
// -----------------------------------------------------------------------
// The ePCR routes: starting a chart, reading it back, the narrative,
// vitals, submitting it, and the crew's own list of charts and calls.
// Procedures, medications and disposition are in backend_routes_pcr_detail.js;
// QA/QI's review actions are in backend_routes_qa.js. Who can open a chart,
// and when, is decided in backend_pcr_access.js.
//
// Note on patient fields: patient_last_name_enc / patient_dob_enc /
// ssn_enc are BYTEA in the schema because they need application-layer
// encryption before they reach the database. That encryption is NOT built,
// so nothing here writes them. Left out rather than faked.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth } from "./backend_auth.js";
import { auditView } from "./backend_audit.js";
import { chartAccess, effectiveStatus, CLINICAL_LEVELS } from "./backend_pcr_access.js";

const router = express.Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isClinical = (user) => CLINICAL_LEVELS.includes(user.fieldLevel);

// The units this person was crewing while they were on a call (through the
// call's assignment window), most recent first.
const MY_UNITS_ON_INCIDENT = `
  SELECT iua.unit_id, iua.assigned_at
  FROM crew_members cm
  JOIN unit_crew_assignments uca ON uca.crew_member_id = cm.crew_member_id
  JOIN incident_unit_assignments iua ON iua.unit_id = uca.unit_id AND iua.incident_id = $2
       AND iua.assigned_at < COALESCE(uca.assigned_to, 'infinity') AND COALESCE(iua.unassigned_at, 'infinity') > uca.assigned_from
  WHERE cm.user_id = $1
  ORDER BY iua.assigned_at DESC`;

// Start a chart for a call. Only an EMT, AEMT or paramedic who was on a unit that ran
// the call can; the chart is tied to that unit, and the clinical crew on it get access.
// Idempotent: asking again returns the same chart (a tablet on flaky signal retries).
router.post("/pcr", async (req, res) => {
  const { incidentId } = req.body || {};
  if (!UUID_RE.test(String(incidentId ?? ""))) return res.status(400).json({ error: "incidentId is required" });
  if (!isClinical(req.user)) {
    return res.status(403).json({ error: "Only an EMT, AEMT or paramedic who worked the call can chart it." });
  }
  const out = await withTenant(req.user.tenantId, async (c) => {
    const unit = (await c.query(MY_UNITS_ON_INCIDENT, [req.user.userId, incidentId])).rows[0];
    if (!unit) return { status: 403, error: "You weren't on a unit that ran this call." };
    const existing = (await c.query("SELECT * FROM patient_care_records WHERE incident_id = $1 AND unit_id = $2", [incidentId, unit.unit_id])).rows[0];
    if (existing) {
      const mine = (await c.query("SELECT 1 FROM pcr_crew WHERE pcr_id = $1 AND user_id = $2", [existing.pcr_id, req.user.userId])).rows.length > 0;
      const open = effectiveStatus(existing) === "draft" || (existing.status === "reopened" && existing.assigned_to_user_id === req.user.userId && !existing.finalized_at);
      if (!mine || !open) return { status: 403, error: "This chart has been submitted and is locked. Only QA/QI can open it." };
      return { status: 200, row: existing };
    }
    const row = (await c.query(
      `INSERT INTO patient_care_records (tenant_id, incident_id, unit_id) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.tenantId, incidentId, unit.unit_id])).rows[0];
    // Everyone on that unit during the call who can chart: this is who the chart belongs to.
    await c.query(
      `INSERT INTO pcr_crew (pcr_id, tenant_id, user_id, crew_member_id)
       SELECT DISTINCT $1::uuid, $2::uuid, cm.user_id, cm.crew_member_id
       FROM unit_crew_assignments uca
       JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
       JOIN incident_unit_assignments iua ON iua.unit_id = uca.unit_id AND iua.incident_id = $3 AND iua.unit_id = $4
            AND iua.assigned_at < COALESCE(uca.assigned_to, 'infinity') AND COALESCE(iua.unassigned_at, 'infinity') > uca.assigned_from
       WHERE cm.user_id IS NOT NULL AND cm.is_active AND cm.field_level IN ('emt', 'aemt', 'paramedic')`,
      [row.pcr_id, req.user.tenantId, incidentId, unit.unit_id]);
    await c.query("INSERT INTO pcr_events (tenant_id, pcr_id, kind, actor_user_id) VALUES ($1, $2, 'created', $3)", [req.user.tenantId, row.pcr_id, req.user.userId]);
    return { status: 201, row };
  });
  if (out.error) return res.status(out.status).json({ error: out.error });
  res.status(out.status).json(out.row);
});

// This person's own list: charts they can still work on, and calls with no chart yet.
// Submitted charts are deliberately absent: once submitted, the crew can't see them.
router.get("/pcr/mine", async (req, res) => {
  if (!isClinical(req.user)) return res.json({ charts: [], calls: [], canChart: false });
  const data = await withTenant(req.user.tenantId, async (c) => {
    const charts = (await c.query(
      `SELECT p.pcr_id, p.status, p.reopen_note, p.created_at, i.incident_id, i.scene_address, i.priority, v.unit_designation
       FROM pcr_crew pc
       JOIN patient_care_records p ON p.pcr_id = pc.pcr_id
       JOIN incidents i ON i.incident_id = p.incident_id
       LEFT JOIN units un ON un.unit_id = p.unit_id LEFT JOIN vehicles v ON v.vehicle_id = un.vehicle_id
       WHERE pc.user_id = $1 AND p.finalized_at IS NULL
         AND (p.status = 'draft' OR (p.status = 'reopened' AND p.assigned_to_user_id = $1))
       ORDER BY (p.status = 'reopened') DESC, p.created_at DESC`, [req.user.userId])).rows;
    const calls = (await c.query(
      `SELECT DISTINCT ON (i.incident_id, iua.unit_id) i.incident_id, i.scene_address, i.scene_detail, i.priority, iua.unit_id, v.unit_designation, iua.role, i.call_received_at
       FROM crew_members cm
       JOIN unit_crew_assignments uca ON uca.crew_member_id = cm.crew_member_id
       JOIN incident_unit_assignments iua ON iua.unit_id = uca.unit_id
            AND iua.assigned_at < COALESCE(uca.assigned_to, 'infinity') AND COALESCE(iua.unassigned_at, 'infinity') > uca.assigned_from
       JOIN incidents i ON i.incident_id = iua.incident_id AND i.cancelled_at IS NULL
       JOIN units un ON un.unit_id = iua.unit_id JOIN vehicles v ON v.vehicle_id = un.vehicle_id
       WHERE cm.user_id = $1 AND iua.role IN ('primary', 'als_intercept')
         AND NOT EXISTS (SELECT 1 FROM patient_care_records p WHERE p.incident_id = iua.incident_id AND p.unit_id = iua.unit_id)
       ORDER BY i.incident_id, iua.unit_id, i.call_received_at DESC`, [req.user.userId])).rows;
    return { charts, calls: calls.sort((a, b) => new Date(b.call_received_at) - new Date(a.call_received_at)) };
  });
  res.json({ ...data, canChart: true });
});

router.get("/pcr/:id", chartAccess("any"), async (req, res) => {
  const out = await withTenant(req.user.tenantId, async (c) => {
    const id = req.params.id;
    const pcr = (await c.query(
      `SELECT p.pcr_id, p.incident_id, p.unit_id, p.status, p.clinical_narrative, p.finalized_at, p.submitted_at,
              p.assigned_to_user_id, p.reopen_note, p.created_at, i.scene_address, i.scene_detail, i.priority, v.unit_designation
       FROM patient_care_records p JOIN incidents i ON i.incident_id = p.incident_id
       LEFT JOIN units un ON un.unit_id = p.unit_id LEFT JOIN vehicles v ON v.vehicle_id = un.vehicle_id
       WHERE p.pcr_id = $1`, [id])).rows[0];
    const vitals = (await c.query("SELECT * FROM pcr_vitals WHERE pcr_id = $1 ORDER BY recorded_at DESC", [id])).rows;
    const procedures = (await c.query("SELECT * FROM pcr_procedures WHERE pcr_id = $1 ORDER BY performed_at", [id])).rows;
    const medications = (await c.query("SELECT * FROM pcr_medications WHERE pcr_id = $1 ORDER BY administered_at", [id])).rows;
    const disposition = (await c.query("SELECT * FROM pcr_disposition WHERE pcr_id = $1", [id])).rows[0] || null;
    const crew = (await c.query(
      `SELECT pc.user_id, cm.first_name || ' ' || cm.last_name AS name, cm.field_level
       FROM pcr_crew pc JOIN crew_members cm ON cm.crew_member_id = pc.crew_member_id WHERE pc.pcr_id = $1 ORDER BY cm.last_name`, [id])).rows;
    const events = (await c.query(
      `SELECT e.kind, e.note, e.at, a.display_name AS actor, t.display_name AS assigned_to
       FROM pcr_events e LEFT JOIN users a ON a.user_id = e.actor_user_id LEFT JOIN users t ON t.user_id = e.assigned_to_user_id
       WHERE e.pcr_id = $1 ORDER BY e.event_id`, [id])).rows;
    // Same transaction as the read: if this entry can't be written, the chart
    // isn't served. Opening a patient record without a trace is the one thing
    // an audit log exists to prevent.
    await auditView(c, req.user, "patient_care_records", id, { as: req.pcrLevel });
    return { ...pcr, status: effectiveStatus(pcr), vitals, procedures, medications, disposition, crew, events, access: req.pcrLevel };
  });
  res.json(out);
});

router.patch("/pcr/:id/narrative", chartAccess("edit"), async (req, res) => {
  const { clinicalNarrative } = req.body;
  if (typeof clinicalNarrative !== "string") return res.status(400).json({ error: "clinicalNarrative must be a string" });
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query("UPDATE patient_care_records SET clinical_narrative = $1 WHERE pcr_id = $2 RETURNING pcr_id, clinical_narrative", [clinicalNarrative, req.params.id]));
  res.json(result.rows[0]);
});

router.post("/pcr/:id/vitals", chartAccess("edit"), async (req, res) => {
  const { bpSystolic, bpDiastolic, heartRate, respiratoryRate, spo2Percent, bloodGlucose, gcsTotal, painScale, temperatureF } = req.body;
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query(
      `INSERT INTO pcr_vitals
         (tenant_id, pcr_id, recorded_at, bp_systolic, bp_diastolic, heart_rate, respiratory_rate, spo2_percent, blood_glucose, gcs_total, pain_scale, temperature_f)
       VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [req.user.tenantId, req.params.id, bpSystolic, bpDiastolic, heartRate, respiratoryRate, spo2Percent, bloodGlucose, gcsTotal, painScale, temperatureF]));
  res.status(201).json(result.rows[0]);
});

// Remove an entry made by mistake (only while the chart is open to this person).
for (const [path, table, idCol] of [["vitals", "pcr_vitals", "vital_id"], ["procedures", "pcr_procedures", "procedure_id"], ["medications", "pcr_medications", "medication_id"]]) {
  router.delete(`/pcr/:id/${path}/:entryId`, chartAccess("edit"), async (req, res) => {
    if (!UUID_RE.test(req.params.entryId)) return res.status(404).json({ error: "Not found" });
    const r = await withTenant(req.user.tenantId, (c) => c.query(`DELETE FROM ${table} WHERE pcr_id = $1 AND ${idCol} = $2 RETURNING ${idCol}`, [req.params.id, req.params.entryId]));
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });
}

// The crew submits. The chart locks at once; only QA/QI can open it again.
// Missing pieces are reported first so the crew can fix them or submit knowingly.
// (Signatures and a destination *facility* can't be entered by crews yet, so those
// checks aren't asked of them here; QA/QI still sees them flagged.)
router.post("/pcr/:id/submit", chartAccess("edit"), async (req, res) => {
  const out = await withTenant(req.user.tenantId, async (c) => {
    const checks = (await c.query("SELECT check_name, passed FROM pcr_completeness_check($1)", [req.params.id])).rows;
    const missing = checks.filter((k) => !k.passed && !["has_crew_signature", "refusal_has_signature", "transport_has_destination"].includes(k.check_name)).map((k) => k.check_name);
    if (missing.length && !req.body?.acknowledgeMissing) return { missing };
    const wasReopened = req.pcr.status === "reopened";
    await c.query(
      `UPDATE patient_care_records SET status = 'submitted', submitted_at = now(), submitted_by_user_id = $2, assigned_to_user_id = NULL WHERE pcr_id = $1`,
      [req.params.id, req.user.userId]);
    await c.query("INSERT INTO pcr_events (tenant_id, pcr_id, kind, actor_user_id) VALUES ($1, $2, $3, $4)",
      [req.user.tenantId, req.params.id, wasReopened ? "resubmitted" : "submitted", req.user.userId]);
    return { ok: true };
  });
  if (out.missing) return res.status(409).json({ error: "This chart is missing some information.", missing: out.missing });
  res.json(out);
});

export default router;

// Not built: POST /pcr/:id/signatures needs object storage first
// (pcr_signatures.object_storage_ref is NOT NULL and means "pointer to an
// uploaded image"; nothing here stores one).
