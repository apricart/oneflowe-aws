-- Per-tenant private-network login restriction.
--
-- The flag defaults to false and the allowlist starts empty, so every existing
-- organization keeps exactly its current login behaviour until a Super Admin
-- explicitly opts in. Idempotent: safe to re-run.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS private_network_login_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- Addresses are stored already masked to their network address with an explicit
-- prefix length (a single host is /32 or /128), so login matching is a pure
-- prefix comparison and one network cannot be stored under two spellings.
CREATE TABLE IF NOT EXISTS organization_allowed_ips (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ip_address varchar(45) NOT NULL,
  prefix_length integer NOT NULL,
  label varchar(120),
  created_by uuid,
  created_at timestamptz DEFAULT NOW(),
  CONSTRAINT organization_allowed_ips_prefix_length_ck
    CHECK (prefix_length >= 0 AND prefix_length <= 128),
  CONSTRAINT organization_allowed_ips_address_nonempty_ck
    CHECK (length(trim(ip_address)) > 0)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS organization_allowed_ips_org_idx
  ON organization_allowed_ips(organization_id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS organization_allowed_ips_org_network_uq
  ON organization_allowed_ips(organization_id, ip_address, prefix_length);
--> statement-breakpoint

ALTER TABLE organization_allowed_ips ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneflowe_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE organization_allowed_ips TO oneflowe_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE organization_allowed_ips_id_seq TO oneflowe_runtime';

    -- The staged NOBYPASSRLS runtime-role design supplies these helpers. Keep
    -- the migration compatible with deployments that have not enabled it yet.
    IF to_regprocedure('oneflowe_rls.is_privileged_context()') IS NOT NULL
       AND to_regprocedure('oneflowe_rls.auth_bootstrap()') IS NOT NULL
       AND to_regprocedure('oneflowe_rls.current_organization_id()') IS NOT NULL THEN
      EXECUTE 'DROP POLICY IF EXISTS oneflowe_allowed_ip_select ON organization_allowed_ips';
      EXECUTE 'DROP POLICY IF EXISTS oneflowe_allowed_ip_write ON organization_allowed_ips';

      -- Login evaluates the allowlist before any tenant context exists, so the
      -- pre-authentication bootstrap context must be able to read it.
      EXECUTE $policy$
        CREATE POLICY oneflowe_allowed_ip_select ON organization_allowed_ips
          FOR SELECT TO oneflowe_runtime
          USING (
            oneflowe_rls.is_privileged_context()
            OR oneflowe_rls.auth_bootstrap()
            OR organization_id = oneflowe_rls.current_organization_id()
          )
      $policy$;

      -- Only a platform-privileged context may change who can reach a tenant.
      EXECUTE $policy$
        CREATE POLICY oneflowe_allowed_ip_write ON organization_allowed_ips
          FOR ALL TO oneflowe_runtime
          USING (oneflowe_rls.is_privileged_context())
          WITH CHECK (oneflowe_rls.is_privileged_context())
      $policy$;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE organization_allowed_ips FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE organization_allowed_ips FROM authenticated;
  END IF;
END $$;
