// backend_routes_example.js
// -----------------------------------------------------------------------
// A representative slice, not a complete API. The same withTenant +
// RLS pattern repeats for every other table in the schema (crew,
// certifications, vehicles, PCRs, protocol documents...) — that's
// repetition, not new architecture, so it isn't all written out here.
// What's worth actually reading closely is what ISN'T in these
// handlers: no manual "WHERE tenant_id = ..." anywhere, and no
// special-case branch for mutual-aid-shared incidents. Both are
// handled by the database once app.current_tenant_id is set — these
// routes are this simple on purpose.
// -----------------------------------------------------------------------

import express from "express";
import { withTenant } from "./backend_db.js";
import { requireAuth, requireRole } from "./backend_auth.js";
import { auditView } from "./backend_audit.js";

const router = express.Router();
router.use(requireAuth);

// Every unit status change goes through here so it can't happen without
// its history row. unit_status_history is the source of truth for
// response-time reporting, and its own schema comment says status must
// never change without a row beside it — the assignment, release and
// complete routes below used to change status (or, for assign and
// release, didn't change it at all) and wrote no history, which a test
// that drove the real handlers found. incident_id is recorded because
// mutual-aid visibility into a shared incident's history is keyed on it.
async function setUnitStatus(client, tenantId, unitId, status, incidentId) {
  await client.query("UPDATE units SET current_status = $1 WHERE unit_id = $2", [status, unitId]);
  await client.query(
    "INSERT INTO unit_status_history (tenant_id, unit_id, incident_id, status) VALUES ($1, $2, $3, $4)",
    [tenantId, unitId, incidentId, status]
  );
}

// SELECT * alone would return scene_location as raw PostGIS binary,
// unusable to a frontend expecting plain lat/lon — this was caught
// while wiring the dispatch console to real data, not before. Same
// ST_Y/ST_X pattern backend_routes_units.js already uses for units.
// Active assignments ride along with every incident: a console has to
// show who is on a call, and without this the API had no way to say.
// The console's own code carried a comment pointing at a
// "loadAssignments" function that was never written — which meant that
// in live mode, after the first Assign, Release and Complete never
// appeared at all.
const INCIDENT_SELECT = `
  SELECT i.*,
    ST_Y(i.scene_location::geometry) AS lat,
    ST_X(i.scene_location::geometry) AS lon,
    COALESCE(
      json_agg(json_build_object('unitId', iua.unit_id, 'role', iua.role) ORDER BY iua.assigned_at)
        FILTER (WHERE iua.unit_id IS NOT NULL),
      '[]'
    ) AS assigned_units
  FROM incidents i
  LEFT JOIN incident_unit_assignments iua ON iua.incident_id = i.incident_id AND iua.unassigned_at IS NULL`;

// Another agency's incidents reach this list only through a mutual-aid
// grant, and the owner is entitled to know when they're looked at, so
// each one returned is logged. Browsing your OWN incidents isn't logged
// per record — that would bury the log — but opening a single one is
// (see below).
router.get("/incidents", async (req, res) => {
  const rows = await withTenant(req.user.tenantId, async (client) => {
    const result = await client.query(`${INCIDENT_SELECT} GROUP BY i.incident_id ORDER BY i.call_received_at DESC LIMIT 100`);
    for (const r of result.rows.filter((row) => row.tenant_id !== req.user.tenantId)) {
      await auditView(client, req.user, "incidents", r.incident_id, { via: "mutual_aid", list: true });
    }
    return result.rows;
  });
  res.json(rows);
});

// Same handler, no branching logic — but this correctly returns a
// mutual-aid-shared incident belonging to a DIFFERENT tenant too, for
// as long as an active grant exists. The isolation and the sharing
// exception both live in the incidents RLS policy, not here. Logged in
// the same transaction as the read, so no entry means no data.
router.get("/incidents/:id", async (req, res) => {
  const row = await withTenant(req.user.tenantId, async (client) => {
    const result = await client.query(`${INCIDENT_SELECT} WHERE i.incident_id = $1 GROUP BY i.incident_id`, [req.params.id]);
    if (result.rows.length === 0) return null;
    const found = result.rows[0];
    await auditView(client, req.user, "incidents", found.incident_id, found.tenant_id !== req.user.tenantId ? { via: "mutual_aid" } : {});
    return found;
  });
  if (!row) return res.status(404).json({ error: "Not found" });
  res.json(row);
});

// The SERVER stamps the protocol version, never the client. The schema
// says protocol_set_id is set once at intake so a chart can always show
// which version was in force on the date of care — a stale client
// choosing it would defeat that. Any protocolSetId in the body is
// ignored. (The dispatch console never sent one, so "New Call" in live
// mode failed on the NOT NULL constraint with an opaque 500.)
router.post("/incidents", async (req, res) => {
  const { incidentType, priority, sceneAddress, lat, lon } = req.body;
  const result = await withTenant(req.user.tenantId, async (client) => {
    const active = await client.query(
      `SELECT protocol_set_id FROM protocol_sets
       WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
       ORDER BY effective_from DESC LIMIT 1`
    );
    if (active.rows.length === 0) return null;
    return client.query(
      `INSERT INTO incidents (tenant_id, incident_type, priority, protocol_set_id, scene_address, scene_location)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::double precision IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography END)
       RETURNING *, $7::double precision AS lat, $6::double precision AS lon`,
      [req.user.tenantId, incidentType, priority, active.rows[0].protocol_set_id, sceneAddress, lon ?? null, lat ?? null]
    );
  });
  if (!result) {
    return res.status(409).json({ error: "No active protocol set is configured for this agency — an incident can't be created without one" });
  }
  res.status(201).json(result.rows[0]);
});

