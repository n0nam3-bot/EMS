# HANDOFF — EMS Dispatch & Operations Platform

> **Every new chat: read this entire file before doing anything.** It is the single source of truth for how this
> project works, where it stands, what is broken, and what comes next. If it disagrees with `README.md`,
> `DEPLOYMENT.md`, `backend/README.md` or `docs/DISPATCH_SPRINT1.md`, **this file wins**. Those were last
> updated on 2026-10-29 / 2026-11-03 and are out of date (§11, issue 4).

| | |
|---|---|
| Repo | https://github.com/n0nam3-bot/EMS — **public**, default branch `main`, 85 commits since 2026-10-29 |
| Live site | https://ems-delta-indol.vercel.app/ (the repo's "homepage" field). A chat cannot check it — see §14 |
| Verified against | the code of commit `c767532` (2026-11-22); `69d4b37` (2026-11-24) added only this file. The Sprint 1 restore (§15, 2026-11-24) is **verified in a sandbox and awaits confirmation on the live site** |
| Last full verification | 2026-11-23 and 2026-11-24, by a Claude chat, in a Linux sandbox: Node 22.23, PostgreSQL 16.15, PostGIS 3.4.2 |

**Evidence tags used in this file**

| Tag | Meaning |
|---|---|
| **[verified]** | Run or observed on the date stated, in the sandbox (never in production) |
| **[code]** | Read in the source, not executed |
| **[docs]** | Claimed by another document in the repo; not independently checked |
| **[unverified]** | Believed true; cannot be checked from a chat |
| **[owner]** | Only the owner can confirm or decide |

---

## 0. Paste this at the start of every new chat

```text
Project: EMS dispatch platform. Repo: https://github.com/n0nam3-bot/EMS.git
First clone the repo, read HANDOFF.md completely, and follow its "START HERE" rules.
Run `git log --oneline -8` so you work from the latest commit, not from anything I upload or you remember.
I work from my phone with no terminal: give me tap-by-tap steps and deliver changes the way HANDOFF.md section 4 says.
Tell me what you verified by running it and what you did not.
Today I want to: ...
```

Tip: save the first four lines in Claude's user preferences (Settings) so every chat starts this way on its own.

---

## 1. START HERE — rules for every chat

1. **Work from the repo at HEAD, nothing else.** Clone it, run `git log --oneline -8`, and read the files you will touch *as they are now*. Not an uploaded zip, not an earlier chat, not memory. *Twice, an update built from a stale copy silently erased finished work (§13, lessons 1–2).*
2. **Never rewrite a whole file from memory or from an old copy.** Make the smallest change that does the job. Before delivering, compare every outgoing file with HEAD (`git diff --stat`) and confirm that only the files you meant to change differ.
3. **Test before and after, and say exactly what ran.** Backend needs Postgres + PostGIS (recipe in §9.3). The `npm test` script lists five files, **including `tests/dispatch-lifecycle.test.js`** — if you add a test file, add it to that list (R3 will make this automatic; §11, issue 3). Web: `npm test` and `npm run build`. Report counts. Never write "this should work".
4. **Label every claim**: verified (you ran it), code-read, or unverified. A chat cannot see Vercel, Neon, or the GitHub Actions runs. Do not pretend to; ask the owner (§14).
5. **The owner works from a phone** (inferred from the workflow header and `DEPLOYMENT.md` — **[owner]** confirm). Never hand over terminal commands as instructions. Deliver changes as in §4: an `ems-update.zip` with repo-relative paths, an explicit list of any file to **delete** (a zip cannot delete), no new `.sql` files, no `.github/workflows` files.
6. **Database changes go only in `UPGRADE_SQL` in `backend/scripts/upgrade.js`**, written to be safe to run repeatedly. Any new table with a `tenant_id` column needs row-level security and the `tenant_isolation` policy, plus explicit `GRANT`s to `ems_app_runtime` (and `REVOKE UPDATE, DELETE` if it is append-only). **Tests will not catch a missing grant** — see §4.4.
7. **Never change or rotate `SESSION_SECRET`** without a plan for re-enrolling every user's two-step sign-in. It is the key that encrypts the stored MFA secrets (§5.3).
8. **Bump `build` in `backend/server.js` (the `/api/health` response) on every release**, and tell the owner which number to expect, so a deploy can be proven. It is `10` once the 2026-11-24 restore is applied (`9` before).
9. **No secrets, no real patient data and no real staff data in the repo.** It is public. The platform is **not approved for real patient data** (§11, issue 11).
10. **Trust the code over any document.** If you find a doc that is wrong, fix it or add it to §11.
11. **Keep this file true.** Whenever a change affects status, known issues, roadmap, env vars, the pipeline or a decision, update the section and add a line to §15 **in the same delivery**. When you fix something from §11, move it to §15 with the commit hash.
12. **Ask only when you must, and one thing at a time.** Ask the owner for facts you cannot obtain (§14). Otherwise decide, state your assumption in one line, and proceed.

---

## 2. Snapshot

**What it is.** A multi-tenant EMS dispatch and operations platform: call intake, a live dispatch board, unit assignment, a field-unit screen, ePCR charting, QA/QI review, scheduling, fleet and inspections, response-time reports, compliance views, and a platform-admin console for managing companies. New York is the reference regulatory implementation (master plan §6); other states are meant to plug in. Origin: `docs/ems_dispatch_platform_master_plan.md` (a pre-build specification with phases 0–3).

**Stack.** Node (Express 4, `pg`, Socket.IO that is **disabled on Vercel**) · PostgreSQL 16 with PostGIS, pgcrypto, pg_trgm · React 18 + Vite 5 + Tailwind 3 (lucide-react, qrcode) · Leaflet from a CDN · backend tests with `node --test`, web tests with Vitest + Testing Library + jsdom.

**Where it runs** (per the workflow header, `vercel.json` and `DEPLOYMENT.md` — **[unverified]** from a chat): GitHub repo → Vercel (one project, two "services": `backend` as Express and `web` as Vite; `/api/*` is rewritten to the backend) → Neon managed Postgres. All human commits are manual uploads through the GitHub web UI by the owner's account; the 9 commits by `github-actions` are the "Apply update" workflow.

### State of the code (sandbox verification; the live site is unchecked)

| Check (date in each row) | Result |
|---|---|
| Backend `npm test` — 5 files: isolation 18, api-client 32, auth-admin 18, geocode 6, dispatch-lifecycle 11 | **85 / 85 pass**, about 40 s **[verified 2026-11-24, with the Sprint 1 restore applied]**. Before the restore: 74 / 74, the fifth file not being in the script **[verified 2026-11-23]** |
| `dispatch-lifecycle.test.js` on the code before the restore (`c767532`) | 1 / 11 pass **[verified 2026-11-23]** — §11, issue 1 |
| Production-style upgrade: a database built from `69d4b37`, then **only** `node scripts/upgrade.js` from the restore build, three times | `incident_events` created with row-level security, the tenant policy and INSERT/SELECT-only for the app login; repeatable; existing data untouched **[verified 2026-11-24]** |
| Live server on that database: create → assign → status chain → clear → complete, with the refusals and the timeline | 20 / 20 **[verified 2026-11-24]** |
| The restore build against a database that has **not** been upgraded | `/api/health` still says OK and reads work, but **creating a call returns HTTP 500** (rolled back cleanly) **[verified 2026-11-24]** — §11, issue 15 |
| Web `npm test` (Vitest, jsdom) | 55 / 55 pass **[verified]** |
| Web `npm run build` | OK — 446 kB JS (129 kB gzip) **[verified]** |
| Fresh database: `npm run migrate`, then `scripts/upgrade.js` twice, then `scripts/bootstrap.js` twice | OK and repeatable **[verified]** |
| Live server on that database: sign-in with MFA enrolment, `/auth/me`, units, users, fleet, schedule, create a call | 13 / 13 **[verified]** |
| `npm audit --omit=dev` (backend and web) | 0 vulnerabilities **[verified]** |
| Web `apiRequest` call sites vs backend routes (77 call sites, static check) | no mismatches **[verified, static only]** |
| Real browsers and phones, the Vercel deployment, Neon, Actions runs, env vars, TomTom/OSRM/Leaflet at runtime | **not checked** — impossible from a chat **[unverified]** |

**Works** (covered by the passing automated suite and the live smoke test above): two-step sign-in (password + authenticator code, 8 recovery codes) and a separate platform-admin session; per-company data isolation enforced by the database; company administration (users with several roles, field levels, units, crew seating, certifications, fleet vehicles, facilities, checklists); creating calls with address search; assigning, releasing, completing and cancelling; unit status and location; mutual-aid grants; the field-unit screen; ePCR from draft to submit to QA approve/reopen with finalized charts locked; shifts; response-time report; hash-chained audit log with a verify endpoint.

**Broken or dangerous** (details and evidence in §11): **any signed-in role, including a read-only auditor, can create, assign and complete calls** (issue 2); the documentation was three weeks stale (issue 4; R4); the pipeline has silent-failure traps (issues 5 and 15). The Sprint 1 dispatch protections were missing until the 2026-11-24 restore (issue 1) — **verified in a sandbox, not yet confirmed on the live site**.

