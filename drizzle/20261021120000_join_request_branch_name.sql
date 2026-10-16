-- Department sign-up: the name the applicant gives a branch it asks to have
-- created. See plans/OF-JOIN-department-signup-multi-user.md ("Branches").
--
-- Before this, a new branch was asked for by its CRC alone, and the review
-- dialog offered the CRC as the new branch's name, so branches were created
-- named after their cost centre. The applicant now names the branch and gives
-- its CRC; Head Office still confirms or corrects the name at approval.
--
-- Additive only. Nullable with no default: a request submitted before this
-- reads null, and Head Office names that branch at review as before. Only a
-- row for a branch still to be created (a CRC) may carry a name; an existing
-- branch's name is read from the branches table. The table is small, so the
-- check is added and validated at once.
--
-- Apply before deploying: the join reads select the column.
--
-- Rollback (after reverting the code that reads it):
--   ALTER TABLE "organization_join_request_branches" DROP COLUMN IF EXISTS "requested_branch_name";

ALTER TABLE "organization_join_request_branches" ADD COLUMN IF NOT EXISTS "requested_branch_name" varchar(100);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_join_request_branches" ADD CONSTRAINT "organization_join_request_branches_name_ck"
    CHECK ("requested_branch_name" IS NULL
      OR ("cost_center_id" IS NOT NULL AND length(btrim("requested_branch_name")) > 0));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
