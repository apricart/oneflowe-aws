# OF-BUDGET — Ledger and order-derived consumption must produce the same number

## Problem

`GET /api/v1/analytics/budgets/summary` reports a branch's consumption from one
of two sources, chosen by `useOrderScopedSpending` (`preset !== "all"` plus any
date/month/year filter):

- **Ledger** — `budgets.amount_spent_cents + amount_held_cents`, the running
  totals the order lifecycle maintains.
- **Orders** — the `orders` table re-aggregated by status and `created_at`.

The Budget Report's graph pins `preset=all` and always reads the ledger; its
report table and the page KPIs pass the live preset and flip to the orders path
the moment a range is chosen. The two then disagree, and the same disagreement
exists between this route and `loadBranchBudgets` in
`lib/server/executive-analytics-queries.ts`, whose comment already claims "the
two reports therefore agree".

Both paths are defensible. They are not reconcilable today because three
separate rules are stated twice, in two different dialects, and drift:

### R1 — Which period an order belongs to

| Site | Rule |
|---|---|
| Order creation hold (`app/api/v1/orders/route.ts:1028`) | `new Date().toISOString().slice(0,7)` — **UTC** month |
| Fulfilment held→spent (`lib/server/order-fulfillment.ts:103`) | `created_at` → **UTC** month |
| Rejection release (`lib/server/order-decision-service.ts:213`) | `created_at` → **UTC** month |
| Group order hold (`lib/server/group-order-creation.ts:866`) | **UTC** month |
| Orders aggregation (both analytics sites) | `TO_CHAR(created_at, 'YYYY-MM')` — **the Postgres session time zone**, whatever it happens to be |
| Analytics period list (`buildAppMonthPeriods`) | **Asia/Karachi** month |

Every write goes to the UTC-month row. The orders aggregation buckets by the
session time zone, so on any deployment whose session is not UTC every order in
the last five hours of a month lands in a bucket the ledger never credited.

**Decision: UTC is canonical for a budget period.** That is what every existing
`budgets.period` row was written against; re-basing the ledger on Karachi would
re-bucket live money across months and is out of scope. The orders aggregation
is corrected to UTC to match the ledger — not the reverse.

### R2 — Which statuses count as spend and which as commitment

Duplicated verbatim as inline SQL in two places
(`app/api/v1/analytics/budgets/summary/route.ts:189-190`,
`lib/server/executive-analytics-queries.ts:309-310`). Nothing keeps them equal,
and nothing ties them to `lib/order-status.ts`, which is where the rest of the
app decides what a status means.

### R3 — How a refund lands

`app/api/v1/orders/[id]/refunds/route.ts:283` decrements the row for
`new Date().toISOString().slice(0,7)` — **the current month**, not the order's.
`getRefundEligibilityError` limits refunds to the order's own calendar month
using `Date.getMonth()`, **server-local** time. Three month definitions in one
flow: local for the window, UTC for the row, session-TZ for the read. At a month
boundary a refund can be admitted by the local-time check and then debited from a
period the order never touched, leaving the ledger and the orders path
permanently apart for both months.

## Approach

State each rule once, in a pure module, and have every consumer — SQL and
TypeScript, read path and write path — derive from it.

### New: `lib/budget-consumption.ts` (pure, no DB)

- `CONSUMED_SPENT_STATUSES` / `CONSUMED_HELD_STATUSES` — the two status sets,
  derived from `getOrderStatusesForFilter` in `lib/order-status.ts` so they
  cannot drift from the app's own status model.
- `orderConsumptionCents(order)` — `max(0, total - refund)`, the per-order
  arithmetic the SQL performs, available to TypeScript callers and to tests as
  the oracle.
- `classifyOrderConsumption(order)` — `"spent" | "held" | "none"`.
- `budgetPeriodOf(date)` — the canonical UTC `YYYY-MM`. The write path's
  `toISOString().slice(0,7)` expressed once, with a name.
- `isSameBudgetPeriod(a, b)` — for the refund window.

### New: `lib/server/budget-consumption-sql.ts`

The same three rules as Drizzle fragments: `consumedSpentCentsSql()`,
`consumedHeldCentsSql()`, `orderBudgetPeriodSql()` — the last emitting
`TO_CHAR(created_at AT TIME ZONE 'UTC', 'YYYY-MM')`, pinning the bucket to the
ledger's period regardless of session time zone.

### Changed

1. `app/api/v1/analytics/budgets/summary/route.ts` — `loadOrderScopedSpending`
   uses the three fragments. No change to RBAC, scoping, or response shape.
2. `lib/server/executive-analytics-queries.ts` — `loadBranchBudgets` uses the
   same two fragments. Its stale comment is corrected.
3. `app/api/v1/orders/[id]/refunds/route.ts` — debit the **order's** period row
   (`budgetPeriodOf(order.createdAt)`), and judge the refund window with
   `isSameBudgetPeriod` rather than local `getMonth()`.
