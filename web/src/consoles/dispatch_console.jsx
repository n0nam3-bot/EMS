import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  CheckCircle2,
  Navigation,
  MapPin,
  Truck,
  XCircle,
  Plus,
  X,
  Radio,
  Activity,
  AlertTriangle,
  Settings,
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
const BLUE = "#4EA1F0";
const AMBER = "#F5934A";
const GREEN = "#34D399";
const RED = "#F0554A";

const MAP_BOUNDS = { latMin: 40.795, latMax: 40.90, lonMin: -73.945, lonMax: -73.835 };

const STATUS_CONFIG = {
  available: { label: "Available", color: "#34D399", icon: CheckCircle2 },
  assigned: { label: "Assigned", color: "#F5A623", icon: Radio },
  en_route: { label: "En Route", color: "#F0862B", icon: Navigation },
  on_scene: { label: "On Scene", color: "#4EA1F0", icon: MapPin },
  transporting: { label: "Transporting", color: "#6C7FF0", icon: Truck },
  at_destination: { label: "At Destination", color: "#5EEAD4", icon: Activity },
  out_of_service: { label: "Out of Service", color: "#55627A", icon: XCircle },
};

const PRIORITY_CONFIG = {
  critical: { label: "Critical", color: "#F0554A", targetMin: 8, rank: 0 },
  emergent: { label: "Emergent", color: "#F5934A", targetMin: 12, rank: 1 },
  urgent: { label: "Urgent", color: "#EAC54F", targetMin: 20, rank: 2 },
  routine: { label: "Routine", color: "#6B7A90", targetMin: 60, rank: 3 },
};

// Matches the schema's actual incident_type enum — "911" alone was
// the frontend's own shorthand and never matched what the database
// accepts, caught only once real wiring made that mismatch load-bearing.
const TYPE_LABELS = {
  emergency_911: "911 Emergency",
  ift_scheduled: "IFT — Scheduled",
  ift_on_demand: "IFT — On Demand",
};

const ROLE_LABELS = { primary: "Primary", als_intercept: "ALS Intercept", support: "Support" };
const CREW_LABELS = { driver: "Driver", non_driver: "Non-Driver" };

