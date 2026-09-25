# OF-REPORTS — Requester × Product, and the Budget vs Consumed columns

> **Note (2026-09-21)**: the standing "Requester × product" panel described
> under *UI* was removed by `OF-REPORTS-product-panel-grouped-by-requester.md`;
> "By product" draws the same grid once two or more requesters are compared.
> The `/matrix` route, chart, table, drill-down and export are unchanged.

## Where the five asks stand

The client's five asks were reviewed against `main` on 2026-09-16. Two of
them, and the defect found during that review, are already answered by the
uncommitted work described in `OF-REPORTS-executive-group-filter.md` and
`OF-REPORTS-product-performance-tab.md`:

| # | Ask | State |
|---|---|---|
| 1 | Group filter on the Budget Report | Done — table, chart and summary cards all send `groupIds`. |
| 2 | Group filter on Graphical Reports | Done — `groupIds` is resolved into the branch fence in `resolveExecutiveScope`, so budgets, pickers and orders agree; the filter row has a Groups control. |
| — | `loadBranchBudgets` ignored `groupIds` (out-of-group branches drawn with full budget and zero spend) | Fixed by the same change: every builder reads `scope.branchIds`. |
| 3 | Budget chart as standing columns | **This plan.** |
| 4 | Total Budget vs Consumed as two bars | **This plan.** |
| 5 | Several requesters, each product separately — never combined | **This plan. The main build.** |

## Objective

1. The Overview's "Budget vs Consumed by Branch" draws **upright columns**, two
   per branch — Total Budget beside Consumed — and nothing stacked.
2. The Product Performance tab gains a **Requester × product** panel: one
   figure per (requester, product) pair, as grouped columns and as a grid, with
   the pair's order lines one click away, and its own sheet in the download.

## Acceptance criteria

- On the Overview, each branch shows exactly two columns, Total Budget and
  Consumed (spent + committed); Spent and Committed remain in the tooltip and
  the table. A long branch list scrolls sideways rather than crushing labels.
- On Product Performance, with two requesters and three products chosen, the
  new panel shows six figures — Ahmed/Paper, Ahmed/Toner, Ahmed/Diesel,
  Sana/Paper … — never "Ahmed across the three".
- With nothing chosen it shows the top requesters against the top products in
  scope, bounded.
- Amount ⇄ Quantity applies to it like every other panel; a quantity across
  mixed units is refused with the same message the other panels show.
- Selecting a column or a grid cell opens the order lines for **that pair**,
  under the same filters and period, and the lines reconcile with the figure.
- The Excel download carries the grid as its own sheet.
- The panel is fenced exactly as the others: Head Office sees its tenant,
  a Group User its assignments, nobody sees the neighbour, and the other roles
  get 403 before a query runs.

## Architecture

### Why a new route rather than a third `mode` on `/compare`

`/compare` answers "one dimension, one value per entity" and its response is
consumed by three screens and the export. A pivot is a different shape —
rows × columns × cells — and folding it in would widen every consumer's type
and the chart-type menu for a mode two of them can never draw. It joins the
existing one-route-per-question layout instead:

```
GET /api/v1/analytics/executive/matrix
```

The route is thin: session → `resolveExecutiveScope` → `parseMatrixRequest`
→ unit resolution → `loadMatrix` → respond. No `keys` folding is needed: both
axes' selections travel as the ordinary `userIds` / `productIds` /
`categoryIds` / `branchIds` filters the panel already sends.

### Request (all optional except `rows`, `columns`, `metric`)

| Param | Rule |
|---|---|
| `rows`, `columns` | each in `MATRIX_DIMENSIONS = user, product, category, branch`; must differ |
| `metric` | in `MATRIX_METRICS = spend, orders, quantity, avgUnitPrice`; listed by both dimensions |
| `limit` | rows and columns each capped at `MATRIX_MAX_ENTITIES` (12); default 8 |
| the shared filters | `startDate`, `endDate`, `organizationIds`, `branchIds`, `groupIds`, `categoryIds`, `productIds`, `userIds`, `unit` — parsed by `parseExecutiveRequest` exactly as every other route |

Anything outside the allowlists is 400. A budget metric is never a matrix
metric: a budget is held per branch, not per requester or product.
`avgOrderValue` is excluded for the reason `metricsUnderLineFocus` gives.

### Response

```ts
{
  rowDimension, columnDimension, metric, format, label, formula, grain,
  period: { startDate, endDate },
  quantityUnit: { selected, conflict, available },
  rows:    [{ key, label, total }],   // ranked by the metric, top N
  columns: [{ key, label, total }],   // ranked by the metric, top M
  cells:   [{ row, column, value, spendCents, quantity, orderCount }],  // pairs with activity only
  limits:  { rows: N, columns: M },
  blocked?: { reason: "unit-conflict", message }
}
```

