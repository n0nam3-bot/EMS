-- =====================================================================
-- EMS Dispatch & Operations Platform — Mutual Aid Cross-Tenant Schema
-- Extends ems_dispatch_core_schema.sql
-- =====================================================================
-- Implements Section 3.3 of the master plan: hard isolation by default,
-- with a governed, time-boxed, fully audited exception for a specific
-- incident when one agency explicitly grants another visibility.
--
-- The core schema gives every table one uniform policy: your tenant's
-- rows, for every command. Mutual aid needs a second answer on a few
-- tables — "who else has been granted a reason to SEE this" — and how
-- it's expressed matters. Each sharing exception here is its own
-- FOR SELECT policy, layered on top of the uniform one. Permissive
-- policies combine with OR per command, so a grant widens what the
-- assisting tenant can READ and nothing else: updates and deletes
-- still only ever match the assisting tenant's own rows.
--
-- The first version of this file instead REPLACED the uniform policy
-- with one whose USING clause included the sharing test. USING applies
-- to every command, so a read-sharing grant also let the assisting
-- agency DELETE the owner's rows wherever no foreign key happened to
-- stand in the way — confirmed by deleting another tenant's
-- unit_status_history in a test. tests/isolation.test.js now fails if
-- any grant-based policy applies to anything but SELECT.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The grant itself
-- ---------------------------------------------------------------------

CREATE TYPE mutual_aid_status AS ENUM ('active', 'expired', 'revoked');

CREATE TABLE mutual_aid_links (
    link_id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requesting_tenant_id         UUID NOT NULL REFERENCES tenants(tenant_id),  -- owns the incident, is asking for help
    assisting_tenant_id             UUID NOT NULL REFERENCES tenants(tenant_id),  -- being granted visibility, nothing more
    incident_id                        UUID NOT NULL REFERENCES incidents(incident_id),
    granted_by_user_id                    UUID NOT NULL REFERENCES users(user_id),
    reason                                    TEXT NOT NULL,
    status                                       mutual_aid_status NOT NULL DEFAULT 'active',
    granted_at                                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at                                         TIMESTAMPTZ NOT NULL,
    revoked_at                                            TIMESTAMPTZ,
    revoked_by_user_id                                       UUID REFERENCES users(user_id),
    CONSTRAINT different_tenants CHECK (requesting_tenant_id <> assisting_tenant_id),
    -- Time-boxed by construction, not by policy someone has to remember
    -- to enforce: nothing gets granted for more than 72 hours without
    -- a fresh, explicit re-grant.
    CONSTRAINT max_grant_window CHECK (expires_at <= granted_at + INTERVAL '72 hours')
);

CREATE INDEX idx_mutual_aid_links_incident ON mutual_aid_links (incident_id);

-- The dual-visibility case the rest of the schema's simple loop can't
-- express: both sides of a grant need to see the grant row, but only
-- the requesting side can create one — you can't grant access on
-- someone else's behalf.
ALTER TABLE mutual_aid_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY mutual_aid_link_owner ON mutual_aid_links
    USING (requesting_tenant_id = current_setting('app.current_tenant_id')::UUID)
    WITH CHECK (requesting_tenant_id = current_setting('app.current_tenant_id')::UUID);
