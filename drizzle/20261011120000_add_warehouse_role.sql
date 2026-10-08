-- The Warehouse role: Apricart staff who pick, dispatch and deliver the
-- approved orders of the branches assigned to them.
-- See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
--
-- Additive only:
--
--   * the WAREHOUSE row in roles. Inserted here rather than by running the
--     general seed against production (the seed rewrites role_permissions),
--     as ORDER_DESK's and APRICART_EXECUTIVE's were.
--   * warehouse_assignments — which branches each warehouse user serves. One
--     row per user per branch; there is no organization-wide row. New and
--     empty: no warehouse user reaches anything until Super Admin assigns a
--     branch.
--
-- No backfill. Nothing existing reads the new table.
--
-- Apply before deploying: the warehouse routes read the new table, and
-- creating a warehouse account needs the role row.
--
-- Rollback (after deactivating every warehouse account):
--   DROP TABLE IF EXISTS "warehouse_assignments";
--   DELETE FROM "roles" WHERE "name" = 'WAREHOUSE' AND NOT EXISTS (
--     SELECT 1 FROM "users" WHERE "users"."role_id" = "roles"."id");

INSERT INTO "roles" ("name", "description")
SELECT 'WAREHOUSE', 'Apricart warehouse: picks, dispatches and delivers approved orders for assigned branches'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'WAREHOUSE');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "warehouse_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"branch_id" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "warehouse_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "warehouse_assignments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_assignments_user_branch_uq" ON "warehouse_assignments" USING btree ("user_id","branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warehouse_assignments_branch_idx" ON "warehouse_assignments" USING btree ("branch_id");
