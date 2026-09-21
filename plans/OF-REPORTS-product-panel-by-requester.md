# OF-REPORTS — "By product" split by requester

> **Superseded (2026-09-21)** by `OF-REPORTS-product-panel-grouped-by-requester.md`:
> the split panel is now drawn grouped, not stacked, and the standing
> "Requester × product" panel it deferred to has been removed.

## Requirement

> If multiple products are selected and multiple requesters are selected, the
> product graph should show segregation by user too, so we know which user
> consumed which product and how much — in the same bar with different colours.

## Decision: stacked columns, from the grid that already exists

The "By product" panel answers *which products consumed the most*, so the
height of each column must stay the product's total. A **stacked column**
keeps that and splits the column into one segment per compared requester, in
the colour that requester already carries on "By requester". Grouped columns
were rejected for this panel: they are the right form for comparing people
*within* a product but lose the total, and "Requester × product" already draws
them further down the same screen, with its grid table. The two panels keep
their jobs: totals with composition here, pairs side by side there.

The figures come from the **`/matrix` endpoint the screen already calls**
(rows = requester, columns = product, the same `userIds` / `productIds`
filters and the same cap of 12). Its column margins are computed by the same
`loadComparison` the plain "By product" panel uses, so a product's total is
the same number whether or not it is split. The request URL is identical to
the "Requester × product" panel's, so SWR answers both panels from one call.
There is no new endpoint, no new query and no new parameter.

### When it applies

Only while **two or more requesters are ticked** to compare. With none ticked
the panel ranks products across everyone in scope and a split by the top
twelve people would be noise; with one ticked the split is a single segment.
The rule lives in the registry as `segmentBy: "user"` on the `by-product`
panel and `panelSegmentation()`, so the same switch can be turned on for
another panel (branch, category) in one line if asked.

### The capped axis

The grid holds at most twelve requesters. If more are ticked, the segments
would not reach the product's total. The remainder is drawn as one neutral
**"Other requesters"** segment (no drill-down, named in the legend and the
footnote), so the column still reads to the true total and the reader is told
who is folded.

### Table and download

The stacked panel's table and its Excel sheet are the **grid transposed** —
one row per product, one column per requester, the product's total last — so
they read the same way as the chart. `transposeMatrix()` is pure; drilling a
transposed cell names the product as the key and the requester as the
narrowing, which `cellDrillTarget` already supports.

## Files

- `lib/executive-analytics.ts` — `segmentBy` on `SideBySidePanel`, `panelSegmentation()`, `by-product` opts in.
- `components/reports/executive/matrix-chart.tsx` — `transposeMatrix()`, `stackedColumnData()`, `MatrixChart` gains `stacked`.
- `components/reports/executive/side-by-side-workspace.tsx` — `MatrixPanel` gains `stacked`; a segmented panel renders through it.
- Tests beside each; the export needs no change (a transposed grid is still a grid sheet).

## Security

No new endpoint, query, parameter or scope path. The segmented panel calls
`/matrix` with exactly the arguments the existing grid panel sends, under the
same `resolveExecutiveScope` fence, and drills through the existing
`/drill-down` with a dimension and narrowing it already accepts.
