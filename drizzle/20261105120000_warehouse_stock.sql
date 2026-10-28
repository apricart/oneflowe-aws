-- Stock per Apricart warehouse, and the history of every change to it.
-- See plans/OF-STOCK-per-warehouse-stock.md.
--
--   * warehouse_stock — the on-hand figure of one product at one warehouse.
--   * stock_movements — append-only: every change to an on-hand figure, with
--     the figure after it. A trigger refuses UPDATE always, and DELETE except
--     for the opening script's own rollback (naming its batch through
--     oneflowe.stock_ledger_rollback_batch) and test cleanup in a database
--     whose name contains "test".
--
-- Additive: two new tables, no existing table or row is touched. Nothing reads
-- either while STOCK_LEDGER_MODE (lib/stock-ledger-policy.ts) is "global".
--
-- Apply before deploying the code that ships this file (the Warehouse Stock
-- page reads both tables), then commit the opening figures with
-- `npm run open:warehouse-stock`, then switch the mode.
--
-- Rollback (with the mode still "global"):
--   DROP TABLE IF EXISTS "stock_movements";
--   DROP TABLE IF EXISTS "warehouse_stock";
--   DROP FUNCTION IF EXISTS stock_movements_guard_change();
--   DROP FUNCTION IF EXISTS stock_ledger_test_cleanup_allowed();
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791133200000;

CREATE TABLE IF NOT EXISTS "warehouse_stock" (
  "id" serial PRIMARY KEY NOT NULL,
  "warehouse_id" integer NOT NULL REFERENCES "apricart_warehouses" ("id"),
  "global_product_id" integer NOT NULL REFERENCES "global_products" ("id"),
  "on_hand_quantity" numeric(12, 3) DEFAULT 0 NOT NULL,
  "updated_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "warehouse_stock_on_hand_ck" CHECK ("on_hand_quantity" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_stock_warehouse_product_uq" ON "warehouse_stock" ("warehouse_id", "global_product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warehouse_stock_product_idx" ON "warehouse_stock" ("global_product_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_movements" (
  "id" serial PRIMARY KEY NOT NULL,
  "warehouse_id" integer NOT NULL REFERENCES "apricart_warehouses" ("id"),
  "global_product_id" integer NOT NULL REFERENCES "global_products" ("id"),
  "movement_type" varchar(32) NOT NULL,
  "quantity_delta" numeric(12, 3) NOT NULL,
  "balance_after" numeric(12, 3) NOT NULL,
  "order_id" integer,
  "reason" varchar(500),
  "batch_id" varchar(64),
  "actor_user_id" uuid,
  "actor_role" varchar(64),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stock_movements_type_ck" CHECK ("movement_type" IN ('OPENING', 'ADJUSTMENT', 'ORDER_ISSUE')),
  CONSTRAINT "stock_movements_delta_ck" CHECK ("quantity_delta" <> 0),
  CONSTRAINT "stock_movements_balance_ck" CHECK ("balance_after" >= 0),
  CONSTRAINT "stock_movements_order_ck" CHECK (("movement_type" = 'ORDER_ISSUE') = ("order_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_movements_warehouse_product_idx" ON "stock_movements" ("warehouse_id", "global_product_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_movements_order_idx" ON "stock_movements" ("order_id") WHERE "order_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_movements_order_issue_uq" ON "stock_movements" ("order_id", "global_product_id") WHERE "movement_type" = 'ORDER_ISSUE';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stock_ledger_test_cleanup_allowed() RETURNS boolean
LANGUAGE sql STABLE AS $$
  -- Integration suites delete what they created. Allowed only in a database
  -- whose name contains "test" and only when the cleanup asks for it in its own
  -- transaction; never in production.
  SELECT current_database() LIKE '%test%'
    AND coalesce(current_setting('oneflowe.stock_ledger_test_cleanup', true), '') = 'on'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stock_movements_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
    stock_ledger_test_cleanup_allowed()
    OR (OLD.batch_id IS NOT NULL
      AND coalesce(current_setting('oneflowe.stock_ledger_rollback_batch', true), '') = OLD.batch_id)
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'stock ledger: % on stock_movements is not allowed; movements are append-only', TG_OP
    USING ERRCODE = 'P0001';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS stock_movements_guard_trg ON stock_movements;
--> statement-breakpoint
CREATE TRIGGER stock_movements_guard_trg BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_guard_change();
