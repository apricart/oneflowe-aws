-- Department sign-up: the city and province of a branch the applicant asks to
-- have created. See plans/OF-JOIN-applicant-new-branch-city.md.
--
-- Before this, the applicant gave a new branch its name and CRC only, and Head
-- Office chose its city at review. The applicant now chooses the city from
-- Pakistan's list (lib/pakistan-cities.ts) and the province follows from it;
-- Head Office's review starts from that choice and may still change it.
--
-- Additive only. Nullable with no default: a request submitted before this
-- reads null, and Head Office chooses that branch's city at review as before.
-- Only a row for a branch still to be created (a CRC) may carry a location,
-- and then both halves of it. Both are named NOT NULL in the check because
-- length(btrim(NULL)) is NULL, which a CHECK accepts. The table is small, so the
-- check is added and validated at once.
--
-- Apply before deploying: the join reads select the columns.
--
-- Rollback (after reverting the code that reads them):
--   ALTER TABLE "organization_join_request_branches" DROP CONSTRAINT IF EXISTS "organization_join_request_branches_location_ck";
--   ALTER TABLE "organization_join_request_branches" DROP COLUMN IF EXISTS "requested_branch_city";
--   ALTER TABLE "organization_join_request_branches" DROP COLUMN IF EXISTS "requested_branch_province";

ALTER TABLE "organization_join_request_branches" ADD COLUMN IF NOT EXISTS "requested_branch_city" varchar(100);--> statement-breakpoint
ALTER TABLE "organization_join_request_branches" ADD COLUMN IF NOT EXISTS "requested_branch_province" varchar(100);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_join_request_branches" ADD CONSTRAINT "organization_join_request_branches_location_ck"
    CHECK (("requested_branch_city" IS NULL AND "requested_branch_province" IS NULL)
      OR ("cost_center_id" IS NOT NULL
        AND "requested_branch_city" IS NOT NULL
        AND "requested_branch_province" IS NOT NULL
        AND length(btrim("requested_branch_city")) > 0
        AND length(btrim("requested_branch_province")) > 0));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
