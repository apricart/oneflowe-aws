# OF-BUDGET — Organization-level "Budget allocation" switch

## Requirement

A Super Admin must be able to switch budget allocation on or off per
organization, from the Create Company and Edit Company dialogs. With it off,
ordering, order reporting and every other feature must work with no dependence
on a budget: no budget is needed to order, no order is refused for budget, no
hold is taken, and no screen shows a budget figure that is not real. New
organizations start with it **off**.

## Decisions

### Storage

- `organizations.budgets_enabled boolean NOT NULL DEFAULT true`.
  - The **database** default is `true` so every existing tenant, every test
    fixture and every script that inserts an organization directly
    (`sync:ke --create-organization`) keeps today's behaviour. Turning budgets
    off for K-Electric or UBL on deploy would silently remove a financial
    control from a live tenant.
  - The **product** default is `false`: `organizationCreateSchema` defaults the
    field to `false` and the Create Company form starts unticked, so every
    organization created through the application starts with budgets off.
- `orders.budget_tracked boolean NOT NULL DEFAULT true`. Every existing order
  took a hold, so every existing order is tracked. Both creation paths write it
  explicitly.
- Hand-written migration `drizzle/20261001120000_add_organization_budgets_enabled.sql`
  (journal `when` = previous + 3600000). Both columns are constant-default
  `ADD COLUMN`s — metadata-only in Postgres 11+, no table rewrite of `orders`.
  **The migration must be applied before the code is deployed**: the new code
  selects both columns.

### An order's budget treatment is fixed when it is created

This is the rule every edge case below reduces to.

- At creation, inside the creation transaction, the organization row is read
  `FOR SHARE` (`resolveOrderBudgetTracking`, `lib/server/organization-budget-policy.ts`).
  The organization PATCH holds `FOR UPDATE`, so an order commits wholly under
  the old or the new setting — never a hold under "off" or no hold under "on".
- The answer is stored on the order as `budget_tracked`.
- **Every later ledger move keys on `order.budget_tracked`, never on the
  organization's current setting**: edit, reject, fulfil (manual, token
  hand-off, 48-hour auto-fulfil), refund (branch request and Super Admin
  direct), admin delete, and the admin budget rebuild. An untracked order never
  touches `budgets` or `product_quantity_budgets`; a tracked order settles
  against the hold it took, exactly as today.
- `orderTakesBudget(order)` in `lib/organization-budget-policy.ts` is the one
  predicate. It **throws** when `budgetTracked` is not a boolean, so a path
  that forgot to select the column fails loudly in tests instead of guessing —
  guessing "tracked" would subtract an untracked order's total from another
  order's hold.

Why not follow the current setting: switching budgets on after an order was
placed without a hold would make rejecting that order release money it never
held (eating another order's hold), and fulfilling it would move held money
that is not there (`BUDGET_LEDGER_INVARIANT`, order stuck). Switching off must
not rewrite money already committed.

### Toggle transitions

| Transition | Effect |
|---|---|
| on → off | New orders untracked. Orders already pending/approved keep their hold and settle against it (reject releases, fulfil moves held→spent, refund credits). Budget rows are kept untouched, not deleted, and reappear if budgets are switched back on. Budget allocation writes are refused (409). |
| off → on | New orders tracked and budget-checked. Orders placed while off stay untracked for life. A branch with no allocation and no baseline cannot order until Head Office allocates — the same onboarding every budgeted tenant has today. The edit dialog warns of this. |
| toggled while an order is being placed | Serialized by the organization row lock. The pre-flight (outside the transaction) may disagree with the transaction; the transaction wins. If the transaction finds budgets on but the pre-flight did not open a budget row, it refuses with "Budget settings changed while this order was being placed. Please try again." rather than holding against nothing. |
| money ↔ quantity mode while off | Stored as today; has no effect until budgets are on. |

### What "off" does, surface by surface

**Ordering (server — the control)**
- `POST /api/v1/orders`: no budget row read or created, no money or quantity
  budget lock, no shortfall check, no hold. Stock, pricing, payment-control and
  delivery-acknowledgement gates unchanged.
- Group Order Portal submission (`lib/server/group-order-creation.ts`): per
  branch, the same.
- `PUT /api/v1/orders/[id]` (edit): an untracked order skips the money and
  quantity budget checks and writes; stock is still re-validated.
- Quantity mode never narrows the catalogue or refuses an unallocated product
  when budgets are off (`/api/v1/branch/inventory`, group catalogue).

**Budget administration (server)**
- `GET /api/v1/budgets` single branch: returns `{ branchId, budgetsEnabled: false }`
  and **writes nothing** (today this read opens a period row).
- `GET /api/v1/budgets?all=1`: for a disabled tenant returns
  `{ budgets: [], budgetsEnabled: false }`; for a Super Admin listing every
  tenant, branches of disabled tenants are excluded.
- `PUT /api/v1/budgets`, quantity-budget writes: 409 `BUDGETS_DISABLED`.
- `GET /api/v1/group-portal/budgets`: `{ items: [], budgetsEnabled: false }`.
- `GET /api/v1/organizations/budget-policy` (new): the caller's own
  organization's `{ budgetsEnabled }`, for the sidebar. Session organization
  only — never a query parameter. Admits exactly the roles whose navigation
  carries budget entries (`SUPER_ADMIN`, `HEAD_OFFICE`, `GROUP_USER`); Super
  Admin gets `true` (its pages are multi-tenant and answer per tenant). The
  ordering roles learn the setting from the budget read they already make.

**Reports (server)** — rule: *budget figures come only from budget-enabled
tenants and only from budget-tracked orders; order figures (spend, orders,
products, trends, users-to-review consumption) are unaffected.*
- Budget Report (`/api/v1/analytics/budgets/summary`): a disabled tenant
  answers the empty summary with `budgetsEnabled: false`; a Super Admin's
  multi-tenant view excludes disabled tenants' branches; the order-derived path
  counts only `budget_tracked` orders so it still agrees with the ledger path
  (`plans/OF-BUDGET-ledger-orders-parity.md`).
- `GET /api/v1/budgets` aggregated path: same tracked-order predicate.
- Executive Analytics (`loadBranchBudgets`, `loadMonthBudgets`): a branch of a
  disabled tenant carries `budgetTracked: false`, zero budget, zero budget
  consumption and zero remaining, so it reads "no budget" and raises no
  over/near/under-budget alert; consumption counts tracked orders only. The
  overview KPI row carries `budgetTracking: "all" | "some" | "none"` and the UI
  says "Budget allocation is off" instead of "no budget" / negative remaining.
  A budget-metric comparison (remaining, utilization) ranks only tracked
  entities, so a disabled tenant never ranks as a real zero.
- Group Report (`/api/v1/analytics/groups`): budget totals exclude disabled
  tenants' ledger rows.
- Organization Excel export: the "Budget Allocation Mode" column reads "Off".
- `POST /api/v1/admin/repair-budgets` rebuild and
  `scripts/backfill-ke-budget-spend.ts`: sum tracked orders only (a no-op for
  K-Electric today, where every order is tracked).

**UI (presentation only)**
- Create/Edit Company: a "Budget allocation" switch, default off on create;
  the money/quantity mode selector is shown only while it is on.
- Shop: budget card, remaining-after-cart lines and "cart exceeds budget"
  warnings are hidden, and checkout is not gated on budget.
- Group storefront: budget sidebar section hidden.
- Sidebar: Budgets, Budget by Quantity and Budget Report hidden for Head Office
  and Group User of a disabled tenant.
- Budgets, Budget by Quantity and Budget Report show a "Budget allocation is
  off for this organization" notice (for a hand-typed URL, or a Super Admin
  who selects such a tenant) rather than a page of zeroes.
