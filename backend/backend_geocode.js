// backend_geocode.js
// -----------------------------------------------------------------------
// Turns what a dispatcher types into coordinates, using free services that
// need no API key: OpenStreetMap Nominatim (handles hospital and building
// names as well as street addresses) with the US Census geocoder as a
// fallback for plain street addresses. Off unless GEOCODE_ENABLED=true, so
// tests and local runs never make outbound calls.
//
// Nominatim's usage policy asks for an identifying User-Agent and light
// use (about one request a second). Fine for dispatchers searching one
// call at a time; revisit with a paid geocoder if volume grows.
// -----------------------------------------------------------------------

export const geocodingEnabled = () => process.env.GEOCODE_ENABLED === "true";
const UA = { "User-Agent": "ems-dispatch/0.1 (dispatch address search)" };

export async function searchPlaces(query, near) {
  if (!geocodingEnabled() || !query) return [];
  const params = new URLSearchParams({ format: "jsonv2", limit: "5", countrycodes: "us", q: query });
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lon)) {
    // A preference for results near the agency, not a hard limit.
    const d = 0.5;
    params.set("viewbox", `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: UA, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const rows = await r.json();
      if (rows.length) return rows.map((m) => ({ label: m.display_name, lat: Number(m.lat), lon: Number(m.lon) }));
    }
  } catch (err) { /* fall through */ }
  try {
    const r = await fetch(
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(query),
      { signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const matches = (await r.json()).result?.addressMatches || [];
      return matches.slice(0, 5).map((m) => ({ label: m.matchedAddress, lat: m.coordinates.y, lon: m.coordinates.x }));
    }
  } catch (err) { /* no results */ }
  return [];
}

export async function geocodeAddress(address) {
  const [first] = await searchPlaces(address);
  return first ? { lat: first.lat, lon: first.lon } : null;
}
