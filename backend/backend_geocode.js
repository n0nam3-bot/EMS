// backend_geocode.js
// -----------------------------------------------------------------------
// Turns what a dispatcher types into coordinates, using free services that need
// no API key.
//
//  - A street address that starts with a house number ("475 Grand Avenue, Palisades
//    Park, NJ") is looked up FIRST in the US Census geocoder, which interpolates house
//    numbers along the street. OpenStreetMap often has the street but not that house
//    number, and used to answer with just the street, silently dropping the "475".
//  - OpenStreetMap Nominatim then adds named places (hospitals, buildings) and any
//    other matches.
//  - Every result says how precise it is, so the screen can warn instead of pretending:
//      address = a specific house/building, street = only the street, place = a named place.
//
// Off unless GEOCODE_ENABLED=true, so tests and local runs never call out. Nominatim's
// usage policy asks for an identifying User-Agent and light use (about 1 request/second).
// -----------------------------------------------------------------------

export const geocodingEnabled = () => process.env.GEOCODE_ENABLED === "true";
const UA = { "User-Agent": "ems-dispatch/0.1 (dispatch address search)" };

export const hasHouseNumber = (q) => /^\s*\d+[A-Za-z]?(?:[-/]\d+)?\s+\S/.test(String(q ?? ""));

// "475 GRAND AVE, PALISADES PARK, NJ, 07650" -> "475 Grand Ave, Palisades Park, NJ 07650"
export function prettyCensus(s) {
  const parts = String(s).split(",").map((p) => p.trim()).filter(Boolean);
  const fixed = parts.map((p) => (/^[A-Z]{2}$/.test(p) || /^\d{5}(-\d{4})?$/.test(p) ? p
    : p.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/(\d)(St|Nd|Rd|Th)\b/g, (m, d, suf) => d + suf.toLowerCase())));
  const zip = fixed.length && /^\d{5}(-\d{4})?$/.test(fixed[fixed.length - 1]) ? fixed.pop() : null;
  const state = fixed.length && /^[A-Z]{2}$/.test(fixed[fixed.length - 1]) ? fixed.pop() : null;
  return [...fixed, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

// Builds a clear label from a Nominatim result instead of cutting its long display_name short.
export function nominatimLabel(m) {
  const a = m.address || {};
  const road = a.road || a.pedestrian || a.footway || a.path || null;
  const city = a.city || a.town || a.village || a.hamlet || a.suburb || a.borough || a.county || null;
  const st = (a["ISO3166-2-lvl4"] || "").replace(/^US-/, "") || a.state || null;
  const line = [a.house_number, road].filter(Boolean).join(" ") || null;
  const tail = [city, [st, a.postcode].filter(Boolean).join(" ")].filter(Boolean);
  const name = m.name && m.name !== road && m.name !== a.house_number ? m.name : null;
  const parts = [name, line, ...tail].filter(Boolean);
  return parts.length ? parts.join(", ") : m.display_name;
}
export function nominatimPrecision(m) {
  const a = m.address || {};
  if (a.house_number) return "address";
  if (m.addresstype === "road" || m.class === "highway" || (!m.name && a.road)) return "street";
  return "place";
}

async function census(query) {
  try {
    const r = await fetch("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(query), { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    return ((await r.json()).result?.addressMatches || []).slice(0, 3).map((m) => ({ label: prettyCensus(m.matchedAddress), lat: m.coordinates.y, lon: m.coordinates.x, precision: "address", source: "census" }));
  } catch (err) { return []; }
}

async function nominatim(query, near) {
  const params = new URLSearchParams({ format: "jsonv2", limit: "6", countrycodes: "us", addressdetails: "1", q: query });
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lon)) {
    const d = 0.5;                                          // a preference for results near the agency, not a hard limit
    params.set("viewbox", `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: UA, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    return (await r.json()).map((m) => ({ label: nominatimLabel(m), lat: Number(m.lat), lon: Number(m.lon), precision: nominatimPrecision(m), source: "osm" }));
  } catch (err) { return []; }
}

export async function searchPlaces(query, near) {
  if (!geocodingEnabled() || !query) return [];
  const numbered = hasHouseNumber(query);
  const [exact, osm] = await Promise.all([numbered ? census(query) : Promise.resolve([]), nominatim(query, near)]);
  const out = [];
  for (const r of [...exact, ...osm]) {
    // the same spot reported twice (within about 10 m) is one result; the first, more precise, one wins
    if (out.some((o) => Math.abs(o.lat - r.lat) < 0.0001 && Math.abs(o.lon - r.lon) < 0.0001)) continue;
    out.push({ ...r, approximate: numbered && r.precision !== "address" });
  }
  return out.slice(0, 7);
}

export async function geocodeAddress(address) {
  const results = await searchPlaces(address);
  // For an automatic lookup, prefer a result that is as precise as what was asked for.
  const best = results.find((r) => r.precision === "address") || results[0];
  return best ? { lat: best.lat, lon: best.lon } : null;
}
