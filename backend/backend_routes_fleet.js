// backend_routes_fleet.js
// -----------------------------------------------------------------------
// The agency's VEHICLES: the numbered ambulances. A unit (BLS 1, Medic 7) has one vehicle at a
// time. Dispatchers and supervisors can swap it from OPS when a vehicle breaks down or is in an
// accident, and the unit stays active: the crew moves to another vehicle, the old one is marked
// out of service with the reason, and the new vehicle gets its own vehicle check.
// A vehicle goes with the crew: only a manned unit can be given one, and it is released again when
// the last person comes off the unit (see reconcileUnit in backend_routes_admin.js).
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth, requireRole } from "./backend_auth.js";

const router = express.Router();
router.use(requireAuth);
const ADMIN = requireRole("supervisor", "it_admin");
const STAFFING = requireRole("supervisor", "it_admin", "dispatcher");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const fail = (s, m) => { throw new HttpError(s, m); };
const handle = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (e instanceof HttpError) return res.status(e.status).json({ error: e.message }); throw e; } };

const SELECT = `
  SELECT f.fleet_vehicle_id, f.vehicle_number, f.make_model, f.plate, f.status, f.out_of_service_reason,
         f.last_inspection_date, f.next_inspection_due, f.retired_at, un.unit_id, v.unit_designation
  FROM fleet_vehicles f
  LEFT JOIN units un ON un.fleet_vehicle_id = f.fleet_vehicle_id AND un.retired_at IS NULL
  LEFT JOIN vehicles v ON v.vehicle_id = un.vehicle_id`;

router.get("/fleet", handle(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const all = req.query.all === "1" && (req.user.roles || []).some((r) => ["supervisor", "it_admin"].includes(r));
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const where = [], vals = [];
  if (!all) where.push("f.retired_at IS NULL");
  if (q) { vals.push(`%${q.replace(/[%_\\]/g, "\\$&")}%`); where.push(`(f.vehicle_number ILIKE $${vals.length} OR f.plate ILIKE $${vals.length} OR f.make_model ILIKE $${vals.length})`); }
  if (req.query.available === "1") where.push("f.status = 'in_service' AND un.unit_id IS NULL");
  const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const out = await withTenant(req.user.tenantId, async (c) => ({
    total: Number((await c.query(`SELECT count(*) AS n FROM fleet_vehicles f LEFT JOIN units un ON un.fleet_vehicle_id = f.fleet_vehicle_id AND un.retired_at IS NULL ${W}`, vals)).rows[0].n),
    rows: (await c.query(`${SELECT} ${W} ORDER BY f.retired_at NULLS FIRST, f.vehicle_number LIMIT ${limit} OFFSET ${offset}`, vals)).rows,
  }));
  res.set("X-Total-Count", String(out.total)).json(out.rows);
}));

router.post("/fleet", ADMIN, handle(async (req, res) => {
  const number = text(req.body?.vehicleNumber, 40);
  if (!number) fail(400, "Give the vehicle its number");
  try {
    const row = await withTenant(req.user.tenantId, async (c) => (await c.query(
      "INSERT INTO fleet_vehicles (tenant_id, vehicle_number, make_model, plate) VALUES ($1, $2, $3, $4) RETURNING fleet_vehicle_id",
      [req.user.tenantId, number, text(req.body?.makeModel), text(req.body?.plate, 20)])).rows[0]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === "23505") fail(409, `A vehicle numbered "${number}" already exists`);
    throw err;
  }
}));

router.patch("/fleet/:id", ADMIN, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad vehicle id");
  const b = req.body || {};
  const sets = [], vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.vehicleNumber !== undefined) { const n = text(b.vehicleNumber, 40); if (!n) fail(400, "A vehicle needs a number"); add("vehicle_number", n); }
  if (b.makeModel !== undefined) add("make_model", text(b.makeModel));
  if (b.plate !== undefined) add("plate", text(b.plate, 20));
  for (const [k, col] of [["nextInspectionDue", "next_inspection_due"], ["lastInspectionDate", "last_inspection_date"]]) {
    if (b[k] !== undefined) { if (b[k] && !DATE_RE.test(String(b[k]))) fail(400, "Dates must look like 2027-03-31"); add(col, b[k] || null); }
  }
  if (!sets.length) fail(400, "Nothing to change");
  vals.push(req.params.id);
  try {
    const r = await withTenant(req.user.tenantId, (c) => c.query(`UPDATE fleet_vehicles SET ${sets.join(", ")} WHERE fleet_vehicle_id = $${vals.length} AND retired_at IS NULL RETURNING fleet_vehicle_id`, vals));
    if (!r.rows.length) fail(404, "Vehicle not found");
  } catch (err) {
    if (err.code === "23505") fail(409, "Another vehicle already has that number");
    throw err;
  }
  res.json({ ok: true });
}));

