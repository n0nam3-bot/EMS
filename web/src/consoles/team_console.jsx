import React, { useState, useEffect, useCallback } from "react";
import { apiRequest } from "../api.js";

const HAIRLINE = "#232C3A";
const PANEL = "#131A24";
const VOID = "#0A0E13";
const SUNKEN = "#0D131B";
const TEXT_PRIMARY = "#E7ECF2";
const TEXT_SECONDARY = "#A9B6C6";
const TEXT_FAINT = "#8795AB";
const GREEN = "#34D399";
const RED = "#F0554A";
const AMBER = "#F5934A";
const BLUE = "#4EA1F0";

const ROLES = [
  ["dispatcher", "Dispatcher"], ["crew", "Crew (EMT / paramedic)"], ["supervisor", "Supervisor"],
  ["compliance_officer", "Compliance officer"], ["it_admin", "IT admin"], ["biller", "Biller"], ["read_only_auditor", "Read-only auditor"],
];
const ROLE_LABEL = Object.fromEntries(ROLES);
const STATUS_LABEL = { available: "Available", assigned: "Assigned", en_route: "En route", on_scene: "On scene", transporting: "Transporting", at_destination: "At destination", out_of_service: "Out of service (no crew)" };

const field = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY };
const btn = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY };
const btnGreen = { backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN };

function randomPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
const daysUntil = (d) => Math.ceil((new Date(d) - new Date(new Date().toDateString())) / 86400000);

export default function TeamConsole({ session }) {
  const [tab, setTab] = useState("people");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const [users, units, certs, certTypes, vehicles] = await Promise.all([
        apiRequest(session, "GET", "/users"), apiRequest(session, "GET", "/units"), apiRequest(session, "GET", "/certifications"),
        apiRequest(session, "GET", "/certification-types"), apiRequest(session, "GET", "/vehicles"),
      ]);
      setData({ users, units, certs, certTypes, vehicles });
    } catch (e) {
      setError(e.message);
    }
  }, [session]);
  useEffect(() => { load(); }, [load]);

  // Every change goes through here: do it, reload, and show the server's own
  // words if it refuses (for example "no current ALS certification").
  async function act(fn, success) {
    setError(""); setNotice("");
    try { await fn(); await load(); if (success) setNotice(success); return true; }
    catch (e) { setError(e.message); return false; }
  }

  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen w-full">
      <style>{`* { box-sizing: border-box; } button, input, select { font-family: inherit; } .mono { font-family: ui-monospace, monospace; }`}</style>
      <div className="px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
        <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>{session.agency}</div>
        <div className="text-lg font-semibold">Team</div>
        <div className="flex gap-2 mt-3">
          {[["people", "People"], ["units", "Units & inspections"]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className="text-sm px-3 py-1.5 rounded-md" style={{ backgroundColor: tab === k ? BLUE : SUNKEN, color: tab === k ? "#06090D" : TEXT_PRIMARY, border: `1px solid ${HAIRLINE}`, fontWeight: tab === k ? 600 : 400 }}>{l}</button>
          ))}
        </div>
      </div>
      <div className="p-4 flex flex-col gap-3" style={{ maxWidth: "860px" }}>
        {error && <div className="text-sm px-3 py-2 rounded-md" style={{ color: RED, backgroundColor: "rgba(240,85,74,0.1)", border: "1px solid #593434" }}>{error}</div>}
        {notice && <div className="text-sm px-3 py-2 rounded-md" style={{ color: GREEN, backgroundColor: "rgba(52,211,153,0.08)", border: "1px solid #2E5943" }}>{notice}</div>}
        {!data && !error && <div className="text-sm" style={{ color: TEXT_FAINT }}>Loading…</div>}
        {data && tab === "people" && <People session={session} data={data} act={act} setNotice={setNotice} />}
        {data && tab === "units" && <Units data={data} act={act} session={session} />}
      </div>
    </div>
  );
}

function Labeled({ label, children }) {
  return <label className="flex flex-col gap-1 min-w-0"><span className="text-xs" style={{ color: TEXT_SECONDARY }}>{label}</span>{children}</label>;
}

