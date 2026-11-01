// backend_routes_auth.js
// -----------------------------------------------------------------------
// Sign-in, in two steps, for company staff and for platform administrators.
//
//   1. POST /auth/login          email + password  ->  a short pass (a "challenge")
//   2. POST /auth/mfa/verify     pass + 6-digit code  ->  the real session
//      (first time only: /auth/mfa/setup, then /auth/mfa/enable shows the
//       authenticator secret, checks a code, and hands out recovery codes)
//
// Mounted BEFORE the other routers because they all demand a session.
// A session names a person and one company; every later request is locked
// to that company by the database (row-level security), not by this code.
// -----------------------------------------------------------------------

import express from "express";
import pool, { withTenant } from "./backend_db.js";
import { requireAuth, signSession, signChallenge, verifyChallenge, signPlatformSession } from "./backend_auth.js";
import { hashPassword, verifyPassword, passwordProblem } from "./backend_passwords.js";
import { newSecret, otpauthUrl, verifyTotp, encryptSecret, decryptSecret, newRecoveryCodes, consumeRecovery } from "./backend_mfa.js";

const router = express.Router();
const WRONG = { error: "Incorrect email or password" };      // same words for every account-revealing failure
const BAD_CODE = { error: "That code isn't right. Check your authenticator app and try again." };
const EXPIRED = { error: "That sign-in took too long. Please start again." };
const ISSUER = "EMS Dispatch";

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

// ---- who is signing in: a company user, or a platform admin -------------------
async function findByEmail(email) {
  const t = (await pool.query("SELECT * FROM auth_find_user($1)", [email])).rows[0];
  if (t) return { kind: "tenant", id: t.user_id, tenantId: t.tenant_id, row: t, active: t.is_active && t.tenant_active };
  const a = (await pool.query("SELECT * FROM platform_find_admin($1)", [email])).rows[0];
  if (a) return { kind: "platform", id: a.admin_id, tenantId: null, row: a, active: a.is_active };
  return null;
}
async function findById(kind, id, tenantId) {
  if (kind === "platform") {
    const a = (await pool.query("SELECT * FROM platform_get_admin($1)", [id])).rows[0];
    return a ? { kind, id, tenantId: null, row: a, active: a.is_active } : null;
  }
  const row = await withTenant(tenantId, async (c) => (await c.query(
    `SELECT u.user_id, u.tenant_id, u.email, u.display_name, u.password_hash, u.role, u.extra_roles::text[] AS extra_roles, u.is_active, u.locked_until,
            u.mfa_enabled_at, u.totp_secret_enc, u.mfa_last_step, u.recovery_hashes, t.is_active AS tenant_active
     FROM users u JOIN tenants t ON t.tenant_id = u.tenant_id WHERE u.user_id = $1`, [id])).rows[0]);
  return row ? { kind, id, tenantId, row, active: row.is_active && row.tenant_active } : null;
}
const recordLogin = (s, ok) => s.kind === "platform"
  ? pool.query("SELECT platform_record_login($1, $2)", [s.id, ok])
  : pool.query("SELECT auth_record_login($1, $2)", [s.id, ok]);
const isLocked = (s) => Boolean(s.row.locked_until && new Date(s.row.locked_until) > new Date());

async function saveMfa(s, { secretEnc = null, enable = false, lastStep = null, recovery = null }) {
  if (s.kind === "platform") {
    await pool.query("SELECT platform_save_mfa($1, $2, $3, $4, $5)", [s.id, secretEnc, enable, lastStep, recovery]);
  } else {
    await withTenant(s.tenantId, (c) => c.query(
      `UPDATE users SET totp_secret_enc = COALESCE($2, totp_secret_enc),
              mfa_enabled_at = CASE WHEN $3 THEN now() ELSE mfa_enabled_at END,
              mfa_last_step = COALESCE($4, mfa_last_step), recovery_hashes = COALESCE($5, recovery_hashes)
       WHERE user_id = $1`, [s.id, secretEnc, enable, lastStep, recovery]));
  }
}

// ---- finishing a sign-in: only here does anyone get a session -------------------
async function issueSession(s) {
  await recordLogin(s, true);
  if (s.kind === "platform") {
    return { kind: "platform", ...signPlatformSession(s.id), user: { id: s.id, email: s.row.email, name: s.row.display_name } };
  }
  await record(s.tenantId, s.id, "login");
  const who = await withTenant(s.tenantId, async (c) => (await c.query(
    `SELECT u.user_id, u.email, u.display_name, u.role, u.extra_roles::text[] AS extra_roles, cm.field_level, t.display_name AS agency
     FROM users u JOIN tenants t ON t.tenant_id = u.tenant_id LEFT JOIN crew_members cm ON cm.user_id = u.user_id
     WHERE u.user_id = $1`, [s.id])).rows[0]);
  return {
    kind: "tenant",
    ...signSession({ userId: s.id, tenantId: s.tenantId }),
    user: { id: who.user_id, email: who.email, name: who.display_name, role: who.role, roles: [who.role, ...who.extra_roles], fieldLevel: who.field_level || null },
    agency: who.agency,
  };
}