---

## 3. The owner and how to work with them

- **Phone-first.** Updates are uploaded through the GitHub website and a workflow is run from the Actions tab. Vercel and Neon are used through their dashboards. Give numbered, tap-by-tap steps; keep any command the owner must type to zero.
- **Honest reporting is the house style.** `backend/README.md` is built around "verified / not verified / not built". Keep that. Say "I ran X and it passed", never "it works".
- **Plain-language product.** User-facing errors are written for non-technical staff, and every account-revealing failure uses the same words ("Incorrect email or password"). Keep that when adding messages.
- **Domain rules in the code are deliberate** (staffing by field level, certification hard-blocks, the unit-vs-vehicle split, append-only evidence). Ask before changing one; do not "simplify" it.
- **Commit messages carry no information** (all "Add files via upload" or "Apply update"). The only narrative of what changed and why is §15 of this file, so keep it current.
- **The owner decides priorities.** §12 is a proposal built from the repo's own documents and from what was verified. Confirm before starting large work.

---

## 4. How changes reach production (the pipeline) and runbooks

### 4.1 The flow

```text
Owner (phone) ── uploads ems-update.zip to the repo's main page ──► GitHub repo (main)
Owner ── Actions tab ▸ "Update and set up" ▸ Run workflow ──►  1. unzip -o every ems-update*.zip into the repo,
                                                                  delete the zip, commit "Apply update", push
                                                               2. Vercel sees the push and redeploys backend + web
                                                               3. if "Set up database" is ticked, against Neon:
                                                                  migrate (only if the tenants table is missing)
                                                                  → node scripts/upgrade.js (always)
                                                                  → bootstrap company/owner (if ticked)
                                                                  → bootstrap platform admin (if an email is given)
```

Steps 2–3 use the files as unpacked in step 1 (same workspace), so a zip that changes `scripts/upgrade.js` is used by that same run **[code]**. The owner also sometimes uploads individual files or whole folders straight through the GitHub web UI; those commits carry the same stale-copy risks (rule 1–2).

### 4.2 Shipping an update — what to tell the owner

1. The chat delivers `ems-update.zip`. **Paths are relative to the repo root** (`backend/backend_routes_units.js`, not `EMS/backend/...`), with no wrapper folder. The name must start with `ems-update` (a browser-renamed `ems-update (1).zip` also matches).
2. Owner: repo ▸ **Add file ▸ Upload files** ▸ pick the zip ▸ **Commit changes**.
3. Owner: **Actions ▸ Update and set up ▸ Run workflow**, with:
   - **Set up / upgrade the database too** — leave ticked (it runs `upgrade.js`; harmless if there is no DDL change);
   - **Create / reset the company owner login** — **untick for routine updates** (see the trap below);
   - platform administrator email — blank.
4. Wait for every step to go green. Vercel then redeploys by itself.
5. Owner opens `https://ems-delta-indol.vercel.app/api/health`. **`build` must equal the number the chat promised** (rule 8; it is `10` after the Sprint 1 restore). Also check `sessionSecret` is `valid`. **This proves the code, not the database** (issue 15).
6. **Create a test call, then assign an available unit to it.** If creating the call fails with "Internal server error", the database step has not finished or has failed: open the workflow run, wait for the green tick (or copy the red log to the chat) and try again. If no unit shows as available, that is the new rule working: a unit must be staffed into service first, so seat a crew on one in OPS.
7. If a step is red, the owner copies that step's log into the chat. The code is **already pushed** by the time a later database step fails, so Vercel may be running new code against an old database; fix forward quickly, or roll back in Vercel (§4.5).

> **Trap — "Create / reset the company owner login" is ticked by default.** Each run with it ticked resets the owner's password to the `ADMIN_PASSWORD` secret (undoing any in-app password change), clears lockouts, re-activates the account, and rewrites the owner's name and email from the boxes. With the email box blank it fails after the upgrade step already ran. Tick it only to create the owner or to recover a forgotten password. **[code]** (`scripts/bootstrap.js`). It does **not** reset the owner's authenticator (recovery codes or the platform admin do — §4.6).

### 4.3 What this pipeline cannot do

| Need | Why | What to do |
|---|---|---|
| Delete or rename a file | `unzip -o` only adds and overwrites | List the files in the chat's reply. Owner: open the file on GitHub ▸ trash icon ▸ commit. **Nothing else removes orphans** (`backend/backend_dispatch.js` was one until the 2026-11-24 restore) |
| Add a **new** `.sql` file | `.gitignore` contains `*.sql`, and the workflow's `git add -A` silently skips new ignored files while still committing edits to tracked ones **[verified]** | Put DDL in `UPGRADE_SQL` (a JS string in `upgrade.js`), or owner uploads the `.sql` through the GitHub UI, or remove the ignore rule |
| Change `.github/workflows/*` | GitHub does not let the built-in token modify workflow files (platform rule, **not tested here**) | Owner edits the workflow in the GitHub UI (pencil icon). This is why the workflow never gained the `upgrade_dispatch.js` step that the Sprint 1 document promises |
| Detect that a file in the zip is stale | No check exists | Rule 2 |
| Run tests | The workflow does not; there is no CI (§11, issue 8) | Run them in the sandbox (§9.3) before delivering |

### 4.4 Database changes — the only supported path

Add idempotent SQL to `UPGRADE_SQL` in `backend/scripts/upgrade.js`. It runs in one transaction (failure rolls everything back, "Upgrade failed: …"). On a fresh database `migrate.js` applies the 8 files in `backend/migrations/` **then** `UPGRADE_SQL`; on an existing database the workflow runs **only** `UPGRADE_SQL`, so every later DDL change must live there **[verified]**.

Patterns in use: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `DO $$ … IF to_regclass(...) IS NULL THEN … END IF; END $$` for one-time data moves, `CREATE OR REPLACE FUNCTION`, guarded constraints (`IF NOT EXISTS (SELECT 1 FROM pg_constraint …)`). Never drop or rename a column or table: Vercel rollbacks run old code against the newer schema.

**A new table must be added to three hard-coded lists at the bottom of `UPGRADE_SQL`:**

1. the **row-level-security array** (`FOREACH t IN ARRAY ARRAY['pcr_crew', …, 'unit_vehicle_log']`) — enables RLS and the `tenant_isolation` policy. A table with a `tenant_id` column and no RLS makes the API refuse to start (locally) or answer **HTTP 503** (on Vercel) **[refusal to start is verified by a test ("refuses to start if a table holding agency data lacks row-level security"); the Vercel 503 path is code-read]**;
2. the **`GRANT SELECT, INSERT, UPDATE, DELETE ON …`** line for `ems_app_runtime`;
3. the **`REVOKE UPDATE, DELETE ON …`** line if the table is an append-only record.

A new `SECURITY DEFINER` function the app calls goes in the function array just above (`REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO ems_app_runtime`). For fresh databases also mirror any append-only revoke in `ensureRuntimeRole` in `migrate.js`.

> **Blind spot — tests cannot catch a missing grant.** Every test builds its database with `applyMigrations()` and *then* calls `ensureRuntimeRole()`, which blanket-grants the runtime role on every table. In production the role already exists, so a table created later is reachable only through the explicit lists above. A forgotten `GRANT` passes all tests and fails live with "permission denied for table …". After any DDL change, test it the production way (§9.3, "upgrade an existing database").

### 4.5 Rollback

- **Code:** Vercel dashboard ▸ Deployments ▸ pick a previous good deployment ▸ promote / instant rollback (Vercel feature, **[unverified]** here). Safe because schema changes are additive.
- **Source:** ask the chat to prepare a corrective zip from the exact earlier commit (`git show <hash>:<path>`), plus the list of files to delete. **Do not roll back by hand-uploading an old repo download** — that is how the Nov 8 rollback removed unrelated work (§13, lesson 2).

### 4.6 Everyday runbooks

| Task | How |
|---|---|
| Check what is deployed | `…/api/health` → `{ status, build, jwtKey, sessionSecret }` (`jwtKey: "missing"` is normal) |
| First-time setup of an environment | Create the GitHub secrets (§10), then run the workflow with both database boxes ticked and the company boxes filled in |
| Reset a forgotten owner password | Run the workflow with **Create / reset the company owner login** ticked and a new value in the `ADMIN_PASSWORD` secret |
| Reset someone's password or 2-step sign-in | A supervisor or IT admin does it in **Team**; a platform admin can for any company in **Platform** |
| Owner lost their phone | Use a recovery code (8 are shown once at enrolment) or have the platform admin reset their 2-step sign-in |
| Create another company | **Platform** console (platform admin): creates the company, its owner, and the default checklist and certification types (`seed_tenant_defaults`) |
| Add or rename units, vehicles, people | **Team** console. The `UNITS` input of `bootstrap.js` only matters on first setup |
| Create the platform admin | Workflow with the platform-admin email filled in and the `PLATFORM_ADMIN_PASSWORD` secret set (12+ characters); the email must differ from every company email |

---

## 5. Architecture

### 5.1 Repository layout

