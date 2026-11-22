import React, { useState, useEffect, useRef } from "react";
import { X, Minus, Plus } from "lucide-react";
import { apiRequest } from "../api.js";
import { useLeafletLoader, esc, PICKUP_COLOR, DROPOFF_COLOR } from "./map_kit.jsx";

// ---- shared design tokens ---------------------------------------------------------------
const HAIRLINE = "#232C3A", PANEL = "#131A24", SUNKEN = "#0D131B";
const TEXT_PRIMARY = "#E7ECF2", TEXT_SECONDARY = "#A9B6C6", TEXT_FAINT = "#8795AB";
const GREEN = "#34D399", AMBER = "#F5934A", BLUE = "#4EA1F0", RED = "#F0554A";
const TYPE_LABELS = { emergency_911: "911 Emergency", ift_scheduled: "IFT — Scheduled", ift_on_demand: "IFT — On Demand", mutual_aid: "Mutual Aid" };
const PRIORITIES = { critical: "Critical", emergent: "Emergent", urgent: "Urgent", routine: "Routine" };

// ---- the form's data ---------------------------------------------------------------------
export const blankForm = () => ({ type: "emergency_911", priority: "emergent", capabilityNeeded: "BLS", address: "", lat: null, lon: null, approx: false, detail: "", destination: "", destLat: null, destLon: null, destFacilityId: null, patientName: "", contactName: "", contactPhone: "", notes: "" });
export const formFromIncident = (i) => ({ type: i.type, priority: i.priority, capabilityNeeded: i.capabilityNeeded, address: i.address || "", lat: i.lat ?? null, lon: i.lon ?? null, approx: false, detail: i.detail || "", destination: i.destination || "", destLat: i.destLat ?? null, destLon: i.destLon ?? null, destFacilityId: i.destinationFacilityId ?? null, patientName: i.patientName || "", contactName: i.contactName || "", contactPhone: i.contactPhone || "", notes: i.notes || "" });
export function formToApi(f) {
  const body = {
    incidentType: f.type, priority: f.priority, capabilityNeeded: f.capabilityNeeded,
    sceneAddress: f.address.trim(), sceneDetail: f.detail.trim() || null, destinationText: f.destination.trim() || null,
    patientName: f.patientName.trim() || null, contactName: f.contactName.trim() || null, contactPhone: f.contactPhone.trim() || null, notes: f.notes.trim() || null,
    destinationFacilityId: f.destFacilityId || null,
  };
  if (f.lat != null && f.lon != null) { body.lat = f.lat; body.lon = f.lon; }
  if (f.destLat != null && f.destLon != null) { body.destLat = f.destLat; body.destLon = f.destLon; }
  return body;
}
const shortLabel = (label) => label.split(",").slice(0, 3).join(",").trim();

// ---- talking to the rest of the app -------------------------------------------------------
// Any screen can open a call form by firing this event; the tray (mounted once, at the top of the
// app) owns the drafts, so they survive switching screens and don't block anything.
export const openCallDraft = (detail = {}) => window.dispatchEvent(new CustomEvent("ems-open-call", { detail }));
export const callsChanged = () => window.dispatchEvent(new Event("ems-calls-changed"));
let nearHint = null;                                     // where the agency's units are, to bias address search
export const setCallNearHint = (h) => { nearHint = h; };

const Field = ({ label, children }) => <label className="flex flex-col gap-1 min-w-0"><span className="text-xs" style={{ color: TEXT_SECONDARY }}>{label}</span>{children}</label>;
const input = { backgroundColor: SUNKEN, border: `1px solid ${HAIRLINE}`, color: TEXT_PRIMARY };

