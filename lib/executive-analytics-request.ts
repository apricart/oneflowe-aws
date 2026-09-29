import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import {
  MAX_COMPARE_ENTITIES,
  clampDrillDownLimit,
  clampDrillDownOffset,
  clampMatrixLimit,
  clampRowLimit,
  isChartType,
  isDimensionAllowedForRole,
  isDrillDownStatusSet,
  isExecutiveDimension,
  isExecutiveMetric,
  isMatrixDimension,
  isMatrixMetric,
  isSupportedCombination,
  isSupportedMatrix,
  resolveDrillDownSort,
  resolveSortDirection,
  type ChartTypeId,
  type DrillDownSortKey,
  type DrillDownStatusSet,
  type ExecutiveDimensionId,
  type ExecutiveMetricId,
  type MatrixDimensionId,
} from "@/lib/executive-analytics"

/**
 * Request validation for the Executive Analytics Center.
 *
 * Every value a client can send is either a whitelisted identifier or a number,
 * and nothing here is ever interpolated into SQL — the dimension and metric
 * names select a pre-written builder, and the id lists are bound as parameters
 * by drizzle. This is what keeps the "one flexible endpoint" design from
 * becoming a query builder pointed at the database.
 *
 * Kept free of the database and the session so it can be unit-tested directly.
 */

export const EXECUTIVE_MAX_ID_FILTERS = 100

/** Default window when the caller sends none: the last 6 whole months to date. */
export function defaultExecutiveWindow(now = new Date()) {
  const end = new Date(now)
  const start = new Date(now)
  start.setMonth(start.getMonth() - 5)
  start.setDate(1)
  start.setHours(0, 0, 0, 0)
  return { start, end }
}

function parseIdList(value: string | null): number[] {
  if (!value) return []
  return Array.from(new Set(
    value
      .split(",")
      .map((entry) => Math.trunc(Number(entry)))
      .filter((entry) => Number.isInteger(entry) && entry > 0),
  )).slice(0, EXECUTIVE_MAX_ID_FILTERS)
}

/**
 * Unit of measure names come from `order_items.unit`, so they are free text
 * rather than an enum. The value is length-capped and stripped of anything that
 * is not a plain identifier character before it is bound — and it is only ever
 * compared for equality against a column, never concatenated.
 */
export function sanitizeUnit(value: string | null): string | null {
  const trimmed = (value || "").trim()
  if (!trimmed || trimmed.length > 64) return null
  const cleaned = trimmed.replace(/[^\p{L}\p{N}\s._/-]/gu, "")
  return cleaned.length > 0 ? cleaned : null
}

export type ExecutiveRequestError = { ok: false; error: string }

export type ParsedExecutiveRequest = {
  ok: true
  startDate: Date
  endDate: Date
  categoryIds: number[]
  productIds: number[]
  groupIds: number[]
  userIds: string[]
  requestedUnit: string | null
  limit: number
  /** Which allowlisted order population the caller is asking to aggregate. */
  statusSet: DrillDownStatusSet
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * User ids are UUIDs rather than integers, so they get their own parser.
 * Anything not shaped like a UUID is dropped rather than passed down — the
 * value is bound as a parameter either way, but a malformed one would make
 * Postgres raise instead of simply matching nothing.
 */
export function parseUuidList(value: string | null): string[] {
  if (!value) return []
  return Array.from(new Set(
    value.split(",").map((entry) => entry.trim()).filter((entry) => UUID_PATTERN.test(entry)),
  )).slice(0, MAX_COMPARE_ENTITIES)
}

export function parseExecutiveRequest(
  searchParams: URLSearchParams,
  now = new Date(),
): ParsedExecutiveRequest | ExecutiveRequestError {
  const fallback = defaultExecutiveWindow(now)
  const startDate = parseStartDateParam(searchParams.get("startDate")) ?? fallback.start
  const endDate = parseEndDateParam(searchParams.get("endDate")) ?? fallback.end

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return { ok: false, error: "Invalid date range" }
  }
  if (startDate.getTime() > endDate.getTime()) {
    return { ok: false, error: "startDate must be on or before endDate" }
  }

  // Anything outside the allowlist is refused rather than defaulted, so a
  // caller cannot turn a status name into a query predicate.
  const rawStatuses = searchParams.get("statuses")
  const statusSet = rawStatuses === null || rawStatuses === "" ? "revenue" : rawStatuses
  if (!isDrillDownStatusSet(statusSet)) return { ok: false, error: "Unsupported statuses" }

  return {
    ok: true,
    startDate,
    endDate,
    categoryIds: parseIdList(searchParams.get("categoryIds")),
    productIds: parseIdList(searchParams.get("productIds")),
    groupIds: parseIdList(searchParams.get("groupIds")),
    userIds: parseUuidList(searchParams.get("userIds")),
    requestedUnit: sanitizeUnit(searchParams.get("unit")),
    limit: clampRowLimit(searchParams.get("limit")),
    statusSet,
  }
}

