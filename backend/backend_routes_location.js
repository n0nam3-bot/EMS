// backend_routes_location.js
// -----------------------------------------------------------------------
// The other end of field_unit_console.jsx's location reporting. Same
// withTenant/RLS pattern as everything else — the new piece worth
// reading closely is the authorization check: it's not enough that a
// request is authenticated, it has to be from someone currently
// assigned to the specific unit they're reporting a position for. That
// reuses unit_crew_assignments from crew_seat_role_schema.sql rather
// than inventing a separate permission concept for it.
//
// Requires the Socket.IO instance to be reachable from request
// handlers — the common way is attaching it once at server startup:
//   app.set("io", io);
// and reading it back here via req.app.get("io").
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth } from "./backend_auth.js";
import { auditDenied } from "./backend_audit.js";
import { broadcastUnitStatusChange } from "./backend_websocket.js";

const router = express.Router();
router.use(requireAuth);

router.patch("/units/:id/location", async (req, res) => {
  const { lat, lon, headingDeg, speedMph, accuracyM } = req.body;
  if (typeof lat !== "number" || typeof lon !== "number") {
    return res.status(400).json({ error: "lat and lon are required" });
  }

  const result = await withTenant(req.user.tenantId, async (client) => {
    // Confirms the reporting user is a currently-active crew member on
    // THIS unit — not just any authenticated session that happens to
    // know a unit ID. Without this check, one compromised or careless
    // client could spoof another unit's position on the dispatch board.
    const assignment = await client.query(
      `SELECT 1 FROM unit_crew_assignments uca
       JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
       WHERE uca.unit_id = $1 AND cm.user_id = $2 AND uca.assigned_to IS NULL`,
      [req.params.id, req.user.userId]
    );
    if (assignment.rows.length === 0) return null;

    return client.query(
      `UPDATE units
       SET current_location = ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           location_updated_at = now()
       WHERE unit_id = $3
       RETURNING *`,
      [lon, lat, req.params.id]
    );
  });

  if (!result) {
    // Reporting a position for a unit you don't crew is how one would
    // spoof a vehicle onto the dispatch board — worth a record.
    await auditDenied(req.user, { method: req.method, path: req.originalUrl, reason: "not crew on this unit" });
    return res.status(403).json({ error: "You're not currently assigned to this unit" });
  }

  const unit = result.rows[0];
  // headingDeg/speedMph/accuracyM aren't persisted in this pass — the
  // core schema's units table only has current_location and
  // location_updated_at. Worth a real column each if heading/speed
  // needs to show up on the dispatch board itself (e.g. an arrow
  // showing direction of travel); passed through unused here rather
  // than silently dropped, so that gap stays visible.
  broadcastUnitStatusChange(req.app.get("io"), { tenantId: req.user.tenantId, incidentId: null, unit });
  res.json(unit);
});

export default router;

// =====================================================================
// Real considerations for production that aren't handled above:
//   - Update frequency: watchPosition can fire every few seconds while
//     moving. Reporting every single event is wasteful; a real client
//     should throttle to something like "report at most every 10-15
//     seconds, or immediately on a large jump" before calling this.
//   - Battery: continuous high-accuracy GPS is a real device battery
//     cost over a full shift — enableHighAccuracy should probably
//     relax once a unit is confirmed stationary (on scene, at
//     destination), not stay maxed the whole time.
//   - Policy, not just engineering: does tracking run for the whole
//     shift or only while actively assigned to a call? That's a labor
//     and privacy question your organization needs to answer, not
//     something this endpoint should assume.
// =====================================================================
