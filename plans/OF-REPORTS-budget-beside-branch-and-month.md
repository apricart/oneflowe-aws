# OF-REPORTS — Total Budget beside "By branch" and "By month"

## Requirement

> In the By branch and By month graphs I also want the same bar comparison,
> but with budget accordingly.

On the Product Performance tab, each branch's Procurement Value column and
each month's Procurement Value column get a **Total Budget** column beside it
— the grouped form the Overview's "Budget vs Consumed by Branch" already draws.

## Decisions

1. **The consumption bar stays Procurement Value.** It is the panel's own
   figure (revenue-eligible orders, net of refunds); the ask was "the same
   bar". It excludes PENDING orders, whereas the Overview's *Consumed* counts
   them as committed. So the tooltip's ratio is labelled **"% of budget"**
   under a Procurement Value heading, never "Utilization", and the footnote
   says why it reads lower than the Overview's figure.
2. **Budget is withheld — never approximated — under any narrowing it cannot
   follow.** A budget is money held per branch per month and nothing else. It
   is not shown when the measure is Quantity, or when products, categories or
   requesters are in focus. The rule is one pure function,
   `budgetBesideWithheldReason` in `lib/executive-analytics.ts`, used by the
   panel (to decide whether to ask, and what footnote to print) and by the
   server (to decide whether to attach), so neither side can show a budget the
   other would not.
3. **By month fills every month in the window.** A budgeted month nobody
   ordered in is exactly what the chart should show; today the month rows come
   from orders alone, so it would be missing. Filled rows are zero-valued and
   the axis stays chronological and capped at `MAX_TIME_AXIS_POINTS.month`.
   **By branch keeps its ranking** — top N by spend — with the budget attached
   to those rows; the Overview already lists every budgeted branch.
4. **Opt-in on the wire.** `/compare` gains an allowlisted boolean `budget=1`.
   The Explore workbench and every other caller send nothing and get the
   response they get today; the field is additive when present
   (`totalBudgetCents` on each row, `budgetBeside: true` at the top).

## Architecture

### Server

- `lib/executive-analytics.ts` — `BUDGET_BESIDE_DIMENSIONS` (branch, group,
  organization, month), `budgetBesideWithheldReason()`, `canShowBudgetBeside()`;
  `SideBySidePanel.budgetBeside?: boolean`, set on `by-branch` and `by-month`.
- `lib/executive-analytics-request.ts` — `withBudget: boolean` on
  `ParsedComparisonRequest`, read as `budget === "1"`.
- `lib/server/executive-analytics-queries.ts` — `attachBudgetBeside()`:
  branch/group/organization reuse `loadBudgetRollup` (the per-branch ledger
  rows the Overview is built from, so the figures reconcile by construction);
  month uses a new `loadMonthBudgets()` — one grouped read on `budgets`
  joined to `branches` and fenced exactly as `loadBranchBudgets` is, keyed by
  `period`, which is the same `YYYY-MM` string the month comparison keys its
  rows with. The branch fence is factored into `scopedBranchFence()` and shared
  by the three readers rather than repeated.
- `app/api/v1/analytics/executive/compare/route.ts` — after the ranked read,
  `if (parsed.withBudget && canShowBudgetBeside(...)) rows = await attachBudgetBeside(...)`;
  the rank response carries `budgetBeside`.

### Client

- `ComparePanel` asks for `budget=1` only when the registry flags the panel
  and `budgetBesideWithheldReason` is null for the current measure and
  filters; otherwise it prints that reason under the chart.
- `ColumnChart` draws `<Bar dataKey="totalBudgetCents">` in the track colour
  before the value column, as the Overview does; legend gains "Total budget";
  the tooltip gains Total budget and % of budget. `EntityTooltip` branches on
  the explicit `budgetBeside` prop *first*, because it already treats
  `totalBudgetCents` on a row as "this row is a budget position" (Consumed /
  Remaining) for the budget metrics, and a companion budget on a spend row
  must not trip that.
- `ComparisonTable` and the Excel rank sheet gain "Total Budget" and
  "% of budget" columns when the response carries the budget.

## Security

- No new route, no new scope path. `attachBudgetBeside` reads the ledger under
  the same branch fence as `loadBranchBudgets`; a caller cannot name a branch,
  group or organization the fence does not already admit, so it cannot see a
  budget outside its reach.
- `budget` is a boolean allowlist match, never interpolated.
- Read-only; no audit row. Prices are unaffected.

## Tests

- Unit: the withheld-reason rule; the registry flag; `budget=1` parsing; the
  column legend/tooltip/table with and without the budget; the rank sheet.
- Workspace: the two panels ask for `budget=1` under Amount with no focus,
  and stop asking (and footnote why) under Quantity, a product focus, or a
  requester comparison.
- Integration (`tests/integration/executive-analytics-api.test.ts`): budgets
  attached per branch and per month against hand-worked figures; an empty
  budgeted month is filled; absent without the flag, under focus, and under
  Quantity; the neighbour's and an unassigned branch's budgets never appear.