/**
 * Where a dimension's selected entities belong once parsed.
 *
 * Branch, organization and group selections are routed into the *scope*
 * parameters, so they travel the same already-audited path as any other tenant
 * narrowing and are intersected with what the caller may see — a group is a
 * set of branches, and the scope resolver turns it into one. The rest become
 * ordinary filters, which is safe because the branch fence has already decided
 * which rows exist at all.
 */
export const ENTITY_KEY_PARAM: Record<ExecutiveDimensionId, string | null> = {
  branch: "branchIds",
  organization: "organizationIds",
  group: "groupIds",
  user: "userIds",
  category: "categoryIds",
  product: "productIds",
  // A time axis has no id list to fold into; a clicked month or day narrows the
  // window instead. See `narrowWindowToPeriod`.
  month: null,
  day: null,
}

/**
 * The dimensions whose picked entities must be folded into the scope
 * parameters *before* the fence is resolved, so a picked entity can only ever
 * narrow what the caller already had. Every route that accepts `keys` (or a
 * drill-down `key`) consults this rather than naming the dimensions itself,
 * so the list cannot drift between routes.
 *
 * The scope resolver reads exactly these three parameters — `branchIds`,
 * `organizationIds`, `groupIds` — which is why the list is these dimensions
 * and no other.
 */
export const SCOPE_KEYED_DIMENSIONS = ["branch", "organization", "group"] as const satisfies readonly ExecutiveDimensionId[]

export function isScopeKeyedDimension(value: unknown): value is (typeof SCOPE_KEYED_DIMENSIONS)[number] {
  return typeof value === "string" && (SCOPE_KEYED_DIMENSIONS as readonly string[]).includes(value)
}

/**
 * Folds `keys` into the parameter its dimension actually uses, so the rest of
 * the pipeline sees an ordinary request and no code path has to special-case
 * "the entity picker".
 */
export function applyEntityKeys(
  searchParams: URLSearchParams,
  dimension: ExecutiveDimensionId,
): URLSearchParams {
  const raw = searchParams.get("keys")
  const target = ENTITY_KEY_PARAM[dimension]
  if (!raw || !target) return searchParams

  const keys = raw.split(",").map((entry) => entry.trim()).filter(Boolean).slice(0, MAX_COMPARE_ENTITIES)
  if (keys.length === 0) return searchParams

  const merged = new URLSearchParams(searchParams)
  // A dimension's own selection replaces whatever was in that slot, so the
  // picker cannot end up intersected against a stale filter of the same kind.
  merged.set(target, keys.join(","))
  return merged
}

export type ParsedComparisonRequest = ParsedExecutiveRequest & {
  dimension: ExecutiveDimensionId
  metric: ExecutiveMetricId
  chart: ChartTypeId
  /**
   * `budget=1`: set each entity's Total Budget beside its figure. A request,
   * not a grant — the route still applies `canShowBudgetBeside`, and omits the
   * budget for a comparison it cannot honestly stand beside.
   */
  withBudget: boolean
}

