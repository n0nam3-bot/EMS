// Renders each console in a plain browser environment (jsdom) — the first
// time any of them has run outside Claude's preview — and drives one real
// interaction through each. Network is stubbed off: the consoles reach for
// route estimates and map tiles, and a test shouldn't.
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import DispatchConsole from "../consoles/dispatch_console.jsx";
import FieldUnitConsole from "../consoles/field_unit_console.jsx";
import ComplianceConsole from "../consoles/compliance_console.jsx";
import EpcrCharting from "../consoles/epcr_charting.jsx";
import App from "../App.jsx";

beforeAll(async () => {
  // The same shim main.jsx loads. NO_SHIM=1 skips it, to show what breaks without it.
  if (!process.env.NO_SHIM) await import("../storage-shim.js");
  globalThis.fetch = () => Promise.reject(new Error("network is off in tests"));
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  window.location.hash = "";
});

describe("dispatch console", () => {
  it("renders the queue and unit board, starts in demo mode, and shows crew as 'employee id - full name'", async () => {
    render(<DispatchConsole />);
    expect(await screen.findByText("Citywide Dispatch")).toBeTruthy();
    expect(screen.getByText("TRANSPORT QUEUE")).toBeTruthy();
    expect(screen.getByText("UNIT BOARD")).toBeTruthy();
    expect(screen.getByText("Demo Data")).toBeTruthy();
    expect(screen.getAllByText(/4471 - Marcus Alvarez/).length).toBeGreaterThan(0);
  });

  it("Assign puts one more unit on a call", async () => {
    render(<DispatchConsole />);
    await screen.findByText("Citywide Dispatch");
    const before = screen.queryAllByRole("button", { name: "Release" }).length;
    fireEvent.click(screen.getAllByRole("button", { name: "Assign" })[0]);
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Release" }).length).toBe(before + 1));
  });
});

describe("compliance console", () => {
  it("shows certifications, and a reviewer can approve a chart out of the queue", async () => {
    render(<ComplianceConsole />);
    expect(await screen.findByText("Compliance Console")).toBeTruthy();
    expect(screen.getByText("CERTIFICATIONS")).toBeTruthy();
    expect(screen.getByText("W. Cho — EMT-B")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /PCR Review/ }));
    expect(await screen.findByText("PCR REVIEW QUEUE")).toBeTruthy();
    const before = screen.getAllByRole("button", { name: "Approve" }).length;
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Approve" }).length).toBe(before - 1));
  });
});

describe("ePCR charting", () => {
  it("records a vitals reading into the log", async () => {
    render(<EpcrCharting />);
    expect(await screen.findByText("ePCR Charting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Vitals/ }));
    fireEvent.change(await screen.findByPlaceholderText("88"), { target: { value: "88" } });
    fireEvent.click(screen.getByRole("button", { name: /Record Vitals/ }));
    expect(await screen.findByText(/HR 88/)).toBeTruthy();
  });
});

describe("field unit console", () => {
  it("renders the assignment with a real navigation link for each map app", () => {
    render(<FieldUnitConsole />);
    expect(screen.getByText("ASSIGNED TRANSPORT")).toBeTruthy();
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h.startsWith("https://www.google.com/maps/dir/"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("https://maps.apple.com/"))).toBe(true);
    expect(hrefs.some((h) => h.startsWith("https://waze.com/ul"))).toBe(true);
  });
});

describe("app shell", () => {
  it("opens on dispatch and switches consoles from the URL hash", async () => {
    render(<App />);
    expect(await screen.findByText("Citywide Dispatch")).toBeTruthy();
    window.location.hash = "#/field";
    expect(await screen.findByText("ASSIGNED TRANSPORT")).toBeTruthy();
  });
});
