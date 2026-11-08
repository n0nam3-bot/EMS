// backend_routes_units.js
// -----------------------------------------------------------------------
// Listing units (with their live position and currently assigned crew) and
// changing a unit's status — which is also where unit_status_history gets
// written, since that table is the source of truth for response-time
// reporting. The rules for WHICH status changes are allowed live in
// backend_dispatch.js.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth } from "./backend_auth.js";
import { broadcastUnitStatusChange } from "./backend_websocket.js";
import { checkTransition, unitMissing, recordEvent, auditOverride, canOverride, EVENT_FOR_STATUS } from "./backend_dispatch.js";

const router = express.Router();
router.use(requireAuth);

const VALID_STATUSES = ["available", "assigned", "en_route", "on_scene", "transporting", "at_destination", "out_of_service"];
// Where a unit sits when its status is set by hand (column on the incident, and a word for the screen).
const STATUS_PLACE = {
  on_scene: { col: "scene_location", label: "pickup" },
  transporting: { col: "scene_location", label: "pickup" },
  at_destination: { col: "destination_location", label: "drop-off" },
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Crew aggregated as a JSON array per unit via unit_crew_display — the FILTER
// clause keeps an unstaffed unit's crew array genuinely empty ([]) instead of
// one null-filled object.
router.get("/units", async (req, res) => {
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query(`
      SELECT
        u.unit_id, u.current_status, u.location_updated_at, u.location_source, u.vehicle_number,
        ST_Y(u.current_location::geometry) AS lat,
        ST_X(u.current_location::geometry) AS lon,
        v.unit_designation, v.capability_level,
        COALESCE(
          json_agg(
            json_build_object(
              'employeeId', ucd.employee_number,
              'name', ucd.first_name || ' ' || ucd.last_name,
              'role', ucd.seat_role,
              'cert', ucd.cert_level,
              'crewMemberId', ucd.crew_member_id,
              'fieldLevel', cmx.field_level
            )
          ) FILTER (WHERE ucd.crew_member_id IS NOT NULL),
          '[]'
        ) AS crew
      FROM units u
      JOIN vehicles v ON v.vehicle_id = u.vehicle_id
      LEFT JOIN unit_crew_display ucd ON ucd.unit_id = u.unit_id
      LEFT JOIN crew_members cmx ON cmx.crew_member_id = ucd.crew_member_id
      WHERE v.archived_at IS NULL
      GROUP BY u.unit_id, u.current_status, u.location_updated_at, u.location_source, u.vehicle_number, v.unit_designation, v.capability_level
      ORDER BY v.unit_designation
    `)
  );
  res.json(result.rows);
});

