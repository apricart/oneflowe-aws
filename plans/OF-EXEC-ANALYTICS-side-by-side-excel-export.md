# OF-EXEC-ANALYTICS — Excel download for the Compare Side by Side tab

## Why

The tab puts five or six comparisons on one screen — product, requester,
branch, month, two trends and (with one product in focus) the day-by-day view —
under one set of filters. A reader who wants to take those figures into a
meeting, or hand them to someone without a login, has nothing to take: every
other report page has an Excel export and this one does not.

## What this adds

One **Download Excel** button in the tab's control row. It writes a workbook
holding exactly what is on screen — the same rows, under the same filters, at
the same measure — one sheet per panel, plus a first sheet that names the
filters in effect so the file is readable on its own.

### No new endpoint, no new authorization surface

The workbook is built **from the responses the panels already hold**. Each
`ComparePanel` reports its latest `/compare` response up to the workspace; the
button turns those into sheets client-side with the `xlsx` package every other
export already uses. Nothing is re-fetched, nothing is fetched wider than the
screen, and the server's scope decisions travel into the file unchanged — a
Head Office user's workbook cannot contain a row their screen could not.

### Layout

* `lib/executive-side-by-side-export.ts` — pure. `buildSideBySideWorkbookData`
  turns `(panels, snapshots, context)` into `{ name, columns, rows }` sheets;
  `excelSheetName` and `getSideBySideExportFilename` beside it. Money is
  written in PKR as a number (cents ÷ 100), never a formatted string, so Excel
  can total a column; percentages as numbers; the metric's unit in the header.
* `components/reports/executive/side-by-side-export-button.tsx` — the thin
  client half: dynamic `import("xlsx")`, `aoa_to_sheet`, `writeFile`. Rows go
  through `sanitizeSpreadsheetRow` so a product or person named `=…` cannot
  become a formula.
* `components/reports/executive/side-by-side-workspace.tsx` — collects panel
  snapshots, resolves the filter ids to names (from the lists the filter
  controls already loaded, so no extra request), renders the button.

### Sheets

| Sheet | Columns |
|---|---|
| Report | Field / Value: subject, measure, formula, period, organizations, branches, categories, unit, products in focus, requesters compared, exported at; then an index of the panel sheets |
| Ranked panel (bar/column) | Rank, `<Dimension>`, `<Metric (unit)>`, Share %, Cumulative share %, Previous period, Change %, Orders — the "previous"/"change" pair is omitted on the month panel, where the server sends none |
| Trend panel (line) | `<Dimension>`, one column per period, Total |
| Blocked / empty / failed panel | a single Note row carrying the message the screen shows, so the reader knows the panel was on screen and why it has no figures |

### Tests

* `lib/executive-side-by-side-export.test.ts` — currency to PKR, share and
  change columns, month panel without prior columns, series periods aligned by
  period (not by index), a blocked panel becomes a note, filters named or
  "All", sheet names sanitised and unique within 31 characters, filename.
* `components/reports/executive/side-by-side-workspace.test.tsx` — the button
  is disabled until every panel has answered, and a click writes one sheet per
  panel on screen, under the current focus, with `xlsx` mocked.

## Security

No new endpoint; no change to scope, RBAC or price visibility. The export
contains only data already delivered to this browser for this screen. Formula
injection is neutralised by the existing `lib/spreadsheet.ts` helper. Filenames
are built from ISO dates and a fixed slug, never from user input.

## Database

None.

## Risk and rollback

UI-only; removing the button and the snapshot callback restores the previous
screen exactly. The panels' own rendering path is untouched.
