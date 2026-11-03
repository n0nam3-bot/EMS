# Dispatch Reliability Sprint 1: status

Status key (AGENTS.md section 3): **implemented, not yet run** = written and read-checked, new test file written, full suite NOT yet run by the author.

| Item | Status | Evidence |
|---|---|---|
| Board lists every open call (+ closed in last 24h), `X-Server-Time` header | implemented, not yet run | `GET /incidents` in `backend_routes_example.js`; test "the board lists every open call" |
| Server-side assignment guard (unit must be `available`, call open, own tenant, valid role; row-locked) | implemented, not yet run | assignments route; tests "refuses to assign", "racing" |
| Unit status transition rules + override with reason, audited | implemented, not yet run | `backend_dispatch.js`, `backend_routes_units.js`; tests "status rules", "crew member can't override" |
| Field status history stamped with the call | implemented, not yet run | status route; lifecycle test |
| `incidents.dispatched_at` set on first assignment | implemented, not yet run | assignments route |
| Complete/cancel not repeatable | implemented, not yet run | tests "completing or cancelling a closed call" |
| Append-only call timeline `incident_events` (+ `GET /incidents/:id/events`) | schema + logic verified against real Postgres; routes not yet run | `scripts/upgrade_dispatch.js` |
| Dispatch console: stale indicator, double-submit locks, remove dead capability heuristic | **not done** (next drop) | `dispatch_console.jsx` unchanged |
| Realtime via Socket.IO on Vercel | **not possible as deployed**; polling (10 s) stays, `X-Server-Time` supports a stale indicator | `server.js` skips sockets when `VERCEL` is set |

## Behaviour changes worth knowing
- A unit on a call can no longer be set `available`/`out_of_service` from the status dropdown. Release it, complete the call, or (from `at_destination`) clear it. Supervisors/dispatchers can override with a reason.
- A crew pressing **Available** from `at destination` now clears the unit from the call; the call stays open for dispatch to complete.
- Assigning requires the unit's status to be `available`. Crew readiness is enforced through that status (the staffing routes keep it in step); a direct crew-count check at assign time is not added because existing tests assign uncrewed seeded units.
- `incident_events` is not wired to the audit trigger (its key is numeric); it is its own append-only record with the actor.

## Deploy
Unzip over the repo, run "Update and set up" (it now also runs `scripts/upgrade_dispatch.js`). Run `npm test` only against a disposable database.
