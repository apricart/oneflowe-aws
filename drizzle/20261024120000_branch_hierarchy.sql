-- Parent / child / standalone branch label. See plans/OF-BRANCH-parent-child-label.md.
--
-- A label only: no access, budget, price or catalogue rule reads these columns.
--
-- Additive only. hierarchy_role is NOT NULL with a constant default, so adding
-- it does not rewrite the table and every existing branch reads STANDALONE.
-- parent_branch_id is nullable and empty, so its checks and key are valid
-- against every existing row.
--
-- Apply before deploying: the branch reads select both columns.
--
-- Rollback (after reverting the code that reads them):
--   DROP TRIGGER IF EXISTS branches_hierarchy_guard_trg ON public.branches;
--   DROP FUNCTION IF EXISTS public.branches_hierarchy_guard();
--   ALTER TABLE "branches" DROP CONSTRAINT IF EXISTS "branches_parent_org_fk";
--   ALTER TABLE "branches" DROP CONSTRAINT IF EXISTS "branches_hierarchy_parent_ck";
--   ALTER TABLE "branches" DROP CONSTRAINT IF EXISTS "branches_hierarchy_role_ck";
--   DROP INDEX IF EXISTS "branches_parent_idx";
--   ALTER TABLE "branches" DROP COLUMN IF EXISTS "parent_branch_id";
--   ALTER TABLE "branches" DROP COLUMN IF EXISTS "hierarchy_role";

ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "hierarchy_role" varchar(16) DEFAULT 'STANDALONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "parent_branch_id" integer;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "branches" ADD CONSTRAINT "branches_hierarchy_role_ck"
    CHECK ("hierarchy_role" IN ('STANDALONE', 'PARENT', 'CHILD'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "branches" ADD CONSTRAINT "branches_hierarchy_parent_ck"
    CHECK ((("hierarchy_role" = 'CHILD') = ("parent_branch_id" IS NOT NULL))
      AND ("parent_branch_id" IS NULL OR "parent_branch_id" <> "id"));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "branches" ADD CONSTRAINT "branches_parent_org_fk"
    FOREIGN KEY ("parent_branch_id", "organization_id")
    REFERENCES "public"."branches"("id", "organization_id")
    ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branches_parent_idx" ON "branches" USING btree ("parent_branch_id")
  WHERE "branches"."parent_branch_id" IS NOT NULL;--> statement-breakpoint

-- One level only, held by the database whatever writes the row:
--   * a child's parent must itself be a PARENT, read FOR SHARE so a concurrent
--     re-type of that parent waits for this row's transaction;
--   * a PARENT that still has children may not change role. The UPDATE holds
--     the parent's row lock, which conflicts with a child insert's FOR SHARE,
--     and the count below runs on a fresh snapshot after that lock is granted.
-- The application checks both first and answers with a specific message; this
-- is the backstop. 23514 with its own constraint name, mapped to 409.
CREATE OR REPLACE FUNCTION public.branches_hierarchy_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_role varchar(16);
BEGIN
  IF NEW.parent_branch_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW.parent_branch_id IS DISTINCT FROM OLD.parent_branch_id
      OR NEW.hierarchy_role IS DISTINCT FROM OLD.hierarchy_role) THEN
    SELECT branch.hierarchy_role INTO parent_role
    FROM public.branches AS branch
    WHERE branch.id = NEW.parent_branch_id
      AND branch.organization_id = NEW.organization_id
    FOR SHARE;

    IF parent_role IS DISTINCT FROM 'PARENT' THEN
      RAISE EXCEPTION 'Branch % is not a parent branch of organization %',
        NEW.parent_branch_id, NEW.organization_id
        USING ERRCODE = '23514', CONSTRAINT = 'branches_hierarchy_guard', TABLE = 'branches';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.hierarchy_role = 'PARENT' AND NEW.hierarchy_role <> 'PARENT'
    AND EXISTS (SELECT 1 FROM public.branches AS child WHERE child.parent_branch_id = OLD.id) THEN
    RAISE EXCEPTION 'Branch % still has child branches', OLD.id
      USING ERRCODE = '23514', CONSTRAINT = 'branches_hierarchy_guard', TABLE = 'branches';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS branches_hierarchy_guard_trg ON public.branches;--> statement-breakpoint
CREATE TRIGGER branches_hierarchy_guard_trg
  BEFORE INSERT OR UPDATE OF hierarchy_role, parent_branch_id ON public.branches
  FOR EACH ROW
  EXECUTE FUNCTION public.branches_hierarchy_guard();
