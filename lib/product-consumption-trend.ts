/**
 * Monthly consumption trend: quantity consumed per product per month.
 *
 * "Consumed" here is a **count of units** — fulfilled quantity net of approved
 * refunds — and not the budget sense of the word. `lib/budget-consumption.ts`
 * names a money figure (`spent + held`) on a branch's monthly ledger row; this
 * names how many of a thing left the shelf. Different questions, deliberately
 * not sharing a module.
 *
 * Everything here is pure so the shape of the chart can be tested without a
 * database. The route supplies rows; this decides which products are drawn,
 * which months the axis carries, and what each cell holds.
 */

import { buildAppMonthPeriods } from "@/lib/date-range-params"

/** Lines drawn unless the caller asks for more. */
export const CONSUMPTION_TREND_DEFAULT_SERIES = 5

/**
 * The most lines that may be drawn.
 *
 * Eight because the categorical palette has eight slots and a ninth line would
 * have to repeat a colour, which is the one thing a multi-series line chart
 * cannot survive. Products past the limit are folded into `other`, never
 * dropped, so a column still sums to what the tenant really consumed.
 */
export const CONSUMPTION_TREND_MAX_SERIES = 8

/**
 * The most months the axis may carry.
 *
 * "All time" on a tenant with four years of history is not a readable axis. The
 * most recent months are kept, because a trend is read from its right-hand end.
 */
export const CONSUMPTION_TREND_MAX_MONTHS = 24

export const OTHER_SERIES_ID = -1
export const OTHER_SERIES_NAME = "Other products"

const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

/**
 * The month an order falls in, as `YYYY-MM`.
 *
 * The single derivation, shared with `buildProductTrend` in the product
 * performance route. The two charts sit one above the other on the same screen
 * under the same filters, so an order has to land in the same month in both or
 * the line chart visibly contradicts the bars above it.
 *
 * It is local-time, which is what the performance route has always used.
 * Changing that is a separate decision — the point of extracting it here is
 * that the change would then move both charts at once.
 */
export function productTrendMonthKey(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
}

/** `2026-01` becomes `Jan 26`. Short enough for a monthly axis at phone width. */
export function formatTrendMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-")
  const abbreviation = MONTH_ABBREVIATIONS[Number(month) - 1]
  if (!abbreviation || !year) return monthKey
  return `${abbreviation} ${year.slice(2)}`
}

export type ConsumptionTrendRow = {
  productId: number
  productName: string
  productCode?: string | null
  monthKey: string
  /** Units ordered on the line, whatever the order's outcome. */
  qtyOrdered: number
  /** Units that stayed with the branch: ordered minus approved refunds. */
  qtyConsumed: number
}

export type ConsumptionTrendPoint = {
  month: string
  label: string
  consumed: number
  ordered: number
}

export type ConsumptionTrendSeries = {
  productId: number
  productName: string
  productCode: string | null
  totalConsumed: number
  totalOrdered: number
  points: ConsumptionTrendPoint[]
}

export type ConsumptionTrend = {
  months: { month: string; label: string }[]
  series: ConsumptionTrendSeries[]
  /** How many products the window held, before the limit was applied. */
  productsInWindow: number
  /** Whether a series named `Other products` is present. */
  hasOther: boolean
}

