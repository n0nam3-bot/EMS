import { useState, useEffect } from "react";

// ---- Leaflet, loaded once from a CDN the first time any screen needs a map -------------------------
export function useLeafletLoader() {
  const [status, setStatus] = useState(() => (typeof window !== "undefined" && window.L ? "ready" : "loading"));
  useEffect(() => {
    if (window.L) { setStatus("ready"); return; }
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
    script.async = true;
    script.onload = () => setStatus("ready");
    script.onerror = () => setStatus("failed");
    document.head.appendChild(script);
  }, []);
  return status;
}

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const hasFix = (o) => Boolean(o) && o.lat != null && o.lon != null;

// Colors for the trip. Units are colored by STATUS; a call's two ends have their own colors so the
// pickup and the drop-off can't be mistaken for each other or for a unit.
export const PICKUP_COLOR = "#22D3EE";     // cyan
export const DROPOFF_COLOR = "#E879F9";    // magenta
export const QUEUED_COLOR = "#5B6B80";     // dull slate: waiting for a unit

// ---- where is a unit? -------------------------------------------------------------------------------------
// There is no GPS from the crews yet, so a unit's place is inferred from its status and its call, and
// the map draws inferred positions dashed so nobody mistakes a guess for a fix. A real, recent GPS
// position always wins. This is the one place to replace once live GPS exists.
//    on scene        at the pickup
//    transporting    on the way: half-way from the pickup to the drop-off
//    at destination  at the drop-off
//    anything else   wherever it last reported
export const GPS_FRESH_MS = 5 * 60 * 1000;
export function effectivePosition(unit, incident, nowMs = Date.now()) {
  const own = hasFix(unit);
  const fresh = own && (!unit.locationUpdatedAt || nowMs - new Date(unit.locationUpdatedAt).getTime() < GPS_FRESH_MS);
  if (fresh) return { lat: unit.lat, lon: unit.lon, estimated: false, basis: "GPS" };
  if (incident) {
    const pickup = hasFix(incident) ? { lat: incident.lat, lon: incident.lon } : null;
    const drop = incident.destLat != null && incident.destLon != null ? { lat: incident.destLat, lon: incident.destLon } : null;
    if (unit.status === "on_scene" && pickup) return { ...pickup, estimated: true, basis: "on scene (at the pickup)" };
    if (unit.status === "at_destination" && (drop || pickup)) return { ...(drop || pickup), estimated: true, basis: drop ? "at the drop-off" : "at the pickup (no drop-off pinned)" };
    if (unit.status === "transporting" && pickup) {
      const mid = drop ? { lat: (pickup.lat + drop.lat) / 2, lon: (pickup.lon + drop.lon) / 2 } : pickup;
      return { ...mid, estimated: true, basis: "transporting (estimated en route)" };
    }
  }
  if (own) return { lat: unit.lat, lon: unit.lon, estimated: true, basis: "last known position" };
  return null;
}

// ---- road route between two points (free OSRM demo server; no live traffic) -----------------------------
const routeCache = new Map();
export async function fetchRoute(a, b) {
  const key = `${a.lat},${a.lon};${b.lat},${b.lon}`;
  if (routeCache.has(key)) return routeCache.get(key);
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(6000) });
    const route = (await r.json()).routes?.[0];
    const out = route ? { points: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]), miles: route.distance / 1609.34, minutes: route.duration / 60 } : null;
    routeCache.set(key, out);
    return out;
  } catch (e) { return null; }
}
