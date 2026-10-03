-- Opt-in per organization: a branch with two orders that are delivered but not
-- yet acknowledged may not order. Defaults to false so every existing tenant
-- keeps ordering as before.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS block_ordering_on_unacknowledged_deliveries boolean NOT NULL DEFAULT false;
