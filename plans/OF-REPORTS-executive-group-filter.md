# OF-REPORTS — a group filter on Graphical Reports

## Requirement

A reader of the Product Performance tab (and the other two levels, which
share the filter row) wants to narrow every figure to one or more branch
groups.

## What already exists

- `branches.groupId` is the whole model: a group is a set of branches.
- Every executive route (`overview`, `compare`, `options`, `drill-down`)
  already parses `groupIds` and applies it in `entityConditions` — as an
  **order-level** filter (`orders.branchId IN (branches of the groups)`).
- `/api/v1/branches` returns `groupId`/`groupName` per branch and is scoped
  per role (Group User → assigned branches only).

So the client never sent `groupIds`, and the server applied it in only one of
the two places that matter.

## The gap in the existing server filter

`loadBranchBudgets` and `loadScopedBranchRows` build their branch list from
`scope.branchIds` alone. Under an order-level group filter the Overview would
draw every branch's budget with only the group's spend against it, the KPI
budget totals would be the tenant's, and the branch picker would ignore the
group. The order side and the budget side would disagree about which
branches are on screen.

## Decision: a group selection is a branch narrowing, resolved in the scope

`resolveExecutiveScope` reads `groupIds`, loads the member branches inside
the tenant fence, and intersects them with whatever branches were requested —
then hands the result to the same `resolveAnalyticsBranchIds` path every
branch selection already takes. Consequences, all wanted:

- every query, budget or order, is fenced to the group's branches, because
  everything is fenced on `scope.branchIds`;
- the cache key (`executiveCacheKey`) is correct without change, since it is
  built from the resolved set;
- a Group User cannot reach past its assignments by naming a group, because
  the intersection with `assignedBranchIds` still happens afterwards;
- another tenant's group intersects to nothing and is refused with the same
  `403 No branches in scope` a foreign branch id gets;
- a Super Admin naming a group without a tenant is a narrowing, not the
  unrestricted case.

The pure part — "requested branches ∩ group branches, or the group branches
when none were requested" — is `narrowRequestedBranchIdsToGroups` in
`lib/server/analytics-scope.ts`, beside `resolveAnalyticsBranchIds`, and is
unit-tested there. The one rule that matters: **an empty intersection is
returned as empty, never as "no restriction"**, because `resolveAnalyticsBranchIds`
treats an empty request as "everything allowed".

`entityConditions` keeps its `groupIds` predicate. It is now redundant for a
filter-bar selection but still carries the Explore workbench's group *keys*,
and removing it would change nothing the reader sees.

### Keys on the group dimension

`compare` and `drill-down` already fold `branch` and `organization` keys into
the scope parameters before the fence is resolved, so a picked entity can
only narrow. `group` joins that list (`isScopeKeyedDimension`). Otherwise a
filter-bar group of G1 and a picked comparison of G2 vs G3 would resolve the
scope to G1 and the filter to G2/G3 — an empty answer for a legitimate
question.

## Client

- `ExecutiveFilterState.groupIds`; `toQuery` emits `groupIds`.
- A "Groups" multi-select in the filter row, between organization and
  branch. Its options are **derived from the scoped branch list**
  (`groupOptionsFromBranches`), not from `/api/v1/groups`: only groups with
  at least one branch the caller can see are offered, which is exactly the
  set for which a selection can return rows, and it is the same request the
  branch filter makes, so it comes from the SWR cache.
- Picking groups narrows the branch filter (`BranchFilter` already takes
  `groupIds`) and clears any branch selection, as an organization change
  does — a branch outside the chosen group would intersect to nothing.
- Changing organization clears groups too. "Clear" resets them.
- The Excel cover sheet gains a "Groups" row, resolved from the same branch
  list.

## Tests

- `lib/server/analytics-scope.test.ts` — the pure intersection rule.
- `lib/server/executive-analytics-scope.test.ts` — the db stub learns
  `branches.groupId`; tenant, group-user, super-admin and foreign-group
  cases.
- `tests/integration/executive-analytics-api.test.ts` — a group created in
  the test around North: overview budgets and branch list, compare by branch,
  options, drill-down all narrow to North; the neighbour's group is refused;
  the South approver naming North's group is refused (assignment wins).
- `executive-filters.test.tsx` — the options derivation and the clearing
  rules; `side-by-side-workspace.test.tsx` — the cover-sheet row.

## Security

No new endpoint. `groupIds` is parsed with `normalizePositiveIds`, resolved
server-side against the caller's own fence, and can only narrow. The group
list the UI offers comes from an endpoint that already scopes per role.
