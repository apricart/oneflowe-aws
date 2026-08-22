-- Tax-inclusive pricing support.
--
-- Catalogue prices are entered inclusive of sales tax, so orders need to record
-- the net and tax components separately for the accounts team without changing
-- what was charged. All three columns are nullable or defaulted, so every
-- existing row keeps exactly its current data and no code path is forced to
-- supply a value.
--
-- The schema changes are idempotent. The settings normalisation below is not
-- quite: re-running it would rewrite a rate that someone has since set back to
-- zero deliberately. It is a one-time correction of a seeded default, and the
-- migration journal runs it once.

-- Per-product override, in basis points (1800 = 18%). NULL means "follow the
-- organization's tax_rate setting", so changing that default moves every
-- product that has not been given an explicit rate of its own.
ALTER TABLE global_products
  ADD COLUMN IF NOT EXISTS tax_rate_bp integer;

-- Snapshot of the rate that actually applied when the order was placed, and the
-- tax it produced. Stored per line rather than derived at read time so a later
-- change to the organization default cannot restate invoices that have already
-- been issued and filed.
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS tax_rate_bp integer;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS tax_cents bigint NOT NULL DEFAULT 0;

-- Normalise the pre-existing `tax_rate` setting to a percentage.
--
-- The key already existed but was seeded as 0 while being validated as a 0-1
-- fraction, so stored values are ambiguous: 0.18 meant 18%, and 18 would have
-- been rejected. Everything is converted to a percentage here so the runtime
-- has exactly one interpretation to apply.
--
-- Fractions between 0 and 1 are scaled up; the seeded 0, which means the rate
-- was never configured, becomes the 18% standard rate that the business already
-- applies to every product. A rate deliberately set to zero after this
-- migration stays zero, because only the untouched seed value is rewritten.
UPDATE organization_settings
   SET value = to_jsonb(((value #>> '{}')::numeric * 100))
 WHERE key = 'tax_rate'
   AND jsonb_typeof(value) = 'number'
   AND (value #>> '{}')::numeric > 0
   AND (value #>> '{}')::numeric <= 1;

UPDATE organization_settings
   SET value = to_jsonb(18)
 WHERE key = 'tax_rate'
   AND jsonb_typeof(value) = 'number'
   AND (value #>> '{}')::numeric = 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'global_products_tax_rate_valid_ck'
  ) THEN
    ALTER TABLE global_products
      ADD CONSTRAINT global_products_tax_rate_valid_ck
      CHECK (tax_rate_bp IS NULL OR (tax_rate_bp >= 0 AND tax_rate_bp <= 10000));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_items_tax_valid_ck'
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT order_items_tax_valid_ck
      CHECK (
        tax_cents >= 0
        AND (tax_rate_bp IS NULL OR (tax_rate_bp >= 0 AND tax_rate_bp <= 10000))
      );
  END IF;
END $$;
