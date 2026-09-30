-- Record the role an order's creator held when they raised it.
--
-- Attribution reports ("user performance", the requester filter list, the
-- budget-burn watchlist, the orders `createdByRole` tab) group orders by the
-- requester role. Every one of them read that role live from users -> roles,
-- so it was really "the creator's role today", not "the role they raised this
-- order under". Once a user's role can be changed from the admin UI, promoting
-- an ORDER_PORTAL user to BRANCH_ADMIN silently removes every order they ever
-- raised from those reports, and demoting one adds orders that were never a
-- requester's.
--
-- This pins the role at creation, the same way status_at_refund already pins
-- the status a refund was taken against on this same table.
--
-- Production safety:
--   * purely additive: one nullable column, no default, no rewrite;
--   * ALTER TABLE ... ADD COLUMN with no default does not rewrite the table and
--     takes only a brief ACCESS EXCLUSIVE lock, so it is safe on a large
--     orders table;
--   * no existing row is modified — history is filled separately by
--     `npm run backfill:order-creator-roles`, which is dry-run by default;
--   * every reader falls back to the live users -> roles join while the column
--     is NULL (lib/server/order-creator-role-sql.ts), so reports return exactly
--     what they return today both before and during the backfill;
--   * rollback is `ALTER TABLE orders DROP COLUMN created_by_role` — nothing
--     else depends on it.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by_role varchar(32);
--> statement-breakpoint

COMMENT ON COLUMN orders.created_by_role IS
  'Role the creator held when this order was raised. NULL for rows predating the column; readers fall back to the live users->roles join. Never updated after insert.';
--> statement-breakpoint

-- Supports the attribution reports, which filter orders by the recorded
-- requester role and group by creator. Partial: rows that predate the column
-- are resolved through the fallback join, never through this index.
CREATE INDEX IF NOT EXISTS orders_created_by_role_idx
  ON orders (created_by_role, created_by_user_id)
  WHERE created_by_role IS NOT NULL;
