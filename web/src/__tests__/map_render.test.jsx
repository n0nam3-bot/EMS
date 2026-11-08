// Drives the real dispatch console with a stand-in for Leaflet that records what gets drawn,
// so the drawing code (colours, sizes, draft preview, selection) is exercised end to end.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import DispatchConsole from "../consoles/dispatch_console.jsx";

let drawn;   // { markers: [{ html }], lines: [] } from the latest redraw
function installFakeLeaflet() {
  drawn = { markers: [], lines: [] };
  const map = { setView() { return map; }, fitBounds() {}, getZoom: () => 12, createPane() {}, getPane: () => ({ style: {} }), removeLayer() {}, remove() {}, on() { return map; } };
  window.L = {
    map: () => map,
    tileLayer: () => ({ on() {}, addTo() { return this; } }),
    layerGroup: () => ({ addTo() { return this; }, clearLayers() { drawn = { markers: [], lines: [] }; } }),
    divIcon: (o) => o,
    marker: (ll, opts) => ({ on() { return this; }, addTo() { drawn.markers.push({ ll, html: opts.icon.html, z: opts.zIndexOffset }); return this; } }),
    polyline: (pts, o) => ({ addTo() { drawn.lines.push({ pts, ...o }); return this; } }),
  };
}
beforeAll(async () => { await import("../storage-shim.js"); globalThis.fetch = () => Promise.reject(new Error("network off")); });
beforeEach(installFakeLeaflet);
afterEach(() => { cleanup(); delete window.L; sessionStorage.clear(); });
const cls = (re) => drawn.markers.filter((m) => re.test(m.html));

describe("dispatch map drawing", () => {
  it("by default shows units and the ongoing calls only, with the legend", async () => {
    render(<DispatchConsole />);
    await screen.findByText("Citywide Dispatch");
    await waitFor(() => expect(cls(/ems-unit/).length).toBe(8));
    expect(cls(/ems-call pickup/).length).toBe(2);              // demo calls i2 and i5 have a unit on them
    expect(cls(/ems-call pickup small/).length).toBe(0);        // queued calls are hidden until asked for
    expect(screen.getByLabelText("Map legend").textContent).toMatch(/Pickup.*Drop-off.*Queued/);
  });

  it("queued calls can be shown, small and dull", async () => {
    render(<DispatchConsole />);
    await screen.findByText("Citywide Dispatch");
    fireEvent.click(await screen.findByRole("button", { name: /Queued calls hidden/ }));
    await waitFor(() => expect(cls(/ems-call pickup small/).length).toBe(3));
    expect(cls(/pickup small/)[0].html).toMatch(/--c:#7A6A78/);
  });

  it("clicking a queued call shows just that call's pickup, full size, and fades the units", async () => {
    render(<DispatchConsole />);
    await screen.findByText("Citywide Dispatch");
    fireEvent.click(screen.getAllByText("Bruckner Expwy & Longwood Ave")[0]);
    await waitFor(() => expect(cls(/ems-call/).length).toBe(1));
    expect(cls(/ems-call/)[0].html).not.toMatch(/small/);
    expect(cls(/ems-unit/).every((m) => /faded/.test(m.html))).toBe(true);
    expect(screen.getByLabelText("Map legend").textContent).toMatch(/selected call's trip/);
  });

  it("a call being typed appears on the map before it is saved, flagged when only the street was found", async () => {
    render(<DispatchConsole />);
    await screen.findByText("Citywide Dispatch");
    act(() => { window.dispatchEvent(new CustomEvent("ems-draft-pins", { detail: {
      pickup: { lat: 40.85, lon: -73.99, label: "475 Grand Avenue, Palisades Park, NJ", approx: true },
      dest: { lat: 40.86, lon: -73.98, label: "Hospital", approx: false } } })); });
    await waitFor(() => expect(cls(/draft/).length).toBe(2));
    expect(cls(/ems-call pickup draft approx/)[0].html).toMatch(/street only/);
    expect(cls(/ems-call dropoff draft/)[0].html).toMatch(/not saved yet/);
    expect(drawn.lines.some((l) => l.color === "#FFFFFF")).toBe(true);
    act(() => { window.dispatchEvent(new CustomEvent("ems-draft-pins", { detail: null })); });
    await waitFor(() => expect(cls(/draft/).length).toBe(0));
  });

  it("units are coloured by status", async () => {
    render(<DispatchConsole />);
    await screen.findByText("Citywide Dispatch");
    await waitFor(() => expect(cls(/ems-unit/).length).toBe(8));
    const colourOf = (name) => cls(new RegExp(`${name} ·`))[0].html.match(/--c:(#[0-9A-Fa-f]{6})/)[1];
    expect(colourOf("Unit 3")).toBe("#34D399");     // available
    expect(colourOf("Unit 7")).toBe("#F0862B");     // en route
    expect(colourOf("Unit 12")).toBe("#4EA1F0");    // on scene
  });
});
