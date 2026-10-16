-- Order approval levels, phase 2b: the level an order is waiting at.
-- See plans/OF-APPROVAL-LEVELS-route-orders-by-level.md.
--
-- Additive only. Nullable with no default, so adding it to the large orders
-- table is a metadata change and every existing order reads null, which means
-- "decided exactly as today". Only an order created while its organization
-- uses approval levels is ever given one. The check is added NOT VALID first so
-- its ACCESS EXCLUSIVE lock is momentary, then validated (every row is null).
--
-- Apply before deploying: the order reads select the column.
--
-- Rollback (after reverting the code that reads it):
--   ALTER TABLE "orders" DROP COLUMN IF EXISTS "approval_level";

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "approval_level" integer;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "orders_approval_level_ck"
    CHECK ("approval_level" IS NULL OR "approval_level" BETWEEN 1 AND 10) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_approval_level_ck";
