// backend_auth.js
// -----------------------------------------------------------------------
// Turns a bearer token into a user — and decides whether that user may
// act. This deliberately does NOT implement OIDC/SAML itself: that
// belongs to a real identity provider (Azure AD/Entra ID, Okta, etc.) or
// a battle-tested library, not a hand-rolled auth flow.
//
// The division of labor matters. The token only proves WHO is asking.
// The database decides what they may do and whether they may do
// anything at all: role, whether the user is active, whether their
// agency is active. This used to verify the signature and then trust
// every claim in the token, so a terminated employee, a downgraded
// role, or a suspended agency kept working until the token happened to
// expire. Looking it up on every request is what makes revocation
// immediate; it costs a query per request, and caching it would give
// back exactly the delay this exists to remove.
//
// It assumes the token's `sub` IS the user's UUID in the users table.
// Real identity providers often use opaque subject strings instead;
// mapping users.external_idp_subject to users.user_id belongs here
// when one is connected.
// -----------------------------------------------------------------------

import jwt from "jsonwebtoken";
import { requestContext } from "./backend_context.js";
import { withTenant } from "./backend_db.js";
import { auditDenied } from "./backend_audit.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function lookupUser(tenantId, userId) {
  // Scoped to the claimed agency: a real user presenting another
  // agency's tenant_id finds nothing, because row-level security hides
  // users that aren't theirs.
  return withTenant(tenantId, async (client) =>
    (await client.query(
      `SELECT u.role, u.is_active AS user_active, t.is_active AS tenant_active
       FROM users u JOIN tenants t ON t.tenant_id = u.tenant_id
       WHERE u.user_id = $1 AND u.tenant_id = $2`,
      [userId, tenantId]
    )).rows[0]
  );
}

// The ONE place a token becomes a user. The HTTP middleware and the
// WebSocket handshake both use it — two copies of "verify the token" is
// how one of them ends up checking less than the other.
//
// Every refusal carries the same message on purpose: a caller shouldn't
// learn whether an account exists, is deactivated, or belongs to a
// suspended agency. The specific reason goes in the audit log instead.
export async function resolveSession(token) {
  const refused = { error: "Invalid or expired session" };
  if (!token) return { error: "Missing session token" };
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_PUBLIC_KEY, { algorithms: ["RS256"] });
  } catch (err) {
    return refused;
  }
  // Both become UUID-typed values in the database. A malformed claim
  // should be a clean refusal here, not an opaque 500 from deep in a
  // query — or an unattributable write.
  if (!UUID_RE.test(payload.sub ?? "") || !UUID_RE.test(payload.tenant_id ?? "")) return refused;

  const who = { tenantId: payload.tenant_id, userId: payload.sub };
  const row = await lookupUser(who.tenantId, who.userId);
  const deny = (reason) => ({ ...refused, denied: { who, reason } });
  if (!row) return deny("no such user in this agency");
  if (!row.tenant_active) return deny("agency suspended");
  if (!row.user_active) return deny("user deactivated");
  return { user: { ...who, role: row.role } };
}

export async function requireAuth(req, res, next) {
  // Several routers each mount this; the first to run has already
  // authenticated the request, and repeating a database lookup per
  // router would multiply its cost for nothing.
  if (req.user) return next();
  const session = await resolveSession(req.headers.authorization?.replace("Bearer ", ""));
  if (!session.user) {
    if (session.denied) {
      try {
        await auditDenied(session.denied.who, { method: req.method, path: req.originalUrl, reason: session.denied.reason });
      } catch (err) {
        // A claimed agency that doesn't exist has nothing to attach the
        // entry to. The caller is refused either way.
      }
    }
    return res.status(401).json({ error: session.error });
  }
  req.user = session.user;
  // Everything downstream, including the database layer, can now ask who
  // is acting without it being passed through every call.
  requestContext.run({ userId: session.user.userId }, next);
}

// "Can you see this row" is the database's job; "are you allowed to take
// this action at all" is this. The role it checks is the one the
// database just returned, not the one the token claimed. A refusal is
// logged: someone with a valid session reaching past their role is worth
// knowing about.
export function requireRole(...allowedRoles) {
  return async (req, res, next) => {
    if (allowedRoles.includes(req.user.role)) return next();
    try {
      await auditDenied(req.user, {
        method: req.method,
        path: req.originalUrl,
        requiredRoles: allowedRoles,
        actualRole: req.user.role,
      });
    } catch (err) {
      // The caller is being refused either way — don't let a logging
      // failure turn a 403 into a 500, but don't swallow it silently.
      console.error("could not record a denied attempt:", err.message);
    }
    return res.status(403).json({ error: "Not authorized for this action" });
  };
}