```text
.github/workflows/update-and-setup.yml   the only workflow (manual run)
vercel.json                              two Vercel "services": backend (Express) + web (Vite); /api/* → backend
backend/
  server.js                              Express app; /api/health; mounts routers; fails closed if isolation is not enforced
  backend_db.js                          pool, withTenant(), assertIsolationEnforced()
  backend_auth.js                        sessions, challenges, requireAuth / requireRole, platform sessions
  backend_mfa.js  backend_passwords.js   TOTP + recovery codes; scrypt hashing
  backend_dispatch.js                    unit/call lifecycle rules: allowed status moves, overrides, the call-timeline helper (used by the units and incidents routes)
  backend_geocode.js                     Census + Nominatim address search
  backend_websocket.js                   Socket.IO (disabled on Vercel; no console uses it)
  backend_routes_*.js                    one router per area (§7).  NOTE: backend_routes_example.js IS THE INCIDENTS ROUTER
  migrate.js                             first-time setup: 8 SQL files + UPGRADE_SQL, then the restricted runtime role
  migrations/*.sql                       the 8 base schema files (applied only on a fresh database)
  scripts/upgrade.js                     UPGRADE_SQL — the ONLY place for later DDL; it also applies upgrade_dispatch.js
  scripts/upgrade_dispatch.js            incident_events DDL (the call timeline) — applied by upgrade.js and migrate.js
  scripts/bootstrap.js, bootstrap_platform.js   create the company + owner / platform admin from env vars
  scripts/dev_token.js, bootstrap_example.sql    legacy helpers for the old RS256 token path
  tests/*.test.js                        isolation, api-client, auth-admin, geocode, dispatch-lifecycle (§9)
  Dockerfile, docker-compose.yml         local container setup — stale and unverified (§11, issue 4)
web/
  src/App.jsx                            sign-in (2-step), session, role → screens, demo mode
  src/api.js                             apiRequest(): bearer token, readable errors, X-Total-Count paging
  src/storage-shim.js                    maps Claude-preview window.storage to sessionStorage
  src/consoles/*.jsx                     the 10 screens (§8) plus 2 shared helpers: call_form.jsx, map_kit.jsx
  src/__tests__/render.test.jsx          55 jsdom render/interaction tests
docs/                                    master plan (spec) and DISPATCH_SPRINT1.md (inaccurate — §11, issue 1)
```

### 5.2 Multi-tenancy and the database

- **Isolation lives in the database, not in route code.** Every company-owned table has `tenant_id` and a row-level-security policy keyed on `app.current_tenant_id`, which `withTenant()` sets per transaction. Routes get isolation by using `withTenant`; no per-query tenant filter is needed. **[code, verified by 18 isolation tests]**
- **Two database logins.** The *owner* (`MIGRATION_DATABASE_URL`) runs migrations and bootstrap. The restricted *runtime* role `ems_app_runtime` (`DATABASE_URL`) runs the API; it is not a superuser and cannot bypass RLS. The API refuses to start as a role that bypasses RLS, or if a tenant table lacks RLS. On Vercel that check runs lazily per function instance and failure returns HTTP 503 **[startup refusal verified by tests; the Vercel 503 path is code-read]**.
- **Sign-in happens before the company is known**, so it goes through `SECURITY DEFINER` functions (`auth_find_user`, `auth_record_login`, `platform_*`, `email_in_use`) — the only cross-company doors. `platform_admins` is unreachable by the app except through those functions.
- **Append-only records** (the runtime role can INSERT and SELECT only): `audit_log`, `unit_status_history`, `pcr_amendments`, `controlled_substance_log`, `protocol_search_log`, `pcr_events`, `unit_checks`, `unit_check_items`, `unit_vehicle_log`. Mutual-aid links can be revoked by status change but never deleted. **[code, tests]**
- **Audit log** is hash-chained per company (`audit_chain_verify`); triggers record who changed which columns, never the values; viewing a chart or an incident is logged; a refused request is itself logged. Readable only by `compliance_officer` and `read_only_auditor`. **[verified]**
- Extensions: `pgcrypto`, `postgis`, `pg_trgm`.
- The restricted role is **cluster-wide**: the test suites call `ensureRuntimeRole()` and so **reset the password of `ems_app_runtime` on whatever Postgres they run against** **[verified]**. Never point tests at a server that also hosts a database you care about.

### 5.3 Authentication and sessions **[code; behaviour verified by tests and the live smoke test]**

1. `POST /auth/login` — email + password (scrypt, minimum 10 characters, constant-time, identical error for every account-revealing failure). Returns a short-lived *challenge*, not a session. 8 bad passwords lock the account for 15 minutes.
2. `POST /auth/mfa/verify` — 6-digit authenticator code (or a recovery code). **Two-step sign-in is mandatory for everyone**, including platform admins. First login: `/auth/mfa/setup` shows the secret/QR, `/auth/mfa/enable` verifies a code and shows 8 single-use recovery codes **once**. A TOTP code works once (replay-protected).
3. The session is an HS256 JWT signed with `SESSION_SECRET`: **12 h** for company users, **2 h** for platform admins; challenges last 5 or 15 minutes. Legacy RS256 tokens are accepted only if `JWT_PUBLIC_KEY` is set (leave it unset).
4. **TOTP secrets are encrypted with AES-256-GCM using a key derived (HKDF) from `SESSION_SECRET`. Changing that secret makes every stored authenticator secret undecryptable and locks everyone out of step 2.** Treat `SESSION_SECRET` as permanent.
5. **Every request re-checks the user in the database** (active user, active company, current role), so deactivation and role changes apply on the next request, not when the token expires.
6. Roles: `dispatcher`, `crew`, `supervisor`, `qa_qi`, `compliance_officer`, `biller`, `it_admin`, `read_only_auditor`. A person can hold several; anyone who works on a unit needs a `field_level` (`mvo`, `emt`, `aemt`, `paramedic`) and gets `crew` automatically.
7. The browser keeps the session in `localStorage["ems:session"]` (§11, issue 12).
8. **Authorization reality:** role checks exist for administration, staffing, QA, compliance, reports, audit and platform routes. **They do not exist for the dispatch routes** (§11, issue 2).

### 5.4 Real-time

`backend_websocket.js` (Socket.IO rooms per company and per incident, using the same authority check) exists but: the server skips sockets when `VERCEL` is set, only the unit-status route broadcasts, and **no console subscribes**. The consoles poll: dispatch and field-unit every 10 s (only while the tab is visible), OPS every 15 s. Scaling Socket.IO past one process would need a Redis adapter. Real push on Vercel needs a separate host or a managed pub/sub (roadmap R9).

### 5.5 Maps, routing, address search

- `GET /geocode?q=` (any signed-in user) needs **`GEOCODE_ENABLED=true`** (off by default so tests never call out). A query that starts with a house number goes to the **US Census** geocoder first (interpolates house numbers), then **OpenStreetMap Nominatim** adds places. Results say how precise they are (`address`, `street`, `place`) so the screen can warn. Creating a call geocodes automatically when no coordinates are sent. **[code, 6 tests with mocked fetch]**
- In the browser: **Leaflet 1.9.4** is loaded from cdnjs at runtime; trip preview and ETA use the **public OSRM demo server**; the traffic layer needs **`VITE_TOMTOM_KEY`** at build time and otherwise shows "Traffic: not configured". All of these are free public services with no SLA (§11, issue 9).

### 5.6 Web app

Hash-routed single page (`#/dispatch`, `#/ops`, …). `App.jsx` shows each role only its screens — **this only tidies the menu; it is not security** — and adds the ePCR screen for `emt`/`aemt`/`paramedic` field levels. A global `fetch` wrapper signs the user out on any 401 from the app's own API. A **demo mode** (sample data, nothing saved) exists for dispatch, field, ePCR and compliance. The consoles were first written against Claude's artifact preview `window.storage`; `storage-shim.js` maps it to `sessionStorage`. Styling is a mix of per-console inline colour tokens and Tailwind classes; the theme is dark.

---

## 6. Domain model and vocabulary

