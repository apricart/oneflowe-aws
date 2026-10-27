-- Warehouses own branches by rule, and an operator works all of a warehouse's
-- branches or a selection of them.
-- See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2).
--
--   * warehouse_route_rules — "organization X" (city_key null) or
--     "organization X in city Y" -> warehouse. Evaluated at read time, never
--     copied into rows. One rule per organization and per (organization, city).
--   * apricart_warehouse_memberships.branch_scope — ALL (default, so every
--     existing membership keeps meaning what it means) or SELECTED.
--   * apricart_warehouse_member_branches — the selection of a SELECTED operator.
--
-- Additive. No existing row changes meaning: nothing reads any of this while
-- WAREHOUSE_ORDER_OWNERSHIP (lib/warehouse-ownership-policy.ts) is "branch",
-- and the column is added with a constant default, which Postgres records in
-- the catalogue without rewriting the table.
--
-- Apply before deploying: the Warehouse Team page's Warehouses section selects
-- the new column and tables.
--
-- Rollback (after deploying the previous code, or with the mode still "branch"):
--   DROP TABLE IF EXISTS "apricart_warehouse_member_branches";
--   DROP TABLE IF EXISTS "warehouse_route_rules";
--   ALTER TABLE "apricart_warehouse_memberships" DROP CONSTRAINT IF EXISTS "apricart_warehouse_memberships_branch_scope_ck";
--   ALTER TABLE "apricart_warehouse_memberships" DROP COLUMN IF EXISTS "branch_scope";
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791129600000;

ALTER TABLE "apricart_warehouse_memberships" ADD COLUMN IF NOT EXISTS "branch_scope" varchar(16) DEFAULT 'ALL' NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'apricart_warehouse_memberships_branch_scope_ck'
      AND conrelid = '"apricart_warehouse_memberships"'::regclass
  ) THEN
    ALTER TABLE "apricart_warehouse_memberships" ADD CONSTRAINT "apricart_warehouse_memberships_branch_scope_ck"
      CHECK ("branch_scope" IN ('ALL', 'SELECTED') AND ("branch_scope" = 'ALL' OR "responsibility" = 'WAREHOUSE_OPERATOR'));
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "apricart_warehouse_member_branches" (
	"id" serial PRIMARY KEY NOT NULL,
	"membership_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apricart_warehouse_member_branches_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."apricart_warehouse_memberships"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "apricart_warehouse_member_branches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apricart_warehouse_member_branches_uq" ON "apricart_warehouse_member_branches" USING btree ("membership_id","branch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apricart_warehouse_member_branches_branch_idx" ON "apricart_warehouse_member_branches" USING btree ("branch_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "warehouse_route_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"warehouse_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"city_key" varchar(100),
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_route_rules_warehouse_id_apricart_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."apricart_warehouses"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "warehouse_route_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "warehouse_route_rules_city_key_ck" CHECK ("city_key" IS NULL OR btrim("city_key") <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_route_rules_org_uq" ON "warehouse_route_rules" USING btree ("organization_id") WHERE "warehouse_route_rules"."city_key" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_route_rules_org_city_uq" ON "warehouse_route_rules" USING btree ("organization_id","city_key") WHERE "warehouse_route_rules"."city_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warehouse_route_rules_warehouse_idx" ON "warehouse_route_rules" USING btree ("warehouse_id");
