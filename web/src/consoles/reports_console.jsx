import React, { useState, useEffect, useCallback } from "react";
import { apiRequest } from "../api.js";

const HAIRLINE = "#232C3A", PANEL = "#131A24", VOID = "#0A0E13", SUNKEN = "#0D131B";
const TEXT_PRIMARY = "#E7ECF2", TEXT_SECONDARY = "#A9B6C6", TEXT_FAINT = "#8795AB";
const GREEN = "#34D399", RED = "#F0554A", AMBER = "#F5934A", BLUE = "#4EA1F0";
const PRIORITY = { critical: ["Critical", RED], emergent: ["Emergent", AMBER], urgent: ["Urgent", "#F5C542"], routine: ["Routine", TEXT_SECONDARY] };
const RANGES = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"]];

export const mmss = (s) => { if (s === null || s === undefined) return "–"; const t = Math.round(s); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

// Response times, from what dispatchers and crews recorded in the app. A call whose status taps are
// missing still counts as a call; it just has no timed intervals.
export default function ReportsConsole({ session }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setData(null);
    try { setData(await apiRequest(session, "GET", `/reports/response?days=${days}`)); setError(""); } catch (e) { setError(e.message); }
  }, [session, days]);
  useEffect(() => { load(); }, [load]);
  const max = Math.max(1, ...(data?.daily || []).map((d) => d.calls));
  const th = { color: TEXT_FAINT, fontWeight: 400 };
  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen w-full">
      <style>{`* { box-sizing: border-box; } button { font-family: inherit; }`}</style>
      <div className="px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
        <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>{session.agency}</div>
        <div className="text-lg font-semibold">Reports: response times</div>
        <div className="flex gap-2 mt-3">
          {RANGES.map(([d, l]) => <button key={d} onClick={() => setDays(d)} className="text-sm px-3 py-1.5 rounded-md" style={{ backgroundColor: days === d ? BLUE : SUNKEN, color: days === d ? "#06090D" : TEXT_PRIMARY, border: `1px solid ${HAIRLINE}`, fontWeight: days === d ? 600 : 400 }}>{l}</button>)}
        </div>
      </div>
      <div className="p-4 flex flex-col gap-3" style={{ maxWidth: "980px" }}>
        {error && <div className="text-sm" style={{ color: RED }}>{error}</div>}
        {!data && !error && <div className="text-sm" style={{ color: TEXT_FAINT }}>Loading…</div>}
        {data && (
          <>
            <div className="flex gap-2 flex-wrap">
              {[["Calls", data.totalCalls, TEXT_PRIMARY], ["Cancelled", data.cancelled, TEXT_SECONDARY], ["With a timed response", data.byPriority.reduce((n, r) => n + r.timed, 0), GREEN]].map(([l, v, c]) => (
                <div key={l} className="rounded-lg border px-4 py-2" style={{ backgroundColor: PANEL, borderColor: HAIRLINE, minWidth: "140px" }}><div className="text-xs" style={{ color: TEXT_FAINT }}>{l}</div><div className="text-2xl font-semibold" style={{ color: c }}>{v}</div></div>
              ))}
            </div>
            <div className="rounded-lg border overflow-x-auto" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
              <table className="w-full text-sm" style={{ minWidth: "720px" }}>
                <thead>
                  <tr style={th}><th className="text-left px-3 py-2" style={th}>Priority</th><th className="text-right px-2" style={th}>Calls</th><th className="text-right px-2" style={th}>Timed</th>
                    {["Dispatch", "Turnout", "Travel", "Response"].map((h) => <th key={h} className="text-right px-3" style={th}>{h}<div className="text-xs">median / 90th</div></th>)}</tr>
                </thead>
                <tbody>
                  {data.byPriority.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center" style={{ color: TEXT_FAINT }}>No calls in this period.</td></tr>}
                  {data.byPriority.map((r) => (
                    <tr key={r.priority} style={{ borderTop: `1px solid #1B2330` }}>
                      <td className="px-3 py-2 font-medium" style={{ color: PRIORITY[r.priority]?.[1] }}>{PRIORITY[r.priority]?.[0] || r.priority}</td>
                      <td className="text-right px-2">{r.calls}</td><td className="text-right px-2">{r.timed}</td>
                      {["dispatch", "turnout", "travel", "response"].map((k) => <td key={k} className="text-right px-3 mono" style={{ fontFamily: "ui-monospace, monospace" }}>{mmss(r[`${k}Median`])} / {mmss(r[`${k}P90`])}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-xs" style={{ color: TEXT_FAINT }}>
              <b>Dispatch</b>: call received to first unit assigned. <b>Turnout</b>: assigned to en route. <b>Travel</b>: en route to on scene. <b>Response</b>: call received to on scene. Times are minutes:seconds. They exist only where a unit was assigned and the crew tapped en route and on scene, so a call with missed taps counts as a call but isn't timed. This is for running the operation, not a regulatory filing.
            </div>
            <div className="rounded-lg border p-4" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
              <div className="text-xs font-semibold tracking-wide mb-2" style={{ color: TEXT_SECONDARY }}>CALLS PER DAY</div>
              {data.daily.length === 0 ? <div className="text-sm" style={{ color: TEXT_FAINT }}>None.</div> : (
                <div className="flex items-end gap-1" style={{ height: "110px", overflowX: "auto" }}>
                  {data.daily.map((d) => (
                    <div key={d.day} className="flex flex-col items-center justify-end shrink-0" style={{ width: days > 90 ? "6px" : "22px", height: "100%" }} title={`${d.day}: ${d.calls}`}>
                      <div style={{ width: "100%", height: `${(d.calls / max) * 85}%`, backgroundColor: BLUE, borderRadius: "2px 2px 0 0", minHeight: "2px" }} />
                      {days <= 30 && <div className="text-xs mt-1" style={{ color: TEXT_FAINT, fontSize: "9px" }}>{d.day.slice(8)}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
