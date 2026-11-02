import { useEffect, useState } from "react";
import QRCode from "qrcode";
import DispatchConsole from "./consoles/dispatch_console.jsx";
import FieldUnitConsole from "./consoles/field_unit_console.jsx";
import ComplianceConsole from "./consoles/compliance_console.jsx";
import EpcrCharting from "./consoles/epcr_charting.jsx";
import TeamConsole from "./consoles/team_console.jsx";
import QaConsole from "./consoles/qa_console.jsx";
import PlatformConsole from "./consoles/platform_console.jsx";
import OpsConsole from "./consoles/ops_console.jsx";
import { CallDraftTray } from "./consoles/call_form.jsx";
import { apiRequest } from "./api.js";

const API_BASE = import.meta.env?.VITE_API_URL || `${window.location.origin}/api`;
const SESSION_KEY = "ems:session";

const VIEWS = {
  dispatch: { label: "Dispatch", Component: DispatchConsole },
  ops: { label: "OPS", Component: OpsConsole },
  field: { label: "Field Unit", Component: FieldUnitConsole },
  epcr: { label: "ePCR", Component: EpcrCharting },
  qa: { label: "QA/QI", Component: QaConsole },
  compliance: { label: "Compliance", Component: ComplianceConsole },
  team: { label: "Team", Component: TeamConsole },
  platform: { label: "Platform", Component: PlatformConsole },
};
const DEMO_VIEWS = ["dispatch", "field", "epcr", "compliance"];
const VIEW_ORDER = ["dispatch", "ops", "field", "epcr", "qa", "compliance", "team", "platform"];
// Which screens each role is shown. This tidies the menu; what a role may
// actually DO is enforced by the server, not here. A person with several
// roles gets every screen any of them gets.
const ROLE_VIEWS = {
  dispatcher: ["dispatch", "ops"],
  supervisor: ["dispatch", "ops", "compliance", "team"],
  it_admin: ["ops", "team"],
  qa_qi: ["qa"],
  compliance_officer: ["compliance"],
  biller: ["compliance"],
  read_only_auditor: ["compliance"],
  crew: ["field"],
};
const CLINICAL = ["emt", "aemt", "paramedic"];
function viewsFor(session) {
  if (session.mode === "demo") return DEMO_VIEWS;
  if (session.kind === "platform") return ["platform"];
  const set = new Set();
  for (const r of session.user.roles || [session.user.role]) (ROLE_VIEWS[r] || []).forEach((v) => set.add(v));
  if (CLINICAL.includes(session.user.fieldLevel)) set.add("epcr");   // MVOs drive; they don't chart
  return VIEW_ORDER.filter((v) => set.has(v));
}
const ROLE_LABEL = { dispatcher: "Dispatcher", crew: "Field", supervisor: "Supervisor", qa_qi: "QA/QI", compliance_officer: "Compliance", it_admin: "IT admin", biller: "Biller", read_only_auditor: "Auditor" };

