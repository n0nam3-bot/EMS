// backend_routes_admin.js
// -----------------------------------------------------------------------
// Everything a supervisor needs to set up and run their own company:
// people and their logins, units, who is crewing which unit, certifications
// and vehicle inspection dates. This is also where the Compliance screen's
// data comes from — nothing there appears until it's entered here.
//
// Every query runs through withTenant, so a supervisor can only ever see
// and change their own company's records.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth, requireRole } from "./backend_auth.js";
import { hashPassword, passwordProblem } from "./backend_passwords.js";
import { searchPlaces, geocodingEnabled } from "./backend_geocode.js";

const router = express.Router();
router.use(requireAuth);

const ADMIN = requireRole("supervisor", "it_admin");
// Putting people on units is the dispatchers' job too.
const STAFFING = requireRole("supervisor", "it_admin", "dispatcher");
const MAX_CREW = 3;
const ROLES = ["dispatcher", "crew", "supervisor", "qa_qi", "compliance_officer", "biller", "it_admin", "read_only_auditor"];
const FIELD_LEVELS = ["mvo", "emt", "aemt", "paramedic"];
// A person can hold several roles. One is stored as their main role (shown first),
// the rest alongside it. Office responsibilities outrank "crew" for that purpose.
const ROLE_PRIORITY = ["supervisor", "it_admin", "qa_qi", "compliance_officer", "dispatcher", "biller", "read_only_auditor", "crew"];
function splitRoles(list) {
  const uniq = ROLE_PRIORITY.filter((r) => list.includes(r));
  return { role: uniq[0], extra: uniq.slice(1) };
}
// Turns what the form sent into a clean set of roles and a field level, or a plain-English problem.
function readRoles(body, { current } = {}) {
  let roles = Array.isArray(body.roles) ? body.roles : body.role !== undefined ? [body.role] : current?.roles;
  let level = body.fieldLevel !== undefined ? body.fieldLevel : current?.fieldLevel ?? null;
  if (!Array.isArray(roles) || roles.length === 0) fail(400, "Pick at least one role");
  for (const r of roles) if (!ROLES.includes(r)) fail(400, `Unknown role "${r}"`);
  if (level !== null && !FIELD_LEVELS.includes(level)) fail(400, "Field level must be MVO, EMT, AEMT or Paramedic");
  if (level && !roles.includes("crew")) roles = [...roles, "crew"];        // anyone with a field level works on a unit
  if (roles.includes("crew") && !level) fail(400, "Pick a field level (MVO, EMT, AEMT or Paramedic) for anyone who works on a unit");
  if (!roles.includes("crew")) level = null;
  return { roles, level, ...splitRoles(roles) };
}

const LEVELS = ["BLS", "ALS", "CCT"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
function handle(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  };
}

// ---- Address search (any signed-in user: dispatchers need it) ----------
const lastSearch = new Map();
router.get("/geocode", handle(async (req, res) => {
  if (!geocodingEnabled()) fail(503, "Address search is turned off on the server (set GEOCODE_ENABLED=true)");
  const q = String(req.query.q ?? "").trim();
  if (q.length < 3) fail(400, "Type at least 3 characters");
  const now = Date.now();
  if (now - (lastSearch.get(req.user.userId) ?? 0) < 1000) fail(429, "One search per second, please");
  lastSearch.set(req.user.userId, now);
  const near = { lat: parseFloat(req.query.lat), lon: parseFloat(req.query.lon) };
  res.json(await searchPlaces(q, near));
}));

