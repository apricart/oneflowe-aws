# OF-BUDGET — Open the current month on the Budgets list

## Problem

On 2026-10-03, 118 K-Electric branches showed a zero October budget, against 23
in September. Read-only investigation of production:

| Group | Branches |
|---|---|
| September allocation > 0, baseline = September allocation, **no October row yet** | 98 |
| No September allocation and no baseline (4 of them had add-ons only) | 20 |
| HSEQ (179) — deliberately left at 0 by the 2026-10-02 repair | 1 |

The 98 had lost nothing. A month's `budgets` row is never written on a
schedule: it is opened at `branches.baseline_budget_cents` by the first thing
that needs it — an order's budget pre-flight (`getOrCreateCurrentBudget`,
`getOrCreateBranchBudget`), the shop's own budget read
(`loadSingleBranchBudget`), an allocation (`writeMoneyBudgetAllocation`), or the
`?period=` list (`syncCurrentMoneyBudgets`). The Budgets page sends none of
those: it calls `GET /api/v1/budgets?all=true&preset=…`, which goes to
`loadAggregatedMoneyBudgets`, sums the rows that exist and counts a missing row
as 0. Head Office therefore saw Rs 0 for every branch nobody had yet ordered
for, and so did the Budget Report and every other ledger reader.

## Change

1. **Code** — the aggregated loader opens the engine's current month for the
   branches it is about to list, before it settles add-ons and reads the
   ledger.
   - `lib/budget-period-opening.ts` (pure): `openableBudgetPeriod(now, periods)`
     — `budgetPeriodOf(now)` when the read covers it, else nothing;
     `budgetRowsToOpen(...)` — one row per branch with no row and a positive
     baseline, at that baseline, 0 spent/held/credited.
   - `lib/server/budget-period-opening.ts`: `openCurrentBudgetPeriodRows(client, …)`
     re-reads the candidates from the database (active, budget-enabled tenant,
     baseline > 0, no row) and inserts with `ON CONFLICT DO NOTHING`.
   - `app/api/v1/budgets/route.ts`: one call in `loadAggregatedMoneyBudgets`.
2. **Data** — a one-off, digest-gated script opened October for the 98
   K-Electric branches at their baseline (see "Production data" below).

## Decisions

- **Open, not display a fallback.** Writing the row fixes every reader at once
  (Budget Report, executive analytics, exports), not just this page, and the
  row is exactly the one the next order would write.
- **Only the engine's UTC month.** Never a past month (a missing row there is a
  month without a budget), and never the Karachi month while it is ahead of the
  engine (00:00–05:00 Karachi on the 1st). A monthly allocation in those hours
  writes the engine's month *and* the baseline; a next-month row opened early
  would keep the superseded baseline. Cost: for those five hours the page still
  shows 0 for unopened next-month rows, as it does today.
- **Only a positive baseline.** Same rule as the order path. A row at 0 shows the
  same figure and would only add writes across every tenant.
- **No stale-zero reset.** `syncCurrentMoneyBudgets` also raises an existing
  0-allocation row to the baseline; that rule is not extended here. This change
  never updates an existing row.
- **No audit row** for an opening, as the order path writes none: the figure is
  the branch's existing baseline, not a decision. The one-off script, which is a
  manual intervention, does audit (`OPEN_BUDGET_PERIOD`).

## Security

- Who can trigger it: only callers that already reach the aggregated list —
  `canManageMoneyBudgets` (`SUPER_ADMIN`, `HEAD_OFFICE`, `GROUP_USER` with
  budget allocation enabled on the account). Every other role falls through to
  the single-branch read, unchanged.
- Which branches: the `branchIds` handed to the writer are the rows returned by
  `buildBudgetBranchScope` — the tenant predicate from the session for Head
  Office, the resolved assignment set for the approver (an empty set is a 403
  before this point), active branches, budget-enabled tenants. The writer
  re-asserts active / budget-enabled / baseline > 0 from the database.
- No request value reaches the write except as a narrowing of that set. The
  period is computed on the server.
- Concurrency: the `(branch_id, period)` unique index; an order or a second
  viewer that opens the row first wins and is not touched.

## Tests

- `lib/budget-period-opening.test.ts` — period boundaries (UTC vs Karachi on the
  1st), baselines 0/null/negative/fractional/unsafe, existing rows, duplicates,
  missing tenant.
- `lib/server/budget-period-opening.test.ts` — contract: opened inside the
  aggregated loader, on the fenced list, before the settle and the read; the
  writer re-asserts the rule and never updates.
- `tests/integration/budget-period-opening.test.ts` — Head Office opens its own
  tenant only; existing, last-month, zero-baseline and inactive rows untouched;
  idempotent and concurrent loads open once; past-month views open nothing;
  naming another tenant's organization or branch opens nothing there; a
  budgets-off tenant is never opened, even by Super Admin; the approver opens
  only its assignments, and is refused outside them; 401; Branch Admin and
  Order Portal open nothing beyond their own branch. Six of the cases fail with
  the route change removed.
- Added the writer to `LEDGER_PERIOD_WRITERS` and `BUDGET_ENABLED_READERS`.

## Production data (2026-10-04)

Scratchpad script `ke-open-october-budget-rows.mts` (org 10, period 2026-10;
dry-run default, `--commit --digest`, `--verify`, `--rollback --digest`). Dry
run: 98 rows, Rs 5,982,549, every baseline equal to the September allocation,
digest `c6303022d8df`. Commit report:
`updatedReports/ke-open-october-budget-rows-commit.json` (gitignored).

## Risk and rollback

- Code: revert the one call in the route; rows already opened are what an order
  would have opened and need no cleanup.
- Data: `--rollback` deletes only the rows the commit created that are still
  untouched (same allocation, nothing spent/held/credited, no add-on).
- KE `sync:ke --budgets=legacy` now finds the current row already open at the
  baseline rather than creating it; raising is unchanged, lowering still needs
  `--lower-budgets`, as for any row an order had opened.
