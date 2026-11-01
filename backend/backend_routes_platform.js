// backend_routes_platform.js
// -----------------------------------------------------------------------
// The platform administrator's console: run the service, not a company.
//   - see every company and open or suspend it
//   - create a company together with its first (owner) account
//   - help an account: reset a password, reset two-step sign-in, deactivate
//
// What this deliberately CANNOT do: read a call, a patient chart, or any
// other operational data. It reaches the database only through a handful of
// narrow functions (see scripts/upgrade.js) that each write themselves into
// the affected company's audit log. A platform admin who needs to see a
// company's data would need an explicit, time-limited grant from that
// company. That isn't built, on purpose.
// -----------------------------------------------------------------------

import express from "express";
import pool from "./backend_db.js";
import { verifyPlatformToken } from "./backend_auth.js";
import { hashPassword } from "./backend_passwords.js";

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PLATFORM_PASSWORD = 12;

async function platformAuth(req, res, next) {
  const claims = verifyPlatformToken(req.headers.authorization);
  if (!claims || !UUID_RE.test(claims.sub ?? "")) return res.status(401).json({ error: "Invalid or expired session" });
  const admin = (await pool.query("SELECT admin_id, email, display_name, is_active FROM platform_get_admin($1)", [claims.sub])).rows[0];
  if (!admin || !admin.is_active) return res.status(401).json({ error: "Invalid or expired session" });
  req.platformAdmin = { id: admin.admin_id, email: admin.email, name: admin.display_name };
  next();
}
router.use("/platform", platformAuth);

router.get("/platform/me", (req, res) => res.json(req.platformAdmin));

router.get("/platform/tenants", async (req, res) => {
  res.json((await pool.query("SELECT * FROM platform_list_tenants()")).rows);
});

router.post("/platform/tenants", async (req, res) => {
  const { name, state, protocolAuthority, ownerEmail, ownerName, ownerPassword } = req.body || {};
  const email = String(ownerEmail ?? "").trim().toLowerCase();
  if (String(name ?? "").trim().length < 2) return res.status(400).json({ error: "Enter the company name" });
  if (!/^[A-Za-z]{2}$/.test(String(state ?? ""))) return res.status(400).json({ error: "State must be a 2-letter code, like NY" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter the owner's email" });
  if (String(ownerName ?? "").trim().length < 2) return res.status(400).json({ error: "Enter the owner's full name" });
  if (typeof ownerPassword !== "string" || ownerPassword.length < 10) return res.status(400).json({ error: "Temporary password must be at least 10 characters" });
  try {
    const hash = await hashPassword(ownerPassword);
    const r = await pool.query("SELECT platform_create_tenant($1, $2, $3, $4, $5, $6, $7) AS tenant_id",
      [String(name).trim(), String(state).toUpperCase(), protocolAuthority || null, email, String(ownerName).trim(), hash, req.platformAdmin.id]);
    res.status(201).json({ tenant_id: r.rows[0].tenant_id });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That email is already used by an account" });
    throw err;
  }
});

router.patch("/platform/tenants/:id", async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Bad company id" });
  if (typeof req.body?.isActive !== "boolean") return res.status(400).json({ error: "isActive must be true or false" });
  const ok = (await pool.query("SELECT platform_set_tenant_active($1, $2, $3) AS ok", [req.params.id, req.body.isActive, req.platformAdmin.id])).rows[0].ok;
  if (!ok) return res.status(404).json({ error: "Company not found" });
  res.json({ ok: true });
});

router.get("/platform/tenants/:id/users", async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Bad company id" });
  res.json((await pool.query("SELECT * FROM platform_list_users($1)", [req.params.id])).rows);
});

router.patch("/platform/users/:id", async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Bad user id" });
  const { password, resetMfa, isActive } = req.body || {};
  if (password === undefined && !resetMfa && isActive === undefined) return res.status(400).json({ error: "Nothing to change" });
  if (password !== undefined && (typeof password !== "string" || password.length < 10)) return res.status(400).json({ error: "Password must be at least 10 characters" });
  const hash = password !== undefined ? await hashPassword(password) : null;
  const ok = (await pool.query("SELECT platform_user_action($1, $2, $3, $4, $5) AS ok",
    [req.params.id, req.platformAdmin.id, hash, Boolean(resetMfa), isActive === undefined ? null : Boolean(isActive)])).rows[0].ok;
  if (!ok) return res.status(404).json({ error: "User not found" });
  res.json({ ok: true });
});

export { MIN_PLATFORM_PASSWORD };
export default router;
