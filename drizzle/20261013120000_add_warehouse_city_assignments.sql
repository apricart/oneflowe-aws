-- Warehouse city assignments: Super Admin assigns a warehouse user a whole
-- city, and every branch whose normalised city matches is served — including
-- branches opened in that city later.
-- See plans/OF-WAREHOUSE-city-assignments.md.
--
-- Additive only:
--
--   * warehouse_city_assignments — one row per user per city key. New and
--     empty: nothing changes for any warehouse user until a city is assigned.
--   * branches_city_key_idx — an expression index on the normalised city. The
--     expression must stay identical to branchCityKeySql
--     (lib/server/branch-city-key.ts), or the planner will not use it.
--     branches is small, so a plain CREATE INDEX holds its lock only briefly.
--
-- No backfill. Explicit branch assignments (warehouse_assignments) are
-- untouched and still apply.
--
-- Apply before deploying: the warehouse reach reads the new table.
--
-- Rollback (warehouse users keep their explicit branches):
--   DROP TABLE IF EXISTS "warehouse_city_assignments";
--   DROP INDEX IF EXISTS "branches_city_key_idx";

CREATE TABLE IF NOT EXISTS "warehouse_city_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"city_key" varchar(100) NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "warehouse_city_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "warehouse_city_assignments_city_key_ck" CHECK (btrim("city_key") <> '')
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_city_assignments_user_city_uq" ON "warehouse_city_assignments" USING btree ("user_id","city_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warehouse_city_assignments_city_idx" ON "warehouse_city_assignments" USING btree ("city_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branches_city_key_idx" ON "branches" USING btree (lower(btrim(regexp_replace("city", '\s+', ' ', 'g'))));
