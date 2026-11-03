// backend_routes_schedule.js
// -----------------------------------------------------------------------
// The shift schedule: who works when, and on which unit.
//
//   - Supervisors and dispatchers plan shifts (one, or the same shift across many days).
//   - Anyone with a shift covering "now" is ON DUTY; the OPS board lists them first.
//   - "Crew units as scheduled" turns today's schedule into the live crew on each unit,
//     using exactly the same rules as dragging people around on OPS. It's a button, not a
//     background job: nothing here runs on its own, so a unit is only crewed when someone
//     presses it. It shows its plan first.
//   - Crew see their own upcoming shifts.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth, requireRole } from "./backend_auth.js";
import { placeCrewMember } from "./backend_routes_admin.js";

const router = express.Router();
router.use(requireAuth);
const STAFFING = requireRole("supervisor", "it_admin", "dispatcher");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DAYS = 35;

class HttpError extends Error { constructor(s, m, extra) { super(m); this.status = s; this.extra = extra; } }
const fail = (s, m, extra) => { throw new HttpError(s, m, extra); };
const handle = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) }); throw e; }
};
const when = (v, what) => { const d = new Date(v); if (!v || Number.isNaN(d.getTime())) fail(400, `${what} isn't a valid date and time`); return d; };

const SHIFT_SELECT = `
  SELECT s.shift_id, s.crew_member_id, cm.first_name || ' ' || cm.last_name AS name, cm.field_level, s.unit_id, v.unit_designation,
         s.seat_role, s.starts_at, s.ends_at, s.notes
  FROM shifts s JOIN crew_members cm ON cm.crew_member_id = s.crew_member_id
  LEFT JOIN units u ON u.unit_id = s.unit_id LEFT JOIN vehicles v ON v.vehicle_id = u.vehicle_id`;

async function overlapWith(c, crewMemberId, startsAt, endsAt, exceptId = null) {
  return (await c.query(
    "SELECT starts_at, ends_at FROM shifts WHERE crew_member_id = $1 AND starts_at < $3 AND ends_at > $2 AND ($4::uuid IS NULL OR shift_id <> $4) LIMIT 1",
    [crewMemberId, startsAt, endsAt, exceptId])).rows[0] || null;
}

router.get("/schedule", STAFFING, handle(async (req, res) => {
  const from = when(req.query.from, "From"), to = when(req.query.to, "To");
  if (to <= from) fail(400, "The end of the range must be after its start");
  if (to - from > MAX_DAYS * 86400000) fail(400, `Ask for ${MAX_DAYS} days or fewer at a time`);
  const rows = await withTenant(req.user.tenantId, async (c) => (await c.query(`${SHIFT_SELECT} WHERE s.starts_at < $2 AND s.ends_at > $1 ORDER BY s.starts_at, cm.last_name`, [from, to])).rows);
  res.json(rows);
}));

// My own upcoming shifts (any signed-in person).
router.get("/schedule/mine", handle(async (req, res) => {
  const rows = await withTenant(req.user.tenantId, async (c) => (await c.query(
    `${SHIFT_SELECT} WHERE cm.user_id = $1 AND s.ends_at > now() AND s.starts_at < now() + interval '14 days' ORDER BY s.starts_at`, [req.user.userId])).rows);
  res.json(rows);
}));

