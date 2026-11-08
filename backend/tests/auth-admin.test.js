// Sign-in (two steps), accounts and roles, staffing, the chart lifecycle with
// QA/QI, unit checks, and the platform administrator, all through the real HTTP
// API against a real database, plus the property that matters most: one
// company's people can't see or change another company's records.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import pg from "pg";
import { applyMigrations, ensureRuntimeRole } from "../migrate.js";
import { hashPassword } from "../backend_passwords.js";
import { hotp, base32Decode, stepAt } from "../backend_mfa.js";

const ADMIN_URL = process.env.TEST_DATABASE_URL || "postgres://ems_app:dev_only_change_me@localhost:5432/ems_dispatch_test";
const RUNTIME_PASSWORD = "test_runtime_password";
const TA = "aaaaaaaa-1111-4111-8111-111111111111", TB = "bbbbbbbb-2222-4222-8222-222222222222";
const UA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", UB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PW = "correct-horse-battery";

// A code works once and the server remembers the last step used, so a test that signs
// in repeatedly moves the clock forward (for server and test alike) instead of waiting.
const realNow = Date.now.bind(Date);
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const advance = () => { skewMs += 61_000; };
const codeFor = (secret) => hotp(base32Decode(secret), stepAt(Date.now()));

let server, base, admin;
const secrets = new Map();   // email -> authenticator secret
const sessions = new Map();  // email -> token

async function call(method, path, body, token) {
  const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
// Full sign-in: password, then (first time) set up the authenticator, or (after) enter a code.
async function signIn(email, password = PW) {
  const first = await call("POST", "/auth/login", { email, password });
  if (first.status !== 200) return first;
  advance();
  if (first.body.step === "mfa_setup") {
    const setup = await call("POST", "/auth/mfa/setup", { challenge: first.body.challenge });
    secrets.set(email, setup.body.secret);
    return call("POST", "/auth/mfa/enable", { challenge: first.body.challenge, code: codeFor(setup.body.secret) });
  }
  return call("POST", "/auth/mfa/verify", { challenge: first.body.challenge, code: codeFor(secrets.get(email)) });
}
// Sign-ins are run one at a time: each one moves the shared fake clock forward, so two running at once
// (the Promise.all calls below) could generate a code under one clock reading and have it verified under
// another, which made this suite fail about one run in four.
let signInQueue = Promise.resolve();
function tokenFor(email) {
  const run = async () => {
    if (!sessions.has(email)) { const r = await signIn(email); assert.equal(r.status, 200, `sign-in for ${email}: ${JSON.stringify(r.body)}`); sessions.set(email, r.body.token); }
    return sessions.get(email);
  };
  const result = signInQueue.then(run);
  signInQueue = result.catch(() => {});
  return result;
}
const q = async (sql, params) => (await admin.query(sql, params)).rows;

before(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query("DROP SCHEMA public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await applyMigrations(admin, "./migrations");
  await ensureRuntimeRole(admin, RUNTIME_PASSWORD);
  const hash = await hashPassword(PW);
  for (const [t, u, name, email] of [[TA, UA, "Company A", "boss@a.test"], [TB, UB, "Company B", "boss@b.test"]]) {
    await admin.query("INSERT INTO tenants (tenant_id, legal_name, display_name, regulatory_state, regulatory_region, encryption_key_ref) VALUES ($1,$2,$2,'NY','x','k')", [t, name]);
    await admin.query("INSERT INTO protocol_sets (tenant_id, issuing_authority, version_label, effective_from) VALUES ($1,'REMAC','v1',CURRENT_DATE)", [t]);
    await admin.query("SELECT seed_tenant_defaults($1)", [t]);
    await admin.query("INSERT INTO users (user_id, tenant_id, email, display_name, role, extra_roles, password_hash) VALUES ($1,$2,$3,'Boss','supervisor','{}',$4)", [u, t, email, hash]);
    await admin.query("INSERT INTO crew_members (tenant_id, user_id, first_name, last_name) VALUES ($1,$2,'Boss','-')", [t, u]);
  }
  await admin.query("INSERT INTO platform_admins (email, display_name, password_hash) VALUES ('root@platform.test', 'Root', $1)", [await hashPassword("platform-password-123")]);

  process.env.DATABASE_URL = ADMIN_URL.replace(/\/\/[^@]+@/, `//ems_app_runtime:${RUNTIME_PASSWORD}@`);
  process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-12345";
  process.env.VERCEL = "1"; // import the app without it listening or exiting
  const { default: app } = await import("../server.js");
  server = http.createServer(app).listen(0);
  base = `http://localhost:${server.address().port}/api`;
});
after(async () => { server?.close(); await admin?.end(); Date.now = realNow; });

// ---------------------------------------------------------------------------------
test("sign-in is two steps: the password alone never yields a session, a code is needed, and a code works once", async () => {
  const wrong = await call("POST", "/auth/login", { email: "boss@a.test", password: "nope-nope-nope" });
  const unknown = await call("POST", "/auth/login", { email: "nobody@a.test", password: "nope-nope-nope" });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body, "same words whether or not the account exists");

  const first = await call("POST", "/auth/login", { email: "BOSS@a.test", password: PW });
  assert.equal(first.body.step, "mfa_setup", "no authenticator yet: set one up, don't just let them in");
  assert.equal(first.body.token, undefined);
  assert.equal((await call("GET", "/units", null, first.body.challenge)).status, 401, "the password-step pass is not a session");

  const setup = await call("POST", "/auth/mfa/setup", { challenge: first.body.challenge });
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  const stored = (await q("SELECT totp_secret_enc FROM users WHERE user_id = $1", [UA]))[0].totp_secret_enc;
  assert.ok(stored && !stored.includes(setup.body.secret), "the authenticator secret is stored encrypted, never in the clear");
  advance();
  assert.equal((await call("POST", "/auth/mfa/enable", { challenge: first.body.challenge, code: "000000" })).status, 401);
  const done = await call("POST", "/auth/mfa/enable", { challenge: first.body.challenge, code: codeFor(setup.body.secret) });
  assert.equal(done.status, 200);
  assert.equal(done.body.recoveryCodes.length, 8);
  assert.equal(done.body.agency, "Company A");
  secrets.set("boss@a.test", setup.body.secret);

  advance();
  const again = await call("POST", "/auth/login", { email: "boss@a.test", password: PW });
  assert.equal(again.body.step, "mfa");
  assert.equal((await call("POST", "/auth/mfa/verify", { challenge: again.body.challenge, code: "123456" })).status, 401);
  const code = codeFor(setup.body.secret);
  assert.equal((await call("POST", "/auth/mfa/verify", { challenge: again.body.challenge, code })).status, 200);
  const again2 = await call("POST", "/auth/login", { email: "boss@a.test", password: PW });
  assert.equal((await call("POST", "/auth/mfa/verify", { challenge: again2.body.challenge, code })).status, 401, "the same code can't be used twice");

  // a recovery code covers a lost phone, once
  const viaRecovery = await call("POST", "/auth/mfa/verify", { challenge: again2.body.challenge, code: done.body.recoveryCodes[0] });
  assert.equal(viaRecovery.status, 200);
  const again3 = await call("POST", "/auth/login", { email: "boss@a.test", password: PW });
  assert.equal((await call("POST", "/auth/mfa/verify", { challenge: again3.body.challenge, code: done.body.recoveryCodes[0] })).status, 401, "a recovery code is single-use");
});

