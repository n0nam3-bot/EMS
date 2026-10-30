import React, { useState, useRef, useEffect, useCallback } from "react";
import { Navigation, MapPin, Play, Square, ExternalLink, AlertTriangle, Wifi, WifiOff } from "lucide-react";

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

// Demo only. Signed in, the call comes from the server.
const DEMO_ASSIGNMENT = { address: "Bruckner Expwy & Longwood Ave", lat: 40.816, lon: -73.896, priority: "critical" };

const PRIORITY = { critical: ["Critical", RED], emergent: ["Emergent", "#F5934A"], urgent: ["Urgent", "#F5C542"], routine: ["Routine", TEXT_SECONDARY] };
const STATUS_STEPS = [
  ["en_route", "En route"],
  ["on_scene", "On scene"],
  ["transporting", "Transporting"],
  ["at_destination", "At destination"],
  ["available", "Available"],
];
const STATUS_LABEL = { available: "Available", assigned: "Assigned", en_route: "En route", on_scene: "On scene", transporting: "Transporting", at_destination: "At destination", out_of_service: "Out of service" };

// Reporting more often than this is wasteful: watchPosition can fire every
// few seconds while moving.
const MIN_REPORT_INTERVAL_MS = 10000;

// Coordinates when the call has them; otherwise the address text, so the
// navigation app can look it up itself.
function navUrl(app, place) {
  const hasCoords = place.lat != null && place.lon != null;
  const dest = hasCoords ? `${place.lat},${place.lon}` : encodeURIComponent(place.text || "");
  if (app === "google") return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
  if (app === "apple") return `https://maps.apple.com/?daddr=${dest}&dirflg=d`;
  if (app === "waze") return hasCoords ? `https://waze.com/ul?ll=${dest}&navigate=yes` : `https://waze.com/ul?q=${dest}&navigate=yes`;
  return "#";
}
const NAV_APPS = [{ key: "google", label: "Google Maps" }, { key: "apple", label: "Apple Maps" }, { key: "waze", label: "Waze" }];
const formatClock = (d) => d.toLocaleTimeString("en-US", { hour12: false });