- Group Report shows "Off" in the budget column; the organization list shows a
  "Budget off" badge instead of a model; refund confirmations credit "the
  branch budget, if the order was placed against one".

### Security

- Only `SUPER_ADMIN` can change the setting: both organization write routes are
  `requireApiRole(["SUPER_ADMIN"])`, and the field is an explicit boolean in
  the strict Zod schemas (mass assignment by any other key is rejected).
- Changing it is audited in the same transaction as
  `UPDATE_ORGANIZATION_BUDGETS_ENABLED` with the previous and new value.
- The policy endpoint reads the session's organization only; no tenant can
  learn another tenant's setting.
- Turning budgets off removes a spending control. That is the intent of the
  switch and is a Super Admin decision; the audit row is the accountability.
- No budget figure is newly exposed: every changed response only removes
  figures or adds a boolean.

### Not changed

- K-Electric scripts (`sync:ke`, `backfill-ke-budget-spend`, restore). KE stays
  enabled; the scripts are out of scope and would only matter for a tenant
  that was switched off.
- The per-user Group User `budgetAllocationEnabled` flag is kept as stored; it
  has no effect while the tenant's budgets are off (the budgets API answers
  "off" first and the sidebar hides the entry).
- An order already holding budget when budgets are switched off is still
  budget-checked if it is edited — its treatment is fixed at creation. Reject
  it and re-order if that is not wanted.
- Add-on expiry keeps settling the kept ledger rows, so they are correct if
  budgets are switched back on.

## Tests

- Unit: `lib/organization-budget-policy.test.ts` (predicate, fail-loud),
  `lib/server/mutation-validation` (create default false, strict boolean),
  sidebar navigation, shop and organizations page behaviour.
- Contract: `lib/server/organization-budget-policy-contract.test.ts` — every
  ledger-moving path consults `orderTakesBudget`, both creation paths resolve
  tracking under the row lock and store it, every budget reader carries the
  tracked-order predicate; `budget-consumption-contract.test.ts` extended.
- Integration (`tests/integration/organization-budget-toggle.test.ts`, real
  routes against Postgres): create defaults off; PATCH audited and SUPER_ADMIN
  only; order with zero budget succeeds when off and leaves every ledger row
  unchanged; order refused for budget when on; full lifecycles (reject, fulfil,
  refund, edit, delete) of an untracked order leave the ledger untouched after
  budgets are switched back on; a tracked order placed before switching off
  still settles exactly; budget reads write nothing; budget writes 409; reports
  exclude disabled tenants and untracked orders; cross-tenant isolation of the
  policy endpoint.
- E2E: Super Admin toggles the switch in Edit Company; an Order Portal user of a
  budget-off tenant with no budget places an order and sees no budget card.
</content>
</invoke>