// ---- the tray ------------------------------------------------------------------------------
let nextKey = 1;
export function CallDraftTray({ session }) {
  const live = session?.mode === "live";
  const [drafts, setDrafts] = useState([]);          // { key, form, editingId, open, error, busy, asking }
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  useEffect(() => {
    const on = (e) => {
      const d = e.detail || {};
      // Editing a call that's already open as a draft just brings that draft forward.
      const existing = d.editingId && draftsRef.current.find((x) => x.editingId === d.editingId);
      if (existing) { setDrafts((all) => all.map((x) => ({ ...x, open: x.key === existing.key }))); return; }
      setDrafts((all) => [...all.map((x) => ({ ...x, open: false })), { key: nextKey++, form: d.form || blankForm(), editingId: d.editingId || null, open: true, error: "", busy: false, asking: false }]);
    };
    window.addEventListener("ems-open-call", on);
    return () => window.removeEventListener("ems-open-call", on);
  }, []);

  // Tell the dispatch map what the open call form is pointing at, so the pickup and drop-off show on
  // the main map before anything is saved.
  const openForm = drafts.find((d) => d.open)?.form;
  const previewKey = openForm ? `${openForm.lat},${openForm.lon},${openForm.destLat},${openForm.destLon},${openForm.address},${openForm.destination}` : "";
  useEffect(() => {
    const detail = openForm ? {
      pickup: openForm.lat != null ? { lat: openForm.lat, lon: openForm.lon, label: openForm.address } : null,
      dest: openForm.destLat != null ? { lat: openForm.destLat, lon: openForm.destLon, label: openForm.destination } : null,
    } : null;
    window.dispatchEvent(new CustomEvent("ems-draft-preview", { detail }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);
  useEffect(() => () => { window.dispatchEvent(new CustomEvent("ems-draft-preview", { detail: null })); }, []);

  if (drafts.length === 0) return null;
  const patch = (key, p) => setDrafts((all) => all.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const drop = (key) => setDrafts((all) => all.filter((x) => x.key !== key));
  const show = (key) => setDrafts((all) => all.map((x) => ({ ...x, open: x.key === key ? !x.open : false })));

  async function submit(d) {
    if (d.form.address.trim().length < 3) return;
    patch(d.key, { busy: true, error: "" });
    try {
      if (live) {
        if (d.editingId) await apiRequest(session, "PATCH", `/incidents/${d.editingId}`, formToApi(d.form));
        else await apiRequest(session, "POST", "/incidents", formToApi(d.form));
        callsChanged();
      } else if (window.__emsDemoCalls) {
        window.__emsDemoCalls(d.form, d.editingId);
      } else {
        throw new Error("Open the Dispatch screen to add it (demo).");
      }
      drop(d.key);
    } catch (e) {
      patch(d.key, { busy: false, error: e.message || "Could not save" });
    }
  }
  async function search(q) {
    const near = nearHint ? `&lat=${nearHint.lat}&lon=${nearHint.lon}` : "";
    // The agency's own saved places come first (instant, exact), then the map.
    const [places, map] = await Promise.all([
      apiRequest(session, "GET", `/facilities?q=${encodeURIComponent(q)}&limit=5`).catch(() => []),
      apiRequest(session, "GET", `/geocode?q=${encodeURIComponent(q)}${near}`).catch((e) => { if (/turned off/.test(e.message)) return []; throw e; }),
    ]);
    return [
      ...places.map((p) => ({ label: `${p.name}, ${p.address}`, short: `${p.name}, ${p.address}`, lat: p.lat, lon: p.lon, facilityId: p.facility_id, kind: "saved" })),
      ...map.map((m) => ({ label: m.label, short: m.label, lat: m.lat, lon: m.lon, kind: "map", precision: m.precision, approximate: Boolean(m.approximate) })),
    ];
  }

  const label = (d) => (d.editingId ? "Edit: " : "") + (d.form.address.trim() || "New call");
  const openOne = drafts.find((d) => d.open);
  return (
    <div className="fixed left-0 right-0 bottom-0 flex flex-col items-end gap-2 pointer-events-none" style={{ zIndex: 40 }}>
      {openOne && (
        <div className="pointer-events-auto mx-2 sm:mx-4 rounded-t-lg sm:rounded-lg border shadow-2xl flex flex-col" style={{ backgroundColor: PANEL, borderColor: HAIRLINE, width: "min(480px, calc(100% - 16px))", maxHeight: "78vh" }}>
          <div className="flex items-center justify-between px-4 py-2.5 border-b shrink-0" style={{ borderColor: HAIRLINE }}>
            <div className="text-sm font-semibold truncate">{openOne.editingId ? "Edit call" : "New call intake"}</div>
            <button onClick={() => patch(openOne.key, { open: false })} aria-label="Minimize" style={{ color: TEXT_SECONDARY }}><Minus size={18} /></button>
          </div>
          <div className="overflow-y-auto">
            <CallForm key={openOne.key} form={openOne.form} setForm={(f) => patch(openOne.key, { form: f })} onSearch={live ? search : null}
              error={openOne.error} busy={openOne.busy} submitLabel={openOne.editingId ? "Save changes" : "Add to queue"} onSubmit={() => submit(openOne)} />
          </div>
        </div>
      )}
      <div className="pointer-events-auto flex gap-2 flex-wrap justify-end px-2 sm:px-4 pb-2">
        {drafts.map((d) => (
          <div key={d.key} className="flex items-center rounded-full border text-xs" style={{ backgroundColor: d.open ? "#1B2736" : PANEL, borderColor: d.open ? BLUE : HAIRLINE, maxWidth: "260px" }}>
            <button onClick={() => show(d.key)} className="pl-3 pr-2 py-2 truncate" style={{ color: TEXT_PRIMARY }}>{label(d)}</button>
            {d.asking ? (
              <>
                <button onClick={() => drop(d.key)} className="px-2 py-2" style={{ color: RED }}>Discard</button>
                <button onClick={() => patch(d.key, { asking: false })} className="pr-3 py-2" style={{ color: TEXT_SECONDARY }}>Keep</button>
              </>
            ) : (
              <button onClick={() => (d.form.address.trim() || d.form.detail || d.form.notes ? patch(d.key, { asking: true }) : drop(d.key))} aria-label="Discard draft" className="pr-2.5 py-2" style={{ color: TEXT_FAINT }}><X size={14} /></button>
            )}
          </div>
        ))}
        <button onClick={() => openCallDraft({})} aria-label="Start another call" className="rounded-full border px-2.5 py-2" style={{ backgroundColor: PANEL, borderColor: HAIRLINE, color: GREEN }}><Plus size={14} /></button>
      </div>
    </div>
  );
}

// A small map inside the form: the pickup (cyan P) and drop-off (magenta D) as you pick them, before saving.
function TripPreview({ pickup, dest }) {
  const status = useLeafletLoader();
  const ref = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const key = `${pickup?.lat},${pickup?.lon},${dest?.lat},${dest?.lon}`;
  useEffect(() => {
    if (status !== "ready" || !ref.current || (!pickup && !dest)) return;
    const L = window.L;
    if (!mapRef.current) {
      mapRef.current = L.map(ref.current, { zoomControl: false, attributionControl: false }).setView([pickup?.lat ?? dest.lat, pickup?.lon ?? dest.lon], 14);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(mapRef.current);
      layerRef.current = L.layerGroup().addTo(mapRef.current);
    }
    const g = layerRef.current; g.clearLayers();
    const pin = (p, t, c) => L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 13], html: `<div title="${esc(p.label)}" style="width:26px;height:26px;border-radius:50%;background:#0A0E13;border:3px solid ${c};color:#fff;font:700 12px Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center">${t}</div>` }) }).addTo(g);
    const pts = [];
    if (pickup) { pin(pickup, "P", PICKUP_COLOR); pts.push([pickup.lat, pickup.lon]); }
    if (dest) { pin(dest, "D", DROPOFF_COLOR); pts.push([dest.lat, dest.lon]); }
    if (pickup && dest) L.polyline(pts, { color: "#4EA1F0", weight: 3, dashArray: "6 6" }).addTo(g);
    mapRef.current.invalidateSize();
    if (pts.length > 1) mapRef.current.fitBounds(pts, { padding: [28, 28], maxZoom: 16 }); else mapRef.current.setView(pts[0], 16);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, key]);
  useEffect(() => () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } }, []);
  if (!pickup && !dest) return null;
  if (status !== "ready") return <div className="text-xs" style={{ color: TEXT_FAINT }}>{status === "failed" ? "Map preview unavailable." : "Loading the map preview…"}</div>;
  return (
    <div>
      <div ref={ref} aria-label="Trip preview map" style={{ height: "150px", borderRadius: "6px", border: `1px solid ${HAIRLINE}` }} />
      <div className="text-xs mt-1" style={{ color: TEXT_FAINT }}><span style={{ color: PICKUP_COLOR }}>P</span> pickup{dest ? <> · <span style={{ color: DROPOFF_COLOR }}>D</span> drop-off</> : ""}. Not saved yet.</div>
    </div>
  );
}

