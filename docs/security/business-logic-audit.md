# Business-logic manipulation audit

Date: 2026-07-15

## Scope

The audit covered live HTTP mutation paths for orders, product pricing, global and branch inventory, money and product-quantity budgets, approval, rejection, fulfilment, delivery progress, payment state, refunds, invoices, organization settings, and administrative order deletion. Legacy import code was reviewed only where it establishes current data conventions; it was not redesigned.

## Business rules discovered

- An order line price is the active organization inventory `customPrice` when present, otherwise the active global product `basePrice`. The order item stores that server-selected price as a historical snapshot.
- Checkout accepts only a branch's active, visible, non-deleted assignment whose organization inventory and global product are also active and non-deleted.
- Quantities must be positive, follow the product's whole/decimal increment rule, be unique per product in a request, not exceed stock or quantity budget, and not exceed 1,000,000 per line.
- The current checkout calculation is `subtotal = sum(round(unit price cents * quantity))`, `tax = 0`, `discount = 0`, and `total = subtotal + tax`. Configured discounts and the organization `tax_rate` setting are not currently applied by checkout; see clarification items.
- A branch/month money budget has `available = allocated + credited - spent - held`. Checkout places the full order total on hold. Fulfilment moves the same amount from held to spent. Rejection releases held money.
- Quantity-budget organizations also require a positive product allocation for each ordered product. Checkout moves quantity into held; fulfilment moves held to used; rejection and an approved refund release the applicable quantity.
- Stock is global. It is deducted when a pending order is created and restored when that pending/approved order is rejected or safely deleted. Existing refund workflows do not restore stock.
- Normal order approval and rejection begin at `PENDING`. Manual fulfilment requires `APPROVED`, a valid approval token, and a Head Office or Super Admin actor. It explicitly sets delivery progress to `DELIVERED`.
- Delivery progress is Super Admin-only and sequential. The system can auto-fulfil an approved order 48 hours after `DELIVERED` when no refund record exists.
- Refunds are itemized from order-item snapshot prices, require a binary `PAID` order, are limited to the order's calendar month, and are allowed for `PENDING`, `APPROVED`, or `FULFILLED` orders. Full refunds set `REFUNDED`; partial refunds preserve the prior order status.
- Non-Super-Admin refund actors create `PENDING` requests. Super Admin can approve/process or cancel them. Approved and legacy `COMPLETED` records count against refundable money and quantity.
- Invoice numbers use an organization-scoped atomic counter. If the counter migration is absent, the unique order TID is the fallback invoice identifier.
- Organization settings are restricted to an allowlist. Head Office is tenant-scoped; price visibility and budget allocation mode are Super Admin-only.

## Trusted server-derived values

| Value | Authoritative source |
| --- | --- |
| Actor, role, organization, branch | Validated server session; Super Admin-selected tenant/branch is checked against database ownership |
| Product orderability | Branch assignment, organization inventory, and global product rows under transaction locks |
| Unit price and product snapshot | Current organization custom price or global base price read again under lock |
| Quantity increment and decimal rules | Global product row |
| Subtotal, tax, total | Server calculation; current tax is explicitly zero |
| Budget availability and holds | Locked branch/month budget row |
| Quantity-budget availability and holds | Locked product quantity-budget rows |
| Stock availability and decrement | Locked global product rows |
| Order/payment/delivery/refund state | Current database row, with conditional update or row lock at mutation time |
| Refund amount and remaining eligibility | Order-item price snapshots, ordered quantities, approved/pending refund rows, order total, and paid state |
| Invoice number | Atomic database sequence update, or unique TID fallback |
| Actor IDs, timestamps, approval/refund/payment fields | Server workflow and authenticated actor |

## Client values that were previously trusted too far

