-- The invoice ledger's credited figures, held to what credit notes can produce.
-- See plans/OF-INVOICE-invoice-ledger.md ("Fixes after the edge-case review").
--
-- 20261015120000 let an invoice's status and credited totals move freely, so a
-- row could read CREDITED with nothing credited, credit more tax than it
-- charged, or have its credits lowered. Credit notes are immutable and only
-- ever add, so none of those can be right:
--
--   * invoices_credited_split_ck   credited net + credited tax = credited total
--                                   (every credit note adds a reconciled triple;
--                                   the backfill writes net = total - tax)
--   * invoices_credited_tax_ck     credited tax never exceeds the tax charged
--                                   (the backfill caps it at tax_cents)
--   * invoices_status_credited_ck  an invoice issued at supply reads ISSUED with
--                                   nothing credited, PARTIALLY_CREDITED in
--                                   between, CREDITED at its total. Legacy rows
--                                   are left out: their status was derived from
--                                   K-Electric order data at backfill.
--   * invoices_guard_change()      also refuses lowering any credited total.
--
-- Additive and fast: three CHECKs over a table of about a thousand rows, and a
-- replaced trigger function. ADD CONSTRAINT validates existing rows; if one is
-- refused, the migration stops with the constraint's name and changes nothing —
-- find the row with the constraint's own expression before going further.
--
-- Rollback:
--   ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_credited_split_ck,
--     DROP CONSTRAINT IF EXISTS invoices_credited_tax_ck,
--     DROP CONSTRAINT IF EXISTS invoices_status_credited_ck;
--   and re-run the invoices_guard_change() definition from 20261015120000.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_credited_split_ck') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_credited_split_ck
      CHECK (credited_net_cents + credited_tax_cents = credited_total_cents);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_credited_tax_ck') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_credited_tax_ck
      CHECK (credited_tax_cents <= tax_cents);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_status_credited_ck') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_status_credited_ck
      CHECK (
        origin <> 'ISSUED_AT_SUPPLY'
        OR (status = 'ISSUED' AND credited_total_cents = 0)
        OR (status = 'PARTIALLY_CREDITED' AND credited_total_cents > 0 AND credited_total_cents < total_cents)
        OR (status = 'CREDITED' AND credited_total_cents > 0 AND credited_total_cents = total_cents)
      );
  END IF;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION invoices_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF invoice_ledger_test_cleanup_allowed() THEN
      RETURN OLD;
    END IF;
    -- Only the backfill's own rollback, naming its batch, may remove a row the
    -- backfill wrote. An invoice issued at supply can never be deleted.
    IF OLD.backfill_batch IS NOT NULL
      AND current_setting('oneflowe.invoice_ledger_rollback_batch', true) = OLD.backfill_batch THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'invoice ledger: invoice % cannot be deleted', OLD.number USING ERRCODE = 'P0001';
  END IF;

  IF (NEW.id, NEW.organization_id, NEW.branch_id, NEW.order_id, NEW.number, NEW.issue_date, NEW.issued_at,
      NEW.origin, NEW.seller, NEW.buyer, NEW.participants, NEW.net_cents, NEW.tax_cents, NEW.discount_cents,
      NEW.delivery_charges_cents, NEW.total_cents, NEW.legacy_snapshot, NEW.issued_by_user_id,
      NEW.backfill_batch, NEW.created_at)
    IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.branch_id, OLD.order_id, OLD.number, OLD.issue_date, OLD.issued_at,
      OLD.origin, OLD.seller, OLD.buyer, OLD.participants, OLD.net_cents, OLD.tax_cents, OLD.discount_cents,
      OLD.delivery_charges_cents, OLD.total_cents, OLD.legacy_snapshot, OLD.issued_by_user_id,
      OLD.backfill_batch, OLD.created_at) THEN
    RAISE EXCEPTION 'invoice ledger: invoice % is issued; only its credited totals and status may change', OLD.number
      USING ERRCODE = 'P0001';
  END IF;

  -- Credit notes are immutable and only ever add to an invoice's credits.
  IF NEW.credited_net_cents < OLD.credited_net_cents
    OR NEW.credited_tax_cents < OLD.credited_tax_cents
    OR NEW.credited_total_cents < OLD.credited_total_cents THEN
    RAISE EXCEPTION 'invoice ledger: invoice % cannot have its credits lowered', OLD.number
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
