# EMS Dispatch & Operations Platform — Backend

What this is, what's been proven, and what hasn't. Everything under "verified" is something a test I watched pass actually exercises; everything under "not verified" or "not built" is named so it isn't discovered the hard way.

## Run it

```bash
# migrations/ is already populated — keep those filenames; the order is load-bearing (see Layout)
npm ci
docker compose up -d db          # Docker is optional — any Postgres 15+ with PostGIS works
RUNTIME_DB_PASSWORD=<pick one> npm run migrate
npm run dev
```

`GET /health` returns `{"status":"ok"}`. Everything else returns 401 until `JWT_PUBLIC_KEY` is a real key from a real identity provider (see `.env.example`). **The database starts empty.** Nothing works until there is an agency (`tenants`), an active `protocol_sets` row for it, and `users` rows. A token carries the user's UUID as `sub` and the agency's UUID as `tenant_id` — but it only says *who is asking*. The database decides everything else: that user must exist, be active, and belong to an active agency, and their **role comes from `users.role`, not from the token**. There are no routes yet to create, deactivate or re-role users; that is done in the database (`tests/api-client.test.js` shows the shape). Optional: `WS_REVALIDATE_MS` (default 30000) sets how often open live-feed sockets are re-checked.

**Two database roles, on purpose.** `migrate.js` runs as the owner and then creates a restricted `ems_app_runtime` role. The API must connect as that one. Table owners bypass row-level security, so an API running as the migration role has every isolation policy in this project silently switched off — the first live test of this schema showed exactly that.

**Tests:** `TEST_DATABASE_URL=postgres://<owner>:<pw>@localhost:5432/<empty db> npm test`. **That database is wiped** (`DROP SCHEMA public CASCADE`) at the start of each suite — never point it at anything you want to keep.

## Verified

`npm test` runs 50 tests, all passing, against real Postgres 16 + PostGIS 3.4. 18 test the database directly; 32 start the real `server.js` and drive it with real RS256 tokens — over HTTP through `api-client.js`, and over a real WebSocket connection.

- **Tenant isolation** on tables, **views**, and through a mutual-aid grant — including that a grant gives *read-only* access, shares exactly the units active on the shared incident, and disappears on revoke.
- **Append-only evidence:** the app role cannot update or delete `audit_log`, `unit_status_history`, `pcr_amendments`, `controlled_substance_log`, `protocol_search_log`, or delete mutual-aid grants.
- **Business rules enforced by the database:** a lapsed or missing ALS certification blocks crew assignment (and a current one is accepted); a grant can't exceed 72 hours; a unit can't be on two live incidents; a finalized chart refuses changes through *every* child table, returned as a clear 409.
- **Dispatch loop through the real handlers:** assign / release / complete move unit status *and* write `unit_status_history` in one transaction; a refused assignment leaves no trace. Incidents carry their active assignments and real lat/lon, units carry their crew, and the server stamps each call with the agency's active protocol version.
- **ePCR routes:** idempotent chart creation, vitals / procedures / medications / narrative / disposition round-trip, disposition is a true upsert.
- Role checks, the 72-hour cap at the API, location reporting restricted to the unit's own crew, certification and vehicle queries.
- **Audit trail.** Every API write to an audited table (15 of them: incidents, assignments, charts and each clinical child table, amendments, the controlled-substance log, grants, certifications, crew, users, protocol sets) leaves an entry naming who did it, what, when, and which *columns* changed — never their values, so PHI isn't copied into the log. Reading a patient chart or opening a single incident is logged in the same transaction as the read: if the entry can't be written, the data isn't served. An agency can see when another agency viewed an incident it shared. Refused attempts (role denials, trying to move a unit you don't crew) are logged. Compliance roles can search the log and verify its hash chain (`GET /audit`, `GET /audit/verify`). Proven: attribution stays correct under 72 concurrent requests from 6 users against a pool of 20 connections; concurrent writes keep one unbroken chain; verification catches an entry whose contents or actor were rewritten after the fact, and doesn't depend on the session's time zone.

