// scheduleLogic.js
// -----------------------------------------------------------------------
// Turns a flat list of shifts into the crew-by-start-time schedule:
//   - shifts that belong together become one CREW (same unit and start, or, with no unit, paired
//     up by start/end time: a paramedic with a partner makes an ALS crew, the rest pair into BLS crews)
//   - each crew is ALS or BLS (a unit's level if it has one, else whether a paramedic is on it)
//   - crews are numbered PER DAY and per level in order of start time: the first BLS crew to start
//     on a day is "BLS 1", the next "BLS 2". These are schedule labels, not the units' own names:
//     the numbers change with how many shifts exist that day.
//   - rows of the grid are the distinct start times, 0000 first, then down the day.
// Times use the device's time zone, like the rest of the schedule.
// -----------------------------------------------------------------------

export const ROLE_TAG = { mvo: "MVO", emt: "EMT", aemt: "AEMT", paramedic: "Medic" };
const RANK = { mvo: 0, emt: 1, aemt: 2, paramedic: 3 };

export const pad2 = (n) => String(n).padStart(2, "0");
export const timeKey = (d) => `${pad2(d.getHours())}${pad2(d.getMinutes())}`;          // 0700
export const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const levelOfUnit = (cap) => (cap === "ALS" || cap === "CCT" ? "ALS" : "BLS");

const memberOrder = (a, b) => (RANK[a.field_level] ?? 1) - (RANK[b.field_level] ?? 1) || a.name.localeCompare(b.name);

const isMedic = (s) => s.field_level === "paramedic";
const isDriver = (s) => !isMedic(s) && (s.field_level === "mvo" || s.seat_role === "driver");

export function groupCrews(shifts, unitCapability = {}) {
  const crews = [];
  const make = (members, unitId = null) => {
    const sorted = [...members].sort(memberOrder);
    const starts = new Date(Math.min(...sorted.map((s) => new Date(s.starts_at))));
    const ends = new Date(Math.max(...sorted.map((s) => new Date(s.ends_at))));
    const level = unitId ? levelOfUnit(unitCapability[unitId]) : sorted.some(isMedic) ? "ALS" : "BLS";
    crews.push({ key: `${unitId || "pool"}|${sorted.map((s) => s.shift_id).join(",")}`, level, unitId, unitName: sorted[0].unit_designation || null, startsAt: starts, endsAt: ends, members: sorted });
  };

  // with a unit: everyone on that unit who starts together
  const byUnit = new Map();
  const pool = new Map();
  for (const s of shifts) {
    if (s.unit_id) { const k = `${s.unit_id}|${s.starts_at}`; byUnit.set(k, [...(byUnit.get(k) || []), s]); }
    else { const k = `${s.starts_at}|${s.ends_at}`; pool.set(k, [...(pool.get(k) || []), s]); }
  }
  for (const [k, members] of byUnit) make(members, k.split("|")[0]);

  // with no unit yet: pair people who work the same hours
  for (const group of pool.values()) {
    const people = [...group].sort(memberOrder);
    const medics = people.filter(isMedic), drivers = people.filter(isDriver), clinicians = people.filter((s) => !isMedic(s) && !isDriver(s));
    while (medics.length) {                                   // a paramedic and a partner (a driver first, else an EMT) make an ALS crew
      const m = medics.shift();
      const partner = drivers.shift() || clinicians.shift();
      make(partner ? [m, partner] : [m]);
    }
    while (clinicians.length || drivers.length) {             // everyone else pairs into BLS crews: an EMT and a driver
      const c = clinicians.shift();
      const d = drivers.shift() || (c ? clinicians.shift() : null);
      make([c, d].filter(Boolean).length ? [c, d].filter(Boolean) : [drivers.shift()].filter(Boolean));
    }
  }
  return crews;
}

// Adds .label ("BLS 2") and .day to each crew. Numbers restart every day and for each level.
export function numberCrews(crews) {
  const sorted = [...crews].sort((a, b) => a.startsAt - b.startsAt || a.endsAt - b.endsAt || a.members[0].name.localeCompare(b.members[0].name));
  const counts = {};
  return sorted.map((c) => {
    const day = dayKey(c.startsAt);
    const k = `${day}|${c.level}`;
    counts[k] = (counts[k] || 0) + 1;
    return { ...c, day, number: counts[k], label: `${c.level} ${counts[k]}` };
  });
}

// For one tab (ALS or BLS): the start-time rows (0000 first) and a lookup of the crews in each cell.
export function buildGrid(numbered, level, days) {
  const dayKeys = days.map(dayKey);
  const mine = numbered.filter((c) => c.level === level && dayKeys.includes(c.day));
  const rows = [...new Set(mine.map((c) => timeKey(c.startsAt)))].sort();
  const cell = (time, day) => mine.filter((c) => timeKey(c.startsAt) === time && c.day === dayKey(day));
  return { rows, cell, count: mine.length };
}

export const clock = (d) => timeKey(d);
export const span = (s) => `${timeKey(new Date(s.starts_at))}-${timeKey(new Date(s.ends_at))}`;
