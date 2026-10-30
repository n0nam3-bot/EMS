// backend_routes_units.js
// -----------------------------------------------------------------------
// The two endpoints the dispatch console needs that didn't exist yet:
// listing units (with their live position, extracted from the PostGIS
// geography column, and their currently assigned crew) and changing a
// unit's status — which is also where unit_status_history actually
// gets written, since that table exists specifically to be the source
// of truth for response-time reporting and doing that write anywhere
// else would leave it incomplete.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth } from "./backend_auth.js";
import { broadcastUnitStatusChange } from "./backend_websocket.js";

const router = express.Router();
router.use(requireAuth);

const VALID_STATUSES = ["available", "assigned", "en_route", "on_scene", "transporting", "at_destination", "out_of_service"];

// Crew aggregated as a JSON array per unit via unit_crew_display (from
// crew_seat_role_schema.sql) — the FILTER clause keeps an unstaffed
// unit's crew array genuinely empty ([]) instead of containing one
// null-filled object, which is what a plain LEFT JOIN would otherwise
// produce through json_agg.
router.get("/units", async (req, res) => {
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query(`
      SELECT
        u.unit_id, u.current_status, u.location_updated_at,
        ST_Y(u.current_location::geometry) AS lat,
        ST_X(u.current_location::geometry) AS lon,
        v.unit_designation, v.capability_level,
        COALESCE(
          json_agg(
            json_build_object(
              'employeeId', ucd.employee_number,
              'name', ucd.first_name || ' ' || ucd.last_name,
              'role', ucd.seat_role,
              'cert', ucd.cert_level
            )
          ) FILTER (WHERE ucd.crew_member_id IS NOT NULL),
          '[]'
        ) AS crew
      FROM units u
      JOIN vehicles v ON v.vehicle_id = u.vehicle_id
      LEFT JOIN unit_crew_display ucd ON ucd.unit_id = u.unit_id
      GROUP BY u.unit_id, u.current_status, u.location_updated_at, v.unit_designation, v.capability_level
      ORDER BY v.unit_designation
    `)
  );
  res.json(result.rows);
});

router.patch("/units/:id/status", async (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
  }
  // Single transaction for both writes — the status change and its
  // history entry either both happen or neither does. Two separate
  // withTenant calls here would risk the status updating while the
  // history row silently doesn't, which defeats the point of having
  // unit_status_history as the response-time source of truth at all.
  const unit = await withTenant(req.user.tenantId, async (client) => {
    // A crew member can only change the status of the unit they are on.
    // Dispatchers and supervisors manage any unit in their company.
    if (req.user.role === "crew") {
      const onIt = await client.query(
        `SELECT 1 FROM unit_crew_assignments uca JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
         WHERE uca.unit_id = $1 AND cm.user_id = $2 AND uca.assigned_to IS NULL`,
        [req.params.id, req.user.userId]
      );
      if (onIt.rows.length === 0) return "forbidden";
    }
    const updated = await client.query(
      "UPDATE units SET current_status = $1 WHERE unit_id = $2 RETURNING *",
      [status, req.params.id]
    );
    if (updated.rows.length === 0) return null;
    await client.query(
      "INSERT INTO unit_status_history (tenant_id, unit_id, status) VALUES ($1, $2, $3)",
      [req.user.tenantId, req.params.id, status]
    );
    return updated.rows[0];
  });
  if (unit === "forbidden") return res.status(403).json({ error: "You're not currently assigned to this unit" });
  if (!unit) return res.status(404).json({ error: "Unit not found" });
  broadcastUnitStatusChange(req.app.get("io"), { tenantId: req.user.tenantId, incidentId: null, unit });
  res.json(unit);
});

export default router;