- **Authority is the database's, checked on every request.** A deactivated user, a downgraded role, and a suspended agency all take effect on the *next* request, not when the token expires; a validly signed token for someone who isn't a user of that agency — including a real user claiming another agency — is refused; the token's role claim never outranks the database. Refusals are logged with the specific reason, while the caller always sees the same message.
- **The live feed** applies the same check at the handshake (one shared function, so the two can't drift), pushes a unit status change to sockets in the same agency and to no one else, and cuts off a socket whose user is deactivated while connected.
- **It refuses to start in the configuration that would merge agencies.** If the database role the API connects as is a superuser, a table owner, or has BYPASSRLS — all exempt from row-level security — or if any table holding agency data lacks row-level security, the server prints why and exits instead of running. Proven by tests that start the real server both ways.

**Not verified by any automated test:** the live feed's mutual-aid incident rooms (`grantIncidentRoomAccess` / `revokeIncidentRoomAccess` are written but no route calls them); any React rendering (the four consoles parse cleanly under a real JSX parser and their pure logic was executed in isolation, but none has been rendered by me); the AI narrative calls; the map and routing in a real browser; browser GPS.

## Layout

`migrate.js` applies, in this order: `ems_dispatch_core_schema.sql` → `epcr_clinical_schema.sql` → `protocol_reference_schema.sql` → `mutual_aid_schema.sql` → `multi_unit_incidents_schema.sql` → `crew_seat_role_schema.sql` → `pcr_finalization_schema.sql` → `audit_schema.sql`. The order is load-bearing: the fifth rewrites policies the fourth creates, and the last attaches triggers to tables the others define.

API: `server.js` mounts `backend_routes_example.js` (incidents, assignments, mutual aid), `backend_routes_units.js`, `backend_routes_location.js`, `backend_routes_compliance.js`, `backend_routes_pcr.js`, `backend_routes_pcr_detail.js`, `backend_routes_audit.js`. `backend_db.js` is what makes tenant isolation work (every query runs in a transaction that sets the tenant and the acting user); `backend_context.js` carries who is acting; `backend_auth.js` (`resolveSession` is the single place a token becomes a user); `backend_audit.js`; `backend_websocket.js`. `api-client.js` is the tested reference for the calls the consoles make. Tests are in `tests/`; `scripts/` holds `bootstrap_example.sql` (first-run agency and users) and `dev_token.js` (development tokens only — never in production).

## The four consoles

Each runs on local demo data until you give it an API URL and a token (a pasted JWT — a dev convenience, not a login).

- **Dispatch** — live mode loads units (with crew) and incidents (with assignments), changes status, assigns, releases, completes, and creates calls. Not real-time: it reloads after each action and nothing subscribes to the WebSocket. New live calls have no map position (there is no geocoder, and it no longer invents one). Distance is straight-line, with a live-route attempt that falls back and says so.
- **Field unit** — real device GPS, reported to the API at most every 10 seconds.
- **Compliance** — Certs & Fleet is real. PCR Review and Investigations are demo data and say so; Investigations has no backing table. **No console shows the audit trail yet** — the API does (`GET /audit`), and an Audit Trail tab is the obvious next consumer.
- **ePCR charting** — vitals, procedures, medications, narrative and disposition type/impression/mechanism/transfer-of-care sync. A failed sync stays visible until dismissed and can't be cleared by a later success. Everything else is local-only and flagged where you enter it (see gaps).

## What testing found

Each of these looked fine in review and was caught only by running something:

1. Migration order: a column drop blocked by a policy that still referenced it.
2. Row-level security completely inert under the owner role (above) — fixed by the restricted role `migrate.js` now creates.
3. `migrate.js` ran itself on import and killed any process that imported it.
4. Both views leaked across tenants (views run as their owner, who bypasses RLS) — `security_invoker`. No shipped route was exposed, but the views were open to the next one.
5. Mutual-aid policies applied to *every command*, so a read-sharing grant let the assisting agency delete the owner's status history. Sharing is now separate `FOR SELECT` policies.
6. The rewritten mutual-aid *units* policy never worked: row-level security applies inside policy subqueries, and the table it read was private to the assisting tenant.
7. `migrate.js` granted the app role `UPDATE`/`DELETE` on `audit_log`, contradicting the schema's own comment.
8. A finalized chart's vitals, procedures, medications and disposition were all still writable. A code comment I wrote called that deliberate; it wasn't.
9. Assign/release/complete never wrote status history — the source of truth for response times — and Assign didn't even change the unit's status.
10. A unit could be double-booked, though earlier docs said it couldn't.
11. The live dispatch console couldn't create a call (missing protocol set), lost every assignment after the first Assign, sent invented coordinates, and showed `NaN` for units without GPS; its live-routing code had also been dropped in a rewrite.
12. **Nothing wrote to the audit log at all**, and when it was wired up its hash chain had three defects. Concurrent writes forked it — the schema's own "known limitation" was a real bug, reproduced by a failing test before it was fixed. The other two I found by re-reading the old function rather than watching a test fail: the hash covered neither the actor nor the contents, so rewriting either went undetected, and the timestamp was hashed in the session's time zone. Tests now cover rewritten contents, a rewritten actor (confirmed able to fail by deliberately breaking the digest), and a different session time zone.
13. Token claims that weren't UUIDs became opaque 500s deep inside queries, and could have produced writes that couldn't be attributed — now a clean 401 at the door.
14. **Authentication trusted the token completely.** Only the signature was checked, so a terminated employee, a downgraded role or a suspended agency kept working until the token expired — and `users.is_active` existed but nothing read it. The live feed carried its own separate copy of the check, so a deactivated user could still open a socket and receive live updates, and an already-open socket was never re-checked. The database is now the authority on every request, both paths share one function, and open sockets are swept. (The suite had also been minting tokens for users who didn't exist; every test client is now backed by a real user.)
15. **Nothing stopped the API from starting in the one configuration that merges agencies.** Connecting as a superuser, a table owner or a BYPASSRLS role switches row-level security off for that connection — and the server started without a word, so every agency could have read every other's data with nothing on screen to say so. It now checks at startup and refuses, with the reason. Two tests watched it start when it shouldn't before the check existed.

## Not built, and why it matters

- **The audit trail has limits.** Deleting the *newest* entry is invisible to the chain alone (closing that needs the latest hash anchored somewhere the database owner can't reach). Not logged by design: browsing your own incident list (opening one is logged), GPS pings and unit status changes (status history covers those), reads of units/certifications/vehicles, and attempts to read records that row-level security hides. The NEMSIS export happens in the browser, so it can't be audited here. Sign-in and failed sign-in belong to the identity provider. Retention (HIPAA expects six years) and partitioning for log growth aren't addressed, and the per-agency lock that keeps the chain unbroken serializes that agency's audited writes — fine at this scale, a ceiling at much higher volume.
- **Every request costs a user lookup, on purpose.** Caching it would give back exactly the delay this exists to remove. Refused sessions are written to the audit log, so anyone holding a validly signed token for a deactivated account can add entries to that agency's log — bounded by what the identity provider will issue, but worth rate-limiting.
- **No user management.** Creating, deactivating and re-roling users happens in the database; no route does it, and no console. Open live sockets notice a deactivation within `WS_REVALIDATE_MS`.
- **No identity provider.** Real login (OIDC/SSO) is an organizational decision, not code. Real providers often use opaque subject strings, so mapping `users.external_idp_subject` to `users.user_id` belongs in `backend_auth.js` when one is connected.
- **No PHI encryption.** Patient name, DOB and SSN columns expect application-layer encryption that doesn't exist, so the Patient tab deliberately doesn't sync. Needs a key-management decision first.
- **Schema gaps the consoles exposed:** no columns for chief complaint, HPI, mental status, survey findings, allergies or history; signatures need object storage; destination facility is free text but the schema wants a facility ID; transport times have no home; no route for the controlled-substance chain-of-custody log (the console warns when it can't link one); incidents have no BLS/ALS-needed column (the console infers it from priority and the New Call choice isn't saved); no investigations table.
- **Real-time is only partly wired:** unit status changes made through the status route are pushed, but assign/release/complete don't broadcast, the mutual-aid incident rooms aren't connected to the grant routes, and no console subscribes. Scaling past one process needs the Redis adapter.
- **Unbuilt routes:** crew, facilities, protocol documents, signatures, controlled substances.
- **Smaller:** `DATE` columns reach JSON as timestamps, which can be off by a day in some time zones; assigning doesn't check a unit is in service; the status route accepts any status mid-call.
- **Hosting and process:** a managed Postgres with PostGIS under a BAA, TLS, secrets management, an independent penetration test and SOC 2 readiness pass before any real patient data, NEMSIS medication coding (RxNorm), and a PDF text-extraction step for the protocol library.

Two lessons from building this worth carrying forward. A fix that exists only in a running environment isn't safe until it's committed somewhere durable. And a test that leaks a database connection when it fails doesn't fail — it hangs, which hides the very result it exists to report.
