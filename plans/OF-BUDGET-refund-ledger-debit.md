# OF-BUDGET — A refund moves the money ledger by one rule

Status: implemented 2026-10-08. Builds on `plans/OF-BUDGET-ledger-orders-parity.md`
(R3, "How a refund lands") and `plans/OF-REFUND-seven-day-requester-window.md`.

## Problem

Found by an offline smoke test of the order flow on the local dev database.
After a Super Admin approved a 1,250 refund on a fulfilled order, every budget
screen agreed (branch remaining 45,650, organization 74,400) except the budget
analytics summary with a date filter, which said **75,650** — the refund
counted twice.

The two Super Admin refund routes wrote the ledger differently:

| Route | Fulfilled order | Unfulfilled order |
|---|---|---|
| `POST /api/v1/orders/[id]/refunds` (`createApprovedRefund`) | `spent -= refund`, floored at 0 | `held -= refund`, floored at 0 |
| `POST /api/v1/admin/refunds` (approval / direct) | `credited += refund` | `credited += refund` |

Every order-side reader nets refunds out of consumption
(`orderConsumptionCents`, `max(0, total − refund)`), which is the parity plan's
model of a refund: R3 assumed the period row is *debited*. The admin route —
the one every refund on the dev database went through (17 of 17
`REFUND_PROCESSED`, 0 `REFUND_APPROVED`) — credited instead, so after any
refund the ledger said the branch consumed the refunded money while the orders
said it did not. `GET /api/v1/analytics/budgets/summary` in orders mode takes
spend from the orders and credit from the ledger, and so counted the refund on
both sides.

Two further defects in the order route:

1. Debiting `held` for an unfulfilled order breaks its later fulfilment:
   `moveBudgetHeldToSpent` moves the order's **full** total and refuses
   (`BUDGET_LEDGER_INVARIANT`) when the hold is short — or, when other orders'
   holds cover it, silently eats theirs.
2. The `GREATEST(0, …)` floor loses money: a row holding less spend than the
   refund (a repaired or imported row) gave the branch back less than the
   refund.

## Rule

`planRefundLedgerMove` in `lib/budget-consumption.ts`, applied by both routes
to the order's own period row, read `FOR UPDATE`:

- **Spent order** (`classifyOrderConsumption` = `spent`): withdraw the refund
  from `spent`, at most what the row has spent; credit any remainder.
- **Anything else** (pending/approved): credit the refund and leave the hold
  whole — every later mover (fulfil, reject, cancel) moves the full total.

In every case the branch's remaining (`allocated + credited − spent − held`)
rises by exactly the refund, as before. Only the split changes, and only for
refunds approved from now on.

Visible effects: on the Budgets page a refund of a fulfilled order now lowers
*spent* instead of raising *credited*; a "reset add-ons" no longer wipes refund
money (it was in `credited`); add-on expiry is unaffected (it withdraws
`min(add-on, remaining)`, and remaining is the same either way).

## Not in scope

- **Rows already credited.** Refunds approved before this change stay as
  credits, so the date-filtered summary still overstates those months. A repair
  would move each `REFUND_PROCESSED` credit to a spent debit on its order's
  period; it must be a dry-run, digest-gated script with a rollback report
  (rule 06) and is left for a follow-up.
- **Refunds taken before fulfilment** still land as credits, so the
  date-filtered summary counts those twice until the order-side netting and the
  hold movers agree on refunded amounts.
- K-Electric scripts that write `amount_credited_cents` for legacy refunds are
  untouched: their ledger is reconciled to legacy's remaining figure, which this
  change does not alter.

## Tests

- `lib/budget-consumption.test.ts` — the rule: buckets, the cap, the remainder,
  normalisation, and "remaining rises by exactly the refund".
- `lib/server/budget-consumption-contract.test.ts` — both routes plan with
  `planRefundLedgerMove`, lock the row first, and neither floors nor credits on
  its own.
- `tests/integration/refund-ledger-move.test.ts` — both routes against
  Postgres, the date-filtered summary agreeing with the ledger, fulfilment
  after a pre-fulfilment refund, and the short-row cap. Four of its six cases
  fail on the previous code.
- `tests/integration/refund-window-api.test.ts` — the cross-month approvals now
  assert the debit on the order's month.
