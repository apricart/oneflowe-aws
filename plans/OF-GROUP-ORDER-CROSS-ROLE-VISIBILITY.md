# Group Order Portal orders — visibility to the branch's own roles

## Problem

A `GROUP_ORDER_PORTAL` user raises one submission covering many branches. The
application records one **ordinary** `orders` row per branch, linked back to the
envelope through the nullable `orders.group_order_id`
(`lib/server/group-order-creation.ts`). Those orders spend the branch's budget
and are delivered to the branch, but the branch's own people cannot see them
everywhere they should.

### What is already correct (verified, do not change)

| Role | Surface | Why it already works |
|---|---|---|
| `HEAD_OFFICE` | `/orders`, Order Report, dashboard | scoped to `orders.organization_id` only |
| `BRANCH_ADMIN` | `/orders`, Order Report, dashboard | scoped to `orders.branch_id` — no creator predicate |
| `BRANCH_ADMIN` / `HEAD_OFFICE` | approve / reject | `canMakeOrderDecision` never looks at the creator |

Nothing anywhere filters on `group_order_id IS NULL`, so a group order is an
ordinary branch order to every one of those queries. This plan adds contract
tests that pin that down, because it is the property the whole feature rests on.

### The real gaps

1. **`ORDER_PORTAL` history (`/shop`)** — `addOrderRoleConditions` in
   `app/api/v1/orders/route.ts` adds `created_by_user_id = self`. A branch's own
   Order Portal user never sees an order raised for their branch by the Group
   Order Portal, even though it spent their budget.
2. **No approval notification** — `queueOrderCreatedNotifications` returns early
   unless the creator's role is `ORDER_PORTAL`, and the group creation path never
   calls it. A group order lands in the Branch Admin's queue silently: no bell,
   no email.
3. **User-attribution reports** — `analytics/users/list` and
   `analytics/users/performance` hard-filter creators to
   `roles.name = 'ORDER_PORTAL'`. A group-portal creator is absent from the user
   filter list and their orders are missing from User Performance entirely.
4. **Order Report cannot identify a group order** — the "Group Order" column and
   the `groupOrderRef` filter are gated to `GROUP_USER` in
   `app/(portal)/reports/order-report/page.tsx`, so Head Office and Branch Admin
   see the rows but cannot tell which submission they came from.

## The rule this change implements

> An order raised through the Group Order Portal is placed **on behalf of** a
> branch. The branch's own roles read it exactly as they read any other order of
> theirs. **No write, decision, or refund right changes for anyone.**

The discriminator is `orders.group_order_id IS NOT NULL`, which is null on every
order created by any other flow. **No order that exists today changes hands.**

## Changes

### Domain (pure, unit-tested)

- **`lib/group-order-visibility.ts`** (new) — one place for the rule:
  - `isGroupPortalOrder(order)` — the `group_order_id` discriminator.
  - `canOrderPortalReadOrder({ viewerUserId, order })` — own order **or** group
    order. Ownership only; tenant/branch scope stays with each caller, matching
    how `canViewFulfillmentToken` is documented.
  - `ORDER_CREATOR_ROLES` / `isOrderCreatorRole` — the roles that *raise* orders
    (`ORDER_PORTAL`, `GROUP_ORDER_PORTAL`), for user-attribution reports.

### Reads that widen

- `app/api/v1/orders/route.ts` — `ORDER_PORTAL` predicate becomes
  `own OR group order`, still under the unchanged organization **and** branch
  pins. Adds a derived `placedByGroupPortal` boolean to each row (the raw
  `groupOrderId` is not exposed).
- `app/api/v1/orders/[id]/route.ts` GET — same widening for the detail read.
- `lib/invoice-access-policy.ts` — `ORDER_PORTAL` gains
  `includesBranchGroupOrders`, so the invoice for a group order in its own branch
  is readable. Every other role's rule is byte-for-byte unchanged; the branch and
  tenant checks still run first.

### Reads that must NOT widen (asserted by tests)

`canOrderPortalEditOrder`, order PUT/DELETE, refund requests
(`canAccessOrderForRefund`), `canViewFulfillmentToken`, `send-token-email`.
All stay creator-only. The UI hides the Edit and Refund controls for a group
order so a user is never offered an action the server will refuse.

### Notifications

- `queueOrderCreatedNotifications` accepts a creator in `ORDER_CREATOR_ROLES`.
  The `users.branch_id = order.branch_id` assertion still applies to
  `ORDER_PORTAL`; a `GROUP_ORDER_PORTAL` user has no pinned branch, so it is
  checked against its assigned branch scope instead.
- `createBranchOrder` queues the event inside the branch's own transaction and
  the submission delivers after the loop. A notification failure is logged and
  never fails an order that was already created — the module's existing
  "branches are independent" contract.

### Reports

- `analytics/users/list`, `analytics/users/performance` — creator role filter
  becomes `ORDER_CREATOR_ROLES`. In `users/list` the branch predicate also
  matches a multi-branch user assigned to one of the scoped branches, since such
  a user has no `users.branch_id`.
- `app/(portal)/reports/order-report/page.tsx` — the Group Order column and
  filter are offered to `SUPER_ADMIN`, `HEAD_OFFICE` and `BRANCH_ADMIN` too. The
  server condition is already pinned to the caller's organizations.
- `components/orders/orders-directory.tsx` — a "Group" badge beside the TID.

## Security review

- **Tenant isolation** — untouched. Every widened read still runs under the same
  organization and branch predicates; only the creator predicate is relaxed, and
  only for rows carrying a `group_order_id`.
- **Privilege escalation** — none. No role gains a write, a decision, a refund,
  or a fulfilment token it did not have.
- **Horizontal access** — an `ORDER_PORTAL` user still cannot see a colleague's
  personally-raised order. The widening covers only orders raised *for the
  branch* by the group portal.
- **Mass assignment / input** — no new request-supplied field is trusted;
  `placedByGroupPortal` is derived server-side and read-only.

## Tests

- `lib/group-order-visibility.test.ts` — the pure rule.
- `lib/server/group-order-cross-role-visibility.test.ts` — contract tests that
  Branch Admin and Head Office scoping carries no creator predicate, that the
  Order Portal predicate is the `or(...)` above, and that edit / refund / token /
  send-token remain creator-only.
- Additions to `lib/invoice-access-policy` coverage and the notification
  security contract.

## Rollback

Every change is additive and keyed on `group_order_id IS NOT NULL`. Reverting the
commit restores the previous behaviour exactly; no migration, no backfill, no
data change.
