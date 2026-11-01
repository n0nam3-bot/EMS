import React, { useState, useEffect, useCallback } from "react";
import { apiRequest } from "../api.js";

const HAIRLINE = "#232C3A", PANEL = "#131A24", VOID = "#0A0E13", SUNKEN = "#0D131B";
const TEXT_PRIMARY = "#E7ECF2", TEXT_SECONDARY = "#A9B6C6", TEXT_FAINT = "#8795AB";
const GREEN = "#34D399", RED = "#F0554A", AMBER = "#F5934A", BLUE = "#4EA1F0";
const field = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY };
const btn = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY };
const btnGreen = { backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN };

const CHECK_TEXT = {
  has_vitals: "No vital signs recorded", has_disposition: "No disposition recorded", has_crew_signature: "No crew signature",
  transport_has_destination: "Transported, but no destination facility recorded", refusal_has_signature: "Refusal without a refusal signature",
};
const LEVEL = { mvo: "MVO", emt: "EMT", aemt: "AEMT", paramedic: "Paramedic" };
const fmt = (d) => (d ? new Date(d).toLocaleString() : "");
const EVENT_TEXT = { created: "Chart started", submitted: "Submitted by crew", reopened: "Sent back for correction", resubmitted: "Resubmitted after correction", approved: "Approved by QA/QI" };

