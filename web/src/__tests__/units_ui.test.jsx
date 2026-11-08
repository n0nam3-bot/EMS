import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import TeamConsole from "../consoles/team_console.jsx";
import OpsConsole from "../consoles/ops_console.jsx";

beforeAll(() => { globalThis.fetch = () => Promise.reject(new Error("network off")); });
afterEach(cleanup);
function fakeServer(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^.*\/api/, "");
    const key = `${init.method || "GET"} ${path.split("?")[0]}`;
    calls.push({ key, url: String(url), body: init.body ? JSON.parse(init.body) : null });
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404 });
    const out = typeof h === "function" ? h(init.body ? JSON.parse(init.body) : null) : h;
    return new Response(JSON.stringify(out), { status: out?.__status || 200 });
  };
  return calls;
}
const session = { mode: "live", kind: "tenant", apiBaseUrl: "/api", token: "t", agency: "Acme", user: { id: "me", name: "Pat", role: "supervisor", roles: ["supervisor"] } };
const UNIT = (o = {}) => ({ unit_id: "u1", unit_designation: "Medic 1", capability_level: "ALS", current_status: "available", crew: [], vehicle_number: "214", ...o });

describe("Team: units", () => {
  const routes = (o = {}) => ({ "GET /users": [], "GET /units": [UNIT()], "GET /certification-types": [], "GET /certifications": [], "GET /vehicles": [], "GET /checklist": [], "GET /unit-checks/status": [], ...o });
  it("a unit can be renamed", async () => {
    const calls = fakeServer(routes({ "PATCH /units/u1": { unit_id: "u1" } }));
    render(<TeamConsole session={session} />);
    fireEvent.click(await screen.findByRole("button", { name: "Units & inspections" }));
    fireEvent.click(await screen.findByText("Medic 1"));
    expect(screen.getByText(/Vehicle: #214/)).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Unit name"), { target: { value: "Medic 11" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(calls.some((c) => c.key === "PATCH /units/u1" && c.body.designation === "Medic 11")).toBe(true));
    expect(await screen.findByText("Unit renamed.")).toBeTruthy();
  });

  it("deleting asks first, and says when a unit was retired instead of erased", async () => {
    const calls = fakeServer(routes({ "DELETE /units/u1": { removed: true, retired: true } }));
    render(<TeamConsole session={session} />);
    fireEvent.click(await screen.findByRole("button", { name: "Units & inspections" }));
    fireEvent.click(await screen.findByText("Medic 1"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete unit" }));
    expect(calls.some((c) => c.key === "DELETE /units/u1")).toBe(false);           // not yet: it asks first
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(await screen.findByText(/had call history, so it was retired/)).toBeTruthy();
  });

  it("shows the server's reason when a delete is refused", async () => {
    fakeServer(routes({ "DELETE /units/u1": { error: "Medic 1 has a crew on it. Take them off in OPS first.", __status: 409 } }));
    render(<TeamConsole session={session} />);
    fireEvent.click(await screen.findByRole("button", { name: "Units & inspections" }));
    fireEvent.click(await screen.findByText("Medic 1"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete unit" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(await screen.findByText(/has a crew on it/)).toBeTruthy();
  });
});

describe("OPS: vehicle", () => {
  const routes = (units, o = {}) => ({ "GET /units": units, "GET /ops/roster": [], "GET /unit-checks/status": [], ...o });
  it("assigns a vehicle number to a unit that has none", async () => {
    const calls = fakeServer(routes([UNIT({ vehicle_number: null })], { "PUT /units/u1/vehicle": { unit_id: "u1" }, "GET /units/u1/vehicle-history": [] }));
    render(<OpsConsole session={session} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assign vehicle" }));
    fireEvent.change(await screen.findByLabelText("Vehicle number"), { target: { value: "310" } });
    expect(screen.queryByLabelText("Reason")).toBeNull();                    // no reason needed the first time
    fireEvent.click(screen.getByRole("button", { name: "Save vehicle" }));
    await waitFor(() => expect(calls.find((c) => c.key === "PUT /units/u1/vehicle")?.body).toEqual({ vehicleNumber: "310", reason: "" }));
  });

  it("swapping a vehicle needs a reason, and the server's refusal is shown", async () => {
    const calls = fakeServer(routes([UNIT()], { "GET /units/u1/vehicle-history": [{ vehicle_number: "214", previous_vehicle_number: null, reason: null, changed_at: new Date().toISOString() }], "PUT /units/u1/vehicle": { error: "Vehicle 310 is already on Medic 2. Move it off that unit first.", __status: 409 } }));
    render(<OpsConsole session={session} />);
    expect(await screen.findByText("#214")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Swap vehicle" }));
    fireEvent.change(await screen.findByLabelText("Vehicle number"), { target: { value: "310" } });
    const save = screen.getByRole("button", { name: "Save vehicle" });
    expect(save.disabled).toBe(true);                                         // a reason is required for a swap
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Mechanical: brakes" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(await screen.findByText(/already on Medic 2/)).toBeTruthy();
    expect(calls.find((c) => c.key === "PUT /units/u1/vehicle").body.reason).toBe("Mechanical: brakes");
  });
});
