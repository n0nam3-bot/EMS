import React, { useState, useEffect, useCallback, useMemo } from "react";
import { apiRequest } from "../api.js";
import { groupCrews, numberCrews, buildGrid, ROLE_TAG, span } from "../scheduleLogic.js";

const HAIRLINE = "#232C3A", PANEL = "#131A24", VOID = "#0A0E13", SUNKEN = "#0D131B";
const TEXT_PRIMARY = "#E7ECF2", TEXT_SECONDARY = "#A9B6C6", TEXT_FAINT = "#8795AB";
const GREEN = "#34D399", RED = "#F0554A", AMBER = "#F5934A", BLUE = "#4EA1F0";
const LEVEL = { mvo: "MVO", emt: "EMT", aemt: "AEMT", paramedic: "Paramedic" };
const LEVEL_COLOR = { mvo: TEXT_SECONDARY, emt: BLUE, aemt: "#7DD3FC", paramedic: GREEN };
const field = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY };
const btn = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY };
const btnGreen = { backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN };
const Labeled = ({ label, children }) => <label className="flex flex-col gap-1 min-w-0"><span className="text-xs" style={{ color: TEXT_SECONDARY }}>{label}</span>{children}</label>;

// ---- dates, in the browser's own time zone --------------------------------------------------
export const startOfWeek = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };   // Monday
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const hhmm = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dateInput = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const atTime = (dateStr, timeStr) => { const [y, m, d] = dateStr.split("-").map(Number); const [h, mi] = timeStr.split(":").map(Number); return new Date(y, m - 1, d, h, mi, 0, 0); };
const dayLabel = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const when = (iso) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function ScheduleConsole({ session }) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [shifts, setShifts] = useState(null);
  const [units, setUnits] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState(null);          // add / edit panel: { shift?, ...fields } or null
  const [tab, setTab] = useState("BLS");              // ALS and BLS crews are shown on separate tabs
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const load = useCallback(async () => {
    try {
      const [s, u] = await Promise.all([
        apiRequest(session, "GET", `/schedule?from=${encodeURIComponent(weekStart.toISOString())}&to=${encodeURIComponent(addDays(weekStart, 7).toISOString())}`),
        apiRequest(session, "GET", "/units"),
      ]);
      setShifts(s); setUnits(u); setError("");
    } catch (e) { setError(e.message); }
  }, [session, weekStart]);
  useEffect(() => { load(); }, [load]);

  // Crews, numbered per day by start time (BLS 1, BLS 2...), then laid out by start time from 0000 down.
  const numbered = useMemo(() => numberCrews(groupCrews(shifts || [], Object.fromEntries(units.map((u) => [u.unit_id, u.capability_level])))), [shifts, units]);
  const grids = useMemo(() => ({ BLS: buildGrid(numbered, "BLS", days), ALS: buildGrid(numbered, "ALS", days) }), [numbered, days]);
  const grid = grids[tab];
  // Open on whichever tab has shifts (an ALS-only week shouldn't look empty).
  useEffect(() => {
    if (shifts === null) return;
    const other = tab === "BLS" ? "ALS" : "BLS";
    if (grids[tab].count === 0 && grids[other].count > 0) setTab(other);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shifts, units]);
  const today = new Date();
  const openAdd = (unitId, day, time = "0700") => setForm({ crewMemberId: "", personName: "", unitId: unitId || "", seatRole: "", date: dateInput(day), time: `${time.slice(0, 2)}:${time.slice(2)}`, hours: 12, repeat: 1, notes: "" });
  const openEdit = (s) => setForm({ shift: s, crewMemberId: s.crew_member_id, personName: s.name, unitId: s.unit_id || "", seatRole: s.seat_role || "", date: dateInput(new Date(s.starts_at)), time: hhmm(new Date(s.starts_at)), hours: Math.round((new Date(s.ends_at) - new Date(s.starts_at)) / 3600000), repeat: 1, notes: s.notes || "" });

  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen w-full">
      <style>{`* { box-sizing: border-box; } button, input, select, textarea { font-family: inherit; }`}</style>
      <div className="px-4 py-3 border-b flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: HAIRLINE }}>
        <div>
          <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>{session.agency}</div>
          <div className="text-lg font-semibold">Schedule</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="text-sm px-3 py-1.5 rounded" style={btn} aria-label="Previous week">←</button>
          <button onClick={() => setWeekStart(startOfWeek(new Date()))} className="text-sm px-3 py-1.5 rounded" style={btn}>This week</button>
          <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="text-sm px-3 py-1.5 rounded" style={btn} aria-label="Next week">→</button>
          <span className="text-sm" style={{ color: TEXT_SECONDARY }}>{dayLabel(days[0])} – {dayLabel(days[6])}</span>
          <button onClick={() => openAdd(null, today)} className="text-sm px-3 py-1.5 rounded" style={btnGreen}>+ Add shift</button>
        </div>
      </div>

      <div className="p-4 flex flex-col gap-3">
        {error && <div className="text-sm px-3 py-2 rounded-md" style={{ color: RED, backgroundColor: "rgba(240,85,74,0.1)", border: "1px solid #593434" }}>{error}</div>}
        {notice && <div className="text-sm px-3 py-2 rounded-md" style={{ color: GREEN, backgroundColor: "rgba(52,211,153,0.08)", border: "1px solid #2E5943" }}>{notice}</div>}
        {form && <ShiftForm key={form.shift?.shift_id || "new"} session={session} units={units} initial={form} onClose={() => setForm(null)} onSaved={(msg) => { setForm(null); setNotice(msg); load(); }} />}

        <div role="tablist" aria-label="Crew level" className="flex gap-2">
          {["BLS", "ALS"].map((l) => (
            <button key={l} role="tab" aria-selected={tab === l} onClick={() => setTab(l)} className="text-sm px-4 py-1.5 rounded-md" style={{ backgroundColor: tab === l ? (l === "ALS" ? GREEN : BLUE) : SUNKEN, color: tab === l ? "#06090D" : TEXT_PRIMARY, border: `1px solid ${HAIRLINE}`, fontWeight: tab === l ? 600 : 400 }}>
              {l} <span className="text-xs" style={{ opacity: 0.8 }}>{grids[l].count}</span>
            </button>
          ))}
        </div>

        <div className="rounded-lg border overflow-x-auto" style={{ borderColor: HAIRLINE, backgroundColor: PANEL }}>
          <div style={{ minWidth: "900px" }}>
            <div className="grid" style={{ gridTemplateColumns: "72px repeat(7, minmax(0, 1fr))" }}>
              <div className="px-2 py-2 text-xs" style={{ color: TEXT_FAINT, borderBottom: `1px solid ${HAIRLINE}` }}>Start time</div>
              {days.map((d) => <div key={d.toISOString()} className="px-2 py-2 text-xs text-center" style={{ color: sameDay(d, today) ? BLUE : TEXT_SECONDARY, fontWeight: sameDay(d, today) ? 600 : 400, borderBottom: `1px solid ${HAIRLINE}`, borderLeft: `1px solid ${HAIRLINE}` }}>{dayLabel(d)}</div>)}
              {shifts === null && !error && <div className="px-3 py-4 text-sm col-span-8" style={{ color: TEXT_FAINT }}>Loading…</div>}
              {shifts !== null && grid.rows.length === 0 && <div className="px-3 py-6 text-sm col-span-8" style={{ color: TEXT_FAINT }}>No {tab} shifts this week. Use + Add shift to schedule people.</div>}
              {shifts !== null && grid.rows.map((t) => (
                <React.Fragment key={t}>
                  <div className="px-2 py-2 text-sm font-medium" style={{ borderBottom: `1px solid #1B2330`, fontFamily: "ui-monospace, monospace" }}>{t}</div>
                  {days.map((d) => (
                    <div key={t + d.toISOString()} className="p-1 flex flex-col gap-1 group" style={{ borderBottom: `1px solid #1B2330`, borderLeft: `1px solid #1B2330`, minHeight: "56px", backgroundColor: sameDay(d, today) ? "rgba(78,161,240,0.04)" : undefined }}>
                      {grid.cell(t, d).map((c) => (
                        <div key={c.key} className="rounded px-1.5 py-1" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, borderLeft: `3px solid ${c.level === "ALS" ? GREEN : BLUE}` }}>
                          <div className="text-xs font-semibold" style={{ color: c.level === "ALS" ? GREEN : BLUE }}>{c.label}{c.unitName ? <span className="font-normal" style={{ color: TEXT_FAINT }}> · {c.unitName}</span> : null}</div>
                          {c.members.map((s) => (
                            <button key={s.shift_id} onClick={() => openEdit(s)} className="block w-full text-left text-xs py-0.5" style={{ color: TEXT_PRIMARY }}>
                              <span style={{ color: LEVEL_COLOR[s.field_level] || TEXT_FAINT }}>[{ROLE_TAG[s.field_level] || "Staff"}]</span> {s.name}
                              <div style={{ color: TEXT_FAINT }}>{span(s)}</div>
                            </button>
                          ))}
                        </div>
                      ))}
                      <button onClick={() => openAdd(null, d, t)} aria-label={`Add a ${tab} shift starting ${t} on ${dayLabel(d)}`} className="text-xs rounded opacity-0 group-hover:opacity-100 focus:opacity-100" style={{ color: TEXT_FAINT, border: `1px dashed ${HAIRLINE}` }}>+</button>
                    </div>
                  ))}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
        <div className="text-xs" style={{ color: TEXT_FAINT }}>Crew numbers such as BLS 1 and ALS 1 are counted for each day in the order crews start, so they change as shifts are added or removed. They are schedule labels, not unit names. Times are 24-hour.</div>
        <div className="text-xs" style={{ color: TEXT_FAINT }}>Times are in this device's time zone. Anyone with a shift covering the current time shows as on duty on OPS, where "Crew units as scheduled" puts them on their units.</div>
      </div>
    </div>
  );
}

