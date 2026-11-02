// backend_routes_facilities.js
// -----------------------------------------------------------------------
// The agency's saved places: the hospitals, nursing homes, dialysis centers and
// other destinations dispatch uses over and over. A dispatcher picks one from
// this list instead of typing and geocoding it each time, and the chart's
// destination comes from it (which is what satisfies "transported, with a
// destination facility").
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth, requireRole } from "./backend_auth.js";
import { geocodeAddress } from "./backend_geocode.js";

const router = express.Router();
router.use(requireAuth);
const ADMIN = requireRole("supervisor", "it_admin");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FACILITY_TYPES = ["hospital", "nursing_home", "dialysis_center", "rehab", "clinic", "other"];
const text = (v, max = 300) => (v == null ? null : String(v).trim().slice(0, max) || null);
const coord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const fail = (s, m) => { throw new HttpError(s, m); };
const handle = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { if (e instanceof HttpError) return res.status(e.status).json({ error: e.message }); throw e; } };

const SELECT = `SELECT facility_id, name, facility_type, address, phone, access_notes, is_active,
                       ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon FROM facilities`;

router.get("/facilities", handle(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const all = req.query.all === "1" && (req.user.roles || []).some((r) => ["supervisor", "it_admin"].includes(r));
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const where = [], vals = [];
  if (!all) where.push("is_active");
  if (q) { vals.push(`%${q.replace(/[%_\\]/g, "\\$&")}%`); where.push(`(name ILIKE $${vals.length} OR address ILIKE $${vals.length})`); }
  const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const out = await withTenant(req.user.tenantId, async (c) => ({
    total: Number((await c.query(`SELECT count(*) AS n FROM facilities ${W}`, vals)).rows[0].n),
    rows: (await c.query(`${SELECT} ${W} ORDER BY is_active DESC, name LIMIT ${limit} OFFSET ${offset}`, vals)).rows,
  }));
  res.set("X-Total-Count", String(out.total)).json(out.rows);
}));

function read(b, partial) {
  const o = {};
  if (!partial || b.name !== undefined) { const v = text(b.name, 200); if (!v || v.length < 2) fail(400, "Give the place a name"); o.name = v; }
  if (!partial || b.facilityType !== undefined) { if (!FACILITY_TYPES.includes(b.facilityType)) fail(400, `Type must be one of: ${FACILITY_TYPES.join(", ")}`); o.facility_type = b.facilityType; }
  if (!partial || b.address !== undefined) { const v = text(b.address, 300); if (!v || v.length < 3) fail(400, "Enter the street address"); o.address = v; }
  if (b.phone !== undefined) o.phone = text(b.phone, 50);
  if (b.accessNotes !== undefined) o.access_notes = text(b.accessNotes, 1000);
  if (b.isActive !== undefined) o.is_active = Boolean(b.isActive);
  return o;
}

router.post("/facilities", ADMIN, handle(async (req, res) => {
  const f = read(req.body || {}, false);
  let { lat, lon } = req.body;
  if (!coord(lat, lon)) { const g = await geocodeAddress(f.address); lat = g?.lat; lon = g?.lon; }   // before the transaction opens
  try {
    const row = await withTenant(req.user.tenantId, async (c) => (await c.query(
      `INSERT INTO facilities (tenant_id, name, facility_type, address, phone, access_notes, location)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::double precision IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography END)
       RETURNING facility_id`,
      [req.user.tenantId, f.name, f.facility_type, f.address, f.phone ?? null, f.access_notes ?? null, coord(lat, lon) ? lon : null, coord(lat, lon) ? lat : null])).rows[0]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === "23505") fail(409, `"${f.name}" is already on the list`);
    throw err;
  }
}));

router.patch("/facilities/:id", ADMIN, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad id");
  const f = read(req.body || {}, true);
  const b = req.body || {};
  const sets = [], vals = [];
  for (const [k, v] of Object.entries(f)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
  if (b.lat !== undefined || b.lon !== undefined) {
    if (!coord(b.lat, b.lon)) fail(400, "Map coordinates are not valid");
    vals.push(b.lon, b.lat); sets.push(`location = ST_SetSRID(ST_MakePoint($${vals.length - 1}, $${vals.length}), 4326)::geography`);
  } else if (f.address) {
    const g = await geocodeAddress(f.address);
    if (g) { vals.push(g.lon, g.lat); sets.push(`location = ST_SetSRID(ST_MakePoint($${vals.length - 1}, $${vals.length}), 4326)::geography`); }
  }
  if (!sets.length) fail(400, "Nothing to change");
  vals.push(req.params.id);
  try {
    const r = await withTenant(req.user.tenantId, (c) => c.query(`UPDATE facilities SET ${sets.join(", ")} WHERE facility_id = $${vals.length} RETURNING facility_id`, vals));
    if (!r.rows.length) fail(404, "Place not found");
  } catch (err) {
    if (err.code === "23505") fail(409, "A place with that name is already on the list");
    throw err;
  }
  res.json({ ok: true });
}));

export default router;