// ---- People ---------------------------------------------------------------
// Staff lists get long. Search, filter and page on the server, and say how many there are in
// total in the X-Total-Count header (the body stays a plain array).
router.get("/users", ADMIN, handle(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const kind = ["field", "office"].includes(req.query.kind) ? req.query.kind : null;
  const status = ["active", "inactive"].includes(req.query.status) ? req.query.status : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const where = [], vals = [];
  if (q) { vals.push(`%${q.replace(/[%_\\]/g, "\\$&")}%`); where.push(`(u.display_name ILIKE $${vals.length} OR u.email ILIKE $${vals.length} OR cm.employee_number ILIKE $${vals.length})`); }
  if (kind === "field") where.push("cm.field_level IS NOT NULL");
  if (kind === "office") where.push("(u.role::text <> 'crew' OR EXISTS (SELECT 1 FROM unnest(u.extra_roles) r WHERE r::text <> 'crew'))");
  if (status) where.push(status === "active" ? "u.is_active" : "NOT u.is_active");
  const W = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const out = await withTenant(req.user.tenantId, async (c) => {
    const total = Number((await c.query(`SELECT count(*) AS n FROM users u LEFT JOIN crew_members cm ON cm.user_id = u.user_id ${W}`, vals)).rows[0].n);
    const rows = (await c.query(
      `SELECT u.user_id, u.email, u.display_name, u.role, u.extra_roles::text[] AS extra_roles, u.is_active, (u.mfa_enabled_at IS NOT NULL) AS mfa_enabled,
              cm.crew_member_id, cm.employee_number, cm.field_level,
              uca.unit_id, v.unit_designation, uca.seat_role
       FROM users u
       LEFT JOIN crew_members cm ON cm.user_id = u.user_id
       LEFT JOIN unit_crew_assignments uca ON uca.crew_member_id = cm.crew_member_id AND uca.assigned_to IS NULL
       LEFT JOIN units un ON un.unit_id = uca.unit_id
       LEFT JOIN vehicles v ON v.vehicle_id = un.vehicle_id
       ${W} ORDER BY u.display_name, u.user_id LIMIT ${limit} OFFSET ${offset}`, vals)).rows;
    return { rows, total };
  });
  res.set("X-Total-Count", String(out.total)).json(out.rows.map((r) => ({ ...r, roles: [r.role, ...r.extra_roles] })));
}));

// The people dispatchers can put on a unit: active field staff, with who they're already on.
router.get("/ops/roster", STAFFING, handle(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const onlyFree = req.query.unassigned === "1";
  const vals = [];
  let extra = "";
  if (q) { vals.push(`%${q.replace(/[%_\\]/g, "\\$&")}%`); extra += ` AND (cm.first_name || ' ' || cm.last_name ILIKE $${vals.length} OR cm.employee_number ILIKE $${vals.length})`; }
  if (onlyFree) extra += " AND uca.unit_id IS NULL";
  if (req.query.onDuty === "1") extra += " AND sh.shift_id IS NOT NULL";
  const rows = await withTenant(req.user.tenantId, async (c) => (await c.query(
    `SELECT cm.crew_member_id, cm.user_id, cm.first_name || ' ' || cm.last_name AS name, cm.employee_number, cm.field_level, uca.unit_id, uca.seat_role,
            (sh.shift_id IS NOT NULL) AS on_duty, sh.unit_id AS shift_unit_id, sv.unit_designation AS shift_unit, sh.ends_at AS shift_ends_at
     FROM crew_members cm JOIN users u ON u.user_id = cm.user_id AND u.is_active
     LEFT JOIN unit_crew_assignments uca ON uca.crew_member_id = cm.crew_member_id AND uca.assigned_to IS NULL
     LEFT JOIN LATERAL (SELECT * FROM shifts s WHERE s.crew_member_id = cm.crew_member_id AND s.starts_at <= now() AND s.ends_at > now() ORDER BY s.starts_at LIMIT 1) sh ON TRUE
     LEFT JOIN units su ON su.unit_id = sh.unit_id LEFT JOIN vehicles sv ON sv.vehicle_id = su.vehicle_id
     WHERE cm.is_active AND cm.field_level IS NOT NULL ${extra}
     ORDER BY cm.last_name, cm.first_name LIMIT 300`, vals)).rows);
  res.json(rows);
}));

