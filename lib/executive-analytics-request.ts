import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import {
  MAX_COMPARE_ENTITIES,
  clampRowLimit,
  isChartType,
  isDimensionAllowedForRole,
  isExecutiveDimension,
  isExecutiveMetric,
  isSupportedCombination,
  type ChartTypeId,
  type ExecutiveDimensionId,
  type ExecutiveMetricId,
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
  }
}

/**
 * Where a dimension's selected entities belong once parsed.
 *
 * Branch and organization selections are routed into the *scope* parameters, so
 * they travel the same already-audited path as any other tenant narrowing and
 * are intersected with what the caller may see. The rest become ordinary
 * filters, which is safe because the branch fence has already decided which
 * rows exist at all.
 */
export const ENTITY_KEY_PARAM: Record<ExecutiveDimensionId, string | null> = {
  branch: "branchIds",
  organization: "organizationIds",
  group: "groupIds",
  user: "userIds",
  category: "categoryIds",
  product: "productIds",
  month: null,
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

  return { ...base, dimension, metric, chart }
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
