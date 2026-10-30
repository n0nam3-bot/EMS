import React, { useState, useEffect, useRef } from "react";
import {
  Activity, Stethoscope, Pill, ClipboardCheck, PenTool, Trash2, User, Syringe,
  AlertTriangle, CheckCircle2, Circle, FileText, Sparkles, Loader2, Search, X, Plus,
  Settings, Wifi, WifiOff,
} from "lucide-react";

const HAIRLINE = "#232C3A";
const PANEL = "#131A24";
const VOID = "#0A0E13";
const SUNKEN = "#0D131B";
const TEXT_PRIMARY = "#E7ECF2";
const TEXT_SECONDARY = "#8593A3";
const TEXT_FAINT = "#57647A";
const GREEN = "#34D399";
const AMBER = "#F5A623";
const RED = "#F0554A";
const BLUE = "#4EA1F0";

const VITALS_INTERVAL_MIN = 5;

const PROCEDURE_PRESETS = ["IV Access", "Intubation", "CPR", "Splinting", "Oxygen", "Cardiac Monitor", "Defibrillation"];
const MEDICATION_PRESETS = ["Albuterol", "Aspirin", "Epinephrine", "Naloxone", "Nitroglycerin", "Morphine", "Fentanyl", "Midazolam", "Ondansetron"];
const ROUTES = ["IV", "IM", "IO", "PO", "SL", "Inhaled", "IN"];
const DISPOSITIONS = [
  { value: "transported", label: "Transported" },
  { value: "refused", label: "Refused Care" },
  { value: "treated_no_transport", label: "Treated, No Transport" },
  { value: "dead_on_scene", label: "Dead on Scene" },
  { value: "cancelled", label: "Cancelled" },
];
const CHIEF_COMPLAINTS = ["Chest Pain", "Difficulty Breathing", "Trauma / MVC", "Altered Mental Status", "Allergic Reaction", "Abdominal Pain", "Syncope"];
const PROTOCOL_SUGGESTIONS = {
  "Chest Pain": ["12-lead ECG", "Aspirin 324mg PO if not contraindicated", "IV access", "Vitals q5min"],
  "Difficulty Breathing": ["Pulse oximetry", "Albuterol nebulizer if wheezing", "Cardiac monitor", "Consider CPAP if severe"],
  "Trauma / MVC": ["C-spine precautions if indicated", "Full body survey", "IV access x2 if unstable", "Splint as indicated"],
  "Altered Mental Status": ["Blood glucose check", "Pupil response", "Trend GCS", "Consider naloxone if opioid suspected"],
  "Allergic Reaction": ["Assess airway", "Epinephrine if anaphylaxis criteria met", "IV access", "Antihistamine per protocol"],
};
const MED_DEFAULTS = {
  Albuterol: { doses: ["2.5mg/3mL neb"], route: "Inhaled" },
  Aspirin: { doses: ["324mg"], route: "PO" },
  Epinephrine: { doses: ["0.3mg (1:1000)", "0.1mg (1:10,000)"], route: "IM" },
  Naloxone: { doses: ["0.4mg", "2mg"], route: "IN" },
  Nitroglycerin: { doses: ["0.4mg"], route: "SL" },
  Morphine: { doses: ["2mg", "4mg"], route: "IV" },
  Fentanyl: { doses: ["25mcg", "50mcg", "100mcg"], route: "IV" },
  Midazolam: { doses: ["2mg", "5mg"], route: "IV" },
  Ondansetron: { doses: ["4mg"], route: "IV" },
};

const DRAFT_SYSTEM_PROMPT = "You are a clinical documentation assistant helping an EMS provider draft a patient care report narrative from structured chart data. Write a concise, chronological, objective, professional EMS narrative in standard third-person clinical style (e.g. 'Crew arrived to find patient...'). Use ONLY the information given below — never invent vital signs, findings, times, or events not present in the data. If a section has no data, omit it rather than guessing. Return only the narrative text, no headers or commentary.";
const CLEANUP_SYSTEM_PROMPT = "You are a clinical documentation assistant. Rewrite the following EMS patient care narrative into clear, professional, objective clinical documentation — regardless of the spelling, grammar, or tone it was written in. Fix spelling and grammar and convert casual or conversational phrasing into standard clinical language. Do not add, remove, guess at, or change any clinical fact, detail, time, medication, dose, or finding — only rewrite the language of what is already there. If any part is genuinely unclear, keep it as-is rather than guessing what was meant. Return only the rewritten narrative, no headers or commentary.";

function formatClock(d) { return d.toLocaleTimeString("en-US", { hour12: false }); }
function minutesSince(d, now) { return (now - d) / 60000; }
function inputStyle() { return { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY }; }
function num(v) { return v === "" || v == null ? null : Number(v); }
function checkAllergy(drugName, allergiesStr) {
  if (!allergiesStr) return false;
  const list = allergiesStr.toLowerCase().split(",").map((a) => a.trim()).filter(Boolean);
  return list.some((a) => drugName.toLowerCase().includes(a) || a.includes(drugName.toLowerCase()));
}

async function callClaude(systemPrompt, userMessage) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, system: systemPrompt, messages: [{ role: "user", content: userMessage }] }),
  });
  if (!response.ok) throw new Error("Request failed");
  const data = await response.json();
  const block = (data.content || []).find((c) => c.type === "text");
  if (!block) throw new Error("No response text");
  return block.text;
}

function buildChartSummary({ patient, assessment, vitals, procedures, medications, disposition }) {
  const lines = [];
  if (patient.name) lines.push(`Patient: ${patient.name}, DOB ${patient.dob || "unknown"}, ${patient.sex || "sex unspecified"}, weight ${patient.weight || "unspecified"}`);
  if (patient.allergies) lines.push(`Allergies: ${patient.allergies}`);
  if (patient.pmh) lines.push(`Past medical history: ${patient.pmh}`);
  if (assessment.chiefComplaint) lines.push(`Chief complaint: ${assessment.chiefComplaint}`);
  if (assessment.onset || assessment.quality || assessment.severity) lines.push(`HPI (OPQRST): onset "${assessment.onset}", provocation "${assessment.provocation}", quality "${assessment.quality}", radiation "${assessment.radiation}", severity ${assessment.severity}/10, time "${assessment.time}"`);
  if (assessment.mentalStatus) lines.push(`Mental status: ${assessment.mentalStatus}`);
  if (assessment.primarySurvey) lines.push(`Primary survey: ${assessment.primarySurvey}`);
  if (assessment.secondarySurvey) lines.push(`Secondary survey: ${assessment.secondarySurvey}`);
  const vChron = vitals.slice().reverse();
  if (vChron.length) lines.push(`Vitals: ${vChron.map((v) => `${formatClock(v.recordedAt)} BP ${v.bpSys || "-"}/${v.bpDia || "-"} HR ${v.hr || "-"} RR ${v.rr || "-"} SpO2 ${v.spo2 || "-"}% GCS ${v.gcs || "-"}`).join("; ")}`);
  const pChron = procedures.slice().reverse();
  if (pChron.length) lines.push(`Procedures: ${pChron.map((p) => `${formatClock(p.performedAt)} ${p.name}${p.outcome ? " - " + p.outcome : ""}`).join("; ")}`);
  const mChron = medications.slice().reverse();
  if (mChron.length) lines.push(`Medications: ${mChron.map((m) => `${formatClock(m.administeredAt)} ${m.name} ${m.dose} ${m.route}`).join("; ")}`);
  if (disposition.type) lines.push(`Disposition: ${disposition.type}${disposition.destinationFacility ? ", transported to " + disposition.destinationFacility : ""}${disposition.transferTo ? ", care transferred to " + disposition.transferTo : ""}`);
  if (disposition.primaryImpression) lines.push(`Primary impression: ${disposition.primaryImpression}`);
  if (disposition.mechanismOfInjury) lines.push(`Mechanism of injury: ${disposition.mechanismOfInjury}`);
  return lines.length ? lines.join("\n") : "No chart data entered yet.";
}