router.post("/users", ADMIN, handle(async (req, res) => {
  const { email, displayName, password, employeeNumber } = req.body || {};
  const cleanEmail = String(email ?? "").trim().toLowerCase();
  const name = String(displayName ?? "").trim();
  if (!EMAIL_RE.test(cleanEmail)) fail(400, "Enter a valid email address");
  if (name.length < 2) fail(400, "Enter the person's full name");
  const { roles, level, role, extra } = readRoles(req.body || {});
  const problem = passwordProblem(password);
  if (problem) fail(400, problem);
  const [first, ...rest] = name.split(/\s+/);
  const hash = await hashPassword(password);
  try {
    const created = await withTenant(req.user.tenantId, async (c) => {
      const taken = (await c.query("SELECT email_in_use($1, NULL) AS used", [cleanEmail])).rows[0].used;
      if (taken) fail(409, "That email is already used by an account");
      const u = (await c.query(
        `INSERT INTO users (tenant_id, email, display_name, role, extra_roles, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING user_id, email, display_name, role, extra_roles::text[] AS extra_roles, is_active`,
        [req.user.tenantId, cleanEmail, name, role, extra, hash]
      )).rows[0];
      // Every person is also a crew-member record so they can hold certifications
      // and, if they work on a unit, be put on one.
      const cm = (await c.query(
        `INSERT INTO crew_members (tenant_id, user_id, first_name, last_name, employee_number, field_level)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING crew_member_id`,
        [req.user.tenantId, u.user_id, first, rest.join(" ") || "-", employeeNumber ? String(employeeNumber).trim() : null, level]
      )).rows[0];
      return { ...u, roles, field_level: level, crew_member_id: cm.crew_member_id };
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === "23505") fail(409, "That email is already used by an account");
    throw err;
  }
}));

router.patch("/users/:id", ADMIN, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad user id");
  const b = req.body || {};
  const touchesRoles = b.roles !== undefined || b.role !== undefined || b.fieldLevel !== undefined;
  if (req.params.id === req.user.userId && (b.isActive === false || touchesRoles)) {
    fail(400, "You can't deactivate or change the roles of your own account");
  }
  let hash;
  if (b.password !== undefined) {
    const problem = passwordProblem(b.password);
    if (problem) fail(400, problem);
    hash = await hashPassword(b.password);
  }
  const out = await withTenant(req.user.tenantId, async (c) => {
    const cur = (await c.query(
      `SELECT u.user_id, u.role, u.extra_roles::text[] AS extra_roles, cm.field_level FROM users u LEFT JOIN crew_members cm ON cm.user_id = u.user_id WHERE u.user_id = $1`,
      [req.params.id])).rows[0];
    if (!cur) return null;
    const sets = [], vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.displayName !== undefined) { if (String(b.displayName).trim().length < 2) fail(400, "Enter the person's full name"); add("display_name", String(b.displayName).trim()); }
    if (b.email !== undefined) {
      const email = String(b.email).trim().toLowerCase();
      if (!EMAIL_RE.test(email)) fail(400, "Enter a valid email address");
      const taken = (await c.query("SELECT email_in_use($1, $2) AS used", [email, req.params.id])).rows[0].used;
      if (taken) fail(409, "That email is already used by another account");
      add("email", email);
    }
    let newLevel;
    if (touchesRoles) {
      const r = readRoles(b, { current: { roles: [cur.role, ...cur.extra_roles], fieldLevel: cur.field_level } });
      add("role", r.role); add("extra_roles", r.extra);
      newLevel = r.level;
      // Taking someone off the field takes them off their unit.
      if (!r.level) {
        await c.query("UPDATE unit_crew_assignments SET assigned_to = now() WHERE assigned_to IS NULL AND crew_member_id IN (SELECT crew_member_id FROM crew_members WHERE user_id = $1)", [req.params.id]);
      }
    }
    if (b.isActive !== undefined) add("is_active", Boolean(b.isActive));
    if (hash) { add("password_hash", hash); sets.push("failed_logins = 0", "locked_until = NULL"); }
    if (b.resetMfa) sets.push("totp_secret_enc = NULL", "mfa_enabled_at = NULL", "mfa_last_step = 0", "recovery_hashes = '{}'");
    if (sets.length) { vals.push(req.params.id); await c.query(`UPDATE users SET ${sets.join(", ")} WHERE user_id = $${vals.length}`, vals); }
    if (newLevel !== undefined) await c.query("UPDATE crew_members SET field_level = $1 WHERE user_id = $2", [newLevel, req.params.id]);
    if (b.displayName !== undefined) {
      const [first, ...rest] = String(b.displayName).trim().split(/\s+/);
      await c.query("UPDATE crew_members SET first_name = $1, last_name = $2 WHERE user_id = $3", [first, rest.join(" ") || "-", req.params.id]);
    }
    if (b.employeeNumber !== undefined) await c.query("UPDATE crew_members SET employee_number = $1 WHERE user_id = $2", [String(b.employeeNumber).trim() || null, req.params.id]);
    if (b.isActive === false) {
      await c.query(
        `UPDATE unit_crew_assignments SET assigned_to = now()
         WHERE assigned_to IS NULL AND crew_member_id IN (SELECT crew_member_id FROM crew_members WHERE user_id = $1)`, [req.params.id]);
      await c.query("UPDATE crew_members SET is_active = FALSE WHERE user_id = $1", [req.params.id]);
    } else if (b.isActive === true) {
      await c.query("UPDATE crew_members SET is_active = TRUE WHERE user_id = $1", [req.params.id]);
    }
    const row = (await c.query(
      `SELECT u.user_id, u.email, u.display_name, u.role, u.extra_roles::text[] AS extra_roles, u.is_active, cm.field_level
       FROM users u LEFT JOIN crew_members cm ON cm.user_id = u.user_id WHERE u.user_id = $1`, [req.params.id])).rows[0];
    return { ...row, roles: [row.role, ...row.extra_roles] };
  });
  if (!out) fail(404, "User not found");
  res.json(out);
}));

