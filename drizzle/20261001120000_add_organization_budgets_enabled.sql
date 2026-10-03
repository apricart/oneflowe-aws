-- Budget allocation becomes a per-organization switch.
--
-- The column default is true so every existing tenant, and every script or
-- fixture that inserts an organization directly, keeps the budget control it
-- has today. Organizations created through the application are inserted with
-- an explicit false (organizationCreateSchema), which is the product default.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS budgets_enabled boolean NOT NULL DEFAULT true;

-- Whether an order took a budget hold when it was created. Every later ledger
-- move (edit, reject, fulfil, refund, delete) keys on this, never on the
-- organization's current setting, so switching budgets on or off never makes a
-- ledger move for an order that did not take a hold, or skip one that did.
-- Every existing order took a hold, so every existing order is tracked.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS budget_tracked boolean NOT NULL DEFAULT true;