function escapeXml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function downloadXml(xmlString, filename) {
  const blob = new Blob([xmlString], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
// Element numbers cited inline (eTimes.03/05, eMedications.01/03/06/10,
// eProcedures.10, eDisposition.32, eProtocols.01) come from the
// published NEMSIS v3.5 data dictionary. Tags WITHOUT a numbered
// citation are structurally placed under the correct module but not
// verified against the current XSD/Schematron — confirm those, and
// resolve eMedications.03 to RxNorm codes, before this touches a real
// state submission. This demonstrates the mapping, not certified output.
function generateNemsisXml({ patient, assessment, vitals, procedures, medications, disposition, narrative }) {
  const esc = escapeXml;
  const vitalsXml = vitals.slice().reverse().map((v) => `
    <eVitals.VitalGroup>
      <eVitals.01>${v.recordedAt.toISOString()}</eVitals.01> <!-- Vital Signs Date/Time -->
      <BloodPressureSystolic>${esc(v.bpSys)}</BloodPressureSystolic>
      <BloodPressureDiastolic>${esc(v.bpDia)}</BloodPressureDiastolic>
      <HeartRate>${esc(v.hr)}</HeartRate>
      <RespiratoryRate>${esc(v.rr)}</RespiratoryRate>
      <PulseOximetry>${esc(v.spo2)}</PulseOximetry>
      <GlasgowComaScore>${esc(v.gcs)}</GlasgowComaScore>
    </eVitals.VitalGroup>`).join("");
  const proceduresXml = procedures.slice().reverse().map((p) => `
    <eProcedures.ProcedureGroup>
      <eProcedures.01>${p.performedAt.toISOString()}</eProcedures.01> <!-- Procedure Date/Time -->
      <ProcedurePerformed>${esc(p.name)}</ProcedurePerformed>
      <eProcedures.10>Crew Member</eProcedures.10> <!-- Role/Type of Person Performing the Procedure -->
      <ProcedureOutcome>${esc(p.outcome)}</ProcedureOutcome>
    </eProcedures.ProcedureGroup>`).join("");
  const medicationsXml = medications.slice().reverse().map((m) => `
    <eMedications.MedicationGroup>
      <eMedications.01>${m.administeredAt.toISOString()}</eMedications.01> <!-- Date/Time Medication Administered -->
      <eMedications.03>${esc(m.name)}</eMedications.03> <!-- Medication Given — NEMSIS requires an RxNorm (RxCUI) code here, not free text -->
      <eMedications.06>${esc(m.dose)}</eMedications.06> <!-- Medication Dosage -->
      <MedicationRoute>${esc(m.route)}</MedicationRoute>
      <eMedications.10>Crew Member</eMedications.10> <!-- Role/Type of Person Administering Medication -->
    </eMedications.MedicationGroup>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!--
  NEMSIS v3.5-style structured export — a mapping demonstration, not a
  certified-compliant submission file. See code comments for which
  element numbers are verified vs. structurally placed only.
-->
<EMSDataSet>
  <ePatient>
    <PatientName>${esc(patient.name)}</PatientName>
    <PatientDOB>${esc(patient.dob)}</PatientDOB>
    <PatientSex>${esc(patient.sex)}</PatientSex>
    <PatientWeight>${esc(patient.weight)}</PatientWeight>
    <PatientAllergies>${esc(patient.allergies)}</PatientAllergies>
    <PatientMedicalHistory>${esc(patient.pmh)}</PatientMedicalHistory>
  </ePatient>
  <eHistory>
    <ChiefComplaint>${esc(assessment.chiefComplaint)}</ChiefComplaint>
    <MentalStatus>${esc(assessment.mentalStatus)}</MentalStatus>
  </eHistory>
  <eTimes>
    <eTimes.03>${esc(disposition.dispatchedAt)}</eTimes.03> <!-- Unit Notified by Dispatch Date/Time -->
    <eTimes.05>${esc(disposition.enRouteAt)}</eTimes.05> <!-- Unit En Route Date/Time -->
    <UnitOnScene>${esc(disposition.onSceneAt)}</UnitOnScene>
    <UnitLeftScene>${esc(disposition.leftSceneAt)}</UnitLeftScene>
  </eTimes>
  <eVitals>${vitalsXml}
  </eVitals>
  <eProcedures>${proceduresXml}
  </eProcedures>
  <eMedications>${medicationsXml}
  </eMedications>
  <eDisposition>
    <eDisposition.32>${esc(disposition.type)}</eDisposition.32> <!-- General level of care provided -->
    <DestinationFacility>${esc(disposition.destinationFacility)}</DestinationFacility>
    <PrimaryImpression>${esc(disposition.primaryImpression)}</PrimaryImpression>
    <MechanismOfInjury>${esc(disposition.mechanismOfInjury)}</MechanismOfInjury>
  </eDisposition>
  <eNarrative>${esc(narrative)}</eNarrative>
</EMSDataSet>`;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}
function fuzzyWordMatch(word, target) {
  if (target.includes(word)) return true;
  const maxDist = word.length > 5 ? 2 : 1;
  if (Math.abs(word.length - target.length) > maxDist) return false;
  return levenshtein(word, target) <= maxDist;
}
function searchProtocols(query, documents) {
  const qWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (qWords.length === 0) return [];
  return documents.map((doc) => {
    const titleLower = doc.title.toLowerCase();
    const contentWords = (doc.title + " " + doc.content).toLowerCase().split(/\s+/);
    let score = 0;
    qWords.forEach((qw) => { if (titleLower.includes(qw)) score += 3; if (contentWords.some((cw) => fuzzyWordMatch(qw, cw))) score += 1; });
    return { doc, score };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).map((r) => r.doc);
}

const SAMPLE_PROTOCOLS = [
  { id: "d1", title: "Chest Pain / Suspected ACS", content: "Obtain 12-lead ECG within 10 minutes of patient contact when possible. Administer aspirin 324mg PO (four 81mg chewable) if no allergy or contraindication. Establish IV access. Reassess vitals and pain scale every 5 minutes during transport. Consider nitroglycerin per local protocol if systolic BP > 100 and no PDE5 inhibitor use in the last 24-48 hours." },
  { id: "d2", title: "Anaphylaxis / Severe Allergic Reaction", content: "Assess airway patency and breath sounds immediately. Administer epinephrine IM (1:1000) into the anterolateral thigh if criteria for anaphylaxis are met — do not delay for IV access. Follow with high-flow oxygen, IV fluids, and antihistamine per local protocol. Reassess every 5 minutes; a second epinephrine dose may be indicated if no improvement in 5-15 minutes." },
  { id: "d3", title: "Opioid Overdose", content: "Assess responsiveness and respiratory effort. Support ventilation with BVM if respirations are inadequate. Administer naloxone, titrating to adequate respiratory effort rather than full arousal — rapid full reversal can precipitate acute withdrawal and combativeness. Monitor closely: naloxone's duration is often shorter than the opioid involved, so re-sedation during transport is a real risk." },
  { id: "d4", title: "Major Hemorrhage Control", content: "Direct pressure is first-line for external bleeding. Apply a tourniquet high and tight for life-threatening extremity hemorrhage not controlled by direct pressure — note application time. Consider hemostatic gauze with wound packing for junctional or non-extremity sites where a tourniquet cannot be applied. Reassess distal pulse and bleeding control frequently." },
  { id: "d5", title: "Respiratory Distress — Asthma/COPD", content: "Assess work of breathing, accessory muscle use, and lung sounds. Administer albuterol nebulizer, with ipratropium added per local protocol for moderate-severe presentations. Position of comfort, typically upright. Consider CPAP for severe distress without contraindication. Continuous pulse oximetry and reassessment of respiratory rate and effort throughout transport." },
];

const SECTIONS = [
  { key: "patient", label: "Patient & History", icon: User, required: true },
  { key: "assessment", label: "Assessment", icon: Stethoscope, required: true },
  { key: "vitals", label: "Vitals", icon: Activity, required: true },
  { key: "procedures", label: "Procedures", icon: Syringe, required: false },
  { key: "medications", label: "Medications", icon: Pill, required: false },
  { key: "narrative", label: "Narrative", icon: FileText, required: true },
  { key: "disposition", label: "Disposition & Times", icon: ClipboardCheck, required: true },
  { key: "signatures", label: "Signatures", icon: PenTool, required: true },
];

// One chart belongs to one call. Signed in, the crew picks the call first
// (EpcrCharting below), then this component is created fresh for that call,
// so two calls' charts can never mix on screen.
function EpcrChart({ session, incidentId, incidentLabel, onBack }) {
  const live = session?.mode === "live";
  const [tab, setTab] = useState("patient");
  const [now, setNow] = useState(() => new Date());
  const [patient, setPatientField] = useState({ name: "", dob: "", sex: "", weight: "", allergies: "", homeMeds: "", pmh: "" });
  const [assessment, setAssessmentField] = useState({ chiefComplaint: "", onset: "", provocation: "", quality: "", radiation: "", severity: "", time: "", primarySurvey: "", secondarySurvey: "", mentalStatus: "" });
  const [vitals, setVitals] = useState([]);
  const [procedures, setProcedures] = useState([]);
  const [medications, setMedications] = useState([]);
  const [narrative, setNarrative] = useState("");
  const [disposition, setDispositionField] = useState({ type: "", destinationFacility: "", transferTo: "", primaryImpression: "", mechanismOfInjury: "", dispatchedAt: live ? "" : "14:02", enRouteAt: live ? "" : "14:04", onSceneAt: live ? "" : "14:11", leftSceneAt: live ? "" : "14:24" });
  const [signatures, setSignatures] = useState([]);
  const [showSearch, setShowSearch] = useState(false);
  const [protocolDocs, setProtocolDocs] = useState(live ? [] : SAMPLE_PROTOCOLS);
  const [docsLoaded, setDocsLoaded] = useState(false);

  // ---- Backend sync ------------------------------------------------------
  const apiBaseUrl = live ? session.apiBaseUrl : "";
  const apiToken = live ? session.token : "";
  const [inFlight, setInFlight] = useState(0);
  const [failedSyncs, setFailedSyncs] = useState([]);
  const pcrPromiseRef = useRef(null);
  const isConfigured = Boolean(live && apiBaseUrl && apiToken && incidentId);
  // Derived, not stored — and a failure can never be cleared by a later
  // success. Two syncs racing (one fails, one succeeds a moment later)
  // must not leave the badge saying "synced" while clinical data sits
  // unsaved. Failures stay until someone explicitly dismisses them.
  const syncStatus = !isConfigured ? "demo" : failedSyncs.length > 0 ? "error" : inFlight > 0 ? "syncing" : "ready";

  async function apiRequest(method, path, body) {
    const res = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  }

  // POST /pcr is idempotent server-side, but two syncs firing before the
  // first response lands would still both send it. Sharing one in-flight
  // promise means the chart is created once per session; a failure
  // resets it so a later attempt can retry instead of caching the error.
  function ensurePcr() {
    if (!pcrPromiseRef.current) {
      pcrPromiseRef.current = apiRequest("POST", "/pcr", { incidentId })
        .then((r) => r.pcr_id)
        .catch((e) => { pcrPromiseRef.current = null; throw e; });
    }
    return pcrPromiseRef.current;
  }

  async function syncToBackend(label, method, subPath, body) {
    if (!isConfigured) return;
    setInFlight((n) => n + 1);
    try {
      const id = await ensurePcr();
      await apiRequest(method, `/pcr/${id}${subPath}`, body);
    } catch (e) {
      setFailedSyncs((prev) => [...prev, `${label}: ${e.message}`]);
    } finally {
      setInFlight((n) => n - 1);
    }
  }

  function noteUnsynced(message) {
    if (isConfigured) setFailedSyncs((prev) => [...prev, message]);
  }

  function commitVitals(e) {
    syncToBackend("Vitals reading", "POST", "/vitals", {
      bpSystolic: num(e.bpSys), bpDiastolic: num(e.bpDia), heartRate: num(e.hr), respiratoryRate: num(e.rr),
      spo2Percent: num(e.spo2), bloodGlucose: num(e.glucose), gcsTotal: num(e.gcs), painScale: num(e.pain), temperatureF: num(e.temp),
    });
  }
  function commitProcedure(e) {
    syncToBackend("Procedure", "POST", "/procedures", { procedureName: e.name, outcome: e.outcome || null, notes: e.notes || null });
  }
  function commitMedication(e) {
    syncToBackend("Medication", "POST", "/medications", { drugName: e.name, dose: e.dose, route: e.route });
    if (e.controlled) {
      noteUnsynced(`${e.name}: marked controlled, but no route exists yet to create the chain-of-custody log entry — that link was NOT made`);
    }
  }
  function commitNarrative(text) {
    if (!text || !text.trim()) return;
    syncToBackend("Narrative", "PATCH", "/narrative", { clinicalNarrative: text });
  }
  function commitDisposition(d) {
    if (!d.type) return;
    syncToBackend("Disposition", "PUT", "/disposition", {
      dispositionType: d.type, destinationFacilityId: null, transferOfCareTo: d.transferTo || null,
      primaryImpression: d.primaryImpression || null, secondaryImpressions: null, mechanismOfInjury: d.mechanismOfInjury || null,
    });
    if (d.destinationFacility) {
      noteUnsynced(`Disposition: destination "${d.destinationFacility}" is free text here but the schema stores a facility ID — destination was NOT saved`);
    }
  }

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try { const res = await window.storage.get("protocol-reference-docs", false); if (!cancelled && res && res.value) setProtocolDocs(JSON.parse(res.value)); }
      catch (e) {} finally { if (!cancelled) setDocsLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => { if (!docsLoaded) return; window.storage.set("protocol-reference-docs", JSON.stringify(protocolDocs), false).catch(() => {}); }, [protocolDocs, docsLoaded]);

  function status(key) {
    switch (key) {
      case "patient": return patient.name.trim() ? "complete" : "empty";
      case "assessment": return assessment.chiefComplaint ? "complete" : "empty";
      case "vitals": return vitals.length > 0 ? "complete" : "empty";
      case "procedures": return procedures.length > 0 ? "complete" : "optional";
      case "medications": return medications.length > 0 ? "complete" : "optional";
      case "narrative": return narrative.trim() ? "complete" : "empty";
      case "disposition": return disposition.type ? "complete" : "empty";
      case "signatures": return signatures.some((s) => s.type === "crew") ? "complete" : "empty";
      default: return "empty";
    }
  }
  const requiredSections = SECTIONS.filter((s) => s.required);
  const completeCount = requiredSections.filter((s) => status(s.key) === "complete").length;
  const currentIndex = SECTIONS.findIndex((s) => s.key === tab);
  const nextSection = SECTIONS[currentIndex + 1];
  const chartData = { patient, assessment, vitals, procedures, medications, disposition };

  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }} className="min-h-screen w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        * { box-sizing: border-box; }
        select, button, input, textarea { font-family: inherit; }
        button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid #4EA1F0; outline-offset: 1px; }
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      <div className="px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>ePCR Charting</div>
            <div className="text-base font-semibold">{live ? incidentLabel : "Bruckner Expwy & Longwood Ave — 911 Critical"}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <SyncBadge status={syncStatus} />
            {live && onBack && (
              <button onClick={onBack} className="text-xs px-2 py-1 rounded" style={{ color: TEXT_SECONDARY, border: `1px solid ${HAIRLINE}` }}>← Calls</button>
            )}
            <span className="text-xs mono" style={{ color: completeCount === requiredSections.length ? GREEN : TEXT_SECONDARY }}>{completeCount}/{requiredSections.length} required</span>
            <div className="mono text-xl">{formatClock(now)}</div>
          </div>
        </div>
      </div>

      {live && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-md text-xs" style={{ color: TEXT_SECONDARY, backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}` }}>
          <span style={{ color: GREEN }}>Saved to the server:</span> vitals, procedures, medications, narrative, disposition.{" "}
          <span style={{ color: AMBER }}>Kept on this device only for now:</span> patient demographics (waiting on encryption), assessment and history, signatures. Those are flagged where you enter them.
        </div>
      )}

      {failedSyncs.length > 0 && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-md text-xs" style={{ backgroundColor: "rgba(240,85,74,0.1)", border: "1px solid #593434", color: RED }}>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 font-semibold"><AlertTriangle size={13} /> Not saved to the backend — still in this chart on this device:</span>
            <button onClick={() => setFailedSyncs([])} className="px-2 py-0.5 rounded" style={{ border: "1px solid #593434", color: RED }}>Dismiss</button>
          </div>
          <ul className="mt-1 flex flex-col gap-0.5">{failedSyncs.map((m, i) => <li key={i}>• {m}</li>)}</ul>
        </div>
      )}

      <div className="flex gap-1 px-2 pt-2 border-b overflow-x-auto" style={{ borderColor: HAIRLINE }}>
        {SECTIONS.map((s) => <ChartTab key={s.key} active={tab === s.key} onClick={() => setTab(s.key)} icon={s.icon} label={s.label} status={status(s.key)} />)}
      </div>

      <div className="p-4">
        {tab === "patient" && <PatientTab patient={patient} set={setPatientField} localOnly={isConfigured ? "Not synced: patient name, DOB and SSN are encrypted-at-rest fields, and no app-layer encryption exists yet — sending them unencrypted would defeat the schema's point. Allergies, home meds and history have no backend columns at all." : null} />}
        {tab === "assessment" && <AssessmentTab assessment={assessment} set={setAssessmentField} localOnly={isConfigured ? "Not synced: the schema has no columns for chief complaint, HPI/OPQRST, mental status or survey findings." : null} />}
        {tab === "vitals" && <VitalsTab vitals={vitals} setVitals={setVitals} now={now} onCommit={commitVitals} />}
        {tab === "procedures" && <ProceduresTab procedures={procedures} setProcedures={setProcedures} onCommit={commitProcedure} />}
        {tab === "medications" && <MedicationsTab medications={medications} setMedications={setMedications} allergies={patient.allergies} onCommit={commitMedication} />}
        {tab === "narrative" && <NarrativeTab narrative={narrative} setNarrative={setNarrative} chartData={chartData} onCommit={commitNarrative} />}
        {tab === "disposition" && <DispositionTab disposition={disposition} set={setDispositionField} canSave={isConfigured} onSave={() => commitDisposition(disposition)} />}
        {tab === "signatures" && <SignaturesTab signatures={signatures} setSignatures={setSignatures} chartData={chartData} narrative={narrative} localOnly={isConfigured ? "Not synced: signatures need object storage (the schema stores a pointer to an uploaded image, not the image) and nothing in this backend has that yet." : null} />}
        {nextSection && (
          <button onClick={() => setTab(nextSection.key)} className="mt-4 w-full text-sm font-medium rounded px-3 py-2.5" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY }}>Continue to {nextSection.label} →</button>
        )}
      </div>

      <button onClick={() => setShowSearch(true)} aria-label="Search protocol reference" className="flex items-center justify-center rounded-full" style={{ position: "fixed", bottom: "20px", right: "20px", width: "56px", height: "56px", backgroundColor: BLUE, color: "#fff", border: "none", boxShadow: "0 4px 14px rgba(0,0,0,0.4)", zIndex: 40 }}>
        <Search size={22} />
      </button>
      {showSearch && <ProtocolSearchModal documents={protocolDocs} setDocuments={setProtocolDocs} onClose={() => setShowSearch(false)} />}
    </div>
  );
}

