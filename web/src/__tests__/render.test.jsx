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
import QaConsole from "../consoles/qa_console.jsx";
import OpsConsole from "../consoles/ops_console.jsx";
import ScheduleConsole, { startOfWeek } from "../consoles/schedule_console.jsx";
import ReportsConsole, { mmss } from "../consoles/reports_console.jsx";
import { effectivePosition } from "../consoles/map_kit.jsx";
import { CallDraftTray } from "../consoles/call_form.jsx";

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
    calls.push({ key, url: String(url), body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404 });
    const out = typeof handler === "function" ? handler(init.body ? JSON.parse(init.body) : null) : handler;
    return new Response(JSON.stringify(out), { status: out?.__status || 200 });
  };
  return calls;
}
const LOGIN = { kind: "tenant", token: "t.t.t", expiresAt: new Date(Date.now() + 3600e3).toISOString(), user: { id: "u1", email: "boss@a.test", name: "Pat Boss", role: "supervisor", roles: ["supervisor", "qa_qi"], fieldLevel: null }, agency: "Acme Ambulance" };
const CHK = (over = {}) => ({ required: true, owner: "the driver", due: false, last_at: new Date(Date.now() - 2 * 3600e3).toISOString(), last_by: "Dan Driver", last_result: "pass", failed_items: [], ...over });
const liveSession = (role = "supervisor", extra = {}) => ({ mode: "live", kind: "tenant", apiBaseUrl: "/api", token: "t.t.t", agency: "Acme Ambulance", user: { ...LOGIN.user, role, roles: [role], ...extra } });
const typeInto = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const INCIDENT = { incident_id: "i1", incident_type: "ift_on_demand", priority: "urgent", scene_address: "BronxCare Hospital Center", scene_detail: "Room 412", destination_text: "Montefiore Moses", patient_name: "", contact_name: "RN Pat", contact_phone: "718-555-0100", notes: "O2", capability_needed: "BLS", call_received_at: new Date().toISOString(), assigned_units: [], lat: 40.84, lon: -73.91, closed_at: null };
const UNIT = (over) => ({ unit_id: "u1", unit_designation: "Medic 1", capability_level: "ALS", current_status: "available", lat: 40.85, lon: -73.9, fleet_vehicle_id: "f1", vehicle_number: "214", crew: [{ employeeId: "4471", name: "Casey Medic", role: "driver", cert: "ALS" }], ...over });

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

  it("signing in is two steps: password, then an authenticator code; then the company's real (empty) board, never the demo, once for every tab", async () => {
    const calls = fakeServer({ "POST /auth/login": { step: "mfa", challenge: "c.c.c" }, "POST /auth/mfa/verify": LOGIN, "GET /units": [], "GET /incidents": [], "GET /auth/me": { user: LOGIN.user, agency: "Acme Ambulance", unit: null, incident: null }, "GET /users": [], "GET /certifications": [], "GET /certification-types": [], "GET /vehicles": [], "GET /pcr-review": [], "GET /checklist": [], "GET /unit-checks/status": [], "GET /qa/charts": [], "GET /ops/roster": [] });
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "boss@a.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter your code")).toBeTruthy();
    expect(screen.queryByText("Citywide Dispatch")).toBeNull();           // a password alone gets nobody in
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Citywide Dispatch")).toBeTruthy();
    expect(screen.getByText(/Acme Ambulance · Pat Boss/)).toBeTruthy();
    expect(await screen.findByText("Live")).toBeTruthy();
    expect(screen.queryByText("Demo Data")).toBeNull();
    expect(screen.queryByText(/Bruckner/)).toBeNull();
    expect(screen.queryByText(/Marcus Alvarez/)).toBeNull();
    expect(screen.queryByText("API")).toBeNull();                          // no per-tab connection setting
    for (const [hash, text] of [["#/compliance", "Compliance Console"], ["#/team", "+ Add field personnel"], ["#/qa", "QA/QI review"], ["#/ops", "OPS: units and crews"]]) {
      window.location.hash = hash;
      expect(await screen.findByText(text)).toBeTruthy();
    }
    expect(calls.filter((c) => c.key === "POST /auth/login").length).toBe(1);
  });

  it("first sign-in sets up the authenticator app and shows recovery codes before letting the person in", async () => {
    fakeServer({
      "POST /auth/login": { step: "mfa_setup", challenge: "c.c.c" },
      "POST /auth/mfa/setup": { secret: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", otpauthUrl: "otpauth://totp/EMS%20Dispatch:boss%40a.test?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" },
      "POST /auth/mfa/enable": { ...LOGIN, recoveryCodes: ["aaaa-bbbb", "cccc-dddd", "eeee-ffff", "gggg-hhhh", "jjjj-kkkk", "mmmm-nnnn", "pppp-qqqq", "rrrr-ssss"] },
      "GET /units": [], "GET /incidents": [],
    });
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "boss@a.test" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Set up two-step sign-in")).toBeTruthy();
    expect(screen.getByText("ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567")).toBeTruthy();
    expect(await screen.findByAltText(/QR code/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on and sign in" }));
    expect(await screen.findByText("Save your recovery codes")).toBeTruthy();
    expect(screen.getByText("aaaa-bbbb")).toBeTruthy();
    const go = screen.getByRole("button", { name: "Continue" });
    expect(go.disabled).toBe(true);                                         // can't skip past the codes
    fireEvent.click(screen.getByLabelText("I've saved these codes"));
    fireEvent.click(go);
    expect(await screen.findByText("Citywide Dispatch")).toBeTruthy();
  });

  it("a platform admin lands on the platform screen only", async () => {
    fakeServer({ "GET /platform/tenants": [{ tenant_id: "t1", display_name: "Acme Ambulance", regulatory_state: "NY", is_active: true, user_count: 3, unit_count: 2 }] });
    localStorage.setItem("ems:session", JSON.stringify({ kind: "platform", token: "p.p.p", expiresAt: new Date(Date.now() + 3600e3).toISOString(), user: { id: "a1", email: "root@x.test", name: "Root" } }));
    render(<App />);
    expect(await screen.findByText("Companies and accounts")).toBeTruthy();
    expect(await screen.findByText("Acme Ambulance")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Dispatch" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Team" })).toBeNull();
    expect(screen.getByText(/can't see any company's calls or patient records/)).toBeTruthy();
  });

  it("a person's screens come from ALL their roles: a dispatcher who also rides gets Dispatch and Field, and charts if EMT-level", async () => {
    fakeServer({ "GET /units": [], "GET /incidents": [], "GET /auth/me": { user: LOGIN.user, agency: "A", unit: null, incident: null }, "GET /me/stats": { assigned: 0, completed: 0, pending: 0, awaitingCorrection: 0, canChart: true }, "GET /unit-checks/status": [] });
    localStorage.setItem("ems:session", JSON.stringify({ ...LOGIN, user: { ...LOGIN.user, role: "dispatcher", roles: ["dispatcher", "crew"], fieldLevel: "emt" } }));
    render(<App />);
    expect(await screen.findByRole("link", { name: "Dispatch" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Field Unit" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "ePCR" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Team" })).toBeNull();
    expect(screen.queryByRole("link", { name: "QA/QI" })).toBeNull();
  });

  it("an MVO sees Field but never ePCR; QA/QI sees only the review screen", async () => {
    fakeServer({ "GET /auth/me": { user: LOGIN.user, agency: "A", unit: null, incident: null }, "GET /me/stats": { assigned: 0, completed: 0, pending: 0, awaitingCorrection: 0, canChart: false }, "GET /qa/charts": [] });
    localStorage.setItem("ems:session", JSON.stringify({ ...LOGIN, user: { ...LOGIN.user, role: "crew", roles: ["crew"], fieldLevel: "mvo" } }));
    const { unmount } = render(<App />);
    expect(await screen.findByRole("link", { name: "Field Unit" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "ePCR" })).toBeNull();
    unmount();
    localStorage.setItem("ems:session", JSON.stringify({ ...LOGIN, user: { ...LOGIN.user, role: "qa_qi", roles: ["qa_qi"], fieldLevel: null } }));
    render(<App />);
    expect(await screen.findByText("QA/QI review")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Dispatch" })).toBeNull();
  });

  it("an expired session goes back to sign-in", async () => {
    localStorage.setItem("ems:session", JSON.stringify({ ...LOGIN, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    render(<App />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });
});

describe("dispatch, signed in", () => {
  it("shows the essentials on one line and the rest when a call is opened; edits go to the server through the draft tray", async () => {
    const calls = fakeServer({ "GET /units": [UNIT()], "GET /incidents": [INCIDENT], "PATCH /incidents/i1": { ...INCIDENT, scene_detail: "Room 500" } });
    render(<><DispatchConsole session={liveSession()} /><CallDraftTray session={liveSession()} /></>);
    expect(await screen.findByText("BronxCare Hospital Center")).toBeTruthy();
    expect(screen.getByText(/Room 412/)).toBeTruthy();
    expect(screen.getByText(/Montefiore Moses/)).toBeTruthy();
    expect(screen.queryByText(/RN Pat 718-555-0100/)).toBeNull();           // contact and notes wait until the call is opened
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(screen.getByText("BronxCare Hospital Center"));
    expect(await screen.findByText(/RN Pat 718-555-0100/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByDisplayValue("Room 412"), { target: { value: "Room 500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(calls.some((c) => c.key === "PATCH /incidents/i1" && c.body.sceneDetail === "Room 500")).toBe(true));
  });

  it("cancelling needs a reason, then tells the server", async () => {
    const calls = fakeServer({ "GET /units": [UNIT()], "GET /incidents": [INCIDENT], "POST /incidents/i1/cancel": { ...INCIDENT, closed_at: "now" } });
    render(<DispatchConsole session={liveSession()} />);
    fireEvent.click(await screen.findByText("BronxCare Hospital Center"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel call" }));
    const confirm = screen.getByRole("button", { name: "Confirm cancel" });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Why is it being cancelled?"), { target: { value: "Facility cancelled" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm cancel" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /incidents/i1/cancel" && c.body.reason === "Facility cancelled")).toBe(true));
  });

  it("MULTITASKING: a new call is a draft in a tray, not a pop-up. The board stays usable, drafts can be minimized and several can be open at once", async () => {
    const calls = fakeServer({ "GET /units": [UNIT()], "GET /incidents": [INCIDENT], "POST /incidents": { incident_id: "i9" } });
    render(<><DispatchConsole session={liveSession()} /><CallDraftTray session={liveSession()} /></>);
    await screen.findByText("BronxCare Hospital Center");
    fireEvent.click(screen.getByRole("button", { name: /New Call/ }));
    fireEvent.change(await screen.findByPlaceholderText(/e\.g\. BronxCare/), { target: { value: "100 First Call St" } });
    // ...while the form is open, the board still responds (a modal would have blocked this)
    fireEvent.click(screen.getByRole("button", { name: "Assign Medic 1" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /incidents/i1/assignments")).toBe(true));
    // minimize it: it becomes a chip holding the address, and the form is gone
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(screen.queryByPlaceholderText(/e\.g\. BronxCare/)).toBeNull();
    expect(screen.getByRole("button", { name: "100 First Call St" })).toBeTruthy();
    // a second call can be started in parallel
    fireEvent.click(screen.getByRole("button", { name: "Start another call" }));
    fireEvent.change(await screen.findByPlaceholderText(/e\.g\. BronxCare/), { target: { value: "200 Second Call Ave" } });
    expect(screen.getByRole("button", { name: "100 First Call St" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await waitFor(() => expect(calls.filter((c) => c.key === "POST /incidents").map((c) => c.body.sceneAddress)).toEqual(["200 Second Call Ave"]));
    expect(screen.getByRole("button", { name: "100 First Call St" })).toBeTruthy();       // the first draft is still waiting
    fireEvent.click(screen.getByRole("button", { name: "100 First Call St" }));
    expect(await screen.findByDisplayValue("100 First Call St")).toBeTruthy();
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

const TEAM_ROUTES = (over = {}) => ({
  "GET /users": [], "GET /units": [UNIT()], "GET /certifications": [], "GET /certification-types": [{ certification_type_id: "t1", code: "PARAMEDIC", label: "Paramedic", required_for_capability: "ALS" }],
  "GET /vehicles": [], "GET /checklist": [], "GET /unit-checks/status": [], ...over,
});

describe("team admin", () => {
  it("field personnel: one compact line each; adding is behind a button; creates a person with a field level and shows the temporary password once", async () => {
    let users = [];
    const calls = fakeServer(TEAM_ROUTES({
      "GET /users": () => users,
      "POST /users": (b) => { users = [{ user_id: "n1", email: b.email, display_name: b.displayName, role: "crew", roles: b.roles, is_active: true, crew_member_id: "c1", field_level: b.fieldLevel, mfa_enabled: false }]; return users[0]; },
    }));
    render(<TeamConsole session={liveSession()} />);
    expect(screen.queryByLabelText("Full name")).toBeNull();                 // the form isn't cluttering the list
    fireEvent.click(await screen.findByRole("button", { name: "+ Add field personnel" }));
    fireEvent.change(await screen.findByLabelText("Full name"), { target: { value: "Casey Medic" } });
    fireEvent.change(screen.getByLabelText("Email (their sign-in name)"), { target: { value: "casey@a.test" } });
    fireEvent.change(screen.getByLabelText("Field level"), { target: { value: "paramedic" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText(/Account created/)).toBeTruthy();
    await waitFor(() => { const b = calls.find((c) => c.key === "POST /users").body; expect(b.fieldLevel).toBe("paramedic"); expect(b.roles).toContain("crew"); });
    expect(await screen.findByText("Casey Medic")).toBeTruthy();
  });

  it("a person's details stay hidden until you open them; name and email can be corrected", async () => {
    const calls = fakeServer(TEAM_ROUTES({
      "GET /users": [{ user_id: "n1", email: "casy@a.test", display_name: "Casy Medic", role: "crew", roles: ["crew"], is_active: true, crew_member_id: "c1", field_level: "emt", unit_id: null, mfa_enabled: true }],
      "PATCH /users/n1": { user_id: "n1" },
    }));
    render(<TeamConsole session={liveSession()} />);
    expect(await screen.findByText("Casy Medic")).toBeTruthy();
    expect(screen.queryByText("Reset password")).toBeNull();                 // collapsed
    expect(screen.queryByDisplayValue("casy@a.test")).toBeNull();
    fireEvent.click(screen.getByText("Casy Medic"));
    fireEvent.change(await screen.findByDisplayValue("casy@a.test"), { target: { value: "casey@a.test" } });
    fireEvent.change(screen.getByDisplayValue("Casy Medic"), { target: { value: "Casey Medic" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(calls.some((c) => c.key === "PATCH /users/n1" && c.body.email === "casey@a.test" && c.body.displayName === "Casey Medic")).toBe(true));
  });

  it("long lists: searching asks the server for matches and shows the total", async () => {
    const calls = fakeServer(TEAM_ROUTES({ "GET /users": [] }));
    render(<TeamConsole session={liveSession()} />);
    fireEvent.change(await screen.findByPlaceholderText(/Search name, email or employee/), { target: { value: "reyes" } });
    await waitFor(() => expect(calls.some((c) => c.key === "GET /users" && c.url.includes("q=reyes") && c.url.includes("kind=field") && c.url.includes("limit=25"))).toBe(true));
    expect(await screen.findByText("Nobody matches that search.")).toBeTruthy();
  });

  it("office personnel: pick one or more roles, and optionally mark that they also work on a unit", async () => {
    const calls = fakeServer(TEAM_ROUTES({ "POST /users": (b) => ({ user_id: "n2", ...b }) }));
    render(<TeamConsole session={liveSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Office personnel" }));
    fireEvent.click(await screen.findByRole("button", { name: "+ Add office personnel" }));
    fireEvent.change(await screen.findByLabelText("Full name"), { target: { value: "Dana Dispatcher" } });
    fireEvent.change(screen.getByLabelText("Email (their sign-in name)"), { target: { value: "dana@a.test" } });
    fireEvent.click(screen.getByLabelText("QA/QI"));
    fireEvent.click(screen.getByLabelText("Also works on a unit"));
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => { const b = calls.find((c) => c.key === "POST /users").body; expect(b.roles).toEqual(["dispatcher", "qa_qi", "crew"]); expect(b.fieldLevel).toBe("emt"); });
  });

  it("shows the server's reason when a unit assignment is refused", async () => {
    fakeServer(TEAM_ROUTES({
      "GET /users": [{ user_id: "n1", email: "c@a.test", display_name: "Casey Medic", role: "crew", roles: ["crew"], is_active: true, crew_member_id: "c1", field_level: "paramedic", unit_id: null, mfa_enabled: true }],
      "PUT /crew/c1/unit": { error: "Casey Medic is a paramedic with no current ALS-level certification, so can't be put on Medic 1. Add their certification first.", __status: 409 },
    }));
    render(<TeamConsole session={liveSession()} />);
    fireEvent.click(await screen.findByText("Casey Medic"));
    fireEvent.change(await screen.findByDisplayValue("Not on a unit"), { target: { value: "u1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/no current ALS-level certification/)).toBeTruthy();
  });

  it("units & inspections: one headline per unit, the three checks by who owns them when opened, and a warning that the starter checklist isn't the agency's real inventory", async () => {
    fakeServer(TEAM_ROUTES({
      "GET /checklist": [{ item_id: "i1", label: "Oxygen supply adequate", category: "Oxygen and airway", applies_to: "BLS", section: "equipment", min_quantity: null, is_active: true, source: "starter" }],
      "GET /unit-checks/status": [{ unit_id: "u1", unit_designation: "Medic 1", capability_level: "ALS", crew_count: 2, check_due: false, any_failed: true, fleet_vehicle_id: "f1", vehicle_number: "214",
        checks: { vehicle: CHK(), bls: CHK({ owner: "an EMT or above", last_by: "Eli Emt" }), als: CHK({ owner: "the paramedic", last_by: "Pat Medic", last_result: "fail", failed_items: ["Suction working"] }) },
        periodic: [{ kind: "dmv_inspection", performedAt: "2026-06-01T00:00:00Z", result: "pass", nextDue: "2027-06-01" }] }],
    }));
    render(<TeamConsole session={liveSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Units & inspections" }));
    expect(await screen.findByText("Check failed")).toBeTruthy();            // the closed row shows only the headline
    expect(screen.getByText("Vehicle 214")).toBeTruthy();
    expect(screen.queryByText(/Suction working/)).toBeNull();
    fireEvent.click(screen.getByText("Medic 1"));
    expect(await screen.findByText(/ALS equipment check \(the paramedic\)/)).toBeTruthy();
    expect(screen.getByText(/FAILED 2 h ago by Pat Medic: Suction working/)).toBeTruthy();
    expect(screen.getByText(/Vehicle check \(the driver\)/)).toBeTruthy();
    expect(screen.getByText(/DMV inspection \(vehicle 214\)/)).toBeTruthy();
    expect(screen.getByText(/not your agency's required equipment/)).toBeTruthy();
    expect(screen.getByText(/Part 800/)).toBeTruthy();
  });

  it("vehicles: listed with the unit using each, added, and taken out of service only with a reason", async () => {
    const calls = fakeServer(TEAM_ROUTES({
      "GET /fleet": [{ fleet_vehicle_id: "f1", vehicle_number: "214", make_model: "Ford F-450", plate: "ABC123", status: "in_service", unit_id: "u1", unit_designation: "Medic 1", next_inspection_due: "2027-06-01" }, { fleet_vehicle_id: "f2", vehicle_number: "215", status: "in_service", unit_id: null }],
      "POST /fleet": { fleet_vehicle_id: "f3" }, "POST /fleet/f2/out-of-service": { ok: true },
    }));
    render(<TeamConsole session={liveSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Vehicles" }));
    expect(await screen.findByText("Vehicle 214")).toBeTruthy();
    expect(screen.getByText("on Medic 1")).toBeTruthy();
    expect(screen.getByText("not assigned")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ Add vehicle" }));
    fireEvent.change(screen.getByLabelText("Vehicle number"), { target: { value: "216" } });
    fireEvent.click(screen.getByRole("button", { name: "Add vehicle" }));
    await waitFor(() => expect(calls.find((c) => c.key === "POST /fleet")?.body.vehicleNumber).toBe("216"));
    fireEvent.click(screen.getByText("Vehicle 215"));
    fireEvent.click(await screen.findByRole("button", { name: "Mark out of service" }));
    const confirm = screen.getAllByRole("button", { name: "Mark out of service" }).pop();
    expect(confirm.disabled).toBe(true);                                     // no reason, no button
    fireEvent.change(screen.getByPlaceholderText(/Why\?/), { target: { value: "Overheating" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Mark out of service" }).pop());
    await waitFor(() => expect(calls.find((c) => c.key === "POST /fleet/f2/out-of-service")?.body).toEqual({ reason: "Overheating" }));
  });
});

describe("QA/QI review", () => {
  const CHART = { pcr_id: "p1", status: "submitted", scene_address: "5 Chart Ave", scene_detail: null, unit_designation: "Medic 1", clinical_narrative: "Found patient seated.", vitals: [{ vital_id: "v1", recorded_at: new Date().toISOString(), heart_rate: 88, bp_systolic: 120, bp_diastolic: 80 }], procedures: [], medications: [], disposition: null, crew: [{ user_id: "e1", name: "Eli Emt", field_level: "emt" }, { user_id: "m1", name: "Dan Driver", field_level: "mvo" }], events: [{ kind: "submitted", at: new Date().toISOString(), actor: "Eli Emt" }], access: "review" };
  it("lists submitted charts, opens one, and sends it back to a named clinical crew member with a note", async () => {
    const calls = fakeServer({
      "GET /qa/charts": [{ pcr_id: "p1", status: "submitted", submitted_at: new Date().toISOString(), scene_address: "5 Chart Ave", unit_designation: "Medic 1", crew: "Eli Emt, Pat Medic", passed: 2, total: 5, failed: ["has_disposition"] }],
      "GET /pcr/p1": CHART, "POST /pcr/p1/reopen": { ok: true },
    });
    render(<QaConsole session={liveSession("qa_qi")} />);
    expect(await screen.findByText("5 Chart Ave")).toBeTruthy();
    expect(screen.getByText(/No disposition recorded/)).toBeTruthy();
    fireEvent.click(screen.getByText("5 Chart Ave"));
    expect(await screen.findByText("Found patient seated.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send back for correction" }));
    const send = screen.getByRole("button", { name: "Send back" });
    expect(send.disabled).toBe(true);                                       // needs a person and a reason
    const select = screen.getByRole("combobox");
    expect([...select.options].map((o) => o.text)).toEqual(["Choose a crew member…", "Eli Emt (EMT)"]);   // the MVO isn't offered
    fireEvent.change(select, { target: { value: "e1" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Add the second set of vitals" } });
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /pcr/p1/reopen" && c.body.assignToUserId === "e1" && /second set/.test(c.body.note))).toBe(true));
  });
});

describe("ePCR, signed in", () => {
  it("shows the crew member's own counts, corrections QA sent back, and calls still needing a chart; never submitted charts", async () => {
    fakeServer({
      "GET /me/stats": { assigned: 12, completed: 9, pending: 3, awaitingCorrection: 1, canChart: true },
      "GET /pcr/mine": { canChart: true,
        charts: [{ pcr_id: "p1", status: "reopened", reopen_note: "Add the second set of vitals", scene_address: "5 Chart Ave", incident_id: "i1", priority: "urgent", unit_designation: "Medic 1" }, { pcr_id: "p2", status: "draft", scene_address: "9 Draft St", incident_id: "i2", priority: "routine", unit_designation: "Medic 1" }],
        calls: [{ incident_id: "i3", unit_id: "u1", scene_address: "77 New Call Rd", priority: "critical", unit_designation: "Medic 1" }] },
    });
    render(<EpcrCharting session={liveSession("crew", { fieldLevel: "emt", roles: ["crew"] })} />);
    expect(await screen.findByText("Calls assigned")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("9")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("SENT BACK FOR CORRECTION")).toBeTruthy();
    expect(screen.getByText("Add the second set of vitals")).toBeTruthy();
    expect(screen.getByText("9 Draft St")).toBeTruthy();
    expect(screen.getByText("77 New Call Rd")).toBeTruthy();
  });

  it("submitting names what's missing first, then locks the chart", async () => {
    const calls = fakeServer({
      "GET /me/stats": { assigned: 1, completed: 0, pending: 1, awaitingCorrection: 0, canChart: true },
      "GET /pcr/mine": { canChart: true, charts: [], calls: [{ incident_id: "i3", unit_id: "u1", scene_address: "77 New Call Rd", priority: "critical", unit_designation: "Medic 1" }] },
      "POST /pcr": { pcr_id: "p9", status: "draft" },
      "GET /pcr/p9": { pcr_id: "p9", status: "draft", clinical_narrative: "", vitals: [], procedures: [], medications: [], disposition: null, events: [], crew: [] },
      "POST /pcr/p9/submit": (b) => (b.acknowledgeMissing ? { ok: true } : { error: "This chart is missing some information.", missing: ["has_disposition"], __status: 409 }),
    });
    render(<EpcrCharting session={liveSession("crew", { fieldLevel: "emt", roles: ["crew"] })} />);
    fireEvent.click(await screen.findByText("77 New Call Rd"));
    fireEvent.click(await screen.findByRole("button", { name: "Submit ePCR" }));
    expect(await screen.findByText(/missing some information/)).toBeTruthy();
    expect(screen.getByText(/No disposition recorded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Submit anyway" }));
    expect(await screen.findByText(/Chart submitted and locked/)).toBeTruthy();
    expect(calls.some((c) => c.key === "POST /pcr/p9/submit" && c.body.acknowledgeMissing === true)).toBe(true);
  });

  it("a reopened chart opens with what was already saved and the QA/QI note", async () => {
    fakeServer({
      "GET /me/stats": { assigned: 1, completed: 0, pending: 1, awaitingCorrection: 1, canChart: true },
      "GET /pcr/mine": { canChart: true, charts: [{ pcr_id: "p9", status: "reopened", reopen_note: "Add the second set of vitals", scene_address: "5 Chart Ave", incident_id: "i1", priority: "urgent", unit_designation: "Medic 1" }], calls: [] },
      "POST /pcr": { pcr_id: "p9", status: "reopened" },
      "GET /pcr/p9": { pcr_id: "p9", status: "reopened", reopen_note: "Add the second set of vitals", clinical_narrative: "Found patient seated.", vitals: [{ vital_id: "v1", recorded_at: new Date().toISOString(), heart_rate: 88, bp_systolic: 120, bp_diastolic: 80 }], procedures: [], medications: [], disposition: null, events: [], crew: [] },
    });
    render(<EpcrCharting session={liveSession("crew", { fieldLevel: "emt", roles: ["crew"] })} />);
    fireEvent.click(await screen.findByText("5 Chart Ave"));
    expect(await screen.findByText(/QA\/QI sent this chart back to you for correction/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resubmit ePCR" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Vitals/ }));
    expect(await screen.findByText(/BP 120\/80/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();   // a mistaken saved entry can be removed
  });
});

describe("field unit: profile and unit check", () => {
  it("shows the three counts (and no chart counts for an MVO), and a failing item needs a note before the check can be submitted", async () => {
    const calls = fakeServer({
      "GET /auth/me": { user: LOGIN.user, agency: "A", unit: { unit_id: "u1", unit_designation: "Medic 1", capability_level: "ALS", current_status: "available", seat_role: "driver" }, incident: null },
      "GET /me/stats": { assigned: 4, completed: 0, pending: 0, awaitingCorrection: 0, canChart: false },
      "GET /unit-checks/status": [{ unit_id: "u1", fleet_vehicle_id: "f1", vehicle_number: "214", crew_count: 2, check_due: true, any_failed: false, checks: { vehicle: { required: true, owner: "the driver", due: true, last_at: null, failed_items: [] }, bls: { required: true, owner: "an EMT or above", due: false, last_at: new Date().toISOString(), last_by: "Eli Emt", last_result: "pass", failed_items: [] }, als: { required: true, owner: "the paramedic", due: false, last_at: new Date().toISOString(), last_by: "Pat Medic", last_result: "pass", failed_items: [] } }, periodic: [] }],
      "GET /checklist": [{ item_id: "i1", label: "Oxygen supply adequate", category: "Oxygen and airway", min_quantity: null }, { item_id: "i2", label: "Suction working", category: "Oxygen and airway", min_quantity: 1 }],
      "POST /unit-checks": { result: "fail", failedItems: ["Suction working"] },
    });
    render(<FieldUnitConsole session={liveSession("crew", { fieldLevel: "mvo", roles: ["crew"] })} />);
    expect(await screen.findByText("MY CALLS")).toBeTruthy();
    expect(screen.getByText("Assigned")).toBeTruthy();
    expect(screen.queryByText("Completed ePCRs")).toBeNull();
    expect(screen.getByText(/MVOs don't write patient charts/)).toBeTruthy();
    // an MVO who is driving owns the VEHICLE check only; the equipment checks belong to the EMT and the paramedic
    expect(await screen.findAllByRole("button", { name: "Do the check" })).toHaveLength(1);
    expect(screen.getByText(/VEHICLE CHECK · VEHICLE 214/)).toBeTruthy();
    expect(screen.getByText("Done by an EMT on this unit.")).toBeTruthy();
    expect(screen.getByText("Done by the paramedic on this unit.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Do the check" }));
    await screen.findByText("Oxygen supply adequate");
    const submit = screen.getByRole("button", { name: "Submit check" });
    expect(submit.disabled).toBe(true);
    const [ok1] = screen.getAllByRole("button", { name: "OK" });
    fireEvent.click(ok1);
    const notOk = screen.getAllByRole("button", { name: "Not OK" })[1];
    fireEvent.click(notOk);
    expect(submit.disabled).toBe(true);                                      // not OK needs a note
    fireEvent.change(screen.getByPlaceholderText("What's wrong?"), { target: { value: "Strap frayed" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls.some((c) => c.key === "POST /unit-checks" && c.body.kind === "vehicle" && c.body.items.some((i) => i.ok === false && i.note === "Strap frayed"))).toBe(true));
    expect(calls.find((c) => c.key === "GET /checklist").url).toContain("kind=vehicle");
    expect(await screen.findByText(/flagged for your supervisor/)).toBeTruthy();
  });
});

describe("OPS: crewing units", () => {
  const crew = (name, level, role, id) => ({ employeeId: "1", name, role, cert: null, crewMemberId: id, fieldLevel: level });
  const U = (over) => ({ unit_id: "u1", unit_designation: "Medic 1", capability_level: "ALS", current_status: "out_of_service", crew: [], ...over });
  const dropData = (p) => ({ getData: () => JSON.stringify(p), setData() {}, effectAllowed: "" });

  it("lists every unit with what it still needs, and the people who aren't on one", async () => {
    fakeServer({
      "GET /units": [U({ crew: [crew("Pat Medic", "paramedic", "non_driver", "c1")] }), U({ unit_id: "u2", unit_designation: "Ambulance 2", capability_level: "BLS", current_status: "available", crew: [crew("Dan Driver", "mvo", "driver", "c2"), crew("Eli Emt", "emt", "non_driver", "c3")] })],
      "GET /ops/roster": [{ crew_member_id: "c9", name: "Una Free", field_level: "emt", employee_number: "7" }],
      "GET /unit-checks/status": [{ unit_id: "u2", crew_count: 2, check_due: true, last_check_at: null, failed_items: [], periodic: [] }],
    });
    render(<OpsConsole session={liveSession()} />);
    expect(await screen.findByText("Medic 1")).toBeTruthy();
    expect(screen.getByText("Needs a driver to take calls.")).toBeTruthy();          // a paramedic alone: no driver yet
    expect(screen.getByText("Check due")).toBeTruthy();                              // Ambulance 2 has a crew and no check
    expect(screen.getByText("Una Free")).toBeTruthy();
    expect(screen.getByText("NOT ON A UNIT (1)")).toBeTruthy();
  });

  it("dropping an MVO on a unit makes them the driver; dropping an EMT next to a paramedic on an ALS unit with no driver makes the EMT the driver; otherwise non-driver", async () => {
    const calls = fakeServer({
      "GET /units": [U({ crew: [crew("Pat Medic", "paramedic", "non_driver", "c1")] }), U({ unit_id: "u3", unit_designation: "Ambulance 3", capability_level: "BLS", crew: [] })],
      "GET /ops/roster": [{ crew_member_id: "c8", name: "Dan Driver", field_level: "mvo" }, { crew_member_id: "c9", name: "Eli Emt", field_level: "emt" }],
      "GET /unit-checks/status": [], "PUT /crew/c8/unit": {}, "PUT /crew/c9/unit": {},
    });
    render(<OpsConsole session={liveSession()} />);
    await screen.findByText("Medic 1");
    const card = (name) => screen.getByText(name).closest("div[class*='rounded-lg']");
    fireEvent.drop(card("Medic 1"), { dataTransfer: dropData({ crewMemberId: "c8", level: "mvo", fromUnitId: null }) });
    await waitFor(() => expect(calls.find((c) => c.key === "PUT /crew/c8/unit")?.body).toEqual({ unitId: "u1", seatRole: "driver" }));
    fireEvent.drop(card("Medic 1"), { dataTransfer: dropData({ crewMemberId: "c9", level: "emt", fromUnitId: null }) });
    await waitFor(() => expect(calls.find((c) => c.key === "PUT /crew/c9/unit")?.body).toEqual({ unitId: "u1", seatRole: "driver" }));   // EMT-driver paired with the paramedic
    fireEvent.drop(card("Ambulance 3"), { dataTransfer: dropData({ crewMemberId: "c9", level: "emt", fromUnitId: null }) });
    await waitFor(() => expect(calls.filter((c) => c.key === "PUT /crew/c9/unit").pop().body).toEqual({ unitId: "u3", seatRole: "non_driver" }));
  });

  it("on a phone there's no dragging: tap a person, then tap the unit. A server refusal is shown in words", async () => {
    const calls = fakeServer({
      "GET /units": [U({ unit_designation: "Medic 1", crew: [crew("Pat Medic", "paramedic", "non_driver", "c1"), crew("Dan Driver", "mvo", "driver", "c2"), crew("Eli Emt", "emt", "non_driver", "c3")] })],
      "GET /ops/roster": [{ crew_member_id: "c9", name: "Una Free", field_level: "emt" }], "GET /unit-checks/status": [],
      "PUT /crew/c9/unit": { error: "Medic 1 already has 3 crew. Take someone off first.", __status: 409 },
    });
    render(<OpsConsole session={liveSession()} />);
    fireEvent.click(await screen.findByText("Una Free"));
    expect(screen.getByText(/Placing/)).toBeTruthy();
    fireEvent.click(screen.getByText("Medic 1"));
    expect(await screen.findByText(/already has 3 crew/)).toBeTruthy();
    expect(calls.find((c) => c.key === "PUT /crew/c9/unit").body.unitId).toBe("u1");
  });

  it("the D badge swaps driver / non-driver, an MVO's can't be changed, and ✕ takes someone off", async () => {
    const calls = fakeServer({
      "GET /units": [U({ unit_designation: "Medic 1", crew: [crew("Dan Driver", "mvo", "driver", "c2"), crew("Eli Emt", "emt", "non_driver", "c3")] })],
      "GET /ops/roster": [], "GET /unit-checks/status": [], "PATCH /crew/c3/seat": {}, "PUT /crew/c3/unit": {},
    });
    render(<OpsConsole session={liveSession()} />);
    await screen.findByText("Eli Emt");
    fireEvent.click(screen.getByTitle("An MVO always drives"));
    fireEvent.click(screen.getByTitle("Tap to make driver"));
    await waitFor(() => expect(calls.find((c) => c.key === "PATCH /crew/c3/seat")?.body).toEqual({ seatRole: "driver" }));
    expect(calls.some((c) => c.key === "PATCH /crew/c2/seat")).toBe(false);
    fireEvent.click(screen.getByLabelText("Take Eli Emt off Medic 1"));
    await waitFor(() => expect(calls.find((c) => c.key === "PUT /crew/c3/unit")?.body).toEqual({ unitId: null }));
  });
});

describe("field unit: due check and new-call alert", () => {
  it("tells the crew their unit check is due", async () => {
    fakeServer({
      "GET /auth/me": { user: LOGIN.user, agency: "A", unit: { unit_id: "u1", unit_designation: "Medic 1", capability_level: "ALS", current_status: "available", seat_role: "driver" }, incident: null },
      "GET /me/stats": { assigned: 0, completed: 0, pending: 0, awaitingCorrection: 0, canChart: true },
      "GET /unit-checks/status": [{ unit_id: "u1", fleet_vehicle_id: "f1", vehicle_number: "214", crew_count: 2, check_due: true, any_failed: false, checks: { vehicle: { required: true, owner: "the driver", due: true, last_at: null, failed_items: [] }, bls: { required: true, owner: "an EMT or above", due: true, last_at: new Date().toISOString(), last_by: "Eli Emt", last_result: "pass", failed_items: [] }, als: { required: true, owner: "the paramedic", due: false, last_at: new Date().toISOString(), last_by: "Pat Medic", last_result: "pass", failed_items: [] } }, periodic: [] }],
    });
    render(<FieldUnitConsole session={liveSession("crew", { fieldLevel: "emt", roles: ["crew"] })} />);
    // this EMT is also the driver: their vehicle check AND BLS equipment check are due, but not the paramedic's ALS check
    expect(await screen.findByText(/Your vehicle check and BLS equipment check are due/)).toBeTruthy();
    expect(screen.queryByText(/ALS equipment check are due/)).toBeNull();
  });
});

describe("ePCR starts from what dispatch knows", () => {
  it("fills the destination from the call's saved place and the times from the unit's status history", async () => {
    fakeServer({
      "GET /me/stats": { assigned: 1, completed: 0, pending: 1, awaitingCorrection: 0, canChart: true },
      "GET /pcr/mine": { canChart: true, charts: [], calls: [{ incident_id: "i3", unit_id: "u1", scene_address: "77 New Call Rd", priority: "critical", unit_designation: "Medic 1" }] },
      "POST /pcr": { pcr_id: "p9", status: "draft" }, "GET /facilities": [{ facility_id: "f1", name: "BronxCare Hospital Center" }],
      "GET /pcr/p9": { pcr_id: "p9", status: "draft", clinical_narrative: "", vitals: [], procedures: [], medications: [], disposition: null, events: [], crew: [],
        call: { destination_facility_id: "f1", destination_facility_name: "BronxCare Hospital Center" }, times: { dispatchedAt: "2026-11-01T14:02:00", enRouteAt: "2026-11-01T14:04:00", onSceneAt: "2026-11-01T14:11:00", leftSceneAt: null } },
    });
    render(<EpcrCharting session={liveSession("crew", { fieldLevel: "emt", roles: ["crew"] })} />);
    fireEvent.click(await screen.findByText("77 New Call Rd"));
    fireEvent.click(await screen.findByRole("button", { name: /Disposition/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Transported" }));
    expect(await screen.findByRole("button", { name: "BronxCare Hospital Center" })).toBeTruthy();   // their saved places are the choices
    expect(screen.getByDisplayValue("14:02")).toBeTruthy();
    expect(screen.getByDisplayValue("14:11")).toBeTruthy();
  });
});

describe("schedule", () => {
  const monday = startOfWeek(new Date());
  const at = (dayOffset, h) => { const d = new Date(monday); d.setDate(d.getDate() + dayOffset); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const SHIFT = { shift_id: "s1", crew_member_id: "c1", name: "Pat Medic", field_level: "paramedic", unit_id: "u1", unit_designation: "Medic 1", seat_role: null, starts_at: at(1, 7), ends_at: at(1, 19), notes: null };

  it("weeks start on Monday", () => { expect(startOfWeek(new Date(2026, 10, 4, 15, 30)).getDay()).toBe(1); expect(startOfWeek(new Date(2026, 10, 1)).getDate()).toBe(26); /* Sun Nov 1 -> Mon Oct 26 */ });

  it("shows a week by unit with each shift's time, and lets a shift be opened, saved and deleted", async () => {
    const calls = fakeServer({ "GET /schedule": [SHIFT], "GET /units": [UNIT()], "PATCH /schedule/s1": { ok: true }, "DELETE /schedule/s1": { ok: true } });
    render(<ScheduleConsole session={liveSession()} />);
    expect(await screen.findByText("Pat Medic")).toBeTruthy();
    expect(screen.getByText("07:00–19:00")).toBeTruthy();
    expect(screen.getByText("No unit yet")).toBeTruthy();
    fireEvent.click(screen.getByText("Pat Medic"));
    expect(await screen.findByText("Edit shift: Pat Medic")).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue("12 hours"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save shift" }));
    await waitFor(() => { const c = calls.find((x) => x.key === "PATCH /schedule/s1"); expect(c).toBeTruthy(); expect(new Date(c.body.endsAt) - new Date(c.body.startsAt)).toBe(10 * 3600000); });
    fireEvent.click(await screen.findByText("Pat Medic"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete shift" }));
    await waitFor(() => expect(calls.some((x) => x.key === "DELETE /schedule/s1")).toBe(true));
  });

  it("adds the same shift for several days in a row, and says plainly when it clashes with another of that person's shifts", async () => {
    let clash = true;
    const calls = fakeServer({
      "GET /schedule": [], "GET /units": [UNIT()],
      "GET /ops/roster": [{ crew_member_id: "c1", name: "Pat Medic", field_level: "paramedic" }],
      "POST /schedule": () => (clash ? { error: "Pat Medic already has a shift that overlaps.", conflict: { startsAt: at(2, 7), endsAt: at(2, 19) }, __status: 409 } : { created: 3, shiftIds: [] }),
    });
    render(<ScheduleConsole session={liveSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Add shift" }));
    fireEvent.change(await screen.findByPlaceholderText("Search field staff…"), { target: { value: "pat" } });
    fireEvent.click(await screen.findByText("Pat Medic", { selector: "span" }));
    fireEvent.change(screen.getByLabelText("Repeat for (days in a row)"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "u1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add shift" }));
    expect(await screen.findByText(/already has a shift that overlaps/)).toBeTruthy();
    expect(screen.getByText(/existing shift:/)).toBeTruthy();
    clash = false;
    fireEvent.click(screen.getByRole("button", { name: "Add shift" }));
    await waitFor(() => { const body = calls.filter((x) => x.key === "POST /schedule").pop().body; expect(body.occurrences.length).toBe(3); expect(body.unitId).toBe("u1"); expect(body.crewMemberId).toBe("c1"); });
    // each day is the same clock time
    const occ = calls.filter((x) => x.key === "POST /schedule").pop().body.occurrences;
    expect(new Set(occ.map((o) => new Date(o.startsAt).getHours())).size).toBe(1);
  });
});

describe("OPS and the schedule", () => {
  const crew = (name, level, role, id) => ({ employeeId: "1", name, role, cert: null, crewMemberId: id, fieldLevel: level });
  it("lists people on duty first, and 'Crew units as scheduled' shows the plan before changing anything", async () => {
    const calls = fakeServer({
      "GET /units": [{ unit_id: "u1", unit_designation: "Medic 7", capability_level: "ALS", current_status: "out_of_service", crew: [crew("Extra Emt", "emt", "non_driver", "c5")] }],
      "GET /ops/roster": [
        { crew_member_id: "c1", name: "Pat Medic", field_level: "paramedic", on_duty: true, shift_unit: "Medic 7", shift_ends_at: new Date(Date.now() + 5 * 3600e3).toISOString() },
        { crew_member_id: "c2", name: "Off Duty", field_level: "emt", on_duty: false },
      ],
      "GET /unit-checks/status": [],
      "POST /schedule/apply": (b) => (b.dryRun ? { dryRun: true, remove: [{ crewMemberId: "c5", name: "Extra Emt", unit: "Medic 7" }], place: [{ crewMemberId: "c1", name: "Pat Medic", unit: "Medic 7", seat: "non_driver" }] } : { removed: 1, placed: 1, skipped: [] }),
    });
    render(<OpsConsole session={liveSession()} />);
    expect(await screen.findByText("Pat Medic")).toBeTruthy();
    expect(screen.queryByText("Off Duty")).toBeNull();                         // on-duty by default
    expect(screen.getByText(/scheduled: Medic 7/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Everyone (2)" }));
    expect(await screen.findByText("Off Duty")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Crew units as scheduled" }));
    expect(await screen.findByText(/off Medic 7/)).toBeTruthy();
    expect(screen.getByText(/Put/)).toBeTruthy();
    expect(calls.filter((c) => c.key === "POST /schedule/apply").every((c) => c.body.dryRun === true)).toBe(true);   // nothing applied yet
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/1 placed, 1 taken off/)).toBeTruthy();
    expect(screen.getByText(/pick a vehicle for the crewed unit that still needs one/)).toBeTruthy();   // a vehicle goes with the crew, and scheduled crewing can't choose one
  });
});

describe("reports", () => {
  it("formats seconds as minutes:seconds", () => { expect(mmss(null)).toBe("–"); expect(mmss(0)).toBe("0:00"); expect(mmss(65)).toBe("1:05"); expect(mmss(599.6)).toBe("10:00"); });
  it("shows response intervals by priority with an honest explanation of what's missing", async () => {
    const calls = fakeServer({ "GET /reports/response": { days: 30, cancelled: 2, totalCalls: 14, daily: [{ day: "2026-10-30", calls: 6 }, { day: "2026-10-31", calls: 8 }],
      byPriority: [{ priority: "critical", calls: 4, timed: 3, dispatchMedian: 42, dispatchP90: 95, turnoutMedian: 60, turnoutP90: 120, travelMedian: 300, travelP90: 480, responseMedian: 420, responseP90: 700 }, { priority: "routine", calls: 10, timed: 0, dispatchMedian: null, dispatchP90: null, turnoutMedian: null, turnoutP90: null, travelMedian: null, travelP90: null, responseMedian: null, responseP90: null }] } });
    render(<ReportsConsole session={liveSession()} />);
    expect(await screen.findByText("Critical")).toBeTruthy();
    expect(screen.getByText("7:00 / 11:40")).toBeTruthy();                      // response median / 90th
    expect(screen.getAllByText("– / –").length).toBe(4);                  // routine has no timed calls: all four intervals blank, not zero
    expect(screen.getByText(/missed taps counts as a call but isn't timed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("days=7"))).toBe(true));
  });
});

describe("field unit: shifts", () => {
  it("shows the crew member's upcoming shifts", async () => {
    fakeServer({
      "GET /auth/me": { user: LOGIN.user, agency: "A", unit: null, incident: null },
      "GET /schedule/mine": [{ shift_id: "s1", starts_at: new Date(Date.now() + 86400e3).toISOString(), ends_at: new Date(Date.now() + 86400e3 + 12 * 3600e3).toISOString(), unit_designation: "Medic 7", seat_role: "driver" }],
    });
    render(<FieldUnitConsole session={liveSession("crew", { fieldLevel: "emt", roles: ["crew"] })} />);
    expect(await screen.findByText("MY SHIFTS")).toBeTruthy();
    expect(screen.getByText("Medic 7 · driver")).toBeTruthy();
  });
});

describe("map positions without GPS", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const call = { lat: 40.84, lon: -73.91, destLat: 40.86, destLon: -73.89 };
  const unit = (over) => ({ lat: 40.8, lon: -73.95, status: "available", locationUpdatedAt: null, ...over });
  it("a recent GPS fix wins; otherwise the unit is placed where its status says it must be, marked as an estimate", () => {
    const fresh = effectivePosition(unit({ status: "on_scene", locationUpdatedAt: "2026-11-03T11:58:00Z" }), call, now);
    expect(fresh).toMatchObject({ lat: 40.8, lon: -73.95, estimated: false, basis: "GPS" });
    const stale = "2026-11-03T09:00:00Z";
    expect(effectivePosition(unit({ status: "on_scene", locationUpdatedAt: stale }), call, now)).toMatchObject({ lat: 40.84, lon: -73.91, estimated: true });          // at the pickup
    expect(effectivePosition(unit({ status: "at_destination", locationUpdatedAt: stale }), call, now)).toMatchObject({ lat: 40.86, lon: -73.89, estimated: true });    // at the DROP-OFF
    const transit = effectivePosition(unit({ status: "transporting", locationUpdatedAt: stale }), call, now);
    expect(transit.lat).toBeCloseTo(40.85, 5); expect(transit.lon).toBeCloseTo(-73.9, 5); expect(transit.estimated).toBe(true);                                         // half-way
    expect(effectivePosition(unit({ status: "en_route", locationUpdatedAt: stale }), call, now)).toMatchObject({ lat: 40.8, lon: -73.95, basis: "last known position" });
    expect(effectivePosition(unit({ status: "at_destination", locationUpdatedAt: stale }), { lat: 40.84, lon: -73.91 }, now)).toMatchObject({ lat: 40.84, lon: -73.91 });   // no drop-off pinned: the pickup
    expect(effectivePosition({ lat: null, lon: null, status: "available" }, null, now)).toBeNull();
    expect(effectivePosition(unit({ status: "available" }), null, now)).toMatchObject({ estimated: false });                                                           // demo/no timestamp: trusted
  });
});

describe("address search and the trip preview", () => {
  const RESULTS = [
    { label: "475 Grand Ave, Palisades Park, NJ 07650", lat: 40.8481, lon: -73.9969, precision: "address", approximate: false },
    { label: "Grand Avenue, Palisades Park, NJ 07650", lat: 40.847, lon: -73.995, precision: "street", approximate: true },
  ];
  const openForm = async () => {
    render(<><DispatchConsole session={liveSession()} /><CallDraftTray session={liveSession()} /></>);
    await screen.findByRole("button", { name: /New Call/ });
    fireEvent.click(screen.getByRole("button", { name: /New Call/ }));
    const pickup = await screen.findByPlaceholderText(/e\.g\. BronxCare/);
    fireEvent.change(pickup, { target: { value: "475 Grand Avenue, Palisades Park, NJ" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Find" })[0]);
    return pickup;
  };
  it("labels how precise each match is, and a street-only match never replaces the house number the dispatcher typed", async () => {
    fakeServer({ "GET /units": [], "GET /incidents": [], "GET /geocode": RESULTS, "GET /facilities": [] });
    const pickup = await openForm();
    expect(await screen.findByText("Exact address")).toBeTruthy();
    expect(screen.getByText("Street only")).toBeTruthy();
    fireEvent.click(screen.getByText(/no house number found: pins the street/));
    expect(pickup.value).toBe("475 Grand Avenue, Palisades Park, NJ");          // the 475 is still there
    expect(screen.getByText(/Pinned on the street/)).toBeTruthy();               // ...with a warning that the pin is approximate
  });
  it("an exact match fills the address and pins it; the dispatch map is told so the pickup shows before saving", async () => {
    fakeServer({ "GET /units": [], "GET /incidents": [], "GET /geocode": RESULTS, "GET /facilities": [] });
    const seen = [];
    const on = (e) => seen.push(e.detail);
    window.addEventListener("ems-draft-preview", on);
    const pickup = await openForm();
    fireEvent.click(await screen.findByText("475 Grand Ave, Palisades Park, NJ 07650", { selector: "span" }));
    expect(pickup.value).toBe("475 Grand Ave, Palisades Park, NJ 07650");
    expect(screen.getByText("Pinned on the map")).toBeTruthy();
    await waitFor(() => expect(seen.some((d) => d?.pickup?.lat === 40.8481 && d.pickup.label.startsWith("475 Grand"))).toBe(true));
    window.removeEventListener("ems-draft-preview", on);
  });
});

describe("dispatch map selection", () => {
  it("selecting a queued call shows its trip (pickup to drop-off); with nothing selected the map is about ongoing calls and units", async () => {
    fakeServer({ "GET /units": [UNIT()], "GET /incidents": [INCIDENT, { ...INCIDENT, incident_id: "i2", scene_address: "No Pin Rd", destination_text: null, lat: null, lon: null }] });
    render(<DispatchConsole session={liveSession()} />);
    expect(await screen.findByText(/LIVE MAP: ongoing calls and unit locations/)).toBeTruthy();
    fireEvent.click(screen.getByText("BronxCare Hospital Center"));
    expect(await screen.findByText(/TRIP: BronxCare Hospital Center → Montefiore Moses/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(await screen.findByText(/LIVE MAP: ongoing calls/)).toBeTruthy();
    fireEvent.click(screen.getByText("No Pin Rd"));
    expect(await screen.findByText(/no pin on the map yet/)).toBeTruthy();              // an unpinned call says so instead of showing nothing
  });
});

describe("team: units can be renamed and deleted", () => {
  it("renames a unit and says what happened when it's deleted (deleted, or retired because it has history)", async () => {
    const calls = fakeServer(TEAM_ROUTES({ "PATCH /units/u1": { ok: true }, "DELETE /units/u1": { retired: true }, "GET /unit-checks/status": [{ unit_id: "u1", crew_count: 0, check_due: false, any_failed: false, checks: { vehicle: CHK({ required: false }), bls: CHK({ required: false }), als: CHK({ required: false }) }, periodic: [] }] }));
    render(<TeamConsole session={liveSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Units & inspections" }));
    fireEvent.click(await screen.findByText("Medic 1"));
    fireEvent.change(await screen.findByDisplayValue("Medic 1"), { target: { value: "ALS 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find((c) => c.key === "PATCH /units/u1")?.body).toEqual({ designation: "ALS 1", capabilityLevel: "ALS" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete unit" }));
    expect(screen.getByText(/retired instead/)).toBeTruthy();                // asks first, and says what "delete" means
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    await waitFor(() => expect(calls.some((c) => c.key === "DELETE /units/u1")).toBe(true));
    expect(await screen.findByText(/retired\. Its history is kept/)).toBeTruthy();
  });
});

describe("OPS: vehicles", () => {
  const crew = (name, level, role, id) => ({ employeeId: "1", name, role, cert: null, crewMemberId: id, fieldLevel: level });
  const base = (over = {}) => ({
    "GET /units": [{ unit_id: "u1", unit_designation: "Medic 7", capability_level: "ALS", current_status: "available", fleet_vehicle_id: "f1", vehicle_number: "214", crew: [crew("Pat Medic", "paramedic", "non_driver", "c1"), crew("Dan Driver", "mvo", "driver", "c2")] },
      { unit_id: "u2", unit_designation: "BLS 2", capability_level: "BLS", current_status: "out_of_service", fleet_vehicle_id: null, vehicle_number: null, crew: [] }],
    "GET /ops/roster": [], "GET /unit-checks/status": [],
    "GET /fleet": [{ fleet_vehicle_id: "f9", vehicle_number: "215", make_model: "Ford E-450" }], ...over,
  });
  it("switches a unit's vehicle after a breakdown: the old one goes out of service with the reason, and the unit stays active", async () => {
    const calls = fakeServer(base({ "PUT /units/u1/vehicle": { ok: true } }));
    render(<OpsConsole session={liveSession()} />);
    expect(await screen.findByText("Vehicle 214")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch vehicle" }));
    fireEvent.change(screen.getByLabelText("Vehicle"), { target: { value: "f9" } });
    expect(screen.getByLabelText("Take vehicle 214 out of service").checked).toBe(true);        // on by default for a breakdown
    fireEvent.change(screen.getByPlaceholderText("Details (optional)"), { target: { value: "overheating" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(calls.find((c) => c.key === "PUT /units/u1/vehicle")?.body).toEqual({ fleetVehicleId: "f9", markOldOutOfService: true, reason: "Mechanical issue: overheating" }));
    expect(await screen.findByText(/still active/)).toBeTruthy();
  });
  // BLS 2 (the second unit of the fixture), with whatever the test needs changed about it.
  const withU2 = (u2) => { const b = base({ "PUT /units/u2/vehicle": { ok: true } }); b["GET /units"] = [b["GET /units"][0], { ...b["GET /units"][1], ...u2 }]; return b; };
  it("a vehicle goes with the crew: a crewed unit with none asks which vehicle the crew is taking, picking one assigns it, and only free in-service vehicles are offered", async () => {
    const calls = fakeServer(withU2({ current_status: "available", crew: [{ employeeId: "9", name: "Eli Emt", role: "driver", cert: null, crewMemberId: "c3", fieldLevel: "emt" }] }));
    render(<OpsConsole session={liveSession()} />);
    expect(await screen.findByText("Which vehicle is this crew taking?")).toBeTruthy();
    expect(calls.some((c) => c.key === "GET /fleet" && c.url.includes("available=1"))).toBe(true);   // the server lists only vehicles in service and not on a unit
    const pick = screen.getByLabelText("Vehicle for BLS 2");
    expect([...pick.options].map((o) => o.textContent)).toEqual(["Pick a vehicle…", "215 · Ford E-450"]);
    expect(screen.queryByRole("button", { name: "Assign vehicle" })).toBeNull();                      // no second step: picking one assigns it, like seating a person
    fireEvent.change(pick, { target: { value: "f9" } });
    await waitFor(() => expect(calls.find((c) => c.key === "PUT /units/u2/vehicle")?.body).toEqual({ fleetVehicleId: "f9" }));
  });
  it("an empty unit shows no vehicle row at all: no crew, so no vehicle to pick", async () => {
    fakeServer(base());
    render(<OpsConsole session={liveSession()} />);
    expect(await screen.findByText("Vehicle 214")).toBeTruthy();                                       // Medic 7 is crewed and has one
    expect(screen.queryByText("No vehicle assigned")).toBeNull();
    expect(screen.queryByText("Which vehicle is this crew taking?")).toBeNull();
    expect(screen.queryByLabelText("Vehicle for BLS 2")).toBeNull();
  });
  it("a vehicle left on a unit after its crew went can be released by hand", async () => {
    const calls = fakeServer(withU2({ fleet_vehicle_id: "f9", vehicle_number: "215", crew: [] }));
    render(<OpsConsole session={liveSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Release vehicle" }));
    await waitFor(() => expect(calls.find((c) => c.key === "PUT /units/u2/vehicle")?.body).toEqual({ fleetVehicleId: null }));
    expect(await screen.findByText("Vehicle released.")).toBeTruthy();
  });
});

describe("Team: units don't look tied to a vehicle", () => {
  const row = (id, name, over) => ({ unit_id: id, unit_designation: name, capability_level: "ALS", current_status: "available", fleet_vehicle_id: null, vehicle_number: null, vehicle_status: null, crew: [], ...over });
  const status = (u) => ({ unit_id: u.unit_id, unit_designation: u.unit_designation, capability_level: u.capability_level, crew_count: u.crew.length, check_due: false, any_failed: false, fleet_vehicle_id: u.fleet_vehicle_id, vehicle_number: u.vehicle_number, checks: { vehicle: CHK(), bls: CHK(), als: CHK() }, periodic: [] });
  it("shows a vehicle only on a crewed unit, flags a crewed unit that has none, and says nothing about vehicles on an empty one", async () => {
    const aboard = [{ employeeId: "7", name: "Pat Medic", role: "driver", cert: "EMT" }];
    const units = [
      row("u1", "Medic 1", { crew: aboard, fleet_vehicle_id: "f1", vehicle_number: "214" }),
      row("u2", "Medic 2", { crew: aboard }),
      row("u3", "Medic 3", { current_status: "out_of_service" }),
    ];
    fakeServer(TEAM_ROUTES({ "GET /units": units, "GET /unit-checks/status": units.map(status) }));
    render(<TeamConsole session={liveSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Units & inspections" }));
    expect(await screen.findByText("Vehicle 214")).toBeTruthy();
    expect(screen.getAllByText("Needs a vehicle")).toHaveLength(1);                                    // Medic 2 only
    expect(screen.queryByText("No vehicle")).toBeNull();                                               // an empty unit is not a problem
    fireEvent.click(screen.getByText("Medic 3"));
    expect(await screen.findByText("Not crewed. A vehicle is picked in OPS when the unit is crewed.")).toBeTruthy();
  });
});

describe("dispatch board: long lists stay usable", () => {
  const u = (i, over) => UNIT({ unit_id: `u${i}`, unit_designation: `Medic ${i}`, ...over });
  const idle = { current_status: "out_of_service", crew: [], fleet_vehicle_id: null, vehicle_number: null };
  const names = () => screen.getAllByText(/^Medic \d+$/).map((e) => e.textContent);
  it("lists available units first, then those on a call, then out of service; chips count them and narrow the list", async () => {
    fakeServer({ "GET /units": [u(1, idle), u(2, { current_status: "en_route" }), u(3), u(4, idle), u(5), u(6, { current_status: "on_scene" }), u(7)], "GET /incidents": [] });
    render(<DispatchConsole session={liveSession()} />);
    const chips = await screen.findByRole("group", { name: "Filter the unit board" });
    for (const t of [/All\s*7/, /Available\s*3/, /On a call\s*2/, /Out of service\s*2/]) expect(chips.textContent).toMatch(t);
    expect(names()).toEqual(["Medic 3", "Medic 5", "Medic 7", "Medic 2", "Medic 6", "Medic 1", "Medic 4"]);   // nothing is hidden by default
    fireEvent.click(screen.getByRole("button", { name: /Out of service\s*2/ }));
    expect(names()).toEqual(["Medic 1", "Medic 4"]);
    expect(screen.getByRole("button", { name: /Out of service\s*2/ }).getAttribute("aria-pressed")).toBe("true");
  });
  it("shows a crew member without an employee number by name only, never 'null -'", async () => {
    fakeServer({ "GET /units": [UNIT({ crew: [{ employeeId: null, name: "Pat Medic", role: "driver", cert: "ALS" }] })], "GET /incidents": [] });
    render(<DispatchConsole session={liveSession()} />);
    expect(await screen.findByText("Pat Medic")).toBeTruthy();
    expect(screen.queryByText(/null/)).toBeNull();
  });
  it("warns 'no vehicle' only on a crewed unit: an empty unit has no vehicle by design", async () => {
    fakeServer({ "GET /units": [u(1, { fleet_vehicle_id: null, vehicle_number: null }), u(2, idle)], "GET /incidents": [] });
    render(<DispatchConsole session={liveSession()} />);
    await screen.findByText("Medic 1");
    expect(screen.getAllByText("no vehicle")).toHaveLength(1);
  });
  it("a long queue gets chips; a call already covered at the level it needs hides its extra suggestion, one that is not covered keeps it", async () => {
    const call = (i, over) => ({ ...INCIDENT, incident_id: `i${i}`, scene_address: `${i} Test Street`, scene_detail: "", destination_text: "", ...over });
    fakeServer({
      "GET /units": [u(1, { capability_level: "ALS", current_status: "on_scene" }), u(2, { capability_level: "BLS", current_status: "en_route" }), u(3, { capability_level: "BLS", current_status: "available" })],
      "GET /incidents": [
        call(1, { capability_needed: "BLS", assigned_units: [{ unitId: "u1", role: "primary" }] }),   // an ALS unit covers a BLS call
        call(2, { capability_needed: "ALS", assigned_units: [{ unitId: "u2", role: "primary" }] }),   // a BLS unit does not cover an ALS call
        call(3), call(4), call(5),
      ],
    });
    render(<DispatchConsole session={liveSession()} />);
    const chips = await screen.findByRole("group", { name: "Filter the transport queue" });
    expect(chips.textContent).toMatch(/Needs a unit\s*3/);
    expect(chips.textContent).toMatch(/Has a unit\s*2/);
    await screen.findByText("1 Test Street");
    expect(screen.getAllByText(/Nearest additional unit/)).toHaveLength(1);                           // only the ALS call still lacking ALS
    fireEvent.click(screen.getByRole("button", { name: /Needs a unit\s*3/ }));                       // the chips narrow the queue
    expect(screen.queryByText("1 Test Street")).toBeNull();
    expect(screen.getByText("3 Test Street")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Has a unit\s*2/ }));
    expect(screen.getByText("1 Test Street")).toBeTruthy();
    expect(screen.queryByText("3 Test Street")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /All\s*5/ }));
    fireEvent.click(screen.getByText("1 Test Street"));                                               // opening the covered call shows its suggestion too
    await waitFor(() => expect(screen.getAllByText(/Nearest additional unit/)).toHaveLength(2));
  });
});
