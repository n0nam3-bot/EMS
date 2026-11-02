#!/usr/bin/env node
// Adds what the sign-in system and the richer call record need to an
// EXISTING database. Every statement is idempotent, so it is safe to run
// on a fresh database (after the migrations) and again on every release.
// Runs as the owner role, like the migrations.
//
//   MIGRATION_DATABASE_URL  owner connection string (direct, not pooled)
import "dotenv/config";
import pg from "pg";

export const UPGRADE_SQL = `
-- ---- Roles: a person can hold several -----------------------------------
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'qa_qi';
ALTER TABLE users ADD COLUMN IF NOT EXISTS extra_roles user_role[] NOT NULL DEFAULT '{}';
-- Field job title. NULL for people who never ride. MVO drives and can't chart.
ALTER TABLE crew_members ADD COLUMN IF NOT EXISTS field_level TEXT;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crew_members_field_level_check') THEN
        ALTER TABLE crew_members ADD CONSTRAINT crew_members_field_level_check
            CHECK (field_level IS NULL OR field_level IN ('mvo', 'emt', 'aemt', 'paramedic'));
    END IF;
END $$;
-- Existing crew-role accounts get a sensible starting level (paramedic if they
-- hold a paramedic-level certification, otherwise EMT). Only fills blanks.
UPDATE crew_members cm SET field_level = CASE WHEN EXISTS (
        SELECT 1 FROM certifications ce JOIN certification_types ct ON ct.certification_type_id = ce.certification_type_id
        WHERE ce.crew_member_id = cm.crew_member_id AND ct.required_for_capability = 'ALS') THEN 'paramedic' ELSE 'emt' END
WHERE cm.field_level IS NULL AND cm.user_id IN (SELECT user_id FROM users WHERE role = 'crew');

-- ---- Two-step sign-in (authenticator app) ---------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret_enc TEXT;       -- encrypted, never the raw secret
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT NOT NULL DEFAULT 0;  -- a code works once
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_hashes TEXT[] NOT NULL DEFAULT '{}';

-- ---- Sign-in ----------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

-- One login = one person at one company. Email is the login name, so it
-- must be unique across all companies.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));

-- Sign-in happens BEFORE we know which company the person belongs to, so
-- these two tiny functions run as the table owner (SECURITY DEFINER) to
-- look the account up by email. They return only what login needs, and
-- only the app's restricted role may call them. Everything else the app
-- does is still locked to one company by row-level security.
-- Changing what a function returns means replacing it outright.
DROP FUNCTION IF EXISTS auth_find_user(TEXT);
CREATE FUNCTION auth_find_user(p_email TEXT)
RETURNS TABLE (user_id UUID, tenant_id UUID, password_hash TEXT, role user_role, extra_roles TEXT[],
               is_active BOOLEAN, tenant_active BOOLEAN, locked_until TIMESTAMPTZ,
               mfa_enabled_at TIMESTAMPTZ, totp_secret_enc TEXT, mfa_last_step BIGINT, recovery_hashes TEXT[])
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT u.user_id, u.tenant_id, u.password_hash, u.role, u.extra_roles::text[], u.is_active, t.is_active, u.locked_until,
           u.mfa_enabled_at, u.totp_secret_enc, u.mfa_last_step, u.recovery_hashes
    FROM users u JOIN tenants t ON t.tenant_id = u.tenant_id
    WHERE lower(u.email) = lower(p_email)
    LIMIT 1
$$;

-- Counts failures and locks the account for 15 minutes after 8 in a row.
CREATE OR REPLACE FUNCTION auth_record_login(p_user UUID, p_ok BOOLEAN)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE users SET
        failed_logins = CASE WHEN p_ok THEN 0 ELSE failed_logins + 1 END,
        locked_until  = CASE WHEN p_ok THEN NULL
                             WHEN failed_logins + 1 >= 8 THEN now() + interval '15 minutes'
                             ELSE locked_until END
    WHERE user_id = p_user
$$;

REVOKE ALL ON FUNCTION auth_find_user(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_record_login(UUID, BOOLEAN) FROM PUBLIC;
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ems_app_runtime') THEN
        GRANT EXECUTE ON FUNCTION auth_find_user(TEXT) TO ems_app_runtime;
        GRANT EXECUTE ON FUNCTION auth_record_login(UUID, BOOLEAN) TO ems_app_runtime;
    END IF;
END $$;

-- ---- A call needs more than one line of text ---------------------------
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS capability_needed TEXT NOT NULL DEFAULT 'BLS';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS scene_detail TEXT;          -- room / floor / unit / cross street
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS destination_text TEXT;      -- where the patient is going
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS destination_location geography(Point, 4326);
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS patient_name TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS cancel_reason TEXT;


-- An ALS ambulance carries a paramedic AND a partner who is not one. The
-- certification rule applies to people who claim ALS-level care (paramedics, and
-- accounts with no field level recorded); EMTs, AEMTs and MVOs may ride along.
CREATE OR REPLACE FUNCTION check_crew_certification()
RETURNS TRIGGER AS $$
DECLARE
    required_cap TEXT;
    has_valid_cert BOOLEAN;
    level TEXT;
BEGIN
    SELECT v.capability_level INTO required_cap
    FROM units u JOIN vehicles v ON v.vehicle_id = u.vehicle_id
    WHERE u.unit_id = NEW.unit_id;
    SELECT field_level INTO level FROM crew_members WHERE crew_member_id = NEW.crew_member_id;
    IF level IN ('mvo', 'emt', 'aemt') THEN RETURN NEW; END IF;
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

-- ---- Charts belong to the unit that treated the patient ---------------------
ALTER TABLE patient_care_records ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES units(unit_id);
ALTER TABLE patient_care_records ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE patient_care_records ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE patient_care_records ADD COLUMN IF NOT EXISTS submitted_by_user_id UUID REFERENCES users(user_id);
ALTER TABLE patient_care_records ADD COLUMN IF NOT EXISTS assigned_to_user_id UUID REFERENCES users(user_id);
ALTER TABLE patient_care_records ADD COLUMN IF NOT EXISTS reopen_note TEXT;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pcr_status_check') THEN
        ALTER TABLE patient_care_records ADD CONSTRAINT pcr_status_check
            CHECK (status IN ('draft', 'submitted', 'reopened', 'finalized'));
    END IF;
END $$;
-- One chart per unit per call (was one per call).
ALTER TABLE patient_care_records DROP CONSTRAINT IF EXISTS patient_care_records_incident_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS pcr_one_per_incident_unit ON patient_care_records (incident_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pcr_one_unowned_per_incident ON patient_care_records (incident_id) WHERE unit_id IS NULL;

-- Once submitted, a chart is locked until QA/QI reopens it.
CREATE OR REPLACE FUNCTION prevent_finalized_pcr_edit() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'PCR % is finalized — insert into pcr_amendments instead of editing directly', OLD.pcr_id;
    END IF;
    IF OLD.status = 'submitted' AND NEW.status = 'submitted'
       AND (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
        RAISE EXCEPTION 'PCR % is submitted and locked — QA/QI must reopen it before it can change', OLD.pcr_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_finalized_pcr_child_change() RETURNS TRIGGER AS $$
DECLARE
    target_pcr UUID;
    is_final BOOLEAN;
    st TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN target_pcr := OLD.pcr_id; ELSE target_pcr := NEW.pcr_id; END IF;
    SELECT finalized_at IS NOT NULL, status INTO is_final, st FROM patient_care_records WHERE pcr_id = target_pcr;
    IF is_final THEN
        RAISE EXCEPTION 'PCR % is finalized — record this change as a pcr_amendments entry instead of altering %', target_pcr, TG_TABLE_NAME;
    END IF;
    IF st = 'submitted' THEN
        RAISE EXCEPTION 'PCR % is submitted and locked — QA/QI must reopen it before % can change', target_pcr, TG_TABLE_NAME;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Who was on the unit when the chart was started: the only people (besides QA/QI)
-- who may ever open it.
CREATE TABLE IF NOT EXISTS pcr_crew (
    pcr_id         UUID NOT NULL REFERENCES patient_care_records(pcr_id),
    tenant_id      UUID NOT NULL REFERENCES tenants(tenant_id),
    user_id        UUID NOT NULL REFERENCES users(user_id),
    crew_member_id UUID NOT NULL REFERENCES crew_members(crew_member_id),
    PRIMARY KEY (pcr_id, user_id)
);
CREATE TABLE IF NOT EXISTS pcr_events (
    event_id            BIGSERIAL PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES tenants(tenant_id),
    pcr_id              UUID NOT NULL REFERENCES patient_care_records(pcr_id),
    kind                TEXT NOT NULL CHECK (kind IN ('created', 'submitted', 'reopened', 'resubmitted', 'approved')),
    actor_user_id       UUID REFERENCES users(user_id),
    assigned_to_user_id UUID REFERENCES users(user_id),
    note                TEXT,
    at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Unit checks and inspections ----------------------------------------------
-- applies_to: BLS = every unit; ALS = ALS and CCT units; CCT = CCT units only.
CREATE TABLE IF NOT EXISTS checklist_items (
    item_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    UUID NOT NULL REFERENCES tenants(tenant_id),
    applies_to   TEXT NOT NULL DEFAULT 'BLS' CHECK (applies_to IN ('BLS', 'ALS', 'CCT')),
    category     TEXT NOT NULL,
    label        TEXT NOT NULL,
    min_quantity INT,
    sort_order   INT NOT NULL DEFAULT 0,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    source       TEXT NOT NULL DEFAULT 'custom' CHECK (source IN ('starter', 'custom', 'imported')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS unit_checks (
    check_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID NOT NULL REFERENCES tenants(tenant_id),
    unit_id              UUID NOT NULL REFERENCES units(unit_id),
    kind                 TEXT NOT NULL CHECK (kind IN ('shift_check', 'dmv_inspection', 'mechanical', 'doh_inspection', 'other')),
    performed_by_user_id UUID REFERENCES users(user_id),
    performed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    result               TEXT NOT NULL CHECK (result IN ('pass', 'fail')),
    notes                TEXT,
    next_due             DATE
);
CREATE TABLE IF NOT EXISTS unit_check_items (
    check_id  UUID NOT NULL REFERENCES unit_checks(check_id),
    tenant_id UUID NOT NULL REFERENCES tenants(tenant_id),
    item_id   UUID NOT NULL REFERENCES checklist_items(item_id),
    label     TEXT NOT NULL,   -- as it read at the time, so later edits don't rewrite history
    ok        BOOLEAN NOT NULL,
    quantity  INT,
    note      TEXT,
    PRIMARY KEY (check_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_unit_checks_unit_time ON unit_checks (unit_id, performed_at DESC);

-- Starting points for a new company. The checklist is deliberately generic:
-- the real equipment list is the agency's own (NYS DOH Part 800 inventory,
-- as currently in force) and is replaced or imported by a supervisor.
CREATE OR REPLACE FUNCTION seed_tenant_defaults(p_tenant UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    INSERT INTO certification_types (tenant_id, code, label, required_for_capability)
    VALUES (p_tenant, 'EMT-B', 'EMT-Basic', NULL), (p_tenant, 'PARAMEDIC', 'Paramedic', 'ALS')
    ON CONFLICT (tenant_id, code) DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM checklist_items WHERE tenant_id = p_tenant) THEN
        INSERT INTO checklist_items (tenant_id, applies_to, category, label, min_quantity, sort_order, source) VALUES
          (p_tenant, 'BLS', 'Vehicle', 'Exterior, tires and lights checked', NULL, 10, 'starter'),
          (p_tenant, 'BLS', 'Vehicle', 'Emergency lights and siren working', NULL, 20, 'starter'),
          (p_tenant, 'BLS', 'Vehicle', 'Fuel level adequate', NULL, 30, 'starter'),
          (p_tenant, 'BLS', 'Vehicle', 'Cot secured and operating', 1, 40, 'starter'),
          (p_tenant, 'BLS', 'Oxygen and airway', 'Oxygen supply adequate, regulator working', NULL, 50, 'starter'),
          (p_tenant, 'BLS', 'Oxygen and airway', 'Suction working', 1, 60, 'starter'),
          (p_tenant, 'BLS', 'Oxygen and airway', 'Bag-valve-mask and airway adjuncts present', NULL, 70, 'starter'),
          (p_tenant, 'BLS', 'Patient assessment', 'Blood pressure cuffs and stethoscope present', NULL, 80, 'starter'),
          (p_tenant, 'BLS', 'Patient assessment', 'AED/monitor charged and operating', 1, 90, 'starter'),
          (p_tenant, 'BLS', 'Infection control', 'PPE available and vehicle decontaminated', NULL, 100, 'starter'),
          (p_tenant, 'BLS', 'Documentation', 'Vehicle check sheet and trip records on board', NULL, 110, 'starter'),
          (p_tenant, 'ALS', 'ALS equipment', 'Cardiac monitor/defibrillator charged and tested', 1, 200, 'starter'),
          (p_tenant, 'ALS', 'ALS equipment', 'IV and advanced airway supplies stocked', NULL, 210, 'starter'),
          (p_tenant, 'ALS', 'Medications', 'Medication kit sealed and in date', 1, 220, 'starter'),
          (p_tenant, 'ALS', 'Medications', 'Controlled substances counted and logged', NULL, 230, 'starter');
    END IF;
END $$;
SELECT seed_tenant_defaults(tenant_id) FROM tenants;

-- ---- Platform administration ---------------------------------------------------
-- A separate kind of account: it runs the platform, not a company. The app's
-- database login has NO direct access to this table or to any other company's
-- rows; everything a platform admin can do goes through the narrow functions
-- below, each of which records itself in the affected company's audit log.
-- None of them reads a patient chart or a call.
CREATE TABLE IF NOT EXISTS platform_admins (
    admin_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    password_hash   TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    failed_logins   INT NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    totp_secret_enc TEXT,
    mfa_enabled_at  TIMESTAMPTZ,
    mfa_last_step   BIGINT NOT NULL DEFAULT 0,
    recovery_hashes TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_admins_email_unique ON platform_admins (lower(email));

DROP FUNCTION IF EXISTS platform_find_admin(TEXT);
CREATE FUNCTION platform_find_admin(p_email TEXT)
RETURNS TABLE (admin_id UUID, email TEXT, display_name TEXT, password_hash TEXT, is_active BOOLEAN, locked_until TIMESTAMPTZ,
               totp_secret_enc TEXT, mfa_enabled_at TIMESTAMPTZ, mfa_last_step BIGINT, recovery_hashes TEXT[])
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT a.admin_id, a.email, a.display_name, a.password_hash, a.is_active, a.locked_until,
           a.totp_secret_enc, a.mfa_enabled_at, a.mfa_last_step, a.recovery_hashes
    FROM platform_admins a WHERE lower(a.email) = lower(p_email) LIMIT 1
$$;
DROP FUNCTION IF EXISTS platform_get_admin(UUID);
CREATE FUNCTION platform_get_admin(p_id UUID)
RETURNS TABLE (admin_id UUID, email TEXT, display_name TEXT, password_hash TEXT, is_active BOOLEAN, locked_until TIMESTAMPTZ,
               totp_secret_enc TEXT, mfa_enabled_at TIMESTAMPTZ, mfa_last_step BIGINT, recovery_hashes TEXT[])
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT a.admin_id, a.email, a.display_name, a.password_hash, a.is_active, a.locked_until,
           a.totp_secret_enc, a.mfa_enabled_at, a.mfa_last_step, a.recovery_hashes
    FROM platform_admins a WHERE a.admin_id = p_id
$$;
CREATE OR REPLACE FUNCTION platform_record_login(p_admin UUID, p_ok BOOLEAN) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE platform_admins SET
        failed_logins = CASE WHEN p_ok THEN 0 ELSE failed_logins + 1 END,
        locked_until  = CASE WHEN p_ok THEN NULL WHEN failed_logins + 1 >= 8 THEN now() + interval '15 minutes' ELSE locked_until END
    WHERE admin_id = p_admin
$$;
-- NULL means "leave as is".
CREATE OR REPLACE FUNCTION platform_save_mfa(p_admin UUID, p_secret_enc TEXT, p_enable BOOLEAN, p_last_step BIGINT, p_recovery TEXT[]) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    UPDATE platform_admins SET
        totp_secret_enc = COALESCE(p_secret_enc, totp_secret_enc),
        mfa_enabled_at  = CASE WHEN p_enable THEN now() ELSE mfa_enabled_at END,
        mfa_last_step   = COALESCE(p_last_step, mfa_last_step),
        recovery_hashes = COALESCE(p_recovery, recovery_hashes)
    WHERE admin_id = p_admin
$$;

CREATE OR REPLACE FUNCTION platform_list_tenants()
RETURNS TABLE (tenant_id UUID, display_name TEXT, regulatory_state TEXT, is_active BOOLEAN, user_count BIGINT, unit_count BIGINT, created_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT t.tenant_id, t.display_name, t.regulatory_state, t.is_active,
           (SELECT count(*) FROM users u WHERE u.tenant_id = t.tenant_id),
           (SELECT count(*) FROM units n WHERE n.tenant_id = t.tenant_id), t.created_at
    FROM tenants t ORDER BY t.display_name
$$;
DROP FUNCTION IF EXISTS platform_list_users(UUID);
CREATE FUNCTION platform_list_users(p_tenant UUID)
RETURNS TABLE (user_id UUID, email TEXT, display_name TEXT, role user_role, extra_roles TEXT[], is_active BOOLEAN, mfa_enabled BOOLEAN, locked BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT u.user_id, u.email, u.display_name, u.role, u.extra_roles::text[], u.is_active, u.mfa_enabled_at IS NOT NULL,
           COALESCE(u.locked_until > now(), FALSE)
    FROM users u WHERE u.tenant_id = p_tenant ORDER BY u.display_name
$$;
CREATE OR REPLACE FUNCTION platform_create_tenant(p_name TEXT, p_state TEXT, p_authority TEXT, p_email TEXT, p_owner_name TEXT, p_owner_hash TEXT, p_admin UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    t UUID; u UUID; first_n TEXT; rest_n TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM platform_admins WHERE lower(email) = lower(p_email)) THEN
        RAISE EXCEPTION 'That email belongs to a platform admin account';
    END IF;
    INSERT INTO tenants (legal_name, display_name, regulatory_state, regulatory_region, encryption_key_ref)
    VALUES (p_name, p_name, p_state, NULL, 'not-yet-used') RETURNING tenant_id INTO t;
    INSERT INTO protocol_sets (tenant_id, issuing_authority, version_label, effective_from)
    VALUES (t, COALESCE(NULLIF(p_authority, ''), 'Local protocols'), 'initial', CURRENT_DATE);
    INSERT INTO users (tenant_id, email, display_name, role, extra_roles, password_hash)
    VALUES (t, lower(p_email), p_owner_name, 'supervisor', ARRAY['qa_qi']::user_role[], p_owner_hash) RETURNING user_id INTO u;
    first_n := split_part(p_owner_name, ' ', 1);
    rest_n := NULLIF(trim(substr(p_owner_name, length(first_n) + 1)), '');
    INSERT INTO crew_members (tenant_id, user_id, first_name, last_name) VALUES (t, u, first_n, COALESCE(rest_n, '-'));
    PERFORM seed_tenant_defaults(t);
    INSERT INTO audit_log (tenant_id, actor_user_id, action, table_name, record_id, detail)
    VALUES (t, NULL, 'platform_support', 'tenants', t, jsonb_build_object('platform_admin', p_admin::text, 'what', 'company created'));
    RETURN t;
END $$;
CREATE OR REPLACE FUNCTION platform_set_tenant_active(p_tenant UUID, p_active BOOLEAN, p_admin UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    UPDATE tenants SET is_active = p_active WHERE tenant_id = p_tenant;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    INSERT INTO audit_log (tenant_id, actor_user_id, action, table_name, record_id, detail)
    VALUES (p_tenant, NULL, 'platform_support', 'tenants', p_tenant,
            jsonb_build_object('platform_admin', p_admin::text, 'what', CASE WHEN p_active THEN 'company reactivated' ELSE 'company suspended' END));
    RETURN TRUE;
END $$;
-- Support actions on one account. NULL arguments mean "leave as is".
CREATE OR REPLACE FUNCTION platform_user_action(p_user UUID, p_admin UUID, p_password_hash TEXT, p_reset_mfa BOOLEAN, p_active BOOLEAN) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    t UUID; what TEXT[] := '{}';
BEGIN
    SELECT tenant_id INTO t FROM users WHERE user_id = p_user;
    IF t IS NULL THEN RETURN FALSE; END IF;
    IF p_password_hash IS NOT NULL THEN
        UPDATE users SET password_hash = p_password_hash, failed_logins = 0, locked_until = NULL WHERE user_id = p_user;
        what := array_append(what, 'password reset');
    END IF;
    IF p_reset_mfa THEN
        UPDATE users SET totp_secret_enc = NULL, mfa_enabled_at = NULL, mfa_last_step = 0, recovery_hashes = '{}' WHERE user_id = p_user;
        what := array_append(what, 'two-step sign-in reset');
    END IF;
    IF p_active IS NOT NULL THEN
        UPDATE users SET is_active = p_active WHERE user_id = p_user;
        what := array_append(what, CASE WHEN p_active THEN 'reactivated' ELSE 'deactivated' END);
    END IF;
    INSERT INTO audit_log (tenant_id, actor_user_id, action, table_name, record_id, detail)
    VALUES (t, NULL, 'platform_support', 'users', p_user, jsonb_build_object('platform_admin', p_admin::text, 'what', array_to_string(what, ', ')));
    RETURN TRUE;
END $$;


-- ---- Saved places (hospitals, nursing homes, dialysis...) ------------------------
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS facilities_name_unique ON facilities (tenant_id, lower(name)) WHERE is_active;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS destination_facility_id UUID REFERENCES facilities(facility_id);

-- Is this email already someone's login (a company user OR a platform admin)?
CREATE OR REPLACE FUNCTION email_in_use(p_email TEXT, p_exclude UUID) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(p_email) AND (p_exclude IS NULL OR user_id <> p_exclude))
        OR EXISTS (SELECT 1 FROM platform_admins WHERE lower(email) = lower(p_email))
$$;

-- ---- Row-level security and grants for the new tables ---------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['pcr_crew', 'pcr_events', 'checklist_items', 'unit_checks', 'unit_check_items'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation') THEN
            EXECUTE format(
                'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.current_tenant_id'')::UUID) WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'')::UUID)', t);
        END IF;
    END LOOP;
END $$;

REVOKE ALL ON FUNCTION seed_tenant_defaults(UUID) FROM PUBLIC;
DO $$
DECLARE f TEXT;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'platform_find_admin(text)', 'platform_get_admin(uuid)', 'platform_record_login(uuid,boolean)',
        'platform_save_mfa(uuid,text,boolean,bigint,text[])', 'platform_list_tenants()', 'platform_list_users(uuid)',
        'platform_create_tenant(text,text,text,text,text,text,uuid)', 'platform_set_tenant_active(uuid,boolean,uuid)',
        'platform_user_action(uuid,uuid,text,boolean,boolean)', 'email_in_use(text,uuid)'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ems_app_runtime') THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ems_app_runtime', f);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ems_app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON pcr_crew, pcr_events, checklist_items, unit_checks, unit_check_items TO ems_app_runtime;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ems_app_runtime;
        -- Records of what happened are append-only for the app.
        REVOKE UPDATE, DELETE ON pcr_events, unit_checks, unit_check_items FROM ems_app_runtime;
        REVOKE ALL ON platform_admins FROM ems_app_runtime;
    END IF;
END $$;
`;

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.MIGRATION_DATABASE_URL) { console.error("Missing MIGRATION_DATABASE_URL"); process.exit(1); }
  const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(UPGRADE_SQL);
    await client.query("COMMIT");
    console.log("Database upgrade applied.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Upgrade failed:", err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
