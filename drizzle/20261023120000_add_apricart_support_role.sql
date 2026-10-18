-- The Apricart Support role: Apricart staff who answer and triage every
-- organization's support requests, and reach nothing else.
-- See plans/OF-SUPPORT-apricart-support-role.md.
--
-- Additive only: the APRICART_SUPPORT row in roles. Inserted here rather than
-- by running the general seed against production (the seed rewrites
-- role_permissions), as ORDER_DESK's, APRICART_EXECUTIVE's and WAREHOUSE's were.
-- No table changes, no backfill. Nothing reads the row until an account holds it.
--
-- Apply before deploying: creating a support account needs the role row.
--
-- Rollback (after deactivating every support account):
--   DELETE FROM "roles" WHERE "name" = 'APRICART_SUPPORT' AND NOT EXISTS (
--     SELECT 1 FROM "users" WHERE "users"."role_id" = "roles"."id");

INSERT INTO "roles" ("name", "description")
SELECT 'APRICART_SUPPORT', 'Apricart support: answers and triages every organization''s support requests, nothing else'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'APRICART_SUPPORT');
