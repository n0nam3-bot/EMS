import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { apiRequest } from "../api.js";

const HAIRLINE = "#232C3A", PANEL = "#131A24", VOID = "#0A0E13", SUNKEN = "#0D131B";
const TEXT_PRIMARY = "#E7ECF2", TEXT_SECONDARY = "#A9B6C6", TEXT_FAINT = "#8795AB";
const GREEN = "#34D399", RED = "#F0554A", AMBER = "#F5934A", BLUE = "#4EA1F0";
const MAX_CREW = 3;
const LEVEL = { mvo: "MVO", emt: "EMT", aemt: "AEMT", paramedic: "Paramedic" };
const LEVEL_COLOR = { mvo: TEXT_SECONDARY, emt: BLUE, aemt: "#7DD3FC", paramedic: GREEN };
const STATUS = { available: ["Available", GREEN], assigned: ["Assigned", AMBER], en_route: ["En route", AMBER], on_scene: ["On scene", AMBER], transporting: ["Transporting", AMBER], at_destination: ["At destination", AMBER], out_of_service: ["Out of service", TEXT_FAINT] };
const BUSY = ["assigned", "en_route", "on_scene", "transporting", "at_destination"];

// Where a person should sit when dropped on a unit. An MVO always drives; EMTs and medics usually don't,
// except an EMT/AEMT paired with a paramedic on an ALS/CCT unit that has no driver yet, who drives.
export function defaultSeat(level, unit) {
  if (level === "mvo") return "driver";
  const hasDriver = unit.crew.some((c) => c.role === "driver");
  const hasMedic = unit.crew.some((c) => c.fieldLevel === "paramedic");
  if (!hasDriver && hasMedic && level !== "paramedic" && unit.capability_level !== "BLS") return "driver";
  return "non_driver";
}
// What a unit still needs before it can take calls: the same rule the server applies.
export function unitNeeds(unit) {
  if (unit.crew.length === 0) return ["a crew"];
  const need = [];
  if (!unit.crew.some((c) => c.role === "driver")) need.push("a driver");
  if (!unit.crew.some((c) => ["emt", "aemt", "paramedic"].includes(c.fieldLevel))) need.push("an EMT or above");
  if (unit.capability_level !== "BLS" && !unit.crew.some((c) => c.fieldLevel === "paramedic")) need.push("a paramedic");
  return need;
}

