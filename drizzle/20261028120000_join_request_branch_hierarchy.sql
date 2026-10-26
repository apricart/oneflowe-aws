-- Department sign-up: the type the applicant proposes for a branch to be
-- created — Standalone, Parent, or Child of a parent branch. See
-- plans/OF-JOIN-new-branch-parent-child.md.
--
-- A child's parent is either an existing branch of the request's organization
-- (requested_parent_branch_id, held to that organization by a composite key) or
-- another branch to be created on the same request (requested_parent_crc, its
-- CRC; whether that branch is proposed as Parent is checked in code, on the
-- whole list). Head Office confirms or changes the type at review; the branch
-- itself is typed only when the approval creates it.
--
-- Additive only. Nullable with no default: a request submitted before this
-- reads null, and Head Office's review starts that branch as Standalone. Only a
-- row for a branch still to be created (a CRC) may carry a type; a child names
-- exactly one parent and nothing else names one. The table is small, so the
-- check and the key are added and validated at once.
--
-- Apply before deploying: the join reads select the columns.
--
-- Rollback (after reverting the code that reads them):
--   ALTER TABLE "organization_join_request_branches" DROP CONSTRAINT IF EXISTS "organization_join_request_branches_parent_org_fk";
--   ALTER TABLE "organization_join_request_branches" DROP CONSTRAINT IF EXISTS "organization_join_request_branches_hierarchy_ck";
--   ALTER TABLE "organization_join_request_branches" DROP COLUMN IF EXISTS "requested_parent_crc";
--   ALTER TABLE "organization_join_request_branches" DROP COLUMN IF EXISTS "requested_parent_branch_id";
--   ALTER TABLE "organization_join_request_branches" DROP COLUMN IF EXISTS "requested_hierarchy_role";

ALTER TABLE "organization_join_request_branches" ADD COLUMN IF NOT EXISTS "requested_hierarchy_role" varchar(16);--> statement-breakpoint
ALTER TABLE "organization_join_request_branches" ADD COLUMN IF NOT EXISTS "requested_parent_branch_id" integer;--> statement-breakpoint
ALTER TABLE "organization_join_request_branches" ADD COLUMN IF NOT EXISTS "requested_parent_crc" varchar(64);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_join_request_branches" ADD CONSTRAINT "organization_join_request_branches_hierarchy_ck"
    CHECK (("requested_hierarchy_role" IS NULL
        AND "requested_parent_branch_id" IS NULL
        AND "requested_parent_crc" IS NULL)
      OR ("cost_center_id" IS NOT NULL
        AND "requested_hierarchy_role" IN ('STANDALONE', 'PARENT', 'CHILD')
        AND ("requested_hierarchy_role" = 'CHILD')
          = (("requested_parent_branch_id" IS NOT NULL) <> ("requested_parent_crc" IS NOT NULL))
        AND ("requested_hierarchy_role" = 'CHILD'
          OR ("requested_parent_branch_id" IS NULL AND "requested_parent_crc" IS NULL))
        AND ("requested_parent_crc" IS NULL OR "requested_parent_crc" <> "cost_center_id")));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_join_request_branches" ADD CONSTRAINT "organization_join_request_branches_parent_org_fk"
    FOREIGN KEY ("requested_parent_branch_id", "organization_id")
    REFERENCES "public"."branches"("id", "organization_id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
