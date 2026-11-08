import { describe, it, expect } from "vitest";
import { groupCrews, numberCrews, buildGrid, levelOfUnit, timeKey, span } from "../scheduleLogic.js";

const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).toISOString();   // Nov <day>, local time
let n = 0;
const S = (name, level, day, h, hours, extra = {}) => ({ shift_id: `s${++n}`, crew_member_id: `c${n}`, name, field_level: level, unit_id: null, unit_designation: null, seat_role: null, starts_at: at(day, h), ends_at: at(day, h + hours), ...extra });
const days = [2, 3, 4, 5, 6, 7, 8].map((d) => new Date(2026, 10, d));

describe("schedule crews", () => {
  it("pairs people with no unit who work the same hours into BLS crews, and numbers them by start time within the day", () => {
    const shifts = [
      S("Eve Emt", "emt", 2, 10, 8), S("Dan Driver", "mvo", 2, 10, 8),     // second BLS crew of Mon
      S("Ed Emt", "emt", 2, 0, 8), S("Mia Mvo", "mvo", 2, 0, 8),            // first BLS crew of Mon
    ];
    const crews = numberCrews(groupCrews(shifts));
    expect(crews.map((c) => [c.label, timeKey(c.startsAt), c.members.map((m) => m.name)])).toEqual([
      ["BLS 1", "0000", ["Mia Mvo", "Ed Emt"]],        // the driver is listed first
      ["BLS 2", "1000", ["Dan Driver", "Eve Emt"]],
    ]);
  });

  it("numbers restart each day, so the same unit number can mean different start times on different days", () => {
    const shifts = [S("A", "emt", 2, 8, 8), S("B", "mvo", 2, 8, 8), S("C", "emt", 3, 1, 8), S("D", "mvo", 3, 1, 8), S("E", "emt", 3, 6, 8), S("F", "mvo", 3, 6, 8)];
    const crews = numberCrews(groupCrews(shifts));
    const byDay = (d) => crews.filter((c) => c.day === `2026-11-0${d}`).map((c) => `${c.label}@${timeKey(c.startsAt)}`);
    expect(byDay(2)).toEqual(["BLS 1@0800"]);
    expect(byDay(3)).toEqual(["BLS 1@0100", "BLS 2@0600"]);
  });

  it("a paramedic with a partner is an ALS crew, counted separately from BLS", () => {
    const shifts = [S("Pat Medic", "paramedic", 2, 7, 12), S("Dan Driver", "mvo", 2, 7, 12), S("Ed Emt", "emt", 2, 7, 12), S("Mia Mvo", "mvo", 2, 7, 12)];
    const crews = numberCrews(groupCrews(shifts));
    expect(crews.map((c) => [c.label, c.members.map((m) => m.name)])).toEqual([["ALS 1", ["Dan Driver", "Pat Medic"]], ["BLS 1", ["Mia Mvo", "Ed Emt"]]]);
  });

  it("crews on a unit use the unit's level, and members on the same unit and start stay together", () => {
    const shifts = [S("Ed Emt", "emt", 2, 7, 12, { unit_id: "u1", unit_designation: "Medic 1" }), S("Pat", "paramedic", 2, 7, 12, { unit_id: "u1", unit_designation: "Medic 1" })];
    const crews = numberCrews(groupCrews(shifts, { u1: "ALS" }));
    expect(crews).toHaveLength(1);
    expect(crews[0]).toMatchObject({ level: "ALS", label: "ALS 1", unitName: "Medic 1" });
    expect(levelOfUnit("CCT")).toBe("ALS");
    expect(levelOfUnit("BLS")).toBe("BLS");
  });

  it("the grid lists start times from 0000 downward, only the ones in use, and puts crews in the right day column", () => {
    const shifts = [S("A", "emt", 3, 1, 8), S("B", "mvo", 3, 1, 8), S("C", "emt", 2, 0, 8), S("D", "mvo", 2, 0, 8), S("E", "emt", 2, 14, 8), S("F", "mvo", 2, 14, 8), S("G", "paramedic", 2, 6, 12), S("H", "mvo", 2, 6, 12)];
    const numbered = numberCrews(groupCrews(shifts));
    const bls = buildGrid(numbered, "BLS", days);
    expect(bls.rows).toEqual(["0000", "0100", "1400"]);
    expect(bls.cell("0000", days[0]).map((c) => c.label)).toEqual(["BLS 1"]);   // Mon
    expect(bls.cell("0100", days[1]).map((c) => c.label)).toEqual(["BLS 1"]);   // Tue: its own numbering
    expect(bls.cell("0100", days[0])).toEqual([]);
    expect(bls.cell("1400", days[0]).map((c) => c.label)).toEqual(["BLS 2"]);   // Mon's second BLS crew
    expect(buildGrid(numbered, "ALS", days).rows).toEqual(["0600"]);
  });

  it("a shift that crosses midnight is shown on the day it starts", () => {
    const s = S("N", "emt", 2, 19, 12);
    const numbered = numberCrews(groupCrews([s, S("M", "mvo", 2, 19, 12)]));
    expect(numbered[0].day).toBe("2026-11-02");
    expect(span(s)).toBe("1900-0700");
  });

  it("a lone person still appears, and week days outside the shown week are ignored", () => {
    const numbered = numberCrews(groupCrews([S("Solo", "emt", 2, 9, 8), S("Elsewhere", "emt", 20, 9, 8)]));
    expect(buildGrid(numbered, "BLS", days).count).toBe(1);
  });
});