export default function OpsConsole({ session }) {
  const [units, setUnits] = useState(null);
  const [pool, setPool] = useState([]);
  const [checks, setChecks] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [q, setQ] = useState("");
  const [levelFilter, setLevelFilter] = useState("all");
  const [unitQ, setUnitQ] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [picked, setPicked] = useState(null);       // a person chosen by tap, waiting for a unit
  const [poolMode, setPoolMode] = useState(null);     // "duty" | "all" (null = on duty if the schedule has anyone on duty)
  const [plan, setPlan] = useState(null);             // the preview of "crew units as scheduled"
  const [dragOver, setDragOver] = useState(null);
  const qRef = useRef(q); qRef.current = q;

  const load = useCallback(async () => {
    try {
      const [u, r, c] = await Promise.all([
        apiRequest(session, "GET", "/units"),
        apiRequest(session, "GET", `/ops/roster?unassigned=1${qRef.current ? `&q=${encodeURIComponent(qRef.current)}` : ""}`),
        apiRequest(session, "GET", "/unit-checks/status"),
      ]);
      setUnits(u); setPool(r); setChecks(Object.fromEntries(c.map((x) => [x.unit_id, x])));
      setError("");
    } catch (e) { setError(e.message); }
  }, [session]);
  useEffect(() => { load(); }, [load, q]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function run(fn, okText) {
    setError(""); setNotice("");
    try { const r = await fn(); await load(); setNotice(r?.warning || okText || ""); }
    catch (e) { setError(e.message); }
  }
  const place = (person, unit) => {
    setPicked(null);
    const level = person.fieldLevel ?? person.field_level;
    return run(() => apiRequest(session, "PUT", `/crew/${person.crewMemberId ?? person.crew_member_id}/unit`, { unitId: unit.unit_id, seatRole: defaultSeat(level, unit) }));
  };
  const remove = (crewMemberId) => run(() => apiRequest(session, "PUT", `/crew/${crewMemberId}/unit`, { unitId: null }));
  const toggleSeat = (c) => run(() => apiRequest(session, "PATCH", `/crew/${c.crewMemberId}/seat`, { seatRole: c.role === "driver" ? "non_driver" : "driver" }));

  const onDragStart = (e, person, fromUnitId) => {
    e.dataTransfer.setData("application/x-ems-person", JSON.stringify({ crewMemberId: person.crewMemberId ?? person.crew_member_id, level: person.fieldLevel ?? person.field_level, name: person.name, fromUnitId }));
    e.dataTransfer.effectAllowed = "move";
  };
  const readDrop = (e) => { try { return JSON.parse(e.dataTransfer.getData("application/x-ems-person")); } catch (err) { return null; } };
  const dropOnUnit = (e, unit) => {
    e.preventDefault(); setDragOver(null);
    const p = readDrop(e);
    if (!p || p.fromUnitId === unit.unit_id) return;
    place({ crewMemberId: p.crewMemberId, fieldLevel: p.level }, unit);
  };
  const dropOnPool = (e) => { e.preventDefault(); setDragOver(null); const p = readDrop(e); if (p?.fromUnitId) remove(p.crewMemberId); };

  const dutyCount = pool.filter((p) => p.on_duty).length;
  const mode = poolMode ?? (dutyCount > 0 ? "duty" : "all");
  const shownPool = pool.filter((p) => (levelFilter === "all" || p.field_level === levelFilter) && (mode === "all" || p.on_duty));
  const showPlan = () => run(async () => { setPlan(await apiRequest(session, "POST", "/schedule/apply", { dryRun: true })); });
  const applyPlan = async () => {
    setError(""); setNotice("");
    try {
      const r = await apiRequest(session, "POST", "/schedule/apply", {});
      setPlan(null); await load();
      setNotice(`Crewed as scheduled: ${r.placed} placed, ${r.removed} taken off.${r.skipped.length ? ` ${r.skipped.length} couldn't be done: ${r.skipped.map((x) => `${x.name} (${x.reason})`).join("; ")}` : ""}`);
    } catch (e) { setError(e.message); }
  };
  const shownUnits = useMemo(() => (units || []).filter((u) => {
    if (unitQ && !u.unit_designation.toLowerCase().includes(unitQ.toLowerCase())) return false;
    if (onlyAttention) { const c = checks[u.unit_id]; if (!(u.current_status === "out_of_service" || c?.check_due || c?.last_check_result === "fail")) return false; }
    return true;
  }), [units, unitQ, onlyAttention, checks]);

  const chip = (active) => ({ backgroundColor: active ? BLUE : SUNKEN, color: active ? "#06090D" : TEXT_PRIMARY, border: `1px solid ${HAIRLINE}`, fontWeight: active ? 600 : 400 });
  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen w-full">
      <style>{`* { box-sizing: border-box; } button, input, select { font-family: inherit; }`}</style>
      <div className="px-4 py-3 border-b flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: HAIRLINE }}>
        <div>
          <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>{session.agency}</div>
          <div className="text-lg font-semibold">OPS: units and crews</div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="text-xs" style={{ color: TEXT_SECONDARY }}>Drag a person onto a unit, or tap them and then tap the unit. Up to {MAX_CREW} per unit.</div>
          <button onClick={showPlan} className="text-sm px-3 py-1.5 rounded" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>Crew units as scheduled</button>
        </div>
      </div>

      <div className="p-4 flex flex-col gap-3">
        {error && <div className="text-sm px-3 py-2 rounded-md" style={{ color: RED, backgroundColor: "rgba(240,85,74,0.1)", border: "1px solid #593434" }}>{error}</div>}
        {notice && <div className="text-sm px-3 py-2 rounded-md" style={{ color: GREEN, backgroundColor: "rgba(52,211,153,0.08)", border: "1px solid #2E5943" }}>{notice}</div>}
        {plan && (
          <div className="rounded-lg border p-4 flex flex-col gap-2" style={{ backgroundColor: PANEL, borderColor: BLUE }}>
            <div className="text-sm font-semibold">Crew units as scheduled</div>
            {plan.remove.length === 0 && plan.place.length === 0 ? <div className="text-sm" style={{ color: TEXT_SECONDARY }}>Nothing to change: every unit with a shift running now already has its scheduled crew.</div> : (
              <>
                <div className="text-xs" style={{ color: TEXT_SECONDARY }}>Only units that have a shift running right now are touched.</div>
                {plan.remove.map((r) => <div key={`r${r.crewMemberId}`} className="text-sm">Take <b>{r.name}</b> off {r.unit} <span className="text-xs" style={{ color: TEXT_FAINT }}>(not scheduled on it now)</span></div>)}
                {plan.place.map((p) => <div key={`p${p.crewMemberId}`} className="text-sm">Put <b>{p.name}</b> on {p.unit} as {p.seat === "driver" ? "driver" : "non-driver"}</div>)}
              </>
            )}
            <div className="flex gap-2">
              {(plan.remove.length > 0 || plan.place.length > 0) && <button onClick={applyPlan} className="text-sm px-4 py-2 rounded" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>Apply</button>}
              <button onClick={() => setPlan(null)} className="text-sm px-4 py-2 rounded" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY }}>{plan.remove.length || plan.place.length ? "Cancel" : "Close"}</button>
            </div>
          </div>
        )}
        {picked && (
          <div className="text-sm px-3 py-2 rounded-md flex items-center justify-between gap-2" style={{ color: BLUE, backgroundColor: "rgba(78,161,240,0.1)", border: `1px solid ${BLUE}` }}>
            <span>Placing <b>{picked.name}</b> ({LEVEL[picked.field_level]}): tap a unit.</span>
            <button onClick={() => setPicked(null)} className="text-xs px-2 py-1 rounded" style={{ border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY }}>Cancel</button>
          </div>
        )}

        <div className="flex flex-col lg:flex-row gap-4 items-start">
          {/* People who aren't on a unit */}
          <div className="w-full lg:w-72 shrink-0 rounded-lg border lg:sticky lg:top-3" style={{ backgroundColor: PANEL, borderColor: dragOver === "pool" ? BLUE : HAIRLINE }}
            onDragOver={(e) => { e.preventDefault(); setDragOver("pool"); }} onDragLeave={() => setDragOver(null)} onDrop={dropOnPool}>
            <div className="px-3 py-2 border-b" style={{ borderColor: HAIRLINE }}>
              <div className="text-xs font-semibold tracking-wide" style={{ color: TEXT_SECONDARY }}>NOT ON A UNIT ({shownPool.length})</div>
              <div className="flex gap-1 mt-2">
                {[["duty", `On duty (${dutyCount})`], ["all", `Everyone (${pool.length})`]].map(([k, l]) => <button key={k} onClick={() => setPoolMode(k)} className="text-xs px-2 py-1 rounded-full" style={chip(mode === k)}>{l}</button>)}
              </div>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or employee #" className="w-full text-sm rounded px-2 py-1.5 mt-2" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY }} />
              <div className="flex gap-1 flex-wrap mt-2">
                {[["all", "All"], ["mvo", "MVO"], ["emt", "EMT"], ["aemt", "AEMT"], ["paramedic", "Medic"]].map(([k, l]) => <button key={k} onClick={() => setLevelFilter(k)} className="text-xs px-2 py-1 rounded-full" style={chip(levelFilter === k)}>{l}</button>)}
              </div>
            </div>
            <div className="p-2 flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: "60vh" }}>
              {units === null && !error && <div className="text-xs p-2" style={{ color: TEXT_FAINT }}>Loading…</div>}
              {units && shownPool.length === 0 && <div className="text-xs p-2" style={{ color: TEXT_FAINT }}>{pool.length === 0 ? "Everyone is on a unit (or no field staff yet)." : mode === "duty" && dutyCount === 0 ? "Nobody scheduled right now." : "Nobody matches."}</div>}
              {shownPool.map((p) => (
                <div key={p.crew_member_id} draggable onDragStart={(e) => onDragStart(e, p, null)} onClick={() => setPicked(picked?.crew_member_id === p.crew_member_id ? null : p)}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-2 cursor-grab" style={{ backgroundColor: picked?.crew_member_id === p.crew_member_id ? "rgba(78,161,240,0.15)" : SUNKEN, border: `1px solid ${picked?.crew_member_id === p.crew_member_id ? BLUE : HAIRLINE}`, touchAction: "manipulation" }}>
                  <span className="min-w-0"><span className="block text-sm truncate">{p.name}</span>{p.on_duty && <span className="block text-xs truncate" style={{ color: GREEN }}>{p.shift_unit ? `scheduled: ${p.shift_unit}` : "on duty"} until {new Date(p.shift_ends_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>}</span>
                  <span className="text-xs shrink-0" style={{ color: LEVEL_COLOR[p.field_level] }}>{LEVEL[p.field_level]}</span>
                </div>
              ))}
            </div>
          </div>

          {/* The units */}
          <div className="flex-1 min-w-0 flex flex-col gap-3 w-full">
            <div className="flex gap-2 flex-wrap items-center">
              <input value={unitQ} onChange={(e) => setUnitQ(e.target.value)} placeholder="Find a unit" className="text-sm rounded px-2 py-1.5" style={{ backgroundColor: PANEL, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY, width: "180px" }} />
              <button onClick={() => setOnlyAttention(!onlyAttention)} className="text-xs px-3 py-1.5 rounded-full" style={chip(onlyAttention)}>Needs attention</button>
              <span className="text-xs" style={{ color: TEXT_FAINT }}>{units ? `${shownUnits.length} of ${units.length} units` : ""}</span>
            </div>
            {units && units.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>No units yet. A supervisor adds them under Team → Units & inspections.</div>}
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
              {shownUnits.map((u) => <UnitCard key={u.unit_id} unit={u} check={checks[u.unit_id]} picked={picked} dragOver={dragOver === u.unit_id}
                onOver={(e) => { e.preventDefault(); setDragOver(u.unit_id); }} onLeave={() => setDragOver(null)} onDrop={(e) => dropOnUnit(e, u)}
                onTapPlace={() => picked && place(picked, u)} onDragStart={onDragStart} onRemove={remove} onSeat={toggleSeat} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function UnitCard({ unit, check, picked, dragOver, onOver, onLeave, onDrop, onTapPlace, onDragStart, onRemove, onSeat }) {
  const [label, color] = STATUS[unit.current_status] || [unit.current_status, TEXT_SECONDARY];
  const needs = unitNeeds(unit);
  const slots = Array.from({ length: MAX_CREW }, (_, i) => unit.crew[i] || null);
  const full = unit.crew.length >= MAX_CREW;
  let checkChip = null;
  if (check?.last_check_result === "fail" && !check.check_due) checkChip = ["Check failed", RED];
  else if (check?.check_due) checkChip = ["Check due", AMBER];
  else if (check?.last_check_at) checkChip = ["Checked", GREEN];
  return (
    <div onDragOver={onOver} onDragLeave={onLeave} onDrop={onDrop} onClick={onTapPlace}
      className="rounded-lg border p-3 flex flex-col gap-2" style={{ backgroundColor: PANEL, borderColor: dragOver ? BLUE : picked && !full ? "#2F4A66" : HAIRLINE, cursor: picked ? "pointer" : "default", boxShadow: dragOver ? `0 0 0 2px ${BLUE}` : undefined }}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">{unit.unit_designation} <span className="text-xs" style={{ color: TEXT_SECONDARY }}>{unit.capability_level}</span></div>
        <div className="flex gap-1.5 items-center">
          {checkChip && <span className="text-xs px-1.5 py-0.5 rounded" style={{ color: checkChip[1], border: `1px solid ${HAIRLINE}` }}>{checkChip[0]}</span>}
          <span className="text-xs px-1.5 py-0.5 rounded" style={{ color, border: `1px solid ${HAIRLINE}` }}>{label}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {slots.map((c, i) => c ? (
          <div key={c.crewMemberId} draggable onDragStart={(e) => onDragStart(e, c, unit.unit_id)} onClick={(e) => e.stopPropagation()}
            className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 cursor-grab" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}` }}>
            <span className="min-w-0 flex items-center gap-2">
              <button onClick={() => c.fieldLevel !== "mvo" && onSeat(c)} title={c.fieldLevel === "mvo" ? "An MVO always drives" : c.role === "driver" ? "Driver: tap to make non-driver" : "Tap to make driver"}
                className="text-xs w-6 h-6 rounded-full shrink-0" style={{ backgroundColor: c.role === "driver" ? BLUE : "transparent", color: c.role === "driver" ? "#06090D" : TEXT_FAINT, border: `1px solid ${c.role === "driver" ? BLUE : HAIRLINE}`, fontWeight: 600 }}>{c.role === "driver" ? "D" : "·"}</button>
              <span className="text-sm truncate">{c.name}</span>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              <span className="text-xs" style={{ color: LEVEL_COLOR[c.fieldLevel] }}>{LEVEL[c.fieldLevel]}</span>
              <button onClick={() => onRemove(c.crewMemberId)} aria-label={`Take ${c.name} off ${unit.unit_designation}`} className="text-xs px-1.5 rounded" style={{ color: TEXT_FAINT, border: `1px solid ${HAIRLINE}` }}>✕</button>
            </span>
          </div>
        ) : (
          <div key={`empty${i}`} className="rounded-md px-2 py-1.5 text-xs" style={{ border: `1px dashed ${HAIRLINE}`, color: TEXT_FAINT }}>{i === 0 && unit.crew.length === 0 ? "Drop a person here" : "Open seat"}</div>
        ))}
      </div>
      {needs.length > 0 && unit.crew.length > 0 && <div className="text-xs" style={{ color: AMBER }}>Needs {needs.join(" and ")} to take calls.</div>}
      {unit.crew.length === 0 && <div className="text-xs" style={{ color: TEXT_FAINT }}>No crew: out of service.</div>}
      {BUSY.includes(unit.current_status) && <div className="text-xs" style={{ color: TEXT_FAINT }}>On a call. Crew changes apply immediately.</div>}
    </div>
  );
}
