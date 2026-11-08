import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { CallDraftTray, openCallDraft } from "../consoles/call_form.jsx";

afterEach(cleanup);
const session = { mode: "live", kind: "tenant", apiBaseUrl: "/api", token: "t", agency: "Acme", user: { roles: ["dispatcher"] } };
const fake = (geocode) => { globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/facilities")) return new Response("[]", { status: 200 });
  if (u.includes("/geocode")) return new Response(JSON.stringify(geocode), { status: 200 });
  return new Response("{}", { status: 404 });
}; };
const pins = [];
const listen = () => { pins.length = 0; window.addEventListener("ems-draft-pins", (e) => pins.push(e.detail)); };

describe("call form addresses", () => {
  it("keeps the address as typed when only the street was found, warns, and previews the pin on the map", async () => {
    listen();
    fake([{ label: "Grand Avenue, Palisades Park, Bergen County, New Jersey, 07650", lat: 40.85, lon: -73.99, exact: false, note: "House number 475 wasn't found; this pin is on the street." }]);
    render(<CallDraftTray session={session} />);
    act(() => openCallDraft({}));
    const box = await screen.findByPlaceholderText(/e\.g\. BronxCare/);
    fireEvent.change(box, { target: { value: "475 Grand Avenue, Palisades Park, NJ" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Find" })[0]);
    expect(await screen.findByText("Street only")).toBeTruthy();
    expect(screen.getByText(/House number 475 wasn't found/)).toBeTruthy();
    fireEvent.click(screen.getByText("Street only").closest("button"));
    expect(box.value).toBe("475 Grand Avenue, Palisades Park, NJ");            // NOT replaced by "Grand Avenue, Palisades Park, NJ"
    expect(screen.getByText(/Pinned to the street only/)).toBeTruthy();
    const last = pins[pins.length - 1];
    expect(last.pickup).toMatchObject({ lat: 40.85, lon: -73.99, approx: true, label: "475 Grand Avenue, Palisades Park, NJ" });
  });

  it("an exact match tidies the address and previews an exact pin", async () => {
    listen();
    fake([{ label: "475 Grand Ave, Palisades Park, NJ, 07650", lat: 40.8484, lon: -73.9979, exact: true }]);
    render(<CallDraftTray session={session} />);
    act(() => openCallDraft({}));
    const box = await screen.findByPlaceholderText(/e\.g\. BronxCare/);
    fireEvent.change(box, { target: { value: "475 Grand Avenue, Palisades Park, NJ" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Find" })[0]);
    fireEvent.click((await screen.findByText(/475 Grand Ave, Palisades Park/)).closest("button"));
    expect(screen.getByText("Pinned on the map")).toBeTruthy();
    expect(pins[pins.length - 1].pickup.approx).toBe(false);
    // closing the draft clears the preview
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(pins[pins.length - 1]).toBeNull());
  });

  it("editing the address after picking a result clears the pin, so a stale pin never goes with new text", async () => {
    listen();
    fake([{ label: "475 Grand Ave, Palisades Park, NJ, 07650", lat: 40.8484, lon: -73.9979, exact: true }]);
    render(<CallDraftTray session={session} />);
    act(() => openCallDraft({}));
    const box = await screen.findByPlaceholderText(/e\.g\. BronxCare/);
    fireEvent.change(box, { target: { value: "475 Grand Avenue" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Find" })[0]);
    fireEvent.click((await screen.findByText(/475 Grand Ave, Palisades/)).closest("button"));
    fireEvent.change(box, { target: { value: "475 Grand Avenue Apt 2" } });
    expect(pins[pins.length - 1].pickup).toBeNull();
  });
});
