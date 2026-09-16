# OF-GROUP-USER — Money budget allocation over the approver's branch set

## Why

Head Office allocates money budgets (monthly baseline and add-on credits) to
every branch in its organization from `/budgets`, backed by
`GET /api/v1/budgets?all=true` and `PUT /api/v1/budgets`. `GROUP_USER` — the
multi-branch approver — approves orders across a set of assigned branches and
already reads their budgets in reports, but cannot allocate: the page, the
sidebar, `proxy.ts` and both handlers admit `HEAD_OFFICE` and `SUPER_ADMIN`
alone.

The ask: let a Group User do the same allocation, for the branches its
assignments reach and no other.

## Rules

| | SUPER_ADMIN | HEAD_OFFICE | **GROUP_USER** |
|---|---|---|---|
| Tenant | requested or all | own row | own row |
| Branches listed (`all=true`) | tenant's / all | tenant's | **assignments ∩ tenant** |
| `branchIds` / `groupIds` params | narrow | narrow | narrow **within** assignments |
| `PUT` target branch | any | own tenant | **own tenant and assigned** |
| No assignments | n/a | n/a | 403 on list and write — never the tenant |
| Quantity-mode organization | refused, pointed at Budget by Quantity | same | same |

The assigned set is `resolveScopedBranchIds()` from
`lib/server/multi-branch-scope.ts` — assigned groups' current member branches
∪ directly assigned branches, each join re-asserting the tenant — the same
resolver the branches, orders, approvals and analytics endpoints use. The
budgets handlers add the organization predicate they already apply to Head
Office on top of it.

An empty resolved set is a **refusal**, not an unfiltered query:
`buildBudgetBranchScope` drops the branch predicate when the list is empty,
so an empty list must never reach it for this role.

## Changes

### `lib/money-budget-access.ts` (new, pure)
- `MONEY_BUDGET_MANAGER_ROLES`, `canManageMoneyBudgets(role)` — replaces the
  inline role check in the route and the page's copy.
- `managesAssignedBranchesOnly(role)` — true for `GROUP_USER`.
- `resolveManagedBranchScope({ role, assignedBranchIds, requestedBranchIds })`
  — tenant-wide roles pass their request through unchanged; the approver gets
  `requested ∩ assigned` (or the whole assigned set), and a refusal when that
  is empty.
- `canAllocateToBranch({ role, assignedBranchIds, branchId })` — the write
  check.

### `app/api/v1/budgets/route.ts`
- `GET ?all=true`: after the role gate, load the approver's assignments,
  resolve the scope, refuse on empty, and hand the resolved list to
  `handleAllMoneyBudgets` as `branchIds`. The tenant-context 400 that covers
  Head Office covers the approver too.
- `PUT`: after loading the branch, the tenant check that covers Head Office
  covers the approver; then `canAllocateToBranch` with the assignments read
  from the database, 403 on failure. Nothing inside the transaction changes;
  the audit row already records the acting user.
- The single-branch `GET` (no `all`) is untouched — it serves the store's own
  branch and nothing in the approver's UI calls it.

### UI
- `proxy.ts` — `/budgets` joins `GROUP_USER_AREAS`. `/budget-by-quantity`
  stays closed (see "Not included").
- `components/shell/sidebar.tsx` — "Budgets" entry for `GROUP_USER`.
- `app/(portal)/budgets/page.tsx` — the gate and the filter row read
  `canManageMoneyBudgets`; the organization's allocation mode comes from the
  `budgetAllocationMode` each row already carries (server-resolved in
  `withBudgetAllocationModes`) with `/api/v1/settings` — Head Office-only
  organization configuration — read only by the roles that may. The group and
  branch filters are already scoped for this role by `/api/v1/groups` and
  `/api/v1/branches`.

### `lib/permissions.ts`
- `GROUP_USER` template gains `Permission.FINANCE_MANAGE_BUDGETS`, so the
  seeded RBAC data says what the handlers now enforce.

## Tests

- `lib/money-budget-access.test.ts` — role gate; pass-through for tenant-wide
  roles; approver: intersection, no-assignment refusal, all-outside refusal,
  write check true/false, ids normalised.
- `tests/integration/group-roles-api.test.ts` + fixture teardown — with the
  existing approver (Alpha group → Alpha North, Alpha South; Beta and Foreign
  outside): list shows exactly the two Alpha branches; `branchIds=Beta` → 403;
  `PUT` add-on to Alpha South succeeds and the ledger and audit row reflect
  it; `PUT` to Beta and to Foreign → 403; the assignment-less approver → 403
  on both; `GROUP_ORDER_PORTAL` still 403; Head Office still sees all three
  tenant branches and still cannot reach Foreign.
- `proxy.test.ts` — `/budgets` open, `/budget-by-quantity` still closed.

## Not included

**Budget by Quantity** (`/budget-by-quantity`, `app/api/v1/budget-quantity/`)
is a separate 764-line surface for organizations that allocate in units rather
than money. It stays Head Office-only in this change; a Group User in a
quantity-mode organization gets the same "allocate from Budget by Quantity"
refusal Head Office gets from the money endpoint. Extending it is a follow-up
with its own plan.

## Security impact

One role admitted to a financial write, fenced server-side to its own
assignment rows and its own tenant, refused when empty. The write already runs
in a transaction with a row lock and an audit entry naming the acting user.
No change to price visibility, settings, or the quantity ledger.

Pre-existing, out of scope, flagged: the single-branch `GET` accepts any
`branchId` from Head Office without a tenant check.

## Database impact

None.

## Rollback

Revert the commit. Allocations an approver made in the meantime are ordinary
ledger rows with an audit trail and need no reversal.
