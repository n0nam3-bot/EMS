-- =====================================================================
-- EMS Dispatch & Operations Platform — Audit Trail
-- Extends ems_dispatch_core_schema.sql (audit_log) and the tables below
-- =====================================================================
-- audit_log and its hash-chain trigger have existed since the first
-- schema, but nothing ever wrote to it: no route recorded a view, an
-- export or a change. This is the half that makes it real.
--
-- Design, and why:
--
-- WRITES are caught by row triggers, not by remembering to log inside
-- each route. A route someone adds next year can't forget to log what
-- the database logs itself, and the trigger also sees changes made by
-- any other code path, including an administrator's.
--
-- An entry names WHICH COLUMNS changed and never their values. Copying
-- a patient's data into the log would create a second copy of it with
-- weaker protection than the record it describes.
--
-- READS can't be trapped by a trigger. The routes record those
-- explicitly (backend_audit.js), in the same transaction as the read:
-- if the entry can't be written, the data isn't served.
--
-- THE HASH CHAIN needed three repairs before it meant anything:
--   1. Its hash covered neither the actor nor the detail, so rewriting
--      who did something or what changed left the hash untouched. Both
--      are in the digest now.
--   2. Two concurrent writes for one tenant could read the same "last
--      hash" and fork the chain (a limitation the core schema flagged).
--      Writes are now serialized per tenant with an advisory lock held
--      until commit, and the entry's sequence number is taken UNDER that
--      lock — otherwise sequence order and chain order can disagree.
--   3. The old digest embedded a timestamp rendered in the session's
--      time zone, so the same row would hash differently from a session
--      set to another zone. It's rendered in UTC now.
-- audit_chain_verify() and the trigger share audit_row_digest(), so the
-- two formulas cannot drift apart.
--
-- Known limits, stated rather than hidden:
--   * Deleting the NEWEST entry leaves no successor to expose it.
--     Closing that needs the latest hash anchored somewhere the
--     database owner can't reach (an external timestamping service).
--   * Chains are per tenant: reads are tenant-scoped, and a global chain
--     would let one tenant's writes influence another's hashes.
--   * Rows written under the earlier formula would fail verification.
--     None exist — nothing wrote to the log before this migration.
-- =====================================================================

CREATE OR REPLACE FUNCTION audit_row_digest(
    p_prev TEXT, p_tenant UUID, p_actor UUID, p_action TEXT, p_table TEXT,
    p_record UUID, p_detail JSONB, p_at TIMESTAMPTZ
) RETURNS TEXT AS $$
    SELECT encode(digest(
        p_prev || '|' || p_tenant::text || '|' || COALESCE(p_actor::text, '') || '|' || p_action
        || '|' || p_table || '|' || COALESCE(p_record::text, '') || '|' || COALESCE(p_detail::text, '')
        || '|' || to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
        'sha256'), 'hex');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION audit_log_hash_chain()
RETURNS TRIGGER AS $$
DECLARE
    last_hash TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('audit_chain:' || NEW.tenant_id::text, 0));
    NEW.audit_id := nextval(pg_get_serial_sequence('audit_log', 'audit_id'));
    SELECT row_hash INTO last_hash FROM audit_log
    WHERE tenant_id = NEW.tenant_id ORDER BY audit_id DESC LIMIT 1;
    NEW.prev_hash := COALESCE(last_hash, 'GENESIS');
    NEW.row_hash := audit_row_digest(NEW.prev_hash, NEW.tenant_id, NEW.actor_user_id, NEW.action,
                                     NEW.table_name, NEW.record_id, NEW.detail, NEW.occurred_at);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE INDEX idx_audit_log_tenant_chain ON audit_log (tenant_id, audit_id DESC);

