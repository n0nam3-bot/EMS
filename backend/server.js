// server.js
// -----------------------------------------------------------------------
// The place every backend file actually gets wired together instead of
// existing as separate pieces that reference each other in theory. Two
// things here matter more than they look like they should:
//
// 1. `express-async-errors` — without this, an error thrown inside any
//    async route handler (a database error withTenant doesn't catch,
//    for instance) doesn't reach the error-handling middleware at all
//    in Express 4 — the request just hangs forever instead of
//    returning a 500. This one import patches that globally rather
//    than needing try/catch added to every handler already written.
//
// 2. `app.set("io", io)` — this is what makes `req.app.get("io")` in
//    backend_routes_location.js resolve to something real. Without
//    this exact line, that file's broadcast call fails at runtime.
// -----------------------------------------------------------------------

import "dotenv/config";
import "express-async-errors";
import express from "express";
import cors from "cors";
import http from "http";

import incidentRoutes from "./backend_routes_example.js";
import locationRoutes from "./backend_routes_location.js";
import unitRoutes from "./backend_routes_units.js";
import complianceRoutes from "./backend_routes_compliance.js";
import pcrRoutes from "./backend_routes_pcr.js";
import pcrDetailRoutes from "./backend_routes_pcr_detail.js";
import auditRoutes from "./backend_routes_audit.js";
import { attachWebSocket } from "./backend_websocket.js";
import { assertIsolationEnforced } from "./backend_db.js";

// On Vercel this file runs as a serverless function: no port to listen on and
// no long-lived WebSocket. Everywhere else (local, Docker, tests) it behaves
// exactly as before.
const ON_VERCEL = Boolean(process.env.VERCEL);

// Fail closed: see assertIsolationEnforced. Done before anything listens.
if (!ON_VERCEL) {
  try {
    await assertIsolationEnforced();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN }));
app.use(express.json());

if (ON_VERCEL) {
  // Depending on how the platform routes /api/* to this function, the
  // "/api" prefix may or may not still be on the path. Normalize so the
  // routes below match either way.
  app.use((req, res, next) => {
    if (!req.url.startsWith("/api") && !req.url.startsWith("/health")) req.url = "/api" + req.url;
    next();
  });
  // Same fail-closed check, run once per function instance on first use
  // (a serverless function has no "startup" to refuse). Retried on failure.
  let isolationCheck;
  app.use(async (req, res, next) => {
    if (req.path.endsWith("/health")) return next();
    try {
      isolationCheck ??= assertIsolationEnforced();
      await isolationCheck;
      next();
    } catch (err) {
      isolationCheck = undefined;
      console.error(err.message);
      res.status(503).json({ error: err.message });
    }
  });
}

let httpServer = null;
if (!ON_VERCEL) {
  httpServer = http.createServer(app);
  const io = attachWebSocket(httpServer);
  app.set("io", io);
}

app.use("/api", incidentRoutes);
app.use("/api", locationRoutes);
app.use("/api", unitRoutes);
app.use("/api", complianceRoutes);
app.use("/api", pcrRoutes);
app.use("/api", pcrDetailRoutes);
app.use("/api", auditRoutes);
// The rest of the schema's resources (crew, protocol documents,
// pcr signatures — blocked on object storage, see
// backend_routes_pcr_detail.js — mutual-aid revoke flows beyond
// what's already here) each need a route file of their own,
// following the exact same withTenant pattern as these six. That's
// real work still to do, not a placeholder — see README.md.

app.get(["/health", "/api/health"], (req, res) => res.json({ status: "ok" }));

// Safety net for anything a route handler didn't already turn into a
// specific 4xx response — not a replacement for the business-logic
// error handling already in each route file, which stays as-is.
app.use((err, req, res, next) => {
  // The schema's triggers raise plain exceptions (SQLSTATE P0001) for
  // business-rule violations and word their messages for people —
  // "PCR ... is finalized — record this change as an amendment".
  // That's the caller's problem to fix, not a server fault, so it goes
  // back as a 409 carrying that message. Without this the finalized-
  // chart rule worked and still looked like a crash. Every other
  // database error (constraint names, internals) stays an opaque 500.
  if (err.code === "P0001") {
    return res.status(409).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

if (httpServer) {
  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => {
    console.log(`EMS dispatch API listening on port ${PORT}`);
  });
}

// Vercel's Express support runs the exported app.
export default app;