`total` per row and column is the entity's own ranked figure from
`loadComparison`, so the grid's margins are exactly the "By requester" and
"By product" panels' bars — every panel reconciles with every other by
construction. For `orders` the cells are distinct order counts per pair and do
**not** sum to the margin (one order holding two products is one order); the
UI names it as a count, never as a total.

### `loadMatrix` (in `lib/server/executive-analytics-queries.ts`)

1. Rank the row entities and the column entities with the existing
   `loadComparison`, each under the full filter set and its own limit.
2. Fold the surviving keys back into SQL predicates by dimension —
   `orders.createdByUserId`, `orderItems.globalProductId`,
   `categoryProductFilter`, `orders.branchId`. A key that is not an id (the
   `uncategorized` / `ungrouped` sentinels) is dropped from the grid rather
   than matched loosely.
3. One grouped read at the grain the pair forces: line grain whenever a
   product or category is on either axis or the metric is line grain or the
   request is line-scoped; order grain otherwise (user × branch, spend).
   Grouping is `rowColumn.group ∪ columnColumn.group` from the same
   `lineDimensionColumns` / `orderDimensionColumns` every other builder uses.
4. Cells are bounded to N × M by the predicates in step 2, so the query can
   never return more than 144 rows whatever the tenant's size.

Fencing: every one of the three reads goes through `lineConditions` /
`orderConditions`, which carry `tenantConditions(scope)`. The route never
receives a branch id it did not resolve itself.

### UI

- `SideBySidePanel` gains `matrix?: { rows: ExecutiveDimensionId }`; a panel
  with it is served by `/matrix` with `columns = panel.dimension`. New registry
  entry `requester-by-product` (columns: product, rows: user), hidden for a
  single focused product for the same reason the product panels are.
- `components/reports/executive/matrix-chart.tsx` — `MatrixChart` (Recharts
  `BarChart`, default upright layout, one `<Bar>` per row entity, categories
  = columns) and `MatrixTable` (rows × columns grid with the margins, every
  cell a button). Both pure presentation.
- `MatrixPanel` in `side-by-side-workspace.tsx`, beside `ComparePanel`,
  using the same `ChartCard`, full-width checkbox, snapshot reporting.
- `DrillTarget` gains `narrow?: Pick<ExecutiveFilterState, "productIds" | "userIds" | "categoryIds" | "branchIds">`.
  `DrillDownPanel` spreads it over the filters before `toQuery`, so a cell
  (Ahmed, Paper) asks `dimension=user&key=<ahmed>&productIds=<paper>` — the
  existing drill-down route serves the pair with no server change, and the
  paging signature includes it so a different cell starts on page one.
- `lib/executive-side-by-side-export.ts` — `SideBySidePanelResponse` becomes
  a union with a `mode: "matrix"` member; `matrixSheet` writes the grid with
  a Total column. `isPanelSnapshotReady` and the empty-panel note are unchanged.

### Overview chart

`BudgetVsActualChart` in `overview-charts.tsx`: default layout (upright),
`<Bar dataKey="totalBudgetCents">` and `<Bar dataKey="consumedCents">` with no
`stackId`, branch names on the X axis angled when crowded, inside an
`overflow-x-auto` wrapper whose inner width grows with the branch count so a
136-branch tenant scrolls instead of collapsing to slivers. Tooltip and table
keep Spent / Committed / Remaining / Utilization. Legend: two entries.
The registry entry `budget-vs-actual` already says `grouped-bar`.

## Security

- **Authentication / authorization**: identical to the sibling routes —
  `resolveExecutiveScope` returns 401 without a session and 403 for every role
  outside `EXECUTIVE_ANALYTICS_ROLES`; the branch fence is derived from the
  caller's own user row and its assignment rows. `organization` is not a
  matrix dimension, so no role-specific dimension exists on this route.
- **Tenant isolation**: all three reads carry `tenantConditions(scope)`; the
  ranked keys folded into step 2 came from a fenced query, so they cannot name
  anything outside it. A foreign `userIds` / `productIds` matches nothing.
- **Input validation**: dimensions and metric are allowlisted and select
  pre-written builders — nothing from the request reaches SQL as text; id
  lists are bounded by `parseIdList` / `parseUuidList`; `limit` is clamped.
- **Bounding**: at most 12 × 12 cells; the panel asks for 12 × 12.
- **Rate limiting**: `withRateLimit`, as `drill-down` does (the only executive
  route that has it today; the aggregate routes rely on the session gate).
  The matrix runs three grouped reads per call, so it gets the limiter.
