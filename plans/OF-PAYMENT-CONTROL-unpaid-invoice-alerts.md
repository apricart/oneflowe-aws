# OF-PAYMENT-CONTROL — unpaid-invoice alerts: one order left, and blocked

Builds on `plans/OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block.md` and
`plans/OF-ORDERING-BLOCK-configurable-thresholds.md`.

## Requirement

With `block_ordering_on_unpaid_invoices` on, a branch stops ordering once its
unpaid invoices reach the organization's `unpaid_invoice_block_threshold`.
Today people learn this only when an order is refused. Everyone who orders for
a branch or approves its orders sees, at the top of every page, a dismissible
alert — not a popup:

1. **One order left** — the branch is one unpaid invoice short of the limit:
   "you can place only one more order; after that, ordering is blocked until
   you clear your dues".
2. **Blocked** — the limit is reached: "your ordering is blocked; you have N
   unpaid invoices; clear your dues before creating a new order". Shown
   instead of (1) for that branch.

A group role sees which branch each alert is about, and that its other branches
can still order.

## Decision

- **The states** (pure, `lib/unpaid-invoice-alerts.ts`):
  - one order left — `isLastOrderBeforeBlock`: `count === threshold − 1` and
    `count ≥ 1`. A limit of 1 never warns: nothing is unpaid at that step, and
    a permanent "one order left" on every branch would be noise.
  - blocked — `hasReachedUnpaidInvoiceLimit` (`count ≥ threshold`) **and** the
    branch's latest Head Office exception is not in force. A branch with an
    exception in force may order, so it is told neither.
- **Same answer as the gate.** Every input is read the gate's way: toggle and
  limit through `loadUnpaidInvoiceBlockConfig`, the count through
  `unpaidInvoiceOrdersOf` (both extracted in
  `lib/server/overdue-payment-source.ts`, which the gate also uses), and the
  exception through `loadLatestException` + `isExceptionActive`, exactly as
  `resolveBranchPaymentControl` does. The integration test checks every
  blocked/not-blocked answer against `resolveBranchPaymentControl`.
- **Who sees it** (`UNPAID_INVOICE_ALERT_ROLES`): `ORDER_PORTAL`,
  `BRANCH_ADMIN` (own branch, from the users row), `GROUP_ORDER_PORTAL`,
  `GROUP_USER` (resolved assignment set, `resolveScopedBranchIds`). Head Office
  and Super Admin are not included: they are not tied to a branch, and an alert
  listing every branch of a tenant on every page would be a report.
- **Endpoint**: `GET /api/v1/payment-control/ordering-alerts`, one call for the
  caller's whole scope. Response: `{ blocked: [...], lastOrder: [...],
  otherBranchesCanOrder, otherBranchesUnaffected }`, each entry
  `{ branchId, branchName, unpaidInvoiceCount, threshold }`; active branches
  only, no amounts, no invoice references. `otherBranchesCanOrder` (a branch in
  scope that is not blocked) decides "you can continue ordering for your other
  branches" on the blocked alert; `otherBranchesUnaffected` (a branch with
  neither alert) decides it on the one-order-left alert.
- **Scope**: organization and branch from `getRequestScope()` (the users row);
  group branches from the assignment tables, fenced again in SQL by
  `branches.organization_id`. Nothing is read from the request. No
  organization or an empty assignment set answers nothing.
- **UI**: `components/payment-control/unpaid-invoice-alerts.tsx`, mounted in
  the portal shell, the `/shop` layout and the `/group-portal` layout; it
  fetches only for the four roles. Blocked is a filled red alert
  (`role="alert"`), one order left a filled orange one (`role="status"`); a
  group role may see both, blocked first; a single-branch role sees at most
  one. Each closes on its own and stays closed for the browser session
  (`sessionStorage`, one key per kind) until its branches, counts or limit
  change. Wording is pure (`unpaidInvoiceAlertsFor`) and varies by single/group
  and initiator/approver.

## Unchanged

The gate, the refusal shape, the blocked popup on a refused order, the Head
Office exception, the threshold columns and their writers. The alerts are
presentation only; the gate in both creation paths remains the control.

## Security

Read-only. Role allowlist via `requireApiRole` (exact, Viewer not admitted);
tenant and branch from the database only; group scope via the existing
resolver, an empty set answering nothing; SQL fenced by organization. Returns
branch names the caller already sees and counts the existing status route
already returns to the same roles; the exception's granter and reason are not
read out. Warehouse, desk, executive and support roles are refused (403), so
the warehouse isolation sweep stays green. `Cache-Control: private, no-store`.

## Database

None. No migration. One grouped read over `branches` and `orders` bounded by
the caller's branch set, plus one exception read per branch at its limit.

## Tests

- `lib/unpaid-invoice-alerts.test.ts` — both boundaries, exception handling,
  the "other branches" flags, parsing, wording per role and branch count,
  dismissal keys.
- `components/payment-control/unpaid-invoice-alerts.test.tsx` — each alert
  renders for its role, both for a group role, none fetched for another role,
  each closes independently and returns when a count changes.
- `tests/integration/unpaid-invoice-alerts.test.ts` — against Postgres: every
  boundary, limit 1, toggle off, the gate's predicate, exception in force /
  expired / revoked (each checked against the gate), per-role scope, inactive
  branches, tenant fence, 401/403.
- `lib/server/payment-control.test.ts` ("the seam") rewritten deliberately to
  follow the extracted predicate and toggle read, with every guarantee kept.

## Rollback

Revert the commit. Nothing is stored.
