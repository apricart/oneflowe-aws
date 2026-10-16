import { normalizeFulfillmentStatus, type FulfillmentStatus } from "@/lib/fulfillment-status"
import { FULFILLED_ORDER_STATUSES, normalizeOrderStatus } from "@/lib/order-delivery-status"

/**
 * Delivery SLA rules for the management delivery dashboard, in one place.
 * See plans/OF-DELIVERY-management-delivery-dashboard.md.
 *
 * Health is **computed, never stored**: it changes with the clock. Every
 * figure on the dashboard — the KPI cards, the attention list, the city,
 * region and branch tables, the pipeline and the order timeline — is derived
 * from `assessDelivery`, so no two of them can disagree.
 *
 * Pure: no database, no request. The server reads the rows; this decides what
 * they mean.
 */

/** The delivery promise: calendar hours from approval to delivery. */
export const DELIVERY_SLA_HOURS = 72

/** An open order is "due soon" in the last this-many hours before its deadline. */
export const DUE_SOON_HOURS = 24

/**
 * Orders approved before this instant are not counted. Older orders' stage
 * timings predate this dashboard and would show invented delays.
 * 2026-09-01 00:00 Asia/Karachi.
 */
export const DELIVERY_DASHBOARD_CUTOFF_DAY = "2026-09-01"
export const DELIVERY_DASHBOARD_CUTOFF_AT = new Date(`${DELIVERY_DASHBOARD_CUTOFF_DAY}T00:00:00.000+05:00`)

/** How many days of deliveries the dashboard reports on when no range is chosen. */
export const DEFAULT_DELIVERED_WINDOW_DAYS = 30

const HOUR_MS = 60 * 60 * 1000

export const DELIVERY_HEALTHS = [
  "ON_TRACK",
  "DUE_SOON",
  "OVERDUE",
  "DELIVERED_ON_TIME",
  "DELIVERED_LATE",
  "DELIVERED_UNTIMED",
] as const

export type DeliveryHealth = (typeof DELIVERY_HEALTHS)[number]

export const OPEN_DELIVERY_HEALTHS: readonly DeliveryHealth[] = ["ON_TRACK", "DUE_SOON", "OVERDUE"]

export const DELIVERY_HEALTH_LABELS: Record<DeliveryHealth, string> = {
  ON_TRACK: "On Track",
  DUE_SOON: "Due Soon",
  OVERDUE: "Overdue",
  DELIVERED_ON_TIME: "Delivered On Time",
  DELIVERED_LATE: "Delivered Late",
  // Delivered, but the moment was never recorded. Counted as delivered; left
  // out of every duration and on-time figure rather than guessed.
  DELIVERED_UNTIMED: "Delivered (time unknown)",
}

/** The open stages the pipeline reports, in the order goods move through them. */
export const OPEN_PIPELINE_STAGES: readonly Exclude<FulfillmentStatus, "DELIVERED">[] = [
  "NOT_STARTED",
  "IN_PROCESS",
  "OUT_FOR_DELIVERY",
]

export type DeliveryOrderInput = {
  status: string | null | undefined
  fulfillmentStatus: string | null | undefined
  approvedAt: Date | string | null | undefined
  deliveredAt: Date | string | null | undefined
}

