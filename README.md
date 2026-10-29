# EMS Dispatch & Operations Platform

Multi-tenant dispatch (CAD) and ePCR charting for ground ambulance agencies: PostgreSQL + PostGIS with row-level security isolating each agency, a Node/Express API with an audit trail and a WebSocket live feed, and four React consoles (dispatch, field unit, compliance, ePCR).

**Status: a tested foundation, not a finished product — and not ready for real patient data.** See "Before real use" below.

## In this folder

| | |
|---|---|
| `DEPLOYMENT.md` | Step by step: database, first agency and user, API, web app |
| `backend/` | The API, the database schema (`migrations/`), tests, Docker files, `scripts/` |
| `web/` | The four consoles as a runnable web project (Vite + React + Tailwind) |
| `docs/` | The original design plan — the reasoning behind the architecture. The READMEs, not the plan, are the source of truth for what exists today |

`backend/README.md` is the detailed one: everything verified, every defect testing found, everything not built.

## What has been proven

- **50 backend tests** pass against real Postgres 16 + PostGIS: tenant isolation (tables, views, mutual-aid sharing — plus a startup check that refuses to run in the one configuration that would merge agencies' data), append-only audit evidence, business rules enforced by the database, the dispatch loop, the audit trail, authentication against the database, and the live feed.
- **6 render tests** drive each console in a browser-like environment, and the production build succeeds.
- **The first-run path works from nothing:** an empty database, `npm run migrate`, the bootstrap SQL, and a minted token produce a working API.

## What has not

- The Dockerfile and `docker-compose.yml` have **never been built** — there was no Docker where this was made. Only the `npm ci --omit=dev` step they rely on was checked.
- The consoles have **never been opened in a real browser, phone or tablet**, and their look outside Claude's preview isn't verified. The map and distance features need internet access from the user's browser.
- A single API instance only: scaling past one needs a Redis adapter that isn't built.

## Before real use

Not optional for real patient data: an **identity provider** (sign-in is a pasted token today); **encryption of patient name, DOB and SSN** (the columns expect it; nothing does it); **user management** (there is no route or screen — it's SQL); an independent **penetration test**; a HIPAA-eligible host under a **BAA**, backups, monitoring and TLS. The ePCR **AI narrative buttons won't work** outside Claude until the API proxies them (a browser can't hold the key). `backend/README.md` lists the rest.
