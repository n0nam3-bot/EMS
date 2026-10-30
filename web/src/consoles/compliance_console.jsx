import React, { useState, useEffect, useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ShieldAlert,
  ClipboardList,
  Settings,
  X,
  Wifi,
  WifiOff,
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

const URGENCY = {
  critical: { color: "#F0554A", label: "Critical" },
  warning: { color: "#F5A623", label: "Due Soon" },
  ok: { color: "#34D399", label: "Current" },
};

const CASE_STATUS = {
  open: { color: "#F0554A", label: "Open" },
  under_review: { color: "#4EA1F0", label: "Under Review" },
  closed: { color: "#55627A", label: "Closed" },
};

function daysFromToday(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}
function daysUntil(date) {
  return Math.round((date - new Date()) / (1000 * 60 * 60 * 24));
}
function urgencyFor(days) {
  if (days <= 7) return "critical";
  if (days <= 30) return "warning";
  return "ok";
}
function formatDays(days) {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "Due today";
  return `${days}d remaining`;
}

const demoCerts = [
  { id: "c1", crewMember: "W. Cho", certType: "EMT-B", expiresOn: daysFromToday(-2) },
  { id: "c2", crewMember: "D. Osei", certType: "ACLS", expiresOn: daysFromToday(4) },
  { id: "c3", crewMember: "M. Chen", certType: "EMT-B", expiresOn: daysFromToday(12) },
  { id: "c4", crewMember: "R. Alvarez", certType: "EMT-B", expiresOn: daysFromToday(25) },
  { id: "c5", crewMember: "K. Diallo", certType: "Paramedic", expiresOn: daysFromToday(90) },
  { id: "c6", crewMember: "J. Patel", certType: "Paramedic", expiresOn: daysFromToday(120) },
];
const demoVehicles = [
  { id: "v1", unit: "Unit 2", inspectionDue: daysFromToday(-5) },
  { id: "v2", unit: "Unit 9", inspectionDue: daysFromToday(8) },
  { id: "v3", unit: "Unit 12", inspectionDue: daysFromToday(60) },
  { id: "v4", unit: "Unit 5", inspectionDue: daysFromToday(75) },
];
const demoPcrs = [
  { id: "p1", incidentRef: "Fordham Rd & Grand Concourse — 911 Emergent", crew: "Nguyen / Brooks", completeness: 92, flags: ["Vitals interval exceeds protocol — q5min required during transport"], status: "pending" },
  { id: "p2", incidentRef: "Westchester Ave & Southern Blvd — 911 Critical", crew: "Patel / Osei", completeness: 78, flags: ["Refusal-of-further-care documentation missing", "Signature timestamp absent"], status: "pending" },
  { id: "p3", incidentRef: "Bruckner Expwy & Longwood Ave — 911 Critical", crew: "Diallo / Fitzgerald", completeness: 100, flags: [], status: "pending" },
];
const investigations = [
  { caseNumber: "2026-014", subject: "PCR Documentation Timeliness", citation: "10 NYCRR § 800.3", status: "open", opened: daysFromToday(-6), note: "Pattern of chart completion beyond the 24-hour policy window across three transports." },
  { caseNumber: "2026-011", subject: "Controlled Substance Count Discrepancy", citation: "Agency SOP — Controlled Substance Accountability", status: "under_review", opened: daysFromToday(-14), note: "Waste count mismatch, single incident, Unit 7. Awaiting witness statement." },
  { caseNumber: "2026-006", subject: "Vehicle Inspection Lapse", citation: "10 NYCRR § 800.3", status: "closed", opened: daysFromToday(-40), note: "Resolved. Inspection completed; SOP reminder issued to fleet lead." },
];

function completenessColor(score) {
  if (score >= 90) return GREEN;
  if (score >= 70) return AMBER;
  return RED;
}

// What each completeness check failing means, in plain words.
const CHECK_TEXT = {
  has_vitals: "No vital signs recorded",
  has_disposition: "No disposition recorded",
  has_crew_signature: "No crew signature",
  transport_has_destination: "Transported, but no destination facility",
  refusal_has_signature: "Refusal without a refusal signature",
};

async function apiGet(baseUrl, token, path) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `HTTP ${res.status}`);
  return res.json();
}