// A signed-in session lives in this browser until it expires (12 hours, the
// length of a shift) or the person signs out. The demo is never saved.
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (s && s.token && s.kind && new Date(s.expiresAt) > new Date()) return { ...s, mode: "live", apiBaseUrl: API_BASE };
  } catch (e) { /* none */ }
  return null;
}
const keyFromHash = () => window.location.hash.replace(/^#\/?/, "");

const C = { bg: "#0A0E13", panel: "#131A24", sunken: "#0D131B", line: "#232C3A", text: "#E7ECF2", sub: "#A9B6C6", faint: "#8795AB", blue: "#4EA1F0", green: "#34D399", red: "#F0554A", amber: "#F5934A" };

export default function App() {
  const [session, setSession] = useState(loadSession);
  const [notice, setNotice] = useState("");
  const [view, setView] = useState(keyFromHash);
  const [showPw, setShowPw] = useState(false);

  const allowed = session ? viewsFor(session) : [];
  const current = allowed.includes(view) ? view : allowed[0];

  function signOut(message = "") {
    try { localStorage.removeItem(SESSION_KEY); sessionStorage.clear(); } catch (e) { /* nothing stored */ }
    setSession(null);
    setNotice(message);
    window.location.hash = "";
  }

  useEffect(() => {
    const onChange = () => setView(keyFromHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  // Any 401 from our own API means the session ended (expired, or the account
  // was deactivated): go back to sign-in instead of showing broken screens.
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const res = await original(...args);
      const url = String(args[0]?.url || args[0] || "");
      if (res.status === 401 && url.startsWith(API_BASE) && !url.includes("/auth/login")) {
        window.dispatchEvent(new Event("ems-session-ended"));
      }
      return res;
    };
    const ended = () => signOut("Your session ended. Please sign in again.");
    window.addEventListener("ems-session-ended", ended);
    return () => { window.fetch = original; window.removeEventListener("ems-session-ended", ended); };
  }, []);

  if (!session) {
    return (
      <SignIn
        notice={notice}
        onSignedIn={(s) => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* works for this tab only */ } setSession({ ...s, mode: "live", apiBaseUrl: API_BASE }); setNotice(""); }}
        onDemo={() => { setSession({ mode: "demo" }); setNotice(""); }}
      />
    );
  }

  const Component = VIEWS[current]?.Component;
  const demo = session.mode === "demo";
  const pill = { padding: "4px 10px", borderRadius: "6px", textDecoration: "none", fontSize: "13px" };
  return (
    <div>
      <nav style={{ display: "flex", alignItems: "center", gap: "4px", padding: "6px 12px", backgroundColor: "#06090D", borderBottom: `1px solid ${C.line}`, fontFamily: "system-ui, sans-serif", flexWrap: "wrap" }}>
        {allowed.map((key) => (
          <a key={key} href={`#/${key}`} style={{ ...pill, color: key === current ? C.text : C.faint, backgroundColor: key === current ? C.panel : "transparent" }}>{VIEWS[key].label}</a>
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: C.sub }}>
          {demo ? (
            <>
              <span style={{ color: C.amber, border: `1px solid ${C.amber}`, borderRadius: "6px", padding: "2px 8px" }}>DEMO: sample data, nothing is saved</span>
              <button onClick={() => signOut()} style={{ ...pill, color: C.text, border: `1px solid ${C.line}`, background: "none", cursor: "pointer" }}>Exit demo</button>
            </>
          ) : (
            <>
              <span>{session.kind === "platform" ? "Platform admin" : session.agency} · {session.user.name}{session.kind === "platform" ? "" : ` (${(session.user.roles || [session.user.role]).map((r) => ROLE_LABEL[r] || r).join(", ")})`}</span>
              {session.kind !== "platform" && <button onClick={() => setShowPw(true)} style={{ ...pill, color: C.sub, border: `1px solid ${C.line}`, background: "none", cursor: "pointer" }}>Password</button>}
              <button onClick={() => signOut()} style={{ ...pill, color: C.text, border: `1px solid ${C.line}`, background: "none", cursor: "pointer" }}>Sign out</button>
            </>
          )}
        </div>
      </nav>
      {Component ? <Component key={`${current}-${session.mode}`} session={session} /> : <div style={{ padding: 24, color: C.sub, fontFamily: "system-ui" }}>Your role doesn't have a screen yet.</div>}
      {session.mode === "demo" || (session.kind === "tenant" && (session.user.roles || []).some((r) => ["dispatcher", "supervisor", "it_admin"].includes(r))) ? <CallDraftTray session={session} /> : null}
      {showPw && session.kind !== "platform" && <ChangePassword session={session} onClose={() => setShowPw(false)} />}
    </div>
  );
}

// Two steps. 1) email + password. 2) a 6-digit code from an authenticator app. The first
// time, step 2 is setting that app up (scan a QR code or type a key), then the person is
// shown recovery codes once, in case they lose their phone.
function SignIn({ onSignedIn, onDemo, notice }) {
  const [step, setStep] = useState("password");     // password | mfa | setup | recovery
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [setup, setSetup] = useState(null);           // { secret, otpauthUrl, qr }
  const [pending, setPending] = useState(null);       // a finished sign-in waiting for "I saved my codes"
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const api = (path, body) => apiRequest({ apiBaseUrl: API_BASE }, "POST", path, body);
  const input = { width: "100%", fontSize: "16px", padding: "12px", borderRadius: "8px", backgroundColor: C.sunken, border: `1px solid ${C.line}`, color: C.text, boxSizing: "border-box", marginTop: "4px" };
  const primary = { padding: "12px", fontSize: "16px", fontWeight: 600, borderRadius: "8px", backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: C.green, cursor: "pointer" };
  const link = { background: "none", border: "none", color: C.faint, fontSize: "13px", cursor: "pointer", textAlign: "left", padding: 0 };
  const sessionOf = (r) => ({ kind: r.kind, token: r.token, expiresAt: r.expiresAt, user: r.user, agency: r.agency });

  async function run(fn) {
    setBusy(true); setError("");
    try { await fn(); } catch (err) { setError(err.message || "Something went wrong"); } finally { setBusy(false); }
  }
  const back = () => { setStep("password"); setCode(""); setChallenge(""); setSetup(null); setError(""); };

  const submitPassword = (e) => { e.preventDefault(); run(async () => {
    const r = await api("/auth/login", { email, password });
    setChallenge(r.challenge); setCode("");
    if (r.step === "mfa") { setStep("mfa"); return; }
    const s = await api("/auth/mfa/setup", { challenge: r.challenge });
    setSetup({ ...s, qr: await QRCode.toDataURL(s.otpauthUrl, { margin: 1, width: 200 }) });
    setStep("setup");
  }); };
  const submitCode = (e) => { e.preventDefault(); run(async () => {
    const r = await api(step === "setup" ? "/auth/mfa/enable" : "/auth/mfa/verify", { challenge, code });
    if (step === "setup") { setPending({ session: sessionOf(r), codes: r.recoveryCodes }); setStep("recovery"); }
    else onSignedIn(sessionOf(r));
  }); };

  const shell = (children) => (
    <div style={{ minHeight: "100vh", backgroundColor: C.bg, color: C.text, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ width: "100%", maxWidth: "380px" }}>
        <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: C.faint }}>EMS Dispatch</div>
        {children}
      </div>
    </div>
  );

  if (step === "recovery") {
    return shell(
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <h1 style={{ fontSize: "22px", fontWeight: 600, margin: "4px 0 0" }}>Save your recovery codes</h1>
        <div style={{ fontSize: "14px", color: C.sub }}>If you lose your phone, each of these signs you in once. They won't be shown again. Keep them somewhere safe, not in this browser.</div>
        <div style={{ fontFamily: "ui-monospace, monospace", fontSize: "16px", backgroundColor: C.sunken, border: `1px solid ${C.line}`, borderRadius: "8px", padding: "12px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
          {pending.codes.map((c) => <div key={c}>{c}</div>)}
        </div>
        <label style={{ fontSize: "14px", color: C.sub, display: "flex", gap: "8px", alignItems: "center" }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I've saved these codes
        </label>
        <button disabled={!saved} onClick={() => onSignedIn(pending.session)} style={{ ...primary, opacity: saved ? 1 : 0.5 }}>Continue</button>
      </div>
    );
  }
  if (step === "setup" || step === "mfa") {
    return shell(
      <form onSubmit={submitCode} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <h1 style={{ fontSize: "22px", fontWeight: 600, margin: "4px 0 0" }}>{step === "setup" ? "Set up two-step sign-in" : "Enter your code"}</h1>
        {step === "setup" && setup && (
          <>
            <div style={{ fontSize: "14px", color: C.sub }}>Add this account to an authenticator app (Google Authenticator, Authy, 1Password, Microsoft Authenticator). Then type the 6-digit code it shows.</div>
            <img alt="QR code to scan with your authenticator app" src={setup.qr} width="200" height="200" style={{ alignSelf: "center", borderRadius: "8px", backgroundColor: "#fff" }} />
            <a href={setup.otpauthUrl} style={{ color: C.blue, fontSize: "14px" }}>On this phone? Tap to open your authenticator app</a>
            <div style={{ fontSize: "13px", color: C.faint }}>Or type this key in by hand:<div style={{ fontFamily: "ui-monospace, monospace", color: C.text, fontSize: "15px", wordBreak: "break-all", marginTop: "4px" }}>{setup.secret.match(/.{1,4}/g).join(" ")}</div></div>
          </>
        )}
        {step === "mfa" && <div style={{ fontSize: "14px", color: C.sub }}>Open your authenticator app and enter the 6-digit code for this account. Lost your phone? Enter one of your recovery codes instead.</div>}
        <label style={{ fontSize: "13px", color: C.sub }}>{step === "mfa" ? "Code" : "6-digit code"}
          <input name="code" autoComplete="one-time-code" inputMode="text" required autoFocus value={code} onChange={(e) => setCode(e.target.value)} style={{ ...input, letterSpacing: "0.15em" }} />
        </label>
        {error && <div style={{ fontSize: "14px", color: C.red }}>{error}</div>}
        <button type="submit" disabled={busy} style={primary}>{busy ? "Checking…" : step === "setup" ? "Turn on and sign in" : "Sign in"}</button>
        <button type="button" onClick={back} style={link}>← Start over</button>
      </form>
    );
  }
  return shell(
    <>
      <h1 style={{ fontSize: "24px", fontWeight: 600, margin: "4px 0 20px" }}>Sign in</h1>
      <form onSubmit={submitPassword} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        {notice && <div style={{ fontSize: "14px", color: C.amber }}>{notice}</div>}
        <label style={{ fontSize: "13px", color: C.sub }}>Email
          <input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} style={input} />
        </label>
        <label style={{ fontSize: "13px", color: C.sub }}>Password
          <input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} style={input} />
        </label>
        {error && <div style={{ fontSize: "14px", color: C.red }}>{error}</div>}
        <button type="submit" disabled={busy} style={primary}>{busy ? "Signing in…" : "Sign in"}</button>
        <div style={{ fontSize: "12px", color: C.faint }}>Forgot your password or lost your phone? Ask your supervisor to reset it.</div>
      </form>
      <div style={{ margin: "28px 0 12px", borderTop: `1px solid ${C.line}` }} />
      <button onClick={onDemo} style={{ width: "100%", padding: "12px", fontSize: "14px", borderRadius: "8px", backgroundColor: "transparent", border: `1px solid ${C.line}`, color: C.sub, cursor: "pointer" }}>View demo</button>
      <div style={{ fontSize: "12px", color: C.faint, marginTop: "6px" }}>Sample data only. Nothing real is shown or saved.</div>
    </>
  );
}

