-- Configurable ordering-block thresholds.
-- See plans/OF-ORDERING-BLOCK-configurable-thresholds.md.
--
-- Additive only. Each ordering block (unpaid invoices, unacknowledged
-- deliveries) stopped a branch at a fixed 2; each organization now carries its
-- own limit, set by Super Admin. The default is 2, so every existing tenant
-- behaves exactly as before until a Super Admin changes it. The bounds are
-- ORDERING_BLOCK_THRESHOLD_MIN..MAX in lib/ordering-block-threshold.ts.
--
-- A constant default is metadata-only on Postgres 11+; each CHECK scans
-- `organizations`, which holds a handful of rows.
--
-- Apply before deploying: both order gates select the new columns.
--
-- Rollback (after deploying code that no longer selects them):
--   ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "organizations_unpaid_invoice_block_threshold_ck";
--   ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "organizations_unacknowledged_delivery_block_threshold_ck";
--   ALTER TABLE "organizations" DROP COLUMN IF EXISTS "unpaid_invoice_block_threshold";
--   ALTER TABLE "organizations" DROP COLUMN IF EXISTS "unacknowledged_delivery_block_threshold";

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "unpaid_invoice_block_threshold" integer NOT NULL DEFAULT 2;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "unacknowledged_delivery_block_threshold" integer NOT NULL DEFAULT 2;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_unpaid_invoice_block_threshold_ck" CHECK ("organizations"."unpaid_invoice_block_threshold" BETWEEN 1 AND 100);--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_unacknowledged_delivery_block_threshold_ck" CHECK ("organizations"."unacknowledged_delivery_block_threshold" BETWEEN 1 AND 100);