CREATE OR REPLACE FUNCTION audit_chain_verify(p_tenant UUID)
RETURNS TABLE (audit_id BIGINT, problem TEXT) AS $$
    WITH ordered AS (
        SELECT a.audit_id, a.tenant_id, a.actor_user_id, a.action, a.table_name, a.record_id,
               a.detail, a.occurred_at, a.prev_hash, a.row_hash,
               LAG(a.row_hash) OVER (ORDER BY a.audit_id) AS expected_prev
        FROM audit_log a
        WHERE a.tenant_id = p_tenant
    )
    SELECT o.audit_id,
           CASE WHEN o.prev_hash IS DISTINCT FROM COALESCE(o.expected_prev, 'GENESIS')
                THEN 'prev_hash does not match the preceding entry'
                ELSE 'row_hash does not match this entry''s contents' END
    FROM ordered o
    WHERE o.prev_hash IS DISTINCT FROM COALESCE(o.expected_prev, 'GENESIS')
       OR o.row_hash <> audit_row_digest(o.prev_hash, o.tenant_id, o.actor_user_id, o.action,
                                         o.table_name, o.record_id, o.detail, o.occurred_at)
    ORDER BY o.audit_id;
$$ LANGUAGE sql STABLE;

-- The actor comes from app.current_user_id, set per transaction by
-- withTenant() alongside the tenant. Missing means unattributed (NULL),
-- not refused — an administrator's seed script has no session user —
-- and tests/api-client.test.js asserts that every write made through the
-- API IS attributed, including under heavy concurrency.
CREATE OR REPLACE FUNCTION audit_row_change()
RETURNS TRIGGER AS $$
DECLARE
    pk_col TEXT := TG_ARGV[0];
    j JSONB;
    v_changed JSONB;
    v_detail JSONB := '{}'::jsonb;
    v_tenant UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        j := to_jsonb(OLD);
    ELSE
        j := to_jsonb(NEW);
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF to_jsonb(OLD) = j THEN
            RETURN NULL;  -- nothing changed (an upsert that matched, say): not an event
        END IF;
        SELECT COALESCE(jsonb_agg(key ORDER BY key), '[]'::jsonb) INTO v_changed
        FROM jsonb_each(j) AS n(key, value)
        JOIN jsonb_each(to_jsonb(OLD)) AS o(key, value) USING (key)
        WHERE n.value IS DISTINCT FROM o.value;
        v_detail := jsonb_build_object('changed', v_changed);
    END IF;

    v_tenant := COALESCE(
        NULLIF(current_setting('app.current_tenant_id', true), '')::uuid,
        (j ->> 'tenant_id')::uuid,
        (j ->> 'requesting_tenant_id')::uuid
    );

    INSERT INTO audit_log (tenant_id, actor_user_id, action, table_name, record_id, detail)
    VALUES (v_tenant, NULLIF(current_setting('app.current_user_id', true), '')::uuid,
            lower(TG_OP), TG_TABLE_NAME, (j ->> pk_col)::uuid, v_detail);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Operational GPS pings and unit status changes are deliberately not
-- audited here: pings would drown the log, and unit_status_history
-- already is the audit trail for status.
DO $$
DECLARE
    pair TEXT[];
BEGIN
    FOREACH pair SLICE 1 IN ARRAY ARRAY[
        ARRAY['incidents', 'incident_id'],
        ARRAY['incident_unit_assignments', 'assignment_id'],
        ARRAY['patient_care_records', 'pcr_id'],
        ARRAY['pcr_vitals', 'vital_id'],
        ARRAY['pcr_procedures', 'procedure_id'],
        ARRAY['pcr_medications', 'medication_id'],
        ARRAY['pcr_disposition', 'pcr_id'],
        ARRAY['pcr_signatures', 'signature_id'],
        ARRAY['pcr_amendments', 'amendment_id'],
        ARRAY['controlled_substance_log', 'log_id'],
        ARRAY['mutual_aid_links', 'link_id'],
        ARRAY['certifications', 'certification_id'],
        ARRAY['crew_members', 'crew_member_id'],
        ARRAY['users', 'user_id'],
        ARRAY['protocol_sets', 'protocol_set_id']
    ]
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I
                FOR EACH ROW EXECUTE FUNCTION audit_row_change(%2$L);',
            pair[1], pair[2]);
    END LOOP;
END $$;
