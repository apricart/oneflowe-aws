-- Made re-entrant after the fact. Four hand-written migrations that carry an
-- earlier timestamp (invoice_sequences, product quantity budgets, decimal
-- quantities, and the branch/order/user columns below) already create most of
-- what this generated migration creates, so on a database built from an empty
-- schema the original unguarded statements aborted the whole run. Every
-- statement here is now conditional on the object's actual state, which makes
-- this file a no-op against any database that already has these objects.
--
-- Only the file contents changed; its journal timestamp is untouched, and
-- drizzle replays by timestamp watermark rather than by content hash, so this
-- is never re-executed on a database that has already recorded it.

CREATE TABLE IF NOT EXISTS "invoice_sequences" (
	"organization_id" integer PRIMARY KEY NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_quantity_budget_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"quantity_budget_id" integer NOT NULL,
	"budget_id" integer,
	"organization_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"organization_inventory_id" integer NOT NULL,
	"global_product_id" integer NOT NULL,
	"period" varchar(16) NOT NULL,
	"allocation_type" varchar(32) NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"price_cents" bigint NOT NULL,
	"amount_cents" bigint NOT NULL,
	"created_by_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_quantity_budgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"organization_inventory_id" integer NOT NULL,
	"global_product_id" integer NOT NULL,
	"period" varchar(16) NOT NULL,
	"allocated_quantity" numeric(12, 3) DEFAULT 0 NOT NULL,
	"held_quantity" numeric(12, 3) DEFAULT 0 NOT NULL,
	"used_quantity" numeric(12, 3) DEFAULT 0 NOT NULL,
	"credited_quantity" numeric(12, 3) DEFAULT 0 NOT NULL,
	"amount_allocated_cents" bigint DEFAULT 0 NOT NULL,
	"amount_credited_cents" bigint DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'global_products' AND column_name = 'stock_quantity'
      AND NOT (data_type = 'numeric' AND numeric_precision = 12 AND numeric_scale = 3)
  ) THEN
    ALTER TABLE "global_products" ALTER COLUMN "stock_quantity" SET DATA TYPE numeric(12, 3);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name = 'quantity'
      AND NOT (data_type = 'numeric' AND numeric_precision = 12 AND numeric_scale = 3)
  ) THEN
    ALTER TABLE "order_items" ALTER COLUMN "quantity" SET DATA TYPE numeric(12, 3);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'refund_items' AND column_name = 'quantity'
      AND NOT (data_type = 'numeric' AND numeric_precision = 12 AND numeric_scale = 3)
  ) THEN
    ALTER TABLE "refund_items" ALTER COLUMN "quantity" SET DATA TYPE numeric(12, 3);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'restock_requests' AND column_name = 'requested_quantity'
      AND NOT (data_type = 'numeric' AND numeric_precision = 12 AND numeric_scale = 3)
  ) THEN
    ALTER TABLE "restock_requests" ALTER COLUMN "requested_quantity" SET DATA TYPE numeric(12, 3);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'restock_requests' AND column_name = 'current_stock'
      AND NOT (data_type = 'numeric' AND numeric_precision = 12 AND numeric_scale = 3)
  ) THEN
    ALTER TABLE "restock_requests" ALTER COLUMN "current_stock" SET DATA TYPE numeric(12, 3);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "province" varchar(100);
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "city" varchar(100);
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "address" text;
--> statement-breakpoint
ALTER TABLE "global_products" ADD COLUMN IF NOT EXISTS "allow_decimal_quantity" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "global_products" ADD COLUMN IF NOT EXISTS "quantity_step" numeric(12, 3) DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "organization_inventory_id" integer;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "fulfillment_status" varchar(32) DEFAULT 'NOT_STARTED' NOT NULL;
--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "refund_number" varchar(20);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "must_change_password" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoice_sequences_organization_id_organizations_id_fk' AND conrelid = 'public.invoice_sequences'::regclass
  ) THEN
    ALTER TABLE "invoice_sequences" ADD CONSTRAINT "invoice_sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budget_allocations_quantity_budget_id_product_quantity_budgets_id_fk' AND conrelid = 'public.product_quantity_budget_allocations'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budget_allocations" ADD CONSTRAINT "product_quantity_budget_allocations_quantity_budget_id_product_quantity_budgets_id_fk" FOREIGN KEY ("quantity_budget_id") REFERENCES "public"."product_quantity_budgets"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budget_allocations_budget_id_budgets_id_fk' AND conrelid = 'public.product_quantity_budget_allocations'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budget_allocations" ADD CONSTRAINT "product_quantity_budget_allocations_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budget_allocations_organization_id_organizations_id_fk' AND conrelid = 'public.product_quantity_budget_allocations'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budget_allocations" ADD CONSTRAINT "product_quantity_budget_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budget_allocations_branch_id_branches_id_fk' AND conrelid = 'public.product_quantity_budget_allocations'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budget_allocations" ADD CONSTRAINT "product_quantity_budget_allocations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budget_allocations_organization_inventory_id_organization_inventory_id_fk' AND conrelid = 'public.product_quantity_budget_allocations'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budget_allocations" ADD CONSTRAINT "product_quantity_budget_allocations_organization_inventory_id_organization_inventory_id_fk" FOREIGN KEY ("organization_inventory_id") REFERENCES "public"."organization_inventory"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budget_allocations_global_product_id_global_products_id_fk' AND conrelid = 'public.product_quantity_budget_allocations'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budget_allocations" ADD CONSTRAINT "product_quantity_budget_allocations_global_product_id_global_products_id_fk" FOREIGN KEY ("global_product_id") REFERENCES "public"."global_products"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budget_allocations_created_by_user_id_users_id_fk' AND conrelid = 'public.product_quantity_budget_allocations'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budget_allocations" ADD CONSTRAINT "product_quantity_budget_allocations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budgets_organization_id_organizations_id_fk' AND conrelid = 'public.product_quantity_budgets'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budgets" ADD CONSTRAINT "product_quantity_budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budgets_branch_id_branches_id_fk' AND conrelid = 'public.product_quantity_budgets'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budgets" ADD CONSTRAINT "product_quantity_budgets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budgets_organization_inventory_id_organization_inventory_id_fk' AND conrelid = 'public.product_quantity_budgets'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budgets" ADD CONSTRAINT "product_quantity_budgets_organization_inventory_id_organization_inventory_id_fk" FOREIGN KEY ("organization_inventory_id") REFERENCES "public"."organization_inventory"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budgets_global_product_id_global_products_id_fk' AND conrelid = 'public.product_quantity_budgets'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budgets" ADD CONSTRAINT "product_quantity_budgets_global_product_id_global_products_id_fk" FOREIGN KEY ("global_product_id") REFERENCES "public"."global_products"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budgets_created_by_user_id_users_id_fk' AND conrelid = 'public.product_quantity_budgets'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budgets" ADD CONSTRAINT "product_quantity_budgets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_quantity_budgets_updated_by_user_id_users_id_fk' AND conrelid = 'public.product_quantity_budgets'::regclass
  ) THEN
    ALTER TABLE "product_quantity_budgets" ADD CONSTRAINT "product_quantity_budgets_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_quantity_budget_allocations_budget_idx" ON "product_quantity_budget_allocations" USING btree ("quantity_budget_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_quantity_budget_allocations_branch_idx" ON "product_quantity_budget_allocations" USING btree ("branch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_quantity_budget_allocations_product_idx" ON "product_quantity_budget_allocations" USING btree ("global_product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_quantity_budget_allocations_period_idx" ON "product_quantity_budget_allocations" USING btree ("period");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_quantity_budgets_branch_product_period_uq" ON "product_quantity_budgets" USING btree ("branch_id","organization_inventory_id","period");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_quantity_budgets_org_idx" ON "product_quantity_budgets" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_quantity_budgets_branch_idx" ON "product_quantity_budgets" USING btree ("branch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_quantity_budgets_product_idx" ON "product_quantity_budgets" USING btree ("global_product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_quantity_budgets_period_idx" ON "product_quantity_budgets" USING btree ("period");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_organization_inventory_idx" ON "order_items" USING btree ("organization_inventory_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_fulfillment_status_idx" ON "orders" USING btree ("fulfillment_status");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'refunds_refund_number_unique' AND conrelid = 'public.refunds'::regclass
  ) THEN
    ALTER TABLE "refunds" ADD CONSTRAINT "refunds_refund_number_unique" UNIQUE("refund_number");
  END IF;
END $$;
