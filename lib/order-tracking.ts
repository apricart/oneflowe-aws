import {
  FULFILLMENT_STATUSES,
  FULFILLMENT_STATUS_LABELS,
  normalizeFulfillmentStatus,
  type FulfillmentStatus,
} from "@/lib/fulfillment-status"
import { FULFILLED_ORDER_STATUSES, normalizeOrderStatus } from "@/lib/order-delivery-status"
import { normalizePaymentStatus } from "@/lib/payment-status"

/**
 * The buyer-facing order tracker, as pure rules
 * (plans/OF-TRACKING-requester-order-tracking.md).
 *
 * An order carries three independent states — `orders.status` (the approval
 * and fulfilment state machine), `orders.fulfillment_status` (where the goods
 * are) and `orders.payment_status` (Paid / Unpaid, toggled by Super Admin).
 * The tracker shows each one on its own card and folds the first two into one
 * journey — placed → approved → in process → out for delivery → delivered →
 * fulfilled — because that is the question a requester asks: where are my
 * goods? Payment stays separate because it moves independently of delivery.
 *
 * Nothing here reads a database, a clock or a session; the server module
 * (`lib/server/order-tracking.ts`) loads the facts and the page renders them.
 */

/** Longest reference the lookup accepts. A TID is 26 characters, an id far fewer. */
export const MAX_TRACKING_REFERENCE_LENGTH = 64

/** How many recent orders the tracking page offers to pick from. */
export const RECENT_TRACKABLE_ORDER_LIMIT = 8

export type TrackingTone = "success" | "info" | "warning" | "danger" | "neutral"
export type TrackingStepState = "complete" | "current" | "upcoming" | "stopped"
export type TrackingStepKey =
  | "placed"
  | "approved"
  | "in_process"
  | "out_for_delivery"
  | "delivered"
  | "fulfilled"
  | "rejected"
  | "cancelled"
  | "refunded"

/** Timestamps are ISO strings (or null) so the same shape crosses to the client. */
export type TrackableOrder = {
  status?: string | null
  fulfillmentStatus?: string | null
  paymentStatus?: string | null
  createdAt?: string | null
  approvedAt?: string | null
  rejectedAt?: string | null
  cancelledAt?: string | null
  returnedForCorrectionAt?: string | null
  /** When the order last entered In Process, from the progress audit trail. */
  inProcessAt?: string | null
  /** When the order last went out for delivery, from the progress audit trail. */
  outForDeliveryAt?: string | null
  deliveredAt?: string | null
  fulfilledAt?: string | null
  paidAt?: string | null
  refundedAt?: string | null
}

export type TrackingStep = {
  key: TrackingStepKey
  label: string
  detail: string
  state: TrackingStepState
  at: string | null
}

export type TrackingStatusCard = {
  label: string
  detail: string
  tone: TrackingTone
  at: string | null
}

export type TrackingStage = { key: string; label: string; reached: boolean; current: boolean }

export type TrackingSummary = {
  order: TrackingStatusCard & { stages: TrackingStage[] }
  payment: TrackingStatusCard & { stages: TrackingStage[] }
  delivery: TrackingStatusCard & { stages: TrackingStage[] }
  /** True once the order can no longer move forward (rejected, cancelled, refunded). */
  stopped: boolean
}

export type TrackingRefund = {
  status: string
  createdAt: string | null
  updatedAt: string | null
}

export type TrackingActivity = {
  key: string
  label: string
  at: string
  tone: TrackingTone
}

export type TrackedOrderItem = {
  productName: string
  productCode: string | null
  unit: string
  quantity: number
}

/** What `GET /api/v1/order-tracking` answers. No person is named. */
export type TrackedOrderView = TrackableOrder & {
  id: number
  tid: string
  status: string
  fulfillmentStatus: string
  paymentStatus: string
  branchName: string | null
  deliveryAddress: string | null
  poNumber: string | null
  isGroupOrder: boolean
  /** Null when the caller's organization hides prices from its role. */
  totalCents: number | null
  rejectionReason: string | null
  cancellationReason: string | null
  correctionRequestNote: string | null
  refunds: TrackingRefund[]
  items: TrackedOrderItem[]
}

/** One row of the "recent orders" picker. */
export type RecentTrackableOrder = {
  id: number
  tid: string
  status: string
  fulfillmentStatus: string
  paymentStatus: string
  branchName: string | null
  createdAt: string | null
}

const STOPPED_STATUSES = new Set(["REJECTED", "CANCELLED", "REFUNDED"])

function isFulfilledStatus(status: string): boolean {
  return (FULFILLED_ORDER_STATUSES as readonly string[]).includes(status)
}