| Term | Meaning in this codebase |
|---|---|
| **Company / agency / tenant** | One customer. Everything below belongs to exactly one. A **platform admin** manages companies and accounts but has no route to a call or a chart |
| **Unit** | A *crewed team* ("Medic 1", "BLS 2") with a capability level `BLS`, `ALS` or `CCT`. Status: `available`, `assigned`, `en_route`, `on_scene`, `transporting`, `at_destination`, `out_of_service` |
| **Fleet vehicle** | The *physical ambulance* with a number painted on it (`fleet_vehicles`). A unit has one at a time and it can be swapped mid-shift (`unit_vehicle_log`). **Inspections belong to the vehicle.** (Nov 22 design; it replaced an earlier `unit_vehicle_history` design from Nov 8 that no longer exists) |
| `vehicles` table | **Legacy name for the unit's definition** — it holds `unit_designation` and `capability_level`. Not the ambulance. Easy to confuse with `fleet_vehicles` |
| **Crew seat** | `driver` or `non_driver`; at most 3 people per unit. An MVO always drives; an EMT/AEMT may drive on an ALS/CCT unit paired with a paramedic |
| **Staffing rule** | An ALS unit needs a paramedic to go in service; an EMT or MVO may ride with one. `reconcileUnit` keeps a unit's in-service state in step with its crew **[code, tested]** |
| **Certification** | A database trigger refuses to seat crew with a missing or lapsed certification for the unit's level |
| **Incident (call)** | `incident_type`: `emergency_911`, `ift_scheduled`, `ift_on_demand`, `mutual_aid`. `priority`: `critical`, `emergent`, `urgent`, `routine`. `capability_needed`: BLS/ALS/CCT. Has a scene and optional destination (a saved **facility** or free text) |
| **Assignment** | `incident_unit_assignments`, role `primary`, `als_intercept`, `support`, `mutual_aid`. The database guarantees one active primary per call and **one active call per unit** (partial unique indexes) |
| **Status moves** | A unit on a call moves forward only: `assigned` → `en_route` → `on_scene` → `transporting` → `at_destination`. Leaving the call is a release, a completion, or "Available" from `at_destination` (which clears the unit and leaves the call open). A unit with no call may be set `available`, `out_of_service` or `en_route` only, and going back in service needs its crew requirements met. Anything else needs an **override** by a supervisor, dispatcher or IT admin with a written reason, recorded in the audit log **[code; verified 2026-11-24]** |
| **Call timeline** | `incident_events`, append-only: `call_received`, `unit_assigned`, `unit_en_route`, `unit_on_scene`, `unit_transporting`, `unit_at_destination`, `unit_cleared`, `unit_released`, `call_closed`, `call_cancelled`. Written in the same transaction as each change; no patient data. Read with `GET /incidents/:id/events` |
| **ePCR (patient care record)** | `draft` → `submitted` → QA `approve` or `reopen` → `finalized`. One chart per (call, unit). Finalized charts are immutable, enforced by trigger and at the API. Amendments are separate rows |
| **Mutual aid** | A grant lets another company *see* a call (never write), capped at 72 hours by a CHECK constraint, revoked by status. Shared calls redact patient and contact fields |
| **Shift** | A scheduled period for a crew member, optionally on a unit; overlaps per person are refused |
| **Unit check** | A checklist run. Who does what: the driver the vehicle checks, an EMT or above the BLS equipment, the paramedic the ALS equipment |
| **Starter data** | `seed_tenant_defaults()` gives each new company certification types (EMT-B, PARAMEDIC) and a *generic* checklist; the real NYS inventory is meant to be imported by a supervisor |
| **Response-time report** | Four intervals from recorded data — dispatch, turnout, travel, response — as medians and 90th percentiles. A call with missing status taps counts as a call but has no timed intervals |

---

## 7. API map **[code]** — all routes are under `/api`

Every router except sign-in demands a valid session (`router.use(requireAuth)`); platform routes demand a platform session. "Any role" means *any signed-in person of that company*. Guards: **ADMIN** = supervisor, it_admin · **STAFFING** = supervisor, it_admin, dispatcher · **AUDIT** = compliance_officer, read_only_auditor.

| Area (file) | Routes | Who |
|---|---|---|
| Health (`server.js`) | `GET /health` → `{status, build, jwtKey, sessionSecret}` | public |
| Sign-in (`backend_routes_auth.js`) | `POST /auth/login`, `/auth/mfa/setup`, `/auth/mfa/enable`, `/auth/mfa/verify` | public (challenge token) |
| Me (`…_auth`) | `GET /auth/me` (who, unit, current call), `GET /me/stats`, `POST /auth/change-password` | any role |
| **Incidents** (`backend_routes_example.js` — **the file name is a misnomer**) | `GET /incidents` (every open call plus the last 24 h of closed ones — `?closedHours=` up to 168 — open first, capped at 500; sends `X-Server-Time`), `GET /incidents/:id/events` (the call timeline), `GET/PATCH /incidents/:id`, `POST /incidents`, `POST /incidents/:id/cancel`, `POST /incidents/:id/assignments`, `DELETE /incidents/:id/assignments/:unitId`, `POST /incidents/:id/complete` | **any role — no check** (§11, issue 2) |
| Mutual aid (same file) | `POST /mutual-aid/grants`, `POST /mutual-aid/grants/:linkId/revoke` | supervisor, compliance_officer |
| Units (`…_units`) | `GET /units`, `PATCH /units/:id/status` | any role; a user whose *primary* role is `crew` may move only their own unit |
| Unit location (`…_location`) | `PATCH /units/:id/location` | any role (own-unit rule inside) |
| Admin (`…_admin`) | `GET/POST /users`, `PATCH /users/:id`; `POST /units`, `PATCH/DELETE /units/:id`; `PATCH /vehicles/:id`; `POST /certification-types`, `POST /certifications`, `DELETE /certifications/:id` | ADMIN |
| | `GET /ops/roster`, `PUT /crew/:id/unit`, `PATCH /crew/:id/seat` | STAFFING |
| | `GET /geocode`, `GET /certification-types` | any role |
| Fleet (`…_fleet`) | `GET /fleet`; `POST /fleet`, `PATCH/DELETE /fleet/:id` | any / ADMIN |
| | `POST /fleet/:id/out-of-service`, `…/return-to-service`, `PUT /units/:id/vehicle` | STAFFING |
| Inspections (`…_inspections`) | `GET /checklist`, `GET /unit-checks/status`, `POST /unit-checks` | any role (who may run which check is enforced inside) |
| | `POST /checklist`, `PATCH /checklist/:id`, `POST /checklist/import`, `POST /unit-checks/inspection` | ADMIN |
| Facilities (`…_facilities`) | `GET /facilities`; `POST /facilities`, `PATCH /facilities/:id` | any / ADMIN |
| Schedule (`…_schedule`) | `GET /schedule?from=&to=` (both required), `POST /schedule`, `PATCH/DELETE /schedule/:id`, `POST /schedule/apply` | STAFFING |
| | `GET /schedule/mine` | any role |
| ePCR (`…_pcr`, `…_pcr_detail`, rules in `backend_pcr_access.js`) | `POST /pcr`, `GET /pcr/mine`, `GET /pcr/:id`, `PATCH /pcr/:id/narrative`, `POST /pcr/:id/vitals`, `…/procedures`, `…/medications`, `PUT …/disposition`, `DELETE /pcr/:id/{vitals,procedures,medications}/:entryId`, `POST /pcr/:id/submit` | per-chart access rules inside |
| QA (`…_qa`) | `GET /qa/charts`, `POST /pcr/:id/reopen`, `POST /pcr/:id/approve` | qa_qi |
| Compliance (`…_compliance`) | `GET /certifications`, `GET /vehicles`; `GET /pcr-review` | any role / qa_qi, compliance_officer, read_only_auditor |
| Reports (`…_reports`) | `GET /reports/response` | supervisor, it_admin, compliance_officer, read_only_auditor |
| Audit (`…_audit`) | `GET /audit`, `GET /audit/verify` | AUDIT |
| Platform (`…_platform`, platform session only) | `GET /platform/me`, `GET/POST /platform/tenants`, `PATCH /platform/tenants/:id`, `GET /platform/tenants/:id/users`, `PATCH /platform/users/:id` | platform admin |

---

## 8. Web consoles and who sees them **[code]**

`ROLE_VIEWS` in `web/src/App.jsx` decides the menu; the server decides what is allowed. A person with several roles gets every screen any of them gets; `emt`/`aemt`/`paramedic` field levels additionally get **ePCR** (MVOs drive, they do not chart).

| Screen | File (lines) | Seen by | What it does |
|---|---|---|---|
| **Dispatch** | `dispatch_console.jsx` (1055) + `call_form.jsx`, `map_kit.jsx` | dispatcher, supervisor | Live call queue and unit board, new-call form and draft tray, assign/release/complete/cancel, map with address search, trip preview, optional traffic layer. Refreshes every 10 s. Has a demo mode |
| **OPS** | `ops_console.jsx` (282) | dispatcher, supervisor, it_admin | Crew units: put people on units and seats, vehicles; refreshes every 15 s |
| **Schedule** | `schedule_console.jsx` (185) | dispatcher, supervisor, it_admin | Shifts, with overlap warnings |
| **Field Unit** | `field_unit_console.jsx` (476) | crew | Driven by `/auth/me`: your unit, your current call, status buttons, unit checks, shifts, profile and stats. Demo mode uses sample data only |
| **ePCR** | `epcr_charting.jsx` (1091) | emt, aemt, paramedic | Patient chart: vitals, procedures, medications, narrative, disposition, submit. **Patient-identifying fields are not stored encrypted (§11, issue 11)** |
| **QA/QI** | `qa_console.jsx` (142) | qa_qi | Review submitted charts, approve or send back |
| **Reports** | `reports_console.jsx` (84) | supervisor, it_admin, compliance_officer, auditor | Response-time medians and 90th percentiles |
| **Compliance** | `compliance_console.jsx` (352) | supervisor, compliance_officer, biller, auditor | Certifications and fleet are live. Per `backend/README.md`, *Investigations is demo data with no backing table* and **no screen shows the audit trail** although `GET /audit` exists **[docs — re-verify]** |
| **Team** | `team_console.jsx` (682) | supervisor, it_admin | People (roles, field levels, certifications, password and 2-step resets), units, fleet vehicles, checklists, saved places |
| **Platform** | `platform_console.jsx` (148) | platform admin only | Companies and accounts; deliberately cannot read a call or a chart |