function challengeOf(req, kind) {
  const p = verifyChallenge(req.body?.challenge, kind);
  return p ? { kind: p.tenant_id ? "tenant" : "platform", id: p.sub, tenantId: p.tenant_id || null } : null;
}

// Step 1
router.post("/auth/login", async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  if (!email || !password) return res.status(400).json({ error: "Enter your email and password" });

  const subject = await findByEmail(email);
  const passwordOk = await verifyPassword(password, subject?.row.password_hash);
  if (subject && isLocked(subject)) return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  if (!subject || !passwordOk) {
    if (subject) {
      await recordLogin(subject, false);
      if (subject.kind === "tenant") await record(subject.tenantId, subject.id, "login_failed");
    }
    return res.status(401).json(WRONG);
  }
  if (!subject.active) {
    if (subject.kind === "tenant") await record(subject.tenantId, subject.id, "login_denied", { reason: subject.row.is_active ? "agency suspended" : "user deactivated" });
    return res.status(401).json(WRONG);
  }
  try {
    const enrolled = Boolean(subject.row.mfa_enabled_at);
    const claims = { sub: subject.id, tenantId: subject.tenantId };
    res.json(enrolled
      ? { step: "mfa", challenge: signChallenge("mfa", claims, 5) }
      : { step: "mfa_setup", challenge: signChallenge("mfa_setup", claims, 15) });
  } catch (err) {
    console.error(err.message);
    res.status(503).json({ error: "Sign-in isn't set up on the server yet (SESSION_SECRET)." });
  }
});

// First time only: create the secret, show it to be scanned or typed into an authenticator app.
router.post("/auth/mfa/setup", async (req, res) => {
  const c = challengeOf(req, "mfa_setup");
  if (!c) return res.status(401).json(EXPIRED);
  const s = await findById(c.kind, c.id, c.tenantId);
  if (!s || !s.active) return res.status(401).json(EXPIRED);
  if (s.row.mfa_enabled_at) return res.status(409).json({ error: "Two-step sign-in is already set up. Sign in again." });
  const secret = newSecret();
  await saveMfa(s, { secretEnc: encryptSecret(secret) });
  res.json({ secret, otpauthUrl: otpauthUrl({ issuer: ISSUER, account: s.row.email, secret }) });
});

// ...then prove it works by entering the first code. Success turns it on and signs in.
router.post("/auth/mfa/enable", async (req, res) => {
  const c = challengeOf(req, "mfa_setup");
  if (!c) return res.status(401).json(EXPIRED);
  const s = await findById(c.kind, c.id, c.tenantId);
  if (!s || !s.active || s.row.mfa_enabled_at || !s.row.totp_secret_enc) return res.status(401).json(EXPIRED);
  const step = verifyTotp(decryptSecret(s.row.totp_secret_enc), req.body?.code, 0);
  if (step === null) { await recordLogin(s, false); return res.status(401).json(BAD_CODE); }
  const recovery = newRecoveryCodes();
  await saveMfa(s, { enable: true, lastStep: step, recovery: recovery.hashes });
  res.json({ ...(await issueSession(s)), recoveryCodes: recovery.codes });
});

// Step 2, every time after that.
router.post("/auth/mfa/verify", async (req, res) => {
  const c = challengeOf(req, "mfa");
  if (!c) return res.status(401).json(EXPIRED);
  const s = await findById(c.kind, c.id, c.tenantId);
  if (!s || !s.active || !s.row.mfa_enabled_at) return res.status(401).json(EXPIRED);
  if (isLocked(s)) return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
  const code = String(req.body?.code ?? "");
  const step = verifyTotp(decryptSecret(s.row.totp_secret_enc), code, s.row.mfa_last_step);
  if (step !== null) {
    await saveMfa(s, { lastStep: step });
  } else {
    const remaining = consumeRecovery(s.row.recovery_hashes || [], code);
    if (!remaining) { await recordLogin(s, false); return res.status(401).json(BAD_CODE); }
    await saveMfa(s, { recovery: remaining });
    if (s.kind === "tenant") await record(s.tenantId, s.id, "login_recovery_code", { remaining: remaining.length });
  }
  res.json(await issueSession(s));
});

