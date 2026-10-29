-- =====================================================================
-- EXAMPLE first-run data. Edit the names, emails and IDs, then run it ONCE
-- as the OWNER (migration) role, after `npm run migrate`:
--
--   psql "$MIGRATION_DATABASE_URL" -f scripts/bootstrap_example.sql
--
-- The database starts empty, and a token is only accepted for a user who
-- exists, is active, and belongs to an active agency. This creates:
--   * one agency
--   * its active protocol set (every incident is stamped with it)
--   * four users, one per role you'll want to try
--
-- There is no API or console for managing users yet — this is how it's
-- done. Deactivate someone with:  UPDATE users SET is_active = false WHERE ...
-- Generate real UUIDs for production (SELECT gen_random_uuid();).
-- encryption_key_ref is required by the schema but not used by any code yet.
-- =====================================================================
BEGIN;

INSERT INTO tenants (tenant_id, legal_name, display_name, regulatory_state, regulatory_region, encryption_key_ref)
VALUES ('aaaaaaaa-1111-4111-8111-000000000001', 'Example Ambulance Co., LLC', 'Example Ambulance', 'NY', 'NYC-REMSCO', 'not-yet-used');

INSERT INTO protocol_sets (protocol_set_id, tenant_id, issuing_authority, version_label, effective_from)
VALUES ('aaaaaaaa-1111-4111-8111-000000000002', 'aaaaaaaa-1111-4111-8111-000000000001', 'NYC REMAC', 'initial', CURRENT_DATE);

INSERT INTO users (user_id, tenant_id, email, display_name, role) VALUES
 ('aaaaaaaa-1111-4111-8111-000000000010', 'aaaaaaaa-1111-4111-8111-000000000001', 'it.admin@example.com',   'Example IT Admin',   'it_admin'),
 ('aaaaaaaa-1111-4111-8111-000000000011', 'aaaaaaaa-1111-4111-8111-000000000001', 'supervisor@example.com', 'Example Supervisor', 'supervisor'),
 ('aaaaaaaa-1111-4111-8111-000000000012', 'aaaaaaaa-1111-4111-8111-000000000001', 'dispatcher@example.com', 'Example Dispatcher', 'dispatcher'),
 ('aaaaaaaa-1111-4111-8111-000000000013', 'aaaaaaaa-1111-4111-8111-000000000001', 'compliance@example.com', 'Example Compliance', 'compliance_officer');

COMMIT;