// ---- Units --------------------------------------------------------------
router.post("/units", ADMIN, handle(async (req, res) => {
  const designation = String(req.body?.designation ?? "").trim();
  const level = String(req.body?.capabilityLevel ?? "").toUpperCase();
  if (!designation) fail(400, "Give the unit a name, like Medic 4");
  if (!LEVELS.includes(level)) fail(400, "Level must be BLS, ALS or CCT");
  const unit = await withTenant(req.user.tenantId, async (c) => {
    const dup = await c.query("SELECT 1 FROM vehicles WHERE lower(unit_designation) = lower($1) AND archived_at IS NULL", [designation]);
    if (dup.rows.length) fail(409, `A unit named "${designation}" already exists`);
    const v = (await c.query(
      "INSERT INTO vehicles (tenant_id, unit_designation, capability_level) VALUES ($1, $2, $3) RETURNING vehicle_id",
      [req.user.tenantId, designation, level]
    )).rows[0];
    // Starts out of service: a unit with nobody on it can't take a call.
    // Putting someone on it (below) makes it available.
    return (await c.query(
      "INSERT INTO units (tenant_id, vehicle_id, current_status) VALUES ($1, $2, 'out_of_service') RETURNING unit_id",
      [req.user.tenantId, v.vehicle_id]
    )).rows[0];
  });
  res.status(201).json({ unit_id: unit.unit_id, unit_designation: designation, capability_level: level });
}));

// Rename a unit, or change its level (BLS/ALS/CCT). Changing the level of a unit that has a crew
// or is on a call is refused: its crew requirements would change under it.
router.patch("/units/:id", ADMIN, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad unit id");
  const b = req.body || {};
  const designation = b.designation === undefined ? null : String(b.designation).trim();
  const level = b.capabilityLevel === undefined ? null : String(b.capabilityLevel).toUpperCase();
  if (designation !== null && !designation) fail(400, "Give the unit a name, like Medic 4");
  if (level !== null && !LEVELS.includes(level)) fail(400, "Level must be BLS, ALS or CCT");
  if (designation === null && level === null) fail(400, "Nothing to change");
  const out = await withTenant(req.user.tenantId, async (c) => {
    const u = (await c.query(
      `SELECT un.unit_id, un.current_status, v.vehicle_id, v.unit_designation, v.capability_level
       FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE un.unit_id = $1 AND v.archived_at IS NULL`, [req.params.id])).rows[0];
    if (!u) fail(404, "Unit not found");
    if (designation !== null && designation.toLowerCase() !== u.unit_designation.toLowerCase()) {
      const dup = await c.query("SELECT 1 FROM vehicles WHERE lower(unit_designation) = lower($1) AND archived_at IS NULL AND vehicle_id <> $2", [designation, u.vehicle_id]);
      if (dup.rows.length) fail(409, `A unit named "${designation}" already exists`);
    }
    if (level !== null && level !== u.capability_level) {
      const crew = Number((await c.query("SELECT count(*) AS n FROM unit_crew_assignments WHERE unit_id = $1 AND assigned_to IS NULL", [req.params.id])).rows[0].n);
      const onCall = (await c.query("SELECT 1 FROM incident_unit_assignments WHERE unit_id = $1 AND unassigned_at IS NULL", [req.params.id])).rows.length > 0;
      if (crew > 0 || onCall) fail(409, "Take the crew off this unit (and finish its call) before changing its level.");
    }
    await c.query("UPDATE vehicles SET unit_designation = COALESCE($1, unit_designation), capability_level = COALESCE($2, capability_level) WHERE vehicle_id = $3", [designation, level, u.vehicle_id]);
    return { unit_id: u.unit_id, unit_designation: designation ?? u.unit_designation, capability_level: level ?? u.capability_level };
  });
  res.json(out);
}));