// QA/QI: review charts the crew has submitted. Opening one is recorded in the audit log.
export default function QaConsole({ session }) {
  const [tab, setTab] = useState("submitted");
  const [list, setList] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setList(null); setError("");
    try { setList(await apiRequest(session, "GET", `/qa/charts?status=${tab}`)); } catch (e) { setError(e.message); }
  }, [session, tab]);
  useEffect(() => { load(); }, [load]);

  if (openId) return <ChartReview session={session} id={openId} onBack={() => { setOpenId(null); load(); }} />;
  const tabs = [["submitted", "To review"], ["reopened", "Sent back"], ["finalized", "Approved"]];
  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen w-full">
      <style>{`* { box-sizing: border-box; } button, input, select, textarea { font-family: inherit; }`}</style>
      <div className="px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
        <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>{session.agency}</div>
        <div className="text-lg font-semibold">QA/QI review</div>
        <div className="flex gap-2 mt-3">
          {tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className="text-sm px-3 py-1.5 rounded-md" style={{ backgroundColor: tab === k ? BLUE : SUNKEN, color: tab === k ? "#06090D" : TEXT_PRIMARY, border: `1px solid ${HAIRLINE}`, fontWeight: tab === k ? 600 : 400 }}>{l}</button>)}
        </div>
      </div>
      <div className="p-4 flex flex-col gap-2" style={{ maxWidth: "860px" }}>
        {error && <div className="text-sm" style={{ color: RED }}>{error}</div>}
        {list === null && !error && <div className="text-sm" style={{ color: TEXT_FAINT }}>Loading…</div>}
        {list && list.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>{tab === "submitted" ? "Nothing waiting for review." : tab === "reopened" ? "No charts are out for correction." : "No approved charts yet."}</div>}
        {(list || []).map((c) => (
          <button key={c.pcr_id} onClick={() => setOpenId(c.pcr_id)} className="text-left rounded-lg border p-4" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
            <div className="text-sm font-medium">{c.scene_address} <span className="text-xs" style={{ color: TEXT_SECONDARY }}>· {c.unit_designation || "no unit"}</span></div>
            <div className="text-xs mt-0.5" style={{ color: TEXT_SECONDARY }}>Crew: {c.crew || "n/a"}{c.assigned_to ? ` · with ${c.assigned_to} for correction` : ""}</div>
            <div className="text-xs mt-0.5" style={{ color: TEXT_FAINT }}>{c.submitted_at ? `Submitted ${fmt(c.submitted_at)}` : ""} · {Number(c.passed)} of {Number(c.total)} checks passed</div>
            {c.failed.length > 0 && <div className="text-xs mt-1" style={{ color: AMBER }}>{c.failed.map((f) => CHECK_TEXT[f] || f).join(" · ")}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return <div className="rounded-lg border p-4" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}><div className="text-xs tracking-wide font-semibold mb-2" style={{ color: TEXT_SECONDARY }}>{title}</div>{children}</div>;
}

function ChartReview({ session, id, onBack }) {
  const [chart, setChart] = useState(null);
  const [error, setError] = useState("");
  const [reopening, setReopening] = useState(false);
  const [assignTo, setAssignTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setChart(await apiRequest(session, "GET", `/pcr/${id}`)); } catch (e) { setError(e.message); }
  }, [session, id]);
  useEffect(() => { load(); }, [load]);

  async function act(path, body, then) {
    setBusy(true); setError("");
    try { await apiRequest(session, "POST", `/pcr/${id}/${path}`, body); then(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const clinicalCrew = (chart?.crew || []).filter((c) => ["emt", "aemt", "paramedic"].includes(c.field_level));

  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen w-full">
      <style>{`* { box-sizing: border-box; } button, input, select, textarea { font-family: inherit; }`}</style>
      <div className="px-4 py-3 border-b flex items-center gap-3" style={{ borderColor: HAIRLINE }}>
        <button onClick={onBack} className="text-sm px-2 py-1 rounded" style={btn}>← Back</button>
        <div className="text-lg font-semibold">Chart review</div>
      </div>
      <div className="p-4 flex flex-col gap-3" style={{ maxWidth: "860px" }}>
        {error && <div className="text-sm px-3 py-2 rounded-md" style={{ color: RED, backgroundColor: "rgba(240,85,74,0.1)", border: "1px solid #593434" }}>{error}</div>}
        {!chart && !error && <div className="text-sm" style={{ color: TEXT_FAINT }}>Loading…</div>}
        {chart && (
          <>
            <Section title="CALL">
              <div className="text-sm font-medium">{chart.scene_address}{chart.scene_detail ? ` · ${chart.scene_detail}` : ""}</div>
              <div className="text-xs mt-0.5" style={{ color: TEXT_SECONDARY }}>{chart.unit_designation} · crew: {chart.crew.map((c) => `${c.name} (${LEVEL[c.field_level] || c.field_level})`).join(", ")}</div>
              <div className="text-xs mt-0.5" style={{ color: chart.status === "finalized" ? GREEN : AMBER }}>Status: {chart.status}</div>
              {chart.reopen_note && chart.status === "reopened" && <div className="text-xs mt-1" style={{ color: TEXT_SECONDARY }}>Correction requested: {chart.reopen_note}</div>}
            </Section>
            <Section title="NARRATIVE"><div className="text-sm whitespace-pre-wrap">{chart.clinical_narrative || <span style={{ color: TEXT_FAINT }}>None entered.</span>}</div></Section>
            <Section title="VITAL SIGNS">
              {chart.vitals.length === 0 ? <div className="text-sm" style={{ color: TEXT_FAINT }}>None recorded.</div> : (
                <div className="overflow-x-auto"><table className="text-xs w-full"><thead><tr style={{ color: TEXT_FAINT }}><th className="text-left pr-3">Time</th><th className="text-left pr-3">BP</th><th className="text-left pr-3">HR</th><th className="text-left pr-3">RR</th><th className="text-left pr-3">SpO₂</th><th className="text-left pr-3">Glucose</th><th className="text-left pr-3">GCS</th><th className="text-left">Pain</th></tr></thead>
                  <tbody>{chart.vitals.map((v) => <tr key={v.vital_id}><td className="pr-3">{new Date(v.recorded_at).toLocaleTimeString()}</td><td className="pr-3">{v.bp_systolic ?? "–"}/{v.bp_diastolic ?? "–"}</td><td className="pr-3">{v.heart_rate ?? "–"}</td><td className="pr-3">{v.respiratory_rate ?? "–"}</td><td className="pr-3">{v.spo2_percent ?? "–"}</td><td className="pr-3">{v.blood_glucose ?? "–"}</td><td className="pr-3">{v.gcs_total ?? "–"}</td><td>{v.pain_scale ?? "–"}</td></tr>)}</tbody></table></div>
              )}
            </Section>
            <Section title="PROCEDURES">{chart.procedures.length === 0 ? <div className="text-sm" style={{ color: TEXT_FAINT }}>None recorded.</div> : chart.procedures.map((p) => <div key={p.procedure_id} className="text-sm">{p.procedure_name}{p.outcome ? ` · ${p.outcome}` : ""}{p.notes ? ` · ${p.notes}` : ""}</div>)}</Section>
            <Section title="MEDICATIONS">{chart.medications.length === 0 ? <div className="text-sm" style={{ color: TEXT_FAINT }}>None recorded.</div> : chart.medications.map((m) => <div key={m.medication_id} className="text-sm">{m.drug_name} {m.dose} {m.route}{m.patient_response ? ` · ${m.patient_response}` : ""}</div>)}</Section>
            <Section title="DISPOSITION">{chart.disposition ? <div className="text-sm">{chart.disposition.disposition_type} · {chart.disposition.primary_impression || "no impression"}{chart.disposition.transfer_of_care_to ? ` · care transferred to ${chart.disposition.transfer_of_care_to}` : ""}</div> : <div className="text-sm" style={{ color: TEXT_FAINT }}>None recorded.</div>}</Section>
            <Section title="HISTORY">{chart.events.map((e, i) => <div key={i} className="text-xs" style={{ color: TEXT_SECONDARY }}>{fmt(e.at)} · {EVENT_TEXT[e.kind] || e.kind}{e.actor ? ` by ${e.actor}` : ""}{e.assigned_to ? ` → ${e.assigned_to}` : ""}{e.note ? ` — "${e.note}"` : ""}</div>)}</Section>

            {chart.status === "submitted" && !reopening && (
              <div className="flex gap-2 flex-wrap">
                <button disabled={busy} onClick={() => act("approve", {}, onBack)} className="text-sm font-medium rounded px-4" style={{ ...btnGreen, minHeight: "44px" }}>Approve</button>
                <button disabled={busy} onClick={() => setReopening(true)} className="text-sm rounded px-4" style={{ ...btn, minHeight: "44px" }}>Send back for correction</button>
              </div>
            )}
            {chart.status === "submitted" && reopening && (
              <Section title="SEND BACK FOR CORRECTION">
                <div className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1"><span className="text-xs" style={{ color: TEXT_SECONDARY }}>Who corrects it (only this person will be able to open it)</span>
                    <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} className="text-sm rounded px-2 py-2" style={field}>
                      <option value="">Choose a crew member…</option>
                      {clinicalCrew.map((c) => <option key={c.user_id} value={c.user_id}>{c.name} ({LEVEL[c.field_level]})</option>)}
                    </select></label>
                  <label className="flex flex-col gap-1"><span className="text-xs" style={{ color: TEXT_SECONDARY }}>What needs to be corrected</span>
                    <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} className="text-sm rounded px-2 py-2" style={field} /></label>
                  <div className="flex gap-2">
                    <button disabled={busy || !assignTo || note.trim().length < 5} onClick={() => act("reopen", { assignToUserId: assignTo, note }, onBack)} className="text-sm font-medium rounded px-4" style={{ ...btnGreen, minHeight: "44px", opacity: !assignTo || note.trim().length < 5 ? 0.5 : 1 }}>Send back</button>
                    <button onClick={() => setReopening(false)} className="text-sm rounded px-4" style={{ ...btn, minHeight: "44px" }}>Cancel</button>
                  </div>
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