4. `lib/server/order-fulfillment.ts`, `lib/server/order-decision-service.ts`,
   `app/api/v1/orders/route.ts`, `lib/server/group-order-creation.ts` — call
   `budgetPeriodOf` instead of an inline `toISOString().slice(0,7)`. Same value,
   one definition; this is what stops the drift returning.

Deliberately **not** changed: which source each caller picks. The Budget Report
graph still reads all-time ledger and the report still narrows by orders — that
is a product decision. This change makes the two agree on the same window.

## Security / RBAC

No authorization change. The summary route keeps
`resolveAllowedBudgetOrganization`, `resolveBudgetBranchIds`,
`shouldHidePricesForRole` and the `redactAnalyticsPrices` response wrapper
untouched; the executive route keeps `resolveExecutiveScope` and
`orderConditions`. The new modules are pure arithmetic over rows the caller has
already been authorized to read — they take no session, resolve no scope, and
must never be handed an unfenced branch id. Tests cover 401 / 403 / cross-tenant
for both routes to prove the refactor did not disturb the fence.

## Tests

**Unit** — `lib/budget-consumption.test.ts`: status classification for every
status in `DerivedOrderStatusKey` including `CANCELLED` and `REFUNDED`; refund
netting including a refund exceeding the total (clamp at 0) and a null refund;
`budgetPeriodOf` across a UTC month boundary and across a Karachi/UTC
disagreement (00:00–05:00 Karachi on the 1st); `isSameBudgetPeriod` across a
year boundary.

**Contract** — `lib/server/budget-consumption-contract.test.ts`: no file outside
the shared module inlines the status CASE expression or an ad-hoc
`toISOString().slice(0, 7)` budget period; the consumer list is the control, in
the manner of `lib/pricing-access.test.ts`.

**Integration** — `tests/integration/budget-ledger-orders-parity.test.ts`:
drive real orders through create → approve → fulfil → partial refund → full
refund → reject, then assert for each branch/period that the ledger totals equal
the order-derived totals, and that both routes report the same consumption for
the same window. Plus 401/403/cross-tenant on both endpoints.

## Risk and rollback

The read-path change alters reported figures only where the session time zone is
not UTC, correcting them toward the ledger. The refund change alters which row
is debited only for a refund crossing a UTC month boundary — today that write
lands on a row the order never touched. No schema change, no migration, no
backfill; rollback is a revert.

Pre-existing ledger/orders divergence in historical data (KE imports backfilled
by `backfill-ke-budget-spend.ts`) is **not** repaired by this change. It makes
the rules agree from here on; it does not rewrite history. Reconciling the KE
backfill is separate work.

## Addendum — the K-Electric historical ledger

**Assessed, and deliberately not repaired.**

K-Electric's ledger is keyed on the **Asia/Karachi** month at every point:
allocations from legacy's own `BudgetTenureFrom` (`lib/legacy-import/ke-budgets.ts`),
the historical allocation import (`scripts/import-ke-branch-budgets.ts`,
`currentKarachiPeriod`), and the spend backfill
(`scripts/backfill-ke-budget-spend.ts`, which groups on
`created_at at time zone 'Asia/Karachi'`). The engine — and therefore every
reader that now goes through `lib/budget-consumption.ts` — is keyed on the UTC
month. The two name different months for an order raised between 19:00 and
23:59:59 UTC on the last day of a UTC month.

This change did **not** introduce that gap and did not move any K-Electric
figure. The previous SQL was a bare `TO_CHAR` on a `timestamptz`, which renders
in the Postgres session's zone; that session is `Etc/UTC` and the application
sets none, so the readers were already bucketing by UTC. Making it explicit
removed a dependency on server configuration — it did not change the answer.
Confirm `show timezone` on the production database before relying on that.

Re-bucketing the K-Electric history to UTC would be the wrong repair:

1. Those allocations came from legacy's Karachi tenure and were reconciled to
   the rupee against legacy's remaining figure. Moving spend between months
   breaks a reconciliation that matches the customer's own system.
2. K-Electric operates in Pakistan. Their September *is* the Karachi September,
   so a UTC re-bucketing makes the figures less true to the tenant, not more.
3. A move can violate `budgets_values_valid_ck` wherever the receiving month has
   less headroom than the money arriving.
4. The orders are historical. No engine action will touch these rows again, so
   nothing compounds.

`npm run audit:ke-budget-periods` (`scripts/audit-ke-budget-period-parity.ts`)
measures the exposure: it counts and prices every order whose two months
disagree, per branch-month, and says for each whether a move would break the
check constraint. It is **read-only and has no `--commit`**, because the
conclusion above is that there is nothing to commit.

If the gap is ever to be closed, the defensible direction is the other one —
teach the backfill and the allocation import to use `budgetPeriodOf`, then
rebuild K-Electric's ledger from the orders in one reconciled pass, re-validated
against legacy. That is its own piece of work with its own rollback plan, not a
patch to this one.