// Delete a unit. One with no history is removed outright; one that has worked calls is RETIRED
// (hidden from every list, history kept). Either way it can't have a crew on it or be on a call.
router.delete("/units/:id", ADMIN, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad unit id");
  const out = await withTenant(req.user.tenantId, async (c) => {
    const u = (await c.query("SELECT un.unit_id, un.vehicle_id, v.unit_designation FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE un.unit_id = $1 AND v.archived_at IS NULL", [req.params.id])).rows[0];
    if (!u) fail(404, "Unit not found");
    if ((await c.query("SELECT 1 FROM incident_unit_assignments WHERE unit_id = $1 AND unassigned_at IS NULL", [req.params.id])).rows.length) fail(409, `${u.unit_designation} is on a call. Finish or release the call first.`);
    if ((await c.query("SELECT 1 FROM unit_crew_assignments WHERE unit_id = $1 AND assigned_to IS NULL", [req.params.id])).rows.length) fail(409, `${u.unit_designation} has a crew on it. Take them off in OPS first.`);
    await c.query("SAVEPOINT remove_unit");
    try {
      await c.query("DELETE FROM unit_crew_assignments WHERE unit_id = $1", [req.params.id]);   // ended crew assignments only (none are open)
      await c.query("DELETE FROM units WHERE unit_id = $1", [req.params.id]);
      await c.query("DELETE FROM vehicles WHERE vehicle_id = $1", [u.vehicle_id]);
      return { removed: true, retired: false };
    } catch (err) {
      if (err.code !== "23503" && err.code !== "42501") throw err;                              // history exists (or is protected): retire instead
      await c.query("ROLLBACK TO SAVEPOINT remove_unit");
      await c.query("UPDATE vehicles SET archived_at = now(), is_in_service = FALSE WHERE vehicle_id = $1", [u.vehicle_id]);
      await c.query("UPDATE units SET current_status = 'out_of_service' WHERE unit_id = $1", [req.params.id]);
      return { removed: true, retired: true };
    }
  });
  res.json(out);
}));

// The truck a unit is driving. OPS can assign one, or swap it mid-shift when there's a mechanical
// problem or an accident, so the unit stays in service. Changing from one vehicle to another needs a
// reason, and every change is kept. A vehicle number can be on only one active unit at a time.
router.put("/units/:id/vehicle", STAFFING, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad unit id");
  const number = req.body?.vehicleNumber === null ? null : String(req.body?.vehicleNumber ?? "").trim().slice(0, 40);
  const reason = String(req.body?.reason ?? "").trim().slice(0, 300);
  if (number === "") fail(400, "Enter the vehicle number, like 214");
  const out = await withTenant(req.user.tenantId, async (c) => {
    const u = (await c.query("SELECT un.unit_id, un.vehicle_number, v.unit_designation FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE un.unit_id = $1 AND v.archived_at IS NULL FOR UPDATE OF un", [req.params.id])).rows[0];
    if (!u) fail(404, "Unit not found");
    if ((u.vehicle_number ?? null) === number) return { unit_id: u.unit_id, vehicle_number: number, unchanged: true };
    if (u.vehicle_number && reason.length < 3) fail(400, "Say why the vehicle is being changed (for example: mechanical issue, accident).");
    if (number) {
      const taken = (await c.query(
        "SELECT v.unit_designation FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE lower(un.vehicle_number) = lower($1) AND un.unit_id <> $2 AND v.archived_at IS NULL", [number, req.params.id])).rows[0];
      if (taken) fail(409, `Vehicle ${number} is already on ${taken.unit_designation}. Move it off that unit first.`);
    }
    await c.query("UPDATE units SET vehicle_number = $1 WHERE unit_id = $2", [number, req.params.id]);
    await c.query(
      "INSERT INTO unit_vehicle_history (tenant_id, unit_id, vehicle_number, previous_vehicle_number, reason, changed_by_user_id) VALUES ($1, $2, $3, $4, $5, $6)",
      [req.user.tenantId, req.params.id, number, u.vehicle_number, reason || null, req.user.userId]);
    return { unit_id: u.unit_id, vehicle_number: number, previous_vehicle_number: u.vehicle_number };
  });
  res.json(out);
}));

