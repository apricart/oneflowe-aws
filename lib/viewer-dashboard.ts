/**
 * The Viewer dashboard's own filter and refresh rules, kept out of the
 * component so they can be tested without a browser.
 *
 * Two of the three additions this role asked for live here — month-wise cost
 * filtering and automatic refresh — because both are arithmetic, and putting
 * arithmetic in a component is how two dashboards end up disagreeing about
 * which month they are showing.
 */

export const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const

export const SHORT_MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const

/** Every month, 1-12, as the analytics endpoints expect them. */
export const ALL_MONTHS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

export type ViewerCostPeriod = {
  /** The year being reported on. */
  year: number
  /**
   * The months selected within it. Empty means the whole year — the endpoints
   * read an empty `months` list as "no month filter", which is the same thing.
   */
  months: number[]
}

/**
 * The years a reader may pick, newest first: every year from the first order
 * the tenant ever placed up to the current one.
 *
 * A malformed or future `earliestDate` falls back to the current year alone
 * rather than producing an empty dropdown or a thousand entries.
 */
export function availableCostYears(
  earliestDate: string | Date | null | undefined,
  now: Date = new Date(),
): number[] {
  const currentYear = now.getFullYear()
  const parsed = earliestDate ? new Date(earliestDate) : null
  const earliestYear = parsed && !Number.isNaN(parsed.getTime())
    ? parsed.getFullYear()
    : currentYear

  const from = Math.min(Math.max(earliestYear, 2000), currentYear)
  const years: number[] = []
  for (let year = currentYear; year >= from; year -= 1) years.push(year)
  return years
}

/** Normalise a month selection: unique, in range, ascending. */
export function normalizeMonths(months: ReadonlyArray<unknown>): number[] {
  return Array.from(new Set(
    months
      .map(Number)
      .filter((month) => Number.isInteger(month) && month >= 1 && month <= 12),
  )).sort((a, b) => a - b)
}

/** "2026" · "September 2026" · "Jan, Mar, Jul 2026" */
export function describeCostPeriod(period: ViewerCostPeriod): string {
  const months = normalizeMonths(period.months)
  if (months.length === 0 || months.length === 12) return String(period.year)
  if (months.length === 1) return `${MONTH_LABELS[months[0] - 1]} ${period.year}`
  return `${months.map((month) => SHORT_MONTH_LABELS[month - 1]).join(", ")} ${period.year}`
}

/**
 * The chart's granularity for a period: a single month is read day by day,
 * anything wider month by month. A reader who picks one month wants to see the
 * shape of that month, not one bar.
 */
export function costChartGranularity(period: ViewerCostPeriod): "daily" | "monthly" {
  return normalizeMonths(period.months).length === 1 ? "daily" : "monthly"
}

export type RefreshChoice = {
  label: string
  /** Milliseconds, or 0 for off. */
  intervalMs: number
}

/**
 * The refresh cadences offered. 30 seconds is the floor deliberately: each tick
 * is a bounded aggregate over `orders` for one tenant, and a faster poll buys a
 * reader nothing that the manual refresh does not.
 */
export const REFRESH_CHOICES: ReadonlyArray<RefreshChoice> = [
  { label: "Off", intervalMs: 0 },
  { label: "30 seconds", intervalMs: 30_000 },
  { label: "1 minute", intervalMs: 60_000 },
  { label: "5 minutes", intervalMs: 300_000 },
  { label: "15 minutes", intervalMs: 900_000 },
]

export const DEFAULT_REFRESH_INTERVAL_MS = 60_000

export function refreshChoiceFor(intervalMs: number): RefreshChoice {
  return REFRESH_CHOICES.find((choice) => choice.intervalMs === intervalMs)
    ?? REFRESH_CHOICES[0]
}

/** "Updated 14:52:08", or a waiting state before the first load lands. */
export function describeLastUpdated(at: Date | null): string {
  if (!at) return "Loading…"
  const pad = (value: number) => String(value).padStart(2, "0")
  return `Updated ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}