// One unit per call is the common case, not the only case — this
// matches the dispatch console's Assign/Add Unit action and the
// incident_unit_assignments table from multi_unit_incidents_schema.sql.
router.post("/incidents/:id/assignments", async (req, res) => {
  const { unitId, role } = req.body;
  try {
    const result = await withTenant(req.user.tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO incident_unit_assignments (tenant_id, incident_id, unit_id, role)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.user.tenantId, req.params.id, unitId, role || "primary"]
      );
      // Same transaction as the assignment: the unit's status and its
      // history row change with it or not at all. A refused assignment
      // (the unique-index violation below) rolls the whole thing back,
      // so a rejected attempt leaves the unit exactly as it was.
      await setUnitStatus(client, req.user.tenantId, unitId, "assigned", req.params.id);
      return inserted;
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    // Translates the unique indexes from the schema — this unit is
    // already on this incident, this incident already has a primary,
    // or this unit is already working a different incident — into one
    // clear response instead of a raw constraint violation.
    if (err.code === "23505") {
      return res.status(409).json({ error: "That unit is already active on an incident, or this incident already has a primary unit" });
    }
    throw err;
  }
});

router.delete("/incidents/:id/assignments/:unitId", async (req, res) => {
  const released = await withTenant(req.user.tenantId, async (client) => {
    const r = await client.query(
      `UPDATE incident_unit_assignments SET unassigned_at = now()
       WHERE incident_id = $1 AND unit_id = $2 AND unassigned_at IS NULL RETURNING *`,
      [req.params.id, req.params.unitId]
    );
    if (r.rows.length > 0) await setUnitStatus(client, req.user.tenantId, req.params.unitId, "available", req.params.id);
    return r;
  });
  if (released.rows.length === 0) return res.status(404).json({ error: "No active assignment found" });
  res.json(released.rows[0]);
});

// Closing out a transport releases every unit still on it in the same
// transaction that closes the incident — the dispatch console's
// "Complete (release all)" action maps directly to this one call,
// not to a series of separate release calls the client would have to
// sequence itself and could leave half-finished if one step failed.
router.post("/incidents/:id/complete", async (req, res) => {
  const result = await withTenant(req.user.tenantId, async (client) => {
    const active = await client.query(
      "SELECT unit_id FROM incident_unit_assignments WHERE incident_id = $1 AND unassigned_at IS NULL",
      [req.params.id]
    );
    for (const row of active.rows) {
      await client.query(
        "UPDATE incident_unit_assignments SET unassigned_at = now() WHERE incident_id = $1 AND unit_id = $2 AND unassigned_at IS NULL",
        [req.params.id, row.unit_id]
      );
      await setUnitStatus(client, req.user.tenantId, row.unit_id, "available", req.params.id);
    }
    return client.query("UPDATE incidents SET closed_at = now() WHERE incident_id = $1 RETURNING *", [req.params.id]);
  });
  if (result.rows.length === 0) return res.status(404).json({ error: "Incident not found" });
  res.json(result.rows[0]);
});

// This route needs a check the database can't make for you. RLS
// answers "what can this session see once a grant exists" — it has no
// opinion on "should this particular user be allowed to CREATE a
// grant in the first place." That's a business rule about roles, and
// it belongs here, in application code, same as the 72-hour cap being
// enforced twice: once as a real CHECK constraint the database will
// never let slip, and again here so the requester gets a clear error
// instead of a raw constraint-violation message.
router.post(
  "/mutual-aid/grants",
  requireRole("supervisor", "compliance_officer"),
  async (req, res) => {
    const { assistingTenantId, incidentId, reason, expiresInHours } = req.body;
    if (!expiresInHours || expiresInHours > 72) {
      return res.status(400).json({ error: "Grants must specify a duration of 72 hours or less" });
    }
    const result = await withTenant(req.user.tenantId, (client) =>
      client.query(
        `INSERT INTO mutual_aid_links
           (requesting_tenant_id, assisting_tenant_id, incident_id, granted_by_user_id, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))
         RETURNING *`,
        [req.user.tenantId, assistingTenantId, incidentId, req.user.userId, reason, expiresInHours]
      )
    );
    res.status(201).json(result.rows[0]);
  }
);

router.post("/mutual-aid/grants/:linkId/revoke", requireRole("supervisor", "compliance_officer"), async (req, res) => {
  const result = await withTenant(req.user.tenantId, (client) =>
    client.query(
      `UPDATE mutual_aid_links SET status = 'revoked', revoked_at = now(), revoked_by_user_id = $1
       WHERE link_id = $2 AND requesting_tenant_id = $3 RETURNING *`,
      [req.user.userId, req.params.linkId, req.user.tenantId]
    )
  );
  if (result.rows.length === 0) return res.status(404).json({ error: "Grant not found, or you're not the tenant that issued it" });
  res.json(result.rows[0]);
});

export default router;
