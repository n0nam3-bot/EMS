import React, { useState, useRef, useEffect } from "react";
import { Navigation, MapPin, Play, Square, ExternalLink, AlertTriangle, Settings, X, Wifi, WifiOff } from "lucide-react";

const HAIRLINE = "#232C3A";
const PANEL = "#131A24";
const VOID = "#0A0E13";
const SUNKEN = "#0D131B";
const TEXT_PRIMARY = "#E7ECF2";
const TEXT_SECONDARY = "#8593A3";
const TEXT_FAINT = "#57647A";
const GREEN = "#34D399";
const RED = "#F0554A";
const AMBER = "#F5934A";
const BLUE = "#4EA1F0";

const ASSIGNMENT = { address: "Bruckner Expwy & Longwood Ave", lat: 40.816, lon: -73.896, priority: "Critical" };

// Reporting more often than this is wasteful — watchPosition can fire
// every few seconds while moving, and backend_routes_location.js's own
// comments named this as a real gap when the endpoint was first built.
// This is that gap actually closed, not just noted again.
const MIN_REPORT_INTERVAL_MS = 10000;

function navUrl(app, lat, lon) {
  if (app === "google") return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
  if (app === "apple") return `https://maps.apple.com/?daddr=${lat},${lon}&dirflg=d`;
  if (app === "waze") return `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;
  return "#";
}
function formatClock(d) {
  return d.toLocaleTimeString("en-US", { hour12: false });
}
function inputLikeStyle() {
  return { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}` };
}