---

## 9. Testing

### 9.1 Inventory **[verified 2026-11-23]**

| File | Tests | Covers |
|---|---|---|
| `backend/tests/isolation.test.js` | 18 | restricted runtime role; company isolation; mutual-aid sharing (read-only, 72 h cap); append-only audit and chain-of-custody; audit hash chain incl. concurrency; certification hard-block; atomic status/complete |
| `backend/tests/api-client.test.js` | 32 | incident and unit routes; PCR lifecycle and finalized-chart lock; mutual-aid role check; audit access; deactivated users, role changes and suspended companies take effect immediately; live-feed authority; **refuses to start** without RLS |
| `backend/tests/auth-admin.test.js` | 18 | two-step sign-in; multiple roles; staffing and seat rules; user editing and lists; unit checks by role; saved places; schedule; response report; unit rename/delete/retire; lockout after 8 bad passwords; resets; platform admin |
| `backend/tests/geocode.test.js` | 6 | address labelling and ordering, with `fetch` mocked |
| `backend/tests/dispatch-lifecycle.test.js` | 11 | Sprint 1 rules (assignment guard, races, status rules, board, closed-call refusal, timeline append-only). **In the `npm test` script since 2026-11-24; 11 / 11 pass (it was 1 / 11 before the restore)** |
| `web/src/__tests__/render.test.jsx` | 55 | every console rendering and basic interaction in jsdom, sign-in, role routing |

### 9.2 Blind spots — a green run does **not** prove these

1. **The `npm test` script is a hand-written list of five files.** A new test file is not run until someone adds it — that is how the dispatch tests were dropped before (§11, issue 3). R3 replaces the list with a directory run.
2. **Missing database grants** pass every test (§4.4).
3. **Tests need a disposable server**: each suite runs `DROP SCHEMA public CASCADE` on `TEST_DATABASE_URL` and resets the cluster-wide `ems_app_runtime` password (§5.2).
4. **No real browser or phone.** Web tests run in jsdom; Leaflet, OSRM, TomTom and print layouts are not exercised.
5. **Geocoding is mocked.** The live Census and Nominatim services are never called by tests.
6. **Vercel serverless mode** is only partly covered (some suites set `VERCEL=1`); the deployed topology is untested.
7. **No continuous integration** — nothing runs the tests on a push (§11, issue 8).

### 9.3 Sandbox recipe **[verified 2026-11-23, Ubuntu 24.04, run as root]**

```bash
# one-time: Postgres 16 + PostGIS
apt-get update && apt-get install -y postgresql postgresql-contrib postgresql-16-postgis-3
service postgresql start        # it can stop between tool calls — start it again when connections are refused
su postgres -c "psql -c \"CREATE ROLE ems_owner SUPERUSER LOGIN PASSWORD 'owner_pw'\""
su postgres -c "psql -c \"CREATE DATABASE ems_test OWNER ems_owner\""

git clone https://github.com/n0nam3-bot/EMS.git && cd EMS
(cd backend && npm ci) && (cd web && npm ci)

# backend: all suites, including the one the script leaves out
cd backend
export TEST_DATABASE_URL=postgres://ems_owner:owner_pw@localhost:5432/ems_test
npm test                                                                  # the scripted list
node --test --test-concurrency=1 --test-timeout=60000 tests/dispatch-lifecycle.test.js

# web
cd ../web && npm test && npm run build
```

**Test a database change the production way** (what the workflow does to an existing database): build a database from the *previous* commit (`npm run migrate`, then `node scripts/upgrade.js`, with `MIGRATION_DATABASE_URL` and `RUNTIME_DB_PASSWORD` set), check out your new code, run **only** `node scripts/upgrade.js` against that same database, run it a second time (must succeed), then start `node server.js` with `DATABASE_URL` set to the `ems_app_runtime` login and exercise the new routes. Re-set that role's password first if a test run has changed it: `ALTER ROLE ems_app_runtime PASSWORD '…'`.

Sandbox notes: `/bin/sh` is `dash` (use `bash` for scripts); background processes do not survive between tool calls; `https://api.github.com` is rate-limited for unauthenticated use; the chat's fetch tool cannot open `vercel.app` or `github.com` pages, so the live site cannot be checked from a chat.

---

## 10. Environment variables and secrets

| Where | Name | Needed | Notes |
|---|---|---|---|
| Vercel (backend) | `DATABASE_URL` | **yes** | Neon connection string for the restricted `ems_app_runtime` login. **[owner]** which string (pooled or direct) is set |
| Vercel (backend) | `SESSION_SECRET` | **yes** | 32+ random characters. Signs sessions **and keys MFA encryption** — never rotate (§5.3). `/health` → `sessionSecret: "valid"` when OK |
| Vercel (backend) | `GEOCODE_ENABLED` | for address search | Must be exactly `true`. Unset → address search returns nothing and new calls get no coordinates |
| Vercel (backend) | `ALLOWED_ORIGIN` | recommended | Site origin for CORS and Socket.IO. The app calls `/api` on its own origin by default |
| Vercel (backend) | `PG_POOL_MAX` | no | Default 3 per serverless instance on Vercel, 20 elsewhere |
| Vercel (backend) | `JWT_PUBLIC_KEY` | no | Legacy RS256 path. **Leave unset** (`/health` then shows `jwtKey: "missing"`, which is normal) |
| Vercel (backend) | `WS_REVALIDATE_MS` | no | Socket re-check interval, default 30 000 ms; not used on Vercel |
| Vercel (automatic) | `VERCEL` | auto | Switches off sockets and `listen`, and makes the isolation check lazy |
| Vercel (web build) | `VITE_API_URL` | no | Default is the site's own `/api` |
| Vercel (web build) | `VITE_TOMTOM_KEY` | optional | Public map key for the traffic layer; it is visible in the browser bundle by design |
| GitHub Actions secrets | `MIGRATION_DATABASE_URL` | **yes** | Neon **direct** string (owner role, no `-pooler`) |
| GitHub Actions secrets | `RUNTIME_DB_PASSWORD` | **yes** | Password of `ems_app_runtime`; used by `npm run migrate` on first run only |
| GitHub Actions secrets | `ADMIN_PASSWORD` | **yes** | Company owner's password (10+ characters); see the §4.2 trap |
| GitHub Actions secrets | `PLATFORM_ADMIN_PASSWORD` | if a platform admin is created | 12+ characters |
| Hard-coded in the workflow | `TENANT_ID` `610d9091-2a98-444a-8822-96370b293cfc`, `USER_ID` `3fcc880e-df88-4d68-876c-2b480074649a` | — | The first company and its owner. Not secret. Do not change; they identify the live rows |
| Tests only | `TEST_DATABASE_URL`, `NO_SHIM` | — | Disposable Postgres; `NO_SHIM=1` shows what breaks without the storage shim |

**`backend/.env.example` does not exist** although `DEPLOYMENT.md`, `backend/README.md`, `docker-compose.yml` and `migrate.js` all point to it (§11, issue 4). This table is the current list. Which of these are actually set in Vercel and GitHub is **[owner]** knowledge: a chat cannot see them.

---

## 11. Known issues (priority order)

Priority: **P0** = unsafe or wrong behaviour in the dispatch path today · **P1** = fix soon, it will bite · **P2** = hygiene. Numbers are referenced from other sections — do not renumber; append new issues at the end and mark fixed ones in §15.

### 1. Dispatch Reliability Sprint 1 was missing from the code — **restored 2026-11-24; awaiting confirmation on the live site**

**Status.** The restore is built, tested in a sandbox and delivered as an `ems-update.zip` (§15, 2026-11-24). **This issue stays open until the owner confirms on the live site:** `/api/health` shows `build` `10`, a test call can be created, and an available unit can be assigned to it. Then move it to §15 as fixed.

**What was wrong at `c767532`** (all **[verified]** 2026-11-23, by the test file and by live probes):

- the server accepted assigning an **out-of-service** unit to a call (HTTP 201);
- **completing a call twice succeeded and rewrote `closed_at`**, which corrupts response-time data;
- a unit with no call could be set straight to `on_scene` (HTTP 200);
- there was no `GET /incidents/:id/events`, no `X-Server-Time` header and no `incidents.dispatched_at`;
- the board was "newest 100", so an old open call could fall off it;
- the table `incident_events` **did not exist in any database built through the pipeline**.

`backend/tests/dispatch-lifecycle.test.js` showed it before the restore: **1 of 11 pass** (the one that passes is the unit double-booking race, which the database already prevents with a unique index). Test 10, "another company can't see…", fails at HEAD only at its first assertion, which calls the missing events endpoint — it is not an isolation breach (the isolation suite passes 18 / 18) and it passes once Sprint 1 is restored.

**How it was lost** (from git history; commit messages are useless, so these are reconstructed from diffs):

