-- Purchasing into Apricart warehouses. See plans/OF-PROCUREMENT-purchasing.md.
--
-- Additive only:
--
--   * the PROCUREMENT row in roles, as the other Apricart roles' were (the
--     general seed rewrites role_permissions, so it is never run on production).
--   * procurement_settings — one row (id 1) holding the over-delivery
--     tolerance. Absent until Super Admin first changes it; absent reads 20%.
--   * suppliers, requisitions, purchase orders, goods receipts, supplier
--     invoices and customer returns, each with its lines. All new and empty.
--   * stock_movements gains two movement types (PURCHASE_RECEIPT,
--     CUSTOMER_RETURN) and the document each one came from. The table is
--     append-only and empty in production until the stock opening is run.
--
-- Goods receipts and their lines are append-only, by the same trigger rule as
-- stock_movements: UPDATE never, DELETE only in test cleanup.
--
-- Rollback (after deactivating every Procurement account):
--   DROP TABLE IF EXISTS "customer_return_lines", "customer_returns",
--     "supplier_invoice_lines", "supplier_invoices", "goods_receipt_lines",
--     "goods_receipts", "purchase_order_lines", "purchase_orders",
--     "purchase_requisition_lines", "purchase_requisitions",
--     "procurement_suppliers", "procurement_settings";
--   DROP FUNCTION IF EXISTS goods_receipts_guard_change();
--   ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "stock_movements_receipt_ck",
--     DROP CONSTRAINT IF EXISTS "stock_movements_return_ck",
--     DROP COLUMN IF EXISTS "goods_receipt_id", DROP COLUMN IF EXISTS "customer_return_id";
--   (then restore stock_movements_type_ck to OPENING, ADJUSTMENT, ORDER_ISSUE)
--   DELETE FROM "roles" WHERE "name" = 'PROCUREMENT' AND NOT EXISTS (
--     SELECT 1 FROM "users" WHERE "users"."role_id" = "roles"."id");
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791136800000;

