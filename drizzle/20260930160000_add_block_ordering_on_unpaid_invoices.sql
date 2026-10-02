-- Opt-in per organization: a branch with two unpaid invoices may not order.
-- Defaults to false so every existing tenant keeps ordering as before.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS block_ordering_on_unpaid_invoices boolean NOT NULL DEFAULT false;
