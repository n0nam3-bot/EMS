// backend_routes_auth.js
// -----------------------------------------------------------------------
// Sign-in. Mounted BEFORE the other routers because they all demand a
// session; login is the one thing that can't.
//
// A login names a person, the person belongs to exactly one company, and
// the session token carries both. Every later request is then locked to
// that company by the database (row-level security), not by this code.
// -----------------------------------------------------------------------

import express from "express";
import pool, { withTenant } from "./backend_db.js";
import { requireAuth, signSession } from "./backend_auth.js";
import { hashPassword, verifyPassword, passwordProblem } from "./backend_passwords.js";

const router = express.Router();

// Same words for every failure that could reveal whether an account exists.
const WRONG = { error: "Incorrect email or password" };

async function record(tenantId, userId, action, detail = {}) {
  try {
    await withTenant(tenantId, (c) => c.query(
      `INSERT INTO audit_log (tenant_id, actor_user_id, action, table_name, record_id, detail)
       VALUES ($1, $2, $3, 'users', $2, $4)`,
      [tenantId, userId, action, JSON.stringify(detail)]
    ));
  } catch (err) {
    console.error("could not record", action, err.message);
  }
}

router.post("/auth/login", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  if (!email || !password) return res.status(400).json({ error: "Enter your email and password" });

  const row = (await pool.query("SELECT * FROM auth_find_user($1)", [email])).rows[0];
  const passwordOk = await verifyPassword(password, row?.password_hash);
  const locked = Boolean(row?.locked_until && new Date(row.locked_until) > new Date());

  if (row && locked) {
    return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  }
  if (!row || !passwordOk) {
    if (row) {
      await pool.query("SELECT auth_record_login($1, false)", [row.user_id]);
      await record(row.tenant_id, row.user_id, "login_failed");
    }
    return res.status(401).json(WRONG);
  }
  if (!row.is_active || !row.tenant_active) {
    await record(row.tenant_id, row.user_id, "login_denied", { reason: row.is_active ? "agency suspended" : "user deactivated" });
    return res.status(401).json(WRONG);
  }

  let session;
  try {
    session = signSession({ userId: row.user_id, tenantId: row.tenant_id });
  } catch (err) {
    console.error(err.message);
    return res.status(503).json({ error: "Sign-in isn't set up on the server yet (SESSION_SECRET)." });
  }
  await pool.query("SELECT auth_record_login($1, true)", [row.user_id]);
  await record(row.tenant_id, row.user_id, "login");

  const who = await withTenant(row.tenant_id, async (c) =>
    (await c.query(
      `SELECT u.user_id, u.email, u.display_name, u.role, t.display_name AS agency
       FROM users u JOIN tenants t ON t.tenant_id = u.tenant_id WHERE u.user_id = $1`,
      [row.user_id]
    )).rows[0]
  );
  res.json({
    ...session,
    user: { id: who.user_id, email: who.email, name: who.display_name, role: who.role },
    agency: who.agency,
  });
});

// Who am I, which unit am I crewing, and what call is that unit on.
// The Field Unit screen is driven entirely by this — nobody types a unit ID.
router.get("/auth/me", requireAuth, async (req, res) => {
  const out = await withTenant(req.user.tenantId, async (c) => {
    const who = (await c.query(
      `SELECT u.user_id, u.email, u.display_name, u.role, t.display_name AS agency
       FROM users u JOIN tenants t ON t.tenant_id = u.tenant_id WHERE u.user_id = $1`,
      [req.user.userId]
    )).rows[0];
    const unit = (await c.query(
      `SELECT un.unit_id, v.unit_designation, v.capability_level, un.current_status, uca.seat_role
       FROM crew_members cm
       JOIN unit_crew_assignments uca ON uca.crew_member_id = cm.crew_member_id AND uca.assigned_to IS NULL
       JOIN units un ON un.unit_id = uca.unit_id
       JOIN vehicles v ON v.vehicle_id = un.vehicle_id
       WHERE cm.user_id = $1 AND cm.is_active
       LIMIT 1`,
      [req.user.userId]
    )).rows[0] || null;
    let incident = null;
    if (unit) {
      incident = (await c.query(
        `SELECT i.incident_id, i.incident_type, i.priority, i.scene_address, i.scene_detail,
                i.destination_text, i.contact_name, i.contact_phone, i.patient_name, i.notes, i.capability_needed,
                ST_Y(i.scene_location::geometry) AS lat, ST_X(i.scene_location::geometry) AS lon,
                ST_Y(i.destination_location::geometry) AS dest_lat, ST_X(i.destination_location::geometry) AS dest_lon,
                iua.role
         FROM incident_unit_assignments iua
         JOIN incidents i ON i.incident_id = iua.incident_id
         WHERE iua.unit_id = $1 AND iua.unassigned_at IS NULL AND i.closed_at IS NULL
         ORDER BY iua.assigned_at DESC LIMIT 1`,
        [unit.unit_id]
      )).rows[0] || null;
    }
    return { who, unit, incident };
  });
  res.json({
    user: { id: out.who.user_id, email: out.who.email, name: out.who.display_name, role: out.who.role },
    agency: out.who.agency,
    unit: out.unit,
    incident: out.incident,
  });
});

router.post("/auth/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const problem = passwordProblem(newPassword);
  if (problem) return res.status(400).json({ error: problem });
  const ok = await withTenant(req.user.tenantId, async (c) => {
    const row = (await c.query("SELECT password_hash FROM users WHERE user_id = $1", [req.user.userId])).rows[0];
    if (!(await verifyPassword(String(currentPassword ?? ""), row?.password_hash))) return false;
    await c.query("UPDATE users SET password_hash = $1 WHERE user_id = $2", [await hashPassword(newPassword), req.user.userId]);
    return true;
  });
  if (!ok) return res.status(400).json({ error: "Current password is incorrect" });
  res.json({ ok: true });
});

export default router;
