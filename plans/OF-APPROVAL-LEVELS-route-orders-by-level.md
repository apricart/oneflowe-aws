# OF-APPROVAL-LEVELS — Phase 2b: route orders by approval level

Builds on `plans/OF-APPROVAL-LEVELS-organization-approval-levels.md` (phase 1,
the levels and the band rule), `plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md`
(phase 2a, users holding a level) and `plans/OF-JOIN-department-signup-multi-user.md`
(the sign-up that names approvers per level).

Status: **implemented 2026-10-15.** Migration `20261020120000_order_approval_level`.

## What is being asked

An order of an organization that uses approval levels is decided only by the
holders of the level its amount falls in, at its branch. Every other
organization's orders are decided exactly as today.

## The one switch

**Levels apply to an organization only while all three hold** — the same rule
the join form uses (`approvalLevelsActive`, `lib/order-approval-levels.ts`):

* order approval is required (`organizations.order_approval_required`);
* approval levels are switched on (`organizations.order_approval_levels_enabled`,
  set by Super Admin in Create / Edit Organization);
* at least one level is saved.

An organization that never turned levels on sees **no change at all**: its
orders never carry a level, and every decision, notification and screen takes
the path it takes today. This is pinned by tests on both sides.

## Decisions

| # | Decision |
|---|---|
| R1 | **The band is fixed on the order when it is created**, from its total including tax: `orders.approval_level` (`approvalLevelForAmount`, the strict bands of `approvalLevelBands`). Null on every order created while levels were not active, and on every order of every other organization. **Null means "decided exactly as today".** |
| R2 | **Each order is banded on its own total**, group-portal branch orders included. Each branch order is priced and committed in its own transaction and decided by that branch's approvers, so its own total is the amount being approved. (The join plan's earlier "band the whole submission" idea is dropped: a failed branch would have counted towards a total nobody approves.) |
| R3 | **Who decides a levelled order:** an active user of the order's organization who holds **exactly** the order's level, whose role may hold a level (`canHoldApprovalLevel`), who reaches the order's branch (a Group User through its assignments, a Branch Admin at its own branch, Head Office anywhere), and **who did not create the order**. No one else — not the branch's other approvers, not Head Office without the level. The same rule decides approve, reject and return for correction. |
| R4 | **The switch is read at decision time.** If Super Admin switches levels off (or approval off, or removes every level), a pending levelled order is decided by the normal approvers at once; switching back on returns it to its band. The stored level is never cleared by the switch. |
| R5 | **An order is refused at creation (409) when no holder of its level reaches its branch**, before any budget or stock is held, because a pending order with no one able to decide it would hold budget indefinitely. The message tells the person to contact Head Office. |
| R6 | **An edit re-bands the order** when it already has a level and levels are active, with the current amounts. The new band must have a holder (else the edit is refused, 409). If the band changed, the new band's holders are told it awaits approval. Every approval, rejection and return claims on the level it authorized, so an edit landing in between makes the decision a 409, never a decision at the wrong level. |
| R7 | **Notifications:** "awaiting approval" (on creation, on an edit that changes the band, and on resubmission after a correction) goes to the holders of the order's level at its branch, instead of the configured approver role. At send time the recipient is checked again: still active, still holding that level, still reaching the branch, and the organization still using levels. |
| R8 | **Super Admin may not remove a level that a pending order is waiting at** (409), as phase 2a already refuses removing a level a user holds. |
| R9 | **Order Desk orders are never levelled**: an Apricart Executive decides them, as today. |
| R10 | **Screens:** each order row carries `approvalLevel` and `levelDecisionLocked` (this viewer cannot decide it because of its level), so no Approve / Reject / Return button is offered that the server would refuse; the order page says which level it awaits. Hiding is presentation only — the server is the control. |
| R11 | **Coverage:** Head Office (own organization) and Super Admin read, per active branch, how many people hold each level there (`GET /api/v1/approval-levels/coverage`), shown on the Users page, so a gap that would refuse orders (R5) is visible before it bites. |

## Design

### Data — `drizzle/20261020120000_order_approval_level.sql`

