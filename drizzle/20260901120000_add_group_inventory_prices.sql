-- Group-level product prices.
--
-- Adds the missing middle tier of the price ladder. Before this migration a
-- product had a global base price and an optional per-organization override;
-- every branch of a tenant therefore paid the same price. Groups already exist
-- as the tenant's collection of branches (`branches.group_id`, one group per
-- branch), so they are the natural place to price a set of branches
-- differently.
--
-- The resolved ladder, implemented once in `lib/server/effective-price.ts`:
--
--   COALESCE(group_inventory_prices.custom_price_cents,
--            organization_inventory.custom_price_cents,
--            global_products.base_price_cents)
--
-- Purely additive and idempotent:
--   * one new table,
--   * no column added to, removed from, or modified on any existing table.
--
-- Because the table starts empty, every COALESCE above resolves exactly as it
-- did before this migration until an administrator sets a group price. No
-- existing price, order, budget, receipt, or report changes.

CREATE TABLE IF NOT EXISTS group_inventory_prices (
  id serial PRIMARY KEY,
  group_id integer NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  -- Denormalized tenant guard, matching user_group_assignments: the row is
  -- pinned to the tenant it was written under so a cross-tenant override can
  -- neither be written nor read back by accident.
  organization_id integer NOT NULL REFERENCES organizations(id),
  organization_inventory_id integer NOT NULL
    REFERENCES organization_inventory(id) ON DELETE CASCADE,
  -- Tax-inclusive, like every other price in the system. NOT NULL: "no
  -- override" is the absence of the row, never a NULL price.
  custom_price_cents integer NOT NULL,
  updated_by_user_id uuid REFERENCES users(id),
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);
--> statement-breakpoint
-- One price per product per group. The upsert in
-- app/api/v1/groups/[id]/prices relies on this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS group_inventory_prices_group_item_uq
  ON group_inventory_prices(group_id, organization_inventory_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS group_inventory_prices_group_idx
  ON group_inventory_prices(group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS group_inventory_prices_org_idx
  ON group_inventory_prices(organization_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS group_inventory_prices_item_idx
  ON group_inventory_prices(organization_inventory_id);
--> statement-breakpoint
-- Mirrors organization_inventory_price_valid_ck: a price is never negative.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'group_inventory_prices_price_valid_ck'
  ) THEN
    ALTER TABLE group_inventory_prices
      ADD CONSTRAINT group_inventory_prices_price_valid_ck
      CHECK (custom_price_cents >= 0);
  END IF;
END $$;
--> statement-breakpoint
-- Match the deny-by-default posture applied to every other public table by
-- 20260709000000_enable_rls_deny_by_default, and grant the staged NOBYPASSRLS
-- runtime role where it exists.
ALTER TABLE group_inventory_prices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneflowe_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE group_inventory_prices TO oneflowe_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE group_inventory_prices_id_seq TO oneflowe_runtime';
  END IF;
END $$;
