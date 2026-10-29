// backend_routes_pcr_detail.js
// -----------------------------------------------------------------------
// Three more PCR sub-resources, same withTenant pattern as
// backend_routes_pcr.js's vitals route. Signatures is deliberately not
// here: the schema's pcr_signatures.object_storage_ref is NOT NULL and
// meant to be a pointer to an uploaded file, and no object storage
// (S3/GCS/Azure Blob, whatever gets chosen) is wired into this backend
// anywhere. Building a signatures route that stores a data URL inline
// instead would silently stop matching what the schema actually says —
// the same class of mistake as the auto-executing migrate.js bug
// earlier today, something that looks done and isn't. Named as blocked
// rather than faked.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth } from "./backend_auth.js";

const router = express.Router();
router.use(requireAuth);

router.post("/pcr/:id/procedures", async (req, res) => {
  const { procedureName, performedByCrewMemberId, outcome, notes } = req.body;
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query(
      `INSERT INTO pcr_procedures (tenant_id, pcr_id, procedure_name, performed_at, performed_by_crew_member_id, outcome, notes)
       VALUES ($1, $2, $3, now(), $4, $5, $6) RETURNING *`,
      [req.user.tenantId, req.params.id, procedureName, performedByCrewMemberId || null, outcome || null, notes || null]
    )
  );
  res.status(201).json(result.rows[0]);
});

router.post("/pcr/:id/medications", async (req, res) => {
  const { drugName, dose, route, administeredByCrewMemberId, controlledSubstanceLogId, patientResponse } = req.body;
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query(
      `INSERT INTO pcr_medications (tenant_id, pcr_id, drug_name, dose, route, administered_at, administered_by_crew_member_id, controlled_substance_log_id, patient_response)
       VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8) RETURNING *`,
      [req.user.tenantId, req.params.id, drugName, dose, route, administeredByCrewMemberId || null, controlledSubstanceLogId || null, patientResponse || null]
    )
  );
  res.status(201).json(result.rows[0]);
});

// pcr_disposition's primary key IS pcr_id (one row per chart, not one
// row per update) — this is a real upsert via ON CONFLICT, not an
// INSERT that happens to work the first time and breaks the second.
router.put("/pcr/:id/disposition", async (req, res) => {
  const { dispositionType, destinationFacilityId, transferOfCareTo, primaryImpression, secondaryImpressions, mechanismOfInjury } = req.body;
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query(
      `INSERT INTO pcr_disposition (pcr_id, tenant_id, disposition_type, destination_facility_id, transfer_of_care_to, primary_impression, secondary_impressions, mechanism_of_injury)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (pcr_id) DO UPDATE SET
         disposition_type = EXCLUDED.disposition_type,
         destination_facility_id = EXCLUDED.destination_facility_id,
         transfer_of_care_to = EXCLUDED.transfer_of_care_to,
         primary_impression = EXCLUDED.primary_impression,
         secondary_impressions = EXCLUDED.secondary_impressions,
         mechanism_of_injury = EXCLUDED.mechanism_of_injury,
         updated_at = now()
       RETURNING *`,
      [req.params.id, req.user.tenantId, dispositionType, destinationFacilityId || null, transferOfCareTo || null, primaryImpression || null, secondaryImpressions || null, mechanismOfInjury || null]
    )
  );
  res.json(result.rows[0]);
});

export default router;
