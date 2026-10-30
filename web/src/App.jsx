import { useEffect, useState } from "react";
import DispatchConsole from "./consoles/dispatch_console.jsx";
import FieldUnitConsole from "./consoles/field_unit_console.jsx";
import ComplianceConsole from "./consoles/compliance_console.jsx";
import EpcrCharting from "./consoles/epcr_charting.jsx";
import TeamConsole from "./consoles/team_console.jsx";
import { apiRequest } from "./api.js";

const API_BASE = import.meta.env?.VITE_API_URL || `${window.location.origin}/api`;
const SESSION_KEY = "ems:session";

const VIEWS = {
  dispatch: { label: "Dispatch", Component: DispatchConsole },
  field: { label: "Field Unit", Component: FieldUnitConsole },
  compliance: { label: "Compliance", Component: ComplianceConsole },
  epcr: { label: "ePCR", Component: EpcrCharting },
  team: { label: "Team", Component: TeamConsole },
};
// Which screens each role is shown. This tidies the menu; what a role may
// actually DO is enforced by the server, not here.
const ROLE_VIEWS = {
  dispatcher: ["dispatch", "field"],
  crew: ["field", "epcr"],
  supervisor: ["dispatch", "field", "epcr", "compliance", "team"],
  it_admin: ["dispatch", "field", "epcr", "compliance", "team"],
  compliance_officer: ["compliance", "epcr"],
  biller: ["compliance"],
  read_only_auditor: ["compliance"],
};
const DEMO_VIEWS = ["dispatch", "field", "compliance", "epcr"];
const ROLE_LABEL = { dispatcher: "Dispatcher", crew: "Crew", supervisor: "Supervisor", compliance_officer: "Compliance", it_admin: "IT admin", biller: "Biller", read_only_auditor: "Auditor" };

// A signed-in session lives in this browser until it expires (12 hours, the
// length of a shift) or the person signs out. The demo is never saved.
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (s && s.token && new Date(s.expiresAt) > new Date()) return { ...s, mode: "live", apiBaseUrl: API_BASE };
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

  const allowed = session ? (session.mode === "demo" ? DEMO_VIEWS : ROLE_VIEWS[session.user?.role] || []) : [];
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
              <span>{session.agency} · {session.user.name} ({ROLE_LABEL[session.user.role] || session.user.role})</span>
              <button onClick={() => setShowPw(true)} style={{ ...pill, color: C.sub, border: `1px solid ${C.line}`, background: "none", cursor: "pointer" }}>Password</button>
              <button onClick={() => signOut()} style={{ ...pill, color: C.text, border: `1px solid ${C.line}`, background: "none", cursor: "pointer" }}>Sign out</button>
            </>
          )}
        </div>
      </nav>
      {Component ? <Component key={`${current}-${session.mode}`} session={session} /> : <div style={{ padding: 24, color: C.sub, fontFamily: "system-ui" }}>Your role doesn't have a screen yet.</div>}
      {showPw && <ChangePassword session={session} onClose={() => setShowPw(false)} />}
    </div>
  );
}

function SignIn({ onSignedIn, onDemo, notice }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = { width: "100%", fontSize: "16px", padding: "12px", borderRadius: "8px", backgroundColor: C.sunken, border: `1px solid ${C.line}`, color: C.text, boxSizing: "border-box" };

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await apiRequest({ apiBaseUrl: API_BASE }, "POST", "/auth/login", { email, password });
      onSignedIn({ token: r.token, expiresAt: r.expiresAt, user: r.user, agency: r.agency });
    } catch (err) {
      setError(err.message || "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", backgroundColor: C.bg, color: C.text, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px", fontFamily: "'Inter', system-ui, sans-serif" }}>
      <div style={{ width: "100%", maxWidth: "380px" }}>
        <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: C.faint }}>EMS Dispatch</div>
        <h1 style={{ fontSize: "24px", fontWeight: 600, margin: "4px 0 20px" }}>Sign in</h1>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {notice && <div style={{ fontSize: "14px", color: C.amber }}>{notice}</div>}
          <label style={{ fontSize: "13px", color: C.sub }}>Email
            <input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} style={{ ...input, marginTop: "4px" }} />
          </label>
          <label style={{ fontSize: "13px", color: C.sub }}>Password
            <input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} style={{ ...input, marginTop: "4px" }} />
          </label>
          {error && <div style={{ fontSize: "14px", color: C.red }}>{error}</div>}
          <button type="submit" disabled={busy} style={{ padding: "12px", fontSize: "16px", fontWeight: 600, borderRadius: "8px", backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: C.green, cursor: "pointer" }}>{busy ? "Signing in…" : "Sign in"}</button>
          <div style={{ fontSize: "12px", color: C.faint }}>Forgot your password? Ask your supervisor to reset it.</div>
        </form>
        <div style={{ margin: "28px 0 12px", borderTop: `1px solid ${C.line}` }} />
        <button onClick={onDemo} style={{ width: "100%", padding: "12px", fontSize: "14px", borderRadius: "8px", backgroundColor: "transparent", border: `1px solid ${C.line}`, color: C.sub, cursor: "pointer" }}>View demo</button>
        <div style={{ fontSize: "12px", color: C.faint, marginTop: "6px" }}>Sample data only. Nothing real is shown or saved.</div>
      </div>
    </div>
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
