-- Group orders placed by a Group Order Portal user.
--
-- A Group Order Portal user builds one submission covering many branches of a
-- single group. The application still records one ordinary row in `orders` per
-- branch — every existing approval, budget, refund, and reporting path keeps
-- working untouched — and `group_orders` is the envelope that ties those sibling
-- rows together so the user can track them under one reference.
--
-- Purely additive:
--   * two new tables, and
--   * one nullable column on `orders` that is NULL for every existing row and
--     for every order any other role creates.
-- Nothing existing is modified, so no other role's behaviour can change.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS group_orders (
  id serial PRIMARY KEY,
  -- Human-facing tracking id shown to the user (e.g. GRP-8F3K2QWD).
  reference varchar(32) NOT NULL,
  organization_id integer NOT NULL REFERENCES organizations(id),
  -- The group the submission was scoped to. Kept nullable so a submission for
  -- branches that carry no group assignment is still representable.
  group_id integer REFERENCES groups(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint varchar(64) NOT NULL,
  notes text,
  -- Outcome snapshot. Branch orders are created independently, so a submission
  -- can succeed for some branches and fail for others; the failures are stored
  -- with their reason so the user can correct them on the next submission.
  requested_branch_count integer NOT NULL DEFAULT 0,
  created_order_count integer NOT NULL DEFAULT 0,
  failures jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS group_orders_reference_uq
  ON group_orders(reference);
--> statement-breakpoint
-- Replaying the same Idempotency-Key returns the original submission rather
-- than creating a second set of branch orders.
CREATE UNIQUE INDEX IF NOT EXISTS group_orders_creator_idempotency_uq
  ON group_orders(created_by_user_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS group_orders_org_idx ON group_orders(organization_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS group_orders_creator_created_idx
  ON group_orders(created_by_user_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS group_orders_group_idx ON group_orders(group_id);
--> statement-breakpoint
ALTER TABLE orders ADD COLUMN IF NOT EXISTS group_order_id integer REFERENCES group_orders(id);
--> statement-breakpoint
-- Partial index: only group-portal orders carry the column, so the index stays
-- the size of that feature rather than the size of the orders table.
CREATE INDEX IF NOT EXISTS orders_group_order_idx
  ON orders(group_order_id) WHERE group_order_id IS NOT NULL;
--> statement-breakpoint
-- One resumable draft per user. The draft holds only selections (branch ids,
-- inventory ids, quantities); prices and availability are always re-resolved on
-- the server at submission time, so a stale draft can never fix a stale price.
CREATE TABLE IF NOT EXISTS group_order_drafts (
  id serial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id),
  group_id integer REFERENCES groups(id),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT NOW(),
  updated_at timestamptz DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS group_order_drafts_user_uq
  ON group_order_drafts(user_id);
--> statement-breakpoint
-- Match the deny-by-default posture applied to every other public table by
-- 20260709000000_enable_rls_deny_by_default, and grant the staged NOBYPASSRLS
-- runtime role where it exists.
ALTER TABLE group_orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE group_order_drafts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneflowe_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE group_orders TO oneflowe_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE group_order_drafts TO oneflowe_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE group_orders_id_seq TO oneflowe_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE group_order_drafts_id_seq TO oneflowe_runtime';
  END IF;
END $$;
