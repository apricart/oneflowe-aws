ALTER TABLE "organizations"
ADD COLUMN IF NOT EXISTS "order_approver_role" varchar(32);

UPDATE "organizations"
SET "order_approver_role" = 'BRANCH_ADMIN'
WHERE "order_approver_role" IS NULL
   OR "order_approver_role" NOT IN ('BRANCH_ADMIN', 'HEAD_OFFICE');

ALTER TABLE "organizations"
ALTER COLUMN "order_approver_role" SET DEFAULT 'BRANCH_ADMIN';

ALTER TABLE "organizations"
ALTER COLUMN "order_approver_role" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organizations_order_approver_role_ck'
  ) THEN
    ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_order_approver_role_ck"
    CHECK ("order_approver_role" IN ('BRANCH_ADMIN', 'HEAD_OFFICE'));
  END IF;
END $$;