export type DeliveryAssessment = {
  health: DeliveryHealth
  isOpen: boolean
  /** Delivered and settled as fulfilled: the branch acknowledged receipt (or the 48-hour sweep did). */
  acknowledged: boolean
  stage: FulfillmentStatus
  approvedAt: Date
  promisedAt: Date
  deliveredAt: Date | null
  /** Open and not yet late: hours until the deadline. */
  hoursRemaining: number | null
  /** Open and late, or delivered late: hours past the deadline. */
  hoursOverdue: number | null
  /** Delivered with a recorded time: approval to delivery. */
  deliveryHours: number | null
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Hours, to one decimal place, so a figure on screen reads the same as one in an export. */
function hoursBetween(from: Date, to: Date): number {
  return Math.round(((to.getTime() - from.getTime()) / HOUR_MS) * 10) / 10
}

export function promisedDeliveryAt(approvedAt: Date): Date {
  return new Date(approvedAt.getTime() + DELIVERY_SLA_HOURS * HOUR_MS)
}

function isFulfilledStatus(status: string): boolean {
  return (FULFILLED_ORDER_STATUSES as readonly string[]).includes(status)
}

/**
 * Where one order stands against its delivery promise, or null when it is not
 * delivery work at all: not yet approved, rejected, cancelled, refunded, or
 * missing its approval time.
 *
 *   * open      = APPROVED and the goods have not arrived
 *   * delivered = fulfilment status DELIVERED, or settled as fulfilled
 */
export function assessDelivery(order: DeliveryOrderInput, now: Date): DeliveryAssessment | null {
  const status = normalizeOrderStatus(order.status)
  const approvedAt = toDate(order.approvedAt)
  if (!approvedAt) return null
  if (status !== "APPROVED" && !isFulfilledStatus(status)) return null

  const stage = normalizeFulfillmentStatus(order.fulfillmentStatus)
  const promisedAt = promisedDeliveryAt(approvedAt)
  const delivered = stage === "DELIVERED" || isFulfilledStatus(status)

  if (delivered) {
    const deliveredAt = toDate(order.deliveredAt)
    const acknowledged = isFulfilledStatus(status)
    if (!deliveredAt) {
      return {
        health: "DELIVERED_UNTIMED",
        isOpen: false,
        acknowledged,
        stage: "DELIVERED",
        approvedAt,
        promisedAt,
        deliveredAt: null,
        hoursRemaining: null,
        hoursOverdue: null,
        deliveryHours: null,
      }
    }
    const late = deliveredAt.getTime() > promisedAt.getTime()
    return {
      health: late ? "DELIVERED_LATE" : "DELIVERED_ON_TIME",
      isOpen: false,
      acknowledged,
      stage: "DELIVERED",
      approvedAt,
      promisedAt,
      deliveredAt,
      hoursRemaining: null,
      hoursOverdue: late ? hoursBetween(promisedAt, deliveredAt) : null,
      deliveryHours: hoursBetween(approvedAt, deliveredAt),
    }
  }

  const msRemaining = promisedAt.getTime() - now.getTime()
  if (msRemaining < 0) {
    return {
      health: "OVERDUE",
      isOpen: true,
      acknowledged: false,
      stage,
      approvedAt,
      promisedAt,
      deliveredAt: null,
      hoursRemaining: null,
      hoursOverdue: hoursBetween(promisedAt, now),
      deliveryHours: null,
    }
  }
  return {
    health: msRemaining <= DUE_SOON_HOURS * HOUR_MS ? "DUE_SOON" : "ON_TRACK",
    isOpen: true,
    acknowledged: false,
    stage,
    approvedAt,
    promisedAt,
    deliveredAt: null,
    hoursRemaining: hoursBetween(now, promisedAt),
    hoursOverdue: null,
    deliveryHours: null,
  }
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

const karachiDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Karachi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/** The Asia/Karachi calendar day, `YYYY-MM-DD`. */
export function karachiDay(date: Date): string {
  return karachiDayFormatter.format(date)
}

/** Midnight at the start of a Karachi day, as an instant. */
export function karachiDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000+05:00`)
}

/** The last millisecond of a Karachi day, as an instant. */
export function karachiDayEnd(day: string): Date {
  return new Date(`${day}T23:59:59.999+05:00`)
}

/** The Karachi day `days` before the given one (Pakistan has no daylight saving). */
export function shiftKarachiDay(day: string, days: number): string {
  return karachiDay(new Date(karachiDayStart(day).getTime() + days * 24 * HOUR_MS + HOUR_MS))
}

/**
 * Whether an order falls inside the dashboard's date range (Karachi days,
 * inclusive): an open order by the day it was approved, a delivered one by the
 * day it was delivered. A delivered order with no recorded time has no day and
 * is never inside a range — the read leaves it out for the same reason.
 */
export function isInDeliveryDateRange(assessment: DeliveryAssessment, from: string, to: string): boolean {
  const at = assessment.isOpen ? assessment.approvedAt : assessment.deliveredAt
  if (!at) return false
  const day = karachiDay(at)
  return day >= from && day <= to
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export type AssessedDeliveryRow<T> = T & { assessment: DeliveryAssessment }

export type DeliveryCounts = {
  open: number
  onTrack: number
  dueSoon: number
  overdue: number
  delivered: number
  deliveredOnTime: number
  deliveredLate: number
  deliveredUntimed: number
  /** Open orders by the stage the goods are at; they add up to `open`. */
  notStarted: number
  inProcess: number
  outForDelivery: number
  /** Delivered orders the branch has not yet acknowledged; with `acknowledged` they add up to `delivered`. */
  awaitingAcknowledgement: number
  acknowledged: number
  /** Delivered on time over delivered with a recorded time, 0–100, or null with none. */
  onTimeRate: number | null
  /** Mean approval-to-delivery hours over delivered orders with a recorded time. */
  averageDeliveryHours: number | null
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
}

type StatusCountKey = "notStarted" | "inProcess" | "outForDelivery" | "awaitingAcknowledgement" | "acknowledged"

const OPEN_STAGE_COUNT_KEYS: Record<(typeof OPEN_PIPELINE_STAGES)[number], StatusCountKey> = {
  NOT_STARTED: "notStarted",
  IN_PROCESS: "inProcess",
  OUT_FOR_DELIVERY: "outForDelivery",
}

/** The one order-status count an assessment adds to: its open stage, or whether its delivery was acknowledged. */
function statusCountKey(assessment: DeliveryAssessment): StatusCountKey {
  if (!assessment.isOpen) return assessment.acknowledged ? "acknowledged" : "awaitingAcknowledgement"
  // An open order is never at DELIVERED; the fallback only satisfies the type.
  return assessment.stage === "DELIVERED" ? "outForDelivery" : OPEN_STAGE_COUNT_KEYS[assessment.stage]
}

export function countDeliveries(assessments: readonly DeliveryAssessment[]): DeliveryCounts {
  const counts = {
    open: 0,
    onTrack: 0,
    dueSoon: 0,
    overdue: 0,
    delivered: 0,
    deliveredOnTime: 0,
    deliveredLate: 0,
    deliveredUntimed: 0,
    notStarted: 0,
    inProcess: 0,
    outForDelivery: 0,
    awaitingAcknowledgement: 0,
    acknowledged: 0,
  }
  const durations: number[] = []
  for (const assessment of assessments) {
    switch (assessment.health) {
      case "ON_TRACK":
        counts.onTrack += 1
        break
      case "DUE_SOON":
        counts.dueSoon += 1
        break
      case "OVERDUE":
        counts.overdue += 1
        break
      case "DELIVERED_ON_TIME":
        counts.deliveredOnTime += 1
        break
      case "DELIVERED_LATE":
        counts.deliveredLate += 1
        break
      case "DELIVERED_UNTIMED":
        counts.deliveredUntimed += 1
        break
    }
    counts[assessment.isOpen ? "open" : "delivered"] += 1
    counts[statusCountKey(assessment)] += 1
    if (assessment.deliveryHours !== null) durations.push(assessment.deliveryHours)
  }
  const timed = counts.deliveredOnTime + counts.deliveredLate
  return {
    ...counts,
    onTimeRate: timed === 0 ? null : Math.round((counts.deliveredOnTime / timed) * 1000) / 10,
    averageDeliveryHours: average(durations),
  }
}

/** Deliveries recorded on the given Karachi day. */
export function countDeliveredOn(assessments: readonly DeliveryAssessment[], day: string): number {
  return assessments.filter((assessment) => assessment.deliveredAt && karachiDay(assessment.deliveredAt) === day).length
}

export const OVERDUE_AGE_BUCKETS = [
  { key: "0-12", label: "0–12 hours", minHours: 0, maxHours: 12 },
  { key: "12-24", label: "12–24 hours", minHours: 12, maxHours: 24 },
  { key: "24-48", label: "24–48 hours", minHours: 24, maxHours: 48 },
  { key: "48-72", label: "48–72 hours", minHours: 48, maxHours: 72 },
  { key: "72+", label: "72+ hours", minHours: 72, maxHours: Number.POSITIVE_INFINITY },
] as const

/** Open overdue orders by how late they are; each order lands in exactly one bucket. */
export function overdueAgeBuckets(assessments: readonly DeliveryAssessment[]) {
  return OVERDUE_AGE_BUCKETS.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    count: assessments.filter((assessment) => assessment.health === "OVERDUE"
      && (assessment.hoursOverdue ?? 0) >= bucket.minHours
      && (assessment.hoursOverdue ?? 0) < bucket.maxHours).length,
  }))
}

/** Open orders by the stage the goods are at. */
export function pipelineCounts(assessments: readonly DeliveryAssessment[]) {
  return OPEN_PIPELINE_STAGES.map((stage) => ({
    stage,
    count: assessments.filter((assessment) => assessment.isOpen && assessment.stage === stage).length,
  }))
}

/** The in-dashboard alerts, worst first. */
export function deliveryAlerts(assessments: readonly DeliveryAssessment[]) {
  const overdue = assessments.filter((assessment) => assessment.health === "OVERDUE")
  return {
    overdue: overdue.length,
    overdueOver24Hours: overdue.filter((assessment) => (assessment.hoursOverdue ?? 0) >= 24).length,
    overdueOver72Hours: overdue.filter((assessment) => (assessment.hoursOverdue ?? 0) >= 72).length,
    dueSoon: assessments.filter((assessment) => assessment.health === "DUE_SOON").length,
  }
}

const ATTENTION_RANK: Record<DeliveryHealth, number> = {
  OVERDUE: 0,
  DUE_SOON: 1,
  ON_TRACK: 2,
  DELIVERED_LATE: 3,
  DELIVERED_ON_TIME: 4,
  DELIVERED_UNTIMED: 5,
}

/**
 * Most urgent first: the most overdue, then the closest to their deadline, then
 * everything still open by deadline, then delivered orders newest first. Ties
 * fall back to the earlier deadline, then the order id, so the order is stable.
 */
export function compareByAttention<T extends { id: number; assessment: DeliveryAssessment }>(a: T, b: T): number {
  const rank = ATTENTION_RANK[a.assessment.health] - ATTENTION_RANK[b.assessment.health]
  if (rank !== 0) return rank
  if (a.assessment.health === "OVERDUE") {
    const late = (b.assessment.hoursOverdue ?? 0) - (a.assessment.hoursOverdue ?? 0)
    if (late !== 0) return late
  }
  if (!a.assessment.isOpen) {
    const delivered = (b.assessment.deliveredAt?.getTime() ?? 0) - (a.assessment.deliveredAt?.getTime() ?? 0)
    if (delivered !== 0) return delivered
  }
  const deadline = a.assessment.promisedAt.getTime() - b.assessment.promisedAt.getTime()
  if (deadline !== 0) return deadline
  return a.id - b.id
}

/** Newest order first: the latest approval at the top, then the higher order id. */
export function compareNewestFirst<T extends { id: number; assessment: DeliveryAssessment }>(a: T, b: T): number {
  const approved = b.assessment.approvedAt.getTime() - a.assessment.approvedAt.getTime()
  if (approved !== 0) return approved
  return b.id - a.id
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export type DeliveryGroupRow = DeliveryCounts & { key: string; label: string }

/**
 * One row per group, worst first (most overdue, then most open). `keyOf`
 * returns the grouping key and its display label; rows sharing a key share a
 * group whatever case or spacing their label was typed with.
 */
export function groupDeliveries<T>(
  rows: readonly AssessedDeliveryRow<T>[],
  keyOf: (row: AssessedDeliveryRow<T>) => { key: string; label: string },
): DeliveryGroupRow[] {
  const groups = new Map<string, { label: string; assessments: DeliveryAssessment[] }>()
  for (const row of rows) {
    const { key, label } = keyOf(row)
    const group = groups.get(key) ?? { label, assessments: [] }
    group.assessments.push(row.assessment)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, label: group.label, ...countDeliveries(group.assessments) }))
    .sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.label.localeCompare(b.label))
}

/** The grouping key for free-text place names: trimmed, case-insensitive; blank is Unknown. */
export const UNKNOWN_PLACE_KEY = "unknown"

export function placeKey(value: string | null | undefined): { key: string; label: string } {
  const label = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : ""
  return label ? { key: label.toLowerCase(), label } : { key: UNKNOWN_PLACE_KEY, label: "Unknown" }
}

/**
 * Where an order is being delivered: the approved delivery address's city when
 * the order was sent somewhere other than its branch, else the branch's city.
 */
export function destinationCity(input: {
  deliveryAddressCity: string | null | undefined
  branchCity: string | null | undefined
}): string | null {
  const address = input.deliveryAddressCity?.trim()
  if (address) return address
  const branch = input.branchCity?.trim()
  return branch || null
}

// ---------------------------------------------------------------------------
// List filters
// ---------------------------------------------------------------------------

/** What a KPI card or the health filter narrows the order list to. */
export const DELIVERY_LIST_VIEWS = [
  "ALL",
  "OPEN",
  "ON_TRACK",
  "DUE_SOON",
  "OVERDUE",
  "DELIVERED",
  "DELIVERED_LATE",
  "DELIVERED_TODAY",
  "NOT_STARTED",
  "IN_PROCESS",
  "OUT_FOR_DELIVERY",
  "AWAITING_ACKNOWLEDGEMENT",
  "ACKNOWLEDGED",
] as const

export type DeliveryListView = (typeof DELIVERY_LIST_VIEWS)[number]

export function isDeliveryListView(value: unknown): value is DeliveryListView {
  return typeof value === "string" && (DELIVERY_LIST_VIEWS as readonly string[]).includes(value)
}

export function matchesDeliveryListView(assessment: DeliveryAssessment, view: DeliveryListView, today: string): boolean {
  switch (view) {
    case "ALL":
      return true
    case "OPEN":
      return assessment.isOpen
    case "DELIVERED":
      return !assessment.isOpen
    case "DELIVERED_TODAY":
      return Boolean(assessment.deliveredAt && karachiDay(assessment.deliveredAt) === today)
    case "NOT_STARTED":
    case "IN_PROCESS":
    case "OUT_FOR_DELIVERY":
      return assessment.isOpen && assessment.stage === view
    case "AWAITING_ACKNOWLEDGEMENT":
      return !assessment.isOpen && !assessment.acknowledged
    case "ACKNOWLEDGED":
      return assessment.acknowledged
    default:
      return assessment.health === view
  }
}