- Checkout treated an organization inventory ID as sufficient and did not prove that the product was active/visible for the selected branch at write time.
- Repeated checkout requests had no user-scoped idempotency key, so retries could create multiple legitimate-looking orders and consume budget/stock more than once.
- Duplicate order/refund line IDs were not rejected explicitly. A repeated refund item could bypass per-line reasoning before the order-level amount check.
- Approval, rejection, fulfilment, payment progress, and delivery progress validated a previously read status but then updated without a compare-and-set. Simultaneous requests could both apply side effects.
- Refund eligibility and cumulative refunded quantities/amounts were calculated before the transaction. Two simultaneous direct refunds could validate the same remainder.
- Money-budget add-ons used read/compute/write and could lose a concurrent credit or race checkout holds. Quantity allocation transactions locked rows in a different order from checkout.
- Quantity-budget reset accepted a scoped client selection and zeroed held/used/spent state even when live orders still depended on it.
- A direct order DELETE path removed an order without reversing stock or budgets. The administrative delete path could restore rejected stock twice and used the current month instead of the order month.
- Concurrent organization-setting creates could persist duplicate `(organization, key)` rows.
- Client-supplied prices, totals, discounts, tax, remaining budget, approval actors, payment state, and refund amount were already rejected by strict request schemas or ignored in favor of server values. This boundary was retained.

## Status-transition matrix

### Order status

| From | To | Actor/rule |
| --- | --- | --- |
| `PENDING` | `APPROVED` | Branch Admin, Head Office, or Super Admin with tenant/branch access; atomic single winner |
| `PENDING` | `REJECTED` | Same roles; reason required; releases stock and held ledgers transactionally |
| `PENDING` | `REFUNDED` | Existing explicit rule: paid, same-month, full refund approved by Super Admin |
| `APPROVED` | `FULFILLED` | Head Office/Super Admin plus approval token, or system auto-fulfil after delivered window |
| `APPROVED` | `REFUNDED` | Paid, same-month, full refund approved by Super Admin |
| `FULFILLED` | `REFUNDED` | Paid, same-month, full refund approved by Super Admin |
| Any eligible status | Same status | Partial refund only; refund amount/lines change, base order status is preserved |
| Any other pair | — | Rejected |

Manual token fulfilment is the existing explicit shortcut from `APPROVED` to `FULFILLED` and sets delivery to `DELIVERED`; it does not require the three delivery-progress calls.

### Delivery progress

| From | To | Actor |
| --- | --- | --- |
| `NOT_STARTED` | `IN_PROCESS` | Super Admin, approved order only |
| `IN_PROCESS` | `OUT_FOR_DELIVERY` | Super Admin, approved order only |
| `OUT_FOR_DELIVERY` | `DELIVERED` | Super Admin, approved order only |
| Any skip/backward/same-state transition | — | Rejected |

### Payment and refund request state

| Resource | From | To | Actor/rule |
| --- | --- | --- | --- |
| Payment | `UNPAID` | `PAID` | Super Admin |
| Payment | `PAID` | `UNPAID` | Super Admin; blocked after an approved/completed refund |
| Refund request | `PENDING` | `APPROVED` | Super Admin; exact request is claimed atomically |
| Refund request | `PENDING` | `CANCELLED` | Super Admin; atomic single winner |
| Refund request | `PENDING` | `SUPERSEDED` | Super Admin processing another refund for the order |

## Concurrency protections added

- User-scoped `Idempotency-Key` plus request fingerprint and a unique database index. Same-key/same-body requests replay the existing order; same-key/different-body requests return `409`.
- Budget, product quantity-budget, branch assignment, organization inventory, product, refund-order, and quantity-ledger rows are locked before authoritative calculations and writes.
- Approval, rejection, manual fulfilment, payment, delivery progress, refund cancellation, and auto-fulfil use conditional updates with a returned winner. Losing requests return/resolve as conflicts without ledger side effects.
- Refund transactions lock the order and recalculate paid/status eligibility, prior quantities, approved/pending amounts, and remaining capacity before any write.
- Money-budget changes serialize on the branch/month row. Quantity allocations use the same money-budget-then-product-budget lock order as checkout.
- Quantity-budget reset locks selected rows and refuses to erase any period containing held/spent/used commitments.
- Invoice counters remain atomic (`last_value = last_value + 1 RETURNING`) and order idempotency prevents retry-generated duplicate invoices.
- Administrative order deletion locks the order and is limited to unpaid, refund-free `PENDING`/`APPROVED` orders. Direct deletion is disabled.

## Transactions added or strengthened