// ---- Geography helpers -------------------------------------------------
function haversineMiles(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function estimateEtaMinutes(miles) {
  const roadFactor = 1.3;
  const avgSpeedMph = 25;
  return ((miles * roadFactor) / avgSpeedMph) * 60;
}
function project(lat, lon) {
  const x = ((lon - MAP_BOUNDS.lonMin) / (MAP_BOUNDS.lonMax - MAP_BOUNDS.lonMin)) * 100;
  const y = (1 - (lat - MAP_BOUNDS.latMin) / (MAP_BOUNDS.latMax - MAP_BOUNDS.latMin)) * 100;
  return { x, y };
}
function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function fetchRoutedDistance(from, to) {
  const jitterMs = Math.random() * 600;
  return new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("routing request failed");
        const data = await res.json();
        if (data.code !== "Ok" || !data.routes?.[0]) throw new Error("no route returned");
        resolve({ miles: data.routes[0].distance / 1609.34, etaMin: data.routes[0].duration / 60 });
      } catch (e) {
        reject(e);
      }
    }, jitterMs);
  });
}
function useRoutedEta(unit, incident) {
  const [routed, setRouted] = useState(null);
  const [status, setStatus] = useState("idle");
  useEffect(() => {
    if (!unit || unit.lat == null || unit.lon == null || incident.lat == null || incident.lon == null) {
      setRouted(null);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    fetchRoutedDistance({ lat: unit.lat, lon: unit.lon }, { lat: incident.lat, lon: incident.lon })
      .then((r) => { if (!cancelled) { setRouted(r); setStatus("live"); } })
      .catch(() => { if (!cancelled) { setRouted(null); setStatus("fallback"); } });
    return () => { cancelled = true; };
  }, [unit?.id, incident.id]);
  return { routed, status };
}

// ---- Real API client ----------------------------------------------------
// Mirrors api-client.js exactly (that file is the tested, standalone
// version of this same logic) — inlined here because a single-file
// React artifact can't import a sibling module.
function makeApiRequest(baseUrl, token) {
  return async function request(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const error = new Error(data?.error || `Request failed with HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return data;
  };
}

function normalizeApiUnit(u) {
  return {
    id: u.unit_id,
    designation: u.unit_designation,
    capability: u.capability_level,
    crew: u.crew || [],
    status: u.current_status,
    lat: u.lat,
    lon: u.lon,
  };
}

// The schema has no capability_needed column on incidents at all —
// a real gap, not something a frontend normalizer can properly fix.
// This heuristic (critical/emergent implies ALS) is a stand-in, not a
// substitute for that column actually existing.
function inferCapabilityNeeded(apiIncident) {
  return apiIncident.priority === "critical" || apiIncident.priority === "emergent" ? "ALS" : "BLS";
}

function normalizeApiIncident(i) {
  return {
    id: i.incident_id,
    type: i.incident_type,
    priority: i.priority,
    address: i.scene_address,
    capabilityNeeded: inferCapabilityNeeded(i),
    callReceivedAt: new Date(i.call_received_at),
    // The API returns each incident's active assignments; this used to
    // be [] with a comment pointing at a loadAssignments function that
    // was never written, which broke the live loop after the first Assign.
    assignedUnits: (i.assigned_units || []).map((a) => ({ unitId: a.unitId, role: a.role })),
    lat: i.lat,
    lon: i.lon,
  };
}

function makeInitialUnits() {
  return [
    { id: "u1", designation: "Unit 3", capability: "BLS", crew: [{ employeeId: "4471", name: "Marcus Alvarez", role: "driver", cert: "EMT" }, { employeeId: "4502", name: "Emily Chen", role: "non_driver", cert: "EMT" }], status: "available", lat: 40.812, lon: -73.918 },
    { id: "u2", designation: "Unit 7", capability: "ALS", crew: [{ employeeId: "4318", name: "Priya Patel", role: "driver", cert: "EMT" }, { employeeId: "4390", name: "Kwame Osei", role: "non_driver", cert: "Medic" }], status: "en_route", lat: 40.848, lon: -73.879 },
    { id: "u3", designation: "Unit 12", capability: "BLS", crew: [{ employeeId: "4275", name: "Linh Nguyen", role: "driver", cert: "EMT" }, { employeeId: "4601", name: "Tyler Brooks", role: "non_driver", cert: "EMT" }], status: "on_scene", lat: 40.8625, lon: -73.8973 },
    { id: "u4", designation: "Unit 5", capability: "ALS", crew: [{ employeeId: "4188", name: "Fatou Diallo", role: "driver", cert: "Medic" }, { employeeId: "4529", name: "Sean Fitzgerald", role: "non_driver", cert: "EMT" }], status: "available", lat: 40.822, lon: -73.867 },
    { id: "u5", designation: "Unit 9", capability: "BLS", crew: [{ employeeId: "4356", name: "Carlos Reyes", role: "driver", cert: "EMT" }, { employeeId: "4442", name: "Daniel Cho", role: "non_driver", cert: "EMT" }], status: "transporting", lat: 40.858, lon: -73.851 },
    { id: "u6", designation: "Unit 14", capability: "ALS", crew: [{ employeeId: "4213", name: "Chidi Okafor", role: "driver", cert: "EMT" }, { employeeId: "4567", name: "Maria Santos", role: "non_driver", cert: "Medic" }], status: "available", lat: 40.849, lon: -73.86 },
    { id: "u7", designation: "Unit 2", capability: "BLS", crew: [], status: "out_of_service", lat: 40.812, lon: -73.886 },
    { id: "u8", designation: "Unit 21", capability: "ALS", crew: [{ employeeId: "4489", name: "Jason Kim", role: "driver", cert: "EMT" }, { employeeId: "4304", name: "Elena Vasquez", role: "non_driver", cert: "Medic" }], status: "at_destination", lat: 40.8804, lon: -73.8799 },
  ];
}

function makeInitialIncidents(nowMs) {
  return [
    { id: "i1", type: "emergency_911", priority: "critical", address: "Bruckner Expwy & Longwood Ave", capabilityNeeded: "ALS", callReceivedAt: new Date(nowMs - 3 * 60 * 1000), assignedUnits: [], lat: 40.816, lon: -73.896 },
    { id: "i2", type: "emergency_911", priority: "emergent", address: "Fordham Rd & Grand Concourse", capabilityNeeded: "BLS", callReceivedAt: new Date(nowMs - 6 * 60 * 1000), assignedUnits: [{ unitId: "u3", role: "primary" }], lat: 40.8625, lon: -73.8973 },
    { id: "i3", type: "ift_scheduled", priority: "routine", address: "Jacobi Medical Center → 233rd St residence", capabilityNeeded: "BLS", callReceivedAt: new Date(nowMs - 14 * 60 * 1000), assignedUnits: [], lat: 40.8566, lon: -73.8472 },
    { id: "i4", type: "ift_on_demand", priority: "urgent", address: "Montefiore Moses → SNF, Pelham Pkwy", capabilityNeeded: "BLS", callReceivedAt: new Date(nowMs - 9 * 60 * 1000), assignedUnits: [], lat: 40.8804, lon: -73.8799 },
    { id: "i5", type: "emergency_911", priority: "critical", address: "Westchester Ave & Southern Blvd", capabilityNeeded: "ALS", callReceivedAt: new Date(nowMs - 1 * 60 * 1000), assignedUnits: [{ unitId: "u2", role: "primary" }], lat: 40.822, lon: -73.891 },
  ];
}

function getRecommendation(incident, units) {
  const available = units.filter((u) => u.status === "available");
  if (available.length === 0) return null;
  const exact = incident.capabilityNeeded === "ALS" ? available.filter((u) => u.capability === "ALS") : available;
  const pool = exact.length > 0 ? exact : available;
  // Live data can lack coordinates: a unit that hasn't reported a GPS
  // fix, an incident that was never geocoded. Don't rank on NaN.
  const located = (o) => o.lat != null && o.lon != null;
  const ranked = located(incident) ? pool.filter(located) : [];
  const best = ranked.length > 0
    ? ranked.reduce((b, u) => (haversineMiles(u, incident) < haversineMiles(b, incident) ? u : b))
    : pool[0];
  const miles = located(incident) && located(best) ? haversineMiles(best, incident) : null;
  const hasPrimary = incident.assignedUnits.some((a) => a.role === "primary");
  let role = "support";
  if (!hasPrimary) {
    role = "primary";
  } else if (incident.capabilityNeeded === "ALS" && best.capability === "ALS") {
    const primaryAssignment = incident.assignedUnits.find((a) => a.role === "primary");
    const primaryUnit = units.find((u) => u.id === primaryAssignment?.unitId);
    if (primaryUnit && primaryUnit.capability === "BLS") role = "als_intercept";
  }
  return { unit: best, miles, etaMin: miles == null ? null : estimateEtaMinutes(miles), isMismatch: pool !== exact, role };
}

export default function DispatchConsole() {
  const [loaded, setLoaded] = useState(false);
  const [units, setUnits] = useState(makeInitialUnits);
  const [now, setNow] = useState(() => new Date());
  const [incidents, setIncidents] = useState(() => makeInitialIncidents(Date.now()));
  const [showNewCall, setShowNewCall] = useState(false);
  const [form, setForm] = useState({ type: "emergency_911", priority: "emergent", address: "", capabilityNeeded: "BLS" });

  const [showSettings, setShowSettings] = useState(false);
  const [apiBaseUrl, setApiBaseUrl] = useState(`${window.location.origin}/api`);
  const [apiToken, setApiToken] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("demo"); // demo | connecting | live | failed
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await window.storage.get("dispatch-console-state", false);
        if (!cancelled && res && res.value) {
          const parsed = JSON.parse(res.value);
          if (parsed.units) setUnits(parsed.units);
          if (parsed.incidents) {
            setIncidents(parsed.incidents.map((i) => ({ ...i, callReceivedAt: new Date(i.callReceivedAt), assignedUnits: i.assignedUnits || [] })));
          }
          if (parsed.apiBaseUrl) setApiBaseUrl(parsed.apiBaseUrl);
          if (parsed.apiToken) setApiToken(parsed.apiToken);
        }
      } catch (err) {
        // No saved session yet, or storage unavailable — keep defaults.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    window.storage.set("dispatch-console-state", JSON.stringify({ units, incidents, apiBaseUrl, apiToken }), false).catch(() => {});
  }, [units, incidents, apiBaseUrl, apiToken, loaded]);

  const apiRequest = useMemo(() => (apiBaseUrl ? makeApiRequest(apiBaseUrl, apiToken) : null), [apiBaseUrl, apiToken]);

  async function refreshFromApi() {
    if (!apiRequest) return;
    const [apiUnits, apiIncidents] = await Promise.all([apiRequest("GET", "/units"), apiRequest("GET", "/incidents")]);
    setUnits(apiUnits.map(normalizeApiUnit));
    setIncidents(apiIncidents.filter((i) => !i.closed_at).map(normalizeApiIncident));
  }

  useEffect(() => {
    if (!loaded) return;
    if (!apiBaseUrl || !apiToken) {
      setConnectionStatus("demo");
      return;
    }
    let cancelled = false;
    setConnectionStatus("connecting");
    refreshFromApi()
      .then(() => { if (!cancelled) setConnectionStatus("live"); })
      .catch((e) => { if (!cancelled) { setConnectionStatus("failed"); setActionError("Could not connect: " + (e.message || "network error")); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, apiBaseUrl, apiToken]);

  // The shared seam every write action goes through: call the real API
  // and reload canonical state on success, or fall back to a purely
  // local update when there's nothing to connect to. Deliberately does
  // NOT fall back silently on a failed API call while "live" — that
  // would make a failed action look like it succeeded.
  async function performAction(apiCall, localUpdate) {
    if (connectionStatus === "live" && apiRequest) {
      try {
        await apiCall();
        await refreshFromApi();
      } catch (e) {
        setActionError(e.message || "Action failed");
      }
    } else {
      localUpdate();
    }
  }

  const availableCount = units.filter((u) => u.status === "available").length;
  const activeIncidents = useMemo(
    () =>
      [...incidents].sort((a, b) => {
        const pr = PRIORITY_CONFIG[a.priority].rank - PRIORITY_CONFIG[b.priority].rank;
        return pr !== 0 ? pr : a.callReceivedAt - b.callReceivedAt;
      }),
    [incidents]
  );

  function handleStatusChange(unitId, newStatus) {
    performAction(
      () => apiRequest("PATCH", `/units/${unitId}/status`, { status: newStatus }),
      () => setUnits((prev) => prev.map((u) => (u.id === unitId ? { ...u, status: newStatus } : u)))
    );
  }
  function handleAssign(incidentId, unitId, role) {
    performAction(
      () => apiRequest("POST", `/incidents/${incidentId}/assignments`, { unitId, role }),
      () => {
        setIncidents((prev) => prev.map((i) => (i.id === incidentId ? { ...i, assignedUnits: [...i.assignedUnits, { unitId, role }] } : i)));
        setUnits((prev) => prev.map((u) => (u.id === unitId ? { ...u, status: "assigned" } : u)));
      }
    );
  }
  function handleRelease(incidentId, unitId) {
    performAction(
      () => apiRequest("DELETE", `/incidents/${incidentId}/assignments/${unitId}`),
      () => {
        setIncidents((prev) => prev.map((i) => (i.id === incidentId ? { ...i, assignedUnits: i.assignedUnits.filter((a) => a.unitId !== unitId) } : i)));
        setUnits((prev) => prev.map((u) => (u.id === unitId ? { ...u, status: "available" } : u)));
      }
    );
  }
  function handleComplete(incidentId) {
    performAction(
      () => apiRequest("POST", `/incidents/${incidentId}/complete`),
      () => {
        const incident = incidents.find((i) => i.id === incidentId);
        if (incident) {
          const unitIds = incident.assignedUnits.map((a) => a.unitId);
          setUnits((prev) => prev.map((u) => (unitIds.includes(u.id) ? { ...u, status: "available" } : u)));
        }
        setIncidents((prev) => prev.filter((i) => i.id !== incidentId));
      }
    );
  }
  function handleCreateIncident(e) {
    e.preventDefault();
    if (!form.address.trim()) return;
    performAction(
      // No coordinates sent in live mode: there is no geocoder, and
      // inventing a position for a real call would put fabricated data
      // in a real database. The call appears in the queue without a map
      // marker until real geocoding exists.
      () => apiRequest("POST", "/incidents", { incidentType: form.type, priority: form.priority, sceneAddress: form.address.trim() }),
      () => {
        // Demo mode only: a random spot in the service area so the map
        // has something to draw.
        const lat = MAP_BOUNDS.latMin + Math.random() * (MAP_BOUNDS.latMax - MAP_BOUNDS.latMin);
        const lon = MAP_BOUNDS.lonMin + Math.random() * (MAP_BOUNDS.lonMax - MAP_BOUNDS.lonMin);
        setIncidents((prev) => [
          ...prev,
          { id: `i${Date.now()}`, type: form.type, priority: form.priority, address: form.address.trim(), capabilityNeeded: form.capabilityNeeded, callReceivedAt: new Date(), assignedUnits: [], lat, lon },
        ]);
      }
    );
    setForm({ type: "emergency_911", priority: "emergent", address: "", capabilityNeeded: "BLS" });
    setShowNewCall(false);
  }
  function handleReset() {
    setUnits(makeInitialUnits());
    setIncidents(makeInitialIncidents(Date.now()));
  }

  if (!loaded) {
    return (
      <div style={{ backgroundColor: VOID, color: TEXT_SECONDARY }} className="min-h-screen w-full flex items-center justify-center text-sm">
        Loading console…
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: VOID, color: TEXT_PRIMARY, fontFamily: "'Inter', system-ui, -apple-system, sans-serif" }} className="min-h-screen w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
        * { box-sizing: border-box; }
        select, button, input { font-family: inherit; }
        button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #4EA1F0; outline-offset: 1px; }
        .leaflet-popup-content-wrapper, .leaflet-popup-tip { background: #131A24; color: #E7ECF2; }
        .leaflet-container { background: #0D131B; }
        .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(0.85) contrast(0.9); }
      `}</style>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
        <div>
          <div className="text-xs tracking-widest uppercase" style={{ color: TEXT_FAINT }}>Ops Console</div>
          <div className="text-lg font-semibold">Citywide Dispatch</div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="mono text-2xl">{now.toLocaleTimeString("en-US", { hour12: false })}</div>
          <div className="flex gap-2">
            <StatPill label="Available" value={`${availableCount}/${units.length}`} color="#34D399" />
            <StatPill label="Active" value={activeIncidents.length} color="#F5A623" />
          </div>
          <ConnectionBadge status={connectionStatus} />
          <button onClick={() => setShowSettings(true)} className="flex items-center gap-1 text-xs px-2 py-1 rounded" style={{ color: TEXT_FAINT, border: `1px solid ${HAIRLINE}` }}>
            <Settings size={13} /> API
          </button>
          <button onClick={handleReset} className="text-xs px-2 py-1 rounded" style={{ color: TEXT_FAINT, border: `1px solid ${HAIRLINE}` }}>
            Reset Demo
          </button>
        </div>
      </div>

      {actionError && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-md text-xs flex items-center justify-between" style={{ backgroundColor: "rgba(240,85,74,0.1)", border: "1px solid #593434", color: RED }}>
          <span className="flex items-center gap-1.5"><AlertTriangle size={13} /> {actionError}</span>
          <button onClick={() => setActionError("")} style={{ color: RED }}><X size={14} /></button>
        </div>
      )}

      <div className="px-4 pt-4">
        <LiveMap units={units} incidents={activeIncidents} />
      </div>

      <div className="p-4 flex flex-col md:grid md:grid-cols-5 gap-4">
        <div className="md:col-span-3 rounded-lg border" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
            <div className="text-sm font-semibold tracking-wide">TRANSPORT QUEUE</div>
            <button onClick={() => setShowNewCall(true)} className="flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-md" style={{ backgroundColor: SUNKEN, color: TEXT_PRIMARY, border: `1px solid ${HAIRLINE}` }}>
              <Plus size={14} /> New Call
            </button>
          </div>
          <div>
            {activeIncidents.length === 0 && (
              <div className="px-4 py-8 text-center text-sm" style={{ color: TEXT_FAINT }}>Queue clear. No active transports.</div>
            )}
            {activeIncidents.map((incident) => (
              <IncidentRow key={incident.id} incident={incident} now={now} units={units} onAssign={handleAssign} onRelease={handleRelease} onComplete={handleComplete} />
            ))}
          </div>
        </div>

        <div className="md:col-span-2 rounded-lg border" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
          <div className="px-4 py-3 border-b text-sm font-semibold tracking-wide" style={{ borderColor: HAIRLINE }}>UNIT BOARD</div>
          <div className="p-3 flex flex-col gap-2">
            {units.map((unit) => (
              <UnitCard key={unit.id} unit={unit} onStatusChange={handleStatusChange} />
            ))}
          </div>
        </div>
      </div>

      {showNewCall && <NewCallModal form={form} setForm={setForm} onSubmit={handleCreateIncident} onClose={() => setShowNewCall(false)} />}
      {showSettings && (
        <SettingsModal
          apiBaseUrl={apiBaseUrl} setApiBaseUrl={setApiBaseUrl}
          apiToken={apiToken} setApiToken={setApiToken}
          connectionStatus={connectionStatus}
          onClose={() => setShowSettings(false)}
        />
      )}
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
  return (
    <div className="flex items-center gap-1 text-xs px-2 py-1 rounded" style={{ color: cfg.color, border: `1px solid ${HAIRLINE}` }}>
      <Icon size={12} /> {cfg.label}
    </div>
  );
}

function SettingsModal({ apiBaseUrl, setApiBaseUrl, apiToken, setApiToken, connectionStatus, onClose }) {
  const [draftUrl, setDraftUrl] = useState(apiBaseUrl);
  const [draftToken, setDraftToken] = useState(apiToken);
  return (
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.6)", zIndex: 50 }}>
      <div className="w-full rounded-lg border" style={{ maxWidth: "420px", backgroundColor: PANEL, borderColor: HAIRLINE }}>
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
          <div className="text-sm font-semibold">Backend Connection</div>
          <button onClick={onClose} style={{ color: TEXT_SECONDARY }}><X size={18} /></button>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <div className="text-xs" style={{ color: TEXT_FAINT }}>
            Leave blank to keep using local demo data. Set both to connect to a real deployed backend — see backend_db.js / server.js for what "real" means here.
          </div>
          <div>
            <label className="text-xs block mb-1" style={{ color: TEXT_SECONDARY }}>API Base URL</label>
            <input value={draftUrl} onChange={(e) => setDraftUrl(e.target.value)} placeholder="https://your-deployed-api.example.com/api" className="w-full text-sm rounded px-2 py-1.5" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY }} />
          </div>
          <div>
            <label className="text-xs block mb-1" style={{ color: TEXT_SECONDARY }}>Session Token (JWT)</label>
            <textarea value={draftToken} onChange={(e) => setDraftToken(e.target.value)} rows={3} placeholder="Paste a token issued by your identity provider" className="w-full text-xs rounded px-2 py-1.5 mono" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY, resize: "vertical" }} />
          </div>
          <div className="flex gap-2">
            <button onClick={() => { setDraftUrl(""); setDraftToken(""); setApiBaseUrl(""); setApiToken(""); }} className="text-xs px-3 py-2 rounded" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY }}>
              Use Demo Data
            </button>
            <button onClick={() => { setApiBaseUrl(draftUrl.trim()); setApiToken(draftToken.trim()); }} className="flex-1 text-sm font-medium rounded px-3 py-2" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>
              Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
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

