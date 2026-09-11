-- Mirrors the external identity pair already carried by `branches` onto
-- `users`, so an account sourced from another platform keeps a stable identity
-- there. Accounts created through the portal leave both columns null; only
-- those accounts may sign in with an email address, because a mirrored person
-- holds one account per role behind a single shared email.
-- This is structural only; no existing user row is modified here.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "external_source" varchar(64),
  ADD COLUMN IF NOT EXISTS "external_id" varchar(128);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_external_identity_pair_ck'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_external_identity_pair_ck"
      CHECK (
        ("external_source" IS NULL) = ("external_id" IS NULL)
        AND (
          "external_source" IS NULL
          OR (btrim("external_source") <> '' AND btrim("external_id") <> '')
        )
      );
  END IF;
END $$;

-- One account per source person *per role* — a mirrored person is two rows
-- (one to place orders, one to approve them) sharing an external identity.
CREATE UNIQUE INDEX IF NOT EXISTS "users_org_external_identity_role_uq"
  ON "users" USING btree ("organization_id", "external_source", "external_id", "role_id")
  WHERE "external_source" IS NOT NULL AND "external_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "users_external_identity_idx"
  ON "users" USING btree ("external_source", "external_id");

-- Rollback:
-- DROP INDEX IF EXISTS "users_external_identity_idx";
-- DROP INDEX IF EXISTS "users_org_external_identity_role_uq";
-- ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_external_identity_pair_ck";
-- ALTER TABLE "users" DROP COLUMN IF EXISTS "external_id";
-- ALTER TABLE "users" DROP COLUMN IF EXISTS "external_source";
