// backend_routes_compliance.js
// -----------------------------------------------------------------------
// Covers exactly the Certs & Fleet tab of compliance_console.jsx —
// certifications with expiry urgency, vehicles with inspection
// urgency. Deliberately does NOT cover PCR Review or Investigations:
// PCR Review needs pcr_completeness_check() (built in epcr_clinical_
// schema.sql) exposed as a route, which isn't done yet, and
// Investigations has no backing table at all anywhere in this
// project's schema — that tab has been mock data from the moment it
// was built, not a wiring gap. Naming both rather than quietly wiring
// one tab and letting the other two look equally real.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth, requireRole } from "./backend_auth.js";
import { auditView } from "./backend_audit.js";

const router = express.Router();
router.use(requireAuth);

router.get("/certifications", async (req, res) => {
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query(`
      SELECT
        c.certification_id, cm.crew_member_id, cm.first_name, cm.last_name,
        ct.code AS cert_type, c.expires_on,
        (c.expires_on - CURRENT_DATE) AS days_until_expiry
      FROM certifications c
      JOIN crew_members cm ON cm.crew_member_id = c.crew_member_id
      JOIN certification_types ct ON ct.certification_type_id = c.certification_type_id
      ORDER BY c.expires_on ASC
    `)
  );
  res.json(result.rows);
});

router.get("/vehicles", async (req, res) => {
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query(`
      SELECT vehicle_id, unit_designation, next_inspection_due,
        (next_inspection_due - CURRENT_DATE) AS days_until_due
      FROM vehicles
      ORDER BY next_inspection_due ASC NULLS LAST
    `)
  );
  res.json(result.rows);
});

// Charts still open (not yet finalized), each with how many completeness
// checks it passes and which ones it fails. Reading charts is itself logged.
// Approving or flagging a chart is not built yet; this is the read side.
const REVIEWERS = requireRole("compliance_officer", "supervisor", "it_admin", "read_only_auditor");
router.get("/pcr-review", REVIEWERS, async (req, res) => {
  const rows = await withTenant(req.user.tenantId, async (client) => {
    const r = await client.query(`
      SELECT p.pcr_id, p.created_at, i.scene_address, i.priority,
             (SELECT count(*) FROM pcr_completeness_check(p.pcr_id) WHERE passed) AS passed,
             (SELECT count(*) FROM pcr_completeness_check(p.pcr_id)) AS total,
             COALESCE((SELECT array_agg(check_name) FROM pcr_completeness_check(p.pcr_id) WHERE NOT passed), '{}') AS failed
      FROM patient_care_records p JOIN incidents i ON i.incident_id = p.incident_id
      WHERE p.finalized_at IS NULL
      ORDER BY p.created_at DESC LIMIT 100`);
    await auditView(client, req.user, "patient_care_records", null, { list: true });
    return r.rows;
  });
  res.json(rows);
});

export default router;

// =====================================================================
// Still not here, and worth being specific about why:
//   - PCR Review needs pcr_completeness_check(pcr_id) wrapped in a
//     route that also lists PCRs pending review in the first place —
//     a real query, not just exposing the existing function.
//   - Investigations needs an actual schema migration first (a table
//     this project has never defined), not just a route. Building the
//     route without the table would be the same mistake as the
//     auto-executing migrate.js bug: something that looks finished
//     and silently isn't.
// =====================================================================