CREATE POLICY mutual_aid_link_assisting_read ON mutual_aid_links FOR SELECT
    USING (assisting_tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ---------------------------------------------------------------------
-- 2. Extending incident visibility — the actual isolation exception
-- ---------------------------------------------------------------------
-- The uniform tenant_isolation policy the core schema's DO-block
-- generated for `incidents` stays exactly as it is. This adds one
-- more policy beside it, and it only ever applies to SELECT.

CREATE POLICY mutual_aid_read ON incidents FOR SELECT
    USING (
        incident_id IN (
            SELECT incident_id FROM mutual_aid_links
            WHERE assisting_tenant_id = current_setting('app.current_tenant_id')::UUID
              AND status = 'active'
              AND expires_at > now()
        )
    );
-- A grant gives read visibility for coordination, never write access
-- to someone else's incident. The assisting agency logs their own
-- involvement as their own incident (see linked_external_incident_id
-- below), not as an edit to the requesting agency's record.

-- How the assisting agency records their own participation: their own
-- incident row, of type 'mutual_aid' (already in the core schema's
-- incident_type enum), cross-referenced back to the shared event. Left
-- as a plain UUID rather than a foreign key — a strict FK here runs
-- into real Postgres RLS/FK interaction issues when the referenced row
-- belongs to a different tenant's visibility scope, and enforcing the
-- link's validity at the application layer avoids that entirely.
ALTER TABLE incidents ADD COLUMN linked_external_tenant_id UUID REFERENCES tenants(tenant_id);
ALTER TABLE incidents ADD COLUMN linked_external_incident_id UUID;

-- ---------------------------------------------------------------------
-- 3. Extending audit visibility — so a grant is never a blind spot
-- ---------------------------------------------------------------------
-- If you grant someone temporary access to your data, you should be
-- able to see when they used it. Audit entries stay written under the
-- actor's own tenant_id (no cross-tenant writes needed), but the data
-- owner gets read visibility into entries about their own incident —
-- deliberately not restricted to only currently-active grants, since
-- audit history should outlive the grant that produced it.

CREATE POLICY mutual_aid_read ON audit_log FOR SELECT
    USING (
        table_name = 'incidents'
        AND record_id IN (
            SELECT incident_id FROM mutual_aid_links
            WHERE requesting_tenant_id = current_setting('app.current_tenant_id')::UUID
        )
    );

-- ---------------------------------------------------------------------
-- 4. Extending unit visibility — so coordination isn't just "trust us"
-- ---------------------------------------------------------------------
-- The next increment flagged when this file was first written, now
-- built. Scoped tighter than "share the whole fleet": the assisting
-- agency sees only the specific unit actually assigned to the shared
-- incident, not the requesting agency's other units — same
-- least-privilege reasoning as the incidents policy above.
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
            SELECT i.assigned_unit_id FROM incidents i
            JOIN mutual_aid_links mal ON mal.incident_id = i.incident_id
            WHERE mal.assisting_tenant_id = current_setting('app.current_tenant_id')::UUID
              AND mal.status = 'active'
              AND mal.expires_at > now()
              AND i.assigned_unit_id IS NOT NULL
        )
    );

CREATE POLICY mutual_aid_read ON unit_status_history FOR SELECT
    USING (
        incident_id IN (
            SELECT incident_id FROM mutual_aid_links
            WHERE assisting_tenant_id = current_setting('app.current_tenant_id')::UUID
              AND status = 'active'
              AND expires_at > now()
        )
    );

-- =====================================================================
-- Example flow
-- =====================================================================
-- 1. Agency A's supervisor grants Agency B visibility into a specific
--    incident:
--    INSERT INTO mutual_aid_links
--      (requesting_tenant_id, assisting_tenant_id, incident_id,
--       granted_by_user_id, reason, expires_at)
--    VALUES ('<A>', '<B>', '<incident>', '<A-supervisor-user>',
--            'MCI mutual aid — I-95 MVC', now() + interval '12 hours');
--
-- 2. Agency B's dispatcher (session set to tenant B) can now SELECT
--    that one incident row — nothing else of Agency A's.
--
-- 3. Agency B logs their own responding unit as their own incident,
--    type 'mutual_aid', with linked_external_tenant_id = A and
--    linked_external_incident_id = the shared incident.
--
-- 4. Agency A's compliance officer later queries audit_log and can see
--    exactly which Agency B users viewed the incident and when — the
--    grant didn't create a blind spot in their own audit trail.
--
-- 5. Agency B's dispatcher can now also see that one responding unit
--    from Agency A on their own board — live status and location,
--    scoped to just that unit, for just as long as the grant lasts.
--
-- Deliberately still not extended, as a boundary rather than an
-- oversight: `patient_care_records` never inherits visibility through
-- a mutual_aid_link, even for a jointly-treated patient. Clinical
-- record sharing across agencies is a real BAA/legal question between
-- the two organizations, not something a database policy should
-- quietly decide on their behalf.
-- =====================================================================
