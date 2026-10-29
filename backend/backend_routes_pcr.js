// backend_routes_pcr.js
// -----------------------------------------------------------------------
// The core ePCR routes: creating a chart, reading it back with its
// vitals, saving the narrative, and recording vitals. Procedures,
// medications and disposition are in backend_routes_pcr_detail.js.
// Signatures are not built anywhere yet — see the note at the bottom.
//
// Note on patient fields: patient_last_name_enc / patient_dob_enc /
// ssn_enc are BYTEA in the schema specifically because they need
// application-layer encryption before they ever reach the database —
// see epcr_clinical_schema.sql's own comments. This file does NOT
// implement that encryption; it's a real, separate piece of work
// (choosing a KMS, an encryption library, a key rotation story), not
// something to fake with a placeholder that looks like it's handling
// PHI correctly when it isn't. Left out rather than stubbed.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth } from "./backend_auth.js";
import { auditView } from "./backend_audit.js";

const router = express.Router();
router.use(requireAuth);

// Idempotent on purpose: patient_care_records.incident_id is UNIQUE,
// so a plain INSERT would turn any retry — a field tablet on flaky
// signal re-sending a request it never saw a response to, or someone
// reopening the chart — into a unique-violation 500. ON CONFLICT with
// a no-op update returns the existing row instead, so "create this
// chart" can be called as many times as needed and always resolves to
// the same one.
router.post("/pcr", async (req, res) => {
  const { incidentId, clinicalNarrative } = req.body;
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query(
      `INSERT INTO patient_care_records (tenant_id, incident_id, clinical_narrative)
       VALUES ($1, $2, $3)
       ON CONFLICT (incident_id) DO UPDATE SET incident_id = EXCLUDED.incident_id
       RETURNING *`,
      [req.user.tenantId, incidentId, clinicalNarrative || null]
    )
  );
  res.status(201).json(result.rows[0]);
});

// The narrative gets written AFTER the chart exists, near the end of a
// call — POST /pcr only sets it at creation, so without this there was
// no way to save it at all. A finalized chart is still protected: the
// prevent_finalized_pcr_edit trigger rejects this UPDATE at the
// database level once finalized_at is set, no check needed here.
router.patch("/pcr/:id/narrative", async (req, res) => {
  const { clinicalNarrative } = req.body;
  if (typeof clinicalNarrative !== "string") {
    return res.status(400).json({ error: "clinicalNarrative must be a string" });
  }
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query(
      "UPDATE patient_care_records SET clinical_narrative = $1 WHERE pcr_id = $2 RETURNING pcr_id, clinical_narrative",
      [clinicalNarrative, req.params.id]
    )
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
  res.json(result.rows[0]);
});

router.get("/pcr/:id", async (req, res) => {
  const result = await withTenant(req.user.tenantId, async (client) => {
    const pcr = await client.query("SELECT * FROM patient_care_records WHERE pcr_id = $1", [req.params.id]);
    if (pcr.rows.length === 0) return null;
    const vitals = await client.query(
      "SELECT * FROM pcr_vitals WHERE pcr_id = $1 ORDER BY recorded_at DESC",
      [req.params.id]
    );
    // Same transaction as the read: if this entry can't be written, the
    // chart isn't served. Opening a patient record without a trace is
    // the one thing an audit log exists to prevent.
    await auditView(client, req.user, "patient_care_records", req.params.id);
    return { ...pcr.rows[0], vitals: vitals.rows };
  });
  if (!result) return res.status(404).json({ error: "Not found" });
  res.json(result);
});

// Once a chart is finalized, this route refuses — via the trigger in
// pcr_finalization_schema.sql, surfaced as a 409 by server.js. An
// earlier version of this comment called adding vitals after
// finalization "a deliberate distinction in the schema." It wasn't.
// The core trigger only guarded the chart row itself, and a test that
// finalized a chart and then tried to add to it found four of five
// paths wide open. Never described a property as designed without
// testing that it holds.
router.post("/pcr/:id/vitals", async (req, res) => {
  const { bpSystolic, bpDiastolic, heartRate, respiratoryRate, spo2Percent, bloodGlucose, gcsTotal, painScale, temperatureF } = req.body;
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query(
      `INSERT INTO pcr_vitals
         (tenant_id, pcr_id, recorded_at, bp_systolic, bp_diastolic, heart_rate, respiratory_rate, spo2_percent, blood_glucose, gcs_total, pain_scale, temperature_f)
       VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [req.user.tenantId, req.params.id, bpSystolic, bpDiastolic, heartRate, respiratoryRate, spo2Percent, bloodGlucose, gcsTotal, painScale, temperatureF]
    )
  );
  res.status(201).json(result.rows[0]);
});

export default router;

// =====================================================================
// Not built anywhere yet:
//   POST /pcr/:id/signatures — needs object storage first.
//     pcr_signatures.object_storage_ref is NOT NULL and means "pointer
//     to an uploaded image"; nothing in this project writes one
//     anywhere yet, and storing a data URL inline would stop matching
//     what the schema says.
// =====================================================================
// Same pattern, not yet written:
//   POST /pcr/:id/procedures   — mirrors pcr_vitals above almost exactly
//   POST /pcr/:id/medications  — same, plus the controlled_substance_
//                                 log_id cross-reference when applicable
//   PUT  /pcr/:id/disposition  — pcr_disposition is one row per PCR,
//                                 so this is an upsert, not an insert
//   POST /pcr/:id/signatures   — needs object storage wired up first,
//                                 since object_storage_ref is NOT NULL
//                                 and nothing in this project yet
//                                 writes a signature image anywhere
// =====================================================================
