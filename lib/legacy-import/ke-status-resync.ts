/**
 * Re-state already-imported K-Electric orders from the legacy platform's
 * *current* delivery status.
 *
 * `import-ke-orders.ts` writes an order once and never revisits it —
 * `ALREADY_IMPORTED` is a skip reason, not a comparison. That is correct for an
 * importer, but it means an order imported while it was still being picked stays
 * `APPROVED/NOT_STARTED` in OneFlowe forever, long after legacy marked it
 * delivered. Eighty-two K-Electric orders are in exactly that position.
 *
 * This module decides, for one order at a time, whether legacy's present view
 * should replace ours. It is pure: the script supplies rows and performs the
 * write.
 *
 * Three rules keep it from doing harm, and each exists because of a case that
 * really occurs in the data:
 *
 *  1. **A refund is ours, not legacy's.** `RefundPrice` from the legacy API was
 *     found to be unusable per order and is deliberately not imported (see
 *     `scripts/clear-ke-unsubstantiated-refunds.ts`); the refunds OneFlowe holds
 *     came from a separately reconciled source. So legacy does not know an order
 *     was refunded, and reports it as merely delivered. Legacy order 619 is that
 *     case. Restating it would erase a refund on legacy's say-so, so an order
 *     that is `REFUNDED` here is never touched.
 *
 *  2. **Fulfilment does not run backwards.** Legacy order 1155 is `FULFILLED`
 *     here and `Out For Delivery` there. Whatever that means at K-Electric, it
 *     is not something to apply unattended, so any transition that moves an
 *     order earlier in its lifecycle is reported for a human and excluded.
 *
 *  3. **Only live orders.** A legacy row that is now cancelled, draft or a test
 *     order says nothing about an order OneFlowe already holds; those are
 *     reported and left alone rather than being reinterpreted.
 */

import {
  LEGACY_STATUS_LIVE,
  mapDeliveryStatus,
  type StatusMapping,
} from "./ke-orders-api"
import type { TargetFulfillmentStatus, TargetOrderStatus } from "./ke-post-cutoff"

/** An order as OneFlowe currently holds it. */
export interface CurrentOrder {
  orderId: number
  legacyOrderId: number
  status: string
  fulfillmentStatus: string | null
  refundAmountCents: number | null
}

/** The header legacy returns for that order today. */
export interface LegacyStatusRow {
  legacyOrderId: number
  legacyStatusId: number
  deliveryStatus: number
}

export interface StatusChange {
  orderId: number
  legacyOrderId: number
  fromStatus: string
  fromFulfillmentStatus: string | null
  toStatus: TargetOrderStatus
  toFulfillmentStatus: TargetFulfillmentStatus
  deliveryStatus: number
}

export type StatusHoldReason =
  /** Refunded in OneFlowe; legacy has no refund concept we trust. */
  | "REFUNDED_LOCALLY"
  /** Legacy would move the order earlier in its lifecycle. */
  | "BACKWARD_TRANSITION"
  /** The legacy row is cancelled, a draft, or a test order. */
  | "LEGACY_NOT_LIVE"
  /** Legacy reports a delivery status this importer has no mapping for. */
  | "UNMAPPED_DELIVERY_STATUS"

export interface StatusHold {
  orderId: number
  legacyOrderId: number
  reason: StatusHoldReason
  currentStatus: string
  currentFulfillmentStatus: string | null
  legacyStatusId: number
  deliveryStatus: number
  legacyMeans: string | null
}

export interface StatusResyncPlan {
  changes: StatusChange[]
  holds: StatusHold[]
  /** Orders already agreeing with legacy. Counted, never listed. */
  unchanged: number
  /** Imported orders legacy no longer returns at all. */
  missingFromLegacy: number[]
}

/**
 * How far through its lifecycle an order is.
 *
 * Rank compares a (status, fulfilment) pair as one number so "APPROVED /
 * OUT_FOR_DELIVERY -> FULFILLED / DELIVERED" reads as forward and the reverse
 * reads as backward. Only the states this importer can produce are ranked;
 * anything else returns null and is treated as not comparable, which routes the
 * order to a human rather than through an unverified comparison.
 */
const FULFILLMENT_RANK: Record<string, number> = {
  NOT_STARTED: 0,
  IN_PROCESS: 1,
  OUT_FOR_DELIVERY: 2,
  DELIVERED: 3,
}

const STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  APPROVED: 1,
  FULFILLED: 2,
}

