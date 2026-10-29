-- =====================================================================
-- EMS Dispatch & Operations Platform — Protocol Reference Library Schema
-- Extends ems_dispatch_core_schema.sql
-- =====================================================================
-- Two-sided feature: compliance/management uploads reference material,
-- field crews search it in real time while treating a patient or
-- charting. PDF is the source of record; extracted_text is what's
-- actually searched — see the design note in Section 3.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Uploaded reference documents
-- ---------------------------------------------------------------------

CREATE TABLE protocol_documents (
    document_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                  UUID NOT NULL REFERENCES tenants(tenant_id),
    title                          TEXT NOT NULL,
    category                          TEXT,              -- e.g. 'Cardiac', 'Airway', 'Pediatric' — for browsing, not a replacement for search
    protocol_set_id                     UUID REFERENCES protocol_sets(protocol_set_id),  -- links this doc to a specific versioned protocol set where applicable
    object_storage_ref                     TEXT NOT NULL,   -- pointer to the original PDF, never the file itself
    extracted_text                            TEXT,          -- OCR/extraction output — this is what gets indexed, not the PDF
    extraction_status                            TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'ocr_required' | 'extracted' | 'failed'
    page_count                                     INTEGER,
    uploaded_by_user_id                               UUID REFERENCES users(user_id),
    uploaded_at                                          TIMESTAMPTZ NOT NULL DEFAULT now(),
    superseded_by_document_id                               UUID REFERENCES protocol_documents(document_id)  -- old versions stay queryable, not deleted
);

-- Full-text search index — this is the "no new infrastructure" option
-- referenced in the response. Swap for Meilisearch/Typesense later if
-- typo-tolerance needs to be sharper than Postgres's built-in stemming.
ALTER TABLE protocol_documents ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(extracted_text, ''))) STORED;
CREATE INDEX idx_protocol_documents_search ON protocol_documents USING GIN (search_vector);

-- Example query a real search endpoint would run:
-- SELECT document_id, title, ts_rank(search_vector, query) AS rank
-- FROM protocol_documents, websearch_to_tsquery('english', $1) query
-- WHERE tenant_id = $2 AND search_vector @@ query
-- ORDER BY rank DESC LIMIT 10;

-- ---------------------------------------------------------------------
-- 2. Search log — what crews actually look up, and when
-- ---------------------------------------------------------------------
-- Compliance value, not just an access log: a spike in searches for a
-- given protocol during active calls is a real signal — either a gap
-- in training or a protocol that's genuinely hard to remember under
-- pressure. Worth a place on the compliance console someday.

CREATE TABLE protocol_search_log (
    search_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 UUID NOT NULL REFERENCES tenants(tenant_id),
    searched_by_user_id          UUID REFERENCES users(user_id),
    incident_id                     UUID REFERENCES incidents(incident_id),  -- nullable: not every search happens mid-call
    query_text                         TEXT NOT NULL,
    result_document_id                    UUID REFERENCES protocol_documents(document_id),  -- which result, if any, they opened
    searched_at                              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_protocol_search_log_tenant_time ON protocol_search_log (tenant_id, searched_at);

-- ---------------------------------------------------------------------
-- Row-level security — same pattern as the rest of the schema
-- ---------------------------------------------------------------------

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['protocol_documents', 'protocol_search_log']
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

-- =====================================================================
-- What real upload needs that isn't in this file: a PDF text-extraction
-- step (direct extraction for born-digital PDFs, OCR — e.g. Tesseract
-- or a cloud OCR service — for scanned ones) that populates
-- extracted_text after upload. That's server-side processing outside
-- the database, not something a schema file can do on its own.
-- =====================================================================