test("company A's admin sees and changes only company A's people, calls and checklists", async () => {
  const a = await tokenFor("boss@a.test"), b = await tokenFor("boss@b.test");
  assert.deepEqual((await call("GET", "/users", null, a)).body.map((u) => u.email), ["boss@a.test"]);
  assert.deepEqual((await call("GET", "/users", null, b)).body.map((u) => u.email), ["boss@b.test"]);
  assert.equal((await call("PATCH", `/users/${UB}`, { roles: ["dispatcher"] }, a)).status, 404, "another company's user looks like it doesn't exist");
  const inc = await call("POST", "/incidents", { incidentType: "emergency_911", priority: "critical", sceneAddress: "1 A Street" }, a);
  assert.equal(inc.status, 201);
  assert.equal((await call("GET", "/incidents", null, b)).body.length, 0);
  assert.equal((await call("PATCH", `/incidents/${inc.body.incident_id}`, { notes: "hijack" }, b)).status, 404);
  const itemsA = (await call("GET", "/checklist", null, a)).body, itemsB = (await call("GET", "/checklist", null, b)).body;
  assert.ok(itemsA.length > 0 && itemsA.every((i) => i.tenant_id === TA) && itemsB.every((i) => i.tenant_id === TB));
});

test("a person can hold several roles; anyone who works a unit needs a field level; office staff can be put on a unit only if they have one", async () => {
  const a = await tokenFor("boss@a.test");
  const make = (body) => call("POST", "/users", { password: PW, ...body }, a);
  assert.equal((await make({ email: "x@a.test", displayName: "No Level", roles: ["crew"] })).status, 400, "crew needs a field level");
  assert.equal((await make({ email: "x@a.test", displayName: "No Roles", roles: [] })).status, 400);
  assert.equal((await make({ email: "x@a.test", displayName: "Bad Level", roles: ["crew"], fieldLevel: "wizard" })).status, 400);
  const office = await make({ email: "disp@a.test", displayName: "Dana Dispatcher", roles: ["dispatcher"] });
  assert.equal(office.status, 201);
  assert.equal(office.body.field_level, null);
  const both = await make({ email: "robin@a.test", displayName: "Robin Both", roles: ["dispatcher", "supervisor"], fieldLevel: "emt" });
  assert.deepEqual([...both.body.roles].sort(), ["crew", "dispatcher", "supervisor"], "a field level adds the crew role");
  const me = await call("GET", "/auth/me", null, await tokenFor("robin@a.test"));
  assert.equal(me.body.user.fieldLevel, "emt");
  assert.ok(me.body.user.roles.includes("dispatcher") && me.body.user.roles.includes("crew"));
  const unit = (await call("POST", "/units", { designation: "Rig 9", capabilityLevel: "BLS" }, a)).body;
  const nonField = await call("PUT", `/crew/${office.body.crew_member_id}/unit`, { unitId: unit.unit_id, seatRole: "driver" }, a);
  assert.equal(nonField.status, 409, "a dispatcher with no field level can't be put on a unit");
  assert.equal((await call("PATCH", `/users/${UA}`, { roles: ["dispatcher"] }, a)).status, 400, "can't change your own roles");
  const lone = await call("PATCH", `/users/${office.body.user_id}`, { roles: ["dispatcher", "qa_qi"] }, a);
  assert.deepEqual([...lone.body.roles].sort(), ["dispatcher", "qa_qi"]);
});

// ---- the main flow: a crew works a call, charts it, QA reviews it -------------------------
const ctx = {};
test("staffing: an ALS unit needs a paramedic to go in service, an EMT or MVO may ride with them, and MVOs can drive", async () => {
  const a = await tokenFor("boss@a.test");
  const person = async (key, email, name, body) => {
    const r = await call("POST", "/users", { email, displayName: name, password: PW, ...body }, a);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ctx[key] = r.body;
  };
  await person("medic", "medic@a.test", "Pat Medic", { roles: ["qa_qi"], fieldLevel: "paramedic" });   // also does QA/QI, so can't review their own charts
  await person("emt", "emt@a.test", "Eli Emt", { roles: ["crew"], fieldLevel: "emt" });
  await person("emt2", "emt2@a.test", "Eve Emt", { roles: ["crew"], fieldLevel: "emt" });
  await person("mvo", "mvo@a.test", "Dan Driver", { roles: ["crew"], fieldLevel: "mvo" });
  await person("qa", "qa@a.test", "Quinn Qa", { roles: ["qa_qi"] });

  ctx.als = (await call("POST", "/units", { designation: "Medic 1", capabilityLevel: "ALS" }, a)).body;
  const put = (who, unit, seat) => call("PUT", `/crew/${ctx[who].crew_member_id}/unit`, { unitId: ctx[unit].unit_id, seatRole: seat }, a);
  const status = async () => (await call("GET", "/units", null, a)).body.find((u) => u.unit_designation === "Medic 1").current_status;

  const drv = await put("mvo", "als", "driver");
  assert.equal(drv.status, 200);
  assert.match(drv.body.warning, /paramedic/i);
  assert.equal(await status(), "out_of_service", "crewed but no paramedic yet");
  assert.equal((await put("medic", "als", "non_driver")).status, 409, "a paramedic still needs a current ALS certification");
  const type = (await call("GET", "/certification-types", null, a)).body.find((t) => t.code === "PARAMEDIC");
  await call("POST", "/certifications", { crewMemberId: ctx.medic.crew_member_id, certificationTypeId: type.certification_type_id, issuingBody: "NY DOH", issuedOn: "2025-01-01", expiresOn: "2030-01-01" }, a);
  assert.equal((await put("medic", "als", "non_driver")).status, 200);
  assert.equal(await status(), "available", "with a paramedic aboard it goes in service");
  assert.equal((await put("emt", "als", "non_driver")).status, 200, "an EMT rides along on an ALS unit without an ALS certification");
  const full = await put("emt2", "als", "non_driver");
  assert.equal(full.status, 409, "a unit holds at most 3 crew");
  assert.match(full.body.error, /3 crew/);
  const mvoSeat = await call("PATCH", `/crew/${ctx.mvo.crew_member_id}/seat`, { seatRole: "non_driver" }, a);
  assert.equal(mvoSeat.status, 409, "an MVO always drives");
});