// One shift, or the same shift on several days: `occurrences` is a list of {startsAt, endsAt}
// (the screen builds it, so daylight-saving changes land on the right clock time).
// All or nothing: if any day clashes with one of that person's other shifts, nothing is saved.
router.post("/schedule", STAFFING, handle(async (req, res) => {
  const b = req.body || {};
  if (!UUID_RE.test(String(b.crewMemberId ?? ""))) fail(400, "Pick a person");
  if (b.unitId != null && !UUID_RE.test(String(b.unitId))) fail(400, "Pick a unit");
  const occ = (Array.isArray(b.occurrences) && b.occurrences.length ? b.occurrences : [{ startsAt: b.startsAt, endsAt: b.endsAt }]).slice(0, 31)
    .map((o) => ({ startsAt: when(o.startsAt, "Start"), endsAt: when(o.endsAt, "End") }));
  for (const o of occ) {
    if (o.endsAt <= o.startsAt) fail(400, "A shift has to end after it starts");
    if (o.endsAt - o.startsAt > 24 * 3600000) fail(400, "A shift can be at most 24 hours");
  }
  const created = await withTenant(req.user.tenantId, async (c) => {
    const cm = (await c.query("SELECT first_name, last_name, field_level FROM crew_members WHERE crew_member_id = $1 AND is_active", [b.crewMemberId])).rows[0];
    if (!cm) fail(404, "Person not found, or deactivated");
    if (!cm.field_level) fail(409, `${cm.first_name} ${cm.last_name} doesn't work in the field, so can't be scheduled on a unit.`);
    if (b.unitId && !(await c.query("SELECT 1 FROM units WHERE unit_id = $1", [b.unitId])).rows.length) fail(404, "Unit not found");
    const seat = cm.field_level === "mvo" ? "driver" : b.seatRole === "driver" ? "driver" : b.seatRole === "non_driver" ? "non_driver" : null;
    const ids = [];
    for (const o of occ) {
      const clash = await overlapWith(c, b.crewMemberId, o.startsAt, o.endsAt);
      if (clash) fail(409, `${cm.first_name} ${cm.last_name} already has a shift that overlaps.`, { conflict: { startsAt: clash.starts_at, endsAt: clash.ends_at } });
      ids.push((await c.query(
        `INSERT INTO shifts (tenant_id, crew_member_id, unit_id, seat_role, starts_at, ends_at, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING shift_id`,
        [req.user.tenantId, b.crewMemberId, b.unitId || null, seat, o.startsAt, o.endsAt, String(b.notes ?? "").trim().slice(0, 300) || null, req.user.userId])).rows[0].shift_id);
    }
    return ids;
  });
  res.status(201).json({ created: created.length, shiftIds: created });
}));

router.patch("/schedule/:id", STAFFING, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad id");
  const b = req.body || {};
  await withTenant(req.user.tenantId, async (c) => {
    const cur = (await c.query("SELECT s.*, cm.field_level, cm.first_name, cm.last_name FROM shifts s JOIN crew_members cm ON cm.crew_member_id = s.crew_member_id WHERE s.shift_id = $1", [req.params.id])).rows[0];
    if (!cur) fail(404, "Shift not found");
    const startsAt = b.startsAt !== undefined ? when(b.startsAt, "Start") : cur.starts_at;
    const endsAt = b.endsAt !== undefined ? when(b.endsAt, "End") : cur.ends_at;
    if (endsAt <= startsAt) fail(400, "A shift has to end after it starts");
    if (endsAt - startsAt > 24 * 3600000) fail(400, "A shift can be at most 24 hours");
    const clash = await overlapWith(c, cur.crew_member_id, startsAt, endsAt, req.params.id);
    if (clash) fail(409, `${cur.first_name} ${cur.last_name} already has a shift that overlaps.`, { conflict: { startsAt: clash.starts_at, endsAt: clash.ends_at } });
    const unitId = b.unitId !== undefined ? b.unitId : cur.unit_id;
    if (unitId && !UUID_RE.test(String(unitId))) fail(400, "Pick a unit");
    const seat = cur.field_level === "mvo" ? "driver" : b.seatRole !== undefined ? (b.seatRole === "driver" ? "driver" : b.seatRole === "non_driver" ? "non_driver" : null) : cur.seat_role;
    await c.query("UPDATE shifts SET starts_at = $2, ends_at = $3, unit_id = $4, seat_role = $5, notes = $6 WHERE shift_id = $1",
      [req.params.id, startsAt, endsAt, unitId || null, seat, b.notes !== undefined ? String(b.notes ?? "").trim().slice(0, 300) || null : cur.notes]);
  });
  res.json({ ok: true });
}));

