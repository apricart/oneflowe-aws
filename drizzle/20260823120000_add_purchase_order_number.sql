-- Buyer-supplied purchase order reference.
--
-- The invoice has always printed a "P.O.#" field, but no purchase order was
-- ever recorded, so it fell back to the invoice number and printed the same
-- value twice. The requester can now supply their own reference when the order
-- is placed, and the invoice prints that.
--
-- Both columns are nullable with no default, so every existing order and group
-- order keeps exactly its current data and no code path is forced to supply
-- one. Idempotent: safe to re-run.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS po_number varchar(64);

-- The group order envelope keeps the reference the requester typed once, so
-- every branch order created beneath it carries the same purchase order.
ALTER TABLE group_orders
  ADD COLUMN IF NOT EXISTS po_number varchar(64);