test("seats: an EMT can be the driver on an ALS unit paired with a paramedic, only one driver per unit, and dispatchers can staff units", async () => {
  const a = await tokenFor("boss@a.test");
  const disp = (await call("POST", "/users", { email: "d2@a.test", displayName: "Dee Dispatch", roles: ["dispatcher"], password: PW }, a)).body;
  const dispTok = await tokenFor("d2@a.test");
  const unit = (await call("POST", "/units", { designation: "Medic 7", capabilityLevel: "ALS" }, a)).body;
  const medic2 = (await call("POST", "/users", { email: "m2@a.test", displayName: "Max Medic", roles: ["crew"], fieldLevel: "paramedic", password: PW }, a)).body;
  const emtDriver = (await call("POST", "/users", { email: "ed@a.test", displayName: "Ed Driver", roles: ["crew"], fieldLevel: "emt", password: PW }, a)).body;
  const type = (await call("GET", "/certification-types", null, a)).body.find((x) => x.code === "PARAMEDIC");
  await call("POST", "/certifications", { crewMemberId: medic2.crew_member_id, certificationTypeId: type.certification_type_id, issuingBody: "NY DOH", issuedOn: "2025-01-01", expiresOn: "2030-01-01" }, a);
  const units = async () => (await call("GET", "/units", null, a)).body.find((u) => u.unit_designation === "Medic 7");
  assert.equal((await call("PUT", `/crew/${medic2.crew_member_id}/unit`, { unitId: unit.unit_id, seatRole: "non_driver" }, dispTok)).status, 200, "a dispatcher can put crew on a unit");
  assert.equal((await units()).current_status, "out_of_service", "a paramedic alone has no driver");
  const put = await call("PUT", `/crew/${emtDriver.crew_member_id}/unit`, { unitId: unit.unit_id, seatRole: "driver" }, dispTok);
  assert.equal(put.status, 200);
  const now = await units();
  assert.equal(now.current_status, "available", "driver (an EMT) + paramedic puts an ALS unit in service");
  assert.deepEqual(now.crew.map((c) => [c.name, c.role, c.fieldLevel]).sort(), [["Ed Driver", "driver", "emt"], ["Max Medic", "non_driver", "paramedic"]]);
  assert.ok(now.crew.every((c) => c.crewMemberId), "each crew entry carries the id the OPS board needs");
  assert.equal((await call("PATCH", `/crew/${medic2.crew_member_id}/seat`, { seatRole: "driver" }, dispTok)).status, 409, "only one driver");
  assert.equal((await call("PATCH", `/crew/${emtDriver.crew_member_id}/seat`, { seatRole: "non_driver" }, dispTok)).status, 200);
  assert.equal((await units()).current_status, "out_of_service", "no driver, so out of service again");
  const nobody = await tokenFor("emt@a.test");
  assert.equal((await call("PUT", `/crew/${medic2.crew_member_id}/unit`, { unitId: null }, nobody)).status, 403, "crew can't staff units");
  const roster = (await call("GET", "/ops/roster?unassigned=1", null, dispTok)).body;
  assert.ok(roster.every((r) => !r.unit_id) && roster.some((r) => r.name === "Pat Medic") === false);
  assert.ok((await call("GET", "/ops/roster?q=ed", null, dispTok)).body.some((r) => r.name === "Ed Driver"), "search by name");
  assert.equal((await call("GET", "/ops/roster", null, nobody)).status, 403);
  ctx.dispTok = dispTok; ctx.disp = disp; ctx.medic2 = medic2; ctx.emtDriver = emtDriver; ctx.medic7 = unit;
});

test("fixing a mistake: name, email and employee number can be corrected; a taken email is refused; the person signs in with the new email", async () => {
  const a = await tokenFor("boss@a.test");
  const u = (await call("POST", "/users", { email: "typo@a.test", displayName: "Jon Smyth", roles: ["dispatcher"], password: PW }, a)).body;
  assert.equal((await call("PATCH", `/users/${u.user_id}`, { email: "boss@a.test" }, a)).status, 409, "an email already in use");
  assert.equal((await call("PATCH", `/users/${u.user_id}`, { email: "root@platform.test" }, a)).status, 409, "...including a platform admin's");
  assert.equal((await call("PATCH", `/users/${u.user_id}`, { email: "not an email" }, a)).status, 400);
  const fixed = await call("PATCH", `/users/${u.user_id}`, { email: "Jon.Smith@a.test", displayName: "Jon Smith", employeeNumber: "9001" }, a);
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.email, "jon.smith@a.test");
  assert.equal((await call("POST", "/auth/login", { email: "typo@a.test", password: PW })).status, 401, "the old email no longer works");
  assert.equal((await call("POST", "/auth/login", { email: "jon.smith@a.test", password: PW })).body.step, "mfa_setup");
  const row = (await call("GET", "/users?q=9001", null, a)).body[0];
  assert.deepEqual([row.display_name, row.employee_number], ["Jon Smith", "9001"]);
});