router.get("/units/:id/vehicle-history", STAFFING, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad unit id");
  const rows = await withTenant(req.user.tenantId, async (c) => (await c.query(
    `SELECT h.vehicle_number, h.previous_vehicle_number, h.reason, h.changed_at, u.display_name AS changed_by
     FROM unit_vehicle_history h LEFT JOIN users u ON u.user_id = h.changed_by_user_id WHERE h.unit_id = $1 ORDER BY h.history_id DESC LIMIT 50`, [req.params.id])).rows);
  res.json(rows);
}));

// Put a person on a unit (or take them off with unitId: null). One unit at a time
// per person. This is what tells the Field Unit screen which unit a signed-in crew
// member is on, and what lets that person report its GPS.
//
// A unit goes into service when it has a crew, and an ALS or CCT unit also needs a
// paramedic on it. It goes back out of service when that stops being true, unless
// it's in the middle of a call.
router.put("/crew/:crewMemberId/unit", STAFFING, handle(async (req, res) => {
  const { unitId, seatRole } = req.body || {};
  if (!UUID_RE.test(req.params.crewMemberId)) fail(400, "Bad crew member id");
  if (unitId !== null && !UUID_RE.test(String(unitId))) fail(400, "Pick a unit");
  const warning = await withTenant(req.user.tenantId, (c) => placeCrewMember(c, req.user.tenantId, req.params.crewMemberId, unitId, seatRole));
  res.json({ ok: true, ...(warning ? { warning } : {}) });
}));

// Puts one person on one unit (or takes them off with unitId null), enforcing every crewing rule, inside
// the caller's transaction. Used by the OPS board and by "crew units as scheduled". Throws an HttpError
// with plain words when a rule is broken; returns a warning string when it worked but the unit still can't
// go in service.
export async function placeCrewMember(c, tenantId, crewMemberId, unitId, seatRole) {
  let seat = seatRole === "driver" ? "driver" : "non_driver";
  let warning = null;
  const cm = (await c.query("SELECT first_name, last_name, field_level FROM crew_members WHERE crew_member_id = $1 AND is_active", [crewMemberId])).rows[0];
  if (!cm) fail(404, "Person not found, or deactivated");
  const who = `${cm.first_name} ${cm.last_name}`.trim();

  const freed = (await c.query(
    "UPDATE unit_crew_assignments SET assigned_to = now() WHERE crew_member_id = $1 AND assigned_to IS NULL RETURNING unit_id",
    [crewMemberId]
  )).rows.map((r) => r.unit_id);

  if (unitId) {
    if (!cm.field_level) fail(409, `${who} doesn't work in the field. Give them a field level (MVO, EMT, AEMT or Paramedic) first.`);
    if (cm.field_level === "mvo") seat = "driver";                       // an MVO always drives
    const unit = (await c.query(
      `SELECT un.unit_id, v.capability_level, v.unit_designation
       FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE un.unit_id = $1`, [unitId]
    )).rows[0];
    if (!unit) fail(404, "Unit not found");
    if (unit.capability_level === "ALS" && cm.field_level === "paramedic") {
      const cert = await c.query(
        `SELECT 1 FROM certifications ce JOIN certification_types ct ON ct.certification_type_id = ce.certification_type_id
         WHERE ce.crew_member_id = $1 AND ct.required_for_capability = 'ALS' AND ce.expires_on >= CURRENT_DATE`,
        [crewMemberId]
      );
      if (!cert.rows.length) fail(409, `${who} is a paramedic with no current ALS-level certification, so can't be put on ${unit.unit_designation}. Add their certification first.`);
    }
    const size = Number((await c.query("SELECT count(*) AS n FROM unit_crew_assignments WHERE unit_id = $1 AND assigned_to IS NULL", [unitId])).rows[0].n);
    if (size >= MAX_CREW) fail(409, `${unit.unit_designation} already has ${MAX_CREW} crew. Take someone off first.`);
    if (seat === "driver") {
      const d = (await c.query(
        `SELECT cm.first_name, cm.last_name FROM unit_crew_assignments uca JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
         WHERE uca.unit_id = $1 AND uca.seat_role = 'driver' AND uca.assigned_to IS NULL`, [unitId]
      )).rows[0];
      if (d) fail(409, `${unit.unit_designation} already has a driver (${d.first_name} ${d.last_name}). Move them first.`);
    }
    await c.query(
      "INSERT INTO unit_crew_assignments (tenant_id, unit_id, crew_member_id, seat_role) VALUES ($1, $2, $3, $4)",
      [tenantId, unitId, crewMemberId, seat]
    );
  }
  for (const id of new Set([...freed, ...(unitId ? [unitId] : [])])) {
    const w = await reconcileUnit(c, tenantId, id);
    if (w && id === unitId) warning = w;
  }
  return warning;
}

