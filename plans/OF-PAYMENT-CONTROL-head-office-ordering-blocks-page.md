# OF-PAYMENT-CONTROL — Head Office Ordering Blocks page

Builds on `plans/OF-PAYMENT-CONTROL-overdue-ordering-block.md` (the exception
mechanism) and `plans/OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block.md` (the
per-organization unpaid-invoice block).

## Problem

A branch blocked by unpaid invoices can keep ordering while Head Office holds a
one-month exception on it. The grant and revoke routes, the audit, and a
`PaymentControlPanel` component with Grant / Revoke buttons all existed, but no
page ever rendered the panel, so Head Office had no way to use it short of
calling the API directly.

## Decisions

1. **A new Head Office page, `/ordering-blocks`** ("Ordering Blocks" in the side
   menu, after Head Count Requests). It lists every **active** branch of the
   caller's own organization with its unpaid-invoice count against the limit,
   its standing, and its latest exception. "Allow ordering" / "Manage" on a row
   opens the existing `PaymentControlPanel` (timeline, grant, revoke) in a
   dialog. Head Office only: Super Admin keeps the API but gets no page (it is
   not pinned to a tenant); an organization-wide Viewer is read-only and is
   kept out by `proxy.ts`, the layout, the endpoint and the menu.
2. **Visible only while the organization blocks ordering on unpaid invoices**
   (`organizations.block_ordering_on_unpaid_invoices`). The list endpoint
   answers `{ enabled: false }` when it is off; the side menu offers the entry
   only on `enabled: true`, and a direct visit shows "Ordering is not blocked
   on unpaid invoices".
3. **The grant route now refuses an organization whose block is off** — 409,
   for Head Office and Super Admin alike, judged inside the grant transaction
   on the locked branch's organization (`block_disabled` from
   `grantPaymentControlException`). Before this an exception granted with the
   block off sat unseen and switched on the moment Super Admin turned the block
   on. Revoking stays possible whatever the toggle says. This is a behaviour
   change on an existing route; no production caller depended on it (no page
   reached it).
4. **Standing is decided by the gate's own rules** — `hasReachedUnpaidInvoiceLimit`,
   `isLastOrderBeforeBlock`, `isExceptionActive` — over the count from
   `unpaidInvoiceOrdersOf` and the limit from `loadUnpaidInvoiceBlockConfig`, so
   the page cannot call a branch blocked while an order would go through.
   Standings: BLOCKED, EXCEPTION_ACTIVE, LAST_ORDER, UNPAID, CLEAR.
5. **Bounded.** Two queries per read whatever the organization's size (one
   grouped count, one `DISTINCT ON` latest exception per branch); filtering
   (`attention` default, `blocked`, `exception`, `all`), search (name or code,
   ≤ 100 chars) and paging (≤ 100 per page) run in memory; the summary counts
   the whole organization. The query is a strict Zod schema — an
   `organizationId` or `branchId` parameter is 400.
6. **Unchanged:** the exception's length (one calendar month, Karachi, from
   `PAYMENT_CONTROL_POLICY`), one live exception per branch, re-granting after
   expiry, revocation, the audit rows, and the unacknowledged-delivery block,
   which still has no exception.

## Modules

| Piece | Where |
|---|---|
| Area, role, list URL (import-free, read by `proxy.ts`) | `lib/ordering-blocks-access.ts` |
| Standing, query schema, page/summary (pure) | `lib/ordering-block-branches.ts` + `.test.ts` |
| Loader | `lib/server/ordering-block-branches.ts` |
| List endpoint | `app/api/v1/payment-control/branches/route.ts` + `.test.ts` |
| Grant refusal | `lib/server/payment-control.ts`, `app/api/v1/payment-control/exceptions/route.ts` |
| Page | `app/(portal)/ordering-blocks/{layout,page}.tsx`, `components/payment-control/ordering-blocks-workspace.tsx` + `.test.tsx` |
| Menu | `components/shell/sidebar.tsx` (`withoutOrderingBlocksNavigation`) + `sidebar.ordering-blocks.test.ts` |
| Routing | `proxy.ts` (`protectedPrefixes`, `ROLE_GATED_AREAS`) + `proxy.test.ts` |
| Against Postgres | `tests/integration/ordering-block-branches-api.test.ts`; `payment-control-api.test.ts` now switches the block on |

## Security

Head Office only (`requireApiRole(["HEAD_OFFICE"])` plus `canUseOrderingBlocksPage`);
organization from `getRequestScope()`, never the request; every query carries
`organization_id = $org`; no amounts returned; `private, no-store`. No new
write path — grants and revocations go through the existing audited routes.

## Database

None. No migration.

## Rollback

Revert the commit. The grant refusal is the only behaviour change to an
existing route; reverting restores grants with the block off.