test("long staff lists: search, filter by field/office, and page through with a total count", async () => {
  const a = await tokenFor("boss@a.test");
  for (let i = 0; i < 6; i++) await call("POST", "/users", { email: `bulk${i}@a.test`, displayName: `Bulk Person ${i}`, roles: i % 2 ? ["crew"] : ["biller"], fieldLevel: i % 2 ? "emt" : undefined, password: PW }, a);
  const raw = await fetch(`${base}/users?q=Bulk&limit=4&offset=0`, { headers: { Authorization: `Bearer ${a}` } });
  assert.equal(raw.headers.get("x-total-count"), "6");
  assert.equal((await raw.json()).length, 4);
  assert.equal((await call("GET", "/users?q=Bulk&limit=4&offset=4", null, a)).body.length, 2);
  const field = (await call("GET", "/users?q=Bulk&kind=field", null, a)).body, office = (await call("GET", "/users?q=Bulk&kind=office", null, a)).body;
  assert.equal(field.length, 3); assert.equal(office.length, 3);
  assert.ok(field.every((u) => u.field_level) && office.every((u) => u.roles.includes("biller")));
  assert.equal((await call("GET", "/users?q=%25", null, a)).body.length, 0, "a % in the search is just a character");
});

test("charts belong to the unit's clinical crew: MVOs and office staff never get one, submitting locks it, only QA/QI can reopen it, and corrections go to one named person", async () => {
  const a = await tokenFor("boss@a.test");
  const tok = Object.fromEntries(await Promise.all(["medic", "emt", "emt2", "mvo", "qa"].map(async (k) => [k, await tokenFor(`${k}@a.test`)])));
  const inc = (await call("POST", "/incidents", { incidentType: "emergency_911", priority: "urgent", sceneAddress: "5 Chart Ave" }, a)).body.incident_id;
  ctx.chartIncident = inc;
  assert.equal((await call("POST", `/incidents/${inc}/assignments`, { unitId: ctx.als.unit_id, role: "primary" }, a)).status, 201);

  // who can start a chart
  assert.equal((await call("POST", "/pcr", { incidentId: inc }, tok.mvo)).status, 403, "an MVO can't chart");
  assert.equal((await call("POST", "/pcr", { incidentId: inc }, a)).status, 403, "office staff can't chart");
  assert.equal((await call("POST", "/pcr", { incidentId: inc }, tok.emt2)).status, 403, "an EMT on some other unit can't chart this call");
  const created = await call("POST", "/pcr", { incidentId: inc }, tok.emt);
  assert.equal(created.status, 201);
  const pcr = created.body.pcr_id;
  assert.equal(created.body.unit_id, ctx.als.unit_id, "the chart is tied to the unit that treated the patient");
  assert.equal((await call("POST", "/pcr", { incidentId: inc }, tok.emt)).body.pcr_id, pcr, "asking again returns the same chart");
  const crewOnChart = (await q("SELECT cm.first_name FROM pcr_crew pc JOIN crew_members cm ON cm.crew_member_id = pc.crew_member_id WHERE pc.pcr_id = $1 ORDER BY 1", [pcr])).map((r) => r.first_name);
  assert.deepEqual(crewOnChart, ["Eli", "Pat"], "the EMT and the paramedic; never the MVO");

  // the crew can edit while it's a draft; nobody else can open it
  assert.equal((await call("POST", `/pcr/${pcr}/vitals`, { heartRate: 88, bpSystolic: 120, bpDiastolic: 80 }, tok.medic)).status, 201);
  assert.equal((await call("PATCH", `/pcr/${pcr}/narrative`, { clinicalNarrative: "Found patient seated." }, tok.emt)).status, 200);
  for (const [who, t] of [["mvo", tok.mvo], ["office", a], ["qa", tok.qa], ["other emt", tok.emt2]]) {
    assert.equal((await call("GET", `/pcr/${pcr}`, null, t)).status, 403, `${who} can't read a draft`);
  }

  // submit: missing pieces are named first, then it locks
  const missing = await call("POST", `/pcr/${pcr}/submit`, {}, tok.emt);
  assert.equal(missing.status, 409);
  assert.ok(missing.body.missing.includes("has_disposition"));
  assert.equal((await call("POST", `/pcr/${pcr}/submit`, { acknowledgeMissing: true }, tok.emt)).status, 200);
  assert.equal((await call("GET", `/pcr/${pcr}`, null, tok.emt)).status, 403, "once submitted the crew can't open it");
  assert.match((await call("GET", `/pcr/${pcr}`, null, tok.emt)).body.error, /locked/i);
  assert.equal((await call("PATCH", `/pcr/${pcr}/narrative`, { clinicalNarrative: "sneaky edit" }, tok.medic)).status, 403);
  assert.equal((await call("POST", `/pcr/${pcr}/vitals`, { heartRate: 200 }, tok.medic)).status, 403);
  await assert.rejects(() => admin.query("UPDATE patient_care_records SET clinical_narrative = 'direct' WHERE pcr_id = $1", [pcr]), /locked/i, "the database itself refuses edits to a submitted chart");
  assert.equal((await call("GET", "/pcr/mine", null, tok.emt)).body.charts.length, 0, "a submitted chart isn't in the crew's list");

  // QA/QI: the review queue, reading, and what they can't do
  assert.equal((await call("GET", "/qa/charts", null, a)).status, 403, "a supervisor isn't QA/QI unless given the role");
  const queue = (await call("GET", "/qa/charts?status=submitted", null, tok.qa)).body;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].unit_designation, "Medic 1");
  const review = await call("GET", `/pcr/${pcr}`, null, tok.qa);
  assert.equal(review.status, 200);
  assert.equal(review.body.access, "review");
  assert.equal(review.body.vitals.length, 1);
  assert.equal((await call("PATCH", `/pcr/${pcr}/narrative`, { clinicalNarrative: "qa edit" }, tok.qa)).status, 403, "QA reviews, doesn't edit");
  assert.equal((await call("GET", `/pcr/${pcr}`, null, tok.medic)).status, 403, "Pat has the QA/QI role but was on this call, so can't review its chart");
  assert.equal((await call("GET", "/qa/charts?status=submitted", null, tok.medic)).body.length, 0);
  assert.equal((await call("POST", `/pcr/${pcr}/reopen`, { assignToUserId: ctx.emt.user_id, note: "x" }, tok.qa)).status, 400, "a reason is required");
  assert.equal((await call("POST", `/pcr/${pcr}/reopen`, { assignToUserId: ctx.mvo.user_id, note: "Add the second set of vitals" }, tok.qa)).status, 400, "only someone on the chart's clinical crew can be assigned");
  assert.equal((await call("POST", `/pcr/${pcr}/reopen`, { assignToUserId: ctx.emt2.user_id, note: "Add the second set of vitals" }, tok.qa)).status, 400, "...and not an outsider");

  // reopen for ONE member
  assert.equal((await call("POST", `/pcr/${pcr}/reopen`, { assignToUserId: ctx.emt.user_id, note: "Add the second set of vitals" }, tok.qa)).status, 200);
  const mine = (await call("GET", "/pcr/mine", null, tok.emt)).body;
  assert.equal(mine.charts.length, 1);
  assert.equal(mine.charts[0].status, "reopened");
  assert.match(mine.charts[0].reopen_note, /second set of vitals/);
  assert.equal((await call("GET", `/pcr/${pcr}`, null, tok.medic)).status, 403, "the partner on the same chart can't open it: it was sent to one person");
  assert.equal((await call("GET", "/pcr/mine", null, tok.medic)).body.charts.length, 0);
  const stats = (await call("GET", "/me/stats", null, tok.emt)).body;
  assert.deepEqual([stats.assigned, stats.completed, stats.pending, stats.awaitingCorrection], [1, 0, 1, 1]);
  const fixed = await call("GET", `/pcr/${pcr}`, null, tok.emt);
  assert.equal(fixed.body.access, "edit");
  assert.equal((await call("POST", `/pcr/${pcr}/vitals`, { heartRate: 84, bpSystolic: 118, bpDiastolic: 78 }, tok.emt)).status, 201);
  assert.equal((await call("DELETE", `/pcr/${pcr}/vitals/${fixed.body.vitals[0].vital_id}`, null, tok.emt)).status, 200, "an entry made by mistake can be removed while it's open to you");
  await call("PUT", `/pcr/${pcr}/disposition`, { dispositionType: "transported", primaryImpression: "Chest pain" }, tok.emt);
  assert.equal((await call("POST", `/pcr/${pcr}/submit`, {}, tok.emt)).status, 200);
  assert.deepEqual((await call("GET", "/pcr/mine", null, tok.emt)).body.charts, []);
  const events = (await call("GET", `/pcr/${pcr}`, null, tok.qa)).body.events.map((e) => e.kind);
  assert.deepEqual(events, ["created", "submitted", "reopened", "resubmitted"]);

  // sign-off
  assert.equal((await call("POST", `/pcr/${pcr}/approve`, {}, tok.medic)).status, 403, "can't approve a chart you were on");
  assert.equal((await call("POST", `/pcr/${pcr}/approve`, {}, tok.qa)).status, 200);
  assert.equal((await call("GET", `/pcr/${pcr}`, null, tok.qa)).body.status, "finalized");
  assert.equal((await call("POST", `/pcr/${pcr}/reopen`, { assignToUserId: ctx.emt.user_id, note: "too late now" }, tok.qa)).status, 409);
  const done = (await call("GET", "/me/stats", null, tok.emt)).body;
  assert.deepEqual([done.assigned, done.completed, done.pending], [1, 1, 0]);
  const mvoStats = (await call("GET", "/me/stats", null, tok.mvo)).body;
  assert.deepEqual([mvoStats.assigned, mvoStats.completed, mvoStats.pending, mvoStats.canChart], [1, 0, 0, false], "an MVO has calls but never charts");
  assert.ok((await q("SELECT count(*) AS n FROM audit_log WHERE action = 'view' AND table_name = 'patient_care_records' AND record_id = $1", [pcr]))[0].n >= 2, "every chart open is audited");
});

