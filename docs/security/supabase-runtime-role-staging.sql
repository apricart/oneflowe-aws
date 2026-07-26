-- STAGING-ONLY TEMPLATE. Do not run against production without the approvals
-- and application changes described in the accompanying security audit.
--
-- This script deliberately creates NOLOGIN privilege-bundle roles. Create
-- separate LOGIN roles and passwords through the approved secret manager, then
-- grant those login roles membership in oneflowe_runtime/oneflowe_migrator.
--
-- The application MUST set transaction-local oneflowe.* context before its
-- DATABASE_URL is switched to a member of oneflowe_runtime:
--   select set_config('oneflowe.role', 'HEAD_OFFICE', true);
--   select set_config('oneflowe.user_id', '<uuid>', true);
--   select set_config('oneflowe.organization_id', '<integer>', true);
--   select set_config('oneflowe.branch_id', '<integer-or-empty>', true);
--
-- Authentication lookups must run in a short transaction with:
--   select set_config('oneflowe.auth_bootstrap', 'on', true);
-- Do not use session-level SET because pooled connections are reused.

BEGIN;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneflowe_runtime') THEN
    CREATE ROLE oneflowe_runtime
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneflowe_migrator') THEN
    CREATE ROLE oneflowe_migrator
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$roles$;

ALTER ROLE oneflowe_runtime
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE oneflowe_migrator
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

DO $database_grants$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO oneflowe_runtime, oneflowe_migrator',
    current_database()
  );
END
$database_grants$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO oneflowe_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO oneflowe_migrator;

-- Compatibility-first runtime grants. RLS provides row isolation. After staging
-- query telemetry identifies the exact write set, replace this blanket DML grant
-- with per-table grants before production cutover.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO oneflowe_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO oneflowe_runtime;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO oneflowe_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO oneflowe_migrator;

CREATE SCHEMA IF NOT EXISTS oneflowe_rls;
REVOKE ALL ON SCHEMA oneflowe_rls FROM PUBLIC;
GRANT USAGE ON SCHEMA oneflowe_rls TO oneflowe_runtime, oneflowe_migrator;

CREATE OR REPLACE FUNCTION oneflowe_rls.context_value(setting_name text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting(setting_name, true), '')
$$;

CREATE OR REPLACE FUNCTION oneflowe_rls.app_role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT oneflowe_rls.context_value('oneflowe.role')
$$;

CREATE OR REPLACE FUNCTION oneflowe_rls.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT oneflowe_rls.context_value('oneflowe.user_id')
$$;

CREATE OR REPLACE FUNCTION oneflowe_rls.current_organization_id()
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  value text := oneflowe_rls.context_value('oneflowe.organization_id');
BEGIN
  IF value IS NULL OR value !~ '^[0-9]+$' THEN
    RETURN NULL;
  END IF;
  RETURN value::integer;
END
$$;

CREATE OR REPLACE FUNCTION oneflowe_rls.current_branch_id()
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
  value text := oneflowe_rls.context_value('oneflowe.branch_id');
BEGIN
  IF value IS NULL OR value !~ '^[0-9]+$' THEN
    RETURN NULL;
  END IF;
  RETURN value::integer;
END
$$;

CREATE OR REPLACE FUNCTION oneflowe_rls.has_valid_context()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT oneflowe_rls.app_role() IN (
    'SUPER_ADMIN',
    'HEAD_OFFICE',
    'BRANCH_ADMIN',
    'ORDER_PORTAL',
    'SYSTEM'
  )
$$;

CREATE OR REPLACE FUNCTION oneflowe_rls.is_privileged_context()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT oneflowe_rls.app_role() IN ('SUPER_ADMIN', 'SYSTEM')
$$;

CREATE OR REPLACE FUNCTION oneflowe_rls.auth_bootstrap()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT oneflowe_rls.context_value('oneflowe.auth_bootstrap') = 'on'
$$;

