// backend_routes_inspections.js
// -----------------------------------------------------------------------
// Unit checks and inspections.
//
//  - The CHECKLIST is the agency's own. It starts from a short generic
//    starter list; a supervisor replaces or extends it with the agency's
//    real equipment inventory (add one at a time, or paste a list). This
//    code does not assert what any regulation requires: NYS DOH Part 800
//    equipment requirements were being replaced in 2026, so the current
//    inventory has to come from the agency, not be baked in here.
//  - A SHIFT CHECK is the crew walking the checklist for their unit and
//    answering each line OK / not OK (with a note for anything not OK).
//    That's the "vehicle check sheet" DOH inspectors ask to see.
//  - A PERIODIC INSPECTION (DMV, mechanical, DOH, other) is recorded by a
//    supervisor with its result and when the next one is due.
//
// A failed check FLAGS a unit; it doesn't take it out of service by itself.
// That is a supervisor's call.
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
const PERIODIC = ["dmv_inspection", "mechanical", "doh_inspection", "other"];

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const fail = (s, m) => { throw new HttpError(s, m); };
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { if (e instanceof HttpError) return res.status(e.status).json({ error: e.message }); throw e; }
};
// Which checklist levels apply to a unit: BLS items to everyone, ALS items to ALS and CCT, CCT to CCT.
const levelsFor = (cap) => (cap === "CCT" ? ["BLS", "ALS", "CCT"] : cap === "ALS" ? ["BLS", "ALS"] : ["BLS"]);

// ---- the checklist ---------------------------------------------------------------
router.get("/checklist", handle(async (req, res) => {
  const unitId = req.query.unitId;
  const rows = await withTenant(req.user.tenantId, async (c) => {
    if (unitId !== undefined) {
      if (!UUID_RE.test(String(unitId))) fail(400, "Bad unit id");
      const u = (await c.query("SELECT v.capability_level FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE un.unit_id = $1", [unitId])).rows[0];
      if (!u) fail(404, "Unit not found");
      return (await c.query("SELECT * FROM checklist_items WHERE is_active AND applies_to = ANY($1) ORDER BY sort_order, category, label", [levelsFor(u.capability_level)])).rows;
    }
    return (await c.query("SELECT * FROM checklist_items ORDER BY is_active DESC, sort_order, category, label")).rows;
  });
  res.json(rows);
}));

function readItem(b, { partial }) {
  const out = {};
  if (!partial || b.label !== undefined) { const v = String(b.label ?? "").trim(); if (v.length < 2) fail(400, "Give the item a name"); out.label = v.slice(0, 200); }
  if (!partial || b.category !== undefined) { out.category = String(b.category ?? "").trim().slice(0, 80) || "General"; }
  if (b.appliesTo !== undefined) { if (!LEVELS.includes(b.appliesTo)) fail(400, "Applies to BLS, ALS or CCT"); out.applies_to = b.appliesTo; }
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
      `INSERT INTO checklist_items (tenant_id, applies_to, category, label, min_quantity, sort_order, source) VALUES ($1, $2, $3, $4, $5, $6, 'custom') RETURNING *`,
      [req.user.tenantId, f.applies_to || "BLS", f.category, f.label, f.min_quantity ?? null, Number(max) + 10])).rows[0];
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
      const dup = await c.query("SELECT 1 FROM checklist_items WHERE lower(label) = lower($1) AND applies_to = $2 AND is_active", [p.label, p.lv]);
      if (dup.rows.length) { skipped++; continue; }
      order += 10;
      await c.query(`INSERT INTO checklist_items (tenant_id, applies_to, category, label, min_quantity, sort_order, source) VALUES ($1, $2, $3, $4, $5, $6, 'imported')`,
        [req.user.tenantId, p.lv, p.category, p.label, p.q, order]);
      added++;
    }
    return { added, skipped };
  });
  res.status(201).json(result);
}));

