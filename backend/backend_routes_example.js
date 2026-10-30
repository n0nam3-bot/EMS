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
import { geocodeAddress } from "./backend_geocode.js";


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
    ST_Y(i.destination_location::geometry) AS dest_lat,
    ST_X(i.destination_location::geometry) AS dest_lon,
    COALESCE(
      json_agg(json_build_object('unitId', iua.unit_id, 'role', iua.role) ORDER BY iua.assigned_at)
        FILTER (WHERE iua.unit_id IS NOT NULL),
      '[]'
    ) AS assigned_units
  FROM incidents i
  LEFT JOIN incident_unit_assignments iua ON iua.incident_id = i.incident_id AND iua.unassigned_at IS NULL`;

// A call shared with another agency through mutual aid shows them where and
// what, not who: the patient's and caller's identity stays with the agency
// that took the call.
function redact(row, tenantId) {
  if (row.tenant_id === tenantId) return row;
  return { ...row, patient_name: null, contact_name: null, contact_phone: null };
}

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
    return result.rows.map((r) => redact(r, req.user.tenantId));
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
    return redact(found, req.user.tenantId);
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
const INCIDENT_TYPES = ["emergency_911", "ift_scheduled", "ift_on_demand", "mutual_aid"];
const PRIORITIES = ["critical", "emergent", "urgent", "routine"];
const LEVELS = ["BLS", "ALS", "CCT"];
const text = (v, max = 500) => (v == null ? null : String(v).trim().slice(0, max) || null);
const coord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

// Returns a plain-English problem, or null if the fields are fine.
// `partial` (editing) only checks what was actually sent.
function incidentProblem(b, partial) {
  const has = (k) => b[k] !== undefined;
  if (!partial || has("incidentType")) if (!INCIDENT_TYPES.includes(b.incidentType)) return `Call type must be one of: ${INCIDENT_TYPES.join(", ")}`;
  if (!partial || has("priority")) if (!PRIORITIES.includes(b.priority)) return `Priority must be one of: ${PRIORITIES.join(", ")}`;
  if (has("capabilityNeeded") && !LEVELS.includes(b.capabilityNeeded)) return "Level of care must be BLS, ALS or CCT";
  if (!partial || has("sceneAddress")) if (!text(b.sceneAddress) || text(b.sceneAddress).length < 3) return "Enter the pickup address or facility";
  for (const [lat, lon] of [[b.lat, b.lon], [b.destLat, b.destLon]]) {
    if ((lat != null || lon != null) && !coord(lat, lon)) return "Map coordinates are not valid";
  }
  return null;
}

// The SERVER stamps the protocol version, never the client. The schema
// says protocol_set_id is set once at intake so a chart can always show
// which version was in force on the date of care — a stale client
// choosing it would defeat that. Any protocolSetId in the body is
// ignored. (The dispatch console never sent one, so "New Call" in live
// mode failed on the NOT NULL constraint with an opaque 500.)
router.post("/incidents", async (req, res) => {
  const b = req.body || {};
  const problem = incidentProblem(b, false);
  if (problem) return res.status(400).json({ error: problem });
  let { lat, lon, destLat, destLon } = b;
  if (lat == null || lon == null) {
    // Before opening the transaction: no database connection is held while waiting on the network.
    const g = await geocodeAddress(b.sceneAddress);
    if (g) ({ lat, lon } = g);
  }
  if ((destLat == null || destLon == null) && text(b.destinationText)) {
    const g = await geocodeAddress(b.destinationText);
    if (g) ({ lat: destLat, lon: destLon } = g);
  }
  const result = await withTenant(req.user.tenantId, async (client) => {
    const active = await client.query(
      `SELECT protocol_set_id FROM protocol_sets
       WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
       ORDER BY effective_from DESC LIMIT 1`
    );
    if (active.rows.length === 0) return null;
    return client.query(
      `INSERT INTO incidents (tenant_id, incident_type, priority, protocol_set_id, scene_address, scene_location,
                              capability_needed, scene_detail, destination_text, destination_location,
                              contact_name, contact_phone, patient_name, notes)
       VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $6::double precision IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography END,
               $8, $9, $10,
               CASE WHEN $11::double precision IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($11, $12), 4326)::geography END,
               $13, $14, $15, $16)
       RETURNING *, $7::double precision AS lat, $6::double precision AS lon`,
      [req.user.tenantId, b.incidentType, b.priority, active.rows[0].protocol_set_id, text(b.sceneAddress),
       lon ?? null, lat ?? null,
       b.capabilityNeeded || "BLS", text(b.sceneDetail), text(b.destinationText), destLon ?? null, destLat ?? null,
       text(b.contactName, 200), text(b.contactPhone, 50), text(b.patientName, 200), text(b.notes, 2000)]
    );
  });
  if (!result) {
    return res.status(409).json({ error: "No active protocol set is configured for this agency — an incident can't be created without one" });
  }
  res.status(201).json(result.rows[0]);
});

// Fixing a mistake. Only what was sent changes; the database audit trigger
// records which fields changed, by whom, and when. A call that has been
// closed or cancelled is a finished record and can't be edited.
router.patch("/incidents/:id", async (req, res) => {
  const b = req.body || {};
  const problem = incidentProblem(b, true);
  if (problem) return res.status(400).json({ error: problem });
  const has = (k) => b[k] !== undefined;

  // Location: an explicit pin wins; a changed address with no pin is
  // re-looked-up; failing that the old pin is cleared rather than left
  // pointing at the wrong place.
  const loc = {};
  if (has("lat") || has("lon")) loc.scene = coord(b.lat, b.lon) ? { lat: b.lat, lon: b.lon } : "clear";
  else if (has("sceneAddress")) loc.scene = (await geocodeAddress(b.sceneAddress)) || "clear";
  if (has("destLat") || has("destLon")) loc.dest = coord(b.destLat, b.destLon) ? { lat: b.destLat, lon: b.destLon } : "clear";
  else if (has("destinationText")) loc.dest = text(b.destinationText) ? ((await geocodeAddress(b.destinationText)) || "clear") : "clear";

  const sets = [], vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  const point = (col, v) => {
    if (v === "clear") return sets.push(`${col} = NULL`);
    vals.push(v.lon, v.lat);
    sets.push(`${col} = ST_SetSRID(ST_MakePoint($${vals.length - 1}, $${vals.length}), 4326)::geography`);
  };
  if (has("incidentType")) add("incident_type", b.incidentType);
  if (has("priority")) add("priority", b.priority);
  if (has("capabilityNeeded")) add("capability_needed", b.capabilityNeeded);
  if (has("sceneAddress")) add("scene_address", text(b.sceneAddress));
  if (has("sceneDetail")) add("scene_detail", text(b.sceneDetail));
  if (has("destinationText")) add("destination_text", text(b.destinationText));
  if (has("contactName")) add("contact_name", text(b.contactName, 200));
  if (has("contactPhone")) add("contact_phone", text(b.contactPhone, 50));
  if (has("patientName")) add("patient_name", text(b.patientName, 200));
  if (has("notes")) add("notes", text(b.notes, 2000));
  if (loc.scene) point("scene_location", loc.scene);
  if (loc.dest) point("destination_location", loc.dest);
  if (!sets.length) return res.status(400).json({ error: "Nothing to change" });

  const row = await withTenant(req.user.tenantId, async (client) => {
    const cur = (await client.query("SELECT closed_at FROM incidents WHERE incident_id = $1 AND tenant_id = $2", [req.params.id, req.user.tenantId])).rows[0];
    if (!cur) return { status: 404 };
    if (cur.closed_at) return { status: 409 };
    vals.push(req.params.id);
    await client.query(`UPDATE incidents SET ${sets.join(", ")} WHERE incident_id = $${vals.length}`, vals);
    const out = await client.query(`${INCIDENT_SELECT} WHERE i.incident_id = $1 GROUP BY i.incident_id`, [req.params.id]);
    return { row: out.rows[0] };
  });
  if (row.status === 404) return res.status(404).json({ error: "Call not found" });
  if (row.status === 409) return res.status(409).json({ error: "This call is already closed and can't be edited" });
  res.json(row.row);
});

// Cancelling is not deleting: the call stays on record, marked cancelled
// with who and why (the audit log keeps the who), and every unit on it is
// released in the same transaction.
router.post("/incidents/:id/cancel", async (req, res) => {
  const reason = text(req.body?.reason, 500);
  if (!reason || reason.length < 3) return res.status(400).json({ error: "Say why the call is being cancelled" });
  const result = await withTenant(req.user.tenantId, async (client) => {
    const cur = (await client.query("SELECT closed_at FROM incidents WHERE incident_id = $1 AND tenant_id = $2", [req.params.id, req.user.tenantId])).rows[0];
    if (!cur) return { status: 404 };
    if (cur.closed_at) return { status: 409 };
    const active = await client.query("SELECT unit_id FROM incident_unit_assignments WHERE incident_id = $1 AND unassigned_at IS NULL", [req.params.id]);
    for (const r of active.rows) {
      await client.query("UPDATE incident_unit_assignments SET unassigned_at = now() WHERE incident_id = $1 AND unit_id = $2 AND unassigned_at IS NULL", [req.params.id, r.unit_id]);
      await setUnitStatus(client, req.user.tenantId, r.unit_id, "available", req.params.id);
    }
    const out = await client.query(
      "UPDATE incidents SET closed_at = now(), cancelled_at = now(), cancel_reason = $2 WHERE incident_id = $1 RETURNING *",
      [req.params.id, reason]
    );
    return { row: out.rows[0] };
  });
  if (result.status === 404) return res.status(404).json({ error: "Call not found" });
  if (result.status === 409) return res.status(409).json({ error: "This call is already closed" });
  res.json(result.row);
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