function useLeafletLoader() {
  const [status, setStatus] = useState(() => (typeof window !== "undefined" && window.L ? "ready" : "loading"));
  useEffect(() => {
    if (window.L) { setStatus("ready"); return; }
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css";
    document.head.appendChild(css);
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js";
    script.async = true;
    script.onload = () => setStatus("ready");
    script.onerror = () => setStatus("failed");
    document.head.appendChild(script);
  }, []);
  return status;
}

function LiveMap({ units, incidents }) {
  const leafletStatus = useLeafletLoader();
  const [tilesWorking, setTilesWorking] = useState(null);
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const tileStatsRef = useRef({ errors: 0, loads: 0 });

  useEffect(() => {
    if (leafletStatus !== "ready" || !containerRef.current || mapRef.current) return;
    const L = window.L;
    const map = L.map(containerRef.current).setView([40.85, -73.89], 12);
    const tileLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
      subdomains: "abcd",
    });
    tileLayer.on("tileload", () => {
      tileStatsRef.current.loads++;
      setTilesWorking((prev) => (prev === null ? true : prev));
    });
    tileLayer.on("tileerror", () => {
      tileStatsRef.current.errors++;
      if (tileStatsRef.current.errors >= 4 && tileStatsRef.current.loads === 0 && mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        setTilesWorking(false);
      }
    });
    tileLayer.addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, [leafletStatus]);

  useEffect(() => {
    if (!mapRef.current || !layerRef.current) return;
    const L = window.L;
    layerRef.current.clearLayers();
    units.forEach((u) => {
      if (u.lat == null || u.lon == null) return;
      const color = STATUS_CONFIG[u.status].color;
      L.circleMarker([u.lat, u.lon], { radius: 7, color: "#fff", weight: 1.5, fillColor: color, fillOpacity: 0.9 })
        .bindPopup(`<b>${u.designation}</b><br/>${STATUS_CONFIG[u.status].label} \u00b7 ${u.capability}`)
        .addTo(layerRef.current);
    });
    incidents.filter((i) => i.assignedUnits.length === 0 && i.lat != null && i.lon != null).forEach((i) => {
      const color = PRIORITY_CONFIG[i.priority].color;
      L.circleMarker([i.lat, i.lon], { radius: 9, color, weight: 2, fillOpacity: 0 })
        .bindPopup(`<b>${i.address}</b><br/>${PRIORITY_CONFIG[i.priority].label}`)
        .addTo(layerRef.current);
    });
  }, [units, incidents]);

  if (leafletStatus === "failed" || tilesWorking === false) {
    return <ZoneMap units={units} incidents={incidents} />;
  }
  return (
    <div className="rounded-lg border p-3" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div className="text-xs tracking-wide" style={{ color: TEXT_FAINT }}>SERVICE AREA — BRONX, NY</div>
        <div className="text-xs" style={{ color: tilesWorking === true ? GREEN : TEXT_FAINT }}>
          {tilesWorking === true ? "Real map tiles · live" : "Loading map…"}
        </div>
      </div>
      <div ref={containerRef} style={{ height: "220px", borderRadius: "6px", backgroundColor: SUNKEN }} />
    </div>
  );
}

