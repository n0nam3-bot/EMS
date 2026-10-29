import { useEffect, useState } from "react";
import DispatchConsole from "./consoles/dispatch_console.jsx";
import FieldUnitConsole from "./consoles/field_unit_console.jsx";
import ComplianceConsole from "./consoles/compliance_console.jsx";
import EpcrCharting from "./consoles/epcr_charting.jsx";

const VIEWS = {
  dispatch: { label: "Dispatch", Component: DispatchConsole },
  field: { label: "Field Unit", Component: FieldUnitConsole },
  compliance: { label: "Compliance", Component: ComplianceConsole },
  epcr: { label: "ePCR", Component: EpcrCharting },
};
const fromHash = () => {
  const key = window.location.hash.replace(/^#\/?/, "");
  return key in VIEWS ? key : "dispatch";
};

// Hash routing: no server-side rewrites needed, so the built site works from
// any static host or sub-path. Each console is a separate screen on purpose —
// the field unit view is meant for a tablet in the vehicle, the others for a desk.
export default function App() {
  const [view, setView] = useState(fromHash);
  useEffect(() => {
    const onChange = () => setView(fromHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const { Component } = VIEWS[view];
  return (
    <div>
      <nav style={{ display: "flex", gap: "4px", padding: "6px 12px", backgroundColor: "#06090D", borderBottom: "1px solid #232C3A", fontFamily: "system-ui, sans-serif", fontSize: "12px" }}>
        {Object.entries(VIEWS).map(([key, v]) => (
          <a key={key} href={`#/${key}`} style={{ padding: "4px 10px", borderRadius: "6px", textDecoration: "none", color: key === view ? "#E7ECF2" : "#57647A", backgroundColor: key === view ? "#131A24" : "transparent" }}>
            {v.label}
          </a>
        ))}
      </nav>
      <Component key={view} />
    </div>
  );
}
