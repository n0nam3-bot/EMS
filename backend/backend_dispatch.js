// backend_dispatch.js
// -----------------------------------------------------------------------
// The rules for moving a unit and a call through their lifecycle, in one place
// so the unit-status route, the assignment routes and the tests agree.
//
// Principle: a unit that is on a call moves FORWARD through the call phases;
// leaving the call (available / out of service) is a release or a completion,
// not a status flip. Anything outside the rules needs an authorized override
// with a reason, and the override is written to the audit log.
// -----------------------------------------------------------------------

export const CALL_PHASE = ["assigned", "en_route", "on_scene", "transporting", "at_destination"];
export const OVERRIDE_ROLES = ["supervisor", "dispatcher", "it_admin"];

export const EVENT_FOR_STATUS = {
  assigned: "unit_assigned", en_route: "unit_en_route", on_scene: "unit_on_scene",
  transporting: "unit_transporting", at_destination: "unit_at_destination", available: "unit_cleared",
};

const LABEL = { available: "available", assigned: "assigned", en_route: "en route", on_scene: "on scene", transporting: "transporting", at_destination: "at destination", out_of_service: "out of service" };

// Returns { ok, clears?, error? }.
//   busy   the unit has an active assignment on an open call.
//   clears the move ends the unit's part in the call (at destination -> available).
export function checkTransition(from, to, busy) {
  if (from === to) return { ok: true, noop: true };
  if (busy) {
    if (to === "available" && from === "at_destination") return { ok: true, clears: true };
    if (!CALL_PHASE.includes(to)) {
      return { ok: false, error: `This unit is on a call, so it can't be set ${LABEL[to]} directly. Release it from the call, or complete the call, first.` };
    }
    if (CALL_PHASE.indexOf(to) < CALL_PHASE.indexOf(from)) {
      return { ok: false, error: `This unit is ${LABEL[from]}; it can't go back to ${LABEL[to]} without a supervisor or dispatcher override.` };
    }
    return { ok: true };
  }
  // No call. "en route" stays allowed for a unit moving itself (a move-up or a radio dispatch).
  if (["available", "out_of_service", "en_route"].includes(to)) return { ok: true };
  return { ok: false, error: `This unit has no active call, so it can't be set ${LABEL[to]}. Assign it to a call first.` };
}

// What a unit still lacks before it can be in service: same rule as reconcileUnit in backend_routes_admin.js.
export async function unitMissing(c, unitId) {
  const u = (await c.query(
    "SELECT v.capability_level, v.is_in_service FROM units un JOIN vehicles v ON v.vehicle_id = un.vehicle_id WHERE un.unit_id = $1", [unitId])).rows[0];
  if (!u) return ["a unit record"];
  const crew = (await c.query(
    `SELECT count(*) AS n,
            count(*) FILTER (WHERE uca.seat_role = 'driver') AS drivers,
            count(*) FILTER (WHERE cm.field_level IN ('emt', 'aemt', 'paramedic')) AS clinical,
            count(*) FILTER (WHERE cm.field_level = 'paramedic') AS medics
     FROM unit_crew_assignments uca JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
     WHERE uca.unit_id = $1 AND uca.assigned_to IS NULL`, [unitId])).rows[0];
  const missing = [];
  if (u.is_in_service === false) missing.push("the vehicle back in service");
  if (Number(crew.n) === 0) return [...missing, "a crew"];
  if (Number(crew.drivers) === 0) missing.push("a driver");
  if (Number(crew.clinical) === 0) missing.push("an EMT or above");
  if (u.capability_level !== "BLS" && Number(crew.medics) === 0) missing.push("a paramedic");
  return missing;
}

// Append one row to the call's timeline. Call it inside the same transaction as the change.
export async function recordEvent(client, user, { incidentId, unitId = null, kind, overrideReason = null, note = null }) {
  await client.query(
    `INSERT INTO incident_events (tenant_id, incident_id, unit_id, kind, actor_user_id, override_reason, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [user.tenantId, incidentId, unitId, kind, user.userId, overrideReason, note]);
}

// An override is security-relevant: who bypassed which rule, and why. No patient data in the detail.
export async function auditOverride(client, user, unitId, detail) {
  await client.query(
    `INSERT INTO audit_log (tenant_id, actor_user_id, action, table_name, record_id, detail)
     VALUES ($1, $2, 'override', 'units', $3, $4)`,
    [user.tenantId, user.userId, unitId, JSON.stringify(detail)]);
}

export const canOverride = (user) => (user.roles || [user.role]).some((r) => OVERRIDE_ROLES.includes(r));
