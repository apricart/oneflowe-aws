import {
  EXECUTIVE_DIMENSIONS,
  MEASURE_LABEL,
  isTimeAxisDimension,
  utilizationPct,
  type ExecutiveDimensionId,
  type MeasureId,
  type SideBySidePanel,
} from "@/lib/executive-analytics"

/**
 * The Excel form of the Product Performance screen.
 *
 * This module is pure — no React, no `xlsx`, no network — so the shape of the
 * workbook can be unit-tested on its own and the client half is left with
 * nothing but "turn these arrays into sheets and save".
 *
 * The workbook is built from the responses the panels already hold, never from
 * a wider request of its own. That is what keeps it inside the server's scope
 * decisions: a row that is in the file was on the screen, under the same
 * filters, at the same measure.
 */

/** The subset of a `/compare` rank row the sheet reads. */
export type ExportRankRow = {
  key: string
  label: string
  value: number
  previousValue: number
  changePct: number | null
  orderCount: number
  share: number
  cumulativeShare: number
  /** Present on every row when the response carries the budget beside the figure. */
  totalBudgetCents?: number
}

/** The subset of a `/compare` series entity the sheet reads. */
export type ExportSeries = {
  key: string
  label: string
  points: Array<{ period: string; value: number }>
}

/** What a ranking or trend panel holds once `/compare` has answered. */
export type SideBySideComparisonResponse = {
  /** The entity represented by each row/series; may differ from the panel's time axis presentation. */
  dimension?: ExecutiveDimensionId
  rows: ExportRankRow[]
  series: ExportSeries[]
  periods: string[]
  format: string
  label: string
  formula: string
  mode: "rank" | "series"
  concentrationEligible: boolean
  /** True when every row carries `totalBudgetCents` beside its figure. */
  budgetBeside?: boolean
  quantityUnit: { selected: string | null }
  blocked?: { reason: string; message: string }
}

/** One entity on an axis of the grid, with the figure it was ranked by. */
export type ExportMatrixEntity = { key: string; label: string; total: number }

/** What the grid panel holds once `/matrix` has answered. */
export type SideBySideMatrixResponse = {
  mode: "matrix"
  rowLabel: string
  columnLabel: string
  rows: ExportMatrixEntity[]
  columns: ExportMatrixEntity[]
  cells: Array<{ row: string; column: string; value: number }>
  format: string
  label: string
  formula: string
  quantityUnit: { selected: string | null }
  blocked?: { reason: string; message: string }
}

/** What a panel holds once its endpoint has answered. */
export type SideBySidePanelResponse = SideBySideComparisonResponse | SideBySideMatrixResponse

/**
 * One panel's current state, as the screen reports it.
 *
 * `error` is the message the card shows in place of the chart; `response` is
 * null until the endpoint has answered.
 */
export type SideBySidePanelSnapshot = {
  response: SideBySidePanelResponse | null
  loading: boolean
  error: string | null
}

/** The filters in effect, already resolved to names for the reader. */
export type SideBySideExportContext = {
  /** "YYYY-MM-DD", as the filter bar holds them. */
  startDate: string
  endDate: string
  measure: MeasureId
  metricLabel: string
  metricFormula: string
  /** Empty means "all"; every list is names, not ids. */
  organizations: string[]
  groups: string[]
  branches: string[]
  categories: string[]
  products: string[]
  requesters: string[]
  unit: string | null
  exportedAt: Date
}

export type WorkbookSheet = {
  /** A valid, unique Excel sheet name — see `excelSheetName`. */
  name: string
  columns: string[]
  rows: unknown[][]
  /** Character widths per column, for `!cols`. */
  columnWidths: number[]
}

export const SUMMARY_SHEET_NAME = "Report"

/** The message written for a panel that was on screen with nothing to draw. */
export const EMPTY_PANEL_NOTE = "Nothing in the selected period under these filters."

/** Excel forbids these in a sheet name, and caps the length at 31. */
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\]/g
const SHEET_NAME_MAX = 31

/**
 * A sheet name Excel will accept, unique among `taken`.
 *
 * Case-insensitive uniqueness, because Excel treats "By Month" and "by month"
 * as the same sheet. A collision gets a numeric suffix that fits inside the
 * limit rather than overflowing it.
 */
export function excelSheetName(title: string, taken: Iterable<string> = []): string {
  const used = new Set(Array.from(taken, (name) => name.toLowerCase()))
  const base = title.replace(SHEET_NAME_FORBIDDEN, " ").replace(/\s+/g, " ").trim().slice(0, SHEET_NAME_MAX) || "Sheet"
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`
    const candidate = `${base.slice(0, SHEET_NAME_MAX - suffix.length).trimEnd()}${suffix}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}