function ChangePassword({ session, onClose }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState({ text: "", ok: false });
  const input = { width: "100%", fontSize: "16px", padding: "10px", borderRadius: "8px", backgroundColor: C.sunken, border: `1px solid ${C.line}`, color: C.text, boxSizing: "border-box", marginTop: "4px" };
  async function submit(e) {
    e.preventDefault();
    try {
      await apiRequest(session, "POST", "/auth/change-password", { currentPassword: current, newPassword: next });
      setMsg({ text: "Password changed.", ok: true });
      setCurrent(""); setNext("");
    } catch (err) {
      setMsg({ text: err.message, ok: false });
    }
  }
  return (
    <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px", zIndex: 60, fontFamily: "system-ui, sans-serif" }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: "360px", backgroundColor: C.panel, border: `1px solid ${C.line}`, borderRadius: "10px", padding: "16px", color: C.text, display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ fontWeight: 600 }}>Change password</div>
        <label style={{ fontSize: "13px", color: C.sub }}>Current password<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} style={input} /></label>
        <label style={{ fontSize: "13px", color: C.sub }}>New password (10+ characters)<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} style={input} /></label>
        {msg.text && <div style={{ fontSize: "13px", color: msg.ok ? C.green : C.red }}>{msg.text}</div>}
        <div style={{ display: "flex", gap: "8px" }}>
          <button type="submit" style={{ flex: 1, padding: "10px", borderRadius: "8px", backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: C.green, cursor: "pointer" }}>Change</button>
          <button type="button" onClick={onClose} style={{ padding: "10px 14px", borderRadius: "8px", backgroundColor: C.sunken, border: `1px solid ${C.line}`, color: C.sub, cursor: "pointer" }}>Close</button>
        </div>
      </form>
    </div>
  );
}
