// backend_routes_reports.js
// -----------------------------------------------------------------------
// Response-time reporting, from what the system has recorded. Four intervals per call:
//   dispatch   call received  -> first unit assigned
//   turnout    unit assigned  -> unit en route
//   travel     en route       -> on scene
//   response   call received  -> on scene        (what the public experiences)
// They only exist when dispatchers assigned units and crews tapped their status in the
// app, so a call with missing taps counts as a call but not as a timed one. Cancelled
// calls are left out. Medians and 90th percentiles, because averages hide the bad ones.
// This is an operations view, not a regulatory filing.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth, requireRole } from "./backend_auth.js";

const router = express.Router();
router.use(requireAuth);
const REPORTERS = requireRole("supervisor", "it_admin", "compliance_officer", "read_only_auditor");

const pct = (col, q) => `percentile_cont(${q}) WITHIN GROUP (ORDER BY ${col}) FILTER (WHERE ${col} >= 0)`;

router.get("/reports/response", REPORTERS, async (req, res) => {
  const days = [7, 30, 90, 365].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 30;
  const out = await withTenant(req.user.tenantId, async (c) => {
    const byPriority = (await c.query(`
      WITH calls AS (
        SELECT incident_id, priority, call_received_at FROM incidents
        WHERE call_received_at >= now() - make_interval(days => $1) AND cancelled_at IS NULL),
      primaries AS (
        SELECT iua.incident_id, iua.assigned_at,
               (SELECT min(h.recorded_at) FROM unit_status_history h WHERE h.unit_id = iua.unit_id AND h.status = 'en_route' AND h.recorded_at >= iua.assigned_at) AS en_route_at,
               (SELECT min(h.recorded_at) FROM unit_status_history h WHERE h.unit_id = iua.unit_id AND h.status = 'on_scene' AND h.recorded_at >= iua.assigned_at) AS on_scene_at
        FROM incident_unit_assignments iua JOIN calls USING (incident_id) WHERE iua.role IN ('primary', 'als_intercept')),
      per_call AS (
        SELECT c.incident_id, c.priority, c.call_received_at, min(p.assigned_at) AS notified_at, min(p.en_route_at) AS en_route_at, min(p.on_scene_at) AS on_scene_at
        FROM calls c LEFT JOIN primaries p ON p.incident_id = c.incident_id GROUP BY c.incident_id, c.priority, c.call_received_at),
      iv AS (
        SELECT priority,
               EXTRACT(EPOCH FROM notified_at - call_received_at) AS dispatch_s, EXTRACT(EPOCH FROM en_route_at - notified_at) AS turnout_s,
               EXTRACT(EPOCH FROM on_scene_at - en_route_at) AS travel_s, EXTRACT(EPOCH FROM on_scene_at - call_received_at) AS response_s
        FROM per_call)
      SELECT priority, count(*) AS calls, count(response_s) FILTER (WHERE response_s >= 0) AS timed,
             ${pct("dispatch_s", 0.5)} AS dispatch_median, ${pct("dispatch_s", 0.9)} AS dispatch_p90,
             ${pct("turnout_s", 0.5)} AS turnout_median, ${pct("turnout_s", 0.9)} AS turnout_p90,
             ${pct("travel_s", 0.5)} AS travel_median, ${pct("travel_s", 0.9)} AS travel_p90,
             ${pct("response_s", 0.5)} AS response_median, ${pct("response_s", 0.9)} AS response_p90
      FROM iv GROUP BY priority`, [days])).rows;
    const daily = (await c.query(
      `SELECT call_received_at::date AS day, count(*) AS calls FROM incidents
       WHERE call_received_at >= now() - make_interval(days => $1) AND cancelled_at IS NULL GROUP BY 1 ORDER BY 1`, [days])).rows;
    const cancelled = Number((await c.query("SELECT count(*) AS n FROM incidents WHERE call_received_at >= now() - make_interval(days => $1) AND cancelled_at IS NOT NULL", [days])).rows[0].n);
    return { byPriority, daily, cancelled };
  });
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  const order = ["critical", "emergent", "urgent", "routine"];
  res.json({
    days, cancelled: out.cancelled,
    totalCalls: out.byPriority.reduce((n, r) => n + Number(r.calls), 0),
    byPriority: out.byPriority.sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority)).map((r) => ({
      priority: r.priority, calls: Number(r.calls), timed: Number(r.timed),
      ...Object.fromEntries(["dispatch", "turnout", "travel", "response"].flatMap((k) => [[`${k}Median`, num(r[`${k}_median`])], [`${k}P90`, num(r[`${k}_p90`])]])),
    })),
    daily: out.daily.map((d) => ({ day: new Date(d.day).toISOString().slice(0, 10), calls: Number(d.calls) })),
  });
});

export default router;
