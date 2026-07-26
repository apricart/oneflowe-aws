-- ROLLBACK FOR docs/security/supabase-runtime-role-staging.sql
-- Run only in the staging database where that script was tested.
-- This rollback removes only policies prefixed oneflowe_ and runtime grants.
-- It intentionally leaves the pre-existing deny-by-default RLS state enabled.

BEGIN;

DO $drop_policies$
DECLARE
  policy_record record;
BEGIN
  FOR policy_record IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname LIKE 'oneflowe\_%' ESCAPE '\'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      policy_record.policyname,
      policy_record.schemaname,
      policy_record.tablename
    );
  END LOOP;
END
$drop_policies$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM oneflowe_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM oneflowe_runtime;
REVOKE USAGE ON SCHEMA public FROM oneflowe_runtime;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM oneflowe_migrator;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM oneflowe_migrator;
REVOKE USAGE, CREATE ON SCHEMA public FROM oneflowe_migrator;

DROP SCHEMA IF EXISTS oneflowe_rls CASCADE;

-- Keep the bundle roles present but inert so rollback does not fail if a DBA
-- has already created login-role memberships. Remove memberships/login roles
-- manually before dropping these bundle roles.
ALTER ROLE oneflowe_runtime
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE oneflowe_migrator
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

COMMIT;

-- Optional after confirming no members/dependencies remain:
-- DROP ROLE oneflowe_runtime;
-- DROP ROLE oneflowe_migrator;
