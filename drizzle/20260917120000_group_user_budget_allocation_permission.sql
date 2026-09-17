-- Group User budget allocation is opt-in per account. Existing accounts are
-- disabled by the database default, including users created outside the UI.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "budget_allocation_enabled" boolean NOT NULL DEFAULT false;
