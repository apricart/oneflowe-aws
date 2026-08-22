/**
 * Pure filter parsing for the Group User's group order report.
 *
 * Kept out of the query module — and free of `server-only` — so the rules that
 * decide what a request may narrow by can be exercised directly. Nothing here
 * reads a session or touches the database: it turns untrusted query-string text
 * into a closed set of values the query layer can use, and everything outside
 * that set collapses to the safe default rather than reaching a query.
 */

export const GROUP_ORDER_REPORT_PAGE_SIZE_DEFAULT = 10
export const GROUP_ORDER_REPORT_PAGE_SIZE_MAX = 50

/** Longest group order reference the search box will act on. */
export const GROUP_ORDER_REFERENCE_MAX_LENGTH = 64

/** Bound on the group filter, so one request cannot ask for an unbounded id list. */
export const MAX_GROUP_FILTER_IDS = 200

export const GROUP_ORDER_REPORT_STATUSES = [
  "ALL",
  "PENDING",
  "APPROVED",
  "FULFILLED",
  "REJECTED",
  "REFUNDED",
] as const

export type GroupOrderReportStatus = (typeof GROUP_ORDER_REPORT_STATUSES)[number]

export function parseGroupOrderReportStatus(value: unknown): GroupOrderReportStatus {
  const normalized = typeof value === "string" ? value.toUpperCase() : ""
  return (GROUP_ORDER_REPORT_STATUSES as readonly string[]).includes(normalized)
    ? (normalized as GroupOrderReportStatus)
    : "ALL"
}

/**
 * The group ids a request asked to narrow to: positive integers only,
 * de-duplicated and capped. The ids are only ever intersected with the branch
 * scope resolved from the session, so this can shrink a report but never widen
 * one.
 */
export function parseGroupFilterIds(value: string | null | undefined): number[] {
  if (!value) return []
  const ids = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
  return [...new Set(ids)].slice(0, MAX_GROUP_FILTER_IDS)
}

/** A page size the caller may ask for, clamped to the report's own bounds. */
export function parseReportPageSize(value: string | null | undefined): number {
  const parsed = parsePositiveInt(value)
  if (parsed === undefined) return GROUP_ORDER_REPORT_PAGE_SIZE_DEFAULT
  return Math.min(parsed, GROUP_ORDER_REPORT_PAGE_SIZE_MAX)
}

export function parsePositiveInt(value: string | null | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}