| Commit | Date | What happened |
|---|---|---|
| `1b0ecbb` | Nov 3 | Sprint 1 delivered: `backend_dispatch.js`, route changes, `upgrade_dispatch.js`, the test, `package.json` test list, `migrate.js` wiring |
| `5720fca` | Nov 3 | The "reports + schedule" update overwrote `backend_routes_example.js`, `backend_routes_units.js`, `migrate.js` and `package.json` from a base that lacked Sprint 1 — **first silent loss** |
| `8443a29` | Nov 8 | A zip re-applied Sprint 1, plus map/units/schedule work and a *different* per-unit vehicle design (`unit_vehicle_history`) |
| `22ca61b` … `cc8205e` | Nov 8 | Manual uploads, apparently of files from a ZIP download of `5720fca` (a file named `EMS-5720fca….zip` was uploaded and deleted that day), reverted that update **wholesale**: Sprint 1 again, plus the unrelated map/units/schedule work, tests and consoles — **second loss**. The reason is not recorded (§14) |

`backend/backend_dispatch.js` and `backend/scripts/upgrade_dispatch.js` were leftovers that nothing imported or ran. **No version of the workflow ever contained an `upgrade_dispatch.js` step**, although the old Sprint 1 document said it did.

**What the restore consisted of** — only the Sprint 1 delta, merged onto the current code, never whole files from old commits (the Nov 8 files carry the discarded vehicle design and would collide with `fleet_vehicles`):

1. `git diff 0375503 1b0ecbb` for `backend_routes_example.js`, `backend_routes_units.js`, `migrate.js` and `package.json`, merged three-way onto `69d4b37`. The first three applied cleanly (the newer `GET /units` with fleet-vehicle fields was kept); in `package.json` the test list gained `tests/dispatch-lifecycle.test.js`.
2. `scripts/upgrade.js` now imports and runs `UPGRADE_DISPATCH_SQL` right after `UPGRADE_SQL`. **This is the line that matters in production:** on an existing database the workflow runs only `upgrade.js`, so without it `incident_events` is never created.
3. `tests/dispatch-lifecycle.test.js`: the two expected permission failures are wrapped in `SAVEPOINT` / `ROLLBACK TO SAVEPOINT`. Before, the second statement failed with "current transaction is aborted" instead of "permission denied" — a **test bug**; the application was right.
4. `server.js`: `build` 9 → 10. `docs/DISPATCH_SPRINT1.md` rewritten to say what is true. This file updated.

**Verified in the sandbox 2026-11-24:** backend `npm test` **85 / 85** (74 existing + 11); web 55 / 55 and build OK; a database built from `69d4b37` (no `incident_events`) upgraded with **only** `node scripts/upgrade.js` from the new build gets the table with row-level security, the `tenant_isolation` policy and INSERT/SELECT-only for the app login, re-runs cleanly, and keeps its data; a live server on that database passed **20 / 20** probes — an unavailable unit is refused, a unit with no call cannot go on scene, the status chain moves forward, "Available" mid-call is refused with a plain message, clearing from at destination frees the unit and leaves the call open, a second complete and a cancel-after-close are refused with `closed_at` unchanged, `dispatched_at` is stamped, the timeline is in order, `X-Server-Time` is present.