function ZoneMap({ units, incidents }) {
  const gridLines = [20, 40, 60, 80];
  return (
    <div className="rounded-lg border p-3" style={{ backgroundColor: PANEL, borderColor: HAIRLINE }}>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <div className="text-xs tracking-wide" style={{ color: TEXT_FAINT }}>SERVICE AREA — BRONX, NY</div>
        <div className="text-xs" style={{ color: "#55627A" }}>Schematic fallback — real map tiles unavailable</div>
      </div>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full" style={{ height: "140px", backgroundColor: SUNKEN, borderRadius: "6px" }}>
        {gridLines.map((v) => <line key={`v${v}`} x1={v} y1="0" x2={v} y2="100" stroke="#1B2330" strokeWidth="0.3" />)}
        {gridLines.map((v) => <line key={`h${v}`} x1="0" y1={v} x2="100" y2={v} stroke="#1B2330" strokeWidth="0.3" />)}
        {incidents.filter((i) => i.assignedUnits.length === 0 && i.lat != null).map((i) => {
          const p = project(i.lat, i.lon);
          return <circle key={i.id} cx={p.x} cy={p.y} r="2.2" fill="none" stroke={PRIORITY_CONFIG[i.priority].color} strokeWidth="0.8" />;
        })}
        {units.filter((u) => u.lat != null).map((u) => {
          const p = project(u.lat, u.lon);
          return <circle key={u.id} cx={p.x} cy={p.y} r="1.6" fill={STATUS_CONFIG[u.status].color} />;
        })}
      </svg>
    </div>
  );
}