function SyncBadge({ status }) {
  const cfg = {
    demo: { icon: WifiOff, color: TEXT_FAINT, label: "Local only" },
    ready: { icon: Wifi, color: GREEN, label: "Synced" },
    syncing: { icon: Wifi, color: AMBER, label: "Syncing…" },
    error: { icon: WifiOff, color: RED, label: "Sync problem" },
  }[status];
  const Icon = cfg.icon;
  return <div className="flex items-center gap-1 text-xs px-2 py-1 rounded" style={{ color: cfg.color, border: `1px solid ${HAIRLINE}` }}><Icon size={12} /> {cfg.label}</div>;
}

function ChartTab({ active, onClick, icon: Icon, label, status }) {
  const dot = status === "complete" ? <CheckCircle2 size={12} color={GREEN} /> : status === "optional" ? <Circle size={10} color={TEXT_FAINT} /> : <Circle size={10} color={AMBER} />;
  return <button onClick={onClick} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-t-md shrink-0" style={{ color: active ? TEXT_PRIMARY : TEXT_FAINT, backgroundColor: active ? PANEL : "transparent", borderBottom: active ? `2px solid ${BLUE}` : "2px solid transparent" }}><Icon size={14} /> {label} {dot}</button>;
}
function Card({ children }) { return <div className="rounded-lg border p-4" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>{children}</div>; }
function FieldLabel({ children }) { return <label className="text-xs block mb-1" style={{ color: TEXT_SECONDARY }}>{children}</label>; }
function LocalOnlyNote({ message }) {
  if (!message) return null;
  return <div className="text-xs px-3 py-2 rounded-md mb-3" style={{ color: AMBER, backgroundColor: "rgba(245,166,35,0.08)", border: "1px solid #4A3A1E" }}>{message}</div>;
}
function TextField({ label, value, onChange, placeholder, type = "text", hint }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full text-sm rounded px-2 py-1.5" style={inputStyle()} />
      {hint && <div className="text-xs mt-0.5" style={{ color: TEXT_FAINT }}>{hint}</div>}
    </div>
  );
}
function PresetButton({ label, active, onClick }) {
  return <button onClick={onClick} className="text-xs px-3 py-2 rounded-md" style={{ backgroundColor: active ? "#1E3A2E" : SUNKEN, border: active ? "1px solid #2E5943" : `1px solid ${HAIRLINE}`, color: active ? GREEN : TEXT_SECONDARY }}>{label}</button>;
}
function TapOrType({ options, value, onChange, placeholder = "Specify..." }) {
  const isCustom = value !== "" && !options.includes(value);
  const [showCustom, setShowCustom] = useState(isCustom);
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => <PresetButton key={opt} label={opt} active={!showCustom && value === opt} onClick={() => { setShowCustom(false); onChange(opt); }} />)}
        <PresetButton label="Other" active={showCustom} onClick={() => { setShowCustom(true); onChange(""); }} />
      </div>
      {showCustom && <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full text-sm rounded px-2 py-1.5 mt-2" style={inputStyle()} autoFocus />}
    </div>
  );
}
function ChipMultiSelect({ options, value, onChange, placeholder }) {
  const selected = value.split(",").map((s) => s.trim()).filter(Boolean);
  function toggle(opt) { onChange(selected.includes(opt) ? selected.filter((s) => s !== opt).join(", ") : [...selected, opt].join(", ")); }
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-2">{options.map((opt) => <PresetButton key={opt} label={opt} active={selected.includes(opt)} onClick={() => toggle(opt)} />)}</div>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="w-full text-sm rounded px-2 py-1.5" style={inputStyle()} />
    </div>
  );
}
function ScaleSelect({ value, onChange, max = 10 }) {
  return (
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: max + 1 }, (_, i) => i).map((n) => (
        <button key={n} onClick={() => onChange(String(n))} className="text-xs rounded-md flex items-center justify-center font-medium" style={{ width: "30px", height: "30px", backgroundColor: String(n) === value ? "#1E3A2E" : SUNKEN, border: String(n) === value ? "1px solid #2E5943" : `1px solid ${HAIRLINE}`, color: String(n) === value ? GREEN : TEXT_SECONDARY }}>{n}</button>
      ))}
    </div>
  );
}

