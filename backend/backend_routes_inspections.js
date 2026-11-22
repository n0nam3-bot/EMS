// backend_routes_inspections.js
// -----------------------------------------------------------------------
// Unit checks and inspections, split by who is responsible for what:
//
//   VEHICLE check   the DRIVER of the unit, for the vehicle it has right now
//   BLS check       an EMT, AEMT or paramedic on the unit, for the BLS equipment inside it
//   ALS check       the PARAMEDIC on the unit, for the ALS equipment (ALS and CCT units only)
//
// The checklist is the agency's own. It starts from a short generic list; a supervisor
// replaces or extends it with the agency's real equipment inventory (add one at a time,
// or paste a list). This code does not assert what any regulation requires: NYS DOH Part 800
// equipment requirements were being replaced in 2026, so the current inventory has to come
// from the agency, not be baked in here.
//
// The system cannot see a crew walk around the truck. A check exists only when someone
// records it, and "due" means the unit has a crew and no check of that kind since that crew
// came on (or in the last 12 hours). If the vehicle is swapped mid-shift, the new vehicle
// needs its own vehicle check.
//
// A failed check FLAGS a unit; it doesn't take it out of service by itself. That's a
// supervisor's call. Periodic inspections (DMV, mechanical, DOH, other) belong to the
// VEHICLE and follow it from unit to unit.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth, requireRole } from "./backend_auth.js";

const router = express.Router();
router.use(requireAuth);
const ADMIN = requireRole("supervisor", "it_admin");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEVELS = ["BLS", "ALS", "CCT"];
const SECTIONS = ["vehicle", "equipment"];
const KINDS = ["vehicle", "bls", "als"];
const PERIODIC = ["dmv_inspection", "mechanical", "doh_inspection", "other"];
const CLINICAL = ["emt", "aemt", "paramedic"];
const SHIFT_HOURS = 12;

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const fail = (s, m) => { throw new HttpError(s, m); };
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { if (e instanceof HttpError) return res.status(e.status).json({ error: e.message }); throw e; }
};

// Which checklist items a kind of check covers for a unit of this level.
function itemsFilter(kind, cap) {
  if (kind === "vehicle") return { where: "section = 'vehicle'", params: [] };
  if (kind === "bls") return { where: "section = 'equipment' AND applies_to = 'BLS'", params: [] };
  return { where: "section = 'equipment' AND applies_to = ANY($1)", params: [cap === "CCT" ? ["ALS", "CCT"] : ["ALS"]] };
}

// ---- the checklist ---------------------------------------------------------------
router.get("/checklist", handle(async (req, res) => {
  const { unitId, kind } = req.query;
  const rows = await withTenant(req.user.tenantId, async (c) => {
    if (unitId !== undefined) {
      if (!UUID_RE.test(String(unitId))) fail(400, "Bad unit id");
      const u = (await c.query("SELECT v.capability_level FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE un.unit_id = $1", [unitId])).rows[0];
      if (!u) fail(404, "Unit not found");
      if (kind && !KINDS.includes(kind)) fail(400, "Kind must be vehicle, bls or als");
      const out = [];
      for (const k of kind ? [kind] : KINDS) {
        if (k === "als" && u.capability_level === "BLS") continue;
        const f = itemsFilter(k, u.capability_level);
        out.push(...(await c.query(`SELECT * FROM checklist_items WHERE is_active AND ${f.where} ORDER BY sort_order, category, label`, f.params)).rows);
      }
      return out;
    }
    return (await c.query("SELECT * FROM checklist_items ORDER BY is_active DESC, section, sort_order, category, label")).rows;
  });
  res.json(rows);
}));