// Signed in (`live`): only this company's real records, never sample data.
// "View demo" (or no session, as in tests): the illustrative sample.
export default function ComplianceConsole({ session }) {
  const live = session?.mode === "live";
  const [tab, setTab] = useState("certs");
  const [pcrs, setPcrs] = useState(live ? [] : demoPcrs);

  const apiBaseUrl = live ? session.apiBaseUrl : "";
  const apiToken = live ? session.token : "";
  const [connectionStatus, setConnectionStatus] = useState(live ? "connecting" : "demo"); // demo | connecting | live | failed
  const [loadError, setLoadError] = useState("");
  const [certs, setCerts] = useState(live ? [] : demoCerts);
  const [vehicles, setVehicles] = useState(live ? [] : demoVehicles);

  useEffect(() => {
    if (!apiBaseUrl || !apiToken) { setConnectionStatus("demo"); return; }
    let cancelled = false;
    setConnectionStatus("connecting");
    Promise.all([
      apiGet(apiBaseUrl, apiToken, "/certifications"),
      apiGet(apiBaseUrl, apiToken, "/vehicles"),
      // Review queue is for reviewers only; other roles just don't get one.
      apiGet(apiBaseUrl, apiToken, "/pcr-review").catch(() => []),
    ])
      .then(([apiCerts, apiVehicles, apiPcrs]) => {
        if (cancelled) return;
        setPcrs(apiPcrs.map((p) => {
          const total = Number(p.total) || 1;
          return {
            id: p.pcr_id, status: "pending", incidentRef: `${p.scene_address}`, crew: new Date(p.created_at).toLocaleString(),
            completeness: Math.round((Number(p.passed) / total) * 100),
            flags: (p.failed || []).map((f) => CHECK_TEXT[f] || f),
          };
        }));
        setCerts(apiCerts.map((c) => ({ id: c.certification_id, crewMember: `${c.first_name} ${c.last_name}`, certType: c.cert_type, expiresOn: new Date(c.expires_on) })));
        setVehicles(apiVehicles.map((v) => ({ id: v.vehicle_id, unit: v.unit_designation, inspectionDue: v.next_inspection_due ? new Date(v.next_inspection_due) : null })));
        setConnectionStatus("live");
      })
      .catch((e) => { if (!cancelled) { setConnectionStatus("failed"); setLoadError(e.message || "Could not load"); } });
    return () => { cancelled = true; };
  }, [apiBaseUrl, apiToken]);

  const certAlerts = useMemo(
    () => [...certs].map((c) => ({ ...c, days: daysUntil(c.expiresOn), urgency: urgencyFor(daysUntil(c.expiresOn)) })).sort((a, b) => a.days - b.days),
    [certs]
  );
  const vehicleAlerts = useMemo(
    () => [...vehicles].filter((v) => v.inspectionDue).map((v) => ({ ...v, days: daysUntil(v.inspectionDue), urgency: urgencyFor(daysUntil(v.inspectionDue)) })).sort((a, b) => a.days - b.days),
    [vehicles]
  );

  const criticalCertCount = certAlerts.filter((c) => c.urgency === "critical").length;
  const criticalVehicleCount = vehicleAlerts.filter((v) => v.urgency === "critical").length;
  const pendingPcrCount = pcrs.filter((p) => p.status === "pending" || p.status === "flagged").length;
  const openCaseCount = investigations.filter((i) => i.status !== "closed").length;

  function handleApprove(id) { setPcrs((prev) => prev.map((p) => (p.id === id ? { ...p, status: "approved" } : p))); }
  function handleFlag(id) { setPcrs((prev) => prev.map((p) => (p.id === id ? { ...p, status: "flagged" } : p))); }
  const visiblePcrs = pcrs.filter((p) => p.status !== "approved");

  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }} className="min-h-screen w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        * { box-sizing: border-box; }
        select, button, input { font-family: inherit; }
        button:focus-visible { outline: 2px solid #4EA1F0; outline-offset: 1px; }
      `}</style>

      <div className="px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>Compliance Console</div>
            <div className="text-lg font-semibold">{live ? session.agency : "Citywide Mobile Response"}</div>
          </div>
          <div className="flex items-center gap-2">
            <ConnectionBadge status={connectionStatus} />
          </div>
        </div>
        <div className="flex gap-2 mt-3 flex-wrap">
          <StatPill label="Certs Critical" value={criticalCertCount} color={RED} />
          <StatPill label="Vehicles Critical" value={criticalVehicleCount} color={RED} />
          <StatPill label="PCRs Pending" value={pendingPcrCount} color={AMBER} />
          {!live && <StatPill label="Open Cases" value={openCaseCount} color={BLUE} />}
        </div>
      </div>

      <div className="flex gap-1 px-4 pt-3 border-b" style={{ borderColor: HAIRLINE }}>
        <TabButton active={tab === "certs"} onClick={() => setTab("certs")} icon={ShieldAlert} label="Certs & Fleet" />
        <TabButton active={tab === "pcr"} onClick={() => setTab("pcr")} icon={CheckCircle2} label="PCR Review" />
        {!live && <TabButton active={tab === "investigations"} onClick={() => setTab("investigations")} icon={ClipboardList} label="Investigations" />}
      </div>

      <div className="p-4">
        {tab === "certs" && (
          <div className="flex flex-col gap-4">
            {!live && (
              <div className="text-xs px-3 py-2 rounded-md" style={{ color: TEXT_FAINT, backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}` }}>
                Demo data. Sign in to see your own company's records.
              </div>
            )}
            {live && connectionStatus === "failed" && <div className="text-xs" style={{ color: RED }}>Could not load: {loadError}</div>}
            {live && connectionStatus === "live" && certs.length === 0 && vehicles.length === 0 && (
              <div className="text-xs px-3 py-2 rounded-md" style={{ color: TEXT_SECONDARY, backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}` }}>
                Nothing here yet. This screen shows what a supervisor enters under Team: each person's certifications and expiry dates, and each vehicle's inspection due date.
              </div>
            )}
            <Panel title="CERTIFICATIONS">
              {certAlerts.map((c) => <UrgencyRow key={c.id} left={`${c.crewMember} — ${c.certType}`} urgency={c.urgency} right={formatDays(c.days)} />)}
            </Panel>
            <Panel title="VEHICLE INSPECTIONS">
              {vehicleAlerts.map((v) => <UrgencyRow key={v.id} left={v.unit} urgency={v.urgency} right={formatDays(v.days)} />)}
            </Panel>
          </div>
        )}

        {tab === "pcr" && (
          <div className="flex flex-col gap-3">
            <div className="text-xs px-3 py-2 rounded-md flex items-center gap-1.5" style={{ color: AMBER, backgroundColor: "rgba(245,166,35,0.08)", border: "1px solid #4A3A1E" }}>
              <AlertTriangle size={13} /> {live ? "Charts that crews have started and not yet finalized, checked against the completeness rules. Approve and flag aren't built yet." : "Demo data."}
            </div>
            <Panel title="PCR REVIEW QUEUE">
              {visiblePcrs.length === 0 && <div className="px-4 py-8 text-center text-sm" style={{ color: TEXT_FAINT }}>{live ? "No open charts." : "All charts reviewed."}</div>}
              {visiblePcrs.map((p) => (
                <div key={p.id} className="px-4 py-3 border-b" style={{ borderColor: "#1B2330" }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm truncate">{p.incidentRef}</div>
                      <div className="text-xs mt-0.5" style={{ color: TEXT_FAINT }}>{p.crew}</div>
                    </div>
                    <div className="mono text-sm font-semibold shrink-0" style={{ color: completenessColor(p.completeness) }}>{p.completeness}%</div>
                  </div>
                  {p.flags.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1">
                      {p.flags.map((f, idx) => <li key={idx} className="text-xs flex items-start gap-1.5" style={{ color: AMBER }}><AlertTriangle size={12} className="shrink-0 mt-0.5" /> {f}</li>)}
                    </ul>
                  )}
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    {p.status === "flagged" && <span className="text-xs px-1.5 py-0.5 rounded" style={{ color: AMBER, backgroundColor: "rgba(245,147,58,0.1)" }}>Flagged — awaiting crew correction</span>}
                    {!live && <button onClick={() => handleApprove(p.id)} className="text-xs px-2 py-1 rounded font-medium" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>Approve</button>}
                    {!live && p.status !== "flagged" && <button onClick={() => handleFlag(p.id)} className="text-xs px-2 py-1 rounded" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY }}>Flag for Correction</button>}
                  </div>
                </div>
              ))}
            </Panel>
          </div>
        )}

        {tab === "investigations" && (
          <div className="flex flex-col gap-3">
            <div className="text-xs px-3 py-2 rounded-md flex items-center gap-1.5" style={{ color: RED, backgroundColor: "rgba(240,85,74,0.08)", border: "1px solid #4A2A26" }}>
              <AlertTriangle size={13} /> Demo data — unlike Certs & Fleet, this isn't a missing route. There's no investigations table anywhere in this project's schema yet; this tab has been illustrative from the start.
            </div>
            <Panel title="INVESTIGATION CASES">
              {investigations.map((inv) => (
                <div key={inv.caseNumber} className="px-4 py-3 border-b" style={{ borderColor: "#1B2330" }}>
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="mono text-xs" style={{ color: TEXT_FAINT }}>#{inv.caseNumber}</span>
                        <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={{ color: CASE_STATUS[inv.status].color, backgroundColor: "rgba(255,255,255,0.04)" }}>{CASE_STATUS[inv.status].label.toUpperCase()}</span>
                      </div>
                      <div className="text-sm mt-1">{inv.subject}</div>
                      <div className="text-xs mt-0.5 mono" style={{ color: TEXT_SECONDARY }}>{inv.citation}</div>
                    </div>
                  </div>
                  <div className="text-sm mt-2" style={{ color: TEXT_SECONDARY }}>{inv.note}</div>
                </div>
              ))}
            </Panel>
          </div>
        )}
      </div>

    </div>
  );
}

function ConnectionBadge({ status }) {
  const cfg = {
    demo: { icon: WifiOff, color: TEXT_FAINT, label: "Demo Data" },
    connecting: { icon: Wifi, color: AMBER, label: "Connecting…" },
    live: { icon: Wifi, color: GREEN, label: "Live" },
    failed: { icon: WifiOff, color: RED, label: "Connection Failed" },
  }[status];
  const Icon = cfg.icon;
  return <div className="flex items-center gap-1 text-xs px-2 py-1 rounded" style={{ color: cfg.color, border: `1px solid ${HAIRLINE}` }}><Icon size={12} /> {cfg.label}</div>;
}

function StatPill({ label, value, color }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md" style={{ backgroundColor: PANEL, border: `1px solid ${HAIRLINE}` }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }}></span>
      <span className="text-xs" style={{ color: TEXT_SECONDARY }}>{label}</span>
      <span className="mono text-xs font-semibold">{value}</span>
    </div>
  );
}
function TabButton({ active, onClick, icon: Icon, label }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-t-md" style={{ color: active ? TEXT_PRIMARY : TEXT_FAINT, backgroundColor: active ? PANEL : "transparent", borderBottom: active ? "2px solid #4EA1F0" : "2px solid transparent" }}>
      <Icon size={14} /> {label}
    </button>
  );
}
function Panel({ title, children }) {
  return (
    <div className="rounded-lg border" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
      <div className="px-4 py-3 border-b text-sm font-semibold tracking-wide" style={{ borderColor: HAIRLINE }}>{title}</div>
      <div>{children}</div>
    </div>
  );
}
function UrgencyRow({ left, urgency, right }) {
  const cfg = URGENCY[urgency];
  return (
    <div className="px-4 py-2.5 flex items-center justify-between gap-2 border-b" style={{ borderColor: "#1B2330" }}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: cfg.color }}></span>
        <span className="text-sm truncate">{left}</span>
      </div>
      <span className="mono text-xs shrink-0" style={{ color: cfg.color }}>{right}</span>
    </div>
  );
}
