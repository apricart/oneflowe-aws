import { BRANCH_REGIONS, branchRegionLabel, normalizeBranchRegion, type BranchRegion } from "@/lib/branch-region"
import {
  DEFAULT_DELIVERED_WINDOW_DAYS,
  DELIVERY_DASHBOARD_CUTOFF_DAY,
  DELIVERY_HEALTH_LABELS,
  DELIVERY_SLA_HOURS,
  DUE_SOON_HOURS,
  assessDelivery,
  compareByAttention,
  countDeliveredOn,
  countDeliveries,
  deliveryAlerts,
  destinationCity,
  groupDeliveries,
  isDeliveryListView,
  isInDeliveryDateRange,
  karachiDay,
  matchesDeliveryListView,
  overdueAgeBuckets,
  pipelineCounts,
  placeKey,
  shiftKarachiDay,
  type AssessedDeliveryRow,
  type DeliveryListView,
} from "@/lib/delivery-sla"
import {
  FULFILLMENT_STATUSES,
  FULFILLMENT_STATUS_LABELS,
  type FulfillmentStatus,
} from "@/lib/fulfillment-status"

/**
 * The management delivery dashboard's request and response, without a
 * database: what a query string may ask for, and how a set of order rows
 * becomes the screen. The server (`lib/server/delivery-dashboard.ts`) reads the
 * rows; everything it returns is built here, through `lib/delivery-sla.ts`.
 *
 * Nothing here carries money or a person — no amount, price, name, email or
 * phone — so the dashboard needs no price-visibility rule.
 */

/** The most order rows one request reads. Beyond it the response says `truncated`. */
export const DELIVERY_DASHBOARD_MAX_ROWS = 20_000

/** The most rows the order list returns. */
export const DELIVERY_ATTENTION_LIMIT = 100

/** The most rows the branch table returns; cities, regions and clients are few. */
export const DELIVERY_BRANCH_LIMIT = 50

/** A delivered range longer than this is refused rather than silently clipped. */
export const DELIVERY_MAX_RANGE_DAYS = 366

export const UNKNOWN_REGION_FILTER = "UNKNOWN"

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ALLOWED_QUERY_KEYS = new Set([
  "organizationId",
  "branchId",
  "region",
  "city",
  "fulfillmentStatus",
  "view",
  "deliveredFrom",
  "deliveredTo",
])

export type DeliveryDashboardFilters = {
  organizationId: number | null
  branchId: number | null
  region: BranchRegion | typeof UNKNOWN_REGION_FILTER | null
  /** Destination city, matched case-insensitively; "Unknown" matches blanks. */
  city: string | null
  fulfillmentStatus: FulfillmentStatus | null
  view: DeliveryListView
  /**
   * Karachi days, inclusive. Every figure counts open orders approved, and
   * delivered orders delivered, inside this range. The names predate that and
   * are kept so the query string stays stable.
   */
  deliveredFrom: string
  deliveredTo: string
}

export type DeliveryDashboardQueryParse =
  | { ok: true; filters: DeliveryDashboardFilters }
  | { ok: false; message: string }

function positiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function isRealDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

const accept = <T,>(value: T): Parsed<T> => ({ ok: true, value })
const refuse = (message: string): { ok: false; message: string } => ({ ok: false, message })

function readParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key)
  return value === null || value.trim() === "" ? null : value.trim()
}

function parseOptionalId(raw: string | null, key: string): Parsed<number | null> {
  if (raw === null) return accept(null)
  const id = positiveInteger(raw)
  return id === null ? refuse(`${key} must be a positive integer`) : accept(id)
}

function parseRegion(raw: string | null): Parsed<DeliveryDashboardFilters["region"]> {
  if (raw === null) return accept(null)
  if (raw.toUpperCase() === UNKNOWN_REGION_FILTER) return accept(UNKNOWN_REGION_FILTER)
  const region = normalizeBranchRegion(raw)
  return region
    ? accept(region)
    : refuse(`region must be one of: ${[...BRANCH_REGIONS, UNKNOWN_REGION_FILTER].join(", ")}`)
}

function parseStage(raw: string | null): Parsed<FulfillmentStatus | null> {
  if (raw === null) return accept(null)
  const normalized = raw.toUpperCase()
  return (FULFILLMENT_STATUSES as readonly string[]).includes(normalized)
    ? accept(normalized as FulfillmentStatus)
    : refuse(`fulfillmentStatus must be one of: ${FULFILLMENT_STATUSES.join(", ")}`)
}