function readItem(b, { partial }) {
  const out = {};
  if (!partial || b.label !== undefined) { const v = String(b.label ?? "").trim(); if (v.length < 2) fail(400, "Give the item a name"); out.label = v.slice(0, 200); }
  if (!partial || b.category !== undefined) { out.category = String(b.category ?? "").trim().slice(0, 80) || "General"; }
  if (b.appliesTo !== undefined) { if (!LEVELS.includes(b.appliesTo)) fail(400, "Applies to BLS, ALS or CCT"); out.applies_to = b.appliesTo; }
  if (b.section !== undefined) { if (!SECTIONS.includes(b.section)) fail(400, "Section must be vehicle or equipment"); out.section = b.section; }
  if (b.minQuantity !== undefined) { const q = b.minQuantity === null || b.minQuantity === "" ? null : Number(b.minQuantity); if (q !== null && (!Number.isInteger(q) || q < 0 || q > 10000)) fail(400, "Quantity must be a whole number"); out.min_quantity = q; }
  if (b.isActive !== undefined) out.is_active = Boolean(b.isActive);
  if (b.sortOrder !== undefined) out.sort_order = Number(b.sortOrder) || 0;
  return out;
}

router.post("/checklist", ADMIN, handle(async (req, res) => {
  const f = readItem(req.body || {}, { partial: false });
  const row = await withTenant(req.user.tenantId, async (c) => {
    const max = (await c.query("SELECT COALESCE(max(sort_order), 0) AS m FROM checklist_items")).rows[0].m;
    return (await c.query(
      `INSERT INTO checklist_items (tenant_id, applies_to, category, label, min_quantity, sort_order, section, source) VALUES ($1, $2, $3, $4, $5, $6, $7, 'custom') RETURNING *`,
      [req.user.tenantId, f.applies_to || "BLS", f.category, f.label, f.min_quantity ?? null, Number(max) + 10, f.section || "equipment"])).rows[0];
  });
  res.status(201).json(row);
}));

router.patch("/checklist/:id", ADMIN, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad id");
  const f = readItem(req.body || {}, { partial: true });
  const keys = Object.keys(f);
  if (!keys.length) fail(400, "Nothing to change");
  const row = await withTenant(req.user.tenantId, async (c) =>
    (await c.query(`UPDATE checklist_items SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(", ")} WHERE item_id = $${keys.length + 1} RETURNING *`, [...keys.map((k) => f[k]), req.params.id])).rows[0]);
  if (!row) fail(404, "Item not found");
  res.json(row);
}));

// Paste a list, one item per line:  Name, quantity, level, category  (everything after the name optional).
// Tabs, commas or | all work, so a list copied from a spreadsheet or the DOH inventory pastes straight in.
router.post("/checklist/import", ADMIN, handle(async (req, res) => {
  const defaultLevel = req.body?.appliesTo || "BLS";
  if (!LEVELS.includes(defaultLevel)) fail(400, "Applies to BLS, ALS or CCT");
  const section = req.body?.section || "equipment";
  if (!SECTIONS.includes(section)) fail(400, "Section must be vehicle or equipment");
  const defaultCategory = String(req.body?.category ?? "").trim() || "Imported";
  const lines = String(req.body?.text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) fail(400, "Paste at least one line");
  if (lines.length > 500) fail(400, "Please import 500 lines or fewer at a time");
  const parsed = lines.map((line) => {
    const [label, qty, level, category] = line.split(/\t|\||,(?=\s*\d+\s*(?:,|$))|,(?=\s*(?:BLS|ALS|CCT)\b)/i).map((x) => x.trim());
    const q = qty !== undefined && /^\d+$/.test(qty) ? Number(qty) : null;
    const lv = level && LEVELS.includes(level.toUpperCase()) ? level.toUpperCase() : defaultLevel;
    return { label: (label || "").slice(0, 200), q, lv, category: (category || defaultCategory).slice(0, 80) };
  }).filter((p) => p.label.length >= 2);
  const result = await withTenant(req.user.tenantId, async (c) => {
    let added = 0, skipped = 0;
    let order = Number((await c.query("SELECT COALESCE(max(sort_order), 0) AS m FROM checklist_items")).rows[0].m);
    for (const p of parsed) {
      const dup = await c.query("SELECT 1 FROM checklist_items WHERE lower(label) = lower($1) AND applies_to = $2 AND section = $3 AND is_active", [p.label, p.lv, section]);
      if (dup.rows.length) { skipped++; continue; }
      order += 10;
      await c.query(`INSERT INTO checklist_items (tenant_id, applies_to, category, label, min_quantity, sort_order, section, source) VALUES ($1, $2, $3, $4, $5, $6, $7, 'imported')`,
        [req.user.tenantId, p.lv, p.category, p.label, p.q, order, section]);
      added++;
    }
    return { added, skipped };
  });
  res.status(201).json(result);
}));

