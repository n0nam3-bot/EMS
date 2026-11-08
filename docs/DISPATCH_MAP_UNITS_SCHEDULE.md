# Map, units, vehicles and schedule: status

Verified = covered by a passing automated test in this repo (backend: 94 tests against real Postgres 16 + PostGIS, run six times in a row; web: 77 tests, production build succeeds). Nothing here has been opened in a real browser or on a phone.

| Request | Status | Where |
|---|---|---|
| Address search kept dropping the house number ("475 Grand Avenue" became "Grand Avenue") | Fixed and tested **with the network stubbed**. The live Census and OpenStreetMap services were not reachable from the build environment, so check a few real addresses | `backend_geocode.js`, `call_form.jsx` |
| Street-only matches are flagged ("Street only", amber warning) and the typed address is kept | Verified | `call_form.test.jsx`, `geocode.test.js` |
| Pickup and drop-off previewed on the map before saving (dashed white markers) | Verified | `mapLogic.js`, `map_render.test.jsx` |
| Click a call to see its trip (pickup, drop-off, route line, its units); nothing selected shows ongoing calls and units | Verified | `mapLogic.js`, `dispatch_console.jsx` |
| Status colours on units; pickup/drop-off colours; queued calls small and dull (toggle, off by default) | Verified | same, plus a legend under the map |
| Manual status puts the unit where it would be: pickup on scene (and leaving), drop-off at destination; real GPS (fix under 2 min old) is never overridden; dashed ring = position from status | Verified | `backend_routes_units.js`, `units-ops.test.js`; `location_source` column |
| Rename and delete units (Team). A unit with call history is retired, not erased; crew/active call blocks it | Verified | `backend_routes_admin.js`, `team_console.jsx` |
| OPS: assign a vehicle number; swap with a required reason; one vehicle number on one unit; history kept | Verified | `PUT /units/:id/vehicle`, `ops_console.jsx` |
| Schedule: ALS and BLS tabs, start-time rows from 0000, crews numbered per day by start order (BLS 1, BLS 2), crew and times shown | Verified (logic and UI) | `scheduleLogic.js`, `schedule_console.jsx` |
| Dispatch Sprint 1 (server-side assignment guard, status rules, call timeline) | Wired in and verified (it had been overwritten by an earlier patch) | `backend_dispatch.js`, `migrate.js`, `dispatch-lifecycle.test.js` |
| **Vehicle inspection by the driver; BLS/ALS equipment inspection by the EMT/paramedic** | **Not done yet.** Needs separate checklists and who-may-sign rules | next |
| Real-time sockets | Not possible on Vercel serverless; the board polls every 10 s | |

## Decisions I made that you may want to change
- A "vehicle" is currently a fleet number on the unit (`units.vehicle_number`), not a full vehicle record (make, VIN, plate, own inspection dates). Swapping keeps a history and the unit stays in service.
- Schedule crews with no unit are paired automatically by start time: a paramedic plus a driver/EMT is an ALS crew; other people pair into BLS crews. People on a unit are grouped by that unit and start time. Shifts crossing midnight show on the day they start. Pairing is a guess when several people share the same hours: assign a unit to make it exact.
- Schedule numbers (BLS 1, ALS 1) are labels computed for each day, not stored, and not the units' names.
- A unit "delete" with history is a retire (hidden everywhere, history kept) so response-time and chart records stay intact.

## Deploy
Unzip over the repo and run "Update and set up" (it runs `scripts/upgrade.js`). **The new columns and tables come from `scripts/upgrade_dispatch.js`, which the workflow does not run yet.** GitHub blocks this workflow from editing itself, so add one line by hand in the GitHub web editor: in `.github/workflows/update-and-setup.yml`, under "Apply database upgrades", change `run: node scripts/upgrade.js` to two lines, `node scripts/upgrade.js` and `node scripts/upgrade_dispatch.js`. Do this BEFORE using the new screens: without it, creating a call fails because the call-timeline table is missing.
