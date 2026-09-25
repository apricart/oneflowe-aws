# OF-REPORTS — "By product" as the requester × product grid; the standing grid panel removed

Supersedes the decision in `OF-REPORTS-product-panel-by-requester.md` and
retires the panel introduced by `OF-REPORTS-user-product-matrix.md` §UI.

## Requirement

> Remove the "Requester × product" graph. When products are selected together
> with requesters, "By product" should show the comparison the way
> "Requester × product" currently shows it.

## Decision: grouped columns, one panel

Before this change the Product Performance tab drew the same `/matrix` answer
twice once two or more requesters were compared: "By product" as **stacked**
columns (each product's total, split into the people's shares) and
"Requester × product" as **grouped** columns (one column per person inside
each product's cluster). The client wants the grouped reading and only one
panel, so:

- The `requester-by-product` registry entry is **removed**, and with it the
  `matrix` field on `SideBySidePanel` — no panel is a standing grid any more.
- `by-product` keeps `segmentBy: "user"`. Below `SEGMENT_MIN_COMPARED` (2) it
  is the plain ranking from `/compare`; from two people up it is served by
  `/matrix` (rows = requester, columns = product) and drawn **grouped**: one
  cluster per product, one column per compared person, never combined. This
  is exactly the form the removed panel drew.
- Its table and its Excel sheet are the grid **as drawn** — one row per
  person, one column per product, the person's total last, the products'
  totals along the bottom — which is what the removed panel's table and sheet
  were. `transposeMatrix()` and the table's `seriesAxis` switch go with the
  stacked form.
- The stacked-only code is deleted rather than left switchable: the `stacked`
  prop on `MatrixChart`, the `other` remainder segment and its label, the
  total label above the stack, and the two-branch footnote. What remains is
  the grouped path that already existed.

Trade-off, stated: the grouped form does not show a product's total as a
column height. The total is still in the tooltip ("All requesters"), in the
table's bottom margin and in the sheet. The plain "By product" ranking (no
people compared) is unchanged and still shows totals.

## What does not change

- No endpoint, query, parameter or scope path. `/matrix` is called with the
  same arguments the removed panel sent, under the same
  `resolveExecutiveScope` fence; the integration suite's matrix cases
  (`tests/integration/executive-analytics-api.test.ts`) are untouched.
- Drill-down from a column or a cell is the same `cellDrillTarget`: the person
  as the key, the product as a narrowing.
- The single-product layout (`hiddenForSingleProduct`) is unchanged.

## Files

- `lib/executive-analytics.ts` — `requester-by-product` and `matrix?` removed; `segmentBy` doc.
- `components/reports/executive/matrix-chart.tsx` — grouped path only.
- `components/reports/executive/side-by-side-workspace.tsx` — `MatrixPanel` loses `stacked`; the panel loop asks `panelSegmentation` alone.
- Tests beside each, and `lib/executive-side-by-side-export.test.ts` (grid sheet cases now on `by-product`).

## Security

None: read-only screen, no new request shape, same fence, same drill-down.