const positiveInteger = (value: unknown) => {
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function parseConsumptionTrendSeriesLimit(value: unknown): number {
  const parsed = positiveInteger(value)
  if (parsed === 0) return CONSUMPTION_TREND_DEFAULT_SERIES
  return Math.min(parsed, CONSUMPTION_TREND_MAX_SERIES)
}

/** Every `YYYY-MM` from `start` to `end` inclusive, oldest first. */
function monthsBetween(start: Date, end: Date): string[] {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return []
  if (start.getTime() > end.getTime()) return []

  // Date-only request bounds are instants at the edges of an Asia/Karachi
  // calendar day. Reading them through the host's local Date getters makes a
  // July 1 start look like June 30 on a UTC server (including CI), adding an
  // extra month to the axis. Keep range expansion in the application's
  // timezone, just like the SQL window parsed from the same parameters.
  return buildAppMonthPeriods(start, end)
}

/**
 * The months the axis carries.
 *
 * A month the reader asked for but that holds nothing is still drawn, at zero —
 * "we consumed none in April" is an answer, and a line that simply skips April
 * says something different and wrong. A month nobody asked for is drawn only
 * because data landed in it.
 *
 * Precedence mirrors `applyDateFilters` on the product routes: an explicit
 * month/year selection wins over a date range, and with neither the window is
 * whatever the rows themselves cover.
 */
export function resolveTrendMonths({
  months,
  years,
  startDate,
  endDate,
  observedMonths = [],
}: {
  months?: number[]
  years?: number[]
  startDate?: Date | null
  endDate?: Date | null
  observedMonths?: string[]
}): string[] {
  const observed = Array.from(new Set(observedMonths.filter(Boolean))).sort()

  const selectedMonths = (months ?? []).filter((month) => month >= 1 && month <= 12)
  const selectedYears = (years ?? []).filter((year) => year > 2000)

  const resolved = (() => {
    if (selectedYears.length > 0) {
      const monthNumbers = selectedMonths.length > 0
        ? selectedMonths
        : Array.from({ length: 12 }, (_, index) => index + 1)
      return selectedYears.flatMap((year) => monthNumbers.map(
        (month) => `${year}-${String(month).padStart(2, "0")}`,
      ))
    }

    // Months without years: the reader means those months of whichever years
    // the data covers, which is how the performance route reads the same pair.
    if (selectedMonths.length > 0) {
      const wanted = new Set(selectedMonths.map((month) => String(month).padStart(2, "0")))
      return observed.filter((month) => wanted.has(month.split("-")[1]))
    }

    if (startDate && endDate) return monthsBetween(startDate, endDate)

    return observed
  })()

  const unique = Array.from(new Set(resolved)).sort()
  // Trimmed from the old end: a trend is read from its right-hand side.
  return unique.slice(Math.max(0, unique.length - CONSUMPTION_TREND_MAX_MONTHS))
}

type ProductTotals = {
  productId: number
  productName: string
  productCode: string | null
  totalConsumed: number
  totalOrdered: number
  byMonth: Map<string, { consumed: number; ordered: number }>
}

function accumulate(rows: ConsumptionTrendRow[], monthSet: Set<string>) {
  const totals = new Map<number, ProductTotals>()
  for (const row of rows) {
    if (!row.productId || !monthSet.has(row.monthKey)) continue

    const existing = totals.get(row.productId) ?? {
      productId: row.productId,
      productName: row.productName || "Unknown product",
      productCode: row.productCode ?? null,
      totalConsumed: 0,
      totalOrdered: 0,
      byMonth: new Map<string, { consumed: number; ordered: number }>(),
    }

    const consumed = Math.max(0, Number(row.qtyConsumed) || 0)
    const ordered = Math.max(0, Number(row.qtyOrdered) || 0)
    existing.totalConsumed += consumed
    existing.totalOrdered += ordered

    const cell = existing.byMonth.get(row.monthKey) ?? { consumed: 0, ordered: 0 }
    cell.consumed += consumed
    cell.ordered += ordered
    existing.byMonth.set(row.monthKey, cell)

    totals.set(row.productId, existing)
  }
  return totals
}

function toSeries(totals: ProductTotals, months: string[]): ConsumptionTrendSeries {
  return {
    productId: totals.productId,
    productName: totals.productName,
    productCode: totals.productCode,
    totalConsumed: totals.totalConsumed,
    totalOrdered: totals.totalOrdered,
    points: months.map((month) => {
      const cell = totals.byMonth.get(month)
      return {
        month,
        label: formatTrendMonthLabel(month),
        consumed: cell?.consumed ?? 0,
        ordered: cell?.ordered ?? 0,
      }
    }),
  }
}

function foldOther(rest: ProductTotals[], months: string[]): ConsumptionTrendSeries {
  const points = months.map((month) => {
    let consumed = 0
    let ordered = 0
    for (const product of rest) {
      const cell = product.byMonth.get(month)
      consumed += cell?.consumed ?? 0
      ordered += cell?.ordered ?? 0
    }
    return { month, label: formatTrendMonthLabel(month), consumed, ordered }
  })

  return {
    productId: OTHER_SERIES_ID,
    productName: OTHER_SERIES_NAME,
    productCode: null,
    totalConsumed: points.reduce((sum, point) => sum + point.consumed, 0),
    totalOrdered: points.reduce((sum, point) => sum + point.ordered, 0),
    points,
  }
}

/**
 * The chart: the `limit` most-consumed products over the whole window, each as
 * a complete row of months, plus an `Other products` row when anything was left
 * over.
 *
 * Ranked on the window total rather than on the last month, so the lines are
 * the products that matter across the period the reader chose — a product that
 * spiked once does not displace one consumed steadily all year.
 */
export function buildConsumptionTrend(
  rows: ConsumptionTrendRow[],
  {
    months,
    limit = CONSUMPTION_TREND_DEFAULT_SERIES,
    includeOther = true,
  }: {
    months: string[]
    limit?: number
    includeOther?: boolean
  },
): ConsumptionTrend {
  const axis = months.slice(0, CONSUMPTION_TREND_MAX_MONTHS)
  const monthSet = new Set(axis)
  const totals = accumulate(rows, monthSet)

  const ranked = Array.from(totals.values())
    .filter((product) => product.totalConsumed > 0 || product.totalOrdered > 0)
    .sort((left, right) => {
      const byConsumed = right.totalConsumed - left.totalConsumed
      if (byConsumed !== 0) return byConsumed
      const byOrdered = right.totalOrdered - left.totalOrdered
      if (byOrdered !== 0) return byOrdered
      return left.productName.localeCompare(right.productName)
    })

  const capped = Math.min(Math.max(1, Math.trunc(limit)), CONSUMPTION_TREND_MAX_SERIES)
  const top = ranked.slice(0, capped)
  const rest = ranked.slice(capped)

  const series = top.map((product) => toSeries(product, axis))
  const hasOther = includeOther && rest.length > 0
  if (hasOther) series.push(foldOther(rest, axis))

  return {
    months: axis.map((month) => ({ month, label: formatTrendMonthLabel(month) })),
    series,
    productsInWindow: ranked.length,
    hasOther,
  }
}