* `orders.approval_level integer NULL`, `orders_approval_level_ck`
  (`NULL OR BETWEEN 1 AND 10`), added `NOT VALID` then validated. Nullable, no
  default: a metadata-only change on the large `orders` table, and every
  existing order reads null (R1).

### Pure — `lib/order-approval-levels.ts`

* `approvalLevelsActive(settings)` — the switch;
* `approvalLevelForAmount(amountCents, amountsCents)` — the band of an amount;
* `canDecideLevelledOrder({ actor, order, organization })` — R3.

### Server — `lib/server/order-approval-routing.ts`

* `loadApprovalLevelSettings(tx, organizationId, { lock })` — the switch, the
  approver role and the amounts, read with the organization row (`FOR SHARE` in
  a write, as the creation path already holds).
* `loadLevelHolders(tx, { organizationId, branchId, level, excludeUserId })` —
  who may decide (R3), for creation, edit and notifications.
* `resolveOrderApprovalLevel(tx, …)` — creation (R1, R5, R9).
* `rebandEditedOrder(tx, …)` — edit (R6).
* `levelledDecisionFor(tx, …)` — the authorizer's levelled branch (R3, R4).
* `loadApprovalLevelCoverage(organizationId)` — R11.

### Wiring

| Path | Change |
|---|---|
| `POST /api/v1/orders` (`persistCreatedOrder`) | `resolveOrderApprovalLevel` after the initial approval; `approvalLevel` on the insert; 409 `APPROVAL_LEVEL_UNAVAILABLE`. |
| `lib/server/group-order-creation.ts` | The same, per branch order; a refused branch is a `failed` result, the others go through. |
| `PATCH /api/v1/orders/[id]` (`persistEditedOrder`) | `rebandEditedOrder`; the update writes the new level; a changed band notifies its holders. |
| `authorizeOrderDecision` | A levelled order (stored level and levels active) is authorized by `levelledDecisionFor` instead of the role rule; the authorization carries `approvalLevel`. Unlevelled orders: unchanged. |
| `approveOrder`, `rejectOrder`, `returnOrderForCorrection` | The claim adds `approval_level = <authorized level>` when one was authorized. |
| `queueOrderCreatedNotifications`, `queueOrderResubmittedNotifications`, `deliverClaimedOrderEmail` | R7. Unlevelled orders: unchanged. |
| `saveOrganizationApprovalLevels` | R8. |
| `GET /api/v1/orders`, `GET /api/v1/orders/[id]`, the group approvals queue | R10 flags. |
| `GET /api/v1/approval-levels/coverage`, Users page | R11. |

## Security

* **Authorization** stays in the one authorizer every decision path uses, inside
  the deciding transaction, reading the actor's level and reach from the
  database, never the request. The claim re-checks the level.
* **Tenant isolation:** holders are read within the order's organization only;
  the coverage read is fenced to Head Office's own organization (Super Admin
  names one).
* **Self-approval:** a creator never decides its own levelled order.
* **No effect elsewhere:** every new branch is gated on a stored level *and*
  `approvalLevelsActive`; an organization with levels off reaches none of it.

## Tests

* **Unit:** `approvalLevelForAmount` at every boundary, one and many levels;
  `approvalLevelsActive`; `canDecideLevelledOrder` across role, level, reach,
  tenant and creator.
* **Contract:** the order-path readers of the levels, listed deliberately in
  `order-approval-levels-contract.test.ts`; the claim conditions.
* **Integration (`tests/integration/order-approval-routing.test.ts`):** creation
  bands and refuses; only the band's holder decides (approve, reject, return);
  Branch Admin, Head Office and the other level are refused; the creator is
  refused; an edit across a band makes a stale approval 409 and moves the
  order; switching levels off returns the order to the normal approvers; an
  organization without levels is unchanged end to end; level removal with a
  pending order is 409; coverage is fenced.

## Risk and rollback

Nothing changes for an organization without levels. For one with levels, the
first line of rollback is Super Admin switching levels off (R4), with no
deploy. Code rollback: revert; the column is ignored and then dropped
(`ALTER TABLE orders DROP COLUMN approval_level`). **Apply the migration before
deploying**: the order reads select the column.
