# OF-DESK-TEAM — Super Admin manages the Order Desk's orders from Order Desk Team

Builds on `plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md`.

## Requirement

Super Admin should see, on `/desk-team`, the approvals view an Apricart
Executive sees on `/executive` — but for **every** order any Order Desk user
entered, in every organization, with no executive assignment needed — and be
able to do everything the executive can do there: approve, reject, send back
for correction, and open the customer's screenshot.

`/desk-team` gets two tabs:

1. **Team** — today's page, unchanged (desk users, executive approvers).
2. **Desk orders** — the executive's approvals component, unfenced.

## Decisions

- **Same endpoints, wider role list.** `/api/v1/executive/approvals*` admit
  `SUPER_ADMIN` beside `APRICART_EXECUTIVE`, exactly as the delivery dashboard
  routes already do. No second copy of the list, decision or screenshot logic.
- **Super Admin's reach is "every desk order"**: `created_by_role = 'ORDER_DESK'`,
  any organization. It is resolved from the account row re-read on every
  request (`loadDeskApprovalReach`: an active, undeleted `SUPER_ADMIN` →
  `{ kind: "all" }`), never from the session. The executive's reach is
  unchanged (`{ kind: "organizations" }`, from its assignments).
- **Desk orders only.** The authorizer's new Super Admin branch decides only a
  desk-entered order; any other order is 404 there, as for the executive. The
  tenant decision routes (`/api/v1/orders/[id]/approve|reject|return-for-correction`)
  still refuse Super Admin at `requireApiRole`, so Super Admin gains no
  authority over a tenant's own orders.
- **The decision is recorded as Super Admin's.** `decisionRole: "SUPER_ADMIN"`
  joins `OrderDecisionRole`; the audit rows are the usual `ORDER_APPROVED`,
  `ORDER_REJECTED`, `ORDER_RETURNED_FOR_CORRECTION` with
  `actorRole`/`decisionRole` `SUPER_ADMIN`.
- **No notification**, as for the executive (`decisionQueuesNotifications`):
  desk orders have no tenant raiser to tell, and telling Super Admin about its
  own approval is noise. The warehouse is still told, as it is for any decider.
- **Approval names the version seen** (`expectedUpdatedAt`) — same route, same rule.
- **No lock beyond the account re-read.** The executive path takes its
  assignment `FOR SHARE` because removing an assignment is a routine change
  that must not race a decision; Super Admin has no assignment, and its
  account is re-read inside the deciding transaction.
- The card links Super Admin to the order page (`/orders/[id]`), where the
  rest of the order's life (delivery, refund, invoice) is already Super
  Admin's. The executive gets no such link (it cannot reach that page).

## Files

- `lib/order-desk-approval.ts` — `DeskApprovalReach`, `canSuperAdminDecideDeskOrder`,
  `decisionQueuesNotifications` also false for `SUPER_ADMIN`.
- `lib/order-approver-role.ts` — `SUPER_ADMIN` decision role + label.
- `lib/server/apricart-executive-scope.ts` — `loadDeskApprovalReach`,
  `deskApprovalOrderCondition`.
- `lib/server/executive-approvals.ts` — list and screenshot read through the new reach.
- `lib/server/order-decision-policy.ts` — `authorizeSuperAdminDeskOrderDecision`.
- `app/api/v1/executive/approvals/**` — admit `SUPER_ADMIN`.
- `components/executive-approvals/executive-approvals.tsx` — `audience` prop for copy and the order link.
- `components/order-desk/desk-team-manager.tsx` — the two tabs.

## Tests

- Unit: `lib/order-desk-approval.test.ts`, `lib/apricart-executive-access.test.ts`
  (routes now admit both roles), `lib/server/executive-desk-approval-contract.test.ts`
  (Super Admin path decides desk orders only, re-reads the account),
  `components/order-desk/desk-team-manager.test.tsx` (tabs).
- Integration: `tests/integration/executive-desk-approval-api.test.ts` —
  Super Admin lists desk orders of every organization (no assignment) and no
  tenant order; approves, rejects, returns with `SUPER_ADMIN` in the audit and
  no notification; cannot decide a tenant order (404) and still cannot through
  the tenant routes (403); reads the screenshot; a deactivated Super Admin
  reaches nothing.

## Security impact

Widens who decides desk orders from "assigned executive" to "assigned executive
or any Super Admin". Super Admin already holds the platform's highest
authority (it sets prices, assigns executives, delivers and refunds); deciding
an Apricart-entered order is within that. No tenant role gains anything; the
proxy is unchanged because Super Admin is not API-confined.

## Database impact

None. No migration.

## Rollback

Revert the commit. Decisions Super Admin made stay valid orders with ordinary
audit rows.