function PatientTab({ patient, set, localOnly }) {
  function upd(field, value) { set((p) => ({ ...p, [field]: value })); }
  return (
    <div>
      <LocalOnlyNote message={localOnly} />
      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <TextField label="Patient Name" value={patient.name} onChange={(v) => upd("name", v)} placeholder="Last, First" />
          <TextField label="DOB" value={patient.dob} onChange={(v) => upd("dob", v)} type="date" />
          <div><FieldLabel>Sex</FieldLabel><TapOrType options={["M", "F", "U"]} value={patient.sex} onChange={(v) => upd("sex", v)} placeholder="Specify" /></div>
          <TextField label="Weight (kg)" value={patient.weight} onChange={(v) => upd("weight", v)} type="number" />
        </div>
        <div className="flex flex-col gap-3">
          <div>
            <FieldLabel>Allergies — tap what applies, checked against Medications later</FieldLabel>
            <ChipMultiSelect options={["Penicillin", "Sulfa", "Latex", "Shellfish", "NKDA"]} value={patient.allergies} onChange={(v) => upd("allergies", v)} placeholder="Add more, comma-separated" />
          </div>
          <TextField label="Home Medications" value={patient.homeMeds} onChange={(v) => upd("homeMeds", v)} placeholder="e.g. Metoprolol, Lisinopril" />
          <div>
            <FieldLabel>Past Medical History</FieldLabel>
            <ChipMultiSelect options={["HTN", "Diabetes", "COPD", "Asthma", "CAD", "Prior MI", "Seizure Disorder", "CHF"]} value={patient.pmh} onChange={(v) => upd("pmh", v)} placeholder="Add more, comma-separated" />
          </div>
        </div>
      </Card>
    </div>
  );
}

