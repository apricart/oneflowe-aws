-- budget_addons_forfeit_bounds_ck assumed every add-on row is a credit.
--
-- 20260919120000_budget_addon_validity added:
--
--   CHECK (forfeited_cents >= 0 AND forfeited_cents <= amount_cents)
--
-- which is unsatisfiable for a row with a negative amount_cents, because
-- forfeited_cents defaults to 0 and 0 <= negative is false. Production holds
-- three such rows -- compensating reversals written on 2026-07-30 against
-- organization 6, each cancelling an earlier add-on to a net zero
-- ("Database reversal of add-ons: N"). The migration therefore could not be
-- applied there at all, while it applied cleanly to every database that had
-- none, so the two diverged silently.
--
-- The application already knows the right bound. planAddonSettlement floors a
-- negative amount before it forfeits anything:
--
--   const amount = Math.max(0, Math.trunc(addon.amountCents))
--
-- so a reversal row can only ever forfeit zero. GREATEST(amount_cents, 0) is
-- that same floor in SQL. It is *stricter* than the original for a negative
-- row -- it pins forfeited_cents at exactly 0 rather than leaving it
-- unsatisfiable -- and identical for every non-negative row, which is all of
-- them bar the three.
--
-- A reversal row also carries valid_until IS NULL, so isAddonDue is false for
-- it and it is never settled. This constraint is the belt to that brace.
--
-- Re-entrant: the constraint is dropped if present and added in the corrected
-- form, so a database that took the first form converges and one that already
-- has the corrected form is unaffected. budget_addons is small (26 rows in
-- production), so the validating scan and its lock are momentary.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'budget_addons_forfeit_bounds_ck'
  ) THEN
    ALTER TABLE "budget_addons" DROP CONSTRAINT "budget_addons_forfeit_bounds_ck";
  END IF;

  ALTER TABLE "budget_addons" ADD CONSTRAINT "budget_addons_forfeit_bounds_ck"
    CHECK ("forfeited_cents" >= 0 AND "forfeited_cents" <= GREATEST("amount_cents", 0));
END $$;