// Body: { status } or, for a supervisor/dispatcher/IT admin, { status, override: true, reason }.
//   - A unit on a call moves forward through the call phases. Setting it available or out of
//     service is a release or a completion (409 otherwise). From "at destination", "available"
//     means the unit has cleared: it leaves the call and the call stays open for dispatch.
//   - A unit with no call can be set available, out of service, or en route (a move-up).
//   - Bringing a unit back into service needs its crew requirements met.
// Everything happens in one transaction: the unit row is locked, so two requests can't both win.
router.patch("/units/:id/status", async (req, res) => {
  const { status, override, reason } = req.body || {};
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "Unit not found" });
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
  }
  const wantsOverride = override === true;
  if (wantsOverride) {
    if (!canOverride(req.user)) return res.status(403).json({ error: "Only a supervisor or dispatcher can override a status rule" });
    if (String(reason ?? "").trim().length < 3) return res.status(400).json({ error: "Say why the status rule is being overridden" });
  }

  const out = await withTenant(req.user.tenantId, async (client) => {
    // A crew member can only change the status of the unit they are on.
    if (req.user.role === "crew") {
      const onIt = await client.query(
        `SELECT 1 FROM unit_crew_assignments uca JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
         WHERE uca.unit_id = $1 AND cm.user_id = $2 AND uca.assigned_to IS NULL`,
        [req.params.id, req.user.userId]
      );
      if (onIt.rows.length === 0) return { code: 403, error: "You're not currently assigned to this unit" };
    }
    const cur = (await client.query("SELECT current_status FROM units WHERE unit_id = $1 AND tenant_id = $2 FOR UPDATE", [req.params.id, req.user.tenantId])).rows[0];
    if (!cur) return { code: 404, error: "Unit not found" };
    const active = (await client.query(
      `SELECT iua.incident_id FROM incident_unit_assignments iua JOIN incidents i ON i.incident_id = iua.incident_id
       WHERE iua.unit_id = $1 AND iua.unassigned_at IS NULL AND i.closed_at IS NULL ORDER BY iua.assigned_at DESC LIMIT 1`, [req.params.id])).rows[0];
    const incidentId = active?.incident_id || null;

    const verdict = checkTransition(cur.current_status, status, Boolean(incidentId));
    let overridden = false;
    if (!verdict.ok) {
      if (!wantsOverride) return { code: 409, error: verdict.error };
      overridden = true;
    }
    if (!overridden && cur.current_status === "out_of_service" && status === "available") {
      const missing = await unitMissing(client, req.params.id);
      if (missing.length) {
        if (!wantsOverride) return { code: 409, error: `This unit can't go back in service until it has ${missing.join(" and ")}.` };
        overridden = true;
      }
    }
    if (verdict.noop) {
      return { unit: (await client.query("SELECT * FROM units WHERE unit_id = $1", [req.params.id])).rows[0] };
    }

    const updated = (await client.query("UPDATE units SET current_status = $1 WHERE unit_id = $2 RETURNING *", [status, req.params.id])).rows[0];
    // The history row carries the call, so response times can be reported per incident
    // and a shared call's history stays visible to an assisting agency.
    await client.query("INSERT INTO unit_status_history (tenant_id, unit_id, incident_id, status) VALUES ($1, $2, $3, $4)", [req.user.tenantId, req.params.id, incidentId, status]);
    if (verdict.clears) {
      await client.query("UPDATE incident_unit_assignments SET unassigned_at = now() WHERE unit_id = $1 AND incident_id = $2 AND unassigned_at IS NULL", [req.params.id, incidentId]);
    }
    if (incidentId && EVENT_FOR_STATUS[status]) {
      await recordEvent(client, req.user, { incidentId, unitId: req.params.id, kind: EVENT_FOR_STATUS[status], overrideReason: overridden ? String(reason).trim() : null });
    }
    // No GPS yet, so a status change placed by hand puts the unit where it would be: at the
    // pickup when on scene (and when leaving it), at the drop-off when at destination. A unit
    // that is reporting real GPS (a fix in the last 2 minutes) is never moved by a status change.
    let movedTo = null;
    if (incidentId && STATUS_PLACE[status]) {
      const col = STATUS_PLACE[status].col;
      const placed = await client.query(
        `UPDATE units u SET current_location = i.${col}, location_updated_at = now(), location_source = 'status'
         FROM incidents i
         WHERE u.unit_id = $1 AND i.incident_id = $2 AND i.${col} IS NOT NULL
           AND (u.location_source IS DISTINCT FROM 'gps' OR u.location_updated_at IS NULL OR u.location_updated_at < now() - interval '2 minutes')
         RETURNING u.unit_id`, [req.params.id, incidentId]);
      if (placed.rows.length) movedTo = STATUS_PLACE[status].label;
    }
    if (overridden) {
      await auditOverride(client, req.user, req.params.id, { from: cur.current_status, to: status, reason: String(reason).trim(), incident_id: incidentId });
    }
    const fresh = movedTo ? (await client.query("SELECT * FROM units WHERE unit_id = $1", [req.params.id])).rows[0] : updated;
    return { unit: { ...fresh, moved_to: movedTo }, incidentId };
  });
  if (out.error) return res.status(out.code).json({ error: out.error });
  broadcastUnitStatusChange(req.app.get("io"), { tenantId: req.user.tenantId, incidentId: out.incidentId || null, unit: out.unit });
  res.json(out.unit);
});

export default router;
