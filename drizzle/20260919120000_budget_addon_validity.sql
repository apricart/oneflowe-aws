-- One-time add-on budgets carry a validity date
-- (plans/OF-BUDGET-addon-validity.md).
--
-- Purely additive and re-entrant: three columns, one partial index, one
-- check. No backfill. Rows granted before this change keep valid_until NULL
-- and are never settled, so no existing balance moves on deploy; rolling the
-- application back leaves the columns unused rather than broken.
--
-- budget_addons.valid_until      the instant the add-on stops being available
--                                (end of the chosen day, Asia/Karachi).
-- budget_addons.expired_at       when the settlement withdrew the unspent part.
-- budget_addons.forfeited_cents  what that withdrawal took off
--                                budgets.amount_credited_cents.
--
-- The table holds one row per add-on ever granted, so the index is created
-- inline rather than concurrently.

ALTER TABLE "budget_addons" ADD COLUMN IF NOT EXISTS "valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "budget_addons" ADD COLUMN IF NOT EXISTS "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "budget_addons" ADD COLUMN IF NOT EXISTS "forfeited_cents" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "budget_addons_open_expiry_idx" ON "budget_addons" USING btree ("valid_until") WHERE "expired_at" IS NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'budget_addons_forfeit_bounds_ck'
  ) THEN
    ALTER TABLE "budget_addons" ADD CONSTRAINT "budget_addons_forfeit_bounds_ck"
      CHECK ("forfeited_cents" >= 0 AND "forfeited_cents" <= "amount_cents");
  END IF;
END $$;
