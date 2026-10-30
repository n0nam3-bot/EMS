// Renders each console in a plain browser environment (jsdom) — the first
// time any of them has run outside Claude's preview — and drives one real
// interaction through each. Network is stubbed off: the consoles reach for
// route estimates and map tiles, and a test shouldn't.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import DispatchConsole from "../consoles/dispatch_console.jsx";
import FieldUnitConsole from "../consoles/field_unit_console.jsx";
import ComplianceConsole from "../consoles/compliance_console.jsx";
import EpcrCharting from "../consoles/epcr_charting.jsx";
import App from "../App.jsx";
import TeamConsole from "../consoles/team_console.jsx";

beforeAll(async () => {
  // The same shim main.jsx loads. NO_SHIM=1 skips it, to show what breaks without it.
  if (!process.env.NO_SHIM) await import("../storage-shim.js");
  globalThis.fetch = () => Promise.reject(new Error("network is off in tests"));
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  window.location.hash = "";
});

describe("dispatch console", () => {
  it("renders the queue and unit board, starts in demo mode, and shows crew as 'employee id - full name'", async () => {
    render(<DispatchConsole />);
    expect(await screen.findByText("Citywide Dispatch")).toBeTruthy();
    expect(screen.getByText("TRANSPORT QUEUE")).toBeTruthy();
    expect(screen.getByText("UNIT BOARD")).toBeTruthy();
    expect(screen.getByText("Demo Data")).toBeTruthy();
    expect(screen.getAllByText(/4471 - Marcus Alvarez/).length).toBeGreaterThan(0);
  });

  it("Assign puts one more unit on a call", async () => {
    render(<DispatchConsole />);
    await screen.findByText("Citywide Dispatch");
    const before = screen.queryAllByRole("button", { name: "Release" }).length;
    fireEvent.click(screen.getAllByRole("button", { name: /^Assign / })[0]);
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Release" }).length).toBe(before + 1));
  });
});

describe("compliance console", () => {
  it("shows certifications, and a reviewer can approve a chart out of the queue", async () => {
    render(<ComplianceConsole />);
    expect(await screen.findByText("Compliance Console")).toBeTruthy();
    expect(screen.getByText("CERTIFICATIONS")).toBeTruthy();
    expect(screen.getByText("W. Cho — EMT-B")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /PCR Review/ }));
    expect(await screen.findByText("PCR REVIEW QUEUE")).toBeTruthy();
    const before = screen.getAllByRole("button", { name: "Approve" }).length;
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Approve" }).length).toBe(before - 1));
  });
});

