// The geocoder with the network stubbed: house numbers must never be silently dropped.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { searchPlaces, houseNumberOf, tidyCensusLabel } from "../backend_geocode.js";

const realFetch = globalThis.fetch;
let calls;
beforeEach(() => { process.env.GEOCODE_ENABLED = "true"; calls = []; });
afterEach(() => { globalThis.fetch = realFetch; delete process.env.GEOCODE_ENABLED; });
const stub = ({ census = [], osm = [] }) => {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = String(url).includes("census.gov") ? { result: { addressMatches: census } } : osm;
    return new Response(JSON.stringify(body), { status: 200 });
  };
};
const CENSUS_HIT = [{ matchedAddress: "475 GRAND AVE, PALISADES PARK, NJ, 07650", coordinates: { x: -73.9979, y: 40.8484 } }];
const STREET_ONLY = [{ display_name: "Grand Avenue, Palisades Park, Bergen County, New Jersey, 07650, United States", lat: "40.85", lon: "-73.99", address: { road: "Grand Avenue" } }];

test("house number parsing", () => {
  assert.equal(houseNumberOf("475 Grand Avenue, Palisades Park, NJ"), "475");
  assert.equal(houseNumberOf("12A Main St"), "12a");
  assert.equal(houseNumberOf("BronxCare Hospital Center"), null);
  assert.equal(houseNumberOf("1 "), null);
});

test("475 Grand Avenue: the Census is asked first and the number is kept in the label", async () => {
  stub({ census: CENSUS_HIT, osm: STREET_ONLY });
  const r = await searchPlaces("475 Grand Avenue, Palisades Park, NJ");
  assert.match(calls[0], /census\.gov/);
  assert.equal(r[0].label, "475 Grand Ave, Palisades Park, NJ, 07650");
  assert.equal(r[0].exact, true);
});

test("when only the street is known, the result says so instead of passing as the typed address", async () => {
  stub({ census: [], osm: STREET_ONLY });
  const r = await searchPlaces("475 Grand Avenue, Palisades Park, NJ");
  assert.equal(r.length, 1);
  assert.equal(r[0].exact, false);
  assert.match(r[0].note, /475/);
});

test("an OSM result with the matching house number is exact and leads the list", async () => {
  stub({ census: [], osm: [STREET_ONLY[0], { display_name: "475, Grand Avenue, Palisades Park", lat: "40.8484", lon: "-73.9979", address: { house_number: "475", road: "Grand Avenue" } }] });
  const r = await searchPlaces("475 Grand Avenue, Palisades Park, NJ");
  assert.equal(r[0].exact, true);
  assert.equal(r[1].exact, false);
});

test("a building or hospital name (no house number) is searched on OSM first and is never flagged approximate", async () => {
  stub({ osm: [{ display_name: "BronxCare Hospital Center, 1650, Grand Concourse, Bronx", lat: "40.84", lon: "-73.91", address: { amenity: "BronxCare" } }] });
  const r = await searchPlaces("BronxCare Hospital Center");
  assert.match(calls[0], /nominatim/);
  assert.equal(r[0].exact, true);
});

test("disabled geocoding makes no network calls", async () => {
  process.env.GEOCODE_ENABLED = "false";
  stub({ census: CENSUS_HIT });
  assert.deepEqual(await searchPlaces("475 Grand Avenue"), []);
  assert.equal(calls.length, 0);
});

test("Census labels are tidied", () => {
  assert.equal(tidyCensusLabel("1650 GRAND CONCOURSE, BRONX, NY, 10457"), "1650 Grand Concourse, Bronx, NY, 10457");
});