function deliveryIndex(status: FulfillmentStatus): number {
  return FULFILLMENT_STATUSES.indexOf(status)
}

/**
 * Parses what a requester typed: an order id ("2251", "#2251") or a transaction
 * id. Returns null for anything that cannot be either, so the route refuses it
 * with 400 rather than querying with it.
 */
export function parseTrackingReference(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const value = raw.trim().replace(/^#/, "").trim()
  if (!value || value.length > MAX_TRACKING_REFERENCE_LENGTH) return null
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null
}

/** The order id a reference names, when it is a positive whole number. */
export function trackingReferenceOrderId(reference: string): number | null {
  if (!/^\d{1,15}$/.test(reference)) return null
  const id = Number(reference)
  return Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null
}

/** Where an order has got to, read once and shared by the steps and the cards. */
function milestones(order: TrackableOrder) {
  const status = normalizeOrderStatus(order.status)
  const delivery = normalizeFulfillmentStatus(order.fulfillmentStatus)
  const pending = status === "PENDING"
  return {
    status,
    delivery,
    stage: deliveryIndex(delivery),
    pending,
    approved: !pending && (Boolean(order.approvedAt) || status === "APPROVED" || isFulfilledStatus(status)),
    fulfilled: isFulfilledStatus(status) || (status === "REFUNDED" && Boolean(order.fulfilledAt)),
    returned: pending && Boolean(order.returnedForCorrectionAt),
  }
}

function approvalDetail(approved: boolean, returned: boolean): string {
  if (approved) return "Approved by your approver"
  return returned ? "Returned for correction — update and resubmit it" : "Awaiting approval"
}

function processDetail(reached: boolean, approved: boolean): string {
  if (reached) return "Being prepared at the warehouse"
  return approved ? "Not started yet — waiting for the warehouse" : "Starts once the order is approved"
}

function fulfilmentDetail(fulfilled: boolean, delivered: boolean): string {
  if (fulfilled) return "Receipt confirmed — order complete"
  return delivered ? "Awaiting receipt confirmation" : "Completes after delivery"
}

/**
 * The progress steps an order has, ignoring any stop. Each step is complete
 * when the order has reached it; the last reached one is `current` unless the
 * journey is finished. The detail on the step after it says what is awaited.
 */
function progressSteps(order: TrackableOrder): TrackingStep[] {
  const { stage, approved, fulfilled, returned } = milestones(order)
  const inProcess = approved && stage >= deliveryIndex("IN_PROCESS")
  const outForDelivery = approved && stage >= deliveryIndex("OUT_FOR_DELIVERY")
  const delivered = approved && stage >= deliveryIndex("DELIVERED")
  const when = (reached: boolean, at: string | null | undefined) => (reached ? at ?? null : null)

  const steps: (Omit<TrackingStep, "state"> & { reached: boolean })[] = [
    { key: "placed", label: "Order placed", detail: "Your order was received", at: order.createdAt ?? null, reached: true },
    { key: "approved", label: "Approved", detail: approvalDetail(approved, returned), at: when(approved, order.approvedAt), reached: approved },
    { key: "in_process", label: "In process", detail: processDetail(inProcess, approved), at: when(inProcess, order.inProcessAt), reached: inProcess },
    {
      key: "out_for_delivery",
      label: "Out for delivery",
      detail: outForDelivery ? "On the way to your branch" : "Waiting for dispatch",
      at: when(outForDelivery, order.outForDeliveryAt),
      reached: outForDelivery,
    },
    {
      key: "delivered",
      label: "Delivered",
      detail: delivered ? "Delivered to your branch" : "Waiting for delivery",
      at: when(delivered, order.deliveredAt),
      reached: delivered,
    },
    { key: "fulfilled", label: "Fulfilled", detail: fulfilmentDetail(fulfilled, delivered), at: when(fulfilled, order.fulfilledAt), reached: fulfilled },
  ]

  const lastReached = steps.reduce((last, step, index) => (step.reached ? index : last), 0)
  return steps.map(({ reached: _reached, ...step }, index) => {
    let state: TrackingStepState = "complete"
    if (index > lastReached) state = "upcoming"
    else if (index === lastReached && !fulfilled) state = "current"
    return { ...step, state }
  })
}

type DatedField = "rejectedAt" | "cancelledAt" | "refundedAt" | "inProcessAt" | "outForDeliveryAt" | "deliveredAt"

const STOP_STEPS: Record<string, { key: TrackingStepKey; label: string; detail: string; at: DatedField }> = {
  REJECTED: { key: "rejected", label: "Rejected", detail: "This order will not be delivered", at: "rejectedAt" },
  CANCELLED: { key: "cancelled", label: "Cancelled", detail: "This order was withdrawn", at: "cancelledAt" },
  REFUNDED: { key: "refunded", label: "Refunded", detail: "This order was refunded in full", at: "refundedAt" },
}

/**
 * The journey shown as connected steps. A rejected, cancelled or refunded
 * order keeps the steps it actually reached and ends on a stop marker, rather
 * than showing a delivery that will never happen as merely "upcoming".
 */
export function getOrderTrackingSteps(order: TrackableOrder): TrackingStep[] {
  const steps = progressSteps(order)
  const stop = STOP_STEPS[normalizeOrderStatus(order.status)]
  if (!stop) return steps

  const kept: TrackingStep[] = steps
    .filter((step) => step.state !== "upcoming")
    .map((step) => ({ ...step, state: "complete" }))
  kept.push({ key: stop.key, label: stop.label, detail: stop.detail, state: "stopped", at: order[stop.at] ?? null })
  return kept
}

function orderCard(order: TrackableOrder): TrackingStatusCard {
  const status = normalizeOrderStatus(order.status)
  if (status === "PENDING") {
    return order.returnedForCorrectionAt
      ? { label: "Returned for correction", detail: "Your approver asked for changes", tone: "warning", at: order.returnedForCorrectionAt }
      : { label: "Pending approval", detail: "Waiting for your approver", tone: "warning", at: order.createdAt ?? null }
  }
  if (status === "APPROVED") return { label: "Approved", detail: "Moving through delivery", tone: "info", at: order.approvedAt ?? null }
  if (status === "FULFILLED") return { label: "Fulfilled", detail: "Receipt confirmed", tone: "success", at: order.fulfilledAt ?? null }
  if (isFulfilledStatus(status)) return { label: "Partially fulfilled", detail: "Part of the order was fulfilled", tone: "success", at: order.fulfilledAt ?? null }
  if (status === "REJECTED") return { label: "Rejected", detail: "Your approver declined this order", tone: "danger", at: order.rejectedAt ?? null }
  if (status === "CANCELLED") return { label: "Cancelled", detail: "This order was withdrawn", tone: "danger", at: order.cancelledAt ?? null }
  if (status === "REFUNDED") return { label: "Refunded", detail: "This order was refunded in full", tone: "neutral", at: order.refundedAt ?? null }
  return { label: status ? status.charAt(0) + status.slice(1).toLowerCase() : "Unknown", detail: "", tone: "neutral", at: null }
}

function orderStages(order: TrackableOrder): TrackingStage[] {
  const { status, approved, fulfilled } = milestones(order)
  const stop = STOP_STEPS[status]
  if (stop) {
    return [
      { key: "PENDING", label: "Pending", reached: true, current: false },
      ...(approved ? [{ key: "APPROVED", label: "Approved", reached: true, current: false }] : []),
      ...(fulfilled ? [{ key: "FULFILLED", label: "Fulfilled", reached: true, current: false }] : []),
      { key: status, label: stop.label, reached: true, current: true },
    ]
  }
  return [
    { key: "PENDING", label: "Pending", reached: true, current: !approved },
    { key: "APPROVED", label: "Approved", reached: approved, current: approved && !fulfilled },
    { key: "FULFILLED", label: "Fulfilled", reached: fulfilled, current: fulfilled },
  ]
}

function paymentCard(order: TrackableOrder, neverDelivered: boolean): TrackingSummary["payment"] {
  const paid = normalizePaymentStatus(order.paymentStatus) === "PAID"
  const stages: TrackingStage[] = [
    { key: "UNPAID", label: "Unpaid", reached: true, current: !paid },
    { key: "PAID", label: "Paid", reached: paid, current: paid },
  ]
  if (paid) return { label: "Paid", detail: "Payment received", tone: "success", at: order.paidAt ?? null, stages }
  if (neverDelivered) {
    const unreached = stages.map((stage) => ({ ...stage, reached: false, current: false }))
    return { label: "Not applicable", detail: "No payment is due on this order", tone: "neutral", at: null, stages: unreached }
  }
  return { label: "Unpaid", detail: "Payment not yet received", tone: "warning", at: null, stages }
}

const DELIVERY_CARD: Record<FulfillmentStatus, { detail: string; tone: TrackingTone; at: DatedField | null }> = {
  NOT_STARTED: { detail: "Waiting for the warehouse to begin", tone: "neutral", at: null },
  IN_PROCESS: { detail: "Being prepared at the warehouse", tone: "info", at: "inProcessAt" },
  OUT_FOR_DELIVERY: { detail: "On the way to your branch", tone: "info", at: "outForDeliveryAt" },
  DELIVERED: { detail: "Goods reached your branch", tone: "success", at: "deliveredAt" },
}

function deliveryCard(order: TrackableOrder, neverDelivered: boolean): TrackingSummary["delivery"] {
  const { delivery, stage, pending } = milestones(order)
  const stages: TrackingStage[] = FULFILLMENT_STATUSES.map((key, index) => ({
    key,
    label: FULFILLMENT_STATUS_LABELS[key],
    reached: !neverDelivered && index <= stage,
    current: !neverDelivered && index === stage,
  }))
  if (neverDelivered) return { label: "Not proceeding", detail: "This order will not be delivered", tone: "neutral", at: null, stages }
  const card = DELIVERY_CARD[delivery]
  return {
    label: FULFILLMENT_STATUS_LABELS[delivery],
    detail: pending && delivery === "NOT_STARTED" ? "Starts once the order is approved" : card.detail,
    tone: card.tone,
    at: card.at ? order[card.at] ?? null : null,
    stages,
  }
}

/**
 * The three status cards: order, payment (Unpaid → Paid) and delivery
 * (Not started → In process → Out for delivery → Delivered). Each card carries
 * every stage it can be in, so the page can show the whole scale, not just the
 * current word.
 */
export function getTrackingSummary(order: TrackableOrder): TrackingSummary {
  const status = normalizeOrderStatus(order.status)
  const neverDelivered = status === "REJECTED" || status === "CANCELLED"
  return {
    order: { ...orderCard(order), stages: orderStages(order) },
    payment: paymentCard(order, neverDelivered),
    delivery: deliveryCard(order, neverDelivered),
    stopped: STOPPED_STATUSES.has(status),
  }
}

/**
 * Everything that has happened to the order, newest first. Each entry is a
 * fact with a timestamp on the order row, its progress trail or a refund row;
 * a stage the order skipped or a time nobody recorded is simply absent.
 */
export function getOrderTrackingActivity(order: TrackableOrder, refunds: readonly TrackingRefund[] = []): TrackingActivity[] {
  const events: TrackingActivity[] = []
  const push = (key: string, label: string, at: string | null | undefined, tone: TrackingTone) => {
    if (at && !Number.isNaN(new Date(at).getTime())) events.push({ key, label, at, tone })
  }

  push("placed", "Order placed", order.createdAt, "neutral")
  push("returned", "Returned for correction", order.returnedForCorrectionAt, "warning")
  push("approved", "Order approved", order.approvedAt, "info")
  push("rejected", "Order rejected", order.rejectedAt, "danger")
  push("cancelled", "Order cancelled", order.cancelledAt, "danger")
  push("in_process", "Processing started", order.inProcessAt, "info")
  push("out_for_delivery", "Out for delivery", order.outForDeliveryAt, "info")
  push("delivered", "Delivered", order.deliveredAt, "success")
  push("fulfilled", "Receipt confirmed — fulfilled", order.fulfilledAt, "success")
  if (normalizePaymentStatus(order.paymentStatus) === "PAID") push("paid", "Payment marked as paid", order.paidAt, "success")
  refunds.forEach((refund, index) => {
    push(`refund-${index}-requested`, "Refund requested", refund.createdAt, "warning")
    const refundStatus = String(refund.status || "").toUpperCase()
    if (refundStatus === "APPROVED") push(`refund-${index}-approved`, "Refund approved", refund.updatedAt, "neutral")
    if (refundStatus === "REJECTED") push(`refund-${index}-rejected`, "Refund request declined", refund.updatedAt, "neutral")
  })
  push("refunded", "Order refunded", order.refundedAt, "neutral")

  return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}

/**
 * The latest time the order entered each delivery stage, from its progress
 * audit rows (`ORDER_FULFILLMENT_STATUS_UPDATE`, metadata `to`). A stage beyond
 * the order's current one is dropped, so a reverted step never shows as done.
 */
export function stageTimesFromTrail(
  trail: readonly { to: unknown; at: Date | string | null }[],
  currentStatus: string | null | undefined,
): Partial<Record<FulfillmentStatus, string>> {
  const current = deliveryIndex(normalizeFulfillmentStatus(currentStatus))
  const times: Partial<Record<FulfillmentStatus, string>> = {}
  for (const entry of trail) {
    if (!entry.at || typeof entry.to !== "string") continue
    const to = entry.to.trim().toUpperCase() as FulfillmentStatus
    if (!FULFILLMENT_STATUSES.includes(to) || deliveryIndex(to) > current) continue
    const at = new Date(entry.at)
    if (Number.isNaN(at.getTime())) continue
    const iso = at.toISOString()
    if (!times[to] || iso > times[to]) times[to] = iso
  }
  return times
}