- Checkout: order, item snapshots, stock, invoice counter, receipt snapshot, money hold, quantity holds, and audit log remain one transaction; authoritative availability and price checks now occur under its locks.
- Rejection and fulfilment: the status claim, money ledger, quantity ledger, stock restoration/movement, and delivery update are single transactions.
- Refund request/direct processing/admin approval: order claim/revalidation, order totals/status, refund/refund items, budget, quantity ledger, notifications, receipt update, and audit are transactional.
- Money budget: baseline/credit, monthly row, add-on history, and audit are transactional under a budget lock.
- Quantity allocation/reset: existing transactions now lock in a consistent order and protect committed usage.
- Payment/delivery changes: atomic state update and audit remain in one transaction.
- Organization setting: unique upsert and audit are one transaction.
- Administrative delete and auto-fulfil: conditional state claim and every related ledger write remain one transaction.

## Database protections

Migration `drizzle/20260715000000_business_logic_integrity.sql` adds:

- unique creator/idempotency and organization/setting indexes;
- non-negative and upper-bound checks for prices, stock, order/refund quantities, order/refund totals, discounts, budgets, quantity budgets, and invoice counters;
- money and quantity budget conservation checks;
- refund-total-not-greater-than-order-total and idempotency-key/fingerprint pairing checks.

The check constraints are `NOT VALID`: PostgreSQL enforces them for new/changed rows immediately without making deployment fail on unknown legacy defects. Operations must inspect/repair old violations and then `VALIDATE CONSTRAINT` in a separately reviewed maintenance window. The migration has not been applied to the configured remote database by this audit.

Deploy the migration before the application build: checkout and setting upserts require the new idempotency columns and unique setting index.

## Tests and results

- Full Vitest run: **16 files and 107 tests passed**.
- Added 4 business-rule tests, 6 concurrency-protection contract tests, duplicate-line and quantity-cap cases, and a 100-way simultaneous invoice-number test.
- Added an isolated PostgreSQL suite with simultaneous attempts to spend one budget remainder, buy the last unit, approve twice, refund twice, fulfil twice, and generate 50 invoices.
- The PostgreSQL suite is **6 tests skipped** because no `TEST_DATABASE_URL` is configured. The only configured database is remote, and the audit intentionally did not run destructive concurrency fixtures against it. Run `TEST_DATABASE_URL=<isolated database> npm test -- business-concurrency.integration.test.ts` before deployment.
- `npx tsc --noEmit`: passed.
- Production `next build`: passed with command-scoped `AWS_REGION=us-east-1` and `NEXTAUTH_URL=https://localhost` to satisfy the existing environment validator.
- `git diff --check`: passed.

## Product-owner clarification required

1. **Discount representation and application.** Schema/API comments describe percent values as basis points and flat values as cents, while the UI treats them as whole percentages and PKR. Checkout currently applies no discount. Confirm units, active-window timezone, whether organization custom prices are discountable, and rounding before enabling server-side discounts.
2. **Tax calculation.** `tax_rate` is configurable from 0 to 1, but checkout hardcodes zero. Confirm whether tax applies, whether it is calculated before/after discount, and its rounding/invoice treatment.
3. **Refund stock disposition.** Existing refunds release budgets but do not add product quantity back to global stock. Confirm whether returned, damaged, cancelled-before-fulfilment, and fulfilled goods should affect stock differently.
4. **Pending-order refunds.** Existing code explicitly allows refunding a paid `PENDING` order. Confirm this remains intended instead of requiring rejection/cancellation first.
5. **Binary payment eligibility.** The model has only `PAID`/`UNPAID`, so a paid order's eligible paid amount is assumed to be its full total. Partial/captured payment amounts need a separate authoritative payment ledger before partial-payment refunds can be modeled safely.
6. **Manual fulfilment shortcut.** Confirm that a token-authorized Head Office/Super Admin may move `APPROVED` directly to `FULFILLED`/`DELIVERED`, bypassing delivery-progress steps.
7. **Refund budget accounting.** One Super Admin refund path subtracts held/spent while the refund-management path adds budget credit. Both increase availability by the refund amount, but reporting semantics differ. Choose one accounting convention before consolidating.
8. **Maximum quantity.** Confirm the new 1,000,000-per-line safety ceiling or provide product/category-specific maxima.
9. **Order deletion.** Confirm that fulfilled, paid, rejected, or refunded orders must remain immutable financial history; the hardened endpoint now deletes only unpaid, refund-free pending/approved orders.
10. **Inactive settings.** `auto_approve_orders` and `order_approval_threshold` are configurable, and UI helpers describe a two-hour auto-approval window, but no server auto-approval mutation exists. Confirm whether these settings should be implemented or removed.
