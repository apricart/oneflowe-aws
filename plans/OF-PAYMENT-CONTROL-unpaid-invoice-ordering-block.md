# OF-PAYMENT-CONTROL — Block ordering on unpaid invoices (per-organization toggle)

Builds on `plans/OF-PAYMENT-CONTROL-overdue-ordering-block.md`, which wired an
order gate into both order-creation paths and left the overdue count behind
one seam (`lib/server/overdue-payment-source.ts`) returning "not configured".
This change answers that plan's open questions 1, 2, 3 and 5 for the tenants
that opt in, and connects the seam.

## Requirement

A Super Admin, while creating or editing an organization, has a toggle. When
it is on for an organization, a branch of that organization that has **two
unpaid invoices** cannot create an order, and the person ordering is shown a
popup: *"You have 2 unpaid invoices. Please pay your dues before placing a new
order."*

## Decisions (confirmed with the requester, 2026-09-30)

1. **The count is per branch**, not organization-wide. The toggle is set on
   the organization; the count and the block are per branch, matching the
   existing gate, Head Office exceptions and budgets. A branch with two unpaid
   invoices is blocked; its sibling branches keep ordering.
2. **An unpaid invoice is an order that is `FULFILLED`, `DELIVERED`, has an
   invoice snapshot (`receipt_data IS NOT NULL`) and `payment_status =
   'UNPAID'`.** These are exactly the orders the Super Admin Paid/Unpaid
   control can act on (`isPaymentStatusUpdateEligible`), so every block can be
   cleared by marking invoices paid. Approved-but-undelivered orders do not
   count: nobody could mark them paid, so a block on them could not be
   cleared.
3. **Threshold stays at 2** — `PAYMENT_CONTROL_POLICY.overdueBlockThreshold`,
   unchanged, so the gate, the refusal payload and the popup all print the
   same number.
4. **Default off.** Every existing organization keeps ordering exactly as
   before until a Super Admin turns it on. With it off the seam still answers
   `NOT_CONFIGURED`, so this change blocks nothing on deploy.
5. **Head Office exceptions still apply.** A blocked branch can be allowed to
   order for one month through the existing
   `POST /api/v1/payment-control/exceptions`.
6. **No amounts leave the seam** (`amountCents: null`). The status endpoint is
   readable by Order Portal users and some tenants hide prices from them
   (`lib/price-visibility.ts`); invoice numbers and delivery dates are enough
   to say which invoices are unpaid.

## Architecture

| Piece | Layer | File |
|---|---|---|
| Toggle column | persistence | `db/schema.ts` (`organizations.blockOrderingOnUnpaidInvoices`), `drizzle/20260930160000_add_block_ordering_on_unpaid_invoices.sql` |
| What an unpaid invoice is; popup copy; refusal parsers (pure) | domain | `lib/unpaid-invoice-block.ts` + `.test.ts` |
| The seam, now reading the toggle and counting | server domain | `lib/server/overdue-payment-source.ts` |
| Refusal message | domain | `blockedMessageOf` in `lib/payment-control-policy.ts` |
| Toggle accepted on create / edit (Super Admin only), audited | route | `app/api/v1/organizations/route.ts`, `app/api/v1/organizations/[id]/route.ts`, `lib/server/mutation-validation.ts` |
| Group result carries the code | server domain | `lib/server/group-order-creation.ts`, `components/group-portal/types.ts` |
| Pre-submit check (fails open — the server decides) | client | `lib/ordering-block-check.ts` |
| Popup | UI | `components/payment-control/unpaid-invoices-dialog.tsx` |
| Toggle in Create / Edit Company | UI | `app/(portal)/organizations/page.tsx` |
| Popup call sites | UI | `app/shop/page.tsx`, `components/group-portal/storefront/group-storefront.tsx` |

The gate call sites, the resolver, the exception routes and the status route
do not change.

## Data

```sql
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS block_ordering_on_unpaid_invoices boolean NOT NULL DEFAULT false;
```

Additive, defaulted, metadata-only on Postgres 11+ (no table rewrite). No
backfill. The count query is served by the existing
`orders_org_branch_status_idx (organization_id, branch_id, status)`; no new
index. Rollback: deploy the previous build (the column is then unused); drop
the column in a later release if wanted.

## Security