CREATE OR REPLACE FUNCTION oneflowe_rls.tenant_allowed(
  row_organization_id integer,
  row_branch_id integer DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN oneflowe_rls.is_privileged_context() THEN true
    WHEN oneflowe_rls.app_role() = 'HEAD_OFFICE' THEN
      row_organization_id = oneflowe_rls.current_organization_id()
    WHEN oneflowe_rls.app_role() IN ('BRANCH_ADMIN', 'ORDER_PORTAL') THEN
      row_organization_id = oneflowe_rls.current_organization_id()
      AND (
        row_branch_id IS NULL
        OR row_branch_id = oneflowe_rls.current_branch_id()
      )
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION oneflowe_rls.owner_allowed(row_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT oneflowe_rls.is_privileged_context()
    OR (
      oneflowe_rls.has_valid_context()
      AND row_user_id IS NOT NULL
      AND row_user_id = oneflowe_rls.current_user_id()
    )
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA oneflowe_rls FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA oneflowe_rls
  TO oneflowe_runtime, oneflowe_migrator;

-- Tables carrying both organization_id and branch_id.
DO $tenant_branch_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'audit_logs',
    'branch_inventory',
    'branch_products',
    'budgets',
    'employee_credentials',
    'inventory',
    'legacy_user_mappings',
    'notifications',
    'orders',
    'product_quantity_budget_allocations',
    'product_quantity_budgets',
    'restock_requests',
    'suppliers',
    'system_logs',
    'users'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS oneflowe_tenant_isolation ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY oneflowe_tenant_isolation ON public.%I FOR ALL TO oneflowe_runtime
       USING (oneflowe_rls.tenant_allowed(organization_id, branch_id))
       WITH CHECK (oneflowe_rls.tenant_allowed(organization_id, branch_id))',
      table_name
    );
  END LOOP;
END
$tenant_branch_policies$;

-- Tables carrying organization_id only.
DO $tenant_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'branches',
    'group_audit_logs',
    'groups',
    'head_offices',
    'invoice_sequences',
    'legacy_import_batches',
    'legacy_order_imports',
    'legacy_product_mappings',
    'order_items',
    'org_metrics',
    'organization_inventory',
    'organization_products',
    'organization_settings',
    'refunds'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS oneflowe_tenant_isolation ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY oneflowe_tenant_isolation ON public.%I FOR ALL TO oneflowe_runtime
       USING (oneflowe_rls.tenant_allowed(organization_id))
       WITH CHECK (oneflowe_rls.tenant_allowed(organization_id))',
      table_name
    );
  END LOOP;
END
$tenant_policies$;

-- Nullable organization-scoped catalogue rows may be globally readable, but
-- tenant users may only write rows belonging to their own organization.
DO $tenant_or_global_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['categories', 'products', 'skus']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS oneflowe_tenant_or_global_select ON public.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS oneflowe_tenant_write ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY oneflowe_tenant_or_global_select ON public.%I FOR SELECT TO oneflowe_runtime
       USING (
         oneflowe_rls.has_valid_context()
         AND (organization_id IS NULL OR oneflowe_rls.tenant_allowed(organization_id))
       )',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY oneflowe_tenant_write ON public.%I FOR ALL TO oneflowe_runtime
       USING (oneflowe_rls.tenant_allowed(organization_id))
       WITH CHECK (oneflowe_rls.tenant_allowed(organization_id))',
      table_name
    );
  END LOOP;
END
$tenant_or_global_policies$;

-- User-owned operational tables.
DROP POLICY IF EXISTS oneflowe_owner_isolation ON public.mfa_codes;
CREATE POLICY oneflowe_owner_isolation ON public.mfa_codes
  FOR ALL TO oneflowe_runtime
  USING (
    oneflowe_rls.owner_allowed(user_id::text)
    OR oneflowe_rls.auth_bootstrap()
  )
  WITH CHECK (
    oneflowe_rls.owner_allowed(user_id::text)
    OR oneflowe_rls.auth_bootstrap()
  );

DROP POLICY IF EXISTS oneflowe_owner_isolation ON public.product_import_batches;
CREATE POLICY oneflowe_owner_isolation ON public.product_import_batches
  FOR ALL TO oneflowe_runtime
  USING (oneflowe_rls.owner_allowed(uploaded_by_user_id::text))
  WITH CHECK (oneflowe_rls.owner_allowed(uploaded_by_user_id::text));

DROP POLICY IF EXISTS oneflowe_owner_isolation ON public.scheduled_reports;
CREATE POLICY oneflowe_owner_isolation ON public.scheduled_reports
  FOR ALL TO oneflowe_runtime
  USING (
    oneflowe_rls.owner_allowed(user_id::text)
    AND (
      organization_id IS NULL
      OR oneflowe_rls.tenant_allowed(organization_id)
      OR oneflowe_rls.is_privileged_context()
    )
  )
  WITH CHECK (
    oneflowe_rls.owner_allowed(user_id::text)
    AND (
      organization_id IS NULL
      OR oneflowe_rls.tenant_allowed(organization_id)
      OR oneflowe_rls.is_privileged_context()
    )
  );

DROP POLICY IF EXISTS oneflowe_owner_isolation ON public.sessions;
CREATE POLICY oneflowe_owner_isolation ON public.sessions
  FOR ALL TO oneflowe_runtime
  USING (
    oneflowe_rls.owner_allowed(user_id::text)
    OR oneflowe_rls.auth_bootstrap()
  )
  WITH CHECK (
    oneflowe_rls.owner_allowed(user_id::text)
    OR oneflowe_rls.auth_bootstrap()
  );