router.delete("/schedule/:id", STAFFING, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad id");
  const r = await withTenant(req.user.tenantId, (c) => c.query("DELETE FROM shifts WHERE shift_id = $1 RETURNING shift_id", [req.params.id]));
  if (!r.rows.length) fail(404, "Shift not found");
  res.json({ ok: true });
}));

// Crew each unit that has a shift running right now with exactly the people scheduled on it:
//   remove  anyone on the unit who isn't scheduled on it now
//   place   anyone scheduled on it now who isn't on it yet (drivers first)
// Units with no shift running now are left alone. `dryRun` returns the plan without changing anything.
router.post("/schedule/apply", STAFFING, handle(async (req, res) => {
  const dryRun = Boolean(req.body?.dryRun);
  const plan = await withTenant(req.user.tenantId, async (c) => {
    const due = (await c.query(
      `SELECT s.crew_member_id, cm.first_name || ' ' || cm.last_name AS name, cm.field_level, s.unit_id, s.seat_role, v.unit_designation, v.capability_level
       FROM shifts s JOIN crew_members cm ON cm.crew_member_id = s.crew_member_id AND cm.is_active
       JOIN units u ON u.unit_id = s.unit_id JOIN vehicles v ON v.vehicle_id = u.vehicle_id
       WHERE s.starts_at <= now() AND s.ends_at > now() AND s.unit_id IS NOT NULL`)).rows;
    const byUnit = new Map();
    for (const d of due) { if (!byUnit.has(d.unit_id)) byUnit.set(d.unit_id, []); byUnit.get(d.unit_id).push(d); }
    const remove = [], place = [];
    for (const [unitId, wanted] of byUnit) {
      const now = (await c.query(
        `SELECT uca.crew_member_id, cm.first_name || ' ' || cm.last_name AS name FROM unit_crew_assignments uca
         JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id WHERE uca.unit_id = $1 AND uca.assigned_to IS NULL`, [unitId])).rows;
      const wantedIds = new Set(wanted.map((w) => w.crew_member_id));
      const onIds = new Set(now.map((n) => n.crew_member_id));
      for (const n of now) if (!wantedIds.has(n.crew_member_id)) remove.push({ crewMemberId: n.crew_member_id, name: n.name, unitId, unit: wanted[0].unit_designation });
      // Seats: what the shift says; otherwise an MVO drives, and with no driver named, a non-paramedic
      // paired with a paramedic on an ALS/CCT unit drives.
      const explicitDriver = wanted.some((w) => w.seat_role === "driver" || w.field_level === "mvo");
      const hasMedic = wanted.some((w) => w.field_level === "paramedic");
      let driverGiven = explicitDriver;
      for (const w of wanted) {
        if (onIds.has(w.crew_member_id)) continue;
        let seat = w.seat_role || (w.field_level === "mvo" ? "driver" : "non_driver");
        if (!w.seat_role && !driverGiven && hasMedic && w.field_level !== "paramedic" && w.capability_level !== "BLS") { seat = "driver"; driverGiven = true; }
        place.push({ crewMemberId: w.crew_member_id, name: w.name, unitId, unit: w.unit_designation, seat });
      }
    }
    place.sort((a, b) => (a.seat === "driver" ? 0 : 1) - (b.seat === "driver" ? 0 : 1));
    return { remove, place };
  });
  if (dryRun) return res.json({ dryRun: true, ...plan });

  const skipped = []; let removed = 0, placed = 0;
  for (const r of plan.remove) {
    try { await withTenant(req.user.tenantId, (c) => placeCrewMember(c, req.user.tenantId, r.crewMemberId, null)); removed++; }
    catch (e) { skipped.push({ name: r.name, unit: r.unit, reason: e.message }); }
  }
  for (const p of plan.place) {
    try { await withTenant(req.user.tenantId, (c) => placeCrewMember(c, req.user.tenantId, p.crewMemberId, p.unitId, p.seat)); placed++; }
    catch (e) { skipped.push({ name: p.name, unit: p.unit, reason: e.message }); }
  }
  res.json({ removed, placed, skipped });
}));

export default router;