// Change just the seat (driver / non-driver) of someone already on a unit.
router.patch("/crew/:crewMemberId/seat", STAFFING, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.crewMemberId)) fail(400, "Bad crew member id");
  const seat = req.body?.seatRole === "driver" ? "driver" : req.body?.seatRole === "non_driver" ? "non_driver" : null;
  if (!seat) fail(400, "Seat must be driver or non_driver");
  let warning = null;
  await withTenant(req.user.tenantId, async (c) => {
    const row = (await c.query(
      `SELECT uca.assignment_id, uca.unit_id, uca.seat_role, cm.field_level, cm.first_name, cm.last_name
       FROM unit_crew_assignments uca JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
       WHERE uca.crew_member_id = $1 AND uca.assigned_to IS NULL`, [req.params.crewMemberId])).rows[0];
    if (!row) fail(404, "That person isn't on a unit");
    if (row.field_level === "mvo" && seat !== "driver") fail(409, "An MVO always drives.");
    if (seat === "driver") {
      const d = (await c.query(
        `SELECT cm.first_name, cm.last_name FROM unit_crew_assignments uca JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
         WHERE uca.unit_id = $1 AND uca.seat_role = 'driver' AND uca.assigned_to IS NULL AND uca.crew_member_id <> $2`, [row.unit_id, req.params.crewMemberId])).rows[0];
      if (d) fail(409, `That unit already has a driver (${d.first_name} ${d.last_name}). Make them non-driver first.`);
    }
    await c.query("UPDATE unit_crew_assignments SET seat_role = $1 WHERE assignment_id = $2", [seat, row.assignment_id]);
    warning = await reconcileUnit(c, req.user.tenantId, row.unit_id);
  });
  res.json({ ok: true, ...(warning ? { warning } : {}) });
}));

// Decides whether an idle unit should be in or out of service from who is on it.
// A unit can take calls when it has a driver, someone who can treat (EMT or above), and, if it's
// an ALS or CCT unit, a paramedic. (A mid-call unit is left alone.)
async function reconcileUnit(c, tenantId, unitId) {
  const u = (await c.query(
    `SELECT un.current_status, v.capability_level, v.unit_designation FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE un.unit_id = $1`, [unitId])).rows[0];
  if (!u || !["available", "out_of_service"].includes(u.current_status)) return null;   // mid-call: leave it alone
  const crew = (await c.query(
    `SELECT count(*) AS n,
            count(*) FILTER (WHERE uca.seat_role = 'driver') AS drivers,
            count(*) FILTER (WHERE cm.field_level IN ('emt', 'aemt', 'paramedic')) AS clinical,
            count(*) FILTER (WHERE cm.field_level = 'paramedic') AS medics
     FROM unit_crew_assignments uca JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
     WHERE uca.unit_id = $1 AND uca.assigned_to IS NULL`, [unitId])).rows[0];
  const missing = [];
  if (Number(crew.drivers) === 0) missing.push("a driver");
  if (Number(crew.clinical) === 0) missing.push("an EMT or above");
  if (u.capability_level !== "BLS" && Number(crew.medics) === 0) missing.push("a paramedic");
  const ready = Number(crew.n) > 0 && missing.length === 0;
  const want = ready ? "available" : "out_of_service";
  if (want !== u.current_status) await setStatus(c, tenantId, unitId, want);
  return Number(crew.n) > 0 && !ready ? `${u.unit_designation} stays out of service until it has ${missing.join(" and ")}.` : null;
}

