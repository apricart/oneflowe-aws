# OF-GROUP-USER — Graphical Reports for the multi-branch approver

## Why

`GROUP_USER` (shown as "Group User") approves orders across a set of branches
resolved from its group and branch assignments. It already reads the Order,
Refund, Product, User, Branch and Group Order reports over that set, but the
Executive Analytics Center at `/reports/graphical` refuses it outright:
`EXECUTIVE_ANALYTICS_ROLES` admits only `SUPER_ADMIN` and `HEAD_OFFICE`, and
`resolveExecutiveScope` returns 403 before a query runs.

The ask: let a Group User open Graphical Reports and see every figure — KPIs,
charts, pickers, drill-down lines — drawn from **only** the branches its
assignments reach.

## Where the boundary already is

Every SQL builder in `lib/server/executive-analytics-queries.ts` fences on
`scope.branchIds` and `scope.organizationIds` from the `ExecutiveScope` that
`resolveExecutiveScope` returns. No builder reads the role. So admitting the
role is a change to the **scope resolver**, not to the fifteen query builders —
if the resolver returns the right branch set, every chart, picker and drill-down
is scoped by construction.

The branch set for this role is the one every other multi-branch read already
uses: `resolveScopedBranchIds(db, userId)` in `lib/server/multi-branch-scope.ts`
(assigned groups' current member branches ∪ individually assigned branches, each
join re-asserting the tenant the assignment was written under). Intersection
with the tenant list and with any requested `branchIds` goes through the
existing `resolveAnalyticsBranchIds` → `resolveMultiBranchAnalyticsIds`, which
already knows `GROUP_USER` and already denies on an empty set.

## Rules for the new scope

| | SUPER_ADMIN | HEAD_OFFICE | **GROUP_USER** |
|---|---|---|---|
| Tenant | requested or none | own row | own row (requested id discarded) |
| Branch set | tenant's / all | tenant's full list | assignments ∩ tenant list |
| `branchIds` param | narrows | narrows | narrows within assignments |
| No tenant on row | n/a | 403 | 403 |
| Empty branch set | n/a | 403 | **403 — never widens to the tenant** |
| `organization` dimension | yes | no | no |
| Prices | read | read | read (not in `PRICE_RESTRICTED_ROLES`) |

A group rollup (`dimension=group`) sums the *branches in scope* that belong to
each group. A Group User assigned two of a group's five branches sees that
group's figure over those two — the other three are outside its reach and are
not summed in. That is the intended reading of "only what they are assigned
to", and it is the same rule `loadBudgetRollup` already applies to Head Office
with a branch filter.

## Changes

### `lib/executive-analytics.ts`
- `EXECUTIVE_ANALYTICS_ROLES` gains `"GROUP_USER"`. `ExecutiveAnalyticsRole`
  widens with it; `requiredRole: "SUPER_ADMIN"` on the organization dimension
  is unchanged, so `dimensionsForRole("GROUP_USER")` excludes it.

### `lib/server/executive-analytics-scope.ts`
- `ExecutiveScope.role` becomes `ExecutiveAnalyticsRole`.
- After the tenant is pinned (same path as HEAD_OFFICE, same
  "Organization context missing" refusal), a multi-branch role loads
  `resolveScopedBranchIds(db, userId)` and passes it as `assignedBranchIds` to
  `resolveAnalyticsBranchIds`. `allowedBranchIds` on the returned scope is the
  assigned ∩ tenant set, not the tenant list.
- `executiveCacheKey` already keys on the resolved branch set, so two Group
  Users with different assignments never share an entry.

### UI
- `app/(portal)/reports/graphical/page.tsx` — the refusal copy names the three
  roles; the gate itself reads `EXECUTIVE_ANALYTICS_ROLES` and needs no change.
- `components/shell/sidebar.tsx` — "Graphical Reports" entry for `GROUP_USER`.
- `app/(portal)/reports/page.tsx` — the Analytics Center card is offered to
  `GROUP_USER` and `/reports/graphical` joins its href allowlist.
- `components/reports/executive/executive-filters.tsx` — no change: the
  organization selector is Super Admin only; the branch selector already lists
  the caller's assignments via `/api/v1/branches`.

### `app/api/v1/categories/route.ts`
- `GET` admits `GROUP_USER`. The filter row's Categories dropdown reads this
  list; it is the global catalogue taxonomy (top-level names and counts, no
  tenant scoping in the existing query), `BRANCH_ADMIN` with the same
  `INVENTORY_VIEW` permission already reads it, and an empty dropdown would be a
  visibly broken control. Nothing about the write paths changes.

### Comments
- `app/api/v1/analytics/executive/drill-down/route.ts` — the note on why prices
  are unredacted names the third role.

## Tests

- `lib/executive-analytics.test.ts` — role gate admits `GROUP_USER`; still
  refuses `GROUP_ORDER_PORTAL`, `BRANCH_ADMIN`, `ORDER_PORTAL`; the organization
  dimension stays closed to it.
- `lib/server/executive-analytics-scope.test.ts` — with `resolveScopedBranchIds`
  stubbed from the fixture: confined to assignments; requested branch outside
  them dropped; all-foreign request → 403; no assignments → 403 "No branches in
  scope"; an assignment on another tenant's branch drops out; no tenant → 403;
  `GROUP_ORDER_PORTAL` still refused; cache keys differ between two Group Users.
- `app/(portal)/reports/graphical/page.test.tsx` — `GROUP_USER` gets the three
  levels; `GROUP_ORDER_PORTAL` still gets the refusal.
- `tests/integration/executive-analytics-api.test.ts` + fixtures — a Group User
  directly assigned to South, plus a stale assignment row pointing at the
  neighbour's branch under tenant A's id. Asserts: 200 on every route; overview
  scope is one branch; compare/options/drill-down show South's figures and
  people only (South 16500; Sana 8500, Group requester 8000); North or Foreign
  named in `branchIds`/`keys`/`key` → 403; `organization` dimension → 403; a
  Group User with no assignments → 403 on every route.

## Security impact

Authorization: one role admitted to four read-only endpoints, with its branch
set derived from its own assignment rows on the server, intersected with its
own tenant, never taken from the request, and refused when empty. No write
path changes. No price redaction change (the role already reads prices in
every other report). Cache keys already carry the resolved branch set.

## Database impact

None. No schema, migration or index change.

## Rollback

Revert the commit. The only persisted-data-adjacent change is the categories
GET allowlist; nothing is written.