function AssessmentTab({ assessment, set, localOnly }) {
  function upd(field, value) { set((a) => ({ ...a, [field]: value })); }
  const suggestions = PROTOCOL_SUGGESTIONS[assessment.chiefComplaint];
  return (
    <div className="flex flex-col gap-3">
      <LocalOnlyNote message={localOnly} />
      <Card>
        <FieldLabel>Chief Complaint — what's wrong, in one tap</FieldLabel>
        <TapOrType options={CHIEF_COMPLAINTS} value={assessment.chiefComplaint} onChange={(v) => upd("chiefComplaint", v)} placeholder="Specify chief complaint" />
      </Card>
      {suggestions && (
        <div className="rounded-lg border p-3" style={{ backgroundColor: "rgba(78,161,240,0.06)", borderColor: "#2C4A63" }}>
          <div className="text-xs font-semibold mb-1" style={{ color: BLUE }}>PROTOCOL-STYLE SUGGESTIONS — general reference, not your agency's approved protocol</div>
          <ul className="flex flex-col gap-0.5">{suggestions.map((s, i) => <li key={i} className="text-xs" style={{ color: TEXT_SECONDARY }}>• {s}</li>)}</ul>
        </div>
      )}
      <Card>
        <div className="text-xs font-semibold tracking-wide mb-3" style={{ color: TEXT_FAINT }}>HISTORY OF PRESENT ILLNESS</div>
        <div className="flex flex-col gap-3">
          <div><FieldLabel>Onset — when did it start?</FieldLabel><TapOrType options={["Sudden", "Gradual"]} value={assessment.onset} onChange={(v) => upd("onset", v)} placeholder="Describe onset" /></div>
          <div><FieldLabel>Provocation — what changes it?</FieldLabel><TapOrType options={["Nothing helps", "Rest helps", "Movement worsens", "Nothing worsens"]} value={assessment.provocation} onChange={(v) => upd("provocation", v)} placeholder="Describe" /></div>
          <div><FieldLabel>Quality — what does it feel like?</FieldLabel><TapOrType options={["Sharp", "Dull", "Crushing", "Burning", "Cramping", "Pressure"]} value={assessment.quality} onChange={(v) => upd("quality", v)} placeholder="Describe" /></div>
          <div><FieldLabel>Radiation — does it move or spread?</FieldLabel><TapOrType options={["None", "Arm", "Jaw", "Back", "Neck"]} value={assessment.radiation} onChange={(v) => upd("radiation", v)} placeholder="Describe" /></div>
          <div><FieldLabel>Severity — how bad, 0 to 10?</FieldLabel><ScaleSelect value={assessment.severity} onChange={(v) => upd("severity", v)} /></div>
          <TextField label="Time" value={assessment.time} onChange={(v) => upd("time", v)} hint="What time did it start?" />
        </div>
      </Card>
      <Card>
        <div className="flex flex-col gap-3">
          <div><FieldLabel>Mental Status</FieldLabel><TapOrType options={["A&Ox4", "Confused", "Lethargic", "Unresponsive"]} value={assessment.mentalStatus} onChange={(v) => upd("mentalStatus", v)} placeholder="Describe" /></div>
          <div>
            <FieldLabel>Primary Survey (ABC)</FieldLabel>
            <div className="mb-1"><PresetButton label="Quick-fill: All Normal" active={false} onClick={() => upd("primarySurvey", "Airway patent, breathing unlabored, radial pulse strong and regular")} /></div>
            <input value={assessment.primarySurvey} onChange={(e) => upd("primarySurvey", e.target.value)} placeholder="Airway/breathing/circulation findings" className="w-full text-sm rounded px-2 py-1.5" style={inputStyle()} />
          </div>
          <div>
            <FieldLabel>Secondary Survey</FieldLabel>
            <div className="mb-1"><PresetButton label="Quick-fill: No Acute Findings" active={false} onClick={() => upd("secondarySurvey", "Head-to-toe survey with no acute findings")} /></div>
            <input value={assessment.secondarySurvey} onChange={(e) => upd("secondarySurvey", e.target.value)} placeholder="Head-to-toe findings" className="w-full text-sm rounded px-2 py-1.5" style={inputStyle()} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function VitalsTab({ vitals, setVitals, now, onCommit }) {
  const emptyDraft = { bpSys: "", bpDia: "", hr: "", rr: "", spo2: "", gcs: "", pain: "", glucose: "", temp: "" };
  const [draft, setDraft] = useState(emptyDraft);
  const last = vitals[0];
  const sinceLast = last ? minutesSince(last.recordedAt, now) : null;
  const overInterval = sinceLast !== null && sinceLast > VITALS_INTERVAL_MIN;
  function update(field, value) { setDraft((d) => ({ ...d, [field]: value })); }
  function record() {
    if (!Object.values(draft).some((v) => v !== "")) return;
    const entry = { id: `v${Date.now()}`, recordedAt: new Date(), ...draft };
    setVitals((prev) => [entry, ...prev]);
    onCommit?.(entry);
    setDraft(emptyDraft);
  }
  return (
    <div className="flex flex-col gap-3">
      {last && <div className="text-xs px-3 py-2 rounded-md" style={{ color: overInterval ? RED : TEXT_SECONDARY, backgroundColor: overInterval ? "rgba(240,85,74,0.1)" : SUNKEN, border: `1px solid ${overInterval ? "#593434" : HAIRLINE}` }}>{Math.floor(sinceLast)} min since last reading {overInterval ? `— protocol interval is ${VITALS_INTERVAL_MIN} min during transport` : ""}</div>}
      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <FieldLabel>BP (sys/dia)</FieldLabel>
            <div className="flex items-center gap-1">
              <input type="number" value={draft.bpSys} onChange={(e) => update("bpSys", e.target.value)} className="w-full text-sm rounded px-2 py-1.5" style={inputStyle()} placeholder="120" />
              <span style={{ color: TEXT_FAINT }}>/</span>
              <input type="number" value={draft.bpDia} onChange={(e) => update("bpDia", e.target.value)} className="w-full text-sm rounded px-2 py-1.5" style={inputStyle()} placeholder="80" />
            </div>
          </div>
          <TextField label="Heart Rate" value={draft.hr} onChange={(v) => update("hr", v)} placeholder="88" type="number" />
          <TextField label="Resp. Rate" value={draft.rr} onChange={(v) => update("rr", v)} placeholder="16" type="number" />
          <TextField label="SpO2 %" value={draft.spo2} onChange={(v) => update("spo2", v)} placeholder="98" type="number" />
          <TextField label="GCS (3-15)" value={draft.gcs} onChange={(v) => update("gcs", v)} placeholder="15" type="number" />
          <TextField label="Pain (0-10)" value={draft.pain} onChange={(v) => update("pain", v)} placeholder="4" type="number" />
          <TextField label="Glucose" value={draft.glucose} onChange={(v) => update("glucose", v)} placeholder="95" type="number" />
          <TextField label="Temp °F" value={draft.temp} onChange={(v) => update("temp", v)} placeholder="98.6" type="number" />
        </div>
        <button onClick={record} className="mt-3 w-full text-sm font-medium rounded px-3 py-2.5" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>Record Vitals — {formatClock(now)}</button>
      </Card>
      <Card>
        <div className="text-xs font-semibold tracking-wide mb-2" style={{ color: TEXT_FAINT }}>LOG ({vitals.length})</div>
        {vitals.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>No readings yet.</div>}
        <div className="flex flex-col gap-2">
          {vitals.map((v, i) => {
            const prev = vitals[i + 1];
            const gap = prev ? Math.floor(minutesSince(prev.recordedAt, v.recordedAt)) : null;
            return <div key={v.id} className="text-xs mono flex items-center justify-between border-b pb-2" style={{ borderColor: "#1B2330", color: TEXT_SECONDARY }}><span>{formatClock(v.recordedAt)} — BP {v.bpSys || "—"}/{v.bpDia || "—"} · HR {v.hr || "—"} · RR {v.rr || "—"} · SpO2 {v.spo2 || "—"}%</span>{gap !== null && <span style={{ color: gap > VITALS_INTERVAL_MIN ? RED : TEXT_FAINT }}>+{gap}m</span>}</div>;
          })}
        </div>
      </Card>
    </div>
  );
}

function ProceduresTab({ procedures, setProcedures, onCommit }) {
  const [selected, setSelected] = useState(null);
  const [outcome, setOutcome] = useState("");
  const [notes, setNotes] = useState("");
  function log() {
    if (!selected) return;
    const entry = { id: `p${Date.now()}`, name: selected, performedAt: new Date(), outcome, notes };
    setProcedures((prev) => [entry, ...prev]);
    onCommit?.(entry);
    setSelected(null); setOutcome(""); setNotes("");
  }
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <FieldLabel>Procedure</FieldLabel>
        <TapOrType options={PROCEDURE_PRESETS} value={selected || ""} onChange={setSelected} placeholder="Specify procedure" />
        {selected && (
          <div className="flex flex-col gap-2 mt-3">
            <div>
              <FieldLabel>Outcome</FieldLabel>
              <TapOrType options={["Successful, 1st attempt", "Successful, 2nd attempt", "Unsuccessful"]} value={outcome} onChange={setOutcome} placeholder="Describe outcome" />
            </div>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className="w-full text-sm rounded px-2 py-1.5" style={inputStyle()} />
            <button onClick={log} className="text-sm font-medium rounded px-3 py-2.5" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>Log Procedure</button>
          </div>
        )}
      </Card>
      <Card>
        <div className="text-xs font-semibold tracking-wide mb-2" style={{ color: TEXT_FAINT }}>LOG ({procedures.length})</div>
        {procedures.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>No procedures logged.</div>}
        <div className="flex flex-col gap-2">
          {procedures.map((p) => <div key={p.id} className="text-xs border-b pb-2" style={{ borderColor: "#1B2330" }}><span className="mono" style={{ color: TEXT_FAINT }}>{formatClock(p.performedAt)}</span> <span style={{ color: TEXT_PRIMARY }}>{p.name}</span> {p.outcome && <span style={{ color: TEXT_SECONDARY }}>— {p.outcome}</span>}</div>)}
        </div>
      </Card>
    </div>
  );
}

function MedicationsTab({ medications, setMedications, allergies, onCommit }) {
  const [selected, setSelected] = useState(null);
  const [dose, setDose] = useState("");
  const [route, setRoute] = useState(ROUTES[0]);
  const [controlled, setControlled] = useState(false);
  const allergyHit = selected ? checkAllergy(selected, allergies) : false;
  const defaults = MED_DEFAULTS[selected];
  function selectDrug(name) {
    setSelected(name);
    setDose("");
    setRoute(MED_DEFAULTS[name] ? MED_DEFAULTS[name].route : ROUTES[0]);
  }
  function log() {
    if (!selected || !dose) return;
    const entry = { id: `m${Date.now()}`, name: selected, dose, route, controlled, administeredAt: new Date(), allergyOverride: allergyHit };
    setMedications((prev) => [entry, ...prev]);
    onCommit?.(entry);
    setSelected(null); setDose(""); setControlled(false);
  }
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <FieldLabel>Medication</FieldLabel>
        <TapOrType options={MEDICATION_PRESETS} value={selected || ""} onChange={selectDrug} placeholder="Specify medication given" />
        {allergyHit && <div className="text-xs px-3 py-2 rounded-md mt-2 flex items-center gap-1.5 flex-wrap" style={{ color: RED, backgroundColor: "rgba(240,85,74,0.1)", border: "1px solid #593434" }}><AlertTriangle size={13} /> Patient has a listed allergy matching this drug — verify before administering.<span style={{ color: TEXT_FAINT }}>(name-match only, not a real interaction database)</span></div>}
        {selected && (
          <div className="flex flex-col gap-2 mt-3">
            <div>
              <FieldLabel>Dose</FieldLabel>
              {defaults?.doses?.length > 0 && <div className="flex flex-wrap gap-2 mb-2">{defaults.doses.map((d) => <PresetButton key={d} label={d} active={dose === d} onClick={() => setDose(d)} />)}</div>}
              <input value={dose} onChange={(e) => setDose(e.target.value)} placeholder="Dose — e.g. 0.3 mg" className="w-full text-sm rounded px-2 py-1.5" style={inputStyle()} />
            </div>
            <div>
              <FieldLabel>Route {defaults ? "(defaulted to typical route — change if different)" : ""}</FieldLabel>
              <select value={route} onChange={(e) => setRoute(e.target.value)} className="text-sm rounded px-2 py-1.5" style={inputStyle()}>
                {ROUTES.map((r) => <option key={r} value={r} style={{ color: "#000" }}>{r}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs" style={{ color: TEXT_SECONDARY }}><input type="checkbox" checked={controlled} onChange={(e) => setControlled(e.target.checked)} /> Controlled substance — link to chain-of-custody log</label>
            <button onClick={log} className="text-sm font-medium rounded px-3 py-2.5" style={{ backgroundColor: allergyHit ? "#3A1E1E" : "#1E3A2E", border: allergyHit ? "1px solid #593434" : "1px solid #2E5943", color: allergyHit ? "#F0857D" : GREEN }}>{allergyHit ? "Log Anyway — Allergy Flagged" : "Log Medication"}</button>
          </div>
        )}
      </Card>
      <Card>
        <div className="text-xs font-semibold tracking-wide mb-2" style={{ color: TEXT_FAINT }}>LOG ({medications.length})</div>
        {medications.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>No medications logged.</div>}
        <div className="flex flex-col gap-2">
          {medications.map((m) => <div key={m.id} className="text-xs border-b pb-2" style={{ borderColor: "#1B2330" }}><span className="mono" style={{ color: TEXT_FAINT }}>{formatClock(m.administeredAt)}</span> <span style={{ color: TEXT_PRIMARY }}>{m.name} {m.dose} {m.route}</span>{m.controlled && <span className="ml-1" style={{ color: AMBER }}>⚠ controlled substance</span>}{m.allergyOverride && <span className="ml-1" style={{ color: RED }}>⚠ given despite allergy flag</span>}</div>)}
        </div>
      </Card>
    </div>
  );
}

function NarrativeTab({ narrative, setNarrative, chartData, onCommit }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previous, setPrevious] = useState(null);
  async function runAssist(mode) {
    setLoading(true); setError("");
    try {
      const result = mode === "draft" ? await callClaude(DRAFT_SYSTEM_PROMPT, buildChartSummary(chartData)) : await callClaude(CLEANUP_SYSTEM_PROMPT, narrative);
      const cleaned = result.trim();
      setPrevious(narrative); setNarrative(cleaned);
      onCommit?.(cleaned);
    } catch (e) { setError("Couldn't reach the writing assistant — check your connection and try again."); }
    finally { setLoading(false); }
  }
  function undo() { if (previous !== null) { setNarrative(previous); onCommit?.(previous); setPrevious(null); } }
  return (
    <Card>
      <FieldLabel>Narrative</FieldLabel>
      <div className="text-xs mb-2" style={{ color: TEXT_FAINT }}>Write what happened in your own words. Spelling and grammar don't matter here — that's what the cleanup button is for. Saves to the chart when you tap out of the box.</div>
      <textarea value={narrative} onChange={(e) => setNarrative(e.target.value)} onBlur={() => onCommit?.(narrative)} rows={8} placeholder="e.g. we pulled up patient was on the couch grabbin his chest said it started about an hour ago while he was watching tv..." className="w-full text-sm rounded px-3 py-2" style={{ ...inputStyle(), resize: "vertical" }} />
      {error && <div className="text-xs mt-2 px-3 py-2 rounded-md" style={{ color: RED, backgroundColor: "rgba(240,85,74,0.1)", border: "1px solid #593434" }}>{error}</div>}
      <div className="flex flex-wrap gap-2 mt-3">
        <button onClick={() => runAssist("draft")} disabled={loading} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-md" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY, opacity: loading ? 0.6 : 1 }}>{loading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Draft from Chart Data</button>
        <button onClick={() => runAssist("cleanup")} disabled={loading || !narrative.trim()} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-md" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN, opacity: loading || !narrative.trim() ? 0.5 : 1 }}>{loading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Clean Up My Writing</button>
        {previous !== null && <button onClick={undo} className="text-xs px-3 py-2 rounded-md" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_FAINT }}>Undo</button>}
      </div>
    </Card>
  );
}