function parseView(raw: string | null): Parsed<DeliveryListView> {
  const view = raw === null ? "ALL" : raw.toUpperCase()
  return isDeliveryListView(view) ? accept(view) : refuse("view is not a known order list")
}

function parseDeliveredRange(params: URLSearchParams, now: Date): Parsed<{ deliveredFrom: string; deliveredTo: string }> {
  const deliveredTo = readParam(params, "deliveredTo") ?? karachiDay(now)
  const deliveredFrom = readParam(params, "deliveredFrom")
    ?? shiftKarachiDay(deliveredTo, -(DEFAULT_DELIVERED_WINDOW_DAYS - 1))
  if (!isRealDay(deliveredFrom) || !isRealDay(deliveredTo)) {
    return refuse("deliveredFrom and deliveredTo must be dates (YYYY-MM-DD)")
  }
  if (deliveredFrom > deliveredTo) return refuse("deliveredFrom must not be after deliveredTo")
  if (daysBetween(deliveredFrom, deliveredTo) > DELIVERY_MAX_RANGE_DAYS) {
    return refuse(`The delivered range may span at most ${DELIVERY_MAX_RANGE_DAYS} days`)
  }
  return accept({ deliveredFrom, deliveredTo })
}

/**
 * Validate the query string. Every key is known and every value checked;
 * anything else is refused, never ignored, so a typo cannot quietly widen or
 * narrow what management is shown.
 */
export function parseDeliveryDashboardQuery(params: URLSearchParams, now: Date): DeliveryDashboardQueryParse {
  const unknownKey = [...params.keys()].find((key) => !ALLOWED_QUERY_KEYS.has(key))
  if (unknownKey) return refuse(`Unknown filter: ${unknownKey}`)

  const organizationId = parseOptionalId(readParam(params, "organizationId"), "organizationId")
  const branchId = parseOptionalId(readParam(params, "branchId"), "branchId")
  const region = parseRegion(readParam(params, "region"))
  const stage = parseStage(readParam(params, "fulfillmentStatus"))
  const view = parseView(readParam(params, "view"))
  const range = parseDeliveredRange(params, now)
  const city = readParam(params, "city")

  for (const result of [organizationId, branchId, region, stage, view, range]) {
    if (!result.ok) return result
  }
  // Unreachable after the loop; repeated so TypeScript narrows each result.
  if (!organizationId.ok || !branchId.ok || !region.ok || !stage.ok || !view.ok || !range.ok) {
    return refuse("Invalid filters")
  }
  if (branchId.value !== null && organizationId.value === null) return refuse("branchId requires organizationId")
  if (city !== null && city.length > 100) return refuse("city must be 100 characters or less")

  return {
    ok: true,
    filters: {
      organizationId: organizationId.value,
      branchId: branchId.value,
      region: region.value,
      city,
      fulfillmentStatus: stage.value,
      view: view.value,
      ...range.value,
    },
  }
}

// ---------------------------------------------------------------------------
// Building the response
// ---------------------------------------------------------------------------

/** One order as the server reads it. */
export type DeliveryOrderRow = {
  id: number
  tid: string
  organizationId: number
  organizationName: string
  branchId: number
  branchName: string
  branchCity: string | null
  branchRegion: string | null
  deliveryAddressCity: string | null
  status: string
  fulfillmentStatus: string | null
  approvedAt: Date | string | null
  deliveredAt: Date | string | null
}

export type DeliveryListRow = {
  id: number
  tid: string
  organizationId: number
  organizationName: string
  branchId: number
  branchName: string
  region: string
  city: string
  stage: FulfillmentStatus
  stageLabel: string
  approvedAt: string
  promisedAt: string
  deliveredAt: string | null
  health: string
  healthLabel: string
  hoursRemaining: number | null
  hoursOverdue: number | null
  deliveryHours: number | null
}

type Assessed = AssessedDeliveryRow<DeliveryOrderRow & { city: string | null }>

function toListRow(row: Assessed): DeliveryListRow {
  const { assessment } = row
  return {
    id: row.id,
    tid: row.tid,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    branchId: row.branchId,
    branchName: row.branchName,
    region: branchRegionLabel(row.branchRegion),
    city: placeKey(row.city).label,
    stage: assessment.stage,
    stageLabel: FULFILLMENT_STATUS_LABELS[assessment.stage],
    approvedAt: assessment.approvedAt.toISOString(),
    promisedAt: assessment.promisedAt.toISOString(),
    deliveredAt: assessment.deliveredAt?.toISOString() ?? null,
    health: assessment.health,
    healthLabel: DELIVERY_HEALTH_LABELS[assessment.health],
    hoursRemaining: assessment.hoursRemaining,
    hoursOverdue: assessment.hoursOverdue,
    deliveryHours: assessment.deliveryHours,
  }
}

