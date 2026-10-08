-- Make the database itself refuse a row whose branch (or group) belongs to a
-- different organization than the row says it does.
-- See plans/OF-DB-tenant-composite-foreign-keys.md.
--
-- Until now every one of these tables checked organization_id and branch_id
-- (or group_id) independently: organization 10 with organization 20's branch
-- was accepted. Each table gains a composite foreign key
--   (branch_id, organization_id) -> branches (id, organization_id)
--   (group_id,  organization_id) -> groups   (id, organization_id)
-- plus orders (group_order_id, organization_id) -> group_orders.
--
-- Additive only. No column, row or existing constraint changes:
--
--   * branches, groups and group_orders gain UNIQUE (id, organization_id),
--     which the composite keys need as a target. id is already the primary
--     key, so this can never fail.
--   * Existing single-column foreign keys stay, with their ON DELETE actions.
--     The composite keys are NO ACTION, which is checked at the end of the
--     statement, after those cascades and SET NULLs have run.
--   * users.branch_id and branches.group_id had no foreign key at all; a
--     delete of the parent left the id dangling. Their composite keys are
--     ON DELETE SET NULL (branch_id) / (group_id) — the column list (PG 15+)
--     leaves organization_id alone — so no delete that succeeds today starts
--     failing, and the id is cleared instead of left dangling.
--   * MATCH SIMPLE (the default): a row with organization_id or the branch /
--     group NULL is not checked, as before.
--
-- Not covered, deliberately: the append-only logs (audit_logs, system_logs,
-- group_audit_logs, notifications, email_outbox, product_price_history). A
-- refusal there would roll back the action being recorded.
--
-- Idempotent: each constraint is added only if absent, and only if its table
-- exists. That lets this file be applied to a database that has not yet run
-- every earlier migration, and then run again by the migrator as a no-op (or
-- to add the keys for tables created in between).
--
-- Every existing row must already satisfy the keys; a violation aborts the
-- whole migration and changes nothing. Production was audited on 2026-10-08:
-- zero violations.
--
-- Rollback (drops only what this file added):
--   ALTER TABLE <table> DROP CONSTRAINT IF EXISTS <table>_branch_org_fk;  -- each table below
--   ALTER TABLE <table> DROP CONSTRAINT IF EXISTS <table>_group_org_fk;
--   ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_group_order_org_fk;
--   ALTER TABLE group_orders DROP CONSTRAINT IF EXISTS group_orders_id_organization_uq;
--   ALTER TABLE groups DROP CONSTRAINT IF EXISTS groups_id_organization_uq;
--   ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_id_organization_uq;

DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('branches',     'branches_id_organization_uq'),
      ('groups',       'groups_id_organization_uq'),
      ('group_orders', 'group_orders_id_organization_uq')
    ) AS t(tbl, name)
  LOOP
    IF to_regclass(format('public.%I', target.tbl)) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = target.name) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (id, organization_id)', target.tbl, target.name);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      -- child table, child column, parent table, constraint name, ON DELETE clause
      ('orders',                              'branch_id',      'branches',     'orders_branch_org_fk',                              ''),
      ('orders',                              'group_order_id', 'group_orders', 'orders_group_order_org_fk',                         ''),
      ('budgets',                             'branch_id',      'branches',     'budgets_branch_org_fk',                             ''),
      ('branch_inventory',                    'branch_id',      'branches',     'branch_inventory_branch_org_fk',                    ''),
      ('branch_products',                     'branch_id',      'branches',     'branch_products_branch_org_fk',                     ''),
      ('branch_delivery_addresses',           'branch_id',      'branches',     'branch_delivery_addresses_branch_org_fk',           ''),
      ('inventory',                           'branch_id',      'branches',     'inventory_branch_org_fk',                           ''),
      ('suppliers',                           'branch_id',      'branches',     'suppliers_branch_org_fk',                           ''),
      ('restock_requests',                    'branch_id',      'branches',     'restock_requests_branch_org_fk',                    ''),
      ('employee_credentials',                'branch_id',      'branches',     'employee_credentials_branch_org_fk',                ''),
      ('payment_control_exceptions',          'branch_id',      'branches',     'payment_control_exceptions_branch_org_fk',          ''),
      ('product_quantity_budgets',            'branch_id',      'branches',     'product_quantity_budgets_branch_org_fk',            ''),
      ('product_quantity_budget_allocations', 'branch_id',      'branches',     'product_quantity_budget_allocations_branch_org_fk', ''),
      ('legacy_user_mappings',                'branch_id',      'branches',     'legacy_user_mappings_branch_org_fk',                ''),
      ('support_threads',                     'branch_id',      'branches',     'support_threads_branch_org_fk',                     ''),
      ('user_branch_assignments',             'branch_id',      'branches',     'user_branch_assignments_branch_org_fk',             ''),
      ('order_desk_assignments',              'branch_id',      'branches',     'order_desk_assignments_branch_org_fk',              ''),
      ('order_correction_requests',           'branch_id',      'branches',     'order_correction_requests_branch_org_fk',           ''),
      ('order_delivery_challans',             'branch_id',      'branches',     'order_delivery_challans_branch_org_fk',             ''),
      ('users',                               'branch_id',      'branches',     'users_branch_org_fk',                               'ON DELETE SET NULL (branch_id)'),
      ('branches',                            'group_id',       'groups',       'branches_group_org_fk',                             'ON DELETE SET NULL (group_id)'),
      ('group_orders',                        'group_id',       'groups',       'group_orders_group_org_fk',                         ''),
      ('group_order_drafts',                  'group_id',       'groups',       'group_order_drafts_group_org_fk',                   ''),
      ('group_inventory_prices',              'group_id',       'groups',       'group_inventory_prices_group_org_fk',               ''),
      ('user_group_assignments',              'group_id',       'groups',       'user_group_assignments_group_org_fk',               '')
    ) AS t(child, col, parent, name, on_delete)
  LOOP
    IF to_regclass(format('public.%I', fk.child)) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk.name) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I, organization_id) REFERENCES %I (id, organization_id) %s',
        fk.child, fk.name, fk.col, fk.parent, fk.on_delete
      );
    END IF;
  END LOOP;
END $$;