test("shift check: a unit with a crew owes a check; the system records it when the crew does it, and can't see it any other way", async () => {
  const a = await tokenFor("boss@a.test"), emt = await tokenFor("emt@a.test");
  const row = async (n) => (await call("GET", "/unit-checks/status", null, a)).body.find((u) => u.unit_designation === n);
  const idle = await row("Rig 9");
  assert.equal(idle.check_due, false, "no crew on it, so nothing is owed");
  const medic1 = await row("Medic 1");
  assert.equal(medic1.crew_count > 0, true);
  const items = (await call("GET", `/checklist?unitId=${ctx.als.unit_id}`, null, emt)).body.map((i) => ({ itemId: i.item_id, ok: true }));
  await call("POST", "/unit-checks", { unitId: ctx.als.unit_id, items }, emt);
  assert.equal((await row("Medic 1")).check_due, false, "done for this crew");
  await admin.query("UPDATE unit_checks SET performed_at = now() - interval '14 hours' WHERE unit_id = $1", [ctx.als.unit_id]);
  assert.equal((await row("Medic 1")).check_due, true, "a check from 14 hours ago doesn't cover a new shift");
});

test("saved places: a supervisor keeps the list, anyone searches it, and a call can point at one as its destination (which the chart then starts from)", async () => {
  const a = await tokenFor("boss@a.test"), b = await tokenFor("boss@b.test");
  await call("POST", `/incidents/${ctx.chartIncident}/complete`, {}, a);   // frees Medic 1 from the earlier call
  assert.equal((await call("POST", "/facilities", { name: "x", facilityType: "hospital", address: "1 St" }, a)).status, 400);
  const made = await call("POST", "/facilities", { name: "BronxCare Hospital Center", facilityType: "hospital", address: "1650 Grand Concourse, Bronx", lat: 40.8396, lon: -73.9115, accessNotes: "Use the ED ambulance bay" }, a);
  assert.equal(made.status, 201);
  assert.equal((await call("POST", "/facilities", { name: "bronxcare hospital center", facilityType: "hospital", address: "dup address" }, a)).status, 409, "no duplicates");
  assert.equal((await call("POST", "/facilities", { name: "Anywhere", facilityType: "hospital", address: "1 St", lat: 1, lon: 1 }, ctx.dispTok)).status, 403, "dispatchers search, supervisors edit");
  const found = (await call("GET", "/facilities?q=bronx", null, ctx.dispTok)).body;
  assert.equal(found[0].name, "BronxCare Hospital Center");
  assert.equal(found[0].lat, 40.8396);
  assert.equal((await call("GET", "/facilities?q=bronx", null, b)).body.length, 0, "another company can't see it");

  const call1 = await call("POST", "/incidents", { incidentType: "ift_on_demand", priority: "urgent", sceneAddress: "Somewhere Nursing Home", destinationText: "BronxCare Hospital Center", destinationFacilityId: made.body.facility_id, destLat: 40.8396, destLon: -73.9115 }, a);
  assert.equal(call1.status, 201);
  assert.equal(call1.body.destination_facility_id, made.body.facility_id);
  assert.equal((await call("PATCH", `/incidents/${call1.body.incident_id}`, { destinationFacilityId: null }, a)).body.destination_facility_id, null, "it can be cleared");
  await call("PATCH", `/incidents/${call1.body.incident_id}`, { destinationFacilityId: made.body.facility_id }, a);
  // the crew's chart starts from what dispatch knows
  await call("POST", `/incidents/${call1.body.incident_id}/assignments`, { unitId: ctx.als.unit_id, role: "primary" }, a);
  await call("PATCH", `/units/${ctx.als.unit_id}/status`, { status: "on_scene" }, a);
  const emt = await tokenFor("emt@a.test");
  const chart = (await call("POST", "/pcr", { incidentId: call1.body.incident_id }, emt)).body;
  const open = (await call("GET", `/pcr/${chart.pcr_id}`, null, emt)).body;
  assert.equal(open.call.destination_facility_name, "BronxCare Hospital Center");
  assert.ok(open.times.dispatchedAt && open.times.onSceneAt, "dispatch and on-scene times come from the status history");
  assert.equal(open.times.leftSceneAt, null);
});

