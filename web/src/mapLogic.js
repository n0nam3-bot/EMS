// mapLogic.js
// -----------------------------------------------------------------------
// What the dispatch map shows, decided in one pure function so it can be tested without a map.
//
//  - A call is selected  -> that call's trip: pickup, drop-off, the line between them, the units
//    on it, and the other units dimmed (so the dispatcher can see who is near).
//  - Nothing selected    -> the ONGOING calls (a unit is assigned) and every unit. Calls still
//    in the queue are left off unless "show queued" is on, and then they're small and dull.
//  - A call being typed (not saved yet) is previewed in a dashed "draft" style.
//
// Colours: units use their status colour (so a crew's progress reads at a glance); a call's pickup
// and drop-off have their own colours, dull and small when the call is only queued.
// -----------------------------------------------------------------------

export const STATUS_COLORS = {
  available: "#34D399", assigned: "#F5A623", en_route: "#F0862B", on_scene: "#4EA1F0",
  transporting: "#6C7FF0", at_destination: "#5EEAD4", out_of_service: "#55627A",
};
export const STATUS_LABELS = {
  available: "Available", assigned: "Assigned", en_route: "En route", on_scene: "On scene",
  transporting: "Transporting", at_destination: "At destination", out_of_service: "Out of service",
};
export const CALL_COLORS = {
  pickup: { live: "#FF5CA8", queued: "#7A6A78", draft: "#FFFFFF" },
  dropoff: { live: "#B388FF", queued: "#6A6F85", draft: "#FFFFFF" },
};

const has = (o) => o && o.lat != null && o.lon != null;
export const isOngoing = (i) => (i.assignedUnits || []).length > 0;

// Where a unit with no GPS should sit for a given status on a given call (null = don't move it).
export function placeForStatus(status, incident) {
  if (!incident) return null;
  if (status === "on_scene" || status === "transporting") return has(incident) ? { lat: incident.lat, lon: incident.lon, from: "pickup" } : null;
  if (status === "at_destination") return incident.destLat != null && incident.destLon != null ? { lat: incident.destLat, lon: incident.destLon, from: "drop-off" } : null;
  return null;
}

// The place a unit is heading for, by status (used to draw its line to the call).
function targetOf(unit, incident) {
  if (!incident) return null;
  if (unit.status === "transporting" && incident.destLat != null) return { lat: incident.destLat, lon: incident.destLon, kind: "dropoff" };
  if (["assigned", "en_route", "on_scene"].includes(unit.status) && has(incident)) return { lat: incident.lat, lon: incident.lon, kind: "pickup" };
  return null;
}

export function buildMapPlan({ units, incidents, selIncidentId = null, selUnitId = null, draft = null, showQueued = false }) {
  const pins = [], lines = [], unitPins = [];
  const sel = incidents.find((i) => i.id === selIncidentId) || null;
  const callOf = (u) => incidents.find((i) => (i.assignedUnits || []).some((a) => a.unitId === u.id)) || null;

  const addCall = (i, tone, extra = {}) => {
    const small = tone === "queued";
    if (has(i)) pins.push({ id: `${i.id}:p`, callId: i.id, kind: "pickup", lat: i.lat, lon: i.lon, tone, small, label: i.address, ...extra });
    if (i.destLat != null && i.destLon != null) pins.push({ id: `${i.id}:d`, callId: i.id, kind: "dropoff", lat: i.destLat, lon: i.destLon, tone, small, label: i.destination || "Drop-off", ...extra });
    if (has(i) && i.destLat != null && i.destLon != null) lines.push({ id: `${i.id}:trip`, from: [i.lat, i.lon], to: [i.destLat, i.destLon], color: CALL_COLORS.pickup[tone] || CALL_COLORS.pickup.live, dashed: true, thin: small });
  };

  if (sel) {
    addCall(sel, isOngoing(sel) ? "live" : "live", { selected: true });   // the one being looked at is full size either way
  } else {
    for (const i of incidents) {
      if (isOngoing(i)) addCall(i, "live");
      else if (showQueued) addCall(i, "queued");
    }
  }

  for (const u of units) {
    if (!has(u)) continue;
    const call = callOf(u);
    const onSelected = sel && call && call.id === sel.id;
    unitPins.push({
      id: u.id, lat: u.lat, lon: u.lon, status: u.status, color: STATUS_COLORS[u.status] || "#888",
      designation: u.designation, capability: u.capability, selected: u.id === selUnitId,
      dim: Boolean(sel) && !onSelected && u.id !== selUnitId,
      fromStatus: u.locationSource === "status",
    });
    // a thin line from each working unit to where it's going
    if (call && (!sel || onSelected)) {
      const t = targetOf(u, call);
      if (t) lines.push({ id: `${u.id}:go`, from: [u.lat, u.lon], to: [t.lat, t.lon], color: STATUS_COLORS[u.status], dashed: false, thin: true });
    }
  }

  // picking a unit and a call shows the leg between them (as before)
  const selU = units.find((u) => u.id === selUnitId);
  if (selU && sel && has(selU) && has(sel)) lines.push({ id: "sel-leg", from: [selU.lat, selU.lon], to: [sel.lat, sel.lon], color: "#4EA1F0", dashed: true, thin: false });

  // the call being typed
  if (draft?.pickup) pins.push({ id: "draft:p", callId: "draft", kind: "pickup", lat: draft.pickup.lat, lon: draft.pickup.lon, tone: "draft", small: false, approx: draft.pickup.approx, label: draft.pickup.label || "New call pickup" });
  if (draft?.dest) pins.push({ id: "draft:d", callId: "draft", kind: "dropoff", lat: draft.dest.lat, lon: draft.dest.lon, tone: "draft", small: false, approx: draft.dest.approx, label: draft.dest.label || "New call drop-off" });
  if (draft?.pickup && draft?.dest) lines.push({ id: "draft:trip", from: [draft.pickup.lat, draft.pickup.lon], to: [draft.dest.lat, draft.dest.lon], color: "#FFFFFF", dashed: true, thin: true });

  // what to frame: the draft, else the selected trip (plus its units), else everything shown
  let focus;
  if (draft && (draft.pickup || draft.dest)) focus = pins.filter((p) => p.callId === "draft");
  else if (sel) focus = [...pins, ...unitPins.filter((u) => !u.dim)];
  else focus = [...pins, ...unitPins];
  return { pins, lines, unitPins, focus: focus.map((p) => [p.lat, p.lon]), selected: sel };
}