function DispositionTab({ disposition, set, canSave, onSave }) {
  const [saved, setSaved] = useState(false);
  function upd(field, value) { setSaved(false); set((d) => ({ ...d, [field]: value })); }
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <FieldLabel>Disposition</FieldLabel>
        <div className="flex flex-wrap gap-2 mb-3">{DISPOSITIONS.map((d) => <PresetButton key={d.value} label={d.label} active={disposition.type === d.value} onClick={() => upd("type", d.value)} />)}</div>
        {disposition.type === "transported" && (
          <div className="flex flex-col gap-2 mb-2">
            <div><FieldLabel>Destination Facility</FieldLabel><TapOrType options={["Lincoln Hospital ED", "Jacobi Medical Center", "Montefiore ED"]} value={disposition.destinationFacility} onChange={(v) => upd("destinationFacility", v)} placeholder="Specify facility" /></div>
            <TextField label="Transfer of Care To" value={disposition.transferTo} onChange={(v) => upd("transferTo", v)} placeholder="Receiving RN/MD name" />
          </div>
        )}
        <TextField label="Primary Impression" value={disposition.primaryImpression} onChange={(v) => upd("primaryImpression", v)} />
        <div className="mt-2"><FieldLabel>Mechanism of Injury (if applicable)</FieldLabel><TapOrType options={["MVC", "Fall", "Assault", "Penetrating Trauma", "Blunt Trauma"]} value={disposition.mechanismOfInjury} onChange={(v) => upd("mechanismOfInjury", v)} placeholder="Specify" /></div>
        {canSave && (
          <div className="mt-3">
            <button onClick={() => { onSave(); setSaved(true); }} disabled={!disposition.type} className="w-full text-sm font-medium rounded px-3 py-2.5" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN, opacity: disposition.type ? 1 : 0.5 }}>
              {saved ? "Saved — tap again to resave after changes" : "Save Disposition to Chart"}
            </button>
            <div className="text-xs mt-1" style={{ color: TEXT_FAINT }}>Saves type, impression, mechanism and transfer of care. Destination facility and the transport times below have no backend home yet.</div>
          </div>
        )}
      </Card>
      <Card>
        <div className="text-xs font-semibold tracking-wide mb-2" style={{ color: TEXT_FAINT }}>TRANSPORT TIMES</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <TextField label="Dispatched" value={disposition.dispatchedAt} onChange={(v) => upd("dispatchedAt", v)} type="time" />
          <TextField label="En Route" value={disposition.enRouteAt} onChange={(v) => upd("enRouteAt", v)} type="time" />
          <TextField label="On Scene" value={disposition.onSceneAt} onChange={(v) => upd("onSceneAt", v)} type="time" />
          <TextField label="Left Scene" value={disposition.leftSceneAt} onChange={(v) => upd("leftSceneAt", v)} type="time" />
        </div>
      </Card>
    </div>
  );
}