async function api(session, method, path, body) {
  const res = await fetch(`${session.apiBaseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export default function FieldUnitConsole({ session }) {
  const live = session?.mode === "live";
  const [tracking, setTracking] = useState(false);
  const [position, setPosition] = useState(null);
  const [error, setError] = useState("");
  const [reportStatus, setReportStatus] = useState("demo"); // demo | reporting | failed
  const watchIdRef = useRef(null);
  const lastReportedAtRef = useRef(0);

  // Signed in: who am I, which unit am I on, what call is it on. Nobody types
  // a unit ID; it comes from the crew assignment a supervisor set up.
  const [me, setMe] = useState(null); // { unit, incident }
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api(session, "GET", "/auth/me");
      setMe({ unit: data.unit, incident: data.incident });
      setLoadError("");
    } catch (e) {
      setLoadError(e.message || "Could not load");
    }
  }, [session]);

  useEffect(() => {
    if (!live) return;
    refresh();
    const t = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 10000);
    return () => clearInterval(t);
  }, [live, refresh]);

  useEffect(() => () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current); }, []);

  const unit = me?.unit || null;
  const incident = me?.incident || null;
  const canReport = live && Boolean(unit);

  async function setStatus(status) {
    setBusy(true);
    try {
      await api(session, "PATCH", `/units/${unit.unit_id}/status`, { status });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function reportToBackend(p) {
    try {
      await api(session, "PATCH", `/units/${unit.unit_id}/location`, { lat: p.lat, lon: p.lon, headingDeg: p.headingDeg, speedMph: p.speedMph, accuracyM: p.accuracyM });
      setReportStatus("reporting");
    } catch (e) {
      setReportStatus("failed");
    }
  }

  function startTracking() {
    if (!navigator.geolocation) { setError("Location isn't available on this device or browser."); return; }
    setError("");
    setTracking(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const p = { lat: pos.coords.latitude, lon: pos.coords.longitude, headingDeg: pos.coords.heading, speedMph: pos.coords.speed != null ? pos.coords.speed * 2.237 : null, accuracyM: pos.coords.accuracy, at: new Date() };
        setPosition(p);
        if (canReport && Date.now() - lastReportedAtRef.current >= MIN_REPORT_INTERVAL_MS) {
          lastReportedAtRef.current = Date.now();
          reportToBackend(p);
        }
      },
      (err) => { setError(err.message || "Location request failed or was denied."); setTracking(false); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
  }
  function stopTracking() {
    if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    watchIdRef.current = null;
    setTracking(false);
    setReportStatus("demo");
  }

  const card = { backgroundColor: PANEL, borderColor: HAIRLINE };
  const title = live ? (unit ? unit.unit_designation : "No unit") : "Unit — En Route";

  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }} className="min-h-screen w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        * { box-sizing: border-box; }
        button, input, textarea { font-family: inherit; }
        button:focus-visible, input:focus-visible { outline: 2px solid #4EA1F0; outline-offset: 1px; }
      `}</style>

      <div className="px-4 py-3 border-b flex items-center justify-between gap-2" style={{ borderColor: HAIRLINE }}>
        <div>
          <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>Field Unit{live && unit ? ` · ${unit.capability_level}` : ""}</div>
          <div className="text-lg font-semibold">{title}</div>
        </div>
        {live && unit && (
          <div className="text-xs px-2 py-1 rounded" style={{ border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY }}>
            {STATUS_LABEL[unit.current_status] || unit.current_status}{unit.seat_role ? ` · ${unit.seat_role === "driver" ? "Driver" : "Non-driver"}` : ""}
          </div>
        )}
      </div>

      <div className="p-4 flex flex-col gap-3" style={{ maxWidth: "640px" }}>
        {live && loadError && <div className="text-sm" style={{ color: RED }}>Could not load your unit: {loadError}</div>}
        {live && !loadError && me === null && <div className="text-sm" style={{ color: TEXT_FAINT }}>Loading…</div>}

        {live && me && !unit && (
          <div className="rounded-lg border p-4 text-sm" style={card}>
            <div className="font-semibold mb-1">You aren't on a unit yet.</div>
            <div style={{ color: TEXT_SECONDARY }}>A supervisor puts you on a unit under <b>Team</b>. Until then this screen can't send your location or show your calls.</div>
          </div>
        )}

        {/* Demo assignment */}
        {!live && (
          <div className="rounded-lg border p-4" style={card}>
            <div className="text-xs tracking-wide font-semibold mb-2" style={{ color: TEXT_SECONDARY }}>ASSIGNED TRANSPORT</div>
            <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={{ color: RED, backgroundColor: "rgba(255,255,255,0.04)" }}>CRITICAL</span>
            <div className="text-base mt-1">{DEMO_ASSIGNMENT.address}</div>
            <NavButtons place={{ lat: DEMO_ASSIGNMENT.lat, lon: DEMO_ASSIGNMENT.lon, text: DEMO_ASSIGNMENT.address }} label="Navigate to scene" />
          </div>
        )}

        {/* Live assignment */}
        {live && unit && (
          <div className="rounded-lg border p-4" style={card}>
            <div className="text-xs tracking-wide font-semibold mb-2" style={{ color: TEXT_SECONDARY }}>ASSIGNED CALL</div>
            {!incident ? (
              <div className="text-sm" style={{ color: TEXT_FAINT }}>No call right now. You'll see it here the moment dispatch assigns your unit.</div>
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={{ color: (PRIORITY[incident.priority] || [])[1], backgroundColor: "rgba(255,255,255,0.04)" }}>{((PRIORITY[incident.priority] || [incident.priority])[0] || "").toUpperCase()}</span>
                  <span className="text-xs" style={{ color: TEXT_FAINT }}>{incident.capability_needed} · {incident.role === "primary" ? "Primary" : incident.role === "support" ? "Support" : "ALS intercept"}</span>
                </div>
                <div className="text-base mt-1 font-medium">{incident.scene_address}</div>
                {incident.scene_detail && <div className="text-sm" style={{ color: TEXT_SECONDARY }}>{incident.scene_detail}</div>}
                <NavButtons place={{ lat: incident.lat, lon: incident.lon, text: incident.scene_address }} label="Navigate to pickup" />
                {incident.destination_text && (
                  <div className="mt-3 pt-3 border-t" style={{ borderColor: HAIRLINE }}>
                    <div className="text-xs" style={{ color: TEXT_FAINT }}>DESTINATION</div>
                    <div className="text-sm font-medium">{incident.destination_text}</div>
                    <NavButtons place={{ lat: incident.dest_lat, lon: incident.dest_lon, text: incident.destination_text }} label="Navigate to destination" />
                  </div>
                )}
                {(incident.patient_name || incident.contact_name || incident.contact_phone || incident.notes) && (
                  <div className="mt-3 pt-3 border-t text-sm flex flex-col gap-0.5" style={{ borderColor: HAIRLINE, color: TEXT_SECONDARY }}>
                    {incident.patient_name && <div>Patient: {incident.patient_name}</div>}
                    {(incident.contact_name || incident.contact_phone) && (
                      <div>Contact: {incident.contact_name} {incident.contact_phone && <a href={`tel:${incident.contact_phone}`} style={{ color: BLUE }}>{incident.contact_phone}</a>}</div>
                    )}
                    {incident.notes && <div>Notes: {incident.notes}</div>}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Status buttons */}
        {live && unit && (
          <div className="rounded-lg border p-4" style={card}>
            <div className="text-xs tracking-wide font-semibold mb-2" style={{ color: TEXT_SECONDARY }}>MY STATUS</div>
            <div className="grid grid-cols-2 gap-2">
              {STATUS_STEPS.map(([key, label]) => {
                const on = unit.current_status === key;
                return (
                  <button key={key} disabled={busy} onClick={() => setStatus(key)} className="rounded-md text-sm font-medium"
                    style={{ minHeight: "48px", backgroundColor: on ? "#1E3A2E" : SUNKEN, border: `1px solid ${on ? "#2E5943" : HAIRLINE}`, color: on ? GREEN : TEXT_PRIMARY }}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* GPS */}
        {(!live || unit) && (
          <div className="rounded-lg border p-4" style={card}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs tracking-wide font-semibold" style={{ color: TEXT_SECONDARY }}>LOCATION</div>
              <ReportBadge status={reportStatus} live={canReport} />
            </div>
            {!tracking ? (
              <button onClick={startTracking} className="w-full flex items-center justify-center gap-2 rounded-md text-sm font-medium" style={{ minHeight: "48px", backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>
                <Play size={16} /> {canReport ? "Share my location with dispatch" : "Start location tracking"}
              </button>
            ) : (
              <button onClick={stopTracking} className="w-full flex items-center justify-center gap-2 rounded-md text-sm font-medium" style={{ minHeight: "48px", backgroundColor: "#3A1E1E", border: "1px solid #593434", color: "#F0857D" }}>
                <Square size={16} /> Stop
              </button>
            )}
            {error && <div className="mt-2 text-xs flex items-center gap-1" style={{ color: RED }}><AlertTriangle size={12} /> {error}</div>}
            {position && (
              <div className="mt-3 text-xs mono flex flex-col gap-0.5" style={{ color: TEXT_SECONDARY }}>
                <div className="flex items-center gap-1"><MapPin size={12} /> {position.lat.toFixed(5)}, {position.lon.toFixed(5)}</div>
                <div>±{Math.round(position.accuracyM)} m · {formatClock(position.at)}</div>
              </div>
            )}
            <div className="mt-3 text-xs" style={{ color: TEXT_FAINT }}>
              {canReport ? "Your position appears on the dispatch map for your unit, updated about every 10 seconds, only while this is on and this page is open." : "Demo: your position stays on this device."}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function NavButtons({ place, label }) {
  return (
    <div className="mt-3">
      <div className="text-xs mb-1.5 flex items-center gap-1" style={{ color: TEXT_FAINT }}><Navigation size={12} /> {label}</div>
      <div className="flex gap-2 flex-wrap">
        {NAV_APPS.map((app) => (
          <a key={app.key} href={navUrl(app.key, place)} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-sm rounded-md px-3" style={{ minHeight: "44px", backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: BLUE, textDecoration: "none" }}>
            {app.label} <ExternalLink size={12} />
          </a>
        ))}
      </div>
    </div>
  );
}

function ReportBadge({ status, live }) {
  const cfg = !live
    ? { icon: WifiOff, color: TEXT_FAINT, label: "Local only" }
    : status === "reporting" ? { icon: Wifi, color: GREEN, label: "Sending to dispatch" }
    : status === "failed" ? { icon: WifiOff, color: RED, label: "Send failed" }
    : { icon: Wifi, color: TEXT_SECONDARY, label: "Ready" };
  const Icon = cfg.icon;
  return <div className="flex items-center gap-1 text-xs px-2 py-1 rounded" style={{ color: cfg.color, border: `1px solid ${HAIRLINE}` }}><Icon size={12} /> {cfg.label}</div>;
}
