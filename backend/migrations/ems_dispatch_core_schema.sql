-- =====================================================================
-- EMS Dispatch & Operations Platform — Core Database Schema
-- PostgreSQL 15+ with PostGIS
-- =====================================================================
-- Implements the entities from Section 4 of the master plan, with:
--   - multi-tenant isolation via row-level security (Section 9)
--   - an immutable, hash-chained audit log (Section 8)
--   - database-level enforcement of key compliance rules, so they
--     can't be bypassed by a bug in the application layer (Section 10)
--
-- Run order: applies top-to-bottom on a fresh database. In production,
-- split this into versioned migrations (Flyway, sqitch, etc.) rather
-- than running it as one file.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS postgis;    -- geography/geometry types
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy search on names/addresses

-- ---------------------------------------------------------------------
-- 1. Tenancy & Auth
-- ---------------------------------------------------------------------

CREATE TABLE tenants (
    tenant_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name          TEXT NOT NULL,
    display_name        TEXT NOT NULL,
    regulatory_state    TEXT NOT NULL,        -- e.g. 'NY' — selects the regulatory profile
    regulatory_region   TEXT,                 -- e.g. 'NYC-REMSCO' — sub-state region, nullable
    encryption_key_ref  TEXT NOT NULL,        -- alias to a key in the cloud KMS, never a raw key
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM (
    'dispatcher', 'crew', 'supervisor', 'compliance_officer',
    'biller', 'it_admin', 'read_only_auditor'
);

CREATE TABLE users (
    user_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL REFERENCES tenants(tenant_id),
    external_idp_subject  TEXT,               -- subject claim from SSO/OIDC, e.g. Azure AD object ID
    email                 TEXT NOT NULL,
    display_name          TEXT NOT NULL,
    role                  user_role NOT NULL,
    mfa_enrolled          BOOLEAN NOT NULL DEFAULT FALSE,
    is_active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

-- ---------------------------------------------------------------------
-- 2. Regulatory / protocol layer — versioned, never overwritten
-- ---------------------------------------------------------------------

CREATE TABLE protocol_sets (
    protocol_set_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants(tenant_id),
    issuing_authority     TEXT NOT NULL,      -- e.g. 'NYC REMAC', 'Texas DSHS'
    version_label          TEXT NOT NULL,     -- e.g. '2026.03'
    effective_from           DATE NOT NULL,
    effective_to              DATE,           -- NULL = currently active
    document_ref               TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, version_label)
);

CREATE TABLE certification_types (
    certification_type_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 UUID NOT NULL REFERENCES tenants(tenant_id),
    code                        TEXT NOT NULL,   -- e.g. 'EMT-B', 'PARAMEDIC', 'ACLS'
    label                         TEXT NOT NULL,
    required_for_capability        TEXT,          -- e.g. 'ALS' — used by the hard-block trigger
    UNIQUE (tenant_id, code)
);

-- ---------------------------------------------------------------------
-- 3. People & assets
-- ---------------------------------------------------------------------

CREATE TABLE crew_members (
    crew_member_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id),
    user_id              UUID REFERENCES users(user_id),  -- nullable: not every crew member logs in
    first_name            TEXT NOT NULL,
    last_name              TEXT NOT NULL,
    employee_number          TEXT,
    is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE certifications (
    certification_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                UUID NOT NULL REFERENCES tenants(tenant_id),
    crew_member_id             UUID NOT NULL REFERENCES crew_members(crew_member_id),
    certification_type_id        UUID NOT NULL REFERENCES certification_types(certification_type_id),
    issuing_body                   TEXT NOT NULL,
    certificate_number               TEXT,
    issued_on                          DATE NOT NULL,
    expires_on                           DATE NOT NULL,
    verified_at                            TIMESTAMPTZ,  -- last checked against the state registry
    created_at                               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_certifications_expiry ON certifications (tenant_id, expires_on);

CREATE TABLE vehicles (
    vehicle_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 UUID NOT NULL REFERENCES tenants(tenant_id),
    unit_designation             TEXT NOT NULL,     -- e.g. 'Unit 12'
    vin                            TEXT,
    capability_level                 TEXT NOT NULL,  -- 'BLS' | 'ALS' | 'CCT'
    bariatric_equipped                 BOOLEAN NOT NULL DEFAULT FALSE,
    isolation_equipped                   BOOLEAN NOT NULL DEFAULT FALSE,
    last_inspection_date                   DATE,
    next_inspection_due                      DATE,
    is_in_service                              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE unit_status AS ENUM (
    'available', 'assigned', 'en_route', 'on_scene',
    'transporting', 'at_destination', 'out_of_service'
);

CREATE TABLE units (
    unit_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              UUID NOT NULL REFERENCES tenants(tenant_id),
    vehicle_id                UUID NOT NULL REFERENCES vehicles(vehicle_id),
    current_status               unit_status NOT NULL DEFAULT 'out_of_service',
    current_location                geography(Point, 4326),
    location_updated_at                TIMESTAMPTZ,
    shift_start                          TIMESTAMPTZ,
    shift_end                              TIMESTAMPTZ
);

CREATE INDEX idx_units_tenant_status ON units (tenant_id, current_status);
CREATE INDEX idx_units_location ON units USING GIST (current_location);
-- The GIST index is what makes "closest available unit" a fast query
-- instead of a full-table distance scan once you have real volume.

CREATE TABLE unit_crew_assignments (
    assignment_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID NOT NULL REFERENCES tenants(tenant_id),
    unit_id                 UUID NOT NULL REFERENCES units(unit_id),
    crew_member_id             UUID NOT NULL REFERENCES crew_members(crew_member_id),
    assigned_from                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_to                     TIMESTAMPTZ
);

-- ---------------------------------------------------------------------
-- 4. Facilities
-- ---------------------------------------------------------------------

CREATE TABLE facilities (
    facility_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                    UUID NOT NULL REFERENCES tenants(tenant_id),
    name                            TEXT NOT NULL,
    facility_type                     TEXT NOT NULL,  -- 'hospital' | 'nursing_home' | 'dialysis_center' ...
    address                              TEXT NOT NULL,
    location                               geography(Point, 4326),
    diversion_status                          TEXT,     -- populated from a regional feed where one exists
    diversion_status_updated_at                  TIMESTAMPTZ,
    access_notes                                   TEXT  -- gate codes, hazmat notes — the "preplan" data
);

-- ---------------------------------------------------------------------
-- 5. Incidents & dispatch
-- ---------------------------------------------------------------------

CREATE TYPE incident_type AS ENUM ('emergency_911', 'ift_scheduled', 'ift_on_demand', 'mutual_aid');
CREATE TYPE incident_priority AS ENUM ('critical', 'emergent', 'urgent', 'routine');

CREATE TABLE incidents (
    incident_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  UUID NOT NULL REFERENCES tenants(tenant_id),
    incident_type                 incident_type NOT NULL,
    priority                        incident_priority NOT NULL,
    protocol_set_id                   UUID NOT NULL REFERENCES protocol_sets(protocol_set_id),
    call_received_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatched_at                          TIMESTAMPTZ,
    scene_address                            TEXT,
    scene_location                             geography(Point, 4326),
    destination_facility_id                       UUID REFERENCES facilities(facility_id),
    assigned_unit_id                                 UUID REFERENCES units(unit_id),
    closed_at                                          TIMESTAMPTZ,
    created_at                                           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- protocol_set_id is set once, at call intake, and never changed —
-- it's what lets a chart correctly show which protocol version was
-- active on the date of care, even after REMAC issues a revision.

CREATE INDEX idx_incidents_tenant_time ON incidents (tenant_id, call_received_at);

CREATE TABLE unit_status_history (
    history_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID NOT NULL REFERENCES tenants(tenant_id),
    unit_id                    UUID NOT NULL REFERENCES units(unit_id),
    incident_id                   UUID REFERENCES incidents(incident_id),
    status                           unit_status NOT NULL,
    recorded_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Source of truth for response-time reporting. The application should
-- never update units.current_status without also inserting a row here.

CREATE INDEX idx_unit_status_history_unit_time ON unit_status_history (unit_id, recorded_at);

CREATE TABLE transport_requests (
    transport_request_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   UUID NOT NULL REFERENCES tenants(tenant_id),
    requesting_facility_id         UUID REFERENCES facilities(facility_id),
    pickup_facility_id                UUID REFERENCES facilities(facility_id),
    dropoff_facility_id                  UUID REFERENCES facilities(facility_id),
    requested_datetime                      TIMESTAMPTZ NOT NULL,
    recurrence_rule                            TEXT,   -- iCal RRULE, e.g. dialysis 3x/week
    medical_necessity_notes                       TEXT,
    linked_incident_id                               UUID REFERENCES incidents(incident_id),
    status                                              TEXT NOT NULL DEFAULT 'requested'
);

-- ---------------------------------------------------------------------
-- 6. Clinical documentation
-- ---------------------------------------------------------------------

CREATE TABLE patient_care_records (
    pcr_id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  UUID NOT NULL REFERENCES tenants(tenant_id),
    incident_id                   UUID NOT NULL UNIQUE REFERENCES incidents(incident_id),
    nemsis_version_target             TEXT NOT NULL DEFAULT '3.5.1',
    patient_last_name_enc                BYTEA,  -- app-layer encrypted; DB only ever sees ciphertext
    patient_dob_enc                         BYTEA,
    ssn_enc                                    BYTEA,
    clinical_narrative                            TEXT,
    finalized_at                                     TIMESTAMPTZ,  -- NULL until signed; immutable after
    finalized_by_user_id                                UUID REFERENCES users(user_id),
    created_at                                             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pcr_amendments (
    amendment_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 UUID NOT NULL REFERENCES tenants(tenant_id),
    pcr_id                       UUID NOT NULL REFERENCES patient_care_records(pcr_id),
    amended_by_user_id              UUID NOT NULL REFERENCES users(user_id),
    reason                             TEXT NOT NULL,
    change_description                    TEXT NOT NULL,
    created_at                               TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A finalized PCR is never edited in place (see trigger in Section 10).
-- Corrections after finalization go here, preserving the original chart.

CREATE TABLE controlled_substance_log (
    log_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  UUID NOT NULL REFERENCES tenants(tenant_id),
    incident_id                   UUID REFERENCES incidents(incident_id),
    unit_id                          UUID NOT NULL REFERENCES units(unit_id),
    crew_member_id                      UUID NOT NULL REFERENCES crew_members(crew_member_id),
    substance                              TEXT NOT NULL,
    action                                    TEXT NOT NULL,  -- 'administered' | 'wasted' | 'restocked' | 'transferred'
    quantity                                     TEXT NOT NULL,
    witness_crew_member_id                          UUID REFERENCES crew_members(crew_member_id),
    recorded_at                                        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 7. Billing
-- ---------------------------------------------------------------------

CREATE TABLE billing_exports (
    billing_export_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                   UUID NOT NULL REFERENCES tenants(tenant_id),
    incident_id                    UUID NOT NULL REFERENCES incidents(incident_id),
    payer_type                        TEXT NOT NULL,  -- 'medicare' | 'medicaid_ny' | 'commercial' | 'self_pay'
    eligibility_verified_at              TIMESTAMPTZ,
    exported_at                             TIMESTAMPTZ,
    export_batch_ref                           TEXT
);

-- ---------------------------------------------------------------------
-- 8. Immutable, hash-chained audit log
-- ---------------------------------------------------------------------

CREATE TABLE audit_log (
    audit_id        BIGSERIAL PRIMARY KEY,
    tenant_id          UUID NOT NULL REFERENCES tenants(tenant_id),
    actor_user_id          UUID,
    action                     TEXT NOT NULL,   -- 'view' | 'insert' | 'update' | 'delete' | 'export'
    table_name                    TEXT NOT NULL,
    record_id                        UUID,
    detail                               JSONB,
    occurred_at                             TIMESTAMPTZ NOT NULL DEFAULT now(),
    prev_hash                                  TEXT NOT NULL,
    row_hash                                      TEXT NOT NULL
);

CREATE INDEX idx_audit_log_tenant_time ON audit_log (tenant_id, occurred_at);

-- In production: REVOKE UPDATE, DELETE ON audit_log FROM the app's
-- database role entirely, so even a compromised application can't
-- tamper with it. That grant lives in your deployment/ops setup, not
-- this schema file, since role names vary by provider.

CREATE OR REPLACE FUNCTION audit_log_hash_chain()
RETURNS TRIGGER AS $$
DECLARE
    last_hash TEXT;
BEGIN
    SELECT row_hash INTO last_hash FROM audit_log ORDER BY audit_id DESC LIMIT 1;
    NEW.prev_hash := COALESCE(last_hash, 'GENESIS');
    NEW.row_hash := encode(
        digest(
            NEW.prev_hash || NEW.tenant_id::TEXT || NEW.action || NEW.table_name ||
            COALESCE(NEW.record_id::TEXT, '') || NEW.occurred_at::TEXT,
            'sha256'
        ),
        'hex'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_hash
    BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_hash_chain();
-- Known limitation to harden before real go-live: concurrent inserts
-- can race on "read the last hash." Fix with SERIALIZABLE isolation
-- on this table or an advisory lock around the insert path — flagging
-- rather than solving here so it isn't glossed over.

-- ---------------------------------------------------------------------
-- 9. Row-level security — tenant isolation
-- ---------------------------------------------------------------------
-- This is the mechanism that actually enforces "no company sees
-- another company's data." Applied identically to every tenant-scoped
-- table via a loop, so no table can be accidentally left uncovered.
--
-- The application sets this once per request/transaction, immediately
-- after authenticating the user and resolving their tenant server-side
-- — never let the client supply this value directly:
--   SET LOCAL app.current_tenant_id = '<tenant-uuid-from-session>';

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'users', 'protocol_sets', 'certification_types', 'crew_members',
        'certifications', 'vehicles', 'units', 'unit_crew_assignments',
        'facilities', 'incidents', 'unit_status_history',
        'transport_requests', 'patient_care_records', 'pcr_amendments',
        'controlled_substance_log', 'billing_exports', 'audit_log'
    ]
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                USING (tenant_id = current_setting(''app.current_tenant_id'')::UUID)
                WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'')::UUID);',
            t
        );
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 10. Business rules enforced at the database layer
-- ---------------------------------------------------------------------
-- Belt-and-suspenders: these rules should also be checked in the app
-- for a good error message, but they're enforced here so a bug in the
-- app layer can't silently violate them.

-- Rule: don't assign a crew member to an ALS-capable unit unless they
-- hold a current, non-expired ALS-level certification.
CREATE OR REPLACE FUNCTION check_crew_certification()
RETURNS TRIGGER AS $$
DECLARE
    required_cap TEXT;
    has_valid_cert BOOLEAN;
BEGIN
    SELECT v.capability_level INTO required_cap
    FROM units u JOIN vehicles v ON v.vehicle_id = u.vehicle_id
    WHERE u.unit_id = NEW.unit_id;

    IF required_cap = 'ALS' THEN
        SELECT EXISTS (
            SELECT 1 FROM certifications c
            JOIN certification_types ct ON ct.certification_type_id = c.certification_type_id
            WHERE c.crew_member_id = NEW.crew_member_id
              AND ct.required_for_capability = 'ALS'
              AND c.expires_on >= CURRENT_DATE
        ) INTO has_valid_cert;

        IF NOT has_valid_cert THEN
            RAISE EXCEPTION 'Crew member % has no current ALS-level certification — cannot assign to unit %',
                NEW.crew_member_id, NEW.unit_id;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_crew_certification
    BEFORE INSERT ON unit_crew_assignments
    FOR EACH ROW EXECUTE FUNCTION check_crew_certification();
-- Simplified for illustration — a real ruleset would also cover BLS
-- minimums, per-seat role requirements, and state-specific variants.

-- Rule: a finalized PCR can never be edited directly — corrections
-- must go through pcr_amendments instead.
CREATE OR REPLACE FUNCTION prevent_finalized_pcr_edit()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'PCR % is finalized — insert into pcr_amendments instead of editing directly',
            OLD.pcr_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_finalized_pcr_edit
    BEFORE UPDATE ON patient_care_records
    FOR EACH ROW EXECUTE FUNCTION prevent_finalized_pcr_edit();

-- =====================================================================
-- Deliberately not included in this pass — say the word and I'll add
-- any of these next:
--   - response-zone polygons for the unit-recommendation engine
--   - the cross-tenant mutual-aid sharing tables (Section 3.3 of plan)
--   - a NEMSIS v3.5.x export view over patient_care_records
-- =====================================================================