function ShiftForm({ session, units, initial, onClose, onSaved }) {
  const editing = Boolean(initial.shift);
  const [f, setF] = useState(initial);
  const [q, setQ] = useState("");
  const [people, setPeople] = useState([]);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (p) => setF({ ...f, ...p });

  useEffect(() => {
    if (editing || q.trim().length < 1) { setPeople([]); return; }
    const t = setTimeout(() => apiRequest(session, "GET", `/ops/roster?q=${encodeURIComponent(q.trim())}`).then(setPeople).catch(() => setPeople([])), 200);
    return () => clearTimeout(t);
  }, [q, editing, session]);

  async function save() {
    setBusy(true); setError(""); setConflict(null);
    try {
      const start = atTime(f.date, f.time);
      const end = new Date(start.getTime() + f.hours * 3600000);
      if (editing) {
        await apiRequest(session, "PATCH", `/schedule/${initial.shift.shift_id}`, { startsAt: start.toISOString(), endsAt: end.toISOString(), unitId: f.unitId || null, seatRole: f.seatRole || null, notes: f.notes });
        onSaved("Shift saved.");
      } else {
        // each day is built on the calendar, so a daylight-saving change keeps the same clock time
        const occurrences = Array.from({ length: Math.min(Math.max(Number(f.repeat) || 1, 1), 14) }, (_, i) => {
          const s = addDays(start, i);
          return { startsAt: s.toISOString(), endsAt: new Date(s.getTime() + f.hours * 3600000).toISOString() };
        });
        const r = await apiRequest(session, "POST", "/schedule", { crewMemberId: f.crewMemberId, unitId: f.unitId || null, seatRole: f.seatRole || null, notes: f.notes, occurrences });
        onSaved(r.created > 1 ? `${r.created} shifts added.` : "Shift added.");
      }
    } catch (e) {
      setError(e.message); setConflict(e.conflict || null);
    } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try { await apiRequest(session, "DELETE", `/schedule/${initial.shift.shift_id}`); onSaved("Shift removed."); } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3" style={{ backgroundColor: PANEL, borderColor: BLUE }}>
      <div className="flex items-center justify-between"><div className="text-sm font-semibold">{editing ? `Edit shift: ${f.personName}` : "Add a shift"}</div><button onClick={onClose} className="text-xs px-2 py-1 rounded" style={btn}>Close</button></div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {!editing && (
          <div className="sm:col-span-3">
            <Labeled label="Person (type a name or employee #)">
              <input value={f.crewMemberId ? f.personName : q} onChange={(e) => { setQ(e.target.value); set({ crewMemberId: "", personName: "" }); }} placeholder="Search field staff…" className="text-sm rounded px-2 py-2" style={field} />
            </Labeled>
            {!f.crewMemberId && people.length > 0 && (
              <div className="rounded border mt-1 overflow-hidden" style={{ borderColor: HAIRLINE }}>
                {people.slice(0, 8).map((p) => (
                  <button key={p.crew_member_id} onClick={() => { set({ crewMemberId: p.crew_member_id, personName: p.name, seatRole: p.field_level === "mvo" ? "driver" : f.seatRole }); setPeople([]); }} className="w-full flex justify-between text-left text-sm px-2 py-2 border-b" style={{ borderColor: "#1B2330", backgroundColor: PANEL }}>
                    <span>{p.name}</span><span className="text-xs" style={{ color: LEVEL_COLOR[p.field_level] }}>{LEVEL[p.field_level]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <Labeled label="Unit"><select value={f.unitId} onChange={(e) => set({ unitId: e.target.value })} className="text-sm rounded px-2 py-2" style={field}><option value="">No unit yet</option>{units.map((u) => <option key={u.unit_id} value={u.unit_id}>{u.unit_designation} ({u.capability_level})</option>)}</select></Labeled>
        <Labeled label="Seat"><select value={f.seatRole} onChange={(e) => set({ seatRole: e.target.value })} className="text-sm rounded px-2 py-2" style={field}><option value="">Automatic</option><option value="driver">Driver</option><option value="non_driver">Non-driver</option></select></Labeled>
        <Labeled label="Notes"><input value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="optional" className="text-sm rounded px-2 py-2" style={field} /></Labeled>
        <Labeled label="Starts on"><input type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
        <Labeled label="At"><input type="time" value={f.time} onChange={(e) => set({ time: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>
        <Labeled label="Length"><select value={f.hours} onChange={(e) => set({ hours: Number(e.target.value) })} className="text-sm rounded px-2 py-2" style={field}>{[4, 6, 8, 10, 12, 16, 24].map((h) => <option key={h} value={h}>{h} hours</option>)}</select></Labeled>
        {!editing && <Labeled label="Repeat for (days in a row)"><input type="number" min="1" max="14" value={f.repeat} onChange={(e) => set({ repeat: e.target.value })} className="text-sm rounded px-2 py-2" style={field} /></Labeled>}
      </div>
      {error && <div className="text-sm" style={{ color: RED }}>{error}{conflict ? ` (existing shift: ${when(conflict.startsAt)} to ${when(conflict.endsAt)})` : ""}</div>}
      <div className="flex gap-2 flex-wrap">
        <button disabled={busy || (!editing && !f.crewMemberId)} onClick={save} className="text-sm px-4 py-2 rounded" style={{ ...btnGreen, opacity: busy || (!editing && !f.crewMemberId) ? 0.5 : 1 }}>{busy ? "Saving…" : editing ? "Save shift" : "Add shift"}</button>
        {editing && <button disabled={busy} onClick={remove} className="text-sm px-4 py-2 rounded" style={{ ...btn, color: "#F0857D" }}>Delete shift</button>}
      </div>
    </div>
  );
}