/**
 * The Level-2 request. An unknown dimension or metric, or a pairing the
 * registry does not list, is refused with 400 rather than silently falling back
 * to a default — a caller must never be able to probe for combinations by
 * watching which ones return data.
 */
export function parseComparisonRequest(
  searchParams: URLSearchParams,
  now = new Date(),
  role?: unknown,
): ParsedComparisonRequest | ExecutiveRequestError {
  const dimension = searchParams.get("dimension")
  const metric = searchParams.get("metric")
  const chart = searchParams.get("chart") ?? "bar"

  if (!isExecutiveDimension(dimension)) return { ok: false, error: "Unsupported dimension" }
  if (!isExecutiveMetric(metric)) return { ok: false, error: "Unsupported metric" }
  if (!isSupportedCombination(dimension, metric)) {
    return { ok: false, error: `Metric "${metric}" cannot be compared by ${dimension}` }
  }
  if (!isChartType(chart)) return { ok: false, error: "Unsupported chart type" }
  // A dimension reserved to one role is refused here as well as being absent
  // from that role's menu, so the restriction does not depend on the UI.
  if (role !== undefined && !isDimensionAllowedForRole(dimension, role)) {
    return { ok: false, error: "Forbidden: Insufficient permissions" }
  }

  const base = parseExecutiveRequest(applyEntityKeys(searchParams, dimension), now)
  if (!base.ok) return base

  return { ...base, dimension, metric, chart, withBudget: searchParams.get("budget") === "1" }
}

export type ParsedMatrixRequest = ParsedExecutiveRequest & {
  rows: MatrixDimensionId
  columns: MatrixDimensionId
  metric: ExecutiveMetricId
  /** Entities per axis, clamped; the grid is at most `limit × limit`. */
  limit: number
}

/**
 * The two-way grid request: "<rows> against <columns>, by <metric>".
 *
 * There is no `keys` here. Both axes' selections travel as the ordinary
 * `userIds` / `productIds` / `categoryIds` / `branchIds` filters, which is
 * what the Product Performance screen already sends, so the grid narrows
 * exactly as the panels beside it do and no second folding path exists to
 * audit. The same refusals as the comparison: nothing outside the registry is
 * answered, so a caller cannot probe for combinations.
 */
export function parseMatrixRequest(
  searchParams: URLSearchParams,
  now = new Date(),
  role?: unknown,
): ParsedMatrixRequest | ExecutiveRequestError {
  const rows = searchParams.get("rows")
  const columns = searchParams.get("columns")
  const metric = searchParams.get("metric")

  if (!isMatrixDimension(rows)) return { ok: false, error: "Unsupported row dimension" }
  if (!isMatrixDimension(columns)) return { ok: false, error: "Unsupported column dimension" }
  if (rows === columns) return { ok: false, error: "Rows and columns must be different dimensions" }
  if (!isMatrixMetric(metric)) return { ok: false, error: "Unsupported metric" }
  if (!isSupportedMatrix(rows, columns, metric)) {
    return { ok: false, error: `Metric "${metric}" cannot be laid out by ${rows} and ${columns}` }
  }
  // No grid dimension is reserved to a role today; checked anyway so the rule
  // cannot be forgotten if one ever is.
  if (role !== undefined && (!isDimensionAllowedForRole(rows, role) || !isDimensionAllowedForRole(columns, role))) {
    return { ok: false, error: "Forbidden: Insufficient permissions" }
  }

  const base = parseExecutiveRequest(searchParams, now)
  if (!base.ok) return base

  return { ...base, rows, columns, metric, limit: clampMatrixLimit(searchParams.get("limit")) }
}

/**
 * The immediately preceding window of the same length, for "vs previous
 * period". Anchored so the two windows never overlap by even a millisecond.
 */
export function previousWindow(startDate: Date, endDate: Date) {
  const durationMs = endDate.getTime() - startDate.getTime()
  const previousEnd = new Date(startDate.getTime() - 1)
  const previousStart = new Date(previousEnd.getTime() - durationMs)
  return { previousStart, previousEnd }
}

// ── Drill-down ─────────────────────────────────────────────────────────────