function SignaturesTab({ signatures, setSignatures, chartData, narrative, localOnly }) {
  const [type, setType] = useState("crew");
  const [name, setName] = useState("");
  const [credential, setCredential] = useState("");
  const [showExport, setShowExport] = useState(false);
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  function getPos(e) {
    const canvas = canvasRef.current; const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX; const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) * (canvas.width / rect.width), y: (clientY - rect.top) * (canvas.height / rect.height) };
  }
  function start(e) { drawingRef.current = true; const ctx = canvasRef.current.getContext("2d"); const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function move(e) { if (!drawingRef.current) return; e.preventDefault(); const ctx = canvasRef.current.getContext("2d"); const p = getPos(e); ctx.strokeStyle = TEXT_PRIMARY; ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineTo(p.x, p.y); ctx.stroke(); }
  function end() { drawingRef.current = false; }
  function clearPad() { const c = canvasRef.current; c.getContext("2d").clearRect(0, 0, c.width, c.height); }
  function capture() {
    if (!name.trim()) return;
    const dataUrl = canvasRef.current.toDataURL();
    setSignatures((prev) => [{ id: `s${Date.now()}`, type, name: name.trim(), credential, dataUrl, capturedAt: new Date() }, ...prev]);
    setName(""); setCredential(""); clearPad();
  }
  return (
    <div className="flex flex-col gap-3">
      <LocalOnlyNote message={localOnly} />
      <Card>
        <div className="flex flex-wrap gap-2 mb-3">{["crew", "receiving_provider", "patient", "refusal"].map((t) => <PresetButton key={t} label={t.replace("_", " ")} active={type === t} onClick={() => setType(t)} />)}</div>
        <div className="flex gap-2 mb-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Signer name" className="flex-1 text-sm rounded px-2 py-1.5" style={inputStyle()} />
          <input value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="Credential (opt.)" className="flex-1 text-sm rounded px-2 py-1.5" style={inputStyle()} />
        </div>
        <canvas ref={canvasRef} width={600} height={200} className="w-full rounded-md" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, touchAction: "none", height: "160px" }} onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end} onTouchStart={start} onTouchMove={move} onTouchEnd={end} />
        <div className="flex gap-2 mt-2">
          <button onClick={clearPad} className="text-xs px-2 py-1 rounded flex items-center gap-1" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY }}><Trash2 size={12} /> Clear</button>
          <button onClick={capture} className="flex-1 text-sm font-medium rounded px-3 py-2" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>Capture Signature</button>
        </div>
      </Card>
      <Card>
        <div className="text-xs font-semibold tracking-wide mb-2" style={{ color: TEXT_FAINT }}>CAPTURED ({signatures.length})</div>
        {signatures.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>No signatures captured.</div>}
        <div className="flex flex-col gap-3">
          {signatures.map((s) => <div key={s.id} className="flex items-center gap-3"><img src={s.dataUrl} alt="signature" style={{ width: "80px", height: "27px", backgroundColor: SUNKEN, borderRadius: "4px", border: `1px solid ${HAIRLINE}` }} /><div className="text-xs"><div style={{ color: TEXT_PRIMARY }}>{s.name} <span style={{ color: TEXT_FAINT }}>({s.type.replace("_", " ")})</span></div><div className="mono" style={{ color: TEXT_FAINT }}>{formatClock(s.capturedAt)}</div></div></div>)}
        </div>
      </Card>
      <Card>
        <div className="text-xs font-semibold tracking-wide mb-2" style={{ color: TEXT_FAINT }}>EXPORT</div>
        <div className="text-xs mb-2" style={{ color: TEXT_FAINT }}>Generates a NEMSIS v3.5-style structured export of this chart.</div>
        <button onClick={() => setShowExport(true)} className="w-full text-sm font-medium rounded px-3 py-2.5" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY }}>Preview NEMSIS Export</button>
      </Card>
      {showExport && <NemsisExportModal xml={generateNemsisXml({ ...chartData, narrative })} onClose={() => setShowExport(false)} />}
    </div>
  );
}