function People({ session, data, act, setNotice }) {
  const [form, setForm] = useState({ displayName: "", email: "", role: "crew", employeeNumber: "", password: randomPassword() });
  const [created, setCreated] = useState(null);
  const set = (p) => setForm({ ...form, ...p });

  async function add(e) {
    e.preventDefault();
    const shown = { email: form.email.trim(), password: form.password };
    const ok = await act(() => apiRequest(session, "POST", "/users", form));
    if (ok) { setCreated(shown); setForm({ displayName: "", email: "", role: "crew", employeeNumber: "", password: randomPassword() }); }
  }

  return (
    <>
      <form onSubmit={add} className="rounded-lg border p-4 flex flex-col gap-3" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
        <div className="text-sm font-semibold">Add a person</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Labeled label="Full name"><input required value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
          <Labeled label="Email (their sign-in name)"><input required type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
          <Labeled label="Role">
            <select value={form.role} onChange={(e) => set({ role: e.target.value })} className="text-sm rounded px-2 py-2" style={field}>
              {ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Labeled>
          <Labeled label="Employee number (optional)"><input value={form.employeeNumber} onChange={(e) => set({ employeeNumber: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
          <Labeled label="Temporary password (10+ characters)">
            <div className="flex gap-2">
              <input required value={form.password} onChange={(e) => set({ password: e.target.value })} className="flex-1 min-w-0 text-sm rounded px-2 py-2 mono" style={field} />
              <button type="button" onClick={() => set({ password: randomPassword() })} className="text-xs px-2 rounded" style={btn}>New</button>
            </div>
          </Labeled>
        </div>
        <button type="submit" className="text-sm font-medium rounded px-3 py-2.5" style={btnGreen}>Create account</button>
      </form>

      {created && (
        <div className="rounded-lg border p-4 text-sm" style={{ backgroundColor: "rgba(52,211,153,0.06)", borderColor: "#2E5943" }}>
          <div className="font-semibold mb-1" style={{ color: GREEN }}>Account created. Give them these sign-in details:</div>
          <div className="mono">{created.email}</div>
          <div className="mono">{created.password}</div>
          <div className="text-xs mt-2" style={{ color: TEXT_SECONDARY }}>This password isn't shown again. They can change it after signing in (top right).</div>
          <button onClick={() => setCreated(null)} className="mt-2 text-xs px-2 py-1 rounded" style={btn}>Done</button>
        </div>
      )}

      {data.users.map((u) => <PersonCard key={u.user_id} u={u} me={session.user.id} data={data} act={act} session={session} setNotice={setNotice} />)}
    </>
  );
}

function PersonCard({ u, me, data, act, session }) {
  const [unitId, setUnitId] = useState(u.unit_id || "");
  const [seat, setSeat] = useState(u.seat_role || "non_driver");
  const [resetting, setResetting] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [addingCert, setAddingCert] = useState(false);
  const [cert, setCert] = useState({ certificationTypeId: data.certTypes[0]?.certification_type_id || "", issuingBody: "", certificateNumber: "", issuedOn: "", expiresOn: "" });
  const certs = data.certs.filter((c) => c.crew_member_id === u.crew_member_id);
  const isMe = u.user_id === me;
  const dirty = (u.unit_id || "") !== unitId || (u.unit_id && (u.seat_role || "non_driver") !== seat);

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3" style={{ backgroundColor: PANEL, borderColor: HAIRLINE, opacity: u.is_active ? 1 : 0.6 }}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{u.display_name}{isMe ? " (you)" : ""}{!u.is_active && <span className="ml-2 text-xs" style={{ color: AMBER }}>deactivated</span>}</div>
          <div className="text-xs" style={{ color: TEXT_SECONDARY }}>{u.email}{u.employee_number ? ` · #${u.employee_number}` : ""}</div>
        </div>
        <select value={u.role} disabled={isMe} onChange={(e) => act(() => apiRequest(session, "PATCH", `/users/${u.user_id}`, { role: e.target.value }), "Role changed. It applies on their next request.")} className="text-xs rounded px-2 py-1.5" style={field}>
          {ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>

      {u.is_active && u.crew_member_id && (
        <div className="flex items-end gap-2 flex-wrap">
          <Labeled label="Crewing unit">
            <select value={unitId} onChange={(e) => setUnitId(e.target.value)} className="text-sm rounded px-2 py-2" style={field}>
              <option value="">Not on a unit</option>
              {data.units.map((x) => <option key={x.unit_id} value={x.unit_id}>{x.unit_designation} ({x.capability_level})</option>)}
            </select>
          </Labeled>
          <Labeled label="Seat">
            <select value={seat} onChange={(e) => setSeat(e.target.value)} className="text-sm rounded px-2 py-2" style={field}>
              <option value="driver">Driver</option><option value="non_driver">Non-driver</option>
            </select>
          </Labeled>
          {dirty && <button onClick={() => act(() => apiRequest(session, "PUT", `/crew/${u.crew_member_id}/unit`, { unitId: unitId || null, seatRole: seat }), unitId ? "Crew updated." : "Removed from unit.")} className="text-sm px-3 py-2 rounded" style={btnGreen}>Save</button>}
        </div>
      )}

      {u.crew_member_id && (
        <div className="flex flex-col gap-1">
          <div className="text-xs" style={{ color: TEXT_FAINT }}>CERTIFICATIONS</div>
          {certs.length === 0 && <div className="text-xs" style={{ color: TEXT_FAINT }}>None recorded. ALS units need a current paramedic-level certification.</div>}
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
              <Labeled label="Type">
                <select value={cert.certificationTypeId} onChange={(e) => setCert({ ...cert, certificationTypeId: e.target.value })} className="text-sm rounded px-2 py-2" style={field}>
                  {data.certTypes.map((t) => <option key={t.certification_type_id} value={t.certification_type_id}>{t.label}{t.required_for_capability ? ` (${t.required_for_capability})` : ""}</option>)}
                </select>
              </Labeled>
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
        {!isMe && <button onClick={() => act(() => apiRequest(session, "PATCH", `/users/${u.user_id}`, { isActive: !u.is_active }), u.is_active ? "Deactivated. They're signed out immediately." : "Reactivated.")} className="text-xs px-2 py-1.5 rounded" style={{ ...btn, color: u.is_active ? "#F0857D" : GREEN }}>{u.is_active ? "Deactivate" : "Reactivate"}</button>}
      </div>
    </div>
  );
}

function Units({ data, act, session }) {
  const [form, setForm] = useState({ designation: "", capabilityLevel: "BLS" });
  async function add(e) {
    e.preventDefault();
    if (await act(() => apiRequest(session, "POST", "/units", form), `${form.designation} added. Put someone on it under People to make it available.`)) setForm({ designation: "", capabilityLevel: "BLS" });
  }
  return (
    <>
      <form onSubmit={add} className="rounded-lg border p-4 flex items-end gap-3 flex-wrap" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
        <Labeled label="Unit name"><input required value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} placeholder="e.g. Medic 4" className="text-sm rounded px-2 py-2" style={field} /></Labeled>
        <Labeled label="Level">
          <select value={form.capabilityLevel} onChange={(e) => setForm({ ...form, capabilityLevel: e.target.value })} className="text-sm rounded px-2 py-2" style={field}>
            <option value="BLS">BLS</option><option value="ALS">ALS</option><option value="CCT">CCT</option>
          </select>
        </Labeled>
        <button type="submit" className="text-sm font-medium rounded px-3 py-2" style={btnGreen}>Add unit</button>
      </form>
      {data.units.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>No units yet.</div>}
      {data.units.map((u) => <UnitCard key={u.unit_id} u={u} v={data.vehicles.find((x) => x.unit_designation === u.unit_designation)} act={act} session={session} />)}
    </>
  );
}

function UnitCard({ u, v, act, session }) {
  const [last, setLast] = useState("");
  const [next, setNext] = useState(v?.next_inspection_due ? String(v.next_inspection_due).slice(0, 10) : "");
  return (
    <div className="rounded-lg border p-4 flex flex-col gap-2" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-sm font-semibold">{u.unit_designation} <span className="text-xs" style={{ color: TEXT_SECONDARY }}>{u.capability_level}</span></div>
        <div className="text-xs" style={{ color: u.current_status === "out_of_service" ? AMBER : TEXT_SECONDARY }}>{STATUS_LABEL[u.current_status] || u.current_status}</div>
      </div>
      <div className="text-xs" style={{ color: TEXT_SECONDARY }}>Crew: {u.crew.length ? u.crew.map((c) => `${c.name} (${c.role === "driver" ? "driver" : "non-driver"})`).join(", ") : "nobody yet"}</div>
      {v && (
        <div className="flex items-end gap-2 flex-wrap">
          <Labeled label="Last inspected"><input type="date" value={last} onChange={(e) => setLast(e.target.value)} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
          <Labeled label="Next inspection due"><input type="date" value={next} onChange={(e) => setNext(e.target.value)} className="text-sm rounded px-2 py-1.5" style={field} /></Labeled>
          <button onClick={() => act(() => apiRequest(session, "PATCH", `/vehicles/${v.vehicle_id}`, { lastInspectionDate: last || undefined, nextInspectionDue: next || undefined }), "Inspection dates saved.")} className="text-xs px-2 py-2 rounded" style={btnGreen}>Save dates</button>
        </div>
      )}
    </div>
  );
}