/** A clicked month key, e.g. "2025-03". */
const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
/** A clicked day key, e.g. "2025-03-17". */
const DAY_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/**
 * The clicked entity's key, as sent by a chart.
 *
 * Entity keys are numeric ids or UUIDs and are re-parsed downstream by the id
 * parsers, so this only enforces a shape and a length — anything longer is
 * refused rather than truncated, because a truncated key would silently drill
 * into the wrong row.
 */
const ENTITY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_KEY_PATTERN.test(value)
}

export function isDayKey(value: unknown): value is string {
  return typeof value === "string" && DAY_KEY_PATTERN.test(value)
}

/** Calendar length of a "YYYY-MM" key. Day 0 of the next month is the last of this one. */
function daysInMonth(monthKey: string): number {
  const [year, month] = monthKey.split("-").map(Number)
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Narrows an existing window to the clicked month or day, intersected with it.
 *
 * Intersected, never replaced: clicking March on a chart drawn for
 * "1 Feb – 15 Mar" must give the rows behind *that bar*, which is 1–15 March,
 * not the whole of March. Getting this wrong would show the reader more money
 * than the bar they clicked, which is the one thing a drill-down must never do.
 *
 * Both keys are read in the application timezone, matching how the buckets they
 * came from were built.
 */
export function narrowWindowToPeriod(
  startDate: Date,
  endDate: Date,
  dimension: ExecutiveDimensionId,
  key: string | null,
): { startDate: Date; endDate: Date } | ExecutiveRequestError {
  if (dimension !== "month" && dimension !== "day") return { startDate, endDate }
  if (!key) return { startDate, endDate }

  const valid = dimension === "month" ? isMonthKey(key) : isDayKey(key)
  if (!valid) return { ok: false, error: `Invalid ${dimension} key` }

  // Both bounds are built as plain calendar strings and handed to the shared
  // date parsers, which anchor them to the application timezone. Doing the
  // arithmetic on a Date would do it in UTC and land the boundary five hours
  // out — the exact class of error this drill-down exists to avoid.
  const firstDay = dimension === "month" ? `${key}-01` : key
  const lastDay = dimension === "month" ? `${key}-${String(daysInMonth(key)).padStart(2, "0")}` : key

  const periodStart = parseStartDateParam(firstDay)
  const periodEnd = parseEndDateParam(lastDay)
  if (!periodStart || !periodEnd) return { ok: false, error: `Invalid ${dimension} key` }

  const start = new Date(Math.max(startDate.getTime(), periodStart.getTime()))
  const end = new Date(Math.min(endDate.getTime(), periodEnd.getTime()))
  if (start.getTime() > end.getTime()) {
    return { ok: false, error: "The selected period does not overlap the requested window" }
  }
  return { startDate: start, endDate: end }
}

export type ParsedDrillDownRequest = ParsedExecutiveRequest & {
  dimension: ExecutiveDimensionId
  metric: ExecutiveMetricId
  /** The clicked entity, already folded into the matching filter for entity dimensions. */
  entityKey: string | null
  /** The clicked bucket on a trend, when the point named one as well as an entity. */
  period: string | null
  sort: DrillDownSortKey
  direction: "asc" | "desc"
  offset: number
  /** Which orders to list: the revenue rule by default, or consumed (pending included). */
  statusSet: DrillDownStatusSet
}

/** The dimension/metric/role half of the drill-down request. */
function validateDrillDownSubject(
  dimension: unknown,
  metric: unknown,
  role: unknown,
): ExecutiveRequestError | null {
  if (!isExecutiveDimension(dimension)) return { ok: false, error: "Unsupported dimension" }
  if (!isExecutiveMetric(metric)) return { ok: false, error: "Unsupported metric" }
  if (!isSupportedCombination(dimension, metric)) {
    return { ok: false, error: `Metric "${metric}" cannot be compared by ${dimension}` }
  }
  if (role !== undefined && !isDimensionAllowedForRole(dimension, role)) {
    return { ok: false, error: "Forbidden: Insufficient permissions" }
  }
  return null
}

/**
 * The clicked key, validated for its dimension.
 *
 * A time-axis key is validated by `narrowWindowToPeriod` against the calendar
 * shape it must have; every other key is an id or a UUID and is only checked
 * for shape here, because the id parsers downstream are what actually decide
 * which rows it can reach.
 */
function resolveEntityKey(
  dimension: ExecutiveDimensionId,
  rawKey: string | null,
): { key: string | null } | ExecutiveRequestError {
  if (!rawKey) return { key: null }
  if (dimension === "month" || dimension === "day") return { key: rawKey }
  if (ENTITY_KEY_PATTERN.test(rawKey)) return { key: rawKey }
  return { ok: false, error: "Invalid entity key" }
}

/**
 * A second, optional narrowing for a point on a multi-series trend.
 *
 * "Requesters over months" plots one line per person across months, so a
 * clicked point names *two* things — the person and the month — and the table
 * must show that person in that month, not that person across the whole window.
 * The entity travels as `key`, the bucket as `period`, and its grain is read
 * from its own shape rather than taken on trust.
 */
function narrowToClickedPeriod(
  window: { startDate: Date; endDate: Date },
  rawPeriod: string | null,
): { startDate: Date; endDate: Date } | ExecutiveRequestError {
  if (!rawPeriod) return window
  const grain = isDayKey(rawPeriod) ? "day" : isMonthKey(rawPeriod) ? "month" : null
  if (!grain) return { ok: false, error: "Invalid period" }
  return narrowWindowToPeriod(window.startDate, window.endDate, grain, rawPeriod)
}

/**
 * The detail request behind a clicked bar.
 *
 * It re-parses the whole filter set rather than trusting a client to send a
 * consistent one, folds an entity key through the same `applyEntityKeys` path
 * the comparison uses — so a branch or organization key is intersected with the
 * caller's fence upstream rather than believed — and narrows the window for a
 * clicked month or day. The sort key selects a pre-written expression from an
 * allowlist and never reaches SQL as text.
 */
export function parseDrillDownRequest(
  searchParams: URLSearchParams,
  now = new Date(),
  role?: unknown,
): ParsedDrillDownRequest | ExecutiveRequestError {
  const dimension = searchParams.get("dimension")
  const metric = searchParams.get("metric") ?? "spend"

  const invalid = validateDrillDownSubject(dimension, metric, role)
  if (invalid) return invalid
  // Narrowed by `validateDrillDownSubject`; re-asserted for the type checker.
  if (!isExecutiveDimension(dimension) || !isExecutiveMetric(metric)) {
    return { ok: false, error: "Unsupported dimension" }
  }

  const resolvedKey = resolveEntityKey(dimension, searchParams.get("key"))
  if ("ok" in resolvedKey) return resolvedKey
  const entityKey = resolvedKey.key
  const isTimeKey = dimension === "month" || dimension === "day"

  // An entity key travels as `keys`, exactly as the comparison's picker does,
  // so there is no second code path that has to be audited for scoping.
  const params = new URLSearchParams(searchParams)
  if (entityKey && !isTimeKey) params.set("keys", entityKey)

  const base = parseExecutiveRequest(applyEntityKeys(params, dimension), now)
  if (!base.ok) return base

  const window = narrowWindowToPeriod(base.startDate, base.endDate, dimension, entityKey)
  if ("ok" in window) return window

  const rawPeriod = searchParams.get("period")
  const period = narrowToClickedPeriod(window, rawPeriod)
  if ("ok" in period) return period

  return {
    ...base,
    startDate: period.startDate,
    endDate: period.endDate,
    limit: clampDrillDownLimit(searchParams.get("limit")),
    offset: clampDrillDownOffset(searchParams.get("offset")),
    dimension,
    metric,
    entityKey,
    period: rawPeriod || null,
    sort: resolveDrillDownSort(searchParams.get("sort")),
    direction: resolveSortDirection(searchParams.get("direction")),
    statusSet: base.statusSet,
  }
}