function matchesCity(row: { city: string | null }, wanted: string | null): boolean {
  if (wanted === null) return true
  return placeKey(row.city).key === placeKey(wanted).key
}

/**
 * The whole dashboard from one set of rows. The city filter is applied here,
 * after the destination city is resolved, so it means the same city the tables
 * show; every other filter was applied when the rows were read.
 */
export function buildDeliveryDashboard(input: {
  rows: readonly DeliveryOrderRow[]
  filters: DeliveryDashboardFilters
  now: Date
  truncated: boolean
  organizations: ReadonlyArray<{ id: number; name: string }>
  branches: ReadonlyArray<{ id: number; name: string }>
}) {
  const { filters, now } = input
  const today = karachiDay(now)

  const assessedAll: Assessed[] = []
  for (const row of input.rows) {
    const assessment = assessDelivery(row, now)
    if (!assessment) continue
    assessedAll.push({
      ...row,
      city: destinationCity({ deliveryAddressCity: row.deliveryAddressCity, branchCity: row.branchCity }),
      assessment,
    })
  }

  // Offered before the city filter narrows the rows, so choosing one city never
  // hides the others from the picker.
  // The first spelling seen names the city, as it does in the tables.
  const cityLabels = new Map<string, string>()
  for (const row of assessedAll) {
    const place = placeKey(row.city)
    if (!cityLabels.has(place.key)) cityLabels.set(place.key, place.label)
  }
  const cityOptions = [...cityLabels.values()].sort((a, b) => a.localeCompare(b))

  // The date range applies to every figure on the screen: open orders by the
  // day they were approved, delivered ones by the day they were delivered. An
  // open order approved outside it is not counted, but it is never silently
  // gone — `openOutsideRange` says how many there are.
  const inCity = assessedAll.filter((row) => matchesCity(row, filters.city))
  const assessed = inCity.filter((row) => isInDeliveryDateRange(row.assessment, filters.deliveredFrom, filters.deliveredTo))
  const openOutsideRange = inCity.filter((row) => row.assessment.isOpen
    && !isInDeliveryDateRange(row.assessment, filters.deliveredFrom, filters.deliveredTo)).length
  const assessments = assessed.map((row) => row.assessment)
  const listed = assessed
    .filter((row) => matchesDeliveryListView(row.assessment, filters.view, today))
    .sort(compareByAttention)

  return {
    generatedAt: now.toISOString(),
    sla: {
      hours: DELIVERY_SLA_HOURS,
      dueSoonHours: DUE_SOON_HOURS,
      countsOrdersApprovedFrom: DELIVERY_DASHBOARD_CUTOFF_DAY,
    },
    filters,
    truncated: input.truncated,
    kpis: {
      ...countDeliveries(assessments),
      deliveredToday: countDeliveredOn(assessments, today),
      openOutsideRange,
    },
    alerts: deliveryAlerts(assessments),
    overdueAge: overdueAgeBuckets(assessments),
    pipeline: pipelineCounts(assessments).map((entry) => ({
      ...entry,
      label: FULFILLMENT_STATUS_LABELS[entry.stage],
    })),
    byCity: groupDeliveries(assessed, (row) => placeKey(row.city)),
    byRegion: groupDeliveries(assessed, (row) => {
      const region = normalizeBranchRegion(row.branchRegion)
      return { key: region ?? UNKNOWN_REGION_FILTER, label: branchRegionLabel(region) }
    }),
    byOrganization: groupDeliveries(assessed, (row) => ({ key: String(row.organizationId), label: row.organizationName })),
    byBranch: groupDeliveries(assessed, (row) => ({
      key: String(row.branchId),
      label: `${row.branchName} · ${row.organizationName}`,
    })).slice(0, DELIVERY_BRANCH_LIMIT),
    orders: {
      total: listed.length,
      items: listed.slice(0, DELIVERY_ATTENTION_LIMIT).map(toListRow),
    },
    options: {
      organizations: input.organizations,
      branches: input.branches,
      regions: [...BRANCH_REGIONS.map((region) => ({ value: region, label: branchRegionLabel(region) })), {
        value: UNKNOWN_REGION_FILTER,
        label: branchRegionLabel(null),
      }],
      cities: cityOptions,
      stages: FULFILLMENT_STATUSES.map((stage) => ({ value: stage, label: FULFILLMENT_STATUS_LABELS[stage] })),
    },
  }
}

export type DeliveryDashboardResponse = ReturnType<typeof buildDeliveryDashboard>