async function setStatus(c, tenantId, unitId, status) {
  await c.query("UPDATE units SET current_status = $1 WHERE unit_id = $2", [status, unitId]);
  await c.query("INSERT INTO unit_status_history (tenant_id, unit_id, status) VALUES ($1, $2, $3)", [tenantId, unitId, status]);
}

// ---- Certifications & vehicle inspections (the Compliance screen's data) --
router.get("/certification-types", handle(async (req, res) => {
  const rows = await withTenant(req.user.tenantId, async (c) =>
    (await c.query("SELECT certification_type_id, code, label, required_for_capability FROM certification_types ORDER BY code")).rows);
  res.json(rows);
}));

router.post("/certification-types", ADMIN, handle(async (req, res) => {
  const code = String(req.body?.code ?? "").trim();
  const label = String(req.body?.label ?? "").trim();
  const cap = req.body?.requiredForCapability ? String(req.body.requiredForCapability).toUpperCase() : null;
  if (!code || !label) fail(400, "Give the certification a short code and a name");
  if (cap && !LEVELS.includes(cap)) fail(400, "Capability must be BLS, ALS, CCT or blank");
  try {
    const row = await withTenant(req.user.tenantId, async (c) => (await c.query(
      "INSERT INTO certification_types (tenant_id, code, label, required_for_capability) VALUES ($1, $2, $3, $4) RETURNING *",
      [req.user.tenantId, code, label, cap]
    )).rows[0]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === "23505") fail(409, `A certification with code "${code}" already exists`);
    throw err;
  }
}));

router.post("/certifications", ADMIN, handle(async (req, res) => {
  const { crewMemberId, certificationTypeId, issuingBody, certificateNumber, issuedOn, expiresOn } = req.body || {};
  if (!UUID_RE.test(String(crewMemberId ?? "")) || !UUID_RE.test(String(certificationTypeId ?? ""))) fail(400, "Pick a person and a certification type");
  if (!DATE_RE.test(String(issuedOn ?? "")) || !DATE_RE.test(String(expiresOn ?? ""))) fail(400, "Dates must look like 2027-03-31");
  if (expiresOn <= issuedOn) fail(400, "The expiry date must be after the issue date");
  const body = String(issuingBody ?? "").trim();
  if (!body) fail(400, "Who issued it? (for example the state EMS office)");
  const row = await withTenant(req.user.tenantId, async (c) => (await c.query(
    `INSERT INTO certifications (tenant_id, crew_member_id, certification_type_id, issuing_body, certificate_number, issued_on, expires_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING certification_id`,
    [req.user.tenantId, crewMemberId, certificationTypeId, body, certificateNumber ? String(certificateNumber).trim() : null, issuedOn, expiresOn]
  )).rows[0]);
  res.status(201).json(row);
}));

router.delete("/certifications/:id", ADMIN, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad id");
  const r = await withTenant(req.user.tenantId, (c) => c.query("DELETE FROM certifications WHERE certification_id = $1 RETURNING certification_id", [req.params.id]));
  if (!r.rows.length) fail(404, "Certification not found");
  res.json({ ok: true });
}));

router.patch("/vehicles/:id", ADMIN, handle(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) fail(400, "Bad vehicle id");
  const { lastInspectionDate, nextInspectionDue } = req.body || {};
  for (const d of [lastInspectionDate, nextInspectionDue]) if (d && !DATE_RE.test(String(d))) fail(400, "Dates must look like 2027-03-31");
  const r = await withTenant(req.user.tenantId, (c) => c.query(
    `UPDATE vehicles SET last_inspection_date = COALESCE($1, last_inspection_date), next_inspection_due = COALESCE($2, next_inspection_due)
     WHERE vehicle_id = $3 RETURNING vehicle_id`,
    [lastInspectionDate || null, nextInspectionDue || null, req.params.id]
  ));
  if (!r.rows.length) fail(404, "Vehicle not found");
  res.json({ ok: true });
}));

export default router;
