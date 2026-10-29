// backend_websocket.js
// -----------------------------------------------------------------------
// The real-time half of the API layer — REST for reads/writes,
// WebSocket for pushing changes to everyone who should see them
// immediately (a unit going en route, a new critical call). Socket.IO
// specifically for its room primitive, which maps directly onto the
// tenant/incident scoping this project has used everywhere else.
//
// The point worth noticing: this file does not re-implement
// authorization. It asks the database the same question the REST
// routes ask — via the same withTenant/RLS pattern — and joins rooms
// based on the answer. A mutual-aid-shared incident shows up in a
// socket's rooms the exact same way an owned one does, because the
// query that decides "what can this tenant see" doesn't know or care
// which case it's answering. That consistency is the actual payoff of
// putting isolation in the database instead of scattered through
// every place data gets touched.
// -----------------------------------------------------------------------

import { Server } from "socket.io";
import { resolveSession, lookupUser } from "./backend_auth.js";
import { withTenant } from "./backend_db.js";

export function attachWebSocket(httpServer) {
  const io = new Server(httpServer, { cors: { origin: process.env.ALLOWED_ORIGIN } });

  // Socket.IO's handshake carries the token in `auth`, not a header —
  // native browser WebSocket can't set custom headers, so this is the
  // conventional place for it regardless of client library.
  // Same authority check as the HTTP API, deliberately the SAME function:
  // this used to carry its own copy of the token check, so a deactivated
  // user could still open a socket and receive live incident and unit
  // updates after the API had started refusing them.
  io.use(async (socket, next) => {
    try {
      const session = await resolveSession(socket.handshake.auth?.token);
      if (!session.user) return next(new Error("Unauthorized"));
      socket.tenantId = session.user.tenantId;
      socket.userId = session.user.userId;
      next();
    } catch (err) {
      next(new Error("Unauthorized"));
    }
  });

  // A handshake check only covers the moment of connecting. A user
  // deactivated (or an agency suspended) while a socket is open would
  // otherwise keep receiving live updates until they happened to
  // disconnect. So every open socket is re-checked on an interval and
  // cut off the moment it no longer passes. One query per socket per
  // sweep is fine at this scale; batching by agency is the optimization
  // if it ever isn't.
  const sweepMs = Number(process.env.WS_REVALIDATE_MS) || 30000;
  const sweep = setInterval(async () => {
    for (const socket of io.sockets.sockets.values()) {
      try {
        const row = await lookupUser(socket.tenantId, socket.userId);
        if (!row || !row.user_active || !row.tenant_active) socket.disconnect(true);
      } catch (err) {
        // A database hiccup must not disconnect every operator mid-call.
      }
    }
  }, sweepMs);
  sweep.unref(); // never the reason the process stays alive
  httpServer.on("close", () => clearInterval(sweep));

  io.on("connection", async (socket) => {
    socket.join(`tenant:${socket.tenantId}`);

    // Snapshot of what this tenant can see right now, scoped to open
    // incidents only — closed ones don't need live push, and joining
    // a room per historical incident would grow unbounded for no
    // benefit. This single query returns both owned incidents and
    // anything currently shared via an active mutual_aid_link; the
    // socket layer never evaluates that distinction itself.
    const visible = await withTenant(socket.tenantId, (client) =>
      client.query("SELECT incident_id FROM incidents WHERE closed_at IS NULL")
    );
    visible.rows.forEach((row) => socket.join(`incident:${row.incident_id}`));
  });

  return io;
}

// Call after a write actually commits — e.g., at the end of a
// PATCH /units/:id/status handler in the REST layer, not before.
// Broadcasting never causes the isolation question to be re-asked:
// the tenant room reaches the owning agency, the incident room
// reaches anyone with an active grant on that one incident, and
// neither the caller nor this function needs to know which recipients
// fall into which case.
export function broadcastUnitStatusChange(io, { tenantId, incidentId, unit }) {
  if (!io) return; // serverless (Vercel) runs without a live feed
  io.to(`tenant:${tenantId}`).emit("unit:status", unit);
  if (incidentId) io.to(`incident:${incidentId}`).emit("unit:status", unit);
}

export function broadcastNewIncident(io, { tenantId, incident }) {
  if (!io) return; // serverless (Vercel) runs without a live feed
  io.to(`tenant:${tenantId}`).emit("incident:new", incident);
}

// The piece a purely request/response API doesn't have to think about:
// a grant is live-relevant, not just a database row. Call this right
// after the INSERT in the POST /mutual-aid/grants handler (backend_
// routes_example.js) succeeds — it makes every currently-connected
// socket for the assisting tenant start receiving that incident's
// updates immediately, not just the next time they happen to
// reconnect and re-sync their room list.
export function grantIncidentRoomAccess(io, assistingTenantId, incidentId) {
  io.in(`tenant:${assistingTenantId}`).socketsJoin(`incident:${incidentId}`);
}

// The other side of the same coin: call this from the
// POST /mutual-aid/grants/:linkId/revoke handler right after the
// UPDATE sets status = 'revoked'. Without this, a socket that joined
// the room while the grant was active would keep silently receiving
// updates until it happened to disconnect — a live access grant that
// outlives the revocation that was supposed to end it.
export function revokeIncidentRoomAccess(io, assistingTenantId, incidentId) {
  io.in(`tenant:${assistingTenantId}`).socketsLeave(`incident:${incidentId}`);
}

// =====================================================================
// Not shown here, and a real deployment needs it: horizontal scaling.
// A single Node process can hold these rooms in memory, but the
// instant there's more than one server instance, "broadcast to this
// room" only reaches sockets connected to THAT instance — Socket.IO's
// Redis adapter (@socket.io/redis-adapter) is the standard fix, and
// it's a config addition to this file, not a redesign of it.
// =====================================================================