**Not verified:** the live site (deploy, Neon, Actions); any console in a real browser or on a phone against the new refusals (**[code]**: the dispatch board and the field screen both show the server's message instead of faking a result); the dispatch-console follow-ups (R6) are still to do. **Behaviour changes** to expect are listed in `docs/DISPATCH_SPRINT1.md` — notably a unit must be staffed into service before it can be assigned, and a crew pressing Available before "at destination" is refused. **Creating a call now also writes a timeline row, so a call cannot be created until the database step has run** (issue 15). This restore does **not** fix issue 2.

### 2. The server does not enforce who may dispatch — **P0, authorization**

**[verified]** 2026-11-23, live, against HEAD with sessions minted for test users: a **`read_only_auditor`** could create a call (HTTP 201), assign a unit to it (201) and complete it (200); a **`biller`** could change any unit's status (200). As a control, `GET /audit` as a biller returned 403, so role gating works where it was applied. The same probe against the Sprint 1 recovery clone gave the same results for create, assign and complete.

Why it matters: `App.jsx` states that the server enforces what a role may do, the menus show dispatch only to dispatcher and supervisor, and the master plan (§7.3) says billers, IT admins and auditors do not see live incidents and dispatchers do not see historical patient data. In the API none of that holds for `/incidents*` and `/units/:id/status` (`backend_routes_example.js` and `backend_routes_units.js` contain no role checks; the only guard on unit status is "a user whose *primary* role is `crew` may move only their own unit"). Reads of `GET /incidents` also return patient and contact fields to every role.

Proposed fix (**[owner]** to confirm the matrix): create/patch/cancel/assign/release/complete → `dispatcher`, `supervisor`, `it_admin` (the same set that sees the call-draft tray and that Sprint 1 treats as override roles); unit status → those roles for any unit, crew only their own; decide per role what `GET /incidents` may return and strip patient/contact fields where the role has no need. Add a negative test per role to `api-client.test.js`: mint a session for a user with that role and expect 403.

### 3. `npm test` was green while skipping the dispatch tests — **fixed 2026-11-24; a weaker form remains (P1)**

The script hard-coded four files. `dispatch-lifecycle.test.js` was in it at `1b0ecbb` and was dropped when `package.json` was overwritten (`5720fca`, again `22ca61b`). Result: 74 passing tests coexisted with a broken dispatch path. **The restore puts the fifth file back in the list.** What remains: the list is still hand-written, so a new test file is silently not run until someone adds it — replace it with `node --test tests/` (R3).

### 4. Documentation is stale and some referenced files do not exist — **P1**

- `README.md`, `DEPLOYMENT.md` and `backend/README.md` were last edited on **2026-10-29**, the first day. They still say: four consoles (there are 10 screens), 50 backend tests (there are 85) and 6 web tests (55), that sign-in is a pasted development token and that there is no user management (both long since built), that crew/facilities routes are unbuilt (built), and that incidents have no BLS/ALS-needed column (it exists).
- `docs/DISPATCH_SPRINT1.md` claimed Sprint 1 was implemented while it was not; **corrected 2026-11-24** with the restore.
- `backend/.env.example` is referenced seven times and **does not exist**; §10 is the current variable list.
- `docker-compose.yml` sets no `SESSION_SECRET`, so nobody can sign in, and no `GEOCODE_ENABLED`; the Dockerfile and compose file were never built or tested **[docs]**.
- Stale comments: `backend_routes_compliance.js` says approving a chart is not built (QA approve/reopen exist in `backend_routes_qa.js`).
- The old `docs/DISPATCH_SPRINT1.md` cited **`AGENTS.md` section 3** as its "status key"; **no `AGENTS.md` has ever been committed** (history searched). The corrected document points at the evidence tags in this file instead.

### 5. The delivery pipeline fails silently in several ways — **P1**

(a) New `.sql` files are dropped without warning **[verified]**. (b) A zip cannot delete or rename, so orphans accumulate (`backend_dispatch.js` was one until 2026-11-24). (c) A zip cannot change workflow files (§4.3). (d) "Create / reset the company owner login" is ticked by default and resets the owner's password (§4.2). (e) Nothing guards against building an update from a stale copy — it happened twice (issue 1). (f) A zip uploaded but never run just sits in the repo: the Nov 17 `ems-update.zip` stayed unapplied for five days and was deleted on Nov 22; its files reached the repo through manual uploads and **nothing was lost — HEAD contains each file, identical or newer [verified]**. (g) If a database step fails — or simply finishes after Vercel has deployed — the new code runs against the old database (issue 15). (h) `scripts/upgrade.js` only runs its main block when `` import.meta.url === `file://${process.argv[1]}` ``, which works on the Linux runner but silently does nothing on Windows or in paths with spaces (`migrate.js` and `upgrade_dispatch.js` already use the robust `pathToFileURL` form). Ideas: R5.

### 6. `SESSION_SECRET` is also the MFA encryption key — **P1**

Rotating it, or setting a different value in a new environment while keeping the database, makes every stored authenticator secret undecryptable (the `v1:` format has no key id). Fix idea: introduce a separate `MFA_ENCRYPTION_KEY` that falls back to `SESSION_SECRET`, and support more than one key version so a rotation does not force re-enrolment.

### 7. The call board was "newest 100", all statuses, all fields — **board fixed by the 2026-11-24 restore (awaiting live confirmation); field exposure remains (P1)**

Before the restore `GET /incidents` was `ORDER BY call_received_at DESC LIMIT 100` with no open/closed filter, so an open call older than the 100th newest vanished from the board **[code; shown by the failing board test]**. Now it returns every open call plus calls closed in the last 24 hours (`?closedHours=`, up to 168), open calls first, capped at 500 **[verified 2026-11-24]**. Still open: `SELECT i.*` returns patient and contact fields to every role — part of issue 2.

### 8. There is no continuous integration — **P1**

Nothing runs a test on a push, and Vercel deploys whatever lands on `main`. Fix idea: a workflow with a PostGIS service container (the compose file already names `postgis/postgis:16-3.4`) running every backend suite, the web tests and the build. It must be added through the GitHub UI (§4.3).

### 9. Public free services sit in the production path — **P1**

Browser: map tiles from `tile.openstreetmap.org`, routing and ETA from the **public OSRM demo server**, Leaflet from cdnjs. Server: OSM Nominatim (usage policy: light use, an identifying User-Agent — the code sends `ems-dispatch/0.1`) and the US Census geocoder. None has an SLA and the tile and routing servers are not meant for production traffic. Before real operations: a paid or self-hosted tile/routing/geocoding provider, caching, and a visible fallback when address search fails.

### 10. Real-time push is not available on Vercel — **P2**

Polling every 10–15 s is the only mechanism (§5.4). The status-change broadcast code exists but nothing subscribes. Decide in R9 between a managed pub/sub, a separate always-on Node host, or accepting polling plus the `X-Server-Time` stale indicator.

### 11. Not ready for real patient data — **P1, standing constraint**

Per `backend/README.md` and the code **[docs, code]**: patient name/date of birth/SSN columns expect application-level encryption that does not exist; ePCR signatures need object storage (`backend_routes_pcr.js` says "Not built"); no controlled-substance chain-of-custody routes; no protocol-document routes; no confirmed hosting under a BAA (Vercel and Neon plans — **[owner]**); no independent penetration test or SOC 2 readiness work; the audit chain cannot detect deletion of the newest entry. Combined with issue 2 and the **public repository**: treat the deployment as **demo/pilot with invented data only** until the owner decides otherwise.

### 12. Browser and session hardening — **P2**

The session token lives in `localStorage["ems:session"]` (readable by any script that runs in the page); no Content-Security-Policy or other security headers are configured anywhere **[verified by search]**; there is no request-rate limiting — only the per-account lockout (8 bad passwords → 15 minutes), and per `backend/README.md` a holder of a validly signed token for a deactivated account can add "refused" entries to that company's audit log. `App.jsx` replaces `window.fetch` globally to catch 401s. Ideas: headers in `vercel.json`, short-lived tokens or httpOnly cookies, edge rate limiting.

### 13. Repository hygiene — **P2**

`.gitignore` has no `node_modules/` or `dist/` (a local `git add -A` would commit them) and ignores `*.sql` and `*.zip` (§4.3). Every commit message is "Add files via upload" or "Apply update". The five newest commits (Nov 22, 18:23–18:26) are **empty** — they changed no files **[verified]**. The repository is public.

### 14. Smaller defects and debt — **P2**

`DATE` columns reach JSON as timestamps and can be off by a day in some time zones **[docs]**. Tests reset the cluster-wide runtime-role password (§5.2). Two files are over 1,000 lines (`dispatch_console.jsx`, `epcr_charting.jsx`): whole-file replacement of such files is exactly how work got lost. Response-time intervals exist only when dispatchers assign and crews tap statuses; Sprint 1's call timeline would make them reliable (R7).

### 15. The new code can go live before the database upgrade has run — **P1**

The workflow pushes the zip's files first (Vercel starts deploying at once) and runs the database step afterwards. For a short window — a minute or two, longer if the database step fails — new code can run against the old schema. With Sprint 1 restored, `POST /incidents` writes a timeline row, so **a call cannot be created until `incident_events` exists**; assigning, releasing, completing and cancelling fail the same way. **[verified 2026-11-24]** against a database without the table: `/api/health` returned 200 with `build` 10, reads worked, and creating a call returned HTTP 500 "Internal server error" with `relation "incident_events" does not exist` in the log; the failed request rolled back cleanly (no half-saved call). **A health check therefore cannot prove this deploy** — the owner's check is to create a test call (§4.2).

This is very likely the failure the earlier Sprint 1 deliveries had: their routes wrote to a table the workflow never created **[hypothesis — §14, question 1]**. Mitigations now: run the workflow with "Set up / upgrade the database too" ticked, wait for the green tick before using the board, roll back in Vercel if calls fail (§4.5). Fixes (R5, workflow edits made by the owner in the GitHub UI): run the database upgrade *before* the commit and push, and have `/api/health` report whether the schema is current (for example whether `incident_events` exists).

---

## 12. Roadmap (proposed — the owner decides; confirm before starting large work)

Sources: the repo's own documents **[docs]** and what was verified on 2026-11-23. Order is a recommendation. Size: S under a day, M a few days, L a week or more.

### Now — make what exists safe and trustworthy

| # | Item | Why | Done when | Size |
|---|---|---|---|---|
| **R1** | **Restore Dispatch Sprint 1** (issue 1) | A dispatcher could send an out-of-service unit and close a call twice | **Delivered 2026-11-24** as an `ems-update.zip` (85 / 85 in the sandbox). **Done when the owner confirms live:** `/api/health` shows `build` 10, a test call can be created and an available unit assigned, and the timeline endpoint answers | S |
| **R2** | **Enforce roles on dispatch routes** (issue 2) | Any signed-in role can create, assign and complete calls | Matrix agreed with the owner and written into §7; a negative test per role passes; read access to patient/contact fields decided | M |
| **R3** | **Complete the test list and add CI** (issues 3, 8) | A green run hid a broken dispatch path | `npm test` runs every file in `tests/`; a workflow with a PostGIS service container runs backend tests, web tests and the build on every push (uploaded through the GitHub UI) | M |
| **R4** | **Refresh the documentation** (issue 4) | New chats and people are misled by three-week-old claims | `README.md` short, accurate and linking here; `DEPLOYMENT.md` and `backend/README.md` match §4 and §10; `backend/.env.example` exists; compose fixed or removed; `.gitignore` gains `node_modules/` and `dist/`; stale comments fixed | S |
| **R5** | **Harden the pipeline** (issues 5, 15) — workflow edits are made in the GitHub UI | Silent failure modes cost work twice | "Create / reset the company owner login" defaults to **off**; the database upgrade runs **before** the push; `/api/health` also reports whether the schema is current; a post-deploy step prints `build`; the apply step honours a deletion list (for example `ems-delete.txt`) and refuses a zip containing new `.sql` or workflow files; `upgrade.js` uses the robust main-guard | M |

### Next — finish what Sprint 1 started and close visible gaps

| # | Item | Notes | Size |
|---|---|---|---|
| **R6** | **Dispatch console reliability UI** | From Sprint 1's "not done": stale-data indicator using `X-Server-Time`, double-submit locks on assign/complete/cancel, remove the dead capability heuristic, show the server's refusal messages. **Test in a real browser and on a phone** — no such test exists | M |
| **R7** | **Reports from the call timeline** | Compute dispatch/turnout/travel/response from `incident_events` and `dispatched_at` instead of inferring them from status taps; add a per-call timeline view | M |
| **R8** | **Audit-trail screen** and a decision on the demo-data *Investigations* tab | `GET /audit` and `/audit/verify` exist; no screen shows them **[docs]** | M |
| **R9** | **Real-time decision** (issue 10) | Managed pub/sub, a separate always-on Node host, or keep polling with the stale indicator | S to decide, L to build |
| **R10** | **Mutual-aid screen and wiring** | Grant routes exist; there is no console, and the socket rooms are not connected to the grant routes **[docs]** | M |
| **R11** | **Protect the secret** (issue 6) | Separate `MFA_ENCRYPTION_KEY` with key versions so a rotation does not lock everyone out | M |
| **R12** | **Replace public free geo services** (issue 9) | A paid or self-hosted tile, routing and geocoding provider; caching; visible fallback | M |

### Later — from the master plan **[docs]**, only after the patient-data decisions in issue 11

PHI field encryption with key management · signature capture on object storage · controlled-substance chain-of-custody routes · protocol-document routes · the ePCR schema gaps named in `backend/README.md` (chief complaint, HPI, mental status, allergies, history, transport times, facility ID) · hospital pre-notification (not built — searched) · billing and RCM hooks (a `billing_exports` table exists in the schema; no route or screen uses it) · analytics beyond response times · certified NEMSIS export (the ePCR console's `generateNemsisXml` is, in its own words, "a demonstration of the mapping, not certified output"; tags are unverified against the XSD/Schematron and medications are not resolved to RxNorm) · field PWA and facility/partner portal · NG911/EIDO interoperability · BAA-capable hosting, an independent penetration test, SOC 2 readiness and alignment with the proposed HIPAA Security Rule.

**Plan status vs. build:** the build already covers most of the master plan's Phase 0 and the crew/certification/vehicle and mapping parts of Phase 1, and — ahead of the plan — multi-tenancy from Phase 2. Hospital pre-notification (Phase 1), billing hooks and analytics (Phase 2) and all of Phase 3 are not built.

---

## 13. Decisions and lessons

### Decisions to preserve (do not undo without asking)

1. **Isolation is the database's job** (row-level security), not route code. One rule, tested, covering every query.
2. **The database is the authority on every request** — no caching of the user lookup — so deactivation, role changes and suspension take effect immediately.
3. **Own sign-in as built:** password plus mandatory authenticator code, platform admins included. An external identity provider (OIDC/SSO) is an organizational decision still open **[docs]**.
4. **Append-only evidence:** audit, status history, chart amendments, unit checks, events. The app's database login cannot update or delete them.
5. **A platform admin can run companies and help with accounts but can never read a call or a chart**, and each action is recorded in the affected company's audit log.
6. **Unit ≠ vehicle** (Nov 22). Inspections belong to the vehicle; the unit keeps its crew and call history across vehicle swaps. The earlier `unit_vehicle_history` design was discarded.
7. **Database changes are idempotent JavaScript strings in `UPGRADE_SQL`** so a phone-only, zip-based pipeline can apply them.
8. **Vercel means polling.** Sockets are skipped there on purpose.
9. **Honest status labelling** in every document; same wording for any failure that could reveal whether an account exists.
10. **`/api/health` carries a hand-bumped `build` number** so a deploy can be proven (history: 3 → 5 → 6 → 7 → 8 → 9).
11. **Free public map and geocoding services for now** (zero cost, zero setup) — a conscious trade-off recorded as issue 9.

### Lessons from the project's own history

1. **Nov 3, `5720fca`:** an update built from a base without the previous update erased it, silently. Always start from HEAD.
2. **Nov 8, `22ca61b` … `cc8205e`:** rolling back by hand-uploading files from an old repository download reverted far more than intended, including the restored Sprint 1. Roll back with Vercel's rollback or a corrective zip built from an exact commit.
3. **Documents drift:** three READMEs went three weeks without an edit while the product tripled. That is why §15 exists and rule 11 says to update it with every change.
4. **A green suite can hide a skipped file.** Count the test files, not just the passes.
5. **A status document that claims "implemented" must cite the commit and the test run.** `docs/DISPATCH_SPRINT1.md` described code that did not exist.
6. **Tests find real bugs** (`backend/README.md` lists twelve, including views leaking across companies and an audit chain that forked under concurrency) — keep testing against real Postgres, not mocks.
7. From `backend/README.md`: *a fix that exists only in a running environment is not safe until it is committed somewhere durable*, and *a test that leaks a database connection when it fails does not fail — it hangs*.
8. **Very large files are the riskiest to replace whole** (`dispatch_console.jsx` 1,055 lines, `epcr_charting.jsx` 1,091). Prefer targeted edits.
9. **Ship the schema before, or together with, the code that needs it — and prove it on an existing database** (§9.3). The earlier Sprint 1 deliveries wired routes to a table the workflow never created, and a green health check cannot reveal that (issue 15).

---

## 14. Open questions for the owner

Ask these once, then record the answers in §15 and remove the question. Items 1–3 change what a chat should do next.

1. **Why was the Nov 8 update rolled back** (`22ca61b` … `cc8205e`)? What broke? It decides whether anything from `8443a29` (map/unit/schedule changes) should return, and whether the Sprint 1 restore is safe to ship on top of what is live. **Hypothesis to confirm or reject:** the Sprint 1 routes write to `incident_events`, a table the workflow never created, so creating a call would have failed live (reproduced in the sandbox as HTTP 500). If that is what you saw, the 2026-11-24 restore is built to avoid it (issue 15). **[owner]**
2. **What does `https://ems-delta-indol.vercel.app/api/health` show right now** (`build` should be `9` before the 2026-11-24 restore is applied and `10` after; `sessionSecret` should be `valid`)? Did the last "Update and set up" run finish green? **[owner]** A chat cannot see the live site, Vercel, Neon or Actions.
3. **Is this a demo or pilot with invented data, or will real patient or staff data go in?** (Issue 11 and R2 depend on it.)
4. **Is there an `AGENTS.md` outside the repo?** The old Sprint 1 document cited its section 3 ("status key"). If yes, commit it or paste it; its rules should be merged into §1.
5. **Which environment variables and secrets are actually set** in Vercel and GitHub (§10) — in particular `GEOCODE_ENABLED`, `ALLOWED_ORIGIN`, `VITE_TOMTOM_KEY`? Which Vercel and Neon plans are in use?
6. **Who may do what on dispatch?** Confirm or edit the matrix in §11, issue 2.
7. **Should the repository stay public?** (Nothing secret is committed, but the platform handles safety-critical workflows and the plan is to hold patient data.)
8. **Is polling every 10 s acceptable for dispatch, or is true real-time push a requirement?** (R9.)
9. **Do you want informative commit messages?** The GitHub upload box takes a one-line description; the chat can supply the text to paste.

---

## 15. Status log (newest first — add a line with every delivery)

| Date | Commit | Entry |
|---|---|---|
| 2026-11-24 | `69d4b37` (baseline) | **R1 delivered as `ems-update.zip`** — Dispatch Sprint 1 restored on top of the current code (§11, issue 1): the Sprint 1 delta merged into `backend_routes_example.js`, `backend_routes_units.js`, `migrate.js` and `package.json`; `scripts/upgrade.js` now applies `upgrade_dispatch.js`; the savepoint test bug fixed; `build` 9 → 10; `docs/DISPATCH_SPRINT1.md` and this file corrected. **Verified in the sandbox:** backend 85 / 85; web 55 / 55 and build OK; a production-style upgrade of a `69d4b37` database; a live probe 20 / 20; and the new code on an un-upgraded database fails call creation with HTTP 500 while `/api/health` stays green (issue 15). **Not verified: the live site** — pending the owner applying the zip. Still open: issue 2 (no role checks on dispatch), issue 15, R2–R5. `HANDOFF.md` itself was uploaded as `69d4b37` |
| 2026-11-23 | `c767532` (baseline) | **HANDOFF.md created** by a Claude chat; it is the only addition — **no application code was changed.** Verified in a sandbox (Node 22.23, PostgreSQL 16.15 + PostGIS 3.4.2): backend `npm test` 74 / 74; `dispatch-lifecycle` 1 / 11; web tests 55 / 55; web build OK; fresh-database migrate → upgrade ×2 → bootstrap ×2 OK; live smoke test 13 / 13 including MFA sign-in; `npm audit` clean. Found: Sprint 1 missing and lost twice (issue 1) with a verified recovery path giving 85 / 85; no role enforcement on dispatch writes (issue 2); stale docs and a missing `.env.example` (issue 4); pipeline traps (issue 5). Not verified: anything live (Vercel, Neon, Actions). Open questions in §14 |

---

## Appendix A — Timeline (from git; commit messages are uninformative)

| Date | Commit | What landed |
|---|---|---|
| 2026-10-29 | `48dc599` … `316c9a4` | Repo created; backend foundation, first consoles, deployment docs, `vercel.json`, database-setup workflow. Health `build: 3` |
| 2026-10-30 | `c796e1f`, `f4e7627` | "Update and set up" workflow; real sign-in (passwords, auth and admin routes), Team console, geocoding. `build: 5` |
| 2026-11-01 | `2b8203c` | Two-step sign-in (MFA), platform admin (routes + console), QA/QI (routes + console), inspections. `build: 6` |
| 2026-11-02 | `0375503` | Facilities, OPS console, call form. `build: 7` |
| 2026-11-03 | `1b0ecbb` | **Dispatch Sprint 1** delivered |
| 2026-11-03 | `5720fca` | Schedule and Reports; **silently overwrote Sprint 1.** `build: 8` |
| 2026-11-08 | `8443a29` | Zip re-applied Sprint 1 plus map, units and schedule work |
| 2026-11-08 | `22ca61b` … `cc8205e` | Manual rollback to the `5720fca` state — second loss of Sprint 1 |
| 2026-11-17 | `f0035c3` | `ems-update.zip` uploaded; the workflow was never run on it |
| 2026-11-22 | `902f7c4` … `c767532` | Zip deleted; files uploaded by hand: Census-first geocoding with precision, fleet vehicles and swaps (`fleet_vehicles`), rewritten inspections, map kit, Team and OPS updates. `build: 9`. The last five commits are empty |
| 2026-11-24 | `69d4b37` | `HANDOFF.md` added |
| 2026-11-24 | (restore zip) | Dispatch Sprint 1 restored; `build: 10` — delivered as `ems-update.zip`, awaiting live confirmation |

## Appendix B — Delivery checklist (copy into your reply and tick it)

- [ ] Started from `git clone` at HEAD; stated the commit (`git log -1 --oneline`)
- [ ] Changed only the files needed; `git diff --stat` against HEAD shows nothing unexpected
- [ ] Backend: every suite run, **including `dispatch-lifecycle`**; counts reported
- [ ] Web: `npm test` and `npm run build` run; counts reported
- [ ] Any DDL went into `UPGRADE_SQL`, with RLS, grants and revokes in the three lists (§4.4), and was tested the production way (§9.3)
- [ ] `build` in `backend/server.js` bumped; the owner told the number to expect
- [ ] Deliverable is an `ems-update.zip` with repo-relative paths; **files to delete listed**; no new `.sql`; no workflow files
- [ ] Owner's steps are tap-by-tap, and say to **untick "Create / reset the company owner login"**
- [ ] §2, §11, §12 and §15 of this file updated in the same zip if anything they say has changed
- [ ] The reply says what was **verified**, what was only **read**, and what **cannot be checked** from a chat