function CallForm({ form, setForm, onSubmit, submitLabel, onSearch, error, busy }) {
  const [results, setResults] = useState(null);       // { field, items }
  const [searching, setSearching] = useState(null);
  const [note, setNote] = useState("");
  const set = (patch) => setForm({ ...form, ...patch });

  async function find(field) {
    const q = (field === "pickup" ? form.address : form.destination).trim();
    if (q.length < 3) { setNote("Type at least 3 characters first."); return; }
    setSearching(field); setNote(""); setResults(null);
    try {
      const items = await onSearch(q);
      if (items.length === 0) setNote("No matches. Try adding the street, borough or ZIP code.");
      else setResults({ field, items });
    } catch (e) { setNote(e.message || "Search failed"); } finally { setSearching(null); }
  }
  function choose(field, item) {
    // A street-only match for a house-numbered address pins the street, but the text stays what was
    // typed ("475 Grand Avenue..."), so the house number is never lost and the crew gets the real address.
    const keepTyped = item.approximate && /^\s*\d/.test(field === "pickup" ? form.address : form.destination);
    set(field === "pickup"
      ? { address: keepTyped ? form.address : item.short, lat: item.lat, lon: item.lon, approx: keepTyped }
      : { destination: keepTyped ? form.destination : item.short, destLat: item.lat, destLon: item.lon, destFacilityId: item.facilityId || null });
    setResults(null);
  }
  const place = (field, label, value, pinned, placeholder, extra) => (
    <Field label={label}>
      <div className="flex gap-2">
        <input type="text" value={value} placeholder={placeholder} className="flex-1 min-w-0 text-sm rounded px-2 py-2" style={input}
          onChange={(e) => set(field === "pickup" ? { address: e.target.value, lat: null, lon: null } : { destination: e.target.value, destLat: null, destLon: null, destFacilityId: null })} />
        {onSearch && <button type="button" onClick={() => find(field)} disabled={searching !== null} className="text-sm px-3 rounded shrink-0" style={{ ...input, color: BLUE }}>{searching === field ? "…" : "Find"}</button>}
      </div>
      {value.trim() && <span className="text-xs" style={{ color: pinned ? GREEN : AMBER }}>{extra || (pinned ? (field === "pickup" && form.approx ? "Pinned on the street (that house number isn't on the map). Check it before you send a unit." : "Pinned on the map") : onSearch ? "Not pinned. Tap Find and pick the exact place so units can be matched by distance." : "Demo: placed at a random spot")}</span>}
      {results && results.field === field && (
        <div className="flex flex-col rounded border mt-1" style={{ borderColor: HAIRLINE }}>
          {results.items.map((item, idx) => (
            <button type="button" key={idx} onClick={() => choose(field, item)} className="text-left text-xs px-2 py-2 border-b flex gap-2" style={{ borderColor: "#1B2330", color: TEXT_PRIMARY, backgroundColor: PANEL }}>
              <span className="shrink-0 px-1 rounded self-start" style={{ color: item.kind === "saved" ? GREEN : item.precision === "address" ? GREEN : AMBER, border: `1px solid ${HAIRLINE}` }}>{item.kind === "saved" ? "Saved place" : item.precision === "address" ? "Exact address" : item.approximate ? "Street only" : item.precision === "street" ? "Street" : "Place"}</span><span>{item.label}{item.approximate ? " (no house number found: pins the street)" : ""}</span>
            </button>
          ))}
        </div>
      )}
    </Field>
  );
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="p-4 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type"><select value={form.type} onChange={(e) => set({ type: e.target.value })} className="w-full text-sm rounded px-2 py-2" style={input}>{Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Priority"><select value={form.priority} onChange={(e) => set({ priority: e.target.value })} className="w-full text-sm rounded px-2 py-2" style={input}>{Object.entries(PRIORITIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      </div>
      <Field label="Level of care needed">
        <div className="flex gap-2">
          {["BLS", "ALS", "CCT"].map((cap) => (
            <button type="button" key={cap} onClick={() => set({ capabilityNeeded: cap })} className="flex-1 text-sm rounded px-2 py-2" style={{ backgroundColor: form.capabilityNeeded === cap ? "#1E3A2E" : SUNKEN, border: form.capabilityNeeded === cap ? "1px solid #2E5943" : `1px solid ${HAIRLINE}`, color: form.capabilityNeeded === cap ? GREEN : TEXT_SECONDARY }}>{cap}</button>
          ))}
        </div>
      </Field>
      {place("pickup", "Pickup address or facility *", form.address, form.lat != null, "e.g. BronxCare Hospital Center, Bronx")}
      <TripPreview pickup={form.lat != null ? { lat: form.lat, lon: form.lon, label: form.address } : null} dest={form.destLat != null ? { lat: form.destLat, lon: form.destLon, label: form.destination } : null} />
      <Field label="Room, floor, unit or cross street"><input type="text" value={form.detail} onChange={(e) => set({ detail: e.target.value })} placeholder="e.g. 4th floor, room 412, main lobby" className="w-full text-sm rounded px-2 py-2" style={input} /></Field>
      {place("dest", "Destination (for transfers)", form.destination, form.destLat != null, "e.g. Montefiore Moses", form.destFacilityId ? "Saved place: the chart will start with this destination" : null)}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Patient name (optional)"><input type="text" value={form.patientName} onChange={(e) => set({ patientName: e.target.value })} className="w-full text-sm rounded px-2 py-2" style={input} /></Field>
        <Field label="Contact name"><input type="text" value={form.contactName} onChange={(e) => set({ contactName: e.target.value })} placeholder="Nurse, caller…" className="w-full text-sm rounded px-2 py-2" style={input} /></Field>
      </div>
      <Field label="Contact phone"><input type="tel" value={form.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })} className="w-full text-sm rounded px-2 py-2" style={input} /></Field>
      <Field label="Notes for the crew"><textarea rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Oxygen, stairs, bariatric, isolation…" className="w-full text-sm rounded px-2 py-2" style={{ ...input, resize: "vertical" }} /></Field>
      {note && <div className="text-xs" style={{ color: AMBER }}>{note}</div>}
      {error && <div className="text-xs" style={{ color: RED }}>{error}</div>}
      <button type="submit" disabled={busy || form.address.trim().length < 3} className="mt-1 text-sm font-medium rounded px-3 py-2.5" style={{ backgroundColor: "#1E3A2E", border: "1px solid #2E5943", color: GREEN, opacity: busy || form.address.trim().length < 3 ? 0.5 : 1 }}>{busy ? "Saving…" : submitLabel}</button>
    </form>
  );
}
