# OF-GROUP-USER — "Other orders" tab in the Group User approval workspace

## What and why

The Group User (`GROUP_USER`) approval workspace at `/approvals` has two tabs:

| Tab | Component | Shows |
|---|---|---|
| By group order | `ApprovalQueue` | Group Order Portal submissions, grouped under their envelope |
| All branch orders | `ApprovalAllOrders` | Every order in the assigned branches, group-raised or not |

Neither answers the question an approver actually asks day to day: *what have
the branch employees themselves raised that is waiting on me?* A group order and
an employee order are decided for different reasons, and mixing them means the
approver reads the "Group Order" badge on every row to tell them apart.

This adds a third tab, **Other orders**, listing only the orders raised by
`ORDER_PORTAL` employees in the branches assigned to this user, with the same
action set a Branch Admin has over its own branch's orders.

## Scope

**In scope**

* A `createdByRole` filter on `GET /api/v1/orders`, allowlisted to the two
  ordering roles, applied to both the row query and the summary snapshot so the
  status counts describe the tab rather than the whole scope.
* A new `ApprovalOtherOrders` client component rendering the shared
  `OrdersDirectory` — the same component `/orders` uses — so the tab inherits the
  full action set rather than growing a parallel one.
* The third tab in `ApprovalsWorkspace`.

**Out of scope**

* Any change to which orders a Group User may reach. The branch scope stays
  `resolveScopedBranchIds`, resolved server-side from the caller's own
  assignments; this filter can only narrow that set, never widen it.
* Any change to the existing two tabs.
* Any new decision endpoint. `GROUP_USER` already reaches approve, reject,
  send-token-email and the order detail; fulfil, fulfilment status and payment
  status are `SUPER_ADMIN`-only for every role including `BRANCH_ADMIN`, so
  "everything a Branch Admin can do" does not include them.

## Design

### Why a creator-role filter and not `groupOrderId IS NULL`

`CLAUDE.md` forbids adding a `groupOrderId IS NULL` predicate to any query,
because group orders belong to the branch and a rule keyed on that column drops
them out of the branch's own figures. This filter is keyed on the **creator's
role** instead, which is the thing the tab is actually about. Group orders are
raised only by `GROUP_ORDER_PORTAL` users, so they fall outside
`createdByRole=ORDER_PORTAL` as a consequence of what they are, not because a
query hid them — and the "All branch orders" tab beside it still shows
everything, so nothing becomes unreachable.

### Filter parsing

`lib/order-creator-filter.ts` — pure, DB-free, unit-tested:

* absent or empty → no filter
* a value in `ORDER_CREATOR_ROLES` (`lib/group-order-visibility.ts`) → that role
* anything else → **400**, not "ignore it"

An unrecognised value must not be silently dropped. This filter narrows a
result; ignoring a malformed value widens what comes back, which is the wrong
direction to fail in.

### The predicate

An `exists` subquery over `users` joined to `roles`, parameterized by the
allowlisted role name. `orders.created_by_user_id` is nullable, so an order with
no creator matches nothing and is correctly excluded.

### Actions

`OrdersDirectory` already gates its controls on the props it is given:
`canDecideOrders` (approve/reject) and `isSuperAdmin` (fulfil, fulfilment
progress, payment status). Passing `canDecideOrders` from the endpoint's own
`capabilities` block and `isSuperAdmin={false}` yields exactly the Branch Admin
action set — the same wiring `/orders` already uses for this role.

## Security impact

* **Authorization** — unchanged. The tab adds a narrowing filter on top of the
  existing `addMultiBranchOrderScope` predicate. `capabilities` still comes from
  `getOrderDecisionCapabilities`, which re-resolves the branch assignments
  server-side; the UI flag cannot grant a decision the endpoint refuses.
* **Tenant isolation** — unchanged. The organization predicate and the resolved
  branch set both still apply; the new condition is `AND`-ed after them.
* **Injection** — the role name is taken from a compile-time allowlist and bound
  as a parameter. No user string reaches SQL.
* **Enumeration** — the filter cannot reveal an order outside the caller's
  branches, because it only removes rows.

## Database impact

None. No schema change, no migration. The subquery reads `users` and `roles` by
primary key.

## Tests

* `lib/order-creator-filter.test.ts` — behavioural: accepts each allowlisted
  role, rejects an unknown role, an empty string, a role that exists but does
  not raise orders (`BRANCH_ADMIN`), and non-string input.
* `lib/server/multi-branch-order-scope.test.ts` — contract: the filter is
  applied to the summary snapshot as well as the rows, and is rejected rather
  than ignored when malformed.

## Risk and rollback

Low. The endpoint's behaviour is unchanged when `createdByRole` is absent, which
is every existing caller. Rollback is reverting the commit; no data is written.