test("schedule: shifts can't overlap for a person, on-duty people are listed first, and 'crew units as scheduled' shows its plan before changing anything", async () => {
  const a = await tokenFor("boss@a.test"), disp = ctx.dispTok, crewTok = await tokenFor("emt@a.test");
  const hr = (h) => new Date(Date.now() + h * 3600000).toISOString();
  const shift = (who, over = {}) => call("POST", "/schedule", { crewMemberId: ctx[who].crew_member_id, unitId: ctx.medic7.unit_id, startsAt: hr(-1), endsAt: hr(11), ...over }, disp);

  assert.equal((await call("POST", "/schedule", { crewMemberId: ctx.medic2.crew_member_id, startsAt: hr(0), endsAt: hr(8) }, crewTok)).status, 403, "crew can't edit the schedule");
  assert.equal((await shift("medic2", { startsAt: hr(5), endsAt: hr(1) })).status, 400, "ends before it starts");
  assert.equal((await shift("medic2", { endsAt: hr(30) })).status, 400, "over 24 hours");
  const m = await shift("medic2");
  assert.equal(m.status, 201);
  const clash = await shift("medic2", { startsAt: hr(6), endsAt: hr(18) });
  assert.equal(clash.status, 409);
  assert.ok(clash.body.conflict.startsAt, "the clashing shift is returned so the screen can show it");
  const many = await call("POST", "/schedule", { crewMemberId: ctx.medic2.crew_member_id, unitId: ctx.medic7.unit_id, occurrences: [1, 2, 3].map((d) => ({ startsAt: hr(24 * d + 12), endsAt: hr(24 * d + 24) })) }, disp);
  assert.equal(many.body.created, 3, "the same shift across several days");
  assert.equal((await call("POST", "/schedule", { crewMemberId: ctx.medic2.crew_member_id, occurrences: [{ startsAt: hr(24 * 5), endsAt: hr(24 * 5 + 8) }, { startsAt: hr(24 * 2 + 14), endsAt: hr(24 * 2 + 20) }] }, disp)).status, 409, "all or nothing: one clash saves none");
  assert.equal((await call("GET", `/schedule?from=${hr(-2)}&to=${hr(24 * 6)}`, null, disp)).body.length, 4, "nothing from the failed batch was saved");
  assert.equal((await shift("emtDriver", { seatRole: "driver" })).status, 201);
  assert.equal((await call("POST", "/schedule", { crewMemberId: ctx.disp.crew_member_id, startsAt: hr(0), endsAt: hr(8) }, disp)).status, 409, "office-only staff aren't scheduled on units");

  const roster = (await call("GET", "/ops/roster?onDuty=1", null, disp)).body;
  assert.deepEqual(roster.map((r) => r.name).sort(), ["Ed Driver", "Max Medic"]);
  assert.ok(roster.every((r) => r.on_duty && r.shift_unit === "Medic 7"));
  const mine = (await call("GET", "/schedule/mine", null, await tokenFor("ed@a.test"))).body;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].unit_designation, "Medic 7");

  // plan first. Medic 7 currently has Max (scheduled) and nobody else; an unscheduled extra is added to see them removed.
  const extra = (await call("POST", "/users", { email: "extra@a.test", displayName: "Extra Emt", roles: ["crew"], fieldLevel: "emt", password: PW }, a)).body;
  await call("PUT", `/crew/${extra.crew_member_id}/unit`, { unitId: ctx.medic7.unit_id, seatRole: "non_driver" }, disp);
  await call("PUT", `/crew/${ctx.emtDriver.crew_member_id}/unit`, { unitId: null }, disp);
  const plan = (await call("POST", "/schedule/apply", { dryRun: true }, disp)).body;
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.remove.map((r) => r.name), ["Extra Emt"]);
  assert.deepEqual(plan.place.map((p) => [p.name, p.seat]), [["Ed Driver", "driver"]]);
  const stillThere = (await call("GET", "/units", null, a)).body.find((u) => u.unit_designation === "Medic 7");
  assert.ok(stillThere.crew.some((c) => c.name === "Extra Emt"), "a dry run changes nothing");

  const done = await call("POST", "/schedule/apply", {}, disp);
  assert.deepEqual([done.body.removed, done.body.placed, done.body.skipped.length], [1, 1, 0]);
  const after = (await call("GET", "/units", null, a)).body.find((u) => u.unit_designation === "Medic 7");
  assert.deepEqual(after.crew.map((c) => [c.name, c.role]).sort(), [["Ed Driver", "driver"], ["Max Medic", "non_driver"]]);
  assert.equal(after.current_status, "available", "crewed as scheduled: driver + paramedic");
  assert.equal((await call("POST", "/schedule/apply", { dryRun: true }, disp)).body.place.length, 0, "applying again has nothing left to do");

  const sh = (await call("GET", `/schedule?from=${hr(-2)}&to=${hr(14)}`, null, disp)).body.find((s) => s.name === "Max Medic");
  assert.equal((await call("PATCH", `/schedule/${sh.shift_id}`, { endsAt: hr(9), notes: "Covering for Sam" }, disp)).status, 200);
  assert.equal((await call("DELETE", `/schedule/${sh.shift_id}`, null, disp)).status, 200);
  assert.equal((await call("DELETE", `/schedule/${sh.shift_id}`, null, disp)).status, 404);
  assert.equal((await call("GET", "/schedule?from=2026-01-01&to=2027-06-01", null, disp)).status, 400, "ask for a month at a time");
  assert.equal((await call("GET", `/schedule?from=${hr(-2)}&to=${hr(24)}`, null, await tokenFor("boss@b.test"))).body.length, 0, "another company's schedule is invisible");
});

