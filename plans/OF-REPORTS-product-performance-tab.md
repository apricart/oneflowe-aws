# OF-REPORTS — the Product Performance tab

## Requirement

> Product Performance page — dedicated page for product / month / user / item /
> branch compare. Amount or quantity; graph + table.

The "Compare Side by Side" tab of Graphical Reports already answers most of
it: product, requester, branch and month panels, an Amount ⇄ Quantity toggle
shared by every panel, and a chart in every panel. Three things were short.

## Gaps and decisions

### 1. Ranked panels had no table

`ChartCard` shows its table toggle only when handed a `table`, and
`ComparePanel` handed one only for `mode === "series"`. So the three line
panels could flip to rows and the four ranked panels — the ones that answer
the requirement's "compare" — could not. The Excel download and the
order-line drill-down are adjacent but neither is "the compared figures, as a
table, on screen".

`ComparisonTable` in `comparison-charts.tsx` already renders exactly that table
(entity, value, share, vs prior, orders) for the Explore workbench's `table`
chart type. It is exported with its own narrow prop type and handed to every
rank-mode panel. Its first cell is the keyboard path to the same drill-down the
bars give a mouse, which is why it is preferred over a plain read-only grid.

### 2. The tab was not a destination

Tab state was `useState`, so there was no URL for the screen, nothing to put in
the sidebar, and every visit opened on Executive Overview. The tab now comes
from `?tab=` and is written back with `window.history.replaceState`, which Next
integrates with `useSearchParams` (verified in
`node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md`).
`router.replace` was rejected: it is a soft navigation with a round trip, and a
tab click should be instant. The page is wrapped in `Suspense` as
`app/(portal)/orders/page.tsx` is, so a prerender does not bail the whole tree
to the client.

The URL is the single source of truth. A sidebar link to
`/reports/graphical?tab=product-performance` while already on the page
changes only the search params, and a local mirror would not have followed it.

Sidebar: "Product Performance" is added under Reports for the three roles that
have Graphical Reports. `proxy.ts` matches on pathname, so nothing changes
there. The sidebar highlights sub-items by exact pathname, so this entry does
not highlight itself; "Graphical Reports" does, and the page's own tab strip
shows the tab — coherent, and preferred over reading search params in the
shell (a `useSearchParams` in the layout would bail every static page).

**Naming clash to resolve with the client:** `/reports/product-performance`
already exists and is labelled "Product Report" in the sidebar. The new entry
carries the client's name for *this* screen; the two now sit next to each
other under Reports.

The tab id changes from `side-by-side` to `product-performance` because it is
now user-facing in the URL. File and component names (`side-by-side-workspace`)
are unchanged; the export filename and cover row follow the new name.

### 3. "Item"

The requirement lists product and item separately. There is no item or SKU
dimension in the registry; the product panel's own comment calls itself
"item-wise". The nearest distinct angle the registry can already answer is
**category**, so a "By category" ranked panel is added — a registry entry only,
served by the existing `/compare` endpoint and the existing drill-down. It is
hidden for a single focused product for the same reason the product panels
are (one bar restating the subject). If the client confirms item means
product, the entry is removed; if it means SKU, that is a new dimension and a
new plan.

## Files

- `lib/executive-analytics.ts` — `by-category` panel.
- `components/reports/executive/comparison-charts.tsx` — export `ComparisonTable`.
- `components/reports/executive/side-by-side-workspace.tsx` — table for rank panels; copy names categories.
- `app/(portal)/reports/graphical/page.tsx` — tab from `?tab=`, label rename, Suspense.
- `components/shell/sidebar.tsx` — "Product Performance" entry ×3.
- `lib/executive-side-by-side-export.ts` — cover row and filename.
- Tests beside each.

## Security

No new endpoint, no new query, no change to scope or role checks. The
category panel and the rank table call the same `/compare` and `/drill-down`
routes with a dimension the registry already accepts under the same fence.
`?tab=` is validated against the tab list and never reaches the server.