/** Money is stored in cents; the sheet carries rupees so a column can be totalled. */
function cellValue(value: number, format: string): number {
  const number = Number(value) || 0
  if (format === "currency") return Math.round(number) / 100
  return Math.round(number * 100) / 100
}

/** The header for the figure column: the metric, and the unit it is measured in. */
export function metricColumnHeader(label: string, format: string, unit: string | null): string {
  if (format === "currency") return `${label} (PKR)`
  if (unit) return `${label} (${unit})`
  return label
}

function pct(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return Math.round(value * 100) / 100
}

/** The figure as a share of the budget beside it; blank, not 0, where there is no budget. */
function budgetSharePct(valueCents: number, totalBudgetCents: number | undefined): number | null {
  if (!totalBudgetCents || totalBudgetCents <= 0) return null
  return pct(utilizationPct(valueCents, totalBudgetCents))
}

const nameList = (names: string[]) => (names.length === 0 ? "All" : names.join(", "))

const formatExportedAt = (date: Date) => `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`

/** The one-row explanation a panel gets when it has no figures to give. */
function noteSheet(name: string, note: string): WorkbookSheet {
  return { name, columns: ["Note"], rows: [[note]], columnWidths: [90] }
}

function rankSheet(name: string, panel: SideBySidePanel, response: SideBySideComparisonResponse): WorkbookSheet {
  const dimensionLabel = EXECUTIVE_DIMENSIONS[panel.dimension].label
  const metricHeader = metricColumnHeader(response.label, response.format, response.quantityUnit.selected)
  // The server computes no prior window for a time axis: the months *are* the
  // axis, so "this month against the equivalent month before it" is nonsense.
  const withPrior = !isTimeAxisDimension(panel.dimension)
  const withShare = response.concentrationEligible
  // The budget beside the figure, as the panel drew it: the same two columns
  // its table shows, in rupees and as the figure's share of the budget.
  const withBudget = Boolean(response.budgetBeside)

  const columns = [
    "Rank",
    dimensionLabel,
    metricHeader,
    ...(withBudget ? ["Total Budget (PKR)", "% of budget"] : []),
    ...(withShare ? ["Share %", "Cumulative share %"] : []),
    ...(withPrior ? [`Previous period ${metricHeader}`, "Change %"] : []),
    "Orders",
  ]
  const widths = [6, 36, 22, ...(withBudget ? [20, 12] : []), ...(withShare ? [10, 18] : []), ...(withPrior ? [26, 10] : []), 8]

  const rows = response.rows.map((row, index) => [
    index + 1,
    row.label,
    cellValue(row.value, response.format),
    ...(withBudget ? [cellValue(row.totalBudgetCents ?? 0, "currency"), budgetSharePct(row.value, row.totalBudgetCents)] : []),
    ...(withShare ? [pct(row.share), pct(row.cumulativeShare)] : []),
    ...(withPrior ? [cellValue(row.previousValue, response.format), pct(row.changePct)] : []),
    Number(row.orderCount) || 0,
  ])

  return { name, columns, rows, columnWidths: widths }
}

function seriesSheet(name: string, panel: SideBySidePanel, response: SideBySideComparisonResponse): WorkbookSheet {
  const dimensionLabel = EXECUTIVE_DIMENSIONS[response.dimension ?? panel.dimension].label
  const metricHeader = metricColumnHeader(response.label, response.format, response.quantityUnit.selected)
  const periods = response.periods

  const rows = response.series.map((entity) => {
    // Looked up by period, not by index: a series with a gap must not have its
    // later points slide left into the wrong month.
    const byPeriod = new Map(entity.points.map((point) => [point.period, point.value]))
    const values = periods.map((period) => cellValue(byPeriod.get(period) ?? 0, response.format))
    const total = Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100
    return [entity.label, ...values, total]
  })

  return {
    name,
    columns: [dimensionLabel, ...periods, `Total ${metricHeader}`],
    rows,
    columnWidths: [36, ...periods.map(() => 12), 22],
  }
}

/**
 * The grid, margins included: one row per row entity, one column per column
 * entity, and the row's own ranked total last. A pair the server sent no cell
 * for is left blank rather than written as 0 — "bought nothing" and "bought a
 * refunded-to-nothing amount" are different facts, and the screen shows a dash.
 */