function IncidentRow({ incident, now, units, onAssign, onRelease, onComplete }) {
  const [confirming, setConfirming] = useState(false);
  const elapsedMs = now - incident.callReceivedAt;
  const target = PRIORITY_CONFIG[incident.priority].targetMin * 60 * 1000;
  const ratio = elapsedMs / target;
  const timerColor = ratio > 1 ? "#F0554A" : ratio > 0.7 ? "#F5A623" : TEXT_SECONDARY;
  const assignedUnits = incident.assignedUnits.map((a) => ({ ...a, unit: units.find((u) => u.id === a.unitId) })).filter((a) => a.unit);
  const rec = getRecommendation(incident, units);
  // Restored: the live-route attempt (with an honest fallback label) was
  // silently dropped when this console was rewired to the API.
  const { routed, status: routeStatus } = useRoutedEta(rec?.unit, incident);

  return (
    <div className="px-4 py-3 border-b" style={{ borderColor: "#1B2330" }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={{ color: PRIORITY_CONFIG[incident.priority].color, backgroundColor: "rgba(255,255,255,0.04)" }}>
              {PRIORITY_CONFIG[incident.priority].label.toUpperCase()}
            </span>
            <span className="text-xs" style={{ color: TEXT_FAINT }}>{TYPE_LABELS[incident.type] || incident.type}</span>
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ color: TEXT_SECONDARY, backgroundColor: SUNKEN }}>{incident.capabilityNeeded}</span>
          </div>
          <div className="text-sm mt-1 truncate">{incident.address}</div>
        </div>
        <div className="mono text-sm shrink-0" style={{ color: timerColor }}>{formatElapsed(elapsedMs)}</div>
      </div>

      {assignedUnits.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {assignedUnits.map((a) => (
            <div key={a.unitId} className="flex items-center gap-2 flex-wrap text-xs">
              <span style={{ color: TEXT_SECONDARY }}>{ROLE_LABELS[a.role]}:</span>
              <span className="font-medium mono">{a.unit.designation}</span>
              <button onClick={() => onRelease(incident.id, a.unitId)} className="px-1.5 py-0.5 rounded" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_FAINT }}>Release</button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 flex-wrap">
        {rec ? (
          <>
            <span className="text-xs" style={{ color: TEXT_SECONDARY }}>{ROLE_LABELS[rec.role]}:</span>
            <span className="text-xs font-medium mono">{rec.unit.designation}</span>
            {rec.miles == null ? (
              <span className="text-xs mono" style={{ color: TEXT_FAINT }}>no GPS fix — distance unknown</span>
            ) : routeStatus === "live" && routed ? (
              <span className="text-xs mono" style={{ color: TEXT_FAINT }}>~{Math.round(routed.etaMin)} min · {routed.miles.toFixed(1)} mi <span style={{ color: BLUE }}>· live route</span></span>
            ) : routeStatus === "loading" ? (
              <span className="text-xs mono" style={{ color: TEXT_FAINT }}>~{Math.round(rec.etaMin)} min est. · checking live route…</span>
            ) : (
              <span className="text-xs mono" style={{ color: TEXT_FAINT }}>~{Math.round(rec.etaMin)} min · {rec.miles.toFixed(1)} mi straight-line <span style={{ color: AMBER }}>· routing unavailable</span></span>
            )}
            {rec.isMismatch && <span className="text-xs flex items-center gap-1" style={{ color: AMBER }}><AlertTriangle size={12} /> capability mismatch — consider intercept</span>}
            <button onClick={() => onAssign(incident.id, rec.unit.id, rec.role)} className="text-xs px-2 py-1 rounded font-medium" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>
              {assignedUnits.length === 0 ? "Assign" : "Add Unit"}
            </button>
          </>
        ) : (
          <div className="flex items-center gap-1 text-xs" style={{ color: RED }}><AlertTriangle size={12} /> No units available — mutual aid may be needed</div>
        )}
      </div>

      {assignedUnits.length > 0 && (
        <div className="mt-2">
          {confirming ? (
            <div className="flex items-center gap-2">
              <button onClick={() => onComplete(incident.id)} className="text-xs px-2 py-1 rounded font-medium" style={{ backgroundColor: "#3A1E1E", border: "1px solid #593434", color: "#F0857D" }}>Confirm complete</button>
              <button onClick={() => setConfirming(false)} className="text-xs px-2 py-1 rounded" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY }}>Cancel</button>
            </div>
          ) : (
            <button onClick={() => setConfirming(true)} className="text-xs px-2 py-1 rounded" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_SECONDARY }}>Complete (release all)</button>
          )}
        </div>
      )}
    </div>
  );
}

