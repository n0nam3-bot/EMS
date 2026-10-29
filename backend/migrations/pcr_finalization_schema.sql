-- =====================================================================
-- EMS Dispatch & Operations Platform — Finalized-Chart Immutability
-- Extends ems_dispatch_core_schema.sql and epcr_clinical_schema.sql
-- =====================================================================
-- The core schema's trigger (prevent_finalized_pcr_edit) protects the
-- patient_care_records ROW once finalized_at is set. That left every
-- table hanging off it wide open: a finalized, signed-off chart could
-- still gain vitals, procedures, medications, a changed disposition,
-- or a new signature through its child tables, with no amendment on
-- record. Found by a test that finalized a chart and then tried each
-- path — four of five were accepted. (The fifth, the narrative, lives
-- on the already-protected row.)
--
-- Corrections to a finalized chart go through pcr_amendments, which is
-- deliberately NOT covered here — that table is where they belong.
--
-- pcr_signatures is included on purpose: adding a signature after
-- finalization changes what was signed off. If the real workflow
-- captures a late signature, that is an amendment, not a silent insert.
-- =====================================================================

CREATE OR REPLACE FUNCTION prevent_finalized_pcr_child_change()
RETURNS TRIGGER AS $$
DECLARE
    target_pcr UUID;
    is_final BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_pcr := OLD.pcr_id;
    ELSE
        target_pcr := NEW.pcr_id;
    END IF;

    SELECT finalized_at IS NOT NULL INTO is_final
    FROM patient_care_records WHERE pcr_id = target_pcr;

    IF is_final THEN
        RAISE EXCEPTION 'PCR % is finalized — record this change as a pcr_amendments entry instead of altering %',
            target_pcr, TG_TABLE_NAME;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['pcr_vitals', 'pcr_procedures', 'pcr_medications', 'pcr_disposition', 'pcr_signatures']
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_finalized
                BEFORE INSERT OR UPDATE OR DELETE ON %1$I
                FOR EACH ROW EXECUTE FUNCTION prevent_finalized_pcr_child_change();',
            t
        );
    END LOOP;
END $$;