export default function FieldUnitConsole() {
  const [tracking, setTracking] = useState(false);
  const [position, setPosition] = useState(null);
  const [error, setError] = useState("");
  const [log, setLog] = useState([]);
  const watchIdRef = useRef(null);
  const lastReportedAtRef = useRef(0);

  const [showSettings, setShowSettings] = useState(false);
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [unitId, setUnitId] = useState("");
  const [reportStatus, setReportStatus] = useState("demo"); // demo | reporting | failed

  useEffect(() => {
    return () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current); };
  }, []);

  const isConfigured = Boolean(apiBaseUrl && apiToken && unitId);

  async function reportToBackend(p) {
    try {
      const res = await fetch(`${apiBaseUrl}/units/${unitId}/location`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
        body: JSON.stringify({ lat: p.lat, lon: p.lon, headingDeg: p.headingDeg, speedMph: p.speedMph, accuracyM: p.accuracyM }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReportStatus("reporting");
    } catch (e) {
      setReportStatus("failed");
    }
  }

  function startTracking() {
    if (!navigator.geolocation) {
      setError("Geolocation isn't available on this device or browser.");
      return;
    }
    setError("");
    setTracking(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const p = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          headingDeg: pos.coords.heading,
          speedMph: pos.coords.speed != null ? pos.coords.speed * 2.237 : null,
          accuracyM: pos.coords.accuracy,
          at: new Date(),
        };
        setPosition(p);
        setLog((prev) => [p, ...prev].slice(0, 6));

        if (isConfigured) {
          const nowMs = Date.now();
          if (nowMs - lastReportedAtRef.current >= MIN_REPORT_INTERVAL_MS) {
            lastReportedAtRef.current = nowMs;
            reportToBackend(p);
          }
        }
      },
      (err) => {
        setError(err.message || "Location request failed or was denied.");
        setTracking(false);
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
  }

  function stopTracking() {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = null;
    setTracking(false);
    setReportStatus(isConfigured ? "demo" : "demo");
  }

  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }} className="min-h-screen w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        * { box-sizing: border-box; }
        button, input, textarea { font-family: inherit; }
        button:focus-visible, input:focus-visible { outline: 2px solid #4EA1F0; outline-offset: 1px; }
      `}</style>

      <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: HAIRLINE }}>
        <div>
          <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>Field Unit</div>
          <div className="text-lg font-semibold">{unitId ? `Unit ${unitId.slice(0, 8)}` : "Unit — En Route"}</div>
        </div>
        <button onClick={() => setShowSettings(true)} className="flex items-center gap-1 text-xs px-2 py-1 rounded" style={{ color: TEXT_FAINT, border: `1px solid ${HAIRLINE}` }}>
          <Settings size={13} /> API
        </button>
      </div>

      <div className="p-4 flex flex-col gap-3">
        <div className="rounded-lg border p-4" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
          <div className="text-xs font-semibold tracking-wide mb-1" style={{ color: TEXT_FAINT }}>ASSIGNED TRANSPORT</div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={{ color: RED, backgroundColor: "rgba(255,255,255,0.04)" }}>{ASSIGNMENT.priority.toUpperCase()}</span>
          </div>
          <div className="text-base mt-1">{ASSIGNMENT.address}</div>
          <div className="flex flex-wrap gap-2 mt-3">
            {[{ key: "google", label: "Google Maps" }, { key: "apple", label: "Apple Maps" }, { key: "waze", label: "Waze" }].map((app) => (
              <a key={app.key} href={navUrl(app.key, ASSIGNMENT.lat, ASSIGNMENT.lon)} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm font-medium rounded-md px-3 py-2"
                style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN, textDecoration: "none" }}>
                <Navigation size={14} /> {app.label} <ExternalLink size={12} />
              </a>
            ))}
          </div>
          <div className="text-xs mt-2" style={{ color: TEXT_FAINT }}>
            Real deep links — on an actual phone these open real turn-by-turn navigation.
          </div>
        </div>

        <div className="rounded-lg border p-4" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold tracking-wide" style={{ color: TEXT_FAINT }}>LOCATION REPORTING</div>
            <ReportBadge status={tracking ? reportStatus : "idle"} configured={isConfigured} />
          </div>

          {!tracking ? (
            <button onClick={startTracking} className="w-full flex items-center justify-center gap-1.5 text-sm font-medium rounded-md px-3 py-2.5" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>
              <Play size={14} /> Start Reporting Location
            </button>
          ) : (
            <button onClick={stopTracking} className="w-full flex items-center justify-center gap-1.5 text-sm font-medium rounded-md px-3 py-2.5" style={{ backgroundColor: "#3A1E1E", border: "1px solid #593434", color: "#F0857D" }}>
              <Square size={14} /> Stop Reporting
            </button>
          )}

          {!isConfigured && (
            <div className="text-xs mt-2" style={{ color: TEXT_FAINT }}>
              No backend connected (tap API above) — GPS still tracks live below, just isn't sent anywhere.
            </div>
          )}

          {error && (
            <div className="text-xs mt-2 px-3 py-2 rounded-md flex items-center gap-1.5" style={{ color: RED, backgroundColor: "rgba(240,85,74,0.1)", border: "1px solid #593434" }}>
              <AlertTriangle size={13} /> {error}
            </div>
          )}

          {position && (
            <div className="mt-3 rounded-md p-3" style={inputLikeStyle()}>
              <div className="flex items-center gap-1.5 text-xs mb-1" style={{ color: GREEN }}>
                <MapPin size={12} /> Live position, updated {formatClock(position.at)}
              </div>
              <div className="text-sm mono">{position.lat.toFixed(5)}, {position.lon.toFixed(5)}</div>
              <div className="text-xs mt-1" style={{ color: TEXT_FAINT }}>
                Accuracy ±{Math.round(position.accuracyM)}m{position.speedMph != null && ` · ${position.speedMph.toFixed(0)} mph`}
              </div>
            </div>
          )}

          <div className="text-xs mt-2" style={{ color: TEXT_FAINT }}>
            Real GPS from your own device. When connected, reports PATCH to <span className="mono">/units/:id/location</span> at most every {MIN_REPORT_INTERVAL_MS / 1000}s — every watchPosition update refreshes the display above, not every one gets sent over the network.
          </div>

          {log.length > 0 && (
            <div className="mt-3">
              <div className="text-xs font-semibold tracking-wide mb-1" style={{ color: TEXT_FAINT }}>RECENT READINGS (DISPLAY ONLY)</div>
              <div className="flex flex-col gap-1">
                {log.map((p, i) => <div key={i} className="text-xs mono" style={{ color: TEXT_SECONDARY }}>{formatClock(p.at)} — {p.lat.toFixed(5)}, {p.lon.toFixed(5)}</div>)}
              </div>
            </div>
          )}
        </div>
      </div>

      {showSettings && (
        <SettingsModal
          apiBaseUrl={apiBaseUrl} setApiBaseUrl={setApiBaseUrl}
          apiToken={apiToken} setApiToken={setApiToken}
          unitId={unitId} setUnitId={setUnitId}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

function ReportBadge({ status, configured }) {
  if (!configured) return (
    <div className="flex items-center gap-1 text-xs px-2 py-1 rounded" style={{ color: TEXT_FAINT, border: `1px solid ${HAIRLINE}` }}><WifiOff size={12} /> Demo</div>
  );
  const cfg = {
    idle: { icon: WifiOff, color: TEXT_FAINT, label: "Not tracking" },
    reporting: { icon: Wifi, color: GREEN, label: "Reporting live" },
    failed: { icon: WifiOff, color: RED, label: "Report failed" },
  }[status] || { icon: WifiOff, color: TEXT_FAINT, label: "Idle" };
  const Icon = cfg.icon;
  return <div className="flex items-center gap-1 text-xs px-2 py-1 rounded" style={{ color: cfg.color, border: `1px solid ${HAIRLINE}` }}><Icon size={12} /> {cfg.label}</div>;
}

function SettingsModal({ apiBaseUrl, setApiBaseUrl, apiToken, setApiToken, unitId, setUnitId, onClose }) {
  const [draftUrl, setDraftUrl] = useState(apiBaseUrl);
  const [draftToken, setDraftToken] = useState(apiToken);
  const [draftUnitId, setDraftUnitId] = useState(unitId);
  return (
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.6)", zIndex: 50 }}>
      <div className="w-full rounded-lg border" style={{ maxWidth: "420px", backgroundColor: PANEL, borderColor: HAIRLINE }}>
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
          <div className="text-sm font-semibold">Backend Connection</div>
          <button onClick={onClose} style={{ color: TEXT_SECONDARY }}><X size={18} /></button>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <div className="text-xs" style={{ color: TEXT_FAINT }}>
            Leave blank to keep GPS display-only. All three are required to actually report location — this is a dev-testing shortcut (pasted token, typed unit ID), not how a real crew would sign in.
          </div>
          <div>
            <label className="text-xs block mb-1" style={{ color: TEXT_SECONDARY }}>API Base URL</label>
            <input value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)} placeholder="https://your-deployed-api.example.com/api" className="w-full text-sm rounded px-2 py-1.5" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY }} />
          </div>
          <div>
            <label className="text-xs block mb-1" style={{ color: TEXT_SECONDARY }}>Unit ID</label>
            <input value={draftUnitId} onChange={(e) => setDraftUnitId(e.target.value)} placeholder="UUID of this unit in the database" className="w-full text-sm rounded px-2 py-1.5 mono" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY }} />
          </div>
          <div>
            <label className="text-xs block mb-1" style={{ color: TEXT_SECONDARY }}>Session Token (JWT)</label>
            <textarea value={draftToken} onChange={(e) => setDraftToken(e.target.value)} rows={3} placeholder="Paste a token for a user assigned to this unit" className="w-full text-xs rounded px-2 py-1.5 mono" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY, resize: "vertical" }} />
          </div>
          <div className="flex gap-2">
            <button onClick={() => { setDraftUrl(""); setDraftToken(""); setDraftUnitId(""); setApiBaseUrl(""); setApiToken(""); setUnitId(""); }} className="text-xs px-3 py-2 rounded" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY }}>
              Clear
            </button>
            <button onClick={() => { setApiBaseUrl(draftUrl.trim()); setApiToken(draftToken.trim()); setUnitId(draftUnitId.trim()); }} className="flex-1 text-sm font-medium rounded px-3 py-2" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
