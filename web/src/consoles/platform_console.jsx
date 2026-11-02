import React, { useState, useEffect, useCallback } from "react";
import { apiRequest } from "../api.js";

const HAIRLINE = "#232C3A", PANEL = "#131A24", VOID = "#0A0E13", SUNKEN = "#0D131B";
const TEXT_PRIMARY = "#E7ECF2", TEXT_SECONDARY = "#A9B6C6", TEXT_FAINT = "#8795AB";
const GREEN = "#34D399", RED = "#F0554A", AMBER = "#F5934A", BLUE = "#4EA1F0";
const field = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY };
const btn = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY };
const btnGreen = { backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN };

function randomPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => chars[b % chars.length]).join("");
}
const Labeled = ({ label, children }) => <label className="flex flex-col gap-1 min-w-0"><span className="text-xs" style={{ color: TEXT_SECONDARY }}>{label}</span>{children}</label>;

// The platform administrator's screen. It manages companies and accounts and nothing
// else: there is deliberately no way from here to read a call or a patient chart.
export default function PlatformConsole({ session }) {
  const [tenants, setTenants] = useState(null);
  const [open, setOpen] = useState(null);       // tenant being looked at
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ name: "", state: "NY", protocolAuthority: "", ownerName: "", ownerEmail: "", ownerPassword: randomPassword() });
  const [shown, setShown] = useState(null);
  const [q, setQ] = useState("");
  const [uq, setUq] = useState("");

  const loadTenants = useCallback(async () => { try { setTenants(await apiRequest(session, "GET", "/platform/tenants")); } catch (e) { setError(e.message); } }, [session]);
  const loadUsers = useCallback(async (id) => { try { setUsers(await apiRequest(session, "GET", `/platform/tenants/${id}/users`)); } catch (e) { setError(e.message); } }, [session]);
  useEffect(() => { loadTenants(); }, [loadTenants]);
  useEffect(() => { if (open) loadUsers(open.tenant_id); }, [open, loadUsers]);

  async function act(fn, success) {
    setError(""); setNotice("");
    try { await fn(); if (success) setNotice(success); await loadTenants(); if (open) await loadUsers(open.tenant_id); return true; }
    catch (e) { setError(e.message); return false; }
  }
  async function create(e) {
    e.preventDefault();
    const given = { email: form.ownerEmail.trim(), password: form.ownerPassword, company: form.name };
    if (await act(() => apiRequest(session, "POST", "/platform/tenants", form))) {
      setShown(given);
      setForm({ name: "", state: "NY", protocolAuthority: "", ownerName: "", ownerEmail: "", ownerPassword: randomPassword() });
    }
  }

  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen w-full">
      <style>{`* { box-sizing: border-box; } button, input, select { font-family: inherit; } .mono { font-family: ui-monospace, monospace; }`}</style>
      <div className="px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
        <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>Platform administration</div>
        <div className="text-lg font-semibold">Companies and accounts</div>
        <div className="text-xs mt-1" style={{ color: TEXT_SECONDARY }}>You can create companies and help with sign-in problems. You can't see any company's calls or patient records, and every action here is written to that company's audit log.</div>
      </div>
      <div className="p-4 flex flex-col gap-3" style={{ maxWidth: "860px" }}>
        {error && <div className="text-sm px-3 py-2 rounded-md" style={{ color: RED, backgroundColor: "rgba(240,85,74,0.1)", border: "1px solid #593434" }}>{error}</div>}
        {notice && <div className="text-sm px-3 py-2 rounded-md" style={{ color: GREEN, backgroundColor: "rgba(52,211,153,0.08)", border: "1px solid #2E5943" }}>{notice}</div>}

        {shown && (
          <div className="rounded-lg border p-4 text-sm" style={{ backgroundColor: "rgba(52,211,153,0.06)", borderColor: "#2E5943" }}>
            <div className="font-semibold mb-1" style={{ color: GREEN }}>{shown.company} created. Give the owner these sign-in details:</div>
            <div className="mono">{shown.email}</div><div className="mono">{shown.password}</div>
            <div className="text-xs mt-2" style={{ color: TEXT_SECONDARY }}>Not shown again. They'll be asked to set up their authenticator app on first sign-in.</div>
            <button onClick={() => setShown(null)} className="mt-2 text-xs px-2 py-1 rounded" style={btn}>Done</button>
          </div>
        )}

        <form onSubmit={create} className="rounded-lg border p-4 flex flex-col gap-3" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
          <div className="text-sm font-semibold">Create a company</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Labeled label="Company name"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
            <Labeled label="State"><input required maxLength={2} value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
            <Labeled label="Medical protocol authority (optional)"><input value={form.protocolAuthority} onChange={(e) => setForm({ ...form, protocolAuthority: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
            <Labeled label="Owner's full name"><input required value={form.ownerName} onChange={(e) => setForm({ ...form, ownerName: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
            <Labeled label="Owner's email (their sign-in)"><input required type="email" value={form.ownerEmail} onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
            <Labeled label="Temporary password">
              <div className="flex gap-2"><input required value={form.ownerPassword} onChange={(e) => setForm({ ...form, ownerPassword: e.target.value })} className="flex-1 min-w-0 text-sm rounded px-2 py-2 mono" style={field} />
                <button type="button" onClick={() => setForm({ ...form, ownerPassword: randomPassword() })} className="text-xs px-2 rounded" style={btn}>New</button></div>
            </Labeled>
          </div>
          <button type="submit" className="text-sm font-medium rounded px-3 py-2.5" style={btnGreen}>Create company</button>
        </form>

        {tenants === null && !error && <div className="text-sm" style={{ color: TEXT_FAINT }}>Loading…</div>}
        {tenants && tenants.length > 3 && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search companies" className="text-sm rounded px-2.5 py-1.5" style={{ ...field, width: "260px", maxWidth: "100%" }} />}
        {(tenants || []).filter((t) => !q || t.display_name.toLowerCase().includes(q.toLowerCase())).map((t) => (
          <div key={t.tenant_id} className="rounded-lg border p-4 flex flex-col gap-2" style={{ backgroundColor: PANEL, borderColor: open?.tenant_id === t.tenant_id ? BLUE : HAIRLINE, opacity: t.is_active ? 1 : 0.7 }}>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <div className="text-sm font-semibold">{t.display_name} {!t.is_active && <span className="text-xs" style={{ color: AMBER }}>suspended</span>}</div>
                <div className="text-xs" style={{ color: TEXT_SECONDARY }}>{t.regulatory_state} · {t.user_count} accounts · {t.unit_count} units</div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setOpen(open?.tenant_id === t.tenant_id ? null : t)} className="text-xs px-2 py-1.5 rounded" style={btn}>{open?.tenant_id === t.tenant_id ? "Hide accounts" : "Accounts"}</button>
                <button onClick={() => act(() => apiRequest(session, "PATCH", `/platform/tenants/${t.tenant_id}`, { isActive: !t.is_active }), t.is_active ? `${t.display_name} suspended. Everyone there is signed out.` : `${t.display_name} reactivated.`)} className="text-xs px-2 py-1.5 rounded" style={{ ...btn, color: t.is_active ? "#F0857D" : GREEN }}>{t.is_active ? "Suspend" : "Reactivate"}</button>
              </div>
            </div>
            {open?.tenant_id === t.tenant_id && (
              <>
                {users.length > 6 && <input value={uq} onChange={(e) => setUq(e.target.value)} placeholder="Search accounts" className="text-sm rounded px-2.5 py-1.5" style={{ ...field, width: "240px", maxWidth: "100%" }} />}
                <div className="rounded-md overflow-hidden" style={{ border: `1px solid ${HAIRLINE}` }}>
                  {users.filter((u) => !uq || `${u.display_name} ${u.email}`.toLowerCase().includes(uq.toLowerCase())).map((u) => <UserRow key={u.user_id} u={u} act={act} session={session} />)}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function UserRow({ u, act, session }) {
  const [openRow, setOpenRow] = useState(false);
  const [pw, setPw] = useState(null);
  const [given, setGiven] = useState(null);
  const patch = (body, ok) => act(() => apiRequest(session, "PATCH", `/platform/users/${u.user_id}`, body), ok);
  return (
    <div style={{ backgroundColor: SUNKEN, borderBottom: `1px solid ${HAIRLINE}`, opacity: u.is_active ? 1 : 0.6 }}>
      <button onClick={() => setOpenRow(!openRow)} aria-expanded={openRow} className="w-full flex items-center gap-3 px-3 py-2 text-left">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: !u.is_active ? TEXT_FAINT : u.mfa_enabled ? GREEN : AMBER }} />
        <span className="min-w-0 flex-1"><span className="block text-sm truncate">{u.display_name}{u.locked && <span className="ml-2 text-xs" style={{ color: RED }}>locked</span>}</span><span className="block text-xs truncate" style={{ color: TEXT_FAINT }}>{u.email} · {[u.role, ...(u.extra_roles || [])].join(", ")}</span></span>
        <span className="text-xs shrink-0" style={{ color: TEXT_FAINT }}>{openRow ? "▲" : "▼"}</span>
      </button>
      {openRow && (
        <div className="px-3 pb-3 flex flex-col gap-2">
          <div className="text-xs" style={{ color: TEXT_SECONDARY }}>Two-step sign-in: {u.mfa_enabled ? "on" : "not set up"}{!u.is_active ? " · deactivated" : ""}</div>
          {given && <div className="text-xs mono" style={{ color: GREEN }}>New password for {u.email}: {given}  (not shown again)</div>}
          <div className="flex gap-2 flex-wrap">
            {pw === null ? (
              <button onClick={() => setPw(randomPassword())} className="text-xs px-2 py-1.5 rounded" style={btn}>Reset password</button>
            ) : (
              <>
                <input value={pw} onChange={(e) => setPw(e.target.value)} className="text-xs rounded px-2 py-1.5 mono" style={{ ...field, minWidth: "190px" }} />
                <button onClick={async () => { if (await patch({ password: pw })) { setGiven(pw); setPw(null); } }} className="text-xs px-2 py-1.5 rounded" style={btnGreen}>Set</button>
                <button onClick={() => setPw(null)} className="text-xs px-2 py-1.5 rounded" style={btn}>Cancel</button>
              </>
            )}
            <button onClick={() => patch({ resetMfa: true }, "Two-step sign-in reset. They'll set it up again next time they sign in.")} className="text-xs px-2 py-1.5 rounded" style={btn}>Reset 2-step</button>
            <button onClick={() => patch({ isActive: !u.is_active }, u.is_active ? "Deactivated." : "Reactivated.")} className="text-xs px-2 py-1.5 rounded" style={{ ...btn, color: u.is_active ? "#F0857D" : GREEN }}>{u.is_active ? "Deactivate" : "Reactivate"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