// ---- recording a check -------------------------------------------------------------------
router.post("/unit-checks", handle(async (req, res) => {
  const { unitId, kind, items, notes } = req.body || {};
  if (!UUID_RE.test(String(unitId ?? ""))) fail(400, "Pick a unit");
  if (!KINDS.includes(kind)) fail(400, "Say which check this is: vehicle, bls or als");
  if (!Array.isArray(items)) fail(400, "Answer the checklist");
  const out = await withTenant(req.user.tenantId, async (c) => {
    const unit = (await c.query(
      `SELECT un.unit_id, un.fleet_vehicle_id, v.capability_level, v.unit_designation, fv.status AS vehicle_status, fv.vehicle_number
       FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id LEFT JOIN fleet_vehicles fv ON fv.fleet_vehicle_id = un.fleet_vehicle_id
       WHERE un.unit_id = $1 AND un.retired_at IS NULL`, [unitId])).rows[0];
    if (!unit) fail(404, "Unit not found");
    const isAdmin = (req.user.roles || [req.user.role]).some((r) => ["supervisor", "it_admin"].includes(r));
    const me = (await c.query(
      `SELECT uca.seat_role, cm.field_level FROM unit_crew_assignments uca JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
       WHERE uca.unit_id = $1 AND cm.user_id = $2 AND uca.assigned_to IS NULL`, [unitId, req.user.userId])).rows[0];
    if (kind === "vehicle") {
      if (!unit.fleet_vehicle_id) fail(409, `${unit.unit_designation} has no vehicle assigned. Assign one in OPS first.`);
      if (!isAdmin && me?.seat_role !== "driver") fail(403, "Only the driver of this unit (or a supervisor) can record the vehicle check.");
    } else if (kind === "bls") {
      if (!isAdmin && !(me && CLINICAL.includes(me.field_level))) fail(403, "Only an EMT, AEMT or paramedic on this unit (or a supervisor) can record the BLS equipment check.");
    } else {
      if (unit.capability_level === "BLS") fail(409, `${unit.unit_designation} is a BLS unit, so it has no ALS equipment check.`);
      if (!isAdmin && me?.field_level !== "paramedic") fail(403, "Only the paramedic on this unit (or a supervisor) can record the ALS equipment check.");
    }
    const f = itemsFilter(kind, unit.capability_level);
    const required = (await c.query(`SELECT item_id, label, min_quantity FROM checklist_items WHERE is_active AND ${f.where}`, f.params)).rows;
    const answers = new Map(items.map((i) => [i.itemId, i]));
    for (const r of required) {
      const a = answers.get(r.item_id);
      if (!a || typeof a.ok !== "boolean") fail(400, `"${r.label}" wasn't answered.`);
      if (!a.ok && !String(a.note ?? "").trim()) fail(400, `Say what's wrong with "${r.label}".`);
      if (a.ok && r.min_quantity != null && a.quantity !== undefined && a.quantity !== null && Number(a.quantity) < r.min_quantity) fail(400, `"${r.label}" needs at least ${r.min_quantity}. If fewer are on board, mark it not OK and say why.`);
    }
    const failed = required.filter((r) => !answers.get(r.item_id).ok);
    const check = (await c.query(
      `INSERT INTO unit_checks (tenant_id, unit_id, kind, performed_by_user_id, result, notes, fleet_vehicle_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING check_id, performed_at, result`,
      [req.user.tenantId, unitId, `${kind}_check`, req.user.userId, failed.length ? "fail" : "pass", String(notes ?? "").trim().slice(0, 1000) || null, unit.fleet_vehicle_id])).rows[0];
    for (const r of required) {
      const a = answers.get(r.item_id);
      await c.query(`INSERT INTO unit_check_items (check_id, tenant_id, item_id, label, ok, quantity, note) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [check.check_id, req.user.tenantId, r.item_id, r.label, a.ok, Number.isInteger(a.quantity) ? a.quantity : null, a.ok ? null : String(a.note).trim().slice(0, 500)]);
    }
    return { ...check, failedItems: failed.map((x) => x.label) };
  });
  res.status(201).json(out);
}));

// ---- periodic inspections (DMV, mechanical, DOH, other): recorded against a VEHICLE ------------
router.post("/unit-checks/inspection", ADMIN, handle(async (req, res) => {
  const { unitId, fleetVehicleId, kind, result, nextDue, performedOn, notes } = req.body || {};
  if (!PERIODIC.includes(kind)) fail(400, "Pick the kind of inspection");
  if (!["pass", "fail"].includes(result)) fail(400, "Pass or fail?");
  if (nextDue && !DATE_RE.test(nextDue)) fail(400, "Dates must look like 2027-03-31");
  if (performedOn && !DATE_RE.test(performedOn)) fail(400, "Dates must look like 2027-03-31");
  const row = await withTenant(req.user.tenantId, async (c) => {
    let vehicleId = fleetVehicleId || null;
    const unit = unitId || null;
    if (vehicleId && !UUID_RE.test(String(vehicleId))) fail(400, "Bad vehicle id");
    if (!vehicleId) {
      if (!UUID_RE.test(String(unitId ?? ""))) fail(400, "Pick a vehicle");
      const u = (await c.query("SELECT fleet_vehicle_id FROM units WHERE unit_id = $1 AND retired_at IS NULL", [unitId])).rows[0];
      if (!u) fail(404, "Unit not found");
      if (!u.fleet_vehicle_id) fail(409, "That unit has no vehicle assigned. Assign one in OPS first.");
      vehicleId = u.fleet_vehicle_id;
    } else if (!(await c.query("SELECT 1 FROM fleet_vehicles WHERE fleet_vehicle_id = $1", [vehicleId])).rows.length) fail(404, "Vehicle not found");
    const r = (await c.query(
      `INSERT INTO unit_checks (tenant_id, unit_id, kind, performed_by_user_id, performed_at, result, notes, next_due, fleet_vehicle_id)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE)::timestamptz, $6, $7, $8, $9) RETURNING check_id`,
      [req.user.tenantId, unit, kind, req.user.userId, performedOn || null, result, String(notes ?? "").trim().slice(0, 1000) || null, nextDue || null, vehicleId])).rows[0];
    if (nextDue && kind !== "other") await c.query("UPDATE fleet_vehicles SET next_inspection_due = $1, last_inspection_date = COALESCE($2::date, CURRENT_DATE) WHERE fleet_vehicle_id = $3", [nextDue, performedOn || null, vehicleId]);
    return r;
  });
  res.status(201).json(row);
}));

// ---- the picture for supervisors, OPS, the Field screen and compliance ------------------------
router.get("/unit-checks/status", handle(async (req, res) => {
  const out = await withTenant(req.user.tenantId, async (c) => {
    const units = (await c.query(
      `SELECT un.unit_id, v.unit_designation, v.capability_level, un.fleet_vehicle_id, fv.vehicle_number, fv.status AS vehicle_status,
              crew.n AS crew_count, crew.since AS crew_since, crew.driver AS has_driver, crew.clinical AS has_clinical, crew.medic AS has_medic
       FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id LEFT JOIN fleet_vehicles fv ON fv.fleet_vehicle_id = un.fleet_vehicle_id
       LEFT JOIN LATERAL (SELECT count(*) AS n, min(uca.assigned_from) AS since,
                                 COALESCE(bool_or(uca.seat_role = 'driver'), FALSE) AS driver,
                                 COALESCE(bool_or(cm.field_level IN ('emt', 'aemt', 'paramedic')), FALSE) AS clinical,
                                 COALESCE(bool_or(cm.field_level = 'paramedic'), FALSE) AS medic
                          FROM unit_crew_assignments uca JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
                          WHERE uca.unit_id = un.unit_id AND uca.assigned_to IS NULL) crew ON TRUE
       WHERE un.retired_at IS NULL ORDER BY v.unit_designation`)).rows;
    const last = (await c.query(
      `SELECT DISTINCT ON (k.unit_id, k.kind) k.check_id, k.unit_id, k.kind, k.performed_at, k.result, u.display_name AS by
       FROM unit_checks k JOIN units un ON un.unit_id = k.unit_id LEFT JOIN users u ON u.user_id = k.performed_by_user_id
       WHERE k.kind IN ('vehicle_check', 'bls_check', 'als_check') AND un.retired_at IS NULL
         AND (k.kind <> 'vehicle_check' OR k.fleet_vehicle_id IS NOT DISTINCT FROM un.fleet_vehicle_id)
       ORDER BY k.unit_id, k.kind, k.performed_at DESC`)).rows;
    const failed = last.length ? (await c.query("SELECT check_id, json_agg(label ORDER BY label) AS labels FROM unit_check_items WHERE NOT ok AND check_id = ANY($1) GROUP BY check_id", [last.map((l) => l.check_id)])).rows : [];
    const periodic = (await c.query(
      `SELECT DISTINCT ON (un.unit_id, k.kind) un.unit_id, k.kind, k.performed_at, k.result, k.next_due
       FROM units un JOIN unit_checks k ON k.kind = ANY($1) AND ((un.fleet_vehicle_id IS NOT NULL AND k.fleet_vehicle_id = un.fleet_vehicle_id) OR (k.fleet_vehicle_id IS NULL AND k.unit_id = un.unit_id))
       WHERE un.retired_at IS NULL ORDER BY un.unit_id, k.kind, k.performed_at DESC`, [PERIODIC])).rows;
    return { units, last, failed, periodic };
  });
  const failedBy = new Map(out.failed.map((f) => [f.check_id, f.labels]));
  res.json(out.units.map((u) => {
    const since = u.crew_since ? new Date(u.crew_since) : null;
    const floor = since ? new Date(Math.max(since.getTime(), Date.now() - SHIFT_HOURS * 3600 * 1000)) : null;
    const required = { vehicle: Boolean(u.has_driver && u.fleet_vehicle_id), bls: Boolean(u.has_clinical), als: u.capability_level !== "BLS" && Boolean(u.has_medic) };
    const owner = { vehicle: "the driver", bls: "an EMT or above", als: "the paramedic" };
    const checks = {};
    for (const k of KINDS) {
      const l = out.last.find((x) => x.unit_id === u.unit_id && x.kind === `${k}_check`);
      checks[k] = {
        required: required[k], owner: owner[k],
        due: required[k] && (!l || new Date(l.performed_at) < floor),
        last_at: l?.performed_at || null, last_by: l?.by || null, last_result: l?.result || null, failed_items: l ? failedBy.get(l.check_id) || [] : [],
      };
    }
    const reqd = KINDS.filter((k) => required[k]);
    return {
      unit_id: u.unit_id, unit_designation: u.unit_designation, capability_level: u.capability_level,
      fleet_vehicle_id: u.fleet_vehicle_id, vehicle_number: u.vehicle_number, vehicle_status: u.vehicle_status,
      crew_count: Number(u.crew_count), crew_since: u.crew_since, checks,
      check_due: reqd.some((k) => checks[k].due),
      any_failed: KINDS.some((k) => checks[k].last_result === "fail" && !checks[k].due),
      periodic: out.periodic.filter((p) => p.unit_id === u.unit_id).map((p) => ({ kind: p.kind, performedAt: p.performed_at, result: p.result, nextDue: p.next_due })),
    };
  }));
}));

export default router;
