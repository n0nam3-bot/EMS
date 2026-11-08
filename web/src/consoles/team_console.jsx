import React, { useState, useEffect, useCallback, useRef } from "react";
import { apiRequest, apiRequestPaged } from "../api.js";

const HAIRLINE = "#232C3A", PANEL = "#131A24", VOID = "#0A0E13", SUNKEN = "#0D131B";
const TEXT_PRIMARY = "#E7ECF2", TEXT_SECONDARY = "#A9B6C6", TEXT_FAINT = "#8795AB";
const GREEN = "#34D399", RED = "#F0554A", AMBER = "#F5934A", BLUE = "#4EA1F0";
const PAGE = 25;

// Office roles. "crew" isn't listed: working on a unit is expressed by a field level.
const OFFICE_ROLES = [
  ["dispatcher", "Dispatcher"], ["supervisor", "Supervisor"], ["qa_qi", "QA/QI"], ["compliance_officer", "Compliance officer"],
  ["it_admin", "IT admin"], ["biller", "Biller"], ["read_only_auditor", "Read-only auditor"],
];
const OFFICE_ROLE_LABEL = Object.fromEntries(OFFICE_ROLES);
const FIELD_LEVELS = [["mvo", "MVO (driver, doesn't chart)"], ["emt", "EMT"], ["aemt", "AEMT"], ["paramedic", "Paramedic"]];
const LEVEL_LABEL = { mvo: "MVO", emt: "EMT", aemt: "AEMT", paramedic: "Paramedic" };
const STATUS_LABEL = { available: "Available", assigned: "Assigned", en_route: "En route", on_scene: "On scene", transporting: "Transporting", at_destination: "At destination", out_of_service: "Out of service" };
const INSPECTION_KINDS = [["dmv_inspection", "DMV inspection"], ["mechanical", "Mechanical / maintenance"], ["doh_inspection", "DOH inspection"], ["other", "Other"]];
const KIND_LABEL = Object.fromEntries(INSPECTION_KINDS);
const PLACE_TYPES = [["hospital", "Hospital"], ["nursing_home", "Nursing home"], ["dialysis_center", "Dialysis center"], ["rehab", "Rehab"], ["clinic", "Clinic"], ["other", "Other"]];
const PLACE_LABEL = Object.fromEntries(PLACE_TYPES);

const field = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY };
const btn = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY };
const btnGreen = { backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN };

function randomPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => chars[b % chars.length]).join("");
}
const daysUntil = (d) => Math.ceil((new Date(d) - new Date(new Date().toDateString())) / 86400000);
const ago = (d) => { const h = (Date.now() - new Date(d)) / 3600000; return h < 1 ? "just now" : h < 24 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`; };
const Labeled = ({ label, children }) => <label className="flex flex-col gap-1 min-w-0"><span className="text-xs" style={{ color: TEXT_SECONDARY }}>{label}</span>{children}</label>;
const Chip = ({ children, color = TEXT_SECONDARY }) => <span className="text-xs px-1.5 py-0.5 rounded whitespace-nowrap" style={{ color, border: `1px solid ${HAIRLINE}` }}>{children}</span>;

export default function TeamConsole({ session }) {
  const [tab, setTab] = useState("field");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Every change goes through here: do it, then let the list reload, and show the server's own
  // words if it refuses (for example "no current ALS certification").
  const act = useCallback(async (fn, success) => {
    setError(""); setNotice("");
    try { const r = await fn(); setNotice(r?.warning || success || ""); return true; }
    catch (e) { setError(e.message); return false; }
  }, []);

  const tabs = [["field", "Field personnel"], ["office", "Office personnel"], ["units", "Units & inspections"], ["places", "Saved places"]];
  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen w-full">
      <style>{`* { box-sizing: border-box; } button, input, select, textarea { font-family: inherit; } .mono { font-family: ui-monospace, monospace; }`}</style>
      <div className="px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
        <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>{session.agency}</div>
        <div className="text-lg font-semibold">Team</div>
        <div className="flex gap-2 mt-3 flex-wrap">
          {tabs.map(([k, l]) => <button key={k} onClick={() => { setTab(k); setError(""); setNotice(""); }} className="text-sm px-3 py-1.5 rounded-md" style={{ backgroundColor: tab === k ? BLUE : SUNKEN, color: tab === k ? "#06090D" : TEXT_PRIMARY, border: `1px solid ${HAIRLINE}`, fontWeight: tab === k ? 600 : 400 }}>{l}</button>)}
        </div>
      </div>
      <div className="p-4 flex flex-col gap-3" style={{ maxWidth: "980px" }}>
        {error && <div className="text-sm px-3 py-2 rounded-md" style={{ color: RED, backgroundColor: "rgba(240,85,74,0.1)", border: "1px solid #593434" }}>{error}</div>}
        {notice && <div className="text-sm px-3 py-2 rounded-md" style={{ color: GREEN, backgroundColor: "rgba(52,211,153,0.08)", border: "1px solid #2E5943" }}>{notice}</div>}
        {(tab === "field" || tab === "office") && <People key={tab} kind={tab} session={session} act={act} />}
        {tab === "units" && <UnitsAndInspections session={session} act={act} />}
        {tab === "places" && <Places session={session} act={act} />}
      </div>
    </div>
  );
}

// A list that stays small: a search box and filters at the top, one line per item, a page at a time.
function ListBar({ q, setQ, placeholder, children, total, shown, page, setPage }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder={placeholder} className="text-sm rounded px-2.5 py-1.5" style={{ ...field, width: "240px", maxWidth: "100%" }} />
      {children}
      <span className="text-xs ml-auto" style={{ color: TEXT_FAINT }}>{total === 0 ? "None" : `${page * PAGE + 1}–${page * PAGE + shown} of ${total}`}</span>
      <button disabled={page === 0} onClick={() => setPage(page - 1)} className="text-xs px-2 py-1.5 rounded" style={{ ...btn, opacity: page === 0 ? 0.4 : 1 }}>Prev</button>
      <button disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)} className="text-xs px-2 py-1.5 rounded" style={{ ...btn, opacity: (page + 1) * PAGE >= total ? 0.4 : 1 }}>Next</button>
    </div>
  );
}

function RoleBoxes({ value, onChange }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {OFFICE_ROLES.map(([k, l]) => <label key={k} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={value.includes(k)} onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((r) => r !== k))} />{l}</label>)}
    </div>
  );
}

// ---- People --------------------------------------------------------------------------------------
function People({ kind, session, act }) {
  const isField = kind === "field";
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("active");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState(null);
  const [units, setUnits] = useState([]);
  const [certTypes, setCertTypes] = useState([]);
  const [loadError, setLoadError] = useState("");
  const timer = useRef();

  const load = useCallback(async () => {
    try {
      const r = await apiRequestPaged(session, `/users?kind=${kind}&status=${status}&limit=${PAGE}&offset=${page * PAGE}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
      setRows(r.rows); setTotal(r.total); setLoadError("");
    } catch (e) { setLoadError(e.message); }
  }, [session, kind, status, page, q]);
  useEffect(() => { clearTimeout(timer.current); timer.current = setTimeout(load, q ? 250 : 0); return () => clearTimeout(timer.current); }, [load, q]);
  useEffect(() => { apiRequest(session, "GET", "/units").then(setUnits).catch(() => {}); apiRequest(session, "GET", "/certification-types").then(setCertTypes).catch(() => {}); }, [session]);
  const change = async (fn, ok) => { const done = await act(fn, ok); if (done) { await load(); apiRequest(session, "GET", "/units").then(setUnits).catch(() => {}); } return done; };

  return (
    <>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs" style={{ color: TEXT_SECONDARY }}>{isField ? "MVOs, EMTs, AEMTs and paramedics." : "Dispatchers, supervisors, QA/QI, compliance and other office staff."}</div>
        <button onClick={() => setAdding(!adding)} className="text-sm px-3 py-1.5 rounded" style={adding ? btn : btnGreen}>{adding ? "Close" : isField ? "+ Add field personnel" : "+ Add office personnel"}</button>
      </div>
      {adding && <AddPerson kind={kind} session={session} act={act} onCreated={(c) => { setCreated(c); setAdding(false); load(); }} />}
      {created && (
        <div className="rounded-lg border p-4 text-sm" style={{ backgroundColor: "rgba(52,211,153,0.06)", borderColor: "#2E5943" }}>
          <div className="font-semibold mb-1" style={{ color: GREEN }}>Account created. Give them these sign-in details:</div>
          <div className="mono">{created.email}</div><div className="mono">{created.password}</div>
          <div className="text-xs mt-2" style={{ color: TEXT_SECONDARY }}>Not shown again. On first sign-in they set up their authenticator app, and can change this password (top right).</div>
          <button onClick={() => setCreated(null)} className="mt-2 text-xs px-2 py-1 rounded" style={btn}>Done</button>
        </div>
      )}
      <ListBar q={q} setQ={setQ} placeholder="Search name, email or employee #" total={total} shown={(rows || []).length} page={page} setPage={setPage}>
        {["active", "inactive"].map((s) => <button key={s} onClick={() => { setStatus(s); setPage(0); }} className="text-xs px-2.5 py-1.5 rounded-full" style={{ backgroundColor: status === s ? BLUE : SUNKEN, color: status === s ? "#06090D" : TEXT_PRIMARY, border: `1px solid ${HAIRLINE}` }}>{s === "active" ? "Active" : "Deactivated"}</button>)}
      </ListBar>
      {loadError && <div className="text-sm" style={{ color: RED }}>{loadError}</div>}
      {rows === null && !loadError && <div className="text-sm" style={{ color: TEXT_FAINT }}>Loading…</div>}
      {rows && rows.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>{q ? "Nobody matches that search." : "Nobody here yet."}</div>}
      <div className="rounded-lg border overflow-hidden" style={{ borderColor: HAIRLINE, backgroundColor: PANEL, display: rows && rows.length ? "block" : "none" }}>
        {(rows || []).map((u) => (
          <PersonRow key={u.user_id} u={u} me={session.user.id} open={open === u.user_id} toggle={() => setOpen(open === u.user_id ? null : u.user_id)}
            units={units} certTypes={certTypes} act={change} session={session} />
        ))}
      </div>
    </>
  );
}