function UnitCard({ unit, onStatusChange }) {
  const cfg = STATUS_CONFIG[unit.status];
  const Icon = cfg.icon;
  return (
    <div className="rounded-md px-3 py-2 flex items-center justify-between gap-2" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}` }}>
      <div className="flex items-center gap-2 min-w-0">
        <Icon size={16} color={cfg.color} className="shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="mono text-sm font-medium">{unit.designation}</span>
            <span className="text-xs px-1 rounded" style={{ color: TEXT_SECONDARY, backgroundColor: PANEL }}>{unit.capability}</span>
          </div>
          <div className="flex flex-col">
            {unit.crew.length === 0 ? (
              <span className="text-xs" style={{ color: TEXT_FAINT }}>No crew — out of service</span>
            ) : (
              unit.crew.map((c, i) => <span key={i} className="text-xs mono truncate" style={{ color: TEXT_FAINT }}>{c.employeeId} - {c.name} — {CREW_LABELS[c.role] || c.role} {c.cert}</span>)
            )}
          </div>
        </div>
      </div>
      <select value={unit.status} onChange={(e) => onStatusChange(unit.id, e.target.value)} className="text-xs rounded px-1.5 py-1 shrink-0" style={{ backgroundColor: PANEL, color: cfg.color, border: `1px solid ${HAIRLINE}` }}>
        {Object.entries(STATUS_CONFIG).map(([key, c]) => <option key={key} value={key} style={{ color: "#000" }}>{c.label}</option>)}
      </select>
    </div>
  );
}

function NewCallModal({ form, setForm, onSubmit, onClose }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ backgroundColor: "rgba(0,0,0,0.6)" }}>
      <div className="w-full rounded-lg border" style={{ maxWidth: "400px", backgroundColor: PANEL, borderColor: HAIRLINE }}>
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: HAIRLINE }}>
          <div className="text-sm font-semibold">New Call Intake</div>
          <button onClick={onClose} style={{ color: TEXT_SECONDARY }}><X size={18} /></button>
        </div>
        <form onSubmit={onSubmit} className="p-4 flex flex-col gap-3">
          <Field label="Type">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full text-sm rounded px-2 py-1.5" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY }}>
              {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className="w-full text-sm rounded px-2 py-1.5" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY }}>
              {Object.entries(PRIORITY_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </Field>
          <Field label="Address / Location">
            <input type="text" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="e.g. Southern Blvd & 149th St" className="w-full text-sm rounded px-2 py-1.5" style={{ backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY }} />
          </Field>
          <Field label="Capability Needed">
            <div className="flex gap-2">
              {["BLS", "ALS"].map((cap) => (
                <button type="button" key={cap} onClick={() => setForm({ ...form, capabilityNeeded: cap })} className="flex-1 text-sm rounded px-2 py-1.5" style={{
                  backgroundColor: form.capabilityNeeded === cap ? "#1E3A2E" : SUNKEN,
                  border: form.capabilityNeeded === cap ? "1px solid #2E5943" : `1px solid ${HAIRLINE}`,
                  color: form.capabilityNeeded === cap ? GREEN : TEXT_SECONDARY,
                }}>{cap}</button>
              ))}
            </div>
          </Field>
          <button type="submit" className="mt-1 text-sm font-medium rounded px-3 py-2" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN }}>Add to Queue</button>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs" style={{ color: TEXT_SECONDARY }}>{label}</span>
      {children}
    </label>
  );
}