// ---- shift checks ---------------------------------------------------------------------
router.post("/unit-checks", handle(async (req, res) => {
  const { unitId, items, notes } = req.body || {};
  if (!UUID_RE.test(String(unitId ?? ""))) fail(400, "Pick a unit");
  if (!Array.isArray(items)) fail(400, "Answer the checklist");
  const out = await withTenant(req.user.tenantId, async (c) => {
    const unit = (await c.query("SELECT un.unit_id, v.capability_level, v.unit_designation FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE un.unit_id = $1", [unitId])).rows[0];
    if (!unit) fail(404, "Unit not found");
    const roles = req.user.roles || [req.user.role];
    const onUnit = (await c.query(
      `SELECT 1 FROM unit_crew_assignments uca JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
       WHERE uca.unit_id = $1 AND cm.user_id = $2 AND uca.assigned_to IS NULL`, [unitId, req.user.userId])).rows.length > 0;
    if (!onUnit && !roles.some((r) => ["supervisor", "it_admin"].includes(r))) fail(403, "Only the crew on this unit, or a supervisor, can record its check.");
    const required = (await c.query("SELECT item_id, label, min_quantity FROM checklist_items WHERE is_active AND applies_to = ANY($1)", [levelsFor(unit.capability_level)])).rows;
    const answers = new Map(items.map((i) => [i.itemId, i]));
    for (const r of required) {
      const a = answers.get(r.item_id);
      if (!a || typeof a.ok !== "boolean") fail(400, `"${r.label}" wasn't answered.`);
      if (!a.ok && !String(a.note ?? "").trim()) fail(400, `Say what's wrong with "${r.label}".`);
      if (a.ok && r.min_quantity != null && a.quantity !== undefined && a.quantity !== null && Number(a.quantity) < r.min_quantity) fail(400, `"${r.label}" needs at least ${r.min_quantity}. If fewer are on board, mark it not OK and say why.`);
    }
    const failed = required.filter((r) => !answers.get(r.item_id).ok);
    const check = (await c.query(
      `INSERT INTO unit_checks (tenant_id, unit_id, kind, performed_by_user_id, result, notes) VALUES ($1, $2, 'shift_check', $3, $4, $5) RETURNING check_id, performed_at, result`,
      [req.user.tenantId, unitId, req.user.userId, failed.length ? "fail" : "pass", String(notes ?? "").trim().slice(0, 1000) || null])).rows[0];
    for (const r of required) {
      const a = answers.get(r.item_id);
      await c.query(`INSERT INTO unit_check_items (check_id, tenant_id, item_id, label, ok, quantity, note) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [check.check_id, req.user.tenantId, r.item_id, r.label, a.ok, Number.isInteger(a.quantity) ? a.quantity : null, a.ok ? null : String(a.note).trim().slice(0, 500)]);
    }
    return { ...check, failedItems: failed.map((f) => f.label) };
  });
  res.status(201).json(out);
}));

// ---- periodic inspections (DMV, mechanical, DOH, other) ---------------------------------
router.post("/unit-checks/inspection", ADMIN, handle(async (req, res) => {
  const { unitId, kind, result, nextDue, performedOn, notes } = req.body || {};
  if (!UUID_RE.test(String(unitId ?? ""))) fail(400, "Pick a unit");
  if (!PERIODIC.includes(kind)) fail(400, "Pick the kind of inspection");
  if (!["pass", "fail"].includes(result)) fail(400, "Pass or fail?");
  if (nextDue && !DATE_RE.test(nextDue)) fail(400, "Dates must look like 2027-03-31");
  if (performedOn && !DATE_RE.test(performedOn)) fail(400, "Dates must look like 2027-03-31");
  const row = await withTenant(req.user.tenantId, async (c) => {
    const u = (await c.query("SELECT vehicle_id FROM units WHERE unit_id = $1", [unitId])).rows[0];
    if (!u) fail(404, "Unit not found");
    const r = (await c.query(
      `INSERT INTO unit_checks (tenant_id, unit_id, kind, performed_by_user_id, performed_at, result, notes, next_due)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE)::timestamptz, $6, $7, $8) RETURNING check_id`,
      [req.user.tenantId, unitId, kind, req.user.userId, performedOn || null, result, String(notes ?? "").trim().slice(0, 1000) || null, nextDue || null])).rows[0];
    // Keep the single "next inspection due" date the compliance screen reads in step.
    if (nextDue && kind !== "other") await c.query("UPDATE vehicles SET next_inspection_due = $1, last_inspection_date = COALESCE($2::date, CURRENT_DATE) WHERE vehicle_id = $3", [nextDue, performedOn || null, u.vehicle_id]);
    return r;
  });
  res.status(201).json(row);
}));

// ---- the picture for supervisors and compliance ------------------------------------------
router.get("/unit-checks/status", handle(async (req, res) => {
  const rows = await withTenant(req.user.tenantId, async (c) => (await c.query(
    `SELECT un.unit_id, v.unit_designation, v.capability_level,
            crew.n AS crew_count, crew.since AS crew_since,
            last.check_id AS last_check_id, last.performed_at AS last_check_at, last.result AS last_check_result, lu.display_name AS last_check_by,
            COALESCE((SELECT json_agg(i.label ORDER BY i.label) FROM unit_check_items i WHERE i.check_id = last.check_id AND NOT i.ok), '[]') AS failed_items,
            COALESCE((SELECT json_agg(json_build_object('kind', p.kind, 'performedAt', p.performed_at, 'result', p.result, 'nextDue', p.next_due) ORDER BY p.kind)
                      FROM (SELECT DISTINCT ON (kind) kind, performed_at, result, next_due FROM unit_checks
                            WHERE unit_id = un.unit_id AND kind <> 'shift_check' ORDER BY kind, performed_at DESC) p), '[]') AS periodic
     FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id
     LEFT JOIN LATERAL (SELECT * FROM unit_checks k WHERE k.unit_id = un.unit_id AND k.kind = 'shift_check' ORDER BY k.performed_at DESC LIMIT 1) last ON TRUE
     LEFT JOIN users lu ON lu.user_id = last.performed_by_user_id
     LEFT JOIN LATERAL (SELECT count(*) AS n, min(uca.assigned_from) AS since FROM unit_crew_assignments uca WHERE uca.unit_id = un.unit_id AND uca.assigned_to IS NULL) crew ON TRUE
     ORDER BY v.unit_designation`)).rows);
  // A unit with a crew on it owes one check per crew per shift. "Due" means it has a crew and no
  // check since that crew came on (or within the last 12 hours, whichever is more recent).
  // The system can't see a crew walk around the truck; a check exists only when someone records it.
  res.json(rows.map((r) => {
    const since = r.crew_since ? new Date(r.crew_since) : null;
    const floor = since ? new Date(Math.max(since.getTime(), Date.now() - 12 * 3600 * 1000)) : null;
    return { ...r, check_due: Boolean(since) && (!r.last_check_at || new Date(r.last_check_at) < floor) };
  }));
}));

export default router;
