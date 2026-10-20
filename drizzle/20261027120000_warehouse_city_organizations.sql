-- Warehouse city rules scoped to chosen organizations: a warehouse user's
-- cities now reach a branch only when the branch's organization is also chosen
-- for that user. See plans/OF-WAREHOUSE-city-assignments-by-organization.md.
--
--   * warehouse_city_organizations — one row per user per organization. Grants
--     nothing on its own; it is intersected with warehouse_city_assignments.
--   * Backfill — for every user who holds a city, every organization that NOW
--     has a branch in one of that user's cities. Every branch reached before is
--     still reached (its organization is in the set by construction) and no
--     other branch is reached. Only a branch in an organization with no branch
--     in the city today stops being reached automatically, which is the change.
--     The city key expression is branchCityKeySql (lib/server/branch-city-key.ts)
--     and branches_city_key_idx; it must stay identical to both.
--
-- Explicit branch assignments (warehouse_assignments) are untouched.
--
-- Apply before deploying: the warehouse reach reads the new table, and without
-- the backfill every city rule reaches nothing.
--
-- Rollback (after deploying the previous code; city rules then reach every
-- organization again):
--   DROP TABLE IF EXISTS "warehouse_city_organizations";

CREATE TABLE IF NOT EXISTS "warehouse_city_organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" integer NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "warehouse_city_organizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "warehouse_city_organizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_city_organizations_user_org_uq" ON "warehouse_city_organizations" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "warehouse_city_organizations_org_idx" ON "warehouse_city_organizations" USING btree ("organization_id");--> statement-breakpoint
INSERT INTO "warehouse_city_organizations" ("user_id", "organization_id")
SELECT DISTINCT wca."user_id", b."organization_id"
FROM "warehouse_city_assignments" wca
INNER JOIN "branches" b ON lower(btrim(regexp_replace(b."city", '\s+', ' ', 'g'))) = wca."city_key"
WHERE b."organization_id" IS NOT NULL
ON CONFLICT ("user_id", "organization_id") DO NOTHING;
