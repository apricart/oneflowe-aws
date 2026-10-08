# OF-DB — Tenant composite foreign keys

## Problem

Every table that carries both `organization_id` and `branch_id` (or `group_id`)
checked the two columns independently: "does organization 10 exist?" and "does
branch 200 exist?". Nothing in the database said branch 200 had to belong to
organization 10, so a row could name one tenant and another tenant's branch.
The application prevents this today; the database did not, so a script, an
import, manual SQL, or a future endpoint that forgot the check could write it.

Two relationships had no foreign key at all: `users.branch_id` and
`branches.group_id` — a dangling id was possible too.

## Change

Migration `20261012120000_add_tenant_composite_foreign_keys`, additive only:

- `UNIQUE (id, organization_id)` on `branches`, `groups`, `group_orders` —
  the target the composite keys need. `id` is already the primary key, so it
  can never fail.
- `(branch_id, organization_id) -> branches (id, organization_id)` on orders,
  budgets, branch_inventory, branch_products, branch_delivery_addresses,
  inventory, suppliers, restock_requests, employee_credentials,
  payment_control_exceptions, product_quantity_budgets,
  product_quantity_budget_allocations, legacy_user_mappings, support_threads,
  user_branch_assignments, order_desk_assignments, order_correction_requests,
  order_delivery_challans, users.
- `(group_id, organization_id) -> groups (id, organization_id)` on branches,
  group_orders, group_order_drafts, group_inventory_prices,
  user_group_assignments.
- `orders (group_order_id, organization_id) -> group_orders (id, organization_id)`.

Declared in `db/schema.ts` as `foreignKey()` / `unique()`. The extras callbacks
of `branches`, `users` and `groups` carry an explicit
`PgTableExtraConfigValue[]` return type: the keys make those three reference
each other in a cycle TypeScript inference cannot close.

### Decisions

- **Existing single-column keys stay**, with their ON DELETE actions. The
  composite keys are NO ACTION, checked at the end of the statement — after
  the existing CASCADE / SET NULL actions have run — so no delete that works
  today is refused. Verified directly on Postgres before writing the migration.
- **`users.branch_id` and `branches.group_id` use `ON DELETE SET NULL
  (column)`** (PG 15+; production is 17, the test DB 16). They had no key, and
  deleting a branch or group under them succeeded; a NO ACTION key would turn
  those deletes into errors (several integration fixtures do exactly that).
  The column list clears only the branch/group, never `organization_id`.
  Drizzle cannot express the column list, so `schema.ts` says `set null` with
  a comment; nothing in this repo runs `drizzle-kit push`.
- **MATCH SIMPLE** (the default): a row with the organization or the branch
  NULL is not checked. On production only `system_logs` has such rows (70),
  and it is out of scope.
- **Logs are out of scope**: audit_logs, system_logs, group_audit_logs,
  notifications, email_outbox, product_price_history. They are append-only
  and written from many places; a refusal there would roll back the action
  being recorded, for little integrity gain.
- `order_items` and `refunds` carry no tenant columns — their tenancy is the
  order's — so they need nothing.
- **No branch or group ever changes organization** through the application
  (`branchUpdateSchema` has no `organizationId`; scripts filter by it), and the
  user access route already checks the branch against the target organization.
  The keys now refuse such a move outright.

### Idempotent, so it can be applied ahead of the journal

Each constraint is added only when absent and only when its table exists.
Production sat at journal 80 of 88 when this was written; the seven migrations
in between belong to features not yet deployed and are the operator's to
apply. The file was therefore applied to production directly, and the migrator
runs it again later as part of the pending batch: a no-op for everything
already present, and it adds the keys of `order_correction_requests` and
`order_delivery_challans`, which are created by those pending migrations.

## Verification

- Read-only audit of production, 2026-10-08, before applying: zero rows
  violating any of the keys (1,257 orders, 18,155 branch_inventory rows, 1,457
  budgets, 738 users, 338 branches, …).
- `tests/integration/tenant-composite-foreign-keys.test.ts`: database and
  `schema.ts` declare the same 28 constraints; cross-tenant branch and group
  refused on several tables and on a cross-organization branch move; same-tenant
  rows accepted; deleting a branch or group clears the reference and keeps the
  organization.
- Full integration and unit suites against the migrated test database.

## Rollback

`ALTER TABLE … DROP CONSTRAINT IF EXISTS …` for each name, listed at the head
of the migration. Data is never touched, so rollback loses nothing.
