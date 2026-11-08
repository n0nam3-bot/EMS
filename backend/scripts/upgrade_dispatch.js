#!/usr/bin/env node
// Dispatch reliability upgrade (Sprint 1). Idempotent: safe on a fresh database
// (migrate.js applies it after the other upgrades) and on every release against an
// existing one (the "Update and set up" workflow runs this file).
//
//   MIGRATION_DATABASE_URL  owner connection string (direct, not pooled)
import "dotenv/config";
import path from "path";
import { pathToFileURL } from "url";
import pg from "pg";

export const UPGRADE_DISPATCH_SQL = `
-- A durable, append-only timeline for each call. Response-time reporting and the
-- ePCR times should read from here and from unit_status_history, never be rebuilt
-- from a unit's current status. Rows are written by the API in the same
-- transaction as the change they describe.
CREATE TABLE IF NOT EXISTS incident_events (
    event_id        BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(tenant_id),
    incident_id     UUID NOT NULL REFERENCES incidents(incident_id),
    unit_id         UUID REFERENCES units(unit_id),
    kind            TEXT NOT NULL CHECK (kind IN (
                      'call_received', 'unit_assigned', 'unit_en_route', 'unit_on_scene', 'unit_transporting',
                      'unit_at_destination', 'unit_cleared', 'unit_released', 'call_cancelled', 'call_closed')),
    actor_user_id   UUID,
    override_reason TEXT,
    note            TEXT,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_events_incident ON incident_events (incident_id, event_id);
-- The dispatch board asks for open calls on every poll.
CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents (tenant_id, call_received_at DESC) WHERE closed_at IS NULL;

ALTER TABLE incident_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'incident_events' AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON incident_events
            USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
            WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);
    END IF;
END $$;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ems_app_runtime') THEN
        GRANT SELECT, INSERT ON incident_events TO ems_app_runtime;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ems_app_runtime;
        REVOKE UPDATE, DELETE ON incident_events FROM ems_app_runtime;
    END IF;
END $$;
`;

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.env.MIGRATION_DATABASE_URL) { console.error("Missing MIGRATION_DATABASE_URL"); process.exit(1); }
  const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(UPGRADE_DISPATCH_SQL);
    await client.query("COMMIT");
    console.log("Dispatch upgrade applied.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Dispatch upgrade failed:", err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
