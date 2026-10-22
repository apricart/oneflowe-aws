-- Apricart warehouses as places, their members, and each branch's default
-- warehouse. Configuration only: no order, reach, notification or decision
-- reads these tables yet. See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
--
--   * apricart_warehouses — never deleted; INACTIVE instead.
--   * apricart_warehouse_memberships — WAREHOUSE_OPERATOR (a WAREHOUSE account)
--     or EXECUTIVE (an APRICART_EXECUTIVE account); the server derives which
--     from the account's role.
--   * branch_fulfillment_routes — at most one warehouse per branch.
--
-- Additive. No existing table is altered and no row is written.
--
-- Apply before deploying: the Warehouse Team page's Warehouses section reads
-- these tables (nothing else does).
--
-- Rollback (after deploying the previous code):
--   DROP TABLE IF EXISTS "branch_fulfillment_routes";
--   DROP TABLE IF EXISTS "apricart_warehouse_memberships";
--   DROP TABLE IF EXISTS "apricart_warehouses";

CREATE TABLE IF NOT EXISTS "apricart_warehouses" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(20) NOT NULL,
	"name" varchar(150) NOT NULL,
	"city" varchar(100),
	"address" varchar(500),
	"contact_phone" varchar(30),
	"status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apricart_warehouses_status_ck" CHECK ("status" IN ('ACTIVE', 'INACTIVE'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apricart_warehouses_code_uq" ON "apricart_warehouses" USING btree ("code");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "apricart_warehouse_memberships" (
	"id" serial PRIMARY KEY NOT NULL,
	"warehouse_id" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"responsibility" varchar(30) NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apricart_warehouse_memberships_warehouse_id_apricart_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."apricart_warehouses"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "apricart_warehouse_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "apricart_warehouse_memberships_responsibility_ck" CHECK ("responsibility" IN ('WAREHOUSE_OPERATOR', 'EXECUTIVE'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apricart_warehouse_memberships_warehouse_user_uq" ON "apricart_warehouse_memberships" USING btree ("warehouse_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apricart_warehouse_memberships_user_idx" ON "apricart_warehouse_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "branch_fulfillment_routes" (
	"branch_id" integer PRIMARY KEY NOT NULL,
	"warehouse_id" integer NOT NULL,
	"created_by_user_id" uuid,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_fulfillment_routes_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "branch_fulfillment_routes_warehouse_id_apricart_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."apricart_warehouses"("id") ON DELETE no action ON UPDATE no action
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branch_fulfillment_routes_warehouse_idx" ON "branch_fulfillment_routes" USING btree ("warehouse_id");