-- Authentication bootstrap permits only reads of credential/role records.
DROP POLICY IF EXISTS oneflowe_auth_bootstrap_select ON public.users;
CREATE POLICY oneflowe_auth_bootstrap_select ON public.users
  FOR SELECT TO oneflowe_runtime
  USING (oneflowe_rls.auth_bootstrap());

DROP POLICY IF EXISTS oneflowe_auth_bootstrap_select ON public.employee_credentials;
CREATE POLICY oneflowe_auth_bootstrap_select ON public.employee_credentials
  FOR SELECT TO oneflowe_runtime
  USING (oneflowe_rls.auth_bootstrap());

-- Global reference/configuration tables: all valid contexts can read; only
-- SUPER_ADMIN or SYSTEM contexts can mutate.
DO $global_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'global_products',
    'modifiers',
    'product_modifiers',
    'roles',
    'role_permissions'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS oneflowe_global_select ON public.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS oneflowe_global_write ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY oneflowe_global_select ON public.%I FOR SELECT TO oneflowe_runtime
       USING (oneflowe_rls.has_valid_context() OR oneflowe_rls.auth_bootstrap())',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY oneflowe_global_write ON public.%I FOR ALL TO oneflowe_runtime
       USING (oneflowe_rls.is_privileged_context())
       WITH CHECK (oneflowe_rls.is_privileged_context())',
      table_name
    );
  END LOOP;
END
$global_policies$;

DROP POLICY IF EXISTS oneflowe_organization_select ON public.organizations;
CREATE POLICY oneflowe_organization_select ON public.organizations
  FOR SELECT TO oneflowe_runtime
  USING (
    oneflowe_rls.is_privileged_context()
    OR id = oneflowe_rls.current_organization_id()
  );

DROP POLICY IF EXISTS oneflowe_organization_write ON public.organizations;
CREATE POLICY oneflowe_organization_write ON public.organizations
  FOR ALL TO oneflowe_runtime
  USING (oneflowe_rls.is_privileged_context())
  WITH CHECK (oneflowe_rls.is_privileged_context());

-- Child tables without direct tenant columns.
DROP POLICY IF EXISTS oneflowe_budget_addon_isolation ON public.budget_addons;
CREATE POLICY oneflowe_budget_addon_isolation ON public.budget_addons
  FOR ALL TO oneflowe_runtime
  USING (
    EXISTS (
      SELECT 1 FROM public.budgets parent
      WHERE parent.id = budget_addons.budget_id
        AND oneflowe_rls.tenant_allowed(parent.organization_id, parent.branch_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.budgets parent
      WHERE parent.id = budget_addons.budget_id
        AND oneflowe_rls.tenant_allowed(parent.organization_id, parent.branch_id)
    )
  );

DROP POLICY IF EXISTS oneflowe_refund_item_isolation ON public.refund_items;
CREATE POLICY oneflowe_refund_item_isolation ON public.refund_items
  FOR ALL TO oneflowe_runtime
  USING (
    EXISTS (
      SELECT 1 FROM public.refunds parent
      WHERE parent.id = refund_items.refund_id
        AND oneflowe_rls.tenant_allowed(parent.organization_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.refunds parent
      WHERE parent.id = refund_items.refund_id
        AND oneflowe_rls.tenant_allowed(parent.organization_id)
    )
  );

-- Administrative history tables without a reliable tenant foreign key remain
-- privileged-only until their schema gains organization_id.
DO $privileged_only_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'inventory_sync_logs',
    'product_assignments'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS oneflowe_privileged_only ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY oneflowe_privileged_only ON public.%I FOR ALL TO oneflowe_runtime
       USING (oneflowe_rls.is_privileged_context())
       WITH CHECK (oneflowe_rls.is_privileged_context())',
      table_name
    );
  END LOOP;
END
$privileged_only_policies$;

-- Keep FORCE ROW LEVEL SECURITY off during staging. The runtime role will not
-- own tables and therefore cannot use the owner bypass. FORCE RLS would mainly
-- affect the object owner/migration path and can break DDL/data migrations.

COMMIT;

-- MANUAL FOLLOW-UP (not transactional and intentionally not automated):
-- 1. Create secret-managed LOGIN roles and grant membership:
--      GRANT oneflowe_runtime TO oneflowe_app_login;
--      GRANT oneflowe_migrator TO oneflowe_migration_login;
-- 2. Transfer existing object ownership only after migration tooling has been
--    tested with oneflowe_migration_login.
-- 3. As the final object owner, configure ALTER DEFAULT PRIVILEGES so future
--    tables/sequences grant runtime DML/sequence usage.
-- 4. Run the cross-tenant tests in the audit before changing DATABASE_URL.
