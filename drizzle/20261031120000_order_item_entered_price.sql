-- The Order Desk may type the price of a line on the orders it keys in.
-- See plans/OF-ORDER-DESK-line-price-entry.md.
--
-- Additive only. price_entered_manually has a constant default, which Postgres
-- 11+ records in the catalogue without rewriting order_items; every existing
-- line reads false. catalogue_price_cents is nullable with no default.
--
-- order_items_manual_price_ck: the catalogue price is recorded only beside an
-- entered one, and is never negative. Every existing row satisfies it (the
-- column is null), so validating it reads the table once and writes nothing.
--
-- Apply before deploying: order creation writes both columns.
--
-- Rollback (after reverting the code that writes them):
--   ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_manual_price_ck";
--   ALTER TABLE "order_items" DROP COLUMN IF EXISTS "catalogue_price_cents";
--   ALTER TABLE "order_items" DROP COLUMN IF EXISTS "price_entered_manually";

ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "price_entered_manually" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "catalogue_price_cents" bigint;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_items_manual_price_ck'
      AND conrelid = '"order_items"'::regclass
  ) THEN
    ALTER TABLE "order_items" ADD CONSTRAINT "order_items_manual_price_ck"
      CHECK ("catalogue_price_cents" IS NULL OR ("price_entered_manually" AND "catalogue_price_cents" >= 0));
  END IF;
END $$;