test("response-time report: counts and timed intervals by priority, for supervisors and compliance, not for crew", async () => {
  const a = await tokenFor("boss@a.test"), crewTok = await tokenFor("emt@a.test");
  assert.equal((await call("GET", "/reports/response?days=30", null, crewTok)).status, 403);
  const r = (await call("GET", "/reports/response?days=30", null, a)).body;
  assert.equal(r.days, 30);
  assert.ok(r.totalCalls >= 3 && r.byPriority.length >= 1);
  const timed = r.byPriority.find((p) => p.timed > 0);
  assert.ok(timed, "at least one priority has calls with a recorded on-scene time");
  for (const k of ["dispatchMedian", "turnoutMedian", "travelMedian", "responseMedian", "responseP90"]) assert.ok(timed[k] === null || timed[k] >= 0, `${k} is a non-negative number of seconds`);
  assert.ok(timed.responseP90 >= timed.responseMedian);
  assert.ok(r.daily.reduce((n, d) => n + d.calls, 0) >= 3);
  assert.equal((await call("GET", "/reports/response?days=999", null, a)).body.days, 30, "only the offered ranges");
  assert.equal((await call("GET", "/reports/response?days=7", null, await tokenFor("boss@b.test"))).body.totalCalls, 0, "another company's calls aren't in it");
});

test("unit checks: the checklist is the agency's own, a shift check needs every line answered, a failure needs a note and flags the unit", async () => {
  const a = await tokenFor("boss@a.test"), emt = await tokenFor("emt@a.test"), mvo = await tokenFor("mvo@a.test");
  const forUnit = (await call("GET", `/checklist?unitId=${ctx.als.unit_id}`, null, emt)).body;
  assert.ok(forUnit.some((i) => i.applies_to === "ALS") && forUnit.some((i) => i.applies_to === "BLS"), "an ALS unit gets BLS and ALS items");
  const blsUnit = (await call("POST", "/units", { designation: "Ambulance 2", capabilityLevel: "BLS" }, a)).body;
  assert.ok((await call("GET", `/checklist?unitId=${blsUnit.unit_id}`, null, a)).body.every((i) => i.applies_to === "BLS"));

  const imp = await call("POST", "/checklist/import", { text: "Pulse oximeter, 2\nSpine board\t3\tBLS\tImmobilization\nTraction splint, 1, ALS, Splints\nPulse oximeter, 2", appliesTo: "BLS", category: "Equipment" }, a);
  assert.equal(imp.status, 201);
  assert.deepEqual(imp.body, { added: 3, skipped: 1 }, "a pasted list is imported; duplicates are skipped");
  assert.equal((await call("POST", "/checklist/import", { text: "x" }, emt)).status, 403, "only supervisors edit the checklist");

  const items = (await call("GET", `/checklist?unitId=${ctx.als.unit_id}`, null, emt)).body;
  const allOk = items.map((i) => ({ itemId: i.item_id, ok: true }));
  assert.equal((await call("POST", "/unit-checks", { unitId: ctx.als.unit_id, items: allOk.slice(1) }, emt)).status, 400, "every line must be answered");
  const oneBad = allOk.map((x, i) => (i === 0 ? { ...x, ok: false } : x));
  assert.equal((await call("POST", "/unit-checks", { unitId: ctx.als.unit_id, items: oneBad }, emt)).status, 400, "a not-OK line needs a note");
  assert.equal((await call("POST", "/unit-checks", { unitId: blsUnit.unit_id, items: [] }, emt)).status, 403, "only the crew on a unit records its check");
  const statusBefore = (await call("GET", "/units", null, a)).body.find((u) => u.unit_designation === "Medic 1").current_status;
  const failed = await call("POST", "/unit-checks", { unitId: ctx.als.unit_id, items: oneBad.map((x, i) => (i === 0 ? { ...x, note: "Strap frayed" } : x)) }, mvo);
  assert.equal(failed.status, 201);
  assert.equal(failed.body.result, "fail");
  const st = (await call("GET", "/unit-checks/status", null, a)).body.find((u) => u.unit_designation === "Medic 1");
  assert.equal(st.last_check_result, "fail");
  assert.deepEqual(st.failed_items, [items[0].label]);
  assert.equal((await call("GET", "/units", null, a)).body.find((u) => u.unit_designation === "Medic 1").current_status, statusBefore, "a failed check flags the unit but never changes its service status; a supervisor decides");
  assert.equal((await call("POST", "/unit-checks", { unitId: ctx.als.unit_id, items: allOk }, emt)).body.result, "pass");

  assert.equal((await call("POST", "/unit-checks/inspection", { unitId: ctx.als.unit_id, kind: "dmv_inspection", result: "pass", nextDue: "2027-06-30" }, emt)).status, 403);
  assert.equal((await call("POST", "/unit-checks/inspection", { unitId: ctx.als.unit_id, kind: "dmv_inspection", result: "pass", nextDue: "2027-06-30" }, a)).status, 201);
  const periodic = (await call("GET", "/unit-checks/status", null, a)).body.find((u) => u.unit_designation === "Medic 1").periodic;
  assert.equal(periodic[0].kind, "dmv_inspection");
  assert.equal(String((await call("GET", "/vehicles", null, a)).body.find((v) => v.unit_designation === "Medic 1").next_inspection_due).slice(0, 10), "2027-06-30");
});