function NemsisExportModal({ xml, onClose }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.7)", zIndex: 50 }}>
      <div className="w-full rounded-lg border flex flex-col" style={{ maxWidth: "600px", maxHeight: "85vh", backgroundColor: PANEL, borderColor: HAIRLINE }}>
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: HAIRLINE }}>
          <div className="text-sm font-semibold">NEMSIS-Style Export</div>
          <button onClick={onClose} style={{ color: TEXT_SECONDARY }}><X size={18} /></button>
        </div>
        <div className="text-xs px-4 pt-3" style={{ color: "#F5934A" }}>Structural mapping demonstration — verify element numbers against the current XSD and resolve medication names to RxNorm codes before any real submission.</div>
        <pre className="p-4 overflow-auto text-xs mono flex-1" style={{ color: TEXT_SECONDARY, whiteSpace: "pre-wrap" }}>{xml}</pre>
        <div className="p-4 border-t shrink-0" style={{ borderColor: HAIRLINE }}>
          <button onClick={() => downloadXml(xml, "pcr_export.xml")} className="w-full text-sm font-medium rounded px-3 py-2" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>Download XML</button>
        </div>
      </div>
    </div>
  );
}

function ProtocolSearchModal({ documents, setDocuments, onClose }) {
  const [query, setQuery] = useState("");
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const results = query.trim() ? searchProtocols(query, documents) : documents;
  function addReference() {
    if (!newTitle.trim() || !newContent.trim()) return;
    setDocuments((prev) => [...prev, { id: `d${Date.now()}`, title: newTitle.trim(), content: newContent.trim() }]);
    setNewTitle(""); setNewContent(""); setShowAdd(false);
  }
  return (
    <div className="fixed inset-0 flex items-end sm:items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.7)", zIndex: 50 }}>
      <div className="w-full rounded-t-lg sm:rounded-lg border flex flex-col" style={{ maxWidth: "480px", maxHeight: "85vh", backgroundColor: PANEL, borderColor: HAIRLINE }}>
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: HAIRLINE }}>
          <div className="text-sm font-semibold flex items-center gap-1.5"><Search size={15} /> Protocol Reference</div>
          <button onClick={onClose} style={{ color: TEXT_SECONDARY }}><X size={18} /></button>
        </div>
        <div className="text-xs px-4 pt-3" style={{ color: "#F5934A" }}>Sample reference library for demonstration — a real deployment holds your agency's actual uploaded, approved protocols.</div>
        {selectedDoc ? (
          <div className="p-4 overflow-y-auto">
            <button onClick={() => setSelectedDoc(null)} className="text-xs mb-2" style={{ color: BLUE }}>← Back to results</button>
            <div className="text-sm font-semibold mb-2">{selectedDoc.title}</div>
            <div className="text-sm" style={{ color: TEXT_SECONDARY, lineHeight: "1.6" }}>{selectedDoc.content}</div>
          </div>
        ) : showAdd ? (
          <div className="p-4 flex flex-col gap-2 overflow-y-auto">
            <div className="text-xs mb-1" style={{ color: TEXT_FAINT }}>Simulates what would exist after a real upload's OCR/extraction step — title and body text only, no actual PDF handling here.</div>
            <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Reference title" className="w-full text-sm rounded px-2 py-1.5" style={inputStyle()} />
            <textarea value={newContent} onChange={(e) => setNewContent(e.target.value)} rows={5} placeholder="Reference text" className="w-full text-sm rounded px-2 py-1.5" style={{ ...inputStyle(), resize: "vertical" }} />
            <div className="flex gap-2 mt-1">
              <button onClick={() => setShowAdd(false)} className="text-xs px-3 py-2 rounded" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY }}>Cancel</button>
              <button onClick={addReference} className="flex-1 text-sm font-medium rounded px-3 py-2" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>Add to Library</button>
            </div>
          </div>
        ) : (
          <>
            <div className="px-4 pt-3"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search — e.g. 'anafalaxis' still finds anaphylaxis" className="w-full text-sm rounded px-3 py-2" style={inputStyle()} autoFocus /></div>
            <div className="p-4 overflow-y-auto flex flex-col gap-2">
              {results.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>No matches.</div>}
              {results.map((doc) => (
                <button key={doc.id} onClick={() => setSelectedDoc(doc)} className="text-left rounded-md px-3 py-2" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}` }}>
                  <div className="text-sm font-medium" style={{ color: TEXT_PRIMARY }}>{doc.title}</div>
                  <div className="text-xs mt-0.5" style={{ color: TEXT_FAINT, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{doc.content}</div>
                </button>
              ))}
              <button onClick={() => setShowAdd(true)} className="flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-md mt-1" style={{ backgroundColor: "transparent", border: `1px dashed ${HAIRLINE}`, color: TEXT_FAINT }}><Plus size={13} /> Add Reference (Demo)</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}


const PRIORITY_LABEL = { critical: "Critical", emergent: "Emergent", urgent: "Urgent", routine: "Routine" };

export default function EpcrCharting({ session }) {
  const live = session?.mode === "live";
  const [picked, setPicked] = useState(null); // { id, label }
  const [calls, setCalls] = useState(null);
  const [mine, setMine] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!live || picked) return;
    let cancelled = false;
    const get = (path) => fetch(`${session.apiBaseUrl}${path}`, { headers: { Authorization: `Bearer ${session.token}` } })
      .then(async (r) => { const j = await r.json().catch(() => null); if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`); return j; });
    Promise.all([get("/incidents"), get("/auth/me")])
      .then(([incidents, me]) => {
        if (cancelled) return;
        setCalls(incidents.filter((i) => !i.closed_at));
        setMine(me.incident?.incident_id || null);
      })
      .catch((e) => { if (!cancelled) setError(e.message || "Could not load calls"); });
    return () => { cancelled = true; };
  }, [live, picked, session]);

  if (!live) return <EpcrChart session={session} incidentId="" incidentLabel="" />;
  if (picked) return <EpcrChart key={picked.id} session={session} incidentId={picked.id} incidentLabel={picked.label} onBack={() => setPicked(null)} />;

  const ordered = (calls || []).slice().sort((a, b) => (a.incident_id === mine ? -1 : b.incident_id === mine ? 1 : 0));
  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, sans-serif" }} className="min-h-screen w-full">
      <div className="px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
        <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>ePCR Charting</div>
        <div className="text-base font-semibold">Which call are you charting?</div>
      </div>
      <div className="p-4 flex flex-col gap-2" style={{ maxWidth: "640px" }}>
        {error && <div className="text-sm" style={{ color: RED }}>{error}</div>}
        {!error && calls === null && <div className="text-sm" style={{ color: TEXT_FAINT }}>Loading calls…</div>}
        {calls && ordered.length === 0 && <div className="text-sm" style={{ color: TEXT_FAINT }}>No open calls. A chart is started from a call that dispatch has created.</div>}
        {ordered.map((c) => (
          <button key={c.incident_id} onClick={() => setPicked({ id: c.incident_id, label: `${c.scene_address} — ${PRIORITY_LABEL[c.priority] || c.priority}` })}
            className="text-left rounded-lg border px-4 py-3" style={{ backgroundColor: PANEL, borderColor: c.incident_id === mine ? BLUE : HAIRLINE }}>
            {c.incident_id === mine && <div className="text-xs font-semibold mb-0.5" style={{ color: BLUE }}>YOUR CURRENT CALL</div>}
            <div className="text-sm font-medium">{c.scene_address}{c.scene_detail ? ` · ${c.scene_detail}` : ""}</div>
            <div className="text-xs" style={{ color: TEXT_SECONDARY }}>{PRIORITY_LABEL[c.priority] || c.priority} · {c.capability_needed} · {(c.assigned_units || []).length} unit(s) assigned</div>
          </button>
        ))}
      </div>
    </div>
  );
}
