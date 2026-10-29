# Deployment

## Quickest path to see it working

Fake data, about 15 minutes, on a computer with a terminal — a laptop, a cloud server, or a browser-based cloud shell. These commands can't be run from a phone on its own.

1. Install Node 20+ and PostgreSQL 15+ **with PostGIS**.
2. Create an empty database and an owner login for it.
3. `cd backend && cp .env.example .env` and fill it in (section 1). `.env.example` already allows the web dev server's address.
4. `npm ci && npm run migrate`
5. Edit and run `scripts/bootstrap_example.sql` (section 2).
6. Make a development key and token (section 5) and put the public key in `.env`.
7. `npm start` — then in a second terminal: `cd ../web && npm ci && npm run dev`.
8. Open the address Vite prints, pick a console, click **API**, enter `http://localhost:3000/api` and your token.

Everything below is the same thing in more detail, and what to do beyond a trial.

## What you need

- **Node.js 20+** (22 was used for testing).
- **PostgreSQL 15+ with PostGIS.** Managed options that support it: AWS RDS, Google Cloud SQL, Azure Database for PostgreSQL. The migration role must be allowed to `CREATE EXTENSION` for `postgis`, `pgcrypto` and `pg_trgm`.
- A domain and **TLS** in front of both the API and the web app.
- An **identity provider** — not built yet. Until it is, you can test with development tokens (section 5); you must not run real patient data that way.

## 1. Database

1. Create an empty database and an **owner** (migration) role.
2. `cd backend && cp .env.example .env`, then fill in `MIGRATION_DATABASE_URL` (the owner), `DATABASE_URL` (the runtime role, `ems_app_runtime`), `RUNTIME_DB_PASSWORD` (its password — must match the one in `DATABASE_URL`), `JWT_PUBLIC_KEY`, and `ALLOWED_ORIGIN`.
3. `npm ci && npm run migrate`. This applies the eight schema files in order and creates the restricted `ems_app_runtime` role.

**The API must connect as `ems_app_runtime`, never as the owner.** Table owners bypass row-level security, so an API running as the owner has every isolation rule silently switched off.

## 2. Your first agency and users

The database starts empty, and a token is accepted only for a user who exists, is active, and belongs to an active agency. Edit `backend/scripts/bootstrap_example.sql` (agency name, protocol authority, emails, and real UUIDs from `SELECT gen_random_uuid();`) and run it once as the owner:

    psql "$MIGRATION_DATABASE_URL" -f scripts/bootstrap_example.sql

A user's role comes from `users.role` in the database, not from the token. To deactivate someone: `UPDATE users SET is_active = false WHERE ...` — it takes effect on their next request, and an open live-feed connection is cut off within `WS_REVALIDATE_MS`.

### Adding another company

Each company is its own `tenants` row with its own users. Run the same bootstrap SQL again with new UUIDs and names. The database keeps their data apart: one company cannot list, open or change another's calls, charts, units or audit entries — including by guessing an exact ID, which returns "not found". (Tested, and demonstrated on two companies set up this way.)

Understand three things before hosting more than one:
- The **only** sharing is mutual aid: a supervisor can grant another company read-only access to one specific incident for up to 72 hours. It can be revoked, and the owner can see when it was viewed. Patient charts are never shared.
- All companies share one database and one server. Separation is enforced by database rules, not by separate machines or separate encryption keys (PHI encryption — where per-company keys would come in — isn't built).
- If you host other companies' data you become their vendor: each will need a business associate agreement with you, and you with your host.

## 3. The API

Environment (see `backend/.env.example`): `DATABASE_URL`, `JWT_PUBLIC_KEY`, `ALLOWED_ORIGIN`, `PORT`, optionally `WS_REVALIDATE_MS`.

    cd backend && npm ci --omit=dev && npm start

- Check `GET /health`.
- The API checks at startup and **refuses to run** — printing why — if its database role would let companies see each other's data (a superuser, a table owner, or a BYPASSRLS role) or if a table holding company data lacks row-level security. If you see "Refusing to start", fix `DATABASE_URL`: it must be the `ems_app_runtime` role.
- Run **exactly one instance** — the live feed keeps its state in memory.
- Your reverse proxy must **pass WebSocket upgrades** to the API.
- `ALLOWED_ORIGIN` must equal the web app's origin exactly (scheme, host and port); it governs both the API and the live feed.
- `backend/Dockerfile` builds the API image; `docker-compose.yml` is for **local development** (Postgres + API). Neither has been built by me.

## 4. The web app

    cd web && npm ci && npm run build

Serve `web/dist` from any static host (it uses hash routes, so no rewrite rules are needed). Open a console, click **API**, enter the base URL **including `/api`** (for example `https://api.example.com/api`) and a session token. Pasting a token is a development convenience: it is kept in `sessionStorage` (cleared when the tab closes), and real sign-in should replace it.

Pages: `#/dispatch`, `#/field` (meant for a tablet in the vehicle), `#/compliance`, `#/epcr`.

## 5. Trying it without an identity provider (testing only)

    openssl genrsa -out dev_private.pem 2048
    openssl rsa -in dev_private.pem -pubout -out dev_public.pem
    # put dev_public.pem in JWT_PUBLIC_KEY (see .env.example for the format)
    node scripts/dev_token.js dev_private.pem <tenant-uuid> <user-uuid>

Anyone holding that private key can become any user of any agency. Never use it in production, and never keep it on a server that holds real data.

## Before real patient data

Everything under "Before real use" in the top-level README, plus: backups and point-in-time recovery for the database; log shipping and alerting; rate limiting; a retention policy for the audit log; secrets in a secrets manager rather than files; and a review of whether your host will sign a BAA.
