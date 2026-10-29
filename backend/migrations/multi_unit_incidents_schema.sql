-- =====================================================================
-- EMS Dispatch & Operations Platform — Multi-Unit Incident Schema
-- Extends ems_dispatch_core_schema.sql and mutual_aid_schema.sql
-- =====================================================================
-- The core schema modeled one unit per incident (incidents.assigned_
-- unit_id) — fine for a routine BLS transport, wrong for anything
-- needing an ALS intercept alongside a BLS primary, or an MCI needing
-- several units on one incident. This replaces the single column with
-- a real join table.
--
-- That change has a real consequence, not just an addition: the
-- mutual-aid `units` policy from mutual_aid_schema.sql reads
-- assigned_unit_id directly. Dropping that column breaks it. Section 1
-- below drops that policy FIRST — confirmed necessary by actually
-- running this migration against a real database: Postgres refused
-- the column drop with "cannot drop column ... because other objects
-- depend on it" until the policy referencing it was gone first. This
-- is what that looks like fixed, not a hypothetical ordering concern.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Replace the single-unit column with a real assignment table
-- ---------------------------------------------------------------------
-- The units policy from mutual_aid_schema.sql has to go FIRST, before
-- the column drop below — its USING clause reads incidents.assigned_
-- unit_id in a subquery, and Postgres tracks that as a real catalog
-- dependency.
DROP POLICY IF EXISTS mutual_aid_read ON units;

ALTER TABLE incidents DROP COLUMN assigned_unit_id;

CREATE TYPE incident_unit_role AS ENUM ('primary', 'als_intercept', 'support', 'mutual_aid');

CREATE TABLE incident_unit_assignments (
    assignment_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  UUID NOT NULL REFERENCES tenants(tenant_id),
    incident_id                   UUID NOT NULL REFERENCES incidents(incident_id),
    unit_id                          UUID NOT NULL REFERENCES units(unit_id),
    role                                incident_unit_role NOT NULL DEFAULT 'primary',
    assigned_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
    unassigned_at                            TIMESTAMPTZ  -- NULL means currently active on this incident
);

-- A unit can have assignment HISTORY on one incident (assigned,
-- released, reassigned later) — what it can't have is two ACTIVE rows
-- for the same incident at once. Partial unique index, not a plain
-- UNIQUE constraint, so history doesn't collide with itself.
CREATE UNIQUE INDEX idx_unique_active_assignment ON incident_unit_assignments (incident_id, unit_id) WHERE unassigned_at IS NULL;

-- Same reasoning for the business rule "only one primary unit at a
-- time" — als_intercept and support units can stack, primary can't.
CREATE UNIQUE INDEX idx_unique_active_primary ON incident_unit_assignments (incident_id) WHERE role = 'primary' AND unassigned_at IS NULL;

-- And a unit can only be working ONE incident at a time. The index
-- above stops the same unit being listed twice on the SAME incident;
-- nothing stopped a dispatcher (or a bug) putting one ambulance on two
-- live calls at once — even though this project's own docs described
-- double-booking as impossible. Found by testing that claim instead of
-- repeating it.
CREATE UNIQUE INDEX idx_unique_active_unit ON incident_unit_assignments (unit_id) WHERE unassigned_at IS NULL;

CREATE INDEX idx_incident_unit_assignments_incident ON incident_unit_assignments (incident_id) WHERE unassigned_at IS NULL;
CREATE INDEX idx_incident_unit_assignments_unit ON incident_unit_assignments (unit_id) WHERE unassigned_at IS NULL;

-- Convenience for the single most common query ("who's primary on
-- this call") — a view, not a denormalized column back on incidents.
-- A view can never drift out of sync with the table it reads; a
-- second copy of the same fact always eventually can.
-- security_invoker = true is load-bearing. A plain view runs with its
-- OWNER's privileges, and the owner is the migration role — which owns
-- every table and so bypasses row-level security. Without this, a
-- tenant session querying this view saw other tenants' assignments
-- even though the table underneath was correctly isolated. Found by
-- probing the view directly; the original tests only covered tables.
CREATE VIEW incident_primary_unit WITH (security_invoker = true) AS
SELECT incident_id, unit_id
FROM incident_unit_assignments
WHERE role = 'primary' AND unassigned_at IS NULL;

ALTER TABLE incident_unit_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON incident_unit_assignments
    USING (tenant_id = current_setting('app.current_tenant_id')::UUID)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::UUID);
-- The uniform policy above is the only thing that applies to writes.
-- Reads get one more door: an assisting tenant can SELECT the
-- assignment rows for incidents shared with it. That's required, not
-- optional — Section 2's units policy finds "units active on a shared
-- incident" by querying THIS table, and row-level security applies
-- inside policy subqueries too. The first version left this table
-- fully private, so that subquery had nothing to read for the
-- assisting tenant and the shared-units policy granted nothing at
-- all. It looked finished and was never exercised until a test did.
CREATE POLICY mutual_aid_read ON incident_unit_assignments FOR SELECT
    USING (
        incident_id IN (
            SELECT incident_id FROM mutual_aid_links
            WHERE assisting_tenant_id = current_setting('app.current_tenant_id')::UUID
              AND status = 'active'
              AND expires_at > now()
        )
    );

-- ---------------------------------------------------------------------
-- 2. Fixing the mutual-aid units policy
-- ---------------------------------------------------------------------
-- The DROP for this exact policy already happened in Section 1, out
-- of necessity — it had to run before the column it depended on could
-- be dropped. This is where it gets recreated, correctly, against
-- incident_unit_assignments instead. This version is actually more
-- correct than what it replaces: the old policy could only share the
-- single primary unit; this one shares every unit currently active on
-- the shared incident — primary, intercept, and support alike — which
-- is what an assisting dispatcher coordinating on a real multi-unit
-- call actually needs to see.
--
-- Worth being explicit about what this actually grants: once a unit
-- row is visible, every column on it is, including current_location.
-- Granting mutual aid on an incident means granting live GPS
-- visibility on the responding unit for the grant's duration — that's
-- the point of the grant, but it should be a known tradeoff for
-- whoever's approving it, not a surprise they discover later.

CREATE POLICY mutual_aid_read ON units FOR SELECT
    USING (
        unit_id IN (
            SELECT iua.unit_id FROM incident_unit_assignments iua
            JOIN mutual_aid_links mal ON mal.incident_id = iua.incident_id
            WHERE mal.assisting_tenant_id = current_setting('app.current_tenant_id')::UUID
              AND mal.status = 'active'
              AND mal.expires_at > now()
              AND iua.unassigned_at IS NULL
        )
    );

-- =====================================================================
-- Still the frontend/backend layer, not schema, and still open:
--   - Dispatch console UI still only knows how to assign one unit per
--     incident, and each incident row needs to show more than one
--   - backend_routes_example.js's incident routes now DO have
--     assignment endpoints (POST/DELETE /incidents/:id/assignments)
--     following this exact table
-- =====================================================================