- **Response**: aggregates only; labels are the same expressions the pickers
  already return. Prices are readable by all three roles on every other
  executive route (see the note in `drill-down/route.ts`), unchanged here.
- **Audit**: read-only; none, consistent with the sibling routes.
- Contract tests: `security-boundaries.test.ts` does not list executive routes;
  nothing to add. The integration suite's `everyRoute` table gains `matrix`.

## Data

No schema, migration, index or backfill. The grouped read touches
`orders` / `order_items` under the same predicates the existing panels use.

## Tests

Unit (`npm test`):
- `lib/executive-analytics.test.ts` — `MATRIX_DIMENSIONS`, `MATRIX_METRICS`,
  `isSupportedMatrix` (same dimension refused, budget metric refused,
  organization refused, `avgOrderValue` refused), `clampMatrixLimit`, the
  new panel's registry entry and its single-product hiding.
- `lib/executive-analytics-request.test.ts` — `parseMatrixRequest`: happy
  path, each 400, limit clamping, filters carried through.
- `lib/server/executive-analytics-queries.test.ts` — contract: `loadMatrix`
  reads through `lineConditions` / `orderConditions` and never builds a
  predicate on an unjoined table.
- `lib/executive-side-by-side-export.test.ts` — the matrix sheet: header,
  margin column, empty and blocked notes.
- `components/reports/executive/matrix-chart.test.tsx` — the grid renders
  every pair, totals, zero cells as "—", cell click yields a narrowed target.
- `components/reports/executive/side-by-side-workspace.test.tsx` — the panel
  is requested from `/matrix` with `rows=user&columns=product` under the
  shared filters; hidden for a single focus; cell click opens the drill-down
  with `productIds` narrowed; the download gets its sheet.
- `components/reports/executive/drill-down-panel.test.tsx` — `narrow` reaches
  the URL and resets paging.
- `components/reports/executive/overview-charts.test.tsx` — two legend
  entries, Consumed in the table, scroll wrapper width.

Integration (`npm run test:integration`, `executive-analytics-api.test.ts`):
- `matrix` joins `everyRoute`: 401, 403 for the three excluded roles.
- Head Office, user × product, spend: the six-cell oracle below.
- Quantity with Paper in focus is blocked (Ream + Box); with `unit=Ream`,
  Ahmed 14 · Sana 7 · Group absent.
- The South approver sees Sana and Group against Paper, Diesel, Toner and
  nothing of North's; naming Ahmed matches nothing.
- The neighbour's Head Office sees only its own pair.
- Bad requests: same dimension, budget metric, unknown dimension → 400.
- The drill-down for (Ahmed, Paper) reconciles: 7000 over O1 and O3's Paper
  lines only.

Oracle, tenant A, Jun–Aug 2026, Procurement Value by (requester, product):

```
            Paper   Toner   Diesel   total
Ahmed        7000    6000       —    13000
Group        5000    3000    2000    10000
Sana         3500       —    5000     8500
total       15500    9000    7000
```

## Risks

- Overview chart at 136 branches: sideways scroll. Mitigated by the minimum
  per-branch width; verified with a large fixture in the component test.
- The matrix adds one route and three grouped reads per panel render; bounded
  by the limits and rate-limited.
- Blast radius on live tenants: read-only, no data change; the only existing
  behaviour that changes is the shape of one Overview chart.

## As built (divergences from the plan above)

- Cells are returned for every pair with at least one line, whatever its net
  value — "bought a refunded-to-nothing amount" is a fact the screen shows as
  0, distinct from the dash for "never bought".
- The grid sheet's corner header is `Requester / Product`, not a backslash,
  which template literals and the spreadsheet library both treat as an escape.
- `matrixAxisIds` keeps only ids whose canonical text equals the ranked key,
  so the SQL predicate can never pin an id the margins do not name.
- The "Full width" checkbox was lifted into `FullWidthToggle` so the grid
  panel and the ranking panels share one control rather than two copies.
- `MATRIX_MAX_ENTITIES` is 12 and the panel asks for 12 × 12; a filled axis
  is footnoted on the panel so twelve is never read as everyone.

## Rollback

Revert the commit. Nothing persisted changes.

## Steps

1. Registry: matrix dimensions/metrics/limits, `isSupportedMatrix`, panel entry. Tests.
2. Request parser: `parseMatrixRequest`. Tests.
3. Query builder: `loadMatrix`. Contract test.
4. Route: `app/api/v1/analytics/executive/matrix/route.ts`.
5. Integration tests for the route.
6. `DrillTarget.narrow`, `DrillDownPanel`. Tests.
7. `matrix-chart.tsx`, `MatrixPanel`, workspace wiring. Tests.
8. Export sheet. Tests.
9. Overview chart. Tests.
10. Gates: typecheck, lint, test, integration, build.