test("deactivating someone ends their session at once, and 8 bad passwords lock an account", async () => {
  const a = await tokenFor("boss@a.test");
  const t = await tokenFor("emt2@a.test");
  assert.equal((await call("PATCH", `/users/${ctx.emt2.user_id}`, { isActive: false }, a)).status, 200);
  assert.equal((await call("GET", "/units", null, t)).status, 401);
  assert.equal((await call("POST", "/auth/login", { email: "emt2@a.test", password: PW })).status, 401);
  assert.equal((await call("PATCH", `/users/${UA}`, { isActive: false }, a)).status, 400, "can't lock yourself out");
  for (let i = 0; i < 8; i++) await call("POST", "/auth/login", { email: "boss@b.test", password: `bad-password-${i}` });
  assert.equal((await call("POST", "/auth/login", { email: "boss@b.test", password: PW })).status, 429);
});

test("a supervisor can reset a person's two-step sign-in, and they set it up again on their next login", async () => {
  const a = await tokenFor("boss@a.test");
  assert.equal((await call("PATCH", `/users/${ctx.emt.user_id}`, { resetMfa: true }, a)).status, 200);
  const next = await call("POST", "/auth/login", { email: "emt@a.test", password: PW });
  assert.equal(next.body.step, "mfa_setup");
});

// ---- the platform administrator -----------------------------------------------------------
test("the platform admin runs companies and helps accounts, with its own session, and can't read any company's data", async () => {
  const bad = await call("POST", "/auth/login", { email: "root@platform.test", password: "wrong-wrong-wrong" });
  assert.equal(bad.status, 401);
  const r = await signIn("root@platform.test", "platform-password-123");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.kind, "platform");
  const root = r.body.token;

  const companyToken = await tokenFor("boss@a.test");
  assert.equal((await call("GET", "/platform/tenants", null, companyToken)).status, 401, "a company session can't reach the platform");
  assert.equal((await call("GET", "/units", null, root)).status, 401, "a platform session can't reach company data");
  assert.equal((await call("GET", "/incidents", null, root)).status, 401);
  assert.equal((await call("GET", "/platform/tenants", null, null)).status, 401);

  assert.deepEqual((await call("GET", "/platform/tenants", null, root)).body.map((t) => t.display_name), ["Company A", "Company B"]);
  assert.equal((await call("POST", "/platform/tenants", { name: "Company C", state: "NY", ownerEmail: "boss@a.test", ownerName: "Dup Owner", ownerPassword: PW }, root)).status, 409, "an email already in use can't start a company");
  const made = await call("POST", "/platform/tenants", { name: "Company C", state: "ny", ownerEmail: "owner@c.test", ownerName: "Casey Owner", ownerPassword: PW }, root);
  assert.equal(made.status, 201);
  const owner = await signIn("owner@c.test");
  assert.equal(owner.status, 200);
  assert.equal(owner.body.agency, "Company C");
  assert.ok(owner.body.user.roles.includes("supervisor") && owner.body.user.roles.includes("qa_qi"));
  assert.ok((await call("GET", "/checklist", null, owner.body.token)).body.length > 0, "a new company starts with the starter checklist");

  const users = (await call("GET", `/platform/tenants/${made.body.tenant_id}/users`, null, root)).body;
  assert.equal(users[0].email, "owner@c.test");
  assert.equal(users[0].mfa_enabled, true);
  assert.equal(Object.keys(users[0]).includes("password_hash"), false);

  const help = await call("PATCH", `/platform/users/${users[0].user_id}`, { password: "a-brand-new-password", resetMfa: true }, root);
  assert.equal(help.status, 200);
  assert.equal((await call("POST", "/auth/login", { email: "owner@c.test", password: PW })).status, 401, "old password stops working");
  assert.equal((await call("POST", "/auth/login", { email: "owner@c.test", password: "a-brand-new-password" })).body.step, "mfa_setup");
  const audit = await q("SELECT detail FROM audit_log WHERE tenant_id = $1 AND action = 'platform_support' ORDER BY audit_id", [made.body.tenant_id]);
  assert.deepEqual(audit.map((x) => x.detail.what), ["company created", "password reset, two-step sign-in reset"], "each platform action is in the company's own audit log");
  assert.equal(audit[1].detail.platform_admin.length, 36);

  assert.equal((await call("PATCH", `/platform/tenants/${made.body.tenant_id}`, { isActive: false }, root)).status, 200);
  assert.equal((await call("GET", "/units", null, owner.body.token)).status, 401, "a suspended company is locked out immediately");
  assert.equal((await call("POST", "/auth/login", { email: "owner@c.test", password: "a-brand-new-password" })).status, 401);
});

test("the app's database login can't touch platform admin accounts directly", async () => {
  const url = process.env.DATABASE_URL;
  const app = new pg.Client({ connectionString: url });
  await app.connect();
  try {
    await assert.rejects(() => app.query("SELECT * FROM platform_admins"), /permission denied/i);
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_tenant_id', $1, true)", [TA]);
    await assert.rejects(() => app.query("UPDATE pcr_events SET note = 'x'"), /permission denied/i, "chart history is append-only for the app");
    await app.query("ROLLBACK");
  } finally {
    await app.end();
  }
});
