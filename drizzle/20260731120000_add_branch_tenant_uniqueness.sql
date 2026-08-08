-- Branch names and generated codes are tenant-owned identifiers. Enforce the
-- same normalized uniqueness at the database boundary that the API applies.
--
-- The preflight is intentionally non-destructive. If legacy duplicates exist,
-- deployment stops with examples so they can be reviewed instead of silently
-- renaming or deleting multi-tenant business data.
DO $$
DECLARE
  duplicate_name_groups bigint;
  duplicate_code_groups bigint;
  duplicate_name_examples text;
  duplicate_code_examples text;
BEGIN
  SELECT count(*)
  INTO duplicate_name_groups
  FROM (
    SELECT "organization_id", lower(btrim("name")) AS normalized_name
    FROM "branches"
    GROUP BY "organization_id", lower(btrim("name"))
    HAVING count(*) > 1
  ) AS duplicate_names;

  IF duplicate_name_groups > 0 THEN
    SELECT string_agg(
      format('organization %s / %s (ids: %s)', organization_id, normalized_name, branch_ids),
      '; ' ORDER BY organization_id, normalized_name
    )
    INTO duplicate_name_examples
    FROM (
      SELECT
        "organization_id" AS organization_id,
        lower(btrim("name")) AS normalized_name,
        array_agg("id" ORDER BY "id")::text AS branch_ids
      FROM "branches"
      GROUP BY "organization_id", lower(btrim("name"))
      HAVING count(*) > 1
      ORDER BY "organization_id", normalized_name
      LIMIT 10
    ) AS examples;

    RAISE EXCEPTION
      USING ERRCODE = '23505',
      MESSAGE = format(
        'Cannot enforce tenant branch-name uniqueness: %s duplicate group(s) exist.',
        duplicate_name_groups
      ),
      DETAIL = format('Examples: %s', coalesce(duplicate_name_examples, '(unavailable)')),
      HINT = 'Resolve duplicate branch names within each organization, then retry the migration.';
  END IF;

  SELECT count(*)
  INTO duplicate_code_groups
  FROM (
    SELECT "organization_id", lower(btrim("code")) AS normalized_code
    FROM "branches"
    WHERE "code" IS NOT NULL AND btrim("code") <> ''
    GROUP BY "organization_id", lower(btrim("code"))
    HAVING count(*) > 1
  ) AS duplicate_codes;

  IF duplicate_code_groups > 0 THEN
    SELECT string_agg(
      format('organization %s / %s (ids: %s)', organization_id, normalized_code, branch_ids),
      '; ' ORDER BY organization_id, normalized_code
    )
    INTO duplicate_code_examples
    FROM (
      SELECT
        "organization_id" AS organization_id,
        lower(btrim("code")) AS normalized_code,
        array_agg("id" ORDER BY "id")::text AS branch_ids
      FROM "branches"
      WHERE "code" IS NOT NULL AND btrim("code") <> ''
      GROUP BY "organization_id", lower(btrim("code"))
      HAVING count(*) > 1
      ORDER BY "organization_id", normalized_code
      LIMIT 10
    ) AS examples;

    RAISE EXCEPTION
      USING ERRCODE = '23505',
      MESSAGE = format(
        'Cannot enforce tenant branch-code uniqueness: %s duplicate group(s) exist.',
        duplicate_code_groups
      ),
      DETAIL = format('Examples: %s', coalesce(duplicate_code_examples, '(unavailable)')),
      HINT = 'Resolve duplicate non-empty branch codes within each organization, then retry the migration.';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branches_org_name_normalized_uq"
  ON "branches" USING btree ("organization_id", lower(btrim("name")));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branches_org_code_normalized_uq"
  ON "branches" USING btree ("organization_id", lower(btrim("code")))
  WHERE "code" IS NOT NULL AND btrim("code") <> '';

-- Rollback (if intentionally required):
-- DROP INDEX IF EXISTS "branches_org_code_normalized_uq";
-- DROP INDEX IF EXISTS "branches_org_name_normalized_uq";
