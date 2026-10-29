-- =====================================================================
-- EMS Dispatch & Operations Platform — Crew Seat Role Schema
-- Extends ems_dispatch_core_schema.sql
-- =====================================================================

CREATE TYPE crew_seat_role AS ENUM ('driver', 'non_driver');

ALTER TABLE unit_crew_assignments ADD COLUMN seat_role crew_seat_role NOT NULL DEFAULT 'non_driver';

CREATE UNIQUE INDEX idx_unique_active_driver ON unit_crew_assignments (unit_id) WHERE seat_role = 'driver' AND assigned_to IS NULL;

-- A crew member's certification level already has a source of truth:
-- the certifications table. This derives EMT-vs-Medic instead of
-- storing a second copy of the same fact that could drift out of sync
-- the moment someone gets recertified.
CREATE OR REPLACE FUNCTION crew_member_current_cert_level(p_crew_member_id UUID)
RETURNS TEXT AS $$
    SELECT ct.code
    FROM certifications c
    JOIN certification_types ct ON ct.certification_type_id = c.certification_type_id
    WHERE c.crew_member_id = p_crew_member_id
      AND c.expires_on >= CURRENT_DATE
    ORDER BY
      CASE WHEN ct.required_for_capability = 'ALS' THEN 0 ELSE 1 END,
      c.expires_on DESC
    LIMIT 1;
$$ LANGUAGE sql STABLE;

-- employee_number included here — caught only while wiring the
-- dispatch console to real data, which displays "employee ID - full
-- name" per an earlier request. Without it, that display would have
-- silently rendered blank IDs against a live backend.
-- security_invoker = true is load-bearing. A plain view runs with its
-- OWNER's privileges, and the owner is the migration role — which owns
-- every table and so bypasses row-level security. Without this, a
-- tenant session querying this view saw other tenants' crew names and
-- employee numbers even though every table underneath was correctly
-- isolated. Found by probing the view directly; the original tests
-- only covered tables, and tests/isolation.test.js now guards this.
CREATE VIEW unit_crew_display WITH (security_invoker = true) AS
SELECT
    uca.unit_id,
    cm.crew_member_id,
    cm.employee_number,
    cm.first_name,
    cm.last_name,
    uca.seat_role,
    crew_member_current_cert_level(cm.crew_member_id) AS cert_level
FROM unit_crew_assignments uca
JOIN crew_members cm ON cm.crew_member_id = uca.crew_member_id
WHERE uca.assigned_to IS NULL;
