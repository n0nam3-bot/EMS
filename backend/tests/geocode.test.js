// The address search: the house number must never be silently dropped, and every result says how precise it is.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { searchPlaces, hasHouseNumber, prettyCensus, nominatimLabel } from "../backend_geocode.js";

const realFetch = globalThis.fetch;
let calls;
const respond = (census, osm) => {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url).includes("census.gov") ? { result: { addressMatches: census } } : osm;
    return new Response(JSON.stringify(body), { status: 200 });
  };
};
beforeEach(() => { process.env.GEOCODE_ENABLED = "true"; });
afterEach(() => { globalThis.fetch = realFetch; delete process.env.GEOCODE_ENABLED; });

test("tells a house-numbered address from a place name", () => {
  for (const q of ["475 Grand Avenue, Palisades Park, NJ", "12B Main St", "  9-11 Broadway Bronx"]) assert.equal(hasHouseNumber(q), true, q);
  for (const q of ["BronxCare Hospital", "Grand Avenue, Palisades Park", "1st Avenue"]) assert.equal(hasHouseNumber(q), false, q);
});

test("the Census address is tidied into readable form", () => {
  assert.equal(prettyCensus("475 GRAND AVE, PALISADES PARK, NJ, 07650"), "475 Grand Ave, Palisades Park, NJ 07650");
  assert.equal(prettyCensus("1650 GRAND CONCOURSE, BRONX, NY, 10457"), "1650 Grand Concourse, Bronx, NY 10457");
  assert.equal(prettyCensus("100 W 42ND ST, NEW YORK, NY, 10036"), "100 W 42nd St, New York, NY 10036");
});

test("a house-numbered query keeps its house number: the exact Census match comes first and the street-only OSM hit is labelled as approximate", async () => {
  respond(
    [{ matchedAddress: "475 GRAND AVE, PALISADES PARK, NJ, 07650", coordinates: { x: -73.9969, y: 40.8481 } }],
    [{ display_name: "Grand Avenue, Palisades Park, Bergen County, New Jersey, 07650, United States", lat: "40.8470", lon: "-73.9950", class: "highway", addresstype: "road",
       address: { road: "Grand Avenue", town: "Palisades Park", "ISO3166-2-lvl4": "US-NJ", postcode: "07650" } }],
  );
  const r = await searchPlaces("475 Grand Avenue, Palisades Park, NJ");
  assert.equal(r[0].label, "475 Grand Ave, Palisades Park, NJ 07650", "the house number is there");
  assert.equal(r[0].precision, "address");
  assert.equal(r[0].approximate, false);
  const street = r.find((x) => x.source === "osm");
  assert.equal(street.label, "Grand Avenue, Palisades Park, NJ 07650");
  assert.equal(street.precision, "street");
  assert.equal(street.approximate, true, "a street-only answer to a numbered question is flagged, never passed off as the address");
  assert.ok(calls.some((u) => u.includes("census.gov")), "Census is asked first for numbered addresses");
});

test("OSM results with a house number are labelled with it, and named places keep their name", async () => {
  respond([], [
    { display_name: "x", lat: "40.84", lon: "-73.91", address: { house_number: "1650", road: "Grand Concourse", city: "The Bronx", "ISO3166-2-lvl4": "US-NY", postcode: "10457" }, name: "BronxCare Hospital Center", class: "amenity" },
    { display_name: "y", lat: "40.85", lon: "-73.90", address: { road: "Fordham Road", city: "Bronx", "ISO3166-2-lvl4": "US-NY" }, class: "highway", addresstype: "road" },
  ]);
  const r = await searchPlaces("bronxcare");
  assert.equal(r[0].label, "BronxCare Hospital Center, 1650 Grand Concourse, The Bronx, NY 10457");
  assert.equal(r[0].precision, "address");
  assert.equal(r[1].precision, "street");
  assert.equal(r[1].approximate, false, "a name search isn't asking for a house number, so a street isn't 'approximate'");
  assert.ok(!calls.some((u) => u.includes("census.gov")), "place names don't go to the address geocoder");
});

test("the same spot from both services appears once, and nothing is returned when geocoding is off", async () => {
  respond([{ matchedAddress: "1 MAIN ST, X, NJ, 07001", coordinates: { x: -74.0, y: 40.0 } }], [{ display_name: "1 Main St", lat: "40.00001", lon: "-74.00001", address: { house_number: "1", road: "Main St", town: "X" } }]);
  assert.equal((await searchPlaces("1 Main St")).length, 1);
  delete process.env.GEOCODE_ENABLED;
  assert.deepEqual(await searchPlaces("1 Main St"), []);
});

test("nominatimLabel falls back to Nominatim's own text when there's nothing to compose", () => {
  assert.equal(nominatimLabel({ display_name: "Somewhere, Far Away", address: {} }), "Somewhere, Far Away");
});