function AddPerson({ kind, session, act, onCreated }) {
  const isField = kind === "field";
  const [form, setForm] = useState({ displayName: "", email: "", employeeNumber: "", fieldLevel: isField ? "emt" : "", officeRoles: isField ? [] : ["dispatcher"], alsoField: false, password: randomPassword() });
  const set = (p) => setForm({ ...form, ...p });
  async function add(e) {
    e.preventDefault();
    const level = isField ? form.fieldLevel : form.alsoField ? form.fieldLevel || "emt" : null;
    const roles = [...form.officeRoles, ...(level ? ["crew"] : [])];
    const shown = { email: form.email.trim(), password: form.password };
    if (await act(() => apiRequest(session, "POST", "/users", { email: form.email, displayName: form.displayName, employeeNumber: form.employeeNumber, password: form.password, roles, fieldLevel: level }))) onCreated(shown);
  }
  return (
    <form onSubmit={add} className="rounded-lg border p-4 flex flex-col gap-3" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Labeled label="Full name"><input required value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
        <Labeled label="Email (their sign-in name)"><input required type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
        <Labeled label="Employee number (optional)"><input value={form.employeeNumber} onChange={(e) => set({ employeeNumber: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
        <Labeled label="Temporary password (10+ characters)">
          <div className="flex gap-2"><input required value={form.password} onChange={(e) => set({ password: e.target.value })} className="flex-1 min-w-0 text-sm rounded px-2 py-2 mono" style={field} /><button type="button" onClick={() => set({ password: randomPassword() })} className="text-xs px-2 rounded" style={btn}>New</button></div>
        </Labeled>
        {isField && <Labeled label="Field level"><select value={form.fieldLevel} onChange={(e) => set({ fieldLevel: e.target.value })} className="text-sm rounded px-2 py-2" style={field}>{FIELD_LEVELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Labeled>}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs" style={{ color: TEXT_SECONDARY }}>{isField ? "Also has office roles (optional)" : "Office roles (pick at least one)"}</span>
        <RoleBoxes value={form.officeRoles} onChange={(v) => set({ officeRoles: v })} />
      </div>
      {!isField && (
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={form.alsoField} onChange={(e) => set({ alsoField: e.target.checked, fieldLevel: form.fieldLevel || "emt" })} />Also works on a unit</label>
          {form.alsoField && <select value={form.fieldLevel} onChange={(e) => set({ fieldLevel: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field}>{FIELD_LEVELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
        </div>
      )}
      <button type="submit" disabled={!isField && form.officeRoles.length === 0} className="text-sm font-medium rounded px-3 py-2.5" style={{ ...btnGreen, opacity: !isField && form.officeRoles.length === 0 ? 0.5 : 1 }}>Create account</button>
    </form>
  );
}

// One line per person. Everything else is behind the row, shown only for the person you open.
function PersonRow({ u, me, open, toggle, units, certTypes, act, session }) {
  const officeNow = u.roles.filter((r) => r !== "crew");
  return (
    <div className="border-b last:border-b-0" style={{ borderColor: "#1B2330", opacity: u.is_active ? 1 : 0.65 }}>
      <button onClick={toggle} aria-expanded={open} className="w-full flex items-center gap-3 px-3 py-2.5 text-left" style={{ backgroundColor: open ? "#17202C" : "transparent" }}>
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: !u.is_active ? TEXT_FAINT : u.mfa_enabled ? GREEN : AMBER }} title={!u.is_active ? "Deactivated" : u.mfa_enabled ? "Two-step on" : "Two-step not set up yet"} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium truncate">{u.display_name}{u.user_id === me ? " (you)" : ""}</span>
          <span className="block text-xs truncate" style={{ color: TEXT_FAINT }}>{u.email}{u.employee_number ? ` · #${u.employee_number}` : ""}</span>
        </span>
        <span className="hidden sm:flex gap-1.5 flex-wrap justify-end">
          {u.field_level && <Chip color={BLUE}>{LEVEL_LABEL[u.field_level]}</Chip>}
          {officeNow.slice(0, 2).map((r) => <Chip key={r}>{OFFICE_ROLE_LABEL[r] || r}</Chip>)}
          {officeNow.length > 2 && <Chip>+{officeNow.length - 2}</Chip>}
        </span>
        <span className="text-xs w-24 text-right truncate shrink-0" style={{ color: u.unit_designation ? TEXT_PRIMARY : TEXT_FAINT }}>{u.field_level ? u.unit_designation || "no unit" : ""}</span>
        <span className="text-xs shrink-0" style={{ color: TEXT_FAINT }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <PersonDetails u={u} me={me} units={units} certTypes={certTypes} act={act} session={session} />}
    </div>
  );
}

function PersonDetails({ u, me, units, certTypes, act, session }) {
  const officeNow = u.roles.filter((r) => r !== "crew");
  const isMe = u.user_id === me;
  const [d, setD] = useState({ displayName: u.display_name, email: u.email, employeeNumber: u.employee_number || "" });
  const [roles, setRoles] = useState(officeNow);
  const [level, setLevel] = useState(u.field_level || "");
  const [unitId, setUnitId] = useState(u.unit_id || "");
  const [seat, setSeat] = useState(u.seat_role || "non_driver");
  const [resetting, setResetting] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [certs, setCerts] = useState(null);
  const [addingCert, setAddingCert] = useState(false);
  const [cert, setCert] = useState({ certificationTypeId: certTypes[0]?.certification_type_id || "", issuingBody: "", certificateNumber: "", issuedOn: "", expiresOn: "" });
  const loadCerts = useCallback(() => { if (u.crew_member_id && u.field_level) apiRequest(session, "GET", `/certifications?crewMemberId=${u.crew_member_id}`).then(setCerts).catch(() => setCerts([])); }, [session, u.crew_member_id, u.field_level]);
  useEffect(() => { loadCerts(); }, [loadCerts]);

  const detailsDirty = d.displayName !== u.display_name || d.email !== u.email || d.employeeNumber !== (u.employee_number || "");
  const rolesDirty = [...roles].sort().join() !== [...officeNow].sort().join() || level !== (u.field_level || "");
  const unitDirty = (u.unit_id || "") !== unitId || (u.unit_id && (u.seat_role || "non_driver") !== seat);
  const patch = (body, ok) => act(() => apiRequest(session, "PATCH", `/users/${u.user_id}`, body), ok);
  const section = { borderTop: `1px solid #1B2330` };

  return (
    <div className="px-4 pb-4 pt-1 flex flex-col gap-4" style={{ backgroundColor: "#111823" }}>
      <div className="flex flex-col gap-2">
        <div className="text-xs font-semibold tracking-wide" style={{ color: TEXT_FAINT }}>DETAILS</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Labeled label="Full name"><input value={d.displayName} onChange={(e) => setD({ ...d, displayName: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
          <Labeled label="Email (sign-in)"><input type="email" value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
          <Labeled label="Employee #"><input value={d.employeeNumber} onChange={(e) => setD({ ...d, employeeNumber: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
        </div>
        {detailsDirty && (
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => patch({ displayName: d.displayName, email: d.email, employeeNumber: d.employeeNumber }, "Details saved.")} className="text-sm px-3 py-1.5 rounded" style={btnGreen}>Save details</button>
            <button onClick={() => setD({ displayName: u.display_name, email: u.email, employeeNumber: u.employee_number || "" })} className="text-sm px-3 py-1.5 rounded" style={btn}>Undo</button>
            {d.email !== u.email && <span className="text-xs" style={{ color: AMBER }}>They'll sign in with the new email from now on.</span>}
          </div>
        )}
      </div>

      {!isMe && (
        <div className="flex flex-col gap-2 pt-3" style={section}>
          <div className="text-xs font-semibold tracking-wide" style={{ color: TEXT_FAINT }}>ROLES</div>
          <RoleBoxes value={roles} onChange={setRoles} />
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs" style={{ color: TEXT_SECONDARY }}>Works on a unit as</span>
            <select value={level} onChange={(e) => setLevel(e.target.value)} className="text-sm rounded px-2 py-1.5" style={field}><option value="">Doesn't work on a unit</option>{FIELD_LEVELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {rolesDirty && (roles.length > 0 || level) && <button onClick={() => patch({ roles: [...roles, ...(level ? ["crew"] : [])], fieldLevel: level || null }, "Roles saved. They apply on the person's next request.")} className="text-sm px-3 py-1.5 rounded" style={btnGreen}>Save roles</button>}
          </div>
        </div>
      )}

      {u.is_active && u.field_level && (
        <div className="flex items-end gap-2 flex-wrap pt-3" style={section}>
          <Labeled label="Crewing unit"><select value={unitId} onChange={(e) => setUnitId(e.target.value)} className="text-sm rounded px-2 py-1.5" style={field}><option value="">Not on a unit</option>{units.map((x) => <option key={x.unit_id} value={x.unit_id}>{x.unit_designation} ({x.capability_level})</option>)}</select></Labeled>
          <Labeled label="Seat"><select value={seat} onChange={(e) => setSeat(e.target.value)} className="text-sm rounded px-2 py-1.5" style={field}><option value="driver">Driver</option><option value="non_driver">Non-driver</option></select></Labeled>
          {unitDirty && <button onClick={() => act(() => apiRequest(session, "PUT", `/crew/${u.crew_member_id}/unit`, { unitId: unitId || null, seatRole: seat }), unitId ? "Crew updated." : "Removed from unit.")} className="text-sm px-3 py-1.5 rounded" style={btnGreen}>Save</button>}
          <span className="text-xs" style={{ color: TEXT_FAINT }}>Easier in bulk: use the OPS screen.</span>
        </div>
      )}

      {u.crew_member_id && u.field_level && (
        <div className="flex flex-col gap-1 pt-3" style={section}>
          <div className="text-xs font-semibold tracking-wide" style={{ color: TEXT_FAINT }}>CERTIFICATIONS</div>
          {certs === null && <div className="text-xs" style={{ color: TEXT_FAINT }}>Loading…</div>}
          {certs && certs.length === 0 && <div className="text-xs" style={{ color: TEXT_FAINT }}>None recorded. A paramedic needs a current paramedic-level certification to be put on an ALS unit.</div>}
          {(certs || []).map((c) => {
            const dd = daysUntil(c.expires_on);
            return (
              <div key={c.certification_id} className="flex items-center justify-between gap-2 text-sm">
                <span>{c.cert_type} <span className="text-xs" style={{ color: dd < 0 ? RED : dd <= 60 ? AMBER : TEXT_SECONDARY }}>{dd < 0 ? `expired ${-dd} days ago` : `expires ${new Date(c.expires_on).toLocaleDateString()} (${dd} days)`}</span></span>
                <button onClick={async () => { if (await act(() => apiRequest(session, "DELETE", `/certifications/${c.certification_id}`), "Certification removed.")) loadCerts(); }} className="text-xs px-1.5 rounded" style={btn}>Remove</button>
              </div>
            );
          })}
          {addingCert ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
              <Labeled label="Type"><select value={cert.certificationTypeId} onChange={(e) => setCert({ ...cert, certificationTypeId: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field}>{certTypes.map((t) => <option key={t.certification_type_id} value={t.certification_type_id}>{t.label}{t.required_for_capability ? ` (${t.required_for_capability})` : ""}</option>)}</select></Labeled>
              <Labeled label="Issued by"><input value={cert.issuingBody} onChange={(e) => setCert({ ...cert, issuingBody: e.target.value })} placeholder="e.g. NYS DOH" className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
              <Labeled label="Issued on"><input type="date" value={cert.issuedOn} onChange={(e) => setCert({ ...cert, issuedOn: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
              <Labeled label="Expires on"><input type="date" value={cert.expiresOn} onChange={(e) => setCert({ ...cert, expiresOn: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
              <Labeled label="Number (optional)"><input value={cert.certificateNumber} onChange={(e) => setCert({ ...cert, certificateNumber: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
              <div className="flex items-end gap-2">
                <button onClick={async () => { if (await act(() => apiRequest(session, "POST", "/certifications", { ...cert, crewMemberId: u.crew_member_id }), "Certification added.")) { setAddingCert(false); loadCerts(); } }} className="text-sm px-3 py-1.5 rounded" style={btnGreen}>Add</button>
                <button onClick={() => setAddingCert(false)} className="text-sm px-3 py-1.5 rounded" style={btn}>Cancel</button>
              </div>
            </div>
          ) : <button onClick={() => setAddingCert(true)} className="self-start text-xs px-2 py-1 rounded mt-1" style={btn}>+ Add certification</button>}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap pt-3" style={section}>
        {resetting ? (
          <>
            <input value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="New password (10+ characters)" className="text-sm rounded px-2 py-1.5 mono" style={{ ...field, minWidth: "220px" }} />
            <button onClick={async () => { if (await patch({ password: newPw }, `Password reset. Tell ${u.display_name.split(" ")[0]} the new one.`)) { setResetting(false); setNewPw(""); } }} className="text-xs px-2 py-1.5 rounded" style={btnGreen}>Set</button>
            <button onClick={() => { setResetting(false); setNewPw(""); }} className="text-xs px-2 py-1.5 rounded" style={btn}>Cancel</button>
          </>
        ) : <button onClick={() => { setResetting(true); setNewPw(randomPassword()); }} className="text-xs px-2 py-1.5 rounded" style={btn}>Reset password</button>}
        <button onClick={() => patch({ resetMfa: true }, `Two-step sign-in reset. ${u.display_name.split(" ")[0]} sets it up again at next sign-in (lost phone).`)} className="text-xs px-2 py-1.5 rounded" style={btn}>Reset 2-step</button>
        {!isMe && <button onClick={() => patch({ isActive: !u.is_active }, u.is_active ? "Deactivated. They're signed out immediately." : "Reactivated.")} className="text-xs px-2 py-1.5 rounded" style={{ ...btn, color: u.is_active ? "#F0857D" : GREEN }}>{u.is_active ? "Deactivate" : "Reactivate"}</button>}
      </div>
    </div>
  );
}

// ---- Units, unit checks, inspections and the checklist ------------------------------------------
function UnitsAndInspections({ session, act }) {
  const [units, setUnits] = useState(null);
  const [checks, setChecks] = useState({});
  const [checklist, setChecklist] = useState([]);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ designation: "", capabilityLevel: "BLS" });
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const [u, c, l] = await Promise.all([apiRequest(session, "GET", "/units"), apiRequest(session, "GET", "/unit-checks/status"), apiRequest(session, "GET", "/checklist")]);
      setUnits(u); setChecks(Object.fromEntries(c.map((x) => [x.unit_id, x]))); setChecklist(l); setError("");
    } catch (e) { setError(e.message); }
  }, [session]);
  useEffect(() => { load(); }, [load]);
  const change = async (fn, ok) => { const done = await act(fn, ok); if (done) await load(); return done; };
  async function add(e) { e.preventDefault(); if (await change(() => apiRequest(session, "POST", "/units", form), `${form.designation} added. Put crew on it in OPS to put it in service.`)) { setForm({ designation: "", capabilityLevel: "BLS" }); setAdding(false); } }

  const shown = (units || []).filter((u) => !q || u.unit_designation.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="flex items-center gap-2 flex-wrap">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a unit" className="text-sm rounded px-2.5 py-1.5" style={{ ...field, width: "200px" }} />
        <span className="text-xs" style={{ color: TEXT_FAINT }}>{units ? `${shown.length} of ${units.length}` : ""}</span>
        <button onClick={() => setAdding(!adding)} className="text-sm px-3 py-1.5 rounded ml-auto" style={adding ? btn : btnGreen}>{adding ? "Close" : "+ Add unit"}</button>
      </div>
      {adding && (
        <form onSubmit={add} className="rounded-lg border p-4 flex items-end gap-3 flex-wrap" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
          <Labeled label="Unit name"><input required value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} placeholder="e.g. Medic 4" className="text-sm rounded px-2 py-2" style={field} /></Labeled>
          <Labeled label="Level"><select value={form.capabilityLevel} onChange={(e) => setForm({ ...form, capabilityLevel: e.target.value })} className="text-sm rounded px-2 py-2" style={field}><option value="BLS">BLS</option><option value="ALS">ALS</option><option value="CCT">CCT</option></select></Labeled>
          <button type="submit" className="text-sm font-medium rounded px-3 py-2" style={btnGreen}>Add unit</button>
        </form>
      )}
      {error && <div className="text-sm" style={{ color: RED }}>{error}</div>}
      {units === null && !error && <div className="text-sm" style={{ color: TEXT_FAINT }}>Loading…</div>}
      {units && units.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>No units yet.</div>}
      <div className="rounded-lg border overflow-hidden" style={{ borderColor: HAIRLINE, backgroundColor: PANEL, display: shown.length ? "block" : "none" }}>
        {shown.map((u) => <UnitRow key={u.unit_id} u={u} status={checks[u.unit_id]} open={open === u.unit_id} toggle={() => setOpen(open === u.unit_id ? null : u.unit_id)} act={change} session={session} />)}
      </div>
      <Checklist session={session} items={checklist} act={change} />
    </>
  );
}

function UnitRow({ u, status, open, toggle, act, session }) {
  const failed = status?.last_check_result === "fail";
  const chip = !status?.crew_count ? null : status.check_due ? ["Check due", AMBER] : failed ? ["Check failed", RED] : ["Checked", GREEN];
  const next = (status?.periodic || []).filter((p) => p.nextDue).sort((a, b) => new Date(a.nextDue) - new Date(b.nextDue))[0];
  const nd = next ? daysUntil(next.nextDue) : null;
  return (
    <div className="border-b last:border-b-0" style={{ borderColor: "#1B2330" }}>
      <button onClick={toggle} aria-expanded={open} className="w-full flex items-center gap-3 px-3 py-2.5 text-left" style={{ backgroundColor: open ? "#17202C" : "transparent" }}>
        <span className="min-w-0 flex-1 text-sm font-medium truncate">{u.unit_designation} <span className="text-xs" style={{ color: TEXT_SECONDARY }}>{u.capability_level}</span></span>
        {chip && <Chip color={chip[1]}>{chip[0]}</Chip>}
        {next && <span className="hidden sm:inline text-xs" style={{ color: nd < 0 ? RED : nd <= 30 ? AMBER : TEXT_FAINT }}>{KIND_LABEL[next.kind]} {nd < 0 ? `${-nd} d overdue` : `in ${nd} d`}</span>}
        <span className="text-xs shrink-0" style={{ color: u.current_status === "out_of_service" ? AMBER : TEXT_SECONDARY }}>{STATUS_LABEL[u.current_status] || u.current_status}</span>
        <span className="text-xs w-12 text-right shrink-0" style={{ color: TEXT_FAINT }}>{u.crew.length} crew</span>
        <span className="text-xs shrink-0" style={{ color: TEXT_FAINT }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <UnitDetails u={u} status={status} act={act} session={session} />}
    </div>
  );
}

function UnitDetails({ u, status, act, session }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(u.unit_designation);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const removeUnit = () => act(async () => {
    const r = await apiRequest(session, "DELETE", `/units/${u.unit_id}`);
    return { warning: r.retired ? `${u.unit_designation} had call history, so it was retired: it's off every list and its history is kept.` : `${u.unit_designation} was deleted.` };
  });
  const [f, setF] = useState({ kind: "dmv_inspection", result: "pass", performedOn: "", nextDue: "", notes: "" });
  const last = status?.last_check_at;
  return (
    <div className="px-4 pb-4 pt-1 flex flex-col gap-2" style={{ backgroundColor: "#111823" }}>
      <div className="flex items-end gap-2 flex-wrap">
        <Labeled label="Unit name"><input aria-label="Unit name" value={name} onChange={(e) => setName(e.target.value)} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
        {name.trim() && name.trim() !== u.unit_designation && <button onClick={() => act(() => apiRequest(session, "PATCH", `/units/${u.unit_id}`, { designation: name.trim() }), "Unit renamed.")} className="text-sm px-3 py-1.5 rounded" style={btnGreen}>Rename</button>}
        {name !== u.unit_designation && <button onClick={() => setName(u.unit_designation)} className="text-sm px-3 py-1.5 rounded" style={btn}>Undo</button>}
        <span className="text-xs" style={{ color: TEXT_FAINT }}>Vehicle: {u.vehicle_number ? `#${u.vehicle_number}` : "none assigned"} (set in OPS)</span>
        <span className="ml-auto flex items-center gap-2">
          {confirmDelete ? (
            <>
              <span className="text-xs" style={{ color: AMBER }}>Delete {u.unit_designation}? A unit with call history is retired, not erased.</span>
              <button onClick={removeUnit} className="text-xs px-2 py-1.5 rounded" style={{ ...btn, color: "#F0857D" }}>Yes, delete</button>
              <button onClick={() => setConfirmDelete(false)} className="text-xs px-2 py-1.5 rounded" style={btn}>Keep</button>
            </>
          ) : <button onClick={() => setConfirmDelete(true)} className="text-xs px-2 py-1.5 rounded" style={{ ...btn, color: "#F0857D" }}>Delete unit</button>}
        </span>
      </div>
      <div className="text-xs" style={{ color: TEXT_SECONDARY }}>Crew: {u.crew.length ? u.crew.map((c) => `${c.name} (${c.role === "driver" ? "driver" : "non-driver"})`).join(", ") : "nobody yet. Use OPS to crew it."}</div>
      <div className="text-sm">
        <span style={{ color: TEXT_FAINT }}>Shift check: </span>
        {!last ? <span style={{ color: status?.crew_count ? AMBER : TEXT_FAINT }}>{status?.crew_count ? "due: none recorded for this crew yet" : "none yet (no crew on it)"}</span>
          : status.last_check_result === "pass" ? <span style={{ color: status.check_due ? AMBER : GREEN }}>{status.check_due ? "due again: last one" : "passed"} {ago(last)} by {status.last_check_by}</span>
          : <span style={{ color: RED }}>FAILED {ago(last)} by {status.last_check_by}: {status.failed_items.join("; ")}</span>}
      </div>
      <div className="text-xs" style={{ color: TEXT_FAINT }}>Crews record the check on their Field screen. The system can't see it any other way.</div>
      {(status?.periodic || []).map((p) => {
        const d = p.nextDue ? daysUntil(p.nextDue) : null;
        return <div key={p.kind} className="text-xs" style={{ color: TEXT_SECONDARY }}>{KIND_LABEL[p.kind]}: {p.result === "pass" ? "passed" : "FAILED"} {new Date(p.performedAt).toLocaleDateString()}{p.nextDue ? <span style={{ color: d < 0 ? RED : d <= 30 ? AMBER : TEXT_SECONDARY }}> · next due {new Date(p.nextDue).toLocaleDateString()} ({d < 0 ? `${-d} days overdue` : `${d} days`})</span> : null}</div>;
      })}
      {adding ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
          <Labeled label="Inspection"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field}>{INSPECTION_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Labeled>
          <Labeled label="Result"><select value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field}><option value="pass">Passed</option><option value="fail">Failed</option></select></Labeled>
          <Labeled label="Done on (blank = today)"><input type="date" value={f.performedOn} onChange={(e) => setF({ ...f, performedOn: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
          <Labeled label="Next one due"><input type="date" value={f.nextDue} onChange={(e) => setF({ ...f, nextDue: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
          <div className="sm:col-span-2"><Labeled label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled></div>
          <div className="flex gap-2">
            <button onClick={async () => { if (await act(() => apiRequest(session, "POST", "/unit-checks/inspection", { unitId: u.unit_id, ...f, performedOn: f.performedOn || undefined, nextDue: f.nextDue || undefined }), "Inspection recorded.")) setAdding(false); }} className="text-sm px-3 py-1.5 rounded" style={btnGreen}>Record</button>
            <button onClick={() => setAdding(false)} className="text-sm px-3 py-1.5 rounded" style={btn}>Cancel</button>
          </div>
        </div>
      ) : <button onClick={() => setAdding(true)} className="self-start text-xs px-2 py-1 rounded" style={btn}>+ Record an inspection</button>}
    </div>
  );
}

function Checklist({ session, items, act }) {
  const [open, setOpen] = useState(false);
  const [add, setAdd] = useState({ label: "", category: "", appliesTo: "BLS", minQuantity: "" });
  const [imp, setImp] = useState({ text: "", appliesTo: "BLS", category: "" });
  const [editing, setEditing] = useState(null);
  const starter = items.some((i) => i.source === "starter" && i.is_active);
  const groups = items.reduce((m, i) => { (m[i.category] ||= []).push(i); return m; }, {});
  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
      <div className="flex items-center justify-between gap-2">
        <div><div className="text-sm font-semibold">Unit check list</div><div className="text-xs" style={{ color: TEXT_SECONDARY }}>What crews check at the start of a shift. BLS items apply to every unit, ALS items to ALS and CCT units.</div></div>
        <button onClick={() => setOpen(!open)} className="text-xs px-2 py-1.5 rounded shrink-0" style={btn}>{open ? "Hide" : `Edit (${items.filter((i) => i.is_active).length} items)`}</button>
      </div>
      {starter && (
        <div className="text-xs px-3 py-2 rounded-md" style={{ color: AMBER, backgroundColor: "rgba(245,147,74,0.08)", border: "1px solid #4A3A1E" }}>
          This is a short generic starter list, not your agency's required equipment. Replace it with your current equipment inventory under NYS DOH Part 800 (those requirements were revised in 2026, so use the version in force now and confirm with your medical director). Use "Paste a list" below to bring it in.
        </div>
      )}
      {open && (
        <>
          {Object.entries(groups).map(([cat, list]) => (
            <div key={cat} className="flex flex-col gap-1">
              <div className="text-xs font-semibold tracking-wide" style={{ color: TEXT_FAINT }}>{cat.toUpperCase()}</div>
              {list.map((i) => (
                <div key={i.item_id} className="flex items-center justify-between gap-2 text-sm" style={{ opacity: i.is_active ? 1 : 0.5 }}>
                  {editing === i.item_id ? <EditItem item={i} session={session} act={act} done={() => setEditing(null)} /> : (
                    <>
                      <span className="min-w-0"><span className="text-xs mr-2 px-1 rounded" style={{ color: TEXT_FAINT, border: `1px solid ${HAIRLINE}` }}>{i.applies_to}</span>{i.label}{i.min_quantity != null ? ` (min ${i.min_quantity})` : ""}</span>
                      <span className="flex gap-1 shrink-0"><button onClick={() => setEditing(i.item_id)} className="text-xs px-1.5 rounded" style={btn}>Edit</button><button onClick={() => act(() => apiRequest(session, "PATCH", `/checklist/${i.item_id}`, { isActive: !i.is_active }))} className="text-xs px-1.5 rounded" style={btn}>{i.is_active ? "Remove" : "Restore"}</button></span>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <div className="sm:col-span-2"><Labeled label="Add an item"><input value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} placeholder="e.g. Pediatric BVM" className="text-sm rounded px-2 py-2" style={field} /></Labeled></div>
            <Labeled label="Applies to"><select value={add.appliesTo} onChange={(e) => setAdd({ ...add, appliesTo: e.target.value })} className="text-sm rounded px-2 py-2" style={field}><option value="BLS">All units (BLS)</option><option value="ALS">ALS & CCT</option><option value="CCT">CCT only</option></select></Labeled>
            <Labeled label="Minimum quantity"><input type="number" min="0" value={add.minQuantity} onChange={(e) => setAdd({ ...add, minQuantity: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
            <div className="sm:col-span-2"><Labeled label="Category"><input value={add.category} onChange={(e) => setAdd({ ...add, category: e.target.value })} placeholder="e.g. Airway" className="text-sm rounded px-2 py-2" style={field} /></Labeled></div>
            <div className="flex items-end"><button onClick={async () => { if (await act(() => apiRequest(session, "POST", "/checklist", { ...add, minQuantity: add.minQuantity === "" ? null : Number(add.minQuantity) }), "Item added.")) setAdd({ label: "", category: "", appliesTo: add.appliesTo, minQuantity: "" }); }} className="text-sm px-3 py-2 rounded" style={btnGreen}>Add</button></div>
          </div>
          <div className="flex flex-col gap-2">
            <Labeled label="Paste a list: one item per line, optionally with a quantity (e.g. “Pulse oximeter, 2”)"><textarea rows={5} value={imp.text} onChange={(e) => setImp({ ...imp, text: e.target.value })} className="text-sm rounded px-2 py-2 mono" style={{ ...field, resize: "vertical" }} /></Labeled>
            <div className="flex items-end gap-2 flex-wrap">
              <Labeled label="Applies to"><select value={imp.appliesTo} onChange={(e) => setImp({ ...imp, appliesTo: e.target.value })} className="text-sm rounded px-2 py-2" style={field}><option value="BLS">All units (BLS)</option><option value="ALS">ALS & CCT</option><option value="CCT">CCT only</option></select></Labeled>
              <Labeled label="Category"><input value={imp.category} onChange={(e) => setImp({ ...imp, category: e.target.value })} placeholder="Imported" className="text-sm rounded px-2 py-2" style={field} /></Labeled>
              <button disabled={!imp.text.trim()} onClick={async () => { const out = { added: 0, skipped: 0 }; if (await act(async () => { Object.assign(out, await apiRequest(session, "POST", "/checklist/import", imp)); return { warning: `Added ${out.added} items${out.skipped ? `, skipped ${out.skipped} already on the list` : ""}.` }; })) setImp({ ...imp, text: "" }); }} className="text-sm px-3 py-2 rounded" style={{ ...btnGreen, opacity: imp.text.trim() ? 1 : 0.5 }}>Import list</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function EditItem({ item, session, act, done }) {
  const [f, setF] = useState({ label: item.label, category: item.category, appliesTo: item.applies_to, minQuantity: item.min_quantity ?? "" });
  return (
    <div className="flex items-center gap-2 flex-wrap w-full">
      <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} className="flex-1 min-w-0 text-sm rounded px-2 py-1.5" style={field} />
      <select value={f.appliesTo} onChange={(e) => setF({ ...f, appliesTo: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field}><option value="BLS">BLS</option><option value="ALS">ALS</option><option value="CCT">CCT</option></select>
      <input type="number" min="0" value={f.minQuantity} onChange={(e) => setF({ ...f, minQuantity: e.target.value })} placeholder="min" className="text-sm rounded px-2 py-1.5" style={{ ...field, width: "64px" }} />
      <button onClick={async () => { if (await act(() => apiRequest(session, "PATCH", `/checklist/${item.item_id}`, { ...f, minQuantity: f.minQuantity === "" ? null : Number(f.minQuantity) }))) done(); }} className="text-xs px-2 py-1.5 rounded" style={btnGreen}>Save</button>
      <button onClick={done} className="text-xs px-2 py-1.5 rounded" style={btn}>Cancel</button>
    </div>
  );
}

// ---- Saved places ---------------------------------------------------------------------------------
function Places({ session, act }) {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const timer = useRef();
  const load = useCallback(async () => {
    try { const r = await apiRequestPaged(session, `/facilities?all=1&limit=${PAGE}&offset=${page * PAGE}${q ? `&q=${encodeURIComponent(q)}` : ""}`); setRows(r.rows); setTotal(r.total); } catch (e) { setRows([]); }
  }, [session, page, q]);
  useEffect(() => { clearTimeout(timer.current); timer.current = setTimeout(load, q ? 250 : 0); return () => clearTimeout(timer.current); }, [load, q]);
  const change = async (fn, ok) => { const done = await act(fn, ok); if (done) await load(); return done; };
  return (
    <>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs" style={{ color: TEXT_SECONDARY }}>Hospitals, nursing homes, dialysis centers and other places dispatch uses often. Dispatchers pick them in a call, and the chart starts with that destination.</div>
        <button onClick={() => setAdding(!adding)} className="text-sm px-3 py-1.5 rounded" style={adding ? btn : btnGreen}>{adding ? "Close" : "+ Add a place"}</button>
      </div>
      {adding && <PlaceForm session={session} act={change} onDone={() => setAdding(false)} />}
      <ListBar q={q} setQ={setQ} placeholder="Search name or address" total={total} shown={(rows || []).length} page={page} setPage={setPage} />
      {rows && rows.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>{q ? "No place matches." : "No saved places yet."}</div>}
      <div className="rounded-lg border overflow-hidden" style={{ borderColor: HAIRLINE, backgroundColor: PANEL, display: rows && rows.length ? "block" : "none" }}>
        {(rows || []).map((p) => (
          <div key={p.facility_id} className="border-b last:border-b-0" style={{ borderColor: "#1B2330", opacity: p.is_active ? 1 : 0.55 }}>
            <button onClick={() => setOpen(open === p.facility_id ? null : p.facility_id)} aria-expanded={open === p.facility_id} className="w-full flex items-center gap-3 px-3 py-2.5 text-left" style={{ backgroundColor: open === p.facility_id ? "#17202C" : "transparent" }}>
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium truncate">{p.name}{!p.is_active ? " (removed)" : ""}</span><span className="block text-xs truncate" style={{ color: TEXT_FAINT }}>{p.address}</span></span>
              <Chip>{PLACE_LABEL[p.facility_type] || p.facility_type}</Chip>
              <span className="text-xs" style={{ color: p.lat != null ? GREEN : AMBER }}>{p.lat != null ? "pinned" : "no pin"}</span>
              <span className="text-xs shrink-0" style={{ color: TEXT_FAINT }}>{open === p.facility_id ? "▲" : "▼"}</span>
            </button>
            {open === p.facility_id && <div className="px-4 pb-4 pt-1" style={{ backgroundColor: "#111823" }}><PlaceForm session={session} act={change} place={p} onDone={() => setOpen(null)} /></div>}
          </div>
        ))}
      </div>
    </>
  );
}

function PlaceForm({ session, act, place, onDone }) {
  const [f, setF] = useState({ name: place?.name || "", facilityType: place?.facility_type || "hospital", address: place?.address || "", phone: place?.phone || "", accessNotes: place?.access_notes || "" });
  const set = (p) => setF({ ...f, ...p });
  const save = async () => {
    const ok = await act(() => (place ? apiRequest(session, "PATCH", `/facilities/${place.facility_id}`, f) : apiRequest(session, "POST", "/facilities", f)), place ? "Place saved." : "Place added.");
    if (ok) onDone();
  };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <Labeled label="Name"><input value={f.name} onChange={(e) => set({ name: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
      <Labeled label="Type"><select value={f.facilityType} onChange={(e) => set({ facilityType: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field}>{PLACE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Labeled>
      <div className="sm:col-span-2"><Labeled label="Street address (it's placed on the map from this)"><input value={f.address} onChange={(e) => set({ address: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled></div>
      <Labeled label="Phone"><input value={f.phone} onChange={(e) => set({ phone: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
      <Labeled label="Access notes (gate codes, which door)"><input value={f.accessNotes} onChange={(e) => set({ accessNotes: e.target.value })} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
      <div className="flex gap-2 sm:col-span-2">
        <button onClick={save} className="text-sm px-3 py-1.5 rounded" style={btnGreen}>{place ? "Save" : "Add place"}</button>
        {place && <button onClick={async () => { if (await act(() => apiRequest(session, "PATCH", `/facilities/${place.facility_id}`, { isActive: !place.is_active }), place.is_active ? "Removed from the list." : "Restored.")) onDone(); }} className="text-sm px-3 py-1.5 rounded" style={{ ...btn, color: place.is_active ? "#F0857D" : GREEN }}>{place.is_active ? "Remove" : "Restore"}</button>}
      </div>
    </div>
  );
}
