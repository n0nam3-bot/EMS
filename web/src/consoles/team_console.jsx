import React, { useState, useEffect, useCallback } from "react";
import { apiRequest } from "../api.js";

const HAIRLINE = "#232C3A", PANEL = "#131A24", VOID = "#0A0E13", SUNKEN = "#0D131B";
const TEXT_PRIMARY = "#E7ECF2", TEXT_SECONDARY = "#A9B6C6", TEXT_FAINT = "#8795AB";
const GREEN = "#34D399", RED = "#F0554A", AMBER = "#F5934A", BLUE = "#4EA1F0";

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

const field = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY };
const btn = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY };
const btnGreen = { backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN };

function randomPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => chars[b % chars.length]).join("");
}
const daysUntil = (d) => Math.ceil((new Date(d) - new Date(new Date().toDateString())) / 86400000);
const ago = (d) => { const h = (Date.now() - new Date(d)) / 3600000; return h < 1 ? "just now" : h < 24 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`; };

export default function TeamConsole({ session }) {
  const [tab, setTab] = useState("field");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const [users, units, certs, certTypes, vehicles, checklist, checks] = await Promise.all([
        apiRequest(session, "GET", "/users"), apiRequest(session, "GET", "/units"), apiRequest(session, "GET", "/certifications"),
        apiRequest(session, "GET", "/certification-types"), apiRequest(session, "GET", "/vehicles"),
        apiRequest(session, "GET", "/checklist"), apiRequest(session, "GET", "/unit-checks/status"),
      ]);
      setData({ users, units, certs, certTypes, vehicles, checklist, checks });
    } catch (e) {
      setError(e.message);
    }
  }, [session]);
  useEffect(() => { load(); }, [load]);

  // Every change goes through here: do it, reload, and show the server's own
  // words if it refuses (for example "no current ALS certification").
  async function act(fn, success) {
    setError(""); setNotice("");
    try { const r = await fn(); await load(); setNotice(r?.warning || success || ""); return true; }
    catch (e) { setError(e.message); return false; }
  }

  const tabs = [["field", "Field personnel"], ["office", "Office personnel"], ["units", "Units & inspections"]];
  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen w-full">
      <style>{`* { box-sizing: border-box; } button, input, select, textarea { font-family: inherit; } .mono { font-family: ui-monospace, monospace; }`}</style>
      <div className="px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
        <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>{session.agency}</div>
        <div className="text-lg font-semibold">Team</div>
        <div className="flex gap-2 mt-3 flex-wrap">
          {tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className="text-sm px-3 py-1.5 rounded-md" style={{ backgroundColor: tab === k ? BLUE : SUNKEN, color: tab === k ? "#06090D" : TEXT_PRIMARY, border: `1px solid ${HAIRLINE}`, fontWeight: tab === k ? 600 : 400 }}>{l}</button>)}
        </div>
      </div>
      <div className="p-4 flex flex-col gap-3" style={{ maxWidth: "860px" }}>
        {error && <div className="text-sm px-3 py-2 rounded-md" style={{ color: RED, backgroundColor: "rgba(240,85,74,0.1)", border: "1px solid #593434" }}>{error}</div>}
        {notice && <div className="text-sm px-3 py-2 rounded-md" style={{ color: GREEN, backgroundColor: "rgba(52,211,153,0.08)", border: "1px solid #2E5943" }}>{notice}</div>}
        {!data && !error && <div className="text-sm" style={{ color: TEXT_FAINT }}>Loading…</div>}
        {data && (tab === "field" || tab === "office") && <People key={tab} kind={tab} session={session} data={data} act={act} />}
        {data && tab === "units" && <UnitsAndInspections session={session} data={data} act={act} />}
      </div>
    </div>
  );
}

const Labeled = ({ label, children }) => <label className="flex flex-col gap-1 min-w-0"><span className="text-xs" style={{ color: TEXT_SECONDARY }}>{label}</span>{children}</label>;

function RoleBoxes({ value, onChange }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {OFFICE_ROLES.map(([k, l]) => (
        <label key={k} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={value.includes(k)} onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((r) => r !== k))} />{l}</label>
      ))}
    </div>
  );
}

function People({ kind, session, data, act }) {
  const isField = kind === "field";
  const blank = () => ({ displayName: "", email: "", employeeNumber: "", fieldLevel: isField ? "emt" : "", officeRoles: isField ? [] : ["dispatcher"], alsoField: false, password: randomPassword() });
  const [form, setForm] = useState(blank);
  const [created, setCreated] = useState(null);
  const set = (p) => setForm({ ...form, ...p });

  async function add(e) {
    e.preventDefault();
    const level = isField ? form.fieldLevel : form.alsoField ? form.fieldLevel || "emt" : null;
    const roles = [...form.officeRoles, ...(level ? ["crew"] : [])];
    const body = { email: form.email, displayName: form.displayName, employeeNumber: form.employeeNumber, password: form.password, roles, fieldLevel: level };
    const shown = { email: form.email.trim(), password: form.password };
    if (await act(() => apiRequest(session, "POST", "/users", body))) { setCreated(shown); setForm(blank()); }
  }
  const list = data.users.filter((u) => (isField ? u.field_level : u.roles.some((r) => r !== "crew")));

  return (
    <>
      <form onSubmit={add} className="rounded-lg border p-4 flex flex-col gap-3" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
        <div className="text-sm font-semibold">{isField ? "Add field personnel" : "Add office personnel"}</div>
        <div className="text-xs" style={{ color: TEXT_SECONDARY }}>{isField ? "People who work on an ambulance: MVOs, EMTs, AEMTs and paramedics." : "Dispatchers, supervisors, QA/QI, compliance and other office staff. Someone who also rides can be marked below."}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Labeled label="Full name"><input required value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
          <Labeled label="Email (their sign-in name)"><input required type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
          <Labeled label="Employee number (optional)"><input value={form.employeeNumber} onChange={(e) => set({ employeeNumber: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
          <Labeled label="Temporary password (10+ characters)">
            <div className="flex gap-2"><input required value={form.password} onChange={(e) => set({ password: e.target.value })} className="flex-1 min-w-0 text-sm rounded px-2 py-2 mono" style={field} />
              <button type="button" onClick={() => set({ password: randomPassword() })} className="text-xs px-2 rounded" style={btn}>New</button></div>
          </Labeled>
          {isField && (
            <Labeled label="Field level">
              <select value={form.fieldLevel} onChange={(e) => set({ fieldLevel: e.target.value })} className="text-sm rounded px-2 py-2" style={field}>{FIELD_LEVELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            </Labeled>
          )}
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

      {created && (
        <div className="rounded-lg border p-4 text-sm" style={{ backgroundColor: "rgba(52,211,153,0.06)", borderColor: "#2E5943" }}>
          <div className="font-semibold mb-1" style={{ color: GREEN }}>Account created. Give them these sign-in details:</div>
          <div className="mono">{created.email}</div><div className="mono">{created.password}</div>
          <div className="text-xs mt-2" style={{ color: TEXT_SECONDARY }}>Not shown again. On first sign-in they set up their authenticator app, and can change this password (top right).</div>
          <button onClick={() => setCreated(null)} className="mt-2 text-xs px-2 py-1 rounded" style={btn}>Done</button>
        </div>
      )}
      {list.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>{isField ? "No field personnel yet." : "No office personnel yet."}</div>}
      {list.map((u) => <PersonCard key={u.user_id} u={u} me={session.user.id} data={data} act={act} session={session} />)}
    </>
  );
}

function PersonCard({ u, me, data, act, session }) {
  const officeNow = u.roles.filter((r) => r !== "crew");
  const [roles, setRoles] = useState(officeNow);
  const [level, setLevel] = useState(u.field_level || "");
  const [unitId, setUnitId] = useState(u.unit_id || "");
  const [seat, setSeat] = useState(u.seat_role || "non_driver");
  const [resetting, setResetting] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [addingCert, setAddingCert] = useState(false);
  const [cert, setCert] = useState({ certificationTypeId: data.certTypes[0]?.certification_type_id || "", issuingBody: "", certificateNumber: "", issuedOn: "", expiresOn: "" });
  const certs = data.certs.filter((c) => c.crew_member_id === u.crew_member_id);
  const isMe = u.user_id === me;
  const unitDirty = (u.unit_id || "") !== unitId || (u.unit_id && (u.seat_role || "non_driver") !== seat);
  const rolesDirty = [...roles].sort().join() !== [...officeNow].sort().join() || level !== (u.field_level || "");
  const canSaveRoles = roles.length > 0 || level;

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3" style={{ backgroundColor: PANEL, borderColor: HAIRLINE, opacity: u.is_active ? 1 : 0.6 }}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{u.display_name}{isMe ? " (you)" : ""}{!u.is_active && <span className="ml-2 text-xs" style={{ color: AMBER }}>deactivated</span>}</div>
          <div className="text-xs" style={{ color: TEXT_SECONDARY }}>{u.email}{u.employee_number ? ` · #${u.employee_number}` : ""} · 2-step {u.mfa_enabled ? "on" : "not set up yet"}</div>
          <div className="flex gap-1.5 flex-wrap mt-1">
            {u.field_level && <span className="text-xs px-1.5 py-0.5 rounded" style={{ color: BLUE, border: `1px solid ${HAIRLINE}` }}>{LEVEL_LABEL[u.field_level]}</span>}
            {officeNow.map((r) => <span key={r} className="text-xs px-1.5 py-0.5 rounded" style={{ color: TEXT_SECONDARY, border: `1px solid ${HAIRLINE}` }}>{OFFICE_ROLE_LABEL[r] || r}</span>)}
          </div>
        </div>
      </div>

      {!isMe && (
        <div className="flex flex-col gap-2">
          <div className="text-xs" style={{ color: TEXT_FAINT }}>ROLES</div>
          <RoleBoxes value={roles} onChange={setRoles} />
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs" style={{ color: TEXT_SECONDARY }}>Works on a unit as</span>
            <select value={level} onChange={(e) => setLevel(e.target.value)} className="text-sm rounded px-2 py-1.5" style={field}><option value="">Doesn't work on a unit</option>{FIELD_LEVELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {rolesDirty && canSaveRoles && <button onClick={() => act(() => apiRequest(session, "PATCH", `/users/${u.user_id}`, { roles: [...roles, ...(level ? ["crew"] : [])], fieldLevel: level || null }), "Roles saved. They apply on the person's next request.")} className="text-sm px-3 py-1.5 rounded" style={btnGreen}>Save roles</button>}
          </div>
        </div>
      )}

      {u.is_active && u.field_level && (
        <div className="flex items-end gap-2 flex-wrap">
          <Labeled label="Crewing unit">
            <select value={unitId} onChange={(e) => setUnitId(e.target.value)} className="text-sm rounded px-2 py-2" style={field}>
              <option value="">Not on a unit</option>
              {data.units.map((x) => <option key={x.unit_id} value={x.unit_id}>{x.unit_designation} ({x.capability_level})</option>)}
            </select>
          </Labeled>
          <Labeled label="Seat">
            <select value={seat} onChange={(e) => setSeat(e.target.value)} className="text-sm rounded px-2 py-2" style={field}><option value="driver">Driver</option><option value="non_driver">Non-driver</option></select>
          </Labeled>
          {unitDirty && <button onClick={() => act(() => apiRequest(session, "PUT", `/crew/${u.crew_member_id}/unit`, { unitId: unitId || null, seatRole: seat }), unitId ? "Crew updated." : "Removed from unit.")} className="text-sm px-3 py-2 rounded" style={btnGreen}>Save</button>}
        </div>
      )}

      {u.crew_member_id && u.field_level && (
        <div className="flex flex-col gap-1">
          <div className="text-xs" style={{ color: TEXT_FAINT }}>CERTIFICATIONS</div>
          {certs.length === 0 && <div className="text-xs" style={{ color: TEXT_FAINT }}>None recorded. A paramedic needs a current paramedic-level certification to be put on an ALS unit.</div>}
          {certs.map((c) => {
            const d = daysUntil(c.expires_on);
            return (
              <div key={c.certification_id} className="flex items-center justify-between gap-2 text-sm">
                <span>{c.cert_type} <span className="text-xs" style={{ color: d < 0 ? RED : d <= 60 ? AMBER : TEXT_SECONDARY }}>{d < 0 ? `expired ${-d} days ago` : `expires ${new Date(c.expires_on).toLocaleDateString()} (${d} days)`}</span></span>
                <button onClick={() => act(() => apiRequest(session, "DELETE", `/certifications/${c.certification_id}`), "Certification removed.")} className="text-xs px-1.5 rounded" style={btn}>Remove</button>
              </div>
            );
          })}
          {addingCert ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
              <Labeled label="Type"><select value={cert.certificationTypeId} onChange={(e) => setCert({ ...cert, certificationTypeId: e.target.value })} className="text-sm rounded px-2 py-2" style={field}>{data.certTypes.map((t) => <option key={t.certification_type_id} value={t.certification_type_id}>{t.label}{t.required_for_capability ? ` (${t.required_for_capability})` : ""}</option>)}</select></Labeled>
              <Labeled label="Issued by"><input value={cert.issuingBody} onChange={(e) => setCert({ ...cert, issuingBody: e.target.value })} placeholder="e.g. NYS DOH" className="text-sm rounded px-2 py-2" style={field} /></Labeled>
              <Labeled label="Issued on"><input type="date" value={cert.issuedOn} onChange={(e) => setCert({ ...cert, issuedOn: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
              <Labeled label="Expires on"><input type="date" value={cert.expiresOn} onChange={(e) => setCert({ ...cert, expiresOn: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
              <Labeled label="Number (optional)"><input value={cert.certificateNumber} onChange={(e) => setCert({ ...cert, certificateNumber: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
              <div className="flex items-end gap-2">
                <button onClick={async () => { if (await act(() => apiRequest(session, "POST", "/certifications", { ...cert, crewMemberId: u.crew_member_id }), "Certification added.")) setAddingCert(false); }} className="text-sm px-3 py-2 rounded" style={btnGreen}>Add</button>
                <button onClick={() => setAddingCert(false)} className="text-sm px-3 py-2 rounded" style={btn}>Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAddingCert(true)} className="self-start text-xs px-2 py-1 rounded mt-1" style={btn}>+ Add certification</button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {resetting ? (
          <>
            <input value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="New password (10+ characters)" className="text-sm rounded px-2 py-1.5 mono" style={{ ...field, minWidth: "220px" }} />
            <button onClick={async () => { if (await act(() => apiRequest(session, "PATCH", `/users/${u.user_id}`, { password: newPw }), `Password reset. Tell ${u.display_name.split(" ")[0]} the new one.`)) { setResetting(false); setNewPw(""); } }} className="text-xs px-2 py-1.5 rounded" style={btnGreen}>Set</button>
            <button onClick={() => { setResetting(false); setNewPw(""); }} className="text-xs px-2 py-1.5 rounded" style={btn}>Cancel</button>
          </>
        ) : (
          <button onClick={() => { setResetting(true); setNewPw(randomPassword()); }} className="text-xs px-2 py-1.5 rounded" style={btn}>Reset password</button>
        )}
        <button onClick={() => act(() => apiRequest(session, "PATCH", `/users/${u.user_id}`, { resetMfa: true }), `Two-step sign-in reset. ${u.display_name.split(" ")[0]} sets it up again at next sign-in (lost phone).`)} className="text-xs px-2 py-1.5 rounded" style={btn}>Reset 2-step</button>
        {!isMe && <button onClick={() => act(() => apiRequest(session, "PATCH", `/users/${u.user_id}`, { isActive: !u.is_active }), u.is_active ? "Deactivated. They're signed out immediately." : "Reactivated.")} className="text-xs px-2 py-1.5 rounded" style={{ ...btn, color: u.is_active ? "#F0857D" : GREEN }}>{u.is_active ? "Deactivate" : "Reactivate"}</button>}
      </div>
    </div>
  );
}

// ---- Units, unit checks, inspections and the checklist -----------------------------------
function UnitsAndInspections({ session, data, act }) {
  const [form, setForm] = useState({ designation: "", capabilityLevel: "BLS" });
  async function add(e) {
    e.preventDefault();
    if (await act(() => apiRequest(session, "POST", "/units", form), `${form.designation} added. Put crew on it under Field personnel to put it in service.`)) setForm({ designation: "", capabilityLevel: "BLS" });
  }
  return (
    <>
      <form onSubmit={add} className="rounded-lg border p-4 flex items-end gap-3 flex-wrap" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
        <Labeled label="Unit name"><input required value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} placeholder="e.g. Medic 4" className="text-sm rounded px-2 py-2" style={field} /></Labeled>
        <Labeled label="Level"><select value={form.capabilityLevel} onChange={(e) => setForm({ ...form, capabilityLevel: e.target.value })} className="text-sm rounded px-2 py-2" style={field}><option value="BLS">BLS</option><option value="ALS">ALS</option><option value="CCT">CCT</option></select></Labeled>
        <button type="submit" className="text-sm font-medium rounded px-3 py-2" style={btnGreen}>Add unit</button>
      </form>
      {data.units.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>No units yet.</div>}
      {data.units.map((u) => <UnitCard key={u.unit_id} u={u} status={data.checks.find((c) => c.unit_id === u.unit_id)} act={act} session={session} />)}
      <Checklist session={session} items={data.checklist} act={act} />
    </>
  );
}

function UnitCard({ u, status, act, session }) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ kind: "dmv_inspection", result: "pass", performedOn: "", nextDue: "", notes: "" });
  const last = status?.last_check_at;
  return (
    <div className="rounded-lg border p-4 flex flex-col gap-2" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold">{u.unit_designation} <span className="text-xs" style={{ color: TEXT_SECONDARY }}>{u.capability_level}</span></div>
        <div className="text-xs" style={{ color: u.current_status === "out_of_service" ? AMBER : TEXT_SECONDARY }}>{STATUS_LABEL[u.current_status] || u.current_status}</div>
      </div>
      <div className="text-xs" style={{ color: TEXT_SECONDARY }}>Crew: {u.crew.length ? u.crew.map((c) => `${c.name} (${c.role === "driver" ? "driver" : "non-driver"})`).join(", ") : "nobody yet"}</div>
      <div className="text-sm">
        <span style={{ color: TEXT_FAINT }}>Shift check: </span>
        {!last ? <span style={{ color: AMBER }}>none recorded yet</span> : status.last_check_result === "pass" ? <span style={{ color: GREEN }}>passed {ago(last)} by {status.last_check_by}</span> : <span style={{ color: RED }}>FAILED {ago(last)} by {status.last_check_by}: {status.failed_items.join("; ")}</span>}
      </div>
      {(status?.periodic || []).map((p) => {
        const d = p.nextDue ? daysUntil(p.nextDue) : null;
        return <div key={p.kind} className="text-xs" style={{ color: TEXT_SECONDARY }}>{KIND_LABEL[p.kind]}: {p.result === "pass" ? "passed" : "FAILED"} {new Date(p.performedAt).toLocaleDateString()}{p.nextDue ? <span style={{ color: d < 0 ? RED : d <= 30 ? AMBER : TEXT_SECONDARY }}> · next due {new Date(p.nextDue).toLocaleDateString()} ({d < 0 ? `${-d} days overdue` : `${d} days`})</span> : null}</div>;
      })}
      {adding ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
          <Labeled label="Inspection"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} className="text-sm rounded px-2 py-2" style={field}>{INSPECTION_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Labeled>
          <Labeled label="Result"><select value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })} className="text-sm rounded px-2 py-2" style={field}><option value="pass">Passed</option><option value="fail">Failed</option></select></Labeled>
          <Labeled label="Done on (blank = today)"><input type="date" value={f.performedOn} onChange={(e) => setF({ ...f, performedOn: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
          <Labeled label="Next one due"><input type="date" value={f.nextDue} onChange={(e) => setF({ ...f, nextDue: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
          <div className="sm:col-span-2"><Labeled label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled></div>
          <div className="flex gap-2">
            <button onClick={async () => { if (await act(() => apiRequest(session, "POST", "/unit-checks/inspection", { unitId: u.unit_id, ...f, performedOn: f.performedOn || undefined, nextDue: f.nextDue || undefined }), "Inspection recorded.")) setAdding(false); }} className="text-sm px-3 py-2 rounded" style={btnGreen}>Record</button>
            <button onClick={() => setAdding(false)} className="text-sm px-3 py-2 rounded" style={btn}>Cancel</button>
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
  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
      <div className="flex items-center justify-between gap-2">
        <div><div className="text-sm font-semibold">Unit check list</div><div className="text-xs" style={{ color: TEXT_SECONDARY }}>What crews check at the start of a shift. BLS items apply to every unit, ALS items to ALS and CCT units.</div></div>
        <button onClick={() => setOpen(!open)} className="text-xs px-2 py-1.5 rounded" style={btn}>{open ? "Hide" : `Edit (${items.filter((i) => i.is_active).length} items)`}</button>
      </div>
      {starter && (
        <div className="text-xs px-3 py-2 rounded-md" style={{ color: AMBER, backgroundColor: "rgba(245,147,74,0.08)", border: "1px solid #4A3A1E" }}>
          This is a short generic starter list, not your agency's required equipment. Replace it with your current equipment inventory under NYS DOH Part 800 (those requirements were revised in 2026, so use the version in force now and confirm with your medical director). Use "Paste a list" below to bring it in.
        </div>
      )}
      {open && (
        <>
          <div className="flex flex-col gap-1">
            {items.map((i) => (
              <div key={i.item_id} className="flex items-center justify-between gap-2 text-sm" style={{ opacity: i.is_active ? 1 : 0.5 }}>
                {editing === i.item_id ? <EditItem item={i} session={session} act={act} done={() => setEditing(null)} /> : (
                  <>
                    <span className="min-w-0"><span className="text-xs mr-2 px-1 rounded" style={{ color: TEXT_FAINT, border: `1px solid ${HAIRLINE}` }}>{i.applies_to}</span>{i.label}{i.min_quantity != null ? ` (min ${i.min_quantity})` : ""} <span className="text-xs" style={{ color: TEXT_FAINT }}>{i.category}</span></span>
                    <span className="flex gap-1 shrink-0">
                      <button onClick={() => setEditing(i.item_id)} className="text-xs px-1.5 rounded" style={btn}>Edit</button>
                      <button onClick={() => act(() => apiRequest(session, "PATCH", `/checklist/${i.item_id}`, { isActive: !i.is_active }))} className="text-xs px-1.5 rounded" style={btn}>{i.is_active ? "Remove" : "Restore"}</button>
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <div className="sm:col-span-2"><Labeled label="Add an item"><input value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} placeholder="e.g. Pediatric BVM" className="text-sm rounded px-2 py-2" style={field} /></Labeled></div>
            <Labeled label="Applies to"><select value={add.appliesTo} onChange={(e) => setAdd({ ...add, appliesTo: e.target.value })} className="text-sm rounded px-2 py-2" style={field}><option value="BLS">All units (BLS)</option><option value="ALS">ALS & CCT</option><option value="CCT">CCT only</option></select></Labeled>
            <Labeled label="Minimum quantity"><input type="number" min="0" value={add.minQuantity} onChange={(e) => setAdd({ ...add, minQuantity: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
            <div className="sm:col-span-2"><Labeled label="Category"><input value={add.category} onChange={(e) => setAdd({ ...add, category: e.target.value })} placeholder="e.g. Airway" className="text-sm rounded px-2 py-2" style={field} /></Labeled></div>
            <div className="flex items-end"><button onClick={async () => { if (await act(() => apiRequest(session, "POST", "/checklist", { ...add, minQuantity: add.minQuantity === "" ? null : Number(add.minQuantity) }), "Item added.")) setAdd({ label: "", category: "", appliesTo: add.appliesTo, minQuantity: "" }); }} className="text-sm px-3 py-2 rounded" style={btnGreen}>Add</button></div>
          </div>
          <div className="flex flex-col gap-2">
            <Labeled label="Paste a list: one item per line, optionally with a quantity (e.g. “Pulse oximeter, 2”)">
              <textarea rows={5} value={imp.text} onChange={(e) => setImp({ ...imp, text: e.target.value })} className="text-sm rounded px-2 py-2 mono" style={{ ...field, resize: "vertical" }} />
            </Labeled>
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