- **Who may set the toggle:** `SUPER_ADMIN` only. Both organization write
  routes are already `requireApiRole(["SUPER_ADMIN"])`; the field is added to
  the strict Zod schemas, so no other route can carry it and an unknown field
  is still refused. Every change is audited (`UPDATE_UNPAID_INVOICE_ORDERING_BLOCK`,
  before and after) in the same transaction; the create audit row records the
  initial value.
- **Who may clear a block:** marking an invoice paid stays `SUPER_ADMIN` only
  (`app/api/v1/orders/[id]/payment-status/route.ts`); granting an exception
  stays `SUPER_ADMIN` / `HEAD_OFFICE`, tenant-fenced. Unchanged.
- **Who is blocked:** every role creating an order for the blocked branch,
  on both paths, including Head Office and Super Admin ordering on its
  behalf. The gate runs inside the order transaction on the server; the
  popup's pre-check is presentation only and fails open, because a UI check
  is not a control.
- **Tenant isolation:** the count is scoped by both `organization_id` and
  `branch_id` from the gate's authoritative scope, never from the request.
  The status read keeps its existing fence (`resolveViewableBranch`).
- **Response exposure:** the 409 carries only `{ code, state, reason,
  overdueCount, threshold, exceptionExpiredAt }` as before; no amounts.

## Tests

- `lib/unpaid-invoice-block.test.ts` — the definition (each status, each
  fulfilment status, paid vs unpaid, no snapshot), the message, the 409 and
  group-result parsers (malformed input → null).
- `lib/payment-control-policy.test.ts` — the new message wording.
- `lib/server/payment-control.test.ts` — the seam contract changes
  deliberately: it now reads the toggle first and returns not-configured
  when it is off, counts with the tenant and branch predicate, and never
  selects an amount.
- `lib/server/organization-approver-validation.test.ts` — the field is
  accepted as a boolean, refused otherwise, defaults to `false` on create.
- `lib/ordering-block-check.test.ts` — blocked, allowed, every failure fails
  open.
- `components/payment-control/unpaid-invoices-dialog.test.tsx` — copy, branch
  list, no "continue", dismiss.
- `app/(portal)/organizations/page.test.tsx` — the toggle defaults off, is
  sent on create and edit, prefills, and is neither shown to nor sent by Head
  Office.
- `app/shop/page.test.tsx` — a blocked pre-check shows the popup and submits
  nothing; a server 409 shows the same popup instead of a toast; clear →
  submitted.
- `lib/server/payment-control.test.ts` (contract) — both pages wire the popup;
  the group route tags the refused branch; the toggle is written only behind
  the Super Admin gate and audited in the transaction.
- `lib/server/pending-invoice-notification-contract.test.ts` — updated
  deliberately: the shop's new-order button now goes through
  `attemptNewOrder`, which still ends in the pending-invoice guard; edits
  still skip both.
- `tests/integration/unpaid-invoice-ordering-block.test.ts` — against
  Postgres with the **real** seam: off → nothing blocked even with unpaid
  invoices; on → 0, 1 allowed, 2 refused with 409 and no row written; paid,
  undelivered, unfulfilled, no-snapshot orders not counted; another branch and
  another tenant not counted; marking one invoice paid through the real
  payment-status route unblocks; a Head Office exception unblocks; group
  submission fails only the blocked branch with the code; the toggle is
  Super Admin only on create and edit (Head Office / Branch Admin / Order
  Portal → 403, unauthenticated → 401), refused as a non-boolean, audited.

## Risks

- **K-Electric imported orders default to `UNPAID`.** Turning the toggle on
  for K-Electric would block every branch with two delivered imported orders
  immediately. The toggle defaults off; do not enable it for a tenant whose
  payment status is not maintained.
- An order paid outside OneFlowe but never marked paid keeps its branch
  blocked. That is the requested behaviour; the remedy is to mark it paid or
  grant an exception.

## Not built

- An organization-wide count (declined in favour of per branch).
- A configurable threshold per organization.
- Mounting the existing Head Office panel (`components/payment-control/*`)
  on a page; the exception API is available and unchanged.

## Deliberate test changes

Existing assertions that pinned the old refusal wording ("overdue payment
limit (2) has been reached") were changed to the requested sentence:
`lib/payment-control-policy.test.ts`, and two in
`tests/integration/payment-control-api.test.ts`. The seam contract in
`lib/server/payment-control.test.ts`, which pinned the seam to always return
"not configured", now pins the toggle-first behaviour instead.
