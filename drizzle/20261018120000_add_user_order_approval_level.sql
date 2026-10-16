-- Order approval levels, phase 2a: the level a user holds.
-- See plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md.
--
-- Additive only. The column is nullable with no default, so every existing
-- user reads null (no level) and Postgres does not rewrite the table. The
-- check is added NOT VALID first so its ACCESS EXCLUSIVE lock is momentary,
-- then validated (every row is null, so the scan is quick and takes only a
-- SHARE UPDATE EXCLUSIVE lock).
--
-- Assignment only: nothing in the order path reads the column yet. Apply
-- before deploying — the users list selects it.
--
-- Rollback (after reverting the code that reads it):
--   ALTER TABLE "users" DROP COLUMN IF EXISTS "order_approval_level";

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "order_approval_level" integer;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_order_approval_level_ck"
    CHECK ("order_approval_level" IS NULL OR "order_approval_level" BETWEEN 1 AND 10) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "users" VALIDATE CONSTRAINT "users_order_approval_level_ck";