describe("ePCR charting", () => {
  it("records a vitals reading into the log", async () => {
    render(<EpcrCharting />);
    expect(await screen.findByText("ePCR Charting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Vitals/ }));
    fireEvent.change(await screen.findByPlaceholderText("88"), { target: { value: "88" } });
    fireEvent.click(screen.getByRole("button", { name: /Record Vitals/ }));
    expect(await screen.findByText(/HR 88/)).toBeTruthy();
  });
});

describe("field unit console", () => {
  it("renders the assignment with a real navigation link for each map app", () => {
    render(<FieldUnitConsole />);
    expect(screen.getByText("ASSIGNED TRANSPORT")).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h.startsWith("https://www.google.com/maps/dir/"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("https://maps.apple.com/"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("https://waze.com/ul"))).toBe(true);
  });
});

// ---- Signed-in behaviour --------------------------------------------------
// A tiny fake of the server, enough to sign in and serve a company's data.
function fakeServer(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^.*\/api/, "");
    const key = `${init.method || "GET"} ${path.split("?")[0]}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404 });
    const out = typeof handler === "function" ? handler(init.body ? JSON.parse(init.body) : null) : handler;
    return new Response(JSON.stringify(out), { status: out?.__status || 200 });
  };
  return calls;
}
const LOGIN = { token: "t.t.t", expiresAt: new Date(Date.now() + 3600e3).toISOString(), user: { id: "u1", email: "boss@a.test", name: "Pat Boss", role: "supervisor" }, agency: "Acme Ambulance" };
const liveSession = (role = "supervisor") => ({ mode: "live", apiBaseUrl: "/api", token: "t.t.t", agency: "Acme Ambulance", user: { ...LOGIN.user, role } });
const INCIDENT = { incident_id: "i1", incident_type: "ift_on_demand", priority: "urgent", scene_address: "BronxCare Hospital Center", scene_detail: "Room 412", destination_text: "Montefiore Moses", patient_name: "", contact_name: "RN Pat", contact_phone: "718-555-0100", notes: "O2", capability_needed: "BLS", call_received_at: new Date().toISOString(), assigned_units: [], lat: 40.84, lon: -73.91, closed_at: null };
const UNIT = (over) => ({ unit_id: "u1", unit_designation: "Medic 1", capability_level: "ALS", current_status: "available", lat: 40.85, lon: -73.9, crew: [{ employeeId: "4471", name: "Casey Medic", role: "driver", cert: "ALS" }], ...over });

describe("sign-in", () => {
  it("starts at sign-in, shows no company or demo data, and offers a clearly separate demo", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "View demo" })).toBeTruthy();
    expect(screen.queryByText("Citywide Dispatch")).toBeNull();
  });

  it("View demo shows sample data with a DEMO banner, and no Team screen", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "View demo" }));
    expect(await screen.findByText("Citywide Dispatch")).toBeTruthy();
    expect(screen.getByText(/DEMO: sample data/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Team" })).toBeNull();
    window.location.hash = "#/field";
    expect(await screen.findByText("ASSIGNED TRANSPORT")).toBeTruthy();
  });

  it("a wrong password shows the server's message and stays on sign-in", async () => {
    fakeServer({ "POST /auth/login": { error: "Incorrect email or password", __status: 401 } });
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "boss@a.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Incorrect email or password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("signing in lands on the company's real (empty) board, never the demo, once for every tab", async () => {
    const calls = fakeServer({ "POST /auth/login": LOGIN, "GET /units": [], "GET /incidents": [], "GET /auth/me": { user: LOGIN.user, agency: "Acme Ambulance", unit: null, incident: null }, "GET /users": [], "GET /certifications": [], "GET /certification-types": [], "GET /vehicles": [], "GET /pcr-review": [] });
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "boss@a.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Citywide Dispatch")).toBeTruthy();
    expect(screen.getByText(/Acme Ambulance · Pat Boss/)).toBeTruthy();
    expect(await screen.findByText("Live")).toBeTruthy();
    expect(screen.queryByText("Demo Data")).toBeNull();
    expect(screen.queryByText(/Bruckner/)).toBeNull();
    expect(screen.queryByText(/Marcus Alvarez/)).toBeNull();
    // every tab reuses the same session: there is no per-tab connection setting
    expect(screen.queryByText("API")).toBeNull();
    for (const [hash, text] of [["#/compliance", "Compliance Console"], ["#/field", "You aren't on a unit yet."], ["#/team", "Add a person"]]) {
      window.location.hash = hash;
      expect(await screen.findByText(text)).toBeTruthy();
    }
    expect(calls.filter((c) => c.key === "POST /auth/login").length).toBe(1);
  });

  it("a crew member sees only the screens for their role", async () => {
    fakeServer({ "GET /auth/me": { user: { ...LOGIN.user, role: "crew" }, agency: "Acme Ambulance", unit: null, incident: null } });
    localStorage.setItem("ems:session", JSON.stringify({ ...LOGIN, user: { ...LOGIN.user, role: "crew" } }));
    render(<App />);
    expect(await screen.findByRole("link", { name: "Field Unit" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Dispatch" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Team" })).toBeNull();
  });

  it("an expired session goes back to sign-in", async () => {
    localStorage.setItem("ems:session", JSON.stringify({ ...LOGIN, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    render(<App />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });
});

describe("dispatch, signed in", () => {
  it("shows the real calls, with room, destination and contact, and edits go to the server", async () => {
    const calls = fakeServer({ "GET /units": [UNIT()], "GET /incidents": [INCIDENT], "PATCH /incidents/i1": { ...INCIDENT, scene_detail: "Room 500" } });
    render(<DispatchConsole session={liveSession()} />);
    expect(await screen.findByText("BronxCare Hospital Center")).toBeTruthy();
    expect(screen.getByText(/Room 412/)).toBeTruthy();
    expect(screen.getByText(/Montefiore Moses/)).toBeTruthy();
    expect(screen.getByText(/RN Pat 718-555-0100/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByDisplayValue("Room 412"), { target: { value: "Room 500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.key === "PATCH /incidents/i1" && c.body.sceneDetail === "Room 500")).toBe(true));
  });

  it("cancelling needs a reason, then tells the server", async () => {
    const calls = fakeServer({ "GET /units": [UNIT()], "GET /incidents": [INCIDENT], "POST /incidents/i1/cancel": { ...INCIDENT, closed_at: "now" } });
    render(<DispatchConsole session={liveSession()} />);
    await screen.findByText("BronxCare Hospital Center");
    fireEvent.click(screen.getByRole("button", { name: "Cancel call" }));
    const confirm = screen.getByRole("button", { name: "Confirm cancel" });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Why is it being cancelled?"), { target: { value: "Facility cancelled" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancel" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /incidents/i1/cancel" && c.body.reason === "Facility cancelled")).toBe(true));
  });

  it("calls the nearest crewed unit a SUGGESTION, shows which one, and mentions a closer unit that is finishing a call", async () => {
    fakeServer({
      "GET /units": [UNIT({ unit_id: "u1", unit_designation: "Medic 1", lat: 40.95, lon: -73.9 }), UNIT({ unit_id: "u2", unit_designation: "Medic 2", capability_level: "BLS", current_status: "at_destination", lat: 40.8405, lon: -73.9105 })],
      "GET /incidents": [INCIDENT],
    });
    render(<DispatchConsole session={liveSession()} />);
    expect(await screen.findByText("Nearest available:")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Assign Medic 1" })).toBeTruthy();
    expect(screen.queryByText(/^Primary:/)).toBeNull();
    expect(screen.getByText("Closer, but finishing a call:")).toBeTruthy();
  });

  it("never suggests a unit that has no crew, and says why", async () => {
    fakeServer({ "GET /units": [UNIT({ crew: [], current_status: "out_of_service" })], "GET /incidents": [INCIDENT] });
    render(<DispatchConsole session={liveSession()} />);
    expect(await screen.findByText(/No unit has a crew yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Assign / })).toBeNull();
  });

  it("a failed action is reported, never faked locally", async () => {
    fakeServer({ "GET /units": [UNIT()], "GET /incidents": [INCIDENT], "POST /incidents/i1/assignments": { error: "Unit is busy", __status: 409 } });
    render(<DispatchConsole session={liveSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assign Medic 1" }));
    expect(await screen.findByText("Unit is busy")).toBeTruthy();
    expect(screen.queryByText("Release")).toBeNull();
  });

  it("the map has a Standard / Dark switch", async () => {
    fakeServer({ "GET /units": [], "GET /incidents": [] });
    render(<DispatchConsole session={liveSession()} />);
    expect(await screen.findByRole("button", { name: "Standard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dark" })).toBeTruthy();
  });
});

describe("field unit, signed in", () => {
  it("knows its unit and call from the login, with no unit ID to type", async () => {
    const incident = { incident_id: "i1", priority: "urgent", scene_address: "BronxCare Hospital Center", scene_detail: "Room 412", destination_text: "Montefiore Moses", capability_needed: "BLS", role: "primary", lat: 40.84, lon: -73.91, dest_lat: null, dest_lon: null, contact_name: "RN Pat", contact_phone: "718-555-0100", notes: "O2" };
    fakeServer({ "GET /auth/me": { user: LOGIN.user, agency: "Acme Ambulance", unit: { unit_id: "u1", unit_designation: "Medic 1", capability_level: "ALS", current_status: "assigned", seat_role: "driver" }, incident } });
    render(<FieldUnitConsole session={liveSession("crew")} />);
    expect(await screen.findByText("Medic 1")).toBeTruthy();
    expect(screen.getByText("BronxCare Hospital Center")).toBeTruthy();
    expect(screen.getByText("Room 412")).toBeTruthy();
    expect(screen.getByRole("button", { name: "On scene" })).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h.includes("destination=40.84,-73.91"))).toBe(true);
    expect(hrefs.some((h) => h.includes("destination=Montefiore%20Moses"))).toBe(true); // no coordinates: falls back to the name
  });

  it("a status button updates the server", async () => {
    const calls = fakeServer({ "GET /auth/me": { user: LOGIN.user, agency: "A", unit: { unit_id: "u1", unit_designation: "Medic 1", capability_level: "ALS", current_status: "available", seat_role: "driver" }, incident: null }, "PATCH /units/u1/status": {} });
    render(<FieldUnitConsole session={liveSession("crew")} />);
    fireEvent.click(await screen.findByRole("button", { name: "En route" }));
    await waitFor(() => expect(calls.some((c) => c.key === "PATCH /units/u1/status" && c.body.status === "en_route")).toBe(true));
  });
});

describe("team admin", () => {
  it("creates a person and shows the temporary password once", async () => {
    let users = [];
    const calls = fakeServer({
      "GET /users": () => users, "GET /units": [UNIT()], "GET /certifications": [], "GET /certification-types": [{ certification_type_id: "t1", code: "PARAMEDIC", label: "Paramedic", required_for_capability: "ALS" }], "GET /vehicles": [],
      "POST /users": (b) => { users = [{ user_id: "n1", email: b.email, display_name: b.displayName, role: b.role, is_active: true, crew_member_id: "c1" }]; return users[0]; },
    });
    render(<TeamConsole session={liveSession()} />);
    fireEvent.change(await screen.findByLabelText("Full name"), { target: { value: "Casey Medic" } });
    fireEvent.change(screen.getByLabelText("Email (their sign-in name)"), { target: { value: "casey@a.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText(/Account created/)).toBeTruthy();
    await waitFor(() => expect(calls.find((c) => c.key === "POST /users").body.role).toBe("crew"));
    expect(await screen.findByText("Casey Medic")).toBeTruthy();
  });

  it("shows the server's reason when a unit assignment is refused", async () => {
    fakeServer({
      "GET /users": [{ user_id: "n1", email: "c@a.test", display_name: "Casey Medic", role: "crew", is_active: true, crew_member_id: "c1", unit_id: null }],
      "GET /units": [UNIT()], "GET /certifications": [], "GET /certification-types": [], "GET /vehicles": [],
      "PUT /crew/c1/unit": { error: "Casey Medic has no current ALS-level certification, so can't be put on Medic 1. Add their certification first.", __status: 409 },
    });
    render(<TeamConsole session={liveSession()} />);
    fireEvent.change(await screen.findByDisplayValue("Not on a unit"), { target: { value: "u1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/no current ALS-level certification/)).toBeTruthy();
  });
});