INSERT INTO "roles" ("name", "description")
SELECT 'PROCUREMENT', 'Apricart procurement: suppliers, purchase orders and supplier invoices for Apricart warehouses'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'PROCUREMENT');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "procurement_settings" (
  "id" integer PRIMARY KEY NOT NULL,
  "over_delivery_tolerance_bps" integer NOT NULL,
  "updated_by_user_id" uuid,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "procurement_settings_single_row_ck" CHECK ("id" = 1),
  CONSTRAINT "procurement_settings_tolerance_ck" CHECK ("over_delivery_tolerance_bps" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "procurement_suppliers" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(200) NOT NULL,
  "contact_name" varchar(200),
  "phone" varchar(32),
  "email" varchar(255),
  "address" varchar(500),
  "ntn" varchar(64),
  "status" varchar(16) DEFAULT 'ACTIVE' NOT NULL,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "procurement_suppliers_status_ck" CHECK ("status" IN ('ACTIVE', 'INACTIVE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "procurement_suppliers_name_uq" ON "procurement_suppliers" (lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_requisitions" (
  "id" serial PRIMARY KEY NOT NULL,
  "warehouse_id" integer NOT NULL REFERENCES "apricart_warehouses" ("id"),
  "status" varchar(16) DEFAULT 'SUBMITTED' NOT NULL,
  "note" varchar(1000),
  "requested_by_user_id" uuid,
  "requested_by_role" varchar(64),
  "decided_by_user_id" uuid,
  "decided_at" timestamp with time zone,
  "decision_reason" varchar(500),
  "purchase_order_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "purchase_requisitions_status_ck" CHECK ("status" IN ('SUBMITTED', 'CONVERTED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT "purchase_requisitions_converted_ck" CHECK (("status" = 'CONVERTED') = ("purchase_order_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_requisitions_warehouse_idx" ON "purchase_requisitions" ("warehouse_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_requisition_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "requisition_id" integer NOT NULL REFERENCES "purchase_requisitions" ("id") ON DELETE CASCADE,
  "global_product_id" integer NOT NULL REFERENCES "global_products" ("id"),
  "quantity" numeric(12, 3) NOT NULL,
  "note" varchar(500),
  CONSTRAINT "purchase_requisition_lines_quantity_ck" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_requisition_lines_product_uq" ON "purchase_requisition_lines" ("requisition_id", "global_product_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_orders" (
  "id" serial PRIMARY KEY NOT NULL,
  "supplier_id" integer NOT NULL REFERENCES "procurement_suppliers" ("id"),
  "warehouse_id" integer NOT NULL REFERENCES "apricart_warehouses" ("id"),
  "requisition_id" integer REFERENCES "purchase_requisitions" ("id"),
  "status" varchar(24) DEFAULT 'DRAFT' NOT NULL,
  "expected_delivery_date" date,
  "notes" varchar(1000),
  "over_delivery_tolerance_bps" integer,
  "subtotal_cents" bigint DEFAULT 0 NOT NULL,
  "tax_cents" bigint DEFAULT 0 NOT NULL,
  "total_cents" bigint DEFAULT 0 NOT NULL,
  "created_by_user_id" uuid,
  "submitted_at" timestamp with time zone,
  "approved_by_user_id" uuid,
  "approved_at" timestamp with time zone,
  "decided_by_user_id" uuid,
  "decided_at" timestamp with time zone,
  "decision_reason" varchar(500),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "purchase_orders_status_ck" CHECK ("status" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT "purchase_orders_tolerance_ck" CHECK ("over_delivery_tolerance_bps" IS NULL OR "over_delivery_tolerance_bps" BETWEEN 0 AND 10000),
  CONSTRAINT "purchase_orders_approved_ck" CHECK (
    "status" NOT IN ('APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED')
    OR ("approved_at" IS NOT NULL AND "over_delivery_tolerance_bps" IS NOT NULL)
  ),
  CONSTRAINT "purchase_orders_totals_ck" CHECK ("subtotal_cents" >= 0 AND "tax_cents" >= 0 AND "total_cents" = "subtotal_cents" + "tax_cents")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_status_idx" ON "purchase_orders" ("status", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_warehouse_idx" ON "purchase_orders" ("warehouse_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_supplier_idx" ON "purchase_orders" ("supplier_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_orders_requisition_uq" ON "purchase_orders" ("requisition_id") WHERE "requisition_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_order_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "purchase_order_id" integer NOT NULL REFERENCES "purchase_orders" ("id") ON DELETE CASCADE,
  "global_product_id" integer NOT NULL REFERENCES "global_products" ("id"),
  "quantity" numeric(12, 3) NOT NULL,
  "unit_cost_cents" bigint NOT NULL,
  "tax_rate_bps" integer DEFAULT 0 NOT NULL,
  "line_net_cents" bigint NOT NULL,
  "line_tax_cents" bigint NOT NULL,
  "line_total_cents" bigint NOT NULL,
  "received_quantity" numeric(12, 3) DEFAULT 0 NOT NULL,
  CONSTRAINT "purchase_order_lines_quantity_ck" CHECK ("quantity" > 0),
  CONSTRAINT "purchase_order_lines_cost_ck" CHECK ("unit_cost_cents" >= 0 AND "line_net_cents" >= 0 AND "line_tax_cents" >= 0 AND "line_total_cents" = "line_net_cents" + "line_tax_cents"),
  CONSTRAINT "purchase_order_lines_tax_rate_ck" CHECK ("tax_rate_bps" BETWEEN 0 AND 10000),
  CONSTRAINT "purchase_order_lines_received_ck" CHECK ("received_quantity" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_order_lines_product_uq" ON "purchase_order_lines" ("purchase_order_id", "global_product_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goods_receipts" (
  "id" serial PRIMARY KEY NOT NULL,
  "purchase_order_id" integer NOT NULL REFERENCES "purchase_orders" ("id"),
  "warehouse_id" integer NOT NULL REFERENCES "apricart_warehouses" ("id"),
  "supplier_delivery_note" varchar(120),
  "notes" varchar(1000),
  "received_by_user_id" uuid,
  "received_by_role" varchar(64),
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goods_receipts_po_idx" ON "goods_receipts" ("purchase_order_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goods_receipt_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "goods_receipt_id" integer NOT NULL REFERENCES "goods_receipts" ("id"),
  "purchase_order_line_id" integer NOT NULL REFERENCES "purchase_order_lines" ("id"),
  "global_product_id" integer NOT NULL REFERENCES "global_products" ("id"),
  "quantity" numeric(12, 3) NOT NULL,
  CONSTRAINT "goods_receipt_lines_quantity_ck" CHECK ("quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "goods_receipt_lines_po_line_uq" ON "goods_receipt_lines" ("goods_receipt_id", "purchase_order_line_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION goods_receipts_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND stock_ledger_test_cleanup_allowed() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'procurement: % on % is not allowed; goods receipts are append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS goods_receipts_guard_trg ON goods_receipts;
--> statement-breakpoint
CREATE TRIGGER goods_receipts_guard_trg BEFORE UPDATE OR DELETE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION goods_receipts_guard_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS goods_receipt_lines_guard_trg ON goods_receipt_lines;
--> statement-breakpoint
CREATE TRIGGER goods_receipt_lines_guard_trg BEFORE UPDATE OR DELETE ON goods_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION goods_receipts_guard_change();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_invoices" (
  "id" serial PRIMARY KEY NOT NULL,
  "supplier_id" integer NOT NULL REFERENCES "procurement_suppliers" ("id"),
  "purchase_order_id" integer NOT NULL REFERENCES "purchase_orders" ("id"),
  "invoice_number" varchar(64) NOT NULL,
  "invoice_date" date NOT NULL,
  "subtotal_cents" bigint NOT NULL,
  "tax_cents" bigint NOT NULL,
  "total_cents" bigint NOT NULL,
  "match_status" varchar(16) NOT NULL,
  "status" varchar(16) DEFAULT 'RECORDED' NOT NULL,
  "recorded_by_user_id" uuid,
  "recorded_by_role" varchar(64),
  "decided_by_user_id" uuid,
  "decided_at" timestamp with time zone,
  "decision_reason" varchar(500),
  "paid_by_user_id" uuid,
  "paid_at" timestamp with time zone,
  "payment_reference" varchar(120),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_invoices_match_ck" CHECK ("match_status" IN ('MATCHED', 'EXCEPTION')),
  CONSTRAINT "supplier_invoices_status_ck" CHECK ("status" IN ('RECORDED', 'APPROVED', 'REJECTED', 'PAID')),
  CONSTRAINT "supplier_invoices_totals_ck" CHECK ("subtotal_cents" >= 0 AND "tax_cents" >= 0 AND "total_cents" = "subtotal_cents" + "tax_cents"),
  CONSTRAINT "supplier_invoices_paid_ck" CHECK (("status" = 'PAID') = ("paid_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_invoices_number_uq" ON "supplier_invoices" ("supplier_id", lower("invoice_number"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_invoices_po_idx" ON "supplier_invoices" ("purchase_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_invoices_status_idx" ON "supplier_invoices" ("status", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "supplier_invoice_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "supplier_invoice_id" integer NOT NULL REFERENCES "supplier_invoices" ("id") ON DELETE CASCADE,
  "purchase_order_line_id" integer NOT NULL REFERENCES "purchase_order_lines" ("id"),
  "quantity" numeric(12, 3) NOT NULL,
  "unit_cost_cents" bigint NOT NULL,
  "line_net_cents" bigint NOT NULL,
  "line_tax_cents" bigint NOT NULL,
  "line_total_cents" bigint NOT NULL,
  CONSTRAINT "supplier_invoice_lines_quantity_ck" CHECK ("quantity" > 0),
  CONSTRAINT "supplier_invoice_lines_cost_ck" CHECK ("unit_cost_cents" >= 0 AND "line_net_cents" >= 0 AND "line_tax_cents" >= 0 AND "line_total_cents" = "line_net_cents" + "line_tax_cents")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supplier_invoice_lines_po_line_uq" ON "supplier_invoice_lines" ("supplier_invoice_id", "purchase_order_line_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_returns" (
  "id" serial PRIMARY KEY NOT NULL,
  "warehouse_id" integer NOT NULL REFERENCES "apricart_warehouses" ("id"),
  "order_id" integer REFERENCES "orders" ("id") ON DELETE SET NULL,
  "status" varchar(16) DEFAULT 'PENDING' NOT NULL,
  "reason" varchar(1000) NOT NULL,
  "recorded_by_user_id" uuid,
  "recorded_by_role" varchar(64),
  "decided_by_user_id" uuid,
  "decided_by_role" varchar(64),
  "decided_at" timestamp with time zone,
  "decision_reason" varchar(500),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customer_returns_status_ck" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_returns_warehouse_idx" ON "customer_returns" ("warehouse_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_return_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "customer_return_id" integer NOT NULL REFERENCES "customer_returns" ("id") ON DELETE CASCADE,
  "global_product_id" integer NOT NULL REFERENCES "global_products" ("id"),
  "quantity" numeric(12, 3) NOT NULL,
  "condition" varchar(16) NOT NULL,
  CONSTRAINT "customer_return_lines_quantity_ck" CHECK ("quantity" > 0),
  CONSTRAINT "customer_return_lines_condition_ck" CHECK ("condition" IN ('RESALEABLE', 'DAMAGED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_return_lines_product_uq" ON "customer_return_lines" ("customer_return_id", "global_product_id", "condition");
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "goods_receipt_id" integer;
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "customer_return_id" integer;
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "stock_movements_type_ck";
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_ck"
  CHECK ("movement_type" IN ('OPENING', 'ADJUSTMENT', 'ORDER_ISSUE', 'PURCHASE_RECEIPT', 'CUSTOMER_RETURN'));
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "stock_movements_receipt_ck";
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_receipt_ck"
  CHECK (("movement_type" = 'PURCHASE_RECEIPT') = ("goods_receipt_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT IF EXISTS "stock_movements_return_ck";
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_return_ck"
  CHECK (("movement_type" = 'CUSTOMER_RETURN') = ("customer_return_id" IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_movements_receipt_uq" ON "stock_movements" ("goods_receipt_id", "global_product_id") WHERE "movement_type" = 'PURCHASE_RECEIPT';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stock_movements_return_uq" ON "stock_movements" ("customer_return_id", "global_product_id") WHERE "movement_type" = 'CUSTOMER_RETURN';