// Never-used vehicles are deleted; ones with history (inspections, past assignments) are retired so
// those records stay. A vehicle a unit is using right now can't be removed: swap it out first.
router.delete("/fleet/:id", ADMIN, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad vehicle id");
  const out = await withTenant(req.user.tenantId, async (c) => {
    const f = (await c.query("SELECT fleet_vehicle_id FROM fleet_vehicles WHERE fleet_vehicle_id = $1 AND retired_at IS NULL", [req.params.id])).rows[0];
    if (!f) fail(404, "Vehicle not found");
    const on = (await c.query("SELECT v.unit_designation FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE un.fleet_vehicle_id = $1 AND un.retired_at IS NULL", [req.params.id])).rows[0];
    if (on) fail(409, `${on.unit_designation} is using this vehicle. Switch it to another vehicle in OPS first.`);
    const used = Number((await c.query(
      `SELECT (SELECT count(*) FROM unit_checks WHERE fleet_vehicle_id = $1) + (SELECT count(*) FROM unit_vehicle_log WHERE from_vehicle_id = $1 OR to_vehicle_id = $1) AS n`, [req.params.id])).rows[0].n);
    if (used === 0) { await c.query("DELETE FROM fleet_vehicles WHERE fleet_vehicle_id = $1", [req.params.id]); return { deleted: true }; }
    await c.query("UPDATE fleet_vehicles SET retired_at = now() WHERE fleet_vehicle_id = $1", [req.params.id]);
    return { retired: true };
  });
  res.json(out);
}));

router.post("/fleet/:id/out-of-service", STAFFING, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad vehicle id");
  const reason = text(req.body?.reason, 300);
  if (!reason || reason.length < 3) fail(400, "Say why (mechanical issue, accident...)");
  const r = await withTenant(req.user.tenantId, (c) => c.query("UPDATE fleet_vehicles SET status = 'out_of_service', out_of_service_reason = $2 WHERE fleet_vehicle_id = $1 AND retired_at IS NULL RETURNING fleet_vehicle_id", [req.params.id, reason]));
  if (!r.rows.length) fail(404, "Vehicle not found");
  res.json({ ok: true });
}));

router.post("/fleet/:id/return-to-service", STAFFING, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad vehicle id");
  const r = await withTenant(req.user.tenantId, (c) => c.query("UPDATE fleet_vehicles SET status = 'in_service', out_of_service_reason = NULL WHERE fleet_vehicle_id = $1 AND retired_at IS NULL RETURNING fleet_vehicle_id", [req.params.id]));
  if (!r.rows.length) fail(404, "Vehicle not found");
  res.json({ ok: true });
}));

// Give a unit a vehicle, or switch it to another. The unit stays active throughout.
//   fleetVehicleId  the vehicle to use (null takes the unit's vehicle away)
//   markOldOutOfService + reason   when the old one has broken down or been in an accident
router.put("/units/:id/vehicle", STAFFING, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad unit id");
  const { fleetVehicleId, markOldOutOfService } = req.body || {};
  const reason = text(req.body?.reason, 300);
  if (fleetVehicleId !== null && !UUID_RE.test(String(fleetVehicleId ?? ""))) fail(400, "Pick a vehicle");
  if (markOldOutOfService && (!reason || reason.length < 3)) fail(400, "Say why the old vehicle is coming out of service");
  await withTenant(req.user.tenantId, async (c) => {
    const unit = (await c.query("SELECT un.unit_id, un.fleet_vehicle_id, v.unit_designation FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE un.unit_id = $1 AND un.retired_at IS NULL", [req.params.id])).rows[0];
    if (!unit) fail(404, "Unit not found");
    if ((unit.fleet_vehicle_id || null) === (fleetVehicleId || null)) fail(400, "The unit already has that vehicle");
    if (fleetVehicleId) {
      const aboard = Number((await c.query("SELECT count(*) AS n FROM unit_crew_assignments WHERE unit_id = $1 AND assigned_to IS NULL", [req.params.id])).rows[0].n);
      if (aboard === 0) fail(409, `Put crew on ${unit.unit_designation} first. A vehicle goes with the crew.`);
      const f = (await c.query("SELECT vehicle_number, status, retired_at FROM fleet_vehicles WHERE fleet_vehicle_id = $1", [fleetVehicleId])).rows[0];
      if (!f || f.retired_at) fail(404, "Vehicle not found");
      if (f.status !== "in_service") fail(409, `Vehicle ${f.vehicle_number} is out of service. Return it to service first.`);
      const other = (await c.query("SELECT v.unit_designation FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE un.fleet_vehicle_id = $1 AND un.retired_at IS NULL AND un.unit_id <> $2", [fleetVehicleId, req.params.id])).rows[0];
      if (other) fail(409, `Vehicle ${f.vehicle_number} is on ${other.unit_designation}. Take it off that unit first.`);
    }
    if (unit.fleet_vehicle_id && markOldOutOfService) {
      await c.query("UPDATE fleet_vehicles SET status = 'out_of_service', out_of_service_reason = $2 WHERE fleet_vehicle_id = $1", [unit.fleet_vehicle_id, reason]);
    }
    await c.query("UPDATE units SET fleet_vehicle_id = $2 WHERE unit_id = $1", [req.params.id, fleetVehicleId || null]);
    await c.query("INSERT INTO unit_vehicle_log (tenant_id, unit_id, from_vehicle_id, to_vehicle_id, reason, by_user_id) VALUES ($1, $2, $3, $4, $5, $6)",
      [req.user.tenantId, req.params.id, unit.fleet_vehicle_id || null, fleetVehicleId || null, reason, req.user.userId]);
  });
  res.json({ ok: true });
}));

export default router;
