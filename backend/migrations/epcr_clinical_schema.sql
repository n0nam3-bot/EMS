-- =====================================================================
-- EMS Dispatch & Operations Platform — Structured ePCR Clinical Schema
-- Extends ems_dispatch_core_schema.sql
-- =====================================================================
-- This is the piece the compliance console's PCR review was missing:
-- structured clinical data for a charting UI to write into, and for a
-- real completeness check to read from — instead of a single opaque
-- score with no data behind it.
--
-- References tenants, crew_members, patient_care_records,
-- controlled_substance_log, and facilities from the core schema.
-- Apply after ems_dispatch_core_schema.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Vitals — time series per PCR
-- ---------------------------------------------------------------------

CREATE TABLE pcr_vitals (
    vital_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                    UUID NOT NULL REFERENCES tenants(tenant_id),
    pcr_id                          UUID NOT NULL REFERENCES patient_care_records(pcr_id),
    recorded_at                        TIMESTAMPTZ NOT NULL,
    recorded_by_crew_member_id            UUID REFERENCES crew_members(crew_member_id),
    bp_systolic                              SMALLINT,
    bp_diastolic                                SMALLINT,
    heart_rate                                     SMALLINT,
    respiratory_rate                                  SMALLINT,
    spo2_percent                                         SMALLINT,
    blood_glucose                                           SMALLINT,
    gcs_total                                                  SMALLINT,  -- 3-15
    pain_scale                                                    SMALLINT,  -- 0-10
    temperature_f                                                    NUMERIC(4,1),
    created_at                                                          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pcr_vitals_pcr_time ON pcr_vitals (pcr_id, recorded_at);
-- This index is what makes the interval-compliance check in Section 6
-- fast instead of a full scan per chart.

-- ---------------------------------------------------------------------
-- 2. Procedures performed
-- ---------------------------------------------------------------------

CREATE TABLE pcr_procedures (
    procedure_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                    UUID NOT NULL REFERENCES tenants(tenant_id),
    pcr_id                          UUID NOT NULL REFERENCES patient_care_records(pcr_id),
    procedure_name                     TEXT NOT NULL,   -- 'IV Access', 'Intubation', 'CPR', 'Splinting', ...
    performed_at                          TIMESTAMPTZ NOT NULL,
    performed_by_crew_member_id              UUID REFERENCES crew_members(crew_member_id),
    outcome                                     TEXT,     -- e.g. 'Successful, 1st attempt'
    notes                                          TEXT,
    created_at                                        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 3. Medications administered
-- ---------------------------------------------------------------------

CREATE TABLE pcr_medications (
    medication_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                    UUID NOT NULL REFERENCES tenants(tenant_id),
    pcr_id                          UUID NOT NULL REFERENCES patient_care_records(pcr_id),
    drug_name                          TEXT NOT NULL,
    dose                                  TEXT NOT NULL,   -- e.g. '0.3 mg', '325 mg'
    route                                    TEXT NOT NULL,   -- 'IV' | 'IM' | 'IO' | 'PO' | 'SL' | 'Inhaled' | 'IN'
    administered_at                             TIMESTAMPTZ NOT NULL,
    administered_by_crew_member_id                 UUID REFERENCES crew_members(crew_member_id),
    controlled_substance_log_id                       UUID REFERENCES controlled_substance_log(log_id),
    patient_response                                     TEXT,
    created_at                                              TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- controlled_substance_log_id links this clinical record back to the
-- chain-of-custody entry when the drug given is a controlled substance
-- — two different concerns (what the patient received vs. custody of
-- the drug itself), cross-referenced rather than merged into one table.

-- ---------------------------------------------------------------------
-- 4. Disposition — one row per PCR
-- ---------------------------------------------------------------------

CREATE TABLE pcr_disposition (
    pcr_id                     UUID PRIMARY KEY REFERENCES patient_care_records(pcr_id),
    tenant_id                    UUID NOT NULL REFERENCES tenants(tenant_id),
    disposition_type                TEXT NOT NULL,   -- 'transported' | 'refused' | 'treated_no_transport' | 'dead_on_scene' | 'cancelled'
    destination_facility_id            UUID REFERENCES facilities(facility_id),
    transfer_of_care_to                   TEXT,        -- receiving provider name/credential
    primary_impression                       TEXT,
    secondary_impressions                       TEXT[],
    mechanism_of_injury                            TEXT,
    updated_at                                        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 5. Signatures — captured as attachments, not inline
-- ---------------------------------------------------------------------

CREATE TABLE pcr_signatures (
    signature_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                     UUID NOT NULL REFERENCES tenants(tenant_id),
    pcr_id                           UUID NOT NULL REFERENCES patient_care_records(pcr_id),
    signature_type                      TEXT NOT NULL,   -- 'crew' | 'receiving_provider' | 'patient' | 'refusal'
    signer_name                            TEXT NOT NULL,
    signer_credential                         TEXT,
    object_storage_ref                           TEXT NOT NULL,  -- pointer into encrypted object storage, not the image itself
    captured_at                                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Row-level security — same pattern as the core schema
-- ---------------------------------------------------------------------

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'pcr_vitals', 'pcr_procedures', 'pcr_medications', 'pcr_disposition', 'pcr_signatures'
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
-- 6. What real completeness checking looks like
-- ---------------------------------------------------------------------
-- This replaces the single fabricated percentage from the compliance
-- console mockup. A checklist of named pass/fail checks tells a
-- reviewer exactly what's missing — a blended score hides that. Add
-- rows here as your protocol requirements grow; this is a starting
-- set, not a complete rules engine.

CREATE OR REPLACE FUNCTION pcr_completeness_check(p_pcr_id UUID)
RETURNS TABLE(check_name TEXT, passed BOOLEAN) AS $$
BEGIN
    RETURN QUERY
    SELECT 'has_vitals'::TEXT, EXISTS(SELECT 1 FROM pcr_vitals WHERE pcr_id = p_pcr_id)
    UNION ALL
    SELECT 'has_disposition'::TEXT, EXISTS(SELECT 1 FROM pcr_disposition WHERE pcr_id = p_pcr_id)
    UNION ALL
    SELECT 'has_crew_signature'::TEXT, EXISTS(SELECT 1 FROM pcr_signatures WHERE pcr_id = p_pcr_id AND signature_type = 'crew')
    UNION ALL
    SELECT 'transport_has_destination'::TEXT, NOT EXISTS(
        SELECT 1 FROM pcr_disposition
        WHERE pcr_id = p_pcr_id AND disposition_type = 'transported' AND destination_facility_id IS NULL
    )
    UNION ALL
    SELECT 'refusal_has_signature'::TEXT, NOT EXISTS(
        SELECT 1 FROM pcr_disposition d
        WHERE d.pcr_id = p_pcr_id AND d.disposition_type = 'refused'
        AND NOT EXISTS (SELECT 1 FROM pcr_signatures s WHERE s.pcr_id = p_pcr_id AND s.signature_type = 'refusal')
    );
END;
$$ LANGUAGE plpgsql STABLE;

-- This is the specific fake flag from the compliance console mockup —
-- "vitals interval exceeds protocol, q5min required during transport"
-- — made real. It finds the largest gap between consecutive vitals
-- readings and checks it against a threshold you pass in.
CREATE OR REPLACE FUNCTION pcr_vitals_max_gap_minutes(p_pcr_id UUID)
RETURNS NUMERIC AS $$
    SELECT EXTRACT(EPOCH FROM MAX(gap)) / 60
    FROM (
        SELECT recorded_at - LAG(recorded_at) OVER (ORDER BY recorded_at) AS gap
        FROM pcr_vitals WHERE pcr_id = p_pcr_id
    ) gaps;
$$ LANGUAGE sql STABLE;
-- Note: the threshold itself (5 min, 15 min, whatever) should come
-- from the chart's protocol_set_id, not a hardcoded number — that
-- needs protocol_sets to hold structured, machine-readable
-- requirements instead of just a document_ref pointer. It doesn't
-- yet. That's the next layer past this one, not this one.

-- =====================================================================
-- Still not here: the charting UI that writes into these tables, and
-- structured protocol requirements for pcr_vitals_max_gap_minutes to
-- check against instead of a passed-in number.
-- =====================================================================
