# Dispatch Reliability Sprint 1: status

Status key (the evidence tags are defined in `HANDOFF.md`): **verified** = a test or a live probe passed against real PostgreSQL + PostGIS in a sandbox, on the date given · **not verified live** = not yet confirmed on the deployed site · **not done** = not built.

**History.** Delivered 2026-11-03 (`1b0ecbb`); overwritten the same day by the reports/schedule update (`5720fca`); re-applied 2026-11-08 (`8443a29`) and rolled back by hand the same day; **restored 2026-11-24** from the `1b0ecbb` delta on top of the current code. Until that restore, this document said "implemented" about code that was not in the repository (`HANDOFF.md` §11, issue 1).

| Item | Status | Evidence |
|---|---|---|
| Board lists every open call (+ closed in the last 24 h; `?closedHours=` up to 168; capped at 500), `X-Server-Time` header | verified 2026-11-24; not verified live | `GET /incidents` in `backend_routes_example.js`; test "the board lists every open call" |
| Server-side assignment guard (unit must be `available`, call open, own tenant, valid assignment role; row-locked) | verified 2026-11-24; not verified live | assignments route; tests "refuses to assign", "racing"; live probe |
| Unit status transition rules + override with reason, audited | verified 2026-11-24; not verified live | `backend_dispatch.js`, `backend_routes_units.js`; tests "status rules", "crew member can't override"; live probe |
| Status history stamped with the call | verified 2026-11-24 | status route; lifecycle test |
| `incidents.dispatched_at` set on first assignment | verified 2026-11-24 (live probe) | assignments route |
| Complete/cancel not repeatable | verified 2026-11-24 | tests "completing or cancelling a closed call"; live probe |
| Append-only call timeline `incident_events` (+ `GET /incidents/:id/events`) | verified 2026-11-24, including creation on an existing database by `scripts/upgrade.js` | `scripts/upgrade_dispatch.js` (applied from `scripts/upgrade.js`); lifecycle test; live probe |
| Dispatch console: stale indicator, double-submit locks, remove dead capability heuristic | **not done** (next drop) | `dispatch_console.jsx` unchanged |
| Realtime via Socket.IO on Vercel | **not possible as deployed**; polling (10 s) stays, `X-Server-Time` supports a stale indicator | `server.js` skips sockets when `VERCEL` is set |

This sprint did **not** add role checks on the dispatch routes: any signed-in role can still create, assign and complete calls (`HANDOFF.md` §11, issue 2).

## Behaviour changes worth knowing
- A unit on a call can no longer be set `available`/`out_of_service` from the status dropdown. Release it, complete the call, or (from `at_destination`) clear it. Supervisors, dispatchers and IT admins can override with a reason; the override is audited.
- A crew pressing **Available** from `at destination` now clears the unit from the call; the call stays open for dispatch to complete. Pressing it earlier (for example on scene) is refused with a message; dispatch must release the unit or complete the call.
- Assigning requires the unit's status to be `available`: crewed and in service. Units created by `bootstrap.js` start out of service until crew are seated in OPS. A direct crew-count check at assign time is not added because existing tests assign uncrewed seeded units.
- **Creating a call, assigning, releasing, completing and cancelling now each write a row to the call's timeline (`incident_events`) in the same transaction. If that table does not exist — because the database step of the workflow has not run — those actions fail with an error. Always run the workflow with "Set up / upgrade the database too" ticked, and wait for the green tick before using the board.**
- `incident_events` is not wired to the audit trigger (its key is numeric); it is its own append-only record with the actor.

## Deploy
Unzip over the repo and run "Update and set up" with **Set up / upgrade the database too** ticked (untick the company-owner box for routine updates). `scripts/upgrade.js` applies `scripts/upgrade_dispatch.js` itself: the workflow never had a separate `upgrade_dispatch.js` step, and a zip cannot change workflow files. Run `npm test` only against a disposable database; the script includes `tests/dispatch-lifecycle.test.js`.