export function lifecycleRank(status: string, fulfillmentStatus: string | null): number | null {
  const statusRank = STATUS_RANK[String(status ?? "").toUpperCase()]
  if (statusRank === undefined) return null
  const fulfillment = String(fulfillmentStatus ?? "NOT_STARTED").toUpperCase()
  const fulfillmentRank = FULFILLMENT_RANK[fulfillment]
  if (fulfillmentRank === undefined) return null
  return statusRank * 10 + fulfillmentRank
}

function isRefunded(order: CurrentOrder): boolean {
  return String(order.status ?? "").toUpperCase() === "REFUNDED"
    || (order.refundAmountCents ?? 0) > 0
}

function describe(mapping: StatusMapping | null): string | null {
  return mapping ? `${mapping.status}/${mapping.fulfillmentStatus}` : null
}

/**
 * Decide what to restate, given every order OneFlowe holds and every header
 * legacy returns.
 *
 * Orders are keyed by legacy order id, which `legacy_order_imports` guarantees
 * unique per organization and source system.
 */
export function planStatusResync(
  current: readonly CurrentOrder[],
  legacy: readonly LegacyStatusRow[],
): StatusResyncPlan {
  const legacyById = new Map<number, LegacyStatusRow>()
  for (const row of legacy) legacyById.set(row.legacyOrderId, row)

  const changes: StatusChange[] = []
  const holds: StatusHold[] = []
  const missingFromLegacy: number[] = []
  let unchanged = 0

  for (const order of [...current].sort((a, b) => a.legacyOrderId - b.legacyOrderId)) {
    const row = legacyById.get(order.legacyOrderId)
    if (!row) {
      missingFromLegacy.push(order.legacyOrderId)
      continue
    }

    const mapping = mapDeliveryStatus(row.deliveryStatus)
    const hold = (reason: StatusHoldReason) => holds.push({
      orderId: order.orderId,
      legacyOrderId: order.legacyOrderId,
      reason,
      currentStatus: order.status,
      currentFulfillmentStatus: order.fulfillmentStatus,
      legacyStatusId: row.legacyStatusId,
      deliveryStatus: row.deliveryStatus,
      legacyMeans: describe(mapping),
    })

    if (row.legacyStatusId !== LEGACY_STATUS_LIVE) { hold("LEGACY_NOT_LIVE"); continue }
    if (!mapping) { hold("UNMAPPED_DELIVERY_STATUS"); continue }

    const sameStatus = String(order.status ?? "").toUpperCase() === mapping.status
    const sameFulfillment =
      String(order.fulfillmentStatus ?? "").toUpperCase() === mapping.fulfillmentStatus
    if (sameStatus && sameFulfillment) { unchanged += 1; continue }

    // Rule 1 — a refund we hold outranks anything legacy reports.
    if (isRefunded(order)) { hold("REFUNDED_LOCALLY"); continue }

    // Rule 2 — never walk an order backwards unattended.
    const from = lifecycleRank(order.status, order.fulfillmentStatus)
    const to = lifecycleRank(mapping.status, mapping.fulfillmentStatus)
    if (from === null || to === null || to < from) { hold("BACKWARD_TRANSITION"); continue }

    changes.push({
      orderId: order.orderId,
      legacyOrderId: order.legacyOrderId,
      fromStatus: order.status,
      fromFulfillmentStatus: order.fulfillmentStatus,
      toStatus: mapping.status,
      toFulfillmentStatus: mapping.fulfillmentStatus,
      deliveryStatus: row.deliveryStatus,
    })
  }

  return { changes, holds, unchanged, missingFromLegacy: missingFromLegacy.toSorted((a, b) => a - b) }
}

export interface StatusResyncCounts {
  ordersConsidered: number
  toChange: number
  unchanged: number
  held: number
  missingFromLegacy: number
  byTransition: Record<string, number>
  byHoldReason: Record<string, number>
}

export function summarizeStatusResync(plan: StatusResyncPlan): StatusResyncCounts {
  const byTransition: Record<string, number> = {}
  for (const change of plan.changes) {
    const key = `${change.fromStatus}/${change.fromFulfillmentStatus ?? "-"} -> ${change.toStatus}/${change.toFulfillmentStatus}`
    byTransition[key] = (byTransition[key] ?? 0) + 1
  }
  const byHoldReason: Record<string, number> = {}
  for (const hold of plan.holds) {
    byHoldReason[hold.reason] = (byHoldReason[hold.reason] ?? 0) + 1
  }
  return {
    ordersConsidered: plan.changes.length + plan.holds.length + plan.unchanged + plan.missingFromLegacy.length,
    toChange: plan.changes.length,
    unchanged: plan.unchanged,
    held: plan.holds.length,
    missingFromLegacy: plan.missingFromLegacy.length,
    byTransition,
    byHoldReason,
  }
}
