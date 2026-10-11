-- Apricart's internal Order Desk role.
-- See plans/OF-ORDER-DESK-internal-order-entry.md.
--
-- Additive only. Nothing existing changes behaviour:
--
--   * organizations.managed_ordering — whether the desk keys in this customer's
--     orders. Defaults to false, so no existing tenant (K-Electric included) is
--     reachable by the desk until a Super Admin switches it on.
--   * orders.intake_channel / intake_reference — where a desk order came from.
--     Nullable; every existing order and every portal order keeps null. The
--     CHECK is added in the same statement set: the column is brand new, so
--     every existing row is NULL and the scan finds nothing to reject.
--   * order_desk_assignments — which managed organizations (all branches) or
--     single branches each desk user may order for. A table of its own so desk
--     users never appear in the group roles' assignment-driven reports.
--   * the ORDER_DESK row in roles, inserted here rather than by running the
--     general seed against production (the seed rewrites role_permissions).
--
-- Apply before deploying: order creation selects the organization column.
--
-- Rollback (after deactivating every desk user):
--   DELETE FROM "roles" WHERE "name" = 'ORDER_DESK' AND NOT EXISTS (
--     SELECT 1 FROM "users" WHERE "users"."role_id" = "roles"."id");
--   DROP TABLE "order_desk_assignments";
--   ALTER TABLE "orders" DROP CONSTRAINT "orders_intake_channel_ck";
--   ALTER TABLE "orders" DROP COLUMN "intake_reference";
--   ALTER TABLE "orders" DROP COLUMN "intake_channel";
--   ALTER TABLE "organizations" DROP COLUMN "managed_ordering";

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "managed_ordering" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "intake_channel" varchar(16);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "intake_reference" varchar(255);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_intake_channel_ck" CHECK ("orders"."intake_channel" IS NULL OR "orders"."intake_channel" IN ('EMAIL', 'WHATSAPP', 'PHONE', 'OTHER'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_desk_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" integer NOT NULL,
	"branch_id" integer,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "order_desk_assignments" ADD CONSTRAINT "order_desk_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_desk_assignments" ADD CONSTRAINT "order_desk_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_desk_assignments" ADD CONSTRAINT "order_desk_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_desk_assignments_user_org_uq" ON "order_desk_assignments" USING btree ("user_id","organization_id") WHERE "order_desk_assignments"."branch_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_desk_assignments_user_branch_uq" ON "order_desk_assignments" USING btree ("user_id","branch_id") WHERE "order_desk_assignments"."branch_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_desk_assignments_user_idx" ON "order_desk_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_desk_assignments_org_idx" ON "order_desk_assignments" USING btree ("organization_id");--> statement-breakpoint
INSERT INTO "roles" ("name", "description")
SELECT 'ORDER_DESK', 'Apricart staff who key in and fulfil orders for the managed organizations assigned to them'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'ORDER_DESK');
