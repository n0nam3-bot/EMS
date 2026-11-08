// backend_geocode.js
// -----------------------------------------------------------------------
// Turns what a dispatcher types into coordinates, using free services that
// need no API key: the US Census geocoder (accurate for street addresses: it
// interpolates house numbers) and OpenStreetMap Nominatim (handles hospital and
// building names). Off unless GEOCODE_ENABLED=true, so tests and local runs
// never make outbound calls.
//
// The rule that matters: a result must never LOOK like the address that was typed
// when it isn't. If you type "475 Grand Avenue" and the only thing a service knows is
// "Grand Avenue", the result comes back with exact: false so the screen can say
// "street only, pin is approximate" instead of quietly dropping the number.
//
// Nominatim's usage policy asks for an identifying User-Agent and light
// use (about one request a second). Fine for dispatchers searching one
// call at a time; revisit with a paid geocoder if volume grows.
// -----------------------------------------------------------------------

export const geocodingEnabled = () => process.env.GEOCODE_ENABLED === "true";
const UA = { "User-Agent": "ems-dispatch/0.1 (dispatch address search)" };

// "475 Grand Avenue, ..." -> "475". Also 12A, 10-20. Null if the query doesn't start with a house number.
export function houseNumberOf(query) {
  const m = String(query ?? "").match(/^\s*(\d+[A-Za-z]?(?:-\d+)?)\s+\S/);
  return m ? m[1].toLowerCase() : null;
}

// The Census returns "475 GRAND AVE, PALISADES PARK, NJ, 07650"; make it readable.
export function tidyCensusLabel(label) {
  const parts = String(label).split(",").map((p) => p.trim());
  return parts.map((p, i) => {
    if (i >= 2 && /^[A-Za-z]{2}$/.test(p)) return p.toUpperCase();           // state
    if (/^\d{5}(-\d{4})?$/.test(p)) return p;                                 // zip
    return p.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
  }).join(", ");
}

async function census(query) {
  try {
    const r = await fetch(
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=" + encodeURIComponent(query),
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) return [];
    const matches = (await r.json()).result?.addressMatches || [];
    // The Census only returns matches for the address that was typed (it interpolates along the street), so a match is exact.
    return matches.slice(0, 5).map((m) => ({ label: tidyCensusLabel(m.matchedAddress), lat: m.coordinates.y, lon: m.coordinates.x, exact: true, source: "census" }));
  } catch (err) { return []; }
}

async function nominatim(query, near, wanted) {
  const params = new URLSearchParams({ format: "jsonv2", limit: "5", countrycodes: "us", q: query, addressdetails: "1" });
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lon)) {
    // A preference for results near the agency, not a hard limit.
    const d = 0.5;
    params.set("viewbox", `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: UA, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return [];
    return (await r.json()).map((m) => {
      const got = String(m.address?.house_number ?? "").toLowerCase();
      // A building or facility name has no house number to match; only a typed number can go unmatched.
      const exact = !wanted || got === wanted;
      return { label: m.display_name, lat: Number(m.lat), lon: Number(m.lon), exact, source: "osm", ...(exact ? {} : { note: `House number ${wanted.toUpperCase()} wasn't found; this pin is on the street.` }) };
    });
  } catch (err) { return []; }
}

export async function searchPlaces(query, near) {
  if (!geocodingEnabled() || !query) return [];
  const wanted = houseNumberOf(query);
  if (wanted) {
    // A street address: the Census first (it knows house numbers), then OSM. Exact matches always lead.
    const fromCensus = await census(query);
    if (fromCensus.length) return fromCensus;
    const osm = await nominatim(query, near, wanted);
    return [...osm.filter((x) => x.exact), ...osm.filter((x) => !x.exact)];
  }
  const osm = await nominatim(query, near, null);
  return osm.length ? osm : census(query);
}

export async function geocodeAddress(address) {
  const [first] = await searchPlaces(address);
  return first ? { lat: first.lat, lon: first.lon, exact: first.exact } : null;
}
