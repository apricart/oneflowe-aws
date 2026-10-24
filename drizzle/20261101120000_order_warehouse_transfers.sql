-- An order may be transferred from one Apricart warehouse to another.
-- See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 3, as built).
--
--   * orders.fulfillment_warehouse_id — the warehouse a transferred order now
--     belongs to. Nullable with no default, so Postgres records the column in
--     the catalogue without rewriting orders, and every existing order reads
--     null: "worked by whoever serves its branch", exactly as before.
--   * order_warehouse_transfers — one row per transfer, never updated.
--
-- The foreign key on orders is added NOT VALID and validated separately, so
-- the brief lock it takes does not wait on a scan; every row is null, so the
-- validation reads the table once and writes nothing. The partial index holds
-- transferred orders only, so it starts empty.
--
-- Apply before deploying: every order read that selects the whole row, and
-- every warehouse read, selects the new column.
--
-- Rollback (after deploying the previous code):
--   DROP TABLE IF EXISTS "order_warehouse_transfers";
--   DROP INDEX IF EXISTS "orders_fulfillment_warehouse_idx";
--   ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_fulfillment_warehouse_id_apricart_warehouses_id_fk";
--   ALTER TABLE "orders" DROP COLUMN IF EXISTS "fulfillment_warehouse_id";

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fulfillment_warehouse_id" integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_fulfillment_warehouse_id_apricart_warehouses_id_fk'
      AND conrelid = '"orders"'::regclass
  ) THEN
    ALTER TABLE "orders" ADD CONSTRAINT "orders_fulfillment_warehouse_id_apricart_warehouses_id_fk"
      FOREIGN KEY ("fulfillment_warehouse_id") REFERENCES "public"."apricart_warehouses"("id")
      ON DELETE no action ON UPDATE no action NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_fulfillment_warehouse_id_apricart_warehouses_id_fk";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_fulfillment_warehouse_idx" ON "orders" USING btree ("fulfillment_warehouse_id","status") WHERE "orders"."fulfillment_warehouse_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_warehouse_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"from_warehouse_id" integer,
	"to_warehouse_id" integer,
	"reason" varchar(500) NOT NULL,
	"transferred_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_warehouse_transfers_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "order_warehouse_transfers_from_warehouse_id_apricart_warehouses_id_fk" FOREIGN KEY ("from_warehouse_id") REFERENCES "public"."apricart_warehouses"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "order_warehouse_transfers_to_warehouse_id_apricart_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."apricart_warehouses"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "order_warehouse_transfers_transferred_by_user_id_users_id_fk" FOREIGN KEY ("transferred_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "order_warehouse_transfers_moves_ck" CHECK ("from_warehouse_id" IS DISTINCT FROM "to_warehouse_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_warehouse_transfers_order_idx" ON "order_warehouse_transfers" USING btree ("order_id","id");