function matrixSheet(name: string, response: SideBySideMatrixResponse): WorkbookSheet {
  const metricHeader = metricColumnHeader(response.label, response.format, response.quantityUnit.selected)
  const byPair = new Map(response.cells.map((cell) => [`${cell.row}|${cell.column}`, cell.value]))
  const totalHeader = response.format === "count" ? `${metricHeader} (whole row)` : `Total ${metricHeader}`

  const rows = response.rows.map((row) => [
    row.label,
    ...response.columns.map((column) => {
      const value = byPair.get(`${row.key}|${column.key}`)
      return value === undefined ? null : cellValue(value, response.format)
    }),
    cellValue(row.total, response.format),
  ])
  rows.push([
    response.format === "count" ? `${metricHeader} (whole column)` : "Total",
    ...response.columns.map((column) => cellValue(column.total, response.format)),
    null,
  ])

  return {
    name,
    columns: [`${response.rowLabel} / ${response.columnLabel}`, ...response.columns.map((column) => column.label), totalHeader],
    rows,
    columnWidths: [36, ...response.columns.map(() => 16), 24],
  }
}

/** One sheet for one panel, whatever state it is in. */
function panelSheet(name: string, panel: SideBySidePanel, snapshot: SideBySidePanelSnapshot | undefined): WorkbookSheet {
  if (!snapshot || snapshot.loading || !snapshot.response) {
    return noteSheet(name, snapshot?.error ?? "This comparison had not loaded when the report was downloaded.")
  }
  if (snapshot.error) return noteSheet(name, snapshot.error)
  const { response } = snapshot
  if (response.blocked) return noteSheet(name, response.blocked.message)

  if (response.mode === "matrix") {
    if (response.rows.length === 0 || response.columns.length === 0) return noteSheet(name, EMPTY_PANEL_NOTE)
    return matrixSheet(name, response)
  }

  const isEmpty = response.mode === "series" ? response.series.length === 0 : response.rows.length === 0
  if (isEmpty) return noteSheet(name, EMPTY_PANEL_NOTE)

  return response.mode === "series"
    ? seriesSheet(name, panel, response)
    : rankSheet(name, panel, response)
}

function summarySheet(context: SideBySideExportContext, index: Array<{ panel: SideBySidePanel; name: string }>): WorkbookSheet {
  const subject = (() => {
    if (context.products.length === 0) return "All products"
    if (context.products.length <= 2) return context.products.join(" and ")
    return `${context.products.length} products`
  })()

  const rows: unknown[][] = [
    ["Report", "Graphical Reports — Product Performance"],
    ["Subject", subject],
    ["Measured by", `${MEASURE_LABEL[context.measure]} (${context.metricLabel})`],
    ["Formula", context.metricFormula],
    ["Period", `${context.startDate} to ${context.endDate}`],
    ["Organizations", nameList(context.organizations)],
    ["Groups", nameList(context.groups)],
    ["Branches", nameList(context.branches)],
    ["Categories", nameList(context.categories)],
    ["Unit of measure", context.unit ?? "Not selected"],
    ["Products in focus", nameList(context.products)],
    ["Requesters compared", context.requesters.length === 0 ? "All requesters (top ranked)" : context.requesters.join(", ")],
    ["Exported at", formatExportedAt(context.exportedAt)],
    [],
    ["Sheet", "Question"],
    ...index.map(({ panel, name }) => [name, panel.question]),
  ]

  return { name: SUMMARY_SHEET_NAME, columns: ["Field", "Value"], rows, columnWidths: [24, 90] }
}

/**
 * Every sheet of the workbook, summary first, then one per panel in the order
 * the registry lists them — so two downloads under different focus settings
 * still read in the same order.
 */
export function buildSideBySideWorkbookData(
  panels: readonly SideBySidePanel[],
  snapshots: Readonly<Record<string, SideBySidePanelSnapshot | undefined>>,
  context: SideBySideExportContext,
): WorkbookSheet[] {
  const taken: string[] = [SUMMARY_SHEET_NAME]
  const named = panels.map((panel) => {
    const name = excelSheetName(panel.title, taken)
    taken.push(name)
    return { panel, name }
  })

  return [
    summarySheet(context, named),
    ...named.map(({ panel, name }) => panelSheet(name, panel, snapshots[panel.id])),
  ]
}

/** Whether one panel has finished — answered or failed — so its sheet is final. */
export function isPanelSnapshotReady(snapshot: SideBySidePanelSnapshot | undefined): boolean {
  if (!snapshot || snapshot.loading) return false
  return snapshot.response !== null || snapshot.error !== null
}

/** Whether every panel on screen has answered, so the file would be complete. */
export function isSideBySideExportReady(
  panels: readonly SideBySidePanel[],
  snapshots: Readonly<Record<string, SideBySidePanelSnapshot | undefined>>,
): boolean {
  if (panels.length === 0) return false
  return panels.every((panel) => isPanelSnapshotReady(snapshots[panel.id]))
}

export function getSideBySideExportFilename(
  context: Pick<SideBySideExportContext, "startDate" | "endDate" | "measure">,
): string {
  const day = (value: string) => value.replace(/[^0-9-]/g, "") || "unknown"
  return `product-performance-${context.measure}-${day(context.startDate)}-to-${day(context.endDate)}.xlsx`
}