// Who am I, which unit am I crewing, and what call is that unit on.
// The Field Unit screen is driven entirely by this — nobody types a unit ID.
router.get("/auth/me", requireAuth, async (req, res) => {
  const out = await withTenant(req.user.tenantId, async (c) => {
    const who = (await c.query(
      `SELECT u.user_id, u.email, u.display_name, u.role, u.extra_roles::text[] AS extra_roles, cm.field_level, t.display_name AS agency
       FROM users u JOIN tenants t ON t.tenant_id = u.tenant_id LEFT JOIN crew_members cm ON cm.user_id = u.user_id
       WHERE u.user_id = $1`, [req.user.userId])).rows[0];
    const unit = (await c.query(
      `SELECT un.unit_id, v.unit_designation, v.capability_level, un.current_status, uca.seat_role
       FROM crew_members cm
       JOIN unit_crew_assignments uca ON uca.crew_member_id = cm.crew_member_id AND uca.assigned_to IS NULL
       JOIN units un ON un.unit_id = uca.unit_id
       JOIN vehicles v ON v.vehicle_id = un.vehicle_id
       WHERE cm.user_id = $1 AND cm.is_active
       LIMIT 1`, [req.user.userId])).rows[0] || null;
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
         ORDER BY iua.assigned_at DESC LIMIT 1`, [unit.unit_id])).rows[0] || null;
    }
    return { who, unit, incident };
  });
  res.json({
    user: { id: out.who.user_id, email: out.who.email, name: out.who.display_name, role: out.who.role, roles: [out.who.role, ...out.who.extra_roles], fieldLevel: out.who.field_level || null },
    agency: out.who.agency,
    unit: out.unit,
    incident: out.incident,
  });
});

// The three numbers on a crew member's profile.
//   assigned   calls their unit was on while they were on that unit (not cancelled)
//   completed  charts they were on that have been submitted (or signed off)
//   pending    charts still theirs to submit: ones in progress, ones QA sent back to
//              them, and calls their unit ran as primary or ALS intercept that have
//              no chart yet. Always 0 for an MVO or a non-field person: they don't chart.
router.get("/me/stats", requireAuth, async (req, res) => {
  const stats = await withTenant(req.user.tenantId, async (c) => {
    const me = (await c.query("SELECT crew_member_id, field_level FROM crew_members WHERE user_id = $1", [req.user.userId])).rows[0];
    if (!me) return { assigned: 0, completed: 0, pending: 0, awaitingCorrection: 0, canChart: false };
    const canChart = ["emt", "aemt", "paramedic"].includes(me.field_level);
    const overlap = `
      FROM unit_crew_assignments uca
      JOIN incident_unit_assignments iua ON iua.unit_id = uca.unit_id
           AND iua.assigned_at < COALESCE(uca.assigned_to, 'infinity') AND COALESCE(iua.unassigned_at, 'infinity') > uca.assigned_from
      JOIN incidents i ON i.incident_id = iua.incident_id AND i.cancelled_at IS NULL
      WHERE uca.crew_member_id = $1`;
    const assigned = Number((await c.query(`SELECT count(DISTINCT iua.incident_id) AS n ${overlap}`, [me.crew_member_id])).rows[0].n);
    if (!canChart) return { assigned, completed: 0, pending: 0, awaitingCorrection: 0, canChart };
    const completed = Number((await c.query(
      `SELECT count(*) AS n FROM pcr_crew pc JOIN patient_care_records p ON p.pcr_id = pc.pcr_id
       WHERE pc.user_id = $1 AND (p.status = 'submitted' OR p.finalized_at IS NOT NULL)`, [req.user.userId])).rows[0].n);
    const open = (await c.query(
      `SELECT count(*) FILTER (WHERE p.status = 'draft') AS drafts,
              count(*) FILTER (WHERE p.status = 'reopened' AND p.assigned_to_user_id = $1) AS corrections
       FROM pcr_crew pc JOIN patient_care_records p ON p.pcr_id = pc.pcr_id
       WHERE pc.user_id = $1 AND p.finalized_at IS NULL`, [req.user.userId])).rows[0];
    const notStarted = Number((await c.query(
      `SELECT count(DISTINCT (iua.incident_id, iua.unit_id)) AS n ${overlap}
         AND iua.role IN ('primary', 'als_intercept')
         AND NOT EXISTS (SELECT 1 FROM patient_care_records p WHERE p.incident_id = iua.incident_id AND p.unit_id = iua.unit_id)`,
      [me.crew_member_id])).rows[0].n);
    const corrections = Number(open.corrections);
    return { assigned, completed, pending: Number(open.drafts) + corrections + notStarted, awaitingCorrection: corrections, canChart };
  });
  res.json(stats);
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
