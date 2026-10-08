-- Management delivery dashboard: branch region, and the Apricart Executive role.
-- See plans/OF-DELIVERY-management-delivery-dashboard.md.
--
-- Additive only.
--
--   * branches.region — the delivery region a branch belongs to (NORTH,
--     CENTRAL, SOUTH), set by Super Admin. New column, so every existing row is
--     NULL ("Unknown") and the CHECK has nothing to reject.
--   * the APRICART_EXECUTIVE row in roles: Apricart's read-only, cross-tenant
--     management account. Inserted here rather than by running the general
--     seed against production (the seed rewrites role_permissions), as
--     ORDER_DESK's was.
--
-- Apply before deploying: the branch reads select the new column.
--
-- Rollback (after deactivating every executive account):
--   DELETE FROM "roles" WHERE "name" = 'APRICART_EXECUTIVE' AND NOT EXISTS (
--     SELECT 1 FROM "users" WHERE "users"."role_id" = "roles"."id");
--   ALTER TABLE "branches" DROP CONSTRAINT "branches_region_ck";
--   ALTER TABLE "branches" DROP COLUMN "region";

ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "region" varchar(16);--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_region_ck" CHECK ("branches"."region" IS NULL OR "branches"."region" IN ('NORTH', 'CENTRAL', 'SOUTH'));--> statement-breakpoint
INSERT INTO "roles" ("name", "description")
SELECT 'APRICART_EXECUTIVE', 'Apricart management: read-only delivery monitoring across every organization'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'APRICART_EXECUTIVE');
