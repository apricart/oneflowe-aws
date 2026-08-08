-- Preserve ordinary case-insensitive tenant branch-name uniqueness while
-- allowing explicitly mapped external locations to use their source identity.
-- This is structural only; no existing branch row is modified here.

ALTER TABLE "branches"
  ADD COLUMN IF NOT EXISTS "external_source" varchar(64),
  ADD COLUMN IF NOT EXISTS "external_id" varchar(128);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'branches_external_identity_pair_ck'
      AND conrelid = 'public.branches'::regclass
  ) THEN
    ALTER TABLE "branches"
      ADD CONSTRAINT "branches_external_identity_pair_ck"
      CHECK (
        ("external_source" IS NULL) = ("external_id" IS NULL)
        AND (
          "external_source" IS NULL
          OR (btrim("external_source") <> '' AND btrim("external_id") <> '')
        )
      );
  END IF;
END $$;

DO $$
DECLARE
  duplicate_summary text;
BEGIN
  SELECT string_agg(
    format('organization %s / exact name %s (ids: %s)', organization_id, exact_name, branch_ids),
    '; '
  )
  INTO duplicate_summary
  FROM (
    SELECT
      organization_id,
      btrim(name) AS exact_name,
      array_agg(id ORDER BY id)::text AS branch_ids
    FROM "branches"
    GROUP BY organization_id, btrim(name)
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_summary IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot enforce exact tenant branch-name uniqueness: %', duplicate_summary;
  END IF;
END $$;

DROP INDEX IF EXISTS "branches_org_name_normalized_uq";

-- Exact duplicate names remain impossible for every tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "branches_org_name_exact_uq"
  ON "branches" USING btree ("organization_id", btrim("name"));

-- UI-created/unmapped branches keep the platform's existing case-insensitive
-- uniqueness contract. External branches are distinguished by their stable IDs.
CREATE UNIQUE INDEX IF NOT EXISTS "branches_org_name_normalized_unmapped_uq"
  ON "branches" USING btree ("organization_id", lower(btrim("name")))
  WHERE "external_source" IS NULL AND "external_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "branches_org_external_identity_uq"
  ON "branches" USING btree ("organization_id", "external_source", "external_id")
  WHERE "external_source" IS NOT NULL AND "external_id" IS NOT NULL;

-- Rollback (only after resolving any external case-only pairs):
-- DROP INDEX IF EXISTS "branches_org_external_identity_uq";
-- DROP INDEX IF EXISTS "branches_org_name_normalized_unmapped_uq";
-- DROP INDEX IF EXISTS "branches_org_name_exact_uq";
-- CREATE UNIQUE INDEX "branches_org_name_normalized_uq"
--   ON "branches" ("organization_id", lower(btrim("name")));
-- ALTER TABLE "branches" DROP CONSTRAINT IF EXISTS "branches_external_identity_pair_ck";
-- ALTER TABLE "branches" DROP COLUMN IF EXISTS "external_id";
-- ALTER TABLE "branches" DROP COLUMN IF EXISTS "external_source";
