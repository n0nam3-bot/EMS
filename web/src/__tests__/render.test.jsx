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
const LOGIN = { kind: "tenant", token: "t.t.t", expiresAt: new Date(Date.now() + 3600e3).toISOString(), user: { id: "u1", email: "boss@a.test", name: "Pat Boss", role: "supervisor", roles: ["supervisor", "qa_qi"], fieldLevel: null }, agency: "Acme Ambulance" };
const liveSession = (role = "supervisor", extra = {}) => ({ mode: "live", kind: "tenant", apiBaseUrl: "/api", token: "t.t.t", agency: "Acme Ambulance", user: { ...LOGIN.user, role, roles: [role], ...extra } });
const typeInto = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
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

  it("signing in is two steps: password, then an authenticator code; then the company's real (empty) board, never the demo, once for every tab", async () => {
    const calls = fakeServer({ "POST /auth/login": { step: "mfa", challenge: "c.c.c" }, "POST /auth/mfa/verify": LOGIN, "GET /units": [], "GET /incidents": [], "GET /auth/me": { user: LOGIN.user, agency: "Acme Ambulance", unit: null, incident: null }, "GET /users": [], "GET /certifications": [], "GET /certification-types": [], "GET /vehicles": [], "GET /pcr-review": [], "GET /checklist": [], "GET /unit-checks/status": [], "GET /qa/charts": [] });
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
    for (const [hash, text] of [["#/compliance", "Compliance Console"], ["#/team", "Add field personnel"], ["#/qa", "QA/QI review"]]) {
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

const TEAM_ROUTES = (over = {}) => ({
  "GET /users": [], "GET /units": [UNIT()], "GET /certifications": [], "GET /certification-types": [{ certification_type_id: "t1", code: "PARAMEDIC", label: "Paramedic", required_for_capability: "ALS" }],
  "GET /vehicles": [], "GET /checklist": [], "GET /unit-checks/status": [], ...over,
});

describe("team admin", () => {
  it("field personnel: creates a person with a field level and shows the temporary password once", async () => {
    let users = [];
    const calls = fakeServer(TEAM_ROUTES({
      "GET /users": () => users,
      "POST /users": (b) => { users = [{ user_id: "n1", email: b.email, display_name: b.displayName, role: "crew", roles: b.roles, is_active: true, crew_member_id: "c1", field_level: b.fieldLevel, mfa_enabled: false }]; return users[0]; },
    }));
    render(<TeamConsole session={liveSession()} />);
    fireEvent.change(await screen.findByLabelText("Full name"), { target: { value: "Casey Medic" } });
    fireEvent.change(screen.getByLabelText("Email (their sign-in name)"), { target: { value: "casey@a.test" } });
    fireEvent.change(screen.getByLabelText("Field level"), { target: { value: "paramedic" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText(/Account created/)).toBeTruthy();
    await waitFor(() => { const b = calls.find((c) => c.key === "POST /users").body; expect(b.fieldLevel).toBe("paramedic"); expect(b.roles).toContain("crew"); });
    expect(await screen.findByText("Casey Medic")).toBeTruthy();
  });

  it("office personnel: pick one or more roles, and optionally mark that they also work on a unit", async () => {
    const calls = fakeServer(TEAM_ROUTES({ "POST /users": (b) => ({ user_id: "n2", ...b }) }));
    render(<TeamConsole session={liveSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Office personnel" }));
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
    fireEvent.change(await screen.findByDisplayValue("Not on a unit"), { target: { value: "u1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/no current ALS-level certification/)).toBeTruthy();
  });

  it("units & inspections: shows the last shift check, flags a failure, and warns that the starter checklist isn't the agency's real inventory", async () => {
    fakeServer(TEAM_ROUTES({
      "GET /checklist": [{ item_id: "i1", label: "Oxygen supply adequate", category: "Oxygen and airway", applies_to: "BLS", min_quantity: null, is_active: true, source: "starter" }],
      "GET /unit-checks/status": [{ unit_id: "u1", unit_designation: "Medic 1", capability_level: "ALS", last_check_at: new Date(Date.now() - 2 * 3600e3).toISOString(), last_check_result: "fail", last_check_by: "Eli Emt", failed_items: ["Suction working"], periodic: [{ kind: "dmv_inspection", performedAt: "2026-06-01T00:00:00Z", result: "pass", nextDue: "2027-06-01" }] }],
    }));
    render(<TeamConsole session={liveSession()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Units & inspections" }));
    expect(await screen.findByText(/FAILED 2 h ago by Eli Emt: Suction working/)).toBeTruthy();
    expect(screen.getByText(/DMV inspection: passed/)).toBeTruthy();
    expect(screen.getByText(/not your agency's required equipment/)).toBeTruthy();
    expect(screen.getByText(/Part 800/)).toBeTruthy();
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
      "GET /unit-checks/status": [{ unit_id: "u1", last_check_at: null, failed_items: [], periodic: [] }],
      "GET /checklist": [{ item_id: "i1", label: "Oxygen supply adequate", category: "Oxygen and airway", min_quantity: null }, { item_id: "i2", label: "Suction working", category: "Oxygen and airway", min_quantity: 1 }],
      "POST /unit-checks": { result: "fail", failedItems: ["Suction working"] },
    });
    render(<FieldUnitConsole session={liveSession("crew", { fieldLevel: "mvo", roles: ["crew"] })} />);
    expect(await screen.findByText("MY CALLS")).toBeTruthy();
    expect(screen.getByText("Assigned")).toBeTruthy();
    expect(screen.queryByText("Completed ePCRs")).toBeNull();
    expect(screen.getByText(/MVOs don't write patient charts/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Do the check" }));
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
    await waitFor(() => expect(calls.some((c) => c.key === "POST /unit-checks" && c.body.items.some((i) => i.ok === false && i.note === "Strap frayed"))).toBe(true));
    expect(await screen.findByText(/flagged for your supervisor/)).toBeTruthy();
  });
});
