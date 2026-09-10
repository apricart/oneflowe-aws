# OF-GROUP — The branch owns its orders

## Decision

Reverses the rule recorded in `CLAUDE.md` under "Group orders belong to the
branch": *"That widening is reading only: editing, cancelling, refunding … all
stay with the person who raised the order."*

The new rule is **branch ownership**: a requester may edit or refund any order
at a branch it is assigned to, whoever raised it. Both requester roles are
affected, symmetrically:

| Actor | May now write |
|---|---|
| `ORDER_PORTAL` | any pending order at **its own branch**, including group orders |
| `GROUP_ORDER_PORTAL` | any pending order at **any of its assigned branches**, including orders raised by branch staff |

Requested by the product owner on 2026-09-10 after being shown the conflict.
Audit choice, also theirs: **log it and notify the raiser**.

## Why the old rule existed, and what replaces it

Creator equality was doing two jobs at once: proving the actor belonged to the
branch, and proving they were accountable for the order. Branch ownership keeps
the first and drops the second. Accountability moves to the audit trail — every
cross-actor write records both parties and notifies the raiser, so the person
answerable for an order still learns that it changed.

What does **not** change:

- Tenant and branch predicates. Every check still asserts organization, branch,
  and that the branch belongs to the order's organization.
- `PENDING`-only editing, and the fulfilled-and-delivered gate on a requester
  refund.
- Approval, rejection and refund *approval* stay with the roles that already
  hold them. Nothing here lets a requester decide its own order.
- The fulfilment token and the token email. Those are a credential handed to an
  administrator, not an action on the order, so they stay with the raiser.

## Design

One pure module, `lib/order-write-access.ts`, answers "may this actor write to
this order" for both roles by resolving the actor to a **set of branch ids** —
one entry for `ORDER_PORTAL`, the assignment set for `GROUP_ORDER_PORTAL`. An
empty set denies; it never widens to the tenant. `lib/order-edit-policy.ts`
delegates to it so there is one statement of the rule.

### Server

1. `PUT /api/v1/orders/[id]` accepts both requester roles. The actor's branch
   set is resolved from the session (`resolveScopedBranchIds` for the group
   role), never from the request.
2. `lockOrderEditAccess` locks the order by id + organization, then checks the
   order's branch against that set. Everything downstream (inventory, budget,
   quantity budgets, stock) keys on **the order's branch**, not the actor's,
   because the group role has no single branch.
3. `persistEditedOrder` drops the `createdByUserId` predicate from its
   optimistic guard; id + organization + branch + `PENDING` still guard it.
4. `POST /api/v1/orders/[id]/refunds` accepts `GROUP_ORDER_PORTAL` and checks
   both requester roles against the branch set instead of creator equality.
5. Every cross-actor write writes an audit row naming actor **and** raiser, and
   inserts a notification addressed to the raiser, inside the same transaction.

### UI

- Shop: the two `placedByGroupPortal` write guards come off, and the dialog
  footer's Edit button gains the `PENDING` guard it was missing (the bug that
  produced "Update failed — Order not found").
- Group portal "Other orders": gains the shared `RefundManagement` control and
  an edit entry point, so the widening is reachable from both portals.

## Tests

- `lib/order-write-access.test.ts` — the rule itself: each role, own branch,
  another branch, another tenant, empty assignment set, non-pending status.
- `lib/order-edit-policy.test.ts` — updated to the new rule.
- `lib/server/group-order-cross-role-visibility.test.ts` — the "reading a group
  order grants no write" block is **restated, not deleted**: it now asserts
  branch ownership is enforced, that the token still stays with the raiser, and
  that cross-actor writes are audited and notified.
- Integration: cross-tenant and cross-branch denial for both roles.

## Risk

This widens write authorization in a live multi-tenant application. The
containment is that branch scope is still mandatory on every path and is
resolved server-side from the session. The realistic failure mode is a branch
colleague editing an order the raiser was still expecting — mitigated by the
notification, not prevented.

Rollback: revert the commit. No schema change, so no migration to undo.
