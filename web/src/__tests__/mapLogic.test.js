import { describe, it, expect } from "vitest";
import { buildMapPlan, placeForStatus, CALL_COLORS, STATUS_COLORS } from "../mapLogic.js";

const U = (id, status, lat, lon, extra = {}) => ({ id, designation: id, capability: "BLS", status, lat, lon, ...extra });
const I = (id, extra = {}) => ({ id, address: id, destination: "", assignedUnits: [], lat: 40.8, lon: -73.9, destLat: 40.9, destLon: -73.8, ...extra });
const ongoing = I("busy", { assignedUnits: [{ unitId: "u2", role: "primary" }], lat: 40.81, lon: -73.91, destLat: 40.91, destLon: -73.81 });
const queued = I("queued", { lat: 40.7, lon: -73.7, destLat: 40.71, destLon: -73.71 });
const units = [U("u1", "available", 40.85, -73.85), U("u2", "en_route", 40.82, -73.88), U("u3", "out_of_service", null, null)];

describe("map plan", () => {
  it("with nothing selected shows ongoing calls and all located units, not queued calls", () => {
    const p = buildMapPlan({ units, incidents: [ongoing, queued] });
    expect(p.pins.map((x) => x.id).sort()).toEqual(["busy:d", "busy:p"]);
    expect(p.pins.every((x) => x.tone === "live" && !x.small)).toBe(true);
    expect(p.unitPins.map((u) => u.id)).toEqual(["u1", "u2"]);        // u3 has no position
    expect(p.unitPins.find((u) => u.id === "u2").color).toBe(STATUS_COLORS.en_route);
  });

  it("queued calls can be shown, and are small and dull", () => {
    const p = buildMapPlan({ units, incidents: [ongoing, queued], showQueued: true });
    const q = p.pins.filter((x) => x.callId === "queued");
    expect(q).toHaveLength(2);
    expect(q.every((x) => x.small && x.tone === "queued")).toBe(true);
    expect(CALL_COLORS.pickup.queued).not.toBe(CALL_COLORS.pickup.live);
  });

  it("selecting a queued call shows just its trip (pickup, drop-off, line) at full size, and dims the other units", () => {
    const p = buildMapPlan({ units, incidents: [ongoing, queued], selIncidentId: "queued" });
    expect(p.pins.map((x) => x.id).sort()).toEqual(["queued:d", "queued:p"]);
    expect(p.pins.every((x) => x.selected && !x.small && x.tone === "live")).toBe(true);
    expect(p.lines.filter((l) => l.id === "queued:trip")).toHaveLength(1);
    expect(p.unitPins.every((u) => u.dim)).toBe(true);
  });

  it("selecting an ongoing call keeps its own units bright", () => {
    const p = buildMapPlan({ units, incidents: [ongoing, queued], selIncidentId: "busy" });
    expect(p.unitPins.find((u) => u.id === "u2").dim).toBe(false);
    expect(p.unitPins.find((u) => u.id === "u1").dim).toBe(true);
  });

  it("a call with no drop-off shows only a pickup, and no trip line", () => {
    const p = buildMapPlan({ units: [], incidents: [I("p", { destLat: null, destLon: null, assignedUnits: [{ unitId: "x" }] })] });
    expect(p.pins.map((x) => x.kind)).toEqual(["pickup"]);
    expect(p.lines).toHaveLength(0);
  });

  it("a working unit gets a line to where it is heading: pickup when en route, drop-off when transporting", () => {
    const a = buildMapPlan({ units: [U("u2", "en_route", 40.82, -73.88)], incidents: [ongoing] });
    expect(a.lines.find((l) => l.id === "u2:go").to).toEqual([40.81, -73.91]);
    const b = buildMapPlan({ units: [U("u2", "transporting", 40.82, -73.88)], incidents: [ongoing] });
    expect(b.lines.find((l) => l.id === "u2:go").to).toEqual([40.91, -73.81]);
    const c = buildMapPlan({ units: [U("u2", "at_destination", 40.91, -73.81)], incidents: [ongoing] });
    expect(c.lines.find((l) => l.id === "u2:go")).toBeUndefined();
  });

  it("a call being typed is previewed before it's saved, flagged when approximate, and the map frames it", () => {
    const draft = { pickup: { lat: 40.85, lon: -73.99, label: "475 Grand Avenue", approx: true }, dest: { lat: 40.86, lon: -73.98, label: "Hospital", approx: false } };
    const p = buildMapPlan({ units, incidents: [ongoing], draft });
    const d = p.pins.filter((x) => x.callId === "draft");
    expect(d.map((x) => [x.kind, x.tone, x.approx])).toEqual([["pickup", "draft", true], ["dropoff", "draft", false]]);
    expect(p.lines.some((l) => l.id === "draft:trip")).toBe(true);
    expect(p.focus).toEqual([[40.85, -73.99], [40.86, -73.98]]);
  });

  it("placing a unit by status: pickup on scene and while leaving, drop-off at destination, nothing without a pin", () => {
    expect(placeForStatus("on_scene", ongoing)).toMatchObject({ lat: 40.81, lon: -73.91, from: "pickup" });
    expect(placeForStatus("transporting", ongoing)).toMatchObject({ lat: 40.81, from: "pickup" });
    expect(placeForStatus("at_destination", ongoing)).toMatchObject({ lat: 40.91, lon: -73.81, from: "drop-off" });
    expect(placeForStatus("en_route", ongoing)).toBeNull();
    expect(placeForStatus("at_destination", I("x", { destLat: null, destLon: null }))).toBeNull();
    expect(placeForStatus("on_scene", null)).toBeNull();
  });
});
