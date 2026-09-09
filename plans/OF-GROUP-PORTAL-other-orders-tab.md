# OF-GROUP-PORTAL — "Other orders" tab in the Group Order Portal storefront

## What and why

The Group Order Portal storefront (`/group-portal`) has three tabs: `Shop`,
`My group orders`, `Refunds`. The orders tab is scoped to the caller's own
submissions (`listGroupOrders({ userId })`), so a requester who orders for eight
branches has no way to see what those branches' own employees have raised —
which is the context they need before raising another order against the same
budget.

This adds a fourth tab, **Other orders**: the orders raised by `ORDER_PORTAL`
employees in the branches assigned to this requester, **read-only**.

## Investigation findings

These shaped the design and are recorded because two of them are
counter-intuitive.

### 1. The list read is already permitted, server-side

`GET /api/v1/orders` deliberately has **no role allowlist** — it narrows rows
per role instead (`addOrderRoleConditions`). `usesMultiBranchScope` returns true
for `GROUP_ORDER_PORTAL`, so that role already reaches
`addMultiBranchOrderScope` and already receives every order in its assigned
branches. The storefront simply never called the endpoint.

So the tab needs **no new read privilege** on the list. It reuses the
`createdByRole` filter added for the Group User's equivalent tab
(`plans/OF-GROUP-USER-other-orders-tab.md`).

### 2. The single-order read is denied twice over

`GET /api/v1/orders/[id]` refuses this role for two independent reasons:

* `GROUP_ORDER_PORTAL` is not on its `requireApiRole` allowlist.
* `hasBranchAccessForOrderRead` sends every role except `GROUP_USER` to
  `verifyResourceAccess`, which compares the order's branch to `scope.branchId`
  — and a multi-branch role has no pinned branch, so it is `null` and every
  comparison fails.

Both have to change for a detail view. The second is the same widening
`GROUP_USER` already received; generalising it from that one role to
`usesMultiBranchScope` is the honest expression of the rule that was already
there.

### 3. Every write is creator-bound, in four places

| Action | Gate | Requires |
|---|---|---|
| Edit a pending order | `canOrderPortalEditOrder` | `actorUserId === orderCreatedByUserId` |
| Refund request | `orders/[id]/refunds` | `orderData.createdByUserId === userId` |
| Fulfilment token, token email | `canViewFulfillmentToken` | creator match |
| Invoice | `invoice-access-policy.ts` | `GROUP_ORDER_PORTAL: ownOrdersOnly: true` |

`CLAUDE.md` states the same rule in prose, and
`lib/server/group-order-cross-role-visibility.test.ts` pins all four. **None of
them is touched.** The tab was specified read-only precisely so they stay as
they are.

## Scope

**In scope**

* `GROUP_ORDER_PORTAL` added to the `orders/[id]` GET allowlist, with the
  branch check resolved from its assignments.
* Creator **contact** details (email, phone, employee id) withheld from a
  requester reading an order it did not raise. The display name stays.
* A read-only `OtherBranchOrders` tab component and its wiring into the
  storefront.
* Shared list chrome extracted so the new tab does not duplicate the Group
  User's equivalent tab.

**Out of scope — deliberately**

* Editing, cancelling, refunding, the fulfilment token, the token email, and
  the invoice for an order this user did not raise. All four controls above
  stay exactly as they are.
* Group orders raised by *other* Group Order Portal requesters. The tab is
  `ORDER_PORTAL`-raised orders only, so it reads as the counterpart of "My
  group orders".
* Any change to the Group User's `/approvals` tabs.

## Design

### Least privilege on the detail read

The detail endpoint selects `creatorName`, `creatorEmail`, `creatorPhone` and
`creatorEmployeeId`. A requester needs to know *who* raised an order in its
branches; it does not need every branch employee's phone number, and a role
that reaches many branches would otherwise be able to enumerate the contact
details of everyone in them.

`lib/order-detail-visibility.ts` (pure, unit-tested) decides this. It withholds
the three contact fields from `GROUP_ORDER_PORTAL` alone, and only for an order
that role did not create — so every other role's response is byte-for-byte what
it was, and the requester's own orders are unaffected.

### No `OrdersDirectory` here

The Group User's tab renders `OrdersDirectory` because that role genuinely has
the decision controls it exposes. A requester has none of them, so reusing it
would mean rendering a component whose main purpose is actions this caller may
not perform, then hiding them all. The tab gets a small read-only list and a
detail sheet in the storefront's own visual language instead.

### Shared chrome, to keep Sonar duplication down

`components/orders/order-list-chrome.tsx` holds the three pieces both tabs
need — the status pill row, the search box, and the pager — plus the
loading/error/empty body. `ApprovalOtherOrders` is refactored onto it in the
same change, so the second tab adds no duplicated block. `ApprovalAllOrders` is
pre-existing and left alone.

## Security impact

* **Authentication** — unchanged.
* **Authorization** — one role gains a **read** on the single-order endpoint,
  bounded by assignments it already has on the list endpoint. No write, no new
  role on any mutating route. The four creator-bound controls are untouched and
  their contract tests still pass unmodified.
* **Tenant isolation** — the new branch check re-asserts the organization
  before consulting assignments (`scope.organizationId !== order.organizationId`
  denies), then resolves the branch set server-side. An empty set denies.
* **Data minimisation** — the change *reduces* what is returned: creator
  contact details are withheld from this role.
* **Injection / IDOR** — the order id is still validated as a positive integer
  and the row is still checked against the caller's scope before anything is
  returned.

## Database impact

None. No schema change, no migration, no new query shape beyond the existing
`resolveScopedBranchIds`.

## Tests

* `lib/order-detail-visibility.test.ts` — behavioural: the requester loses
  contact fields on another's order, keeps them on its own, and every other
  role is unaffected.
* `lib/server/multi-branch-order-scope.test.ts` — two existing assertions
  **deliberately updated**, because the contract they pinned has legitimately
  changed:
  * the `orders/[id]` GET allowlist now names `GROUP_ORDER_PORTAL`;
  * the branch check is now keyed on `usesMultiBranchScope(role)` rather than
    `role !== GROUP_USER_ROLE`.
  Both are updated to assert the *new* contract, not removed — and new
  assertions are added that the requester gains no write.
* `lib/server/group-order-cross-role-visibility.test.ts` — left untouched and
  must still pass, which is the evidence that no write moved.

## Risk and rollback

Low. The list endpoint is unchanged. The detail endpoint gains one role on a
read path and returns strictly less data to it than it returns to anyone else.
Rollback is reverting the commit; no data is written and no migration runs.
