import { normalizeFulfillmentStatus } from "@/lib/fulfillment-status"

/**
 * The order-status buckets the read-only Viewer dashboard reports on.
 *
 * They are derived from two columns — `orders.status` (where the order is in
 * the approval/fulfilment state machine) and `orders.fulfillment_status`
 * (where the goods are) — and the whole point of this module is that the rule
 * is written **once**. The KPI card reads it, its SQL counterpart in
 * `lib/server/order-delivery-status-sql.ts` restates the same predicate for
 * Postgres, and the drill-down behind the card is keyed on the same bucket, so
 * a card and the list it opens cannot disagree.
 *
 * The partition is deliberate and load-bearing:
 *
 *     ACTIVE = DELIVERED_UNACKNOWLEDGED + UNFULFILLED
 *
 * Every approved order has either arrived (and is waiting for the branch to
 * acknowledge receipt, which is what moves it to FULFILLED) or has not. That
 * identity is what makes the panel readable without a legend, and
 * `lib/order-delivery-status.test.ts` pins it.
 *
 * Note this is *not* the same as the "Not Delivered" detail on the existing
 * Super Admin / Head Office / Branch Admin cards, whose `NOT_DELIVERED`
 * drill-down counts every status while the card counts approved ones only.
 * That inconsistency predates this work and is left where it is; the Viewer
 * dashboard uses UNFULFILLED, whose card and drill-down share one predicate.
 */

/** Order statuses that count as fulfilled, partial fulfilment included. */
export const FULFILLED_ORDER_STATUSES = [
  "FULFILLED",
  "PARTIAL",
  "PARTIALLY_FULFILLED",
] as const

/** The one fulfilment status that means the goods reached the branch. */
export const DELIVERED_FULFILLMENT_STATUS = "DELIVERED"

export type ViewerStatusBucketKey =
  | "PENDING"
  | "APPROVED"
  | "DELIVERED"
  | "DELIVERED_UNACKNOWLEDGED"
  | "UNFULFILLED"
  | "FULFILLED"

export type OrderDeliverySource = {
  status?: string | null
  fulfillmentStatus?: string | null
}

export function normalizeOrderStatus(status?: string | null): string {
  return String(status || "").trim().toUpperCase()
}

/** Whether the goods have reached the branch, whatever the order status says. */
export function isDelivered(order: OrderDeliverySource): boolean {
  return normalizeFulfillmentStatus(order.fulfillmentStatus) === DELIVERED_FULFILLMENT_STATUS
}

/** Whether the order has been settled as fulfilled, partial fulfilment included. */
export function isFulfilledStatus(status?: string | null): boolean {
  return (FULFILLED_ORDER_STATUSES as readonly string[]).includes(normalizeOrderStatus(status))
}

export function matchesViewerStatusBucket(
  bucket: ViewerStatusBucketKey,
  order: OrderDeliverySource,
): boolean {
  const status = normalizeOrderStatus(order.status)
  const delivered = isDelivered(order)

  switch (bucket) {
    case "PENDING":
      return status === "PENDING"
    case "APPROVED":
      return status === "APPROVED"
    case "DELIVERED":
      return delivered
    case "DELIVERED_UNACKNOWLEDGED":
      return status === "APPROVED" && delivered
    case "UNFULFILLED":
      return status === "APPROVED" && !delivered
    case "FULFILLED":
      return isFulfilledStatus(status)
    default:
      return false
  }
}

export type ViewerStatusBucket = {
  key: ViewerStatusBucketKey
  label: string
  /** Printed on the card so a reader can check the number without a legend. */
  description: string
  /** The `type` this bucket's card sends to `/api/v1/analytics/drill-down`. */
  drillDownType: string
  /** The field carrying this bucket's count in the sales-performance payload. */
  countField: string
}

/**
 * The panel, in reading order. Active sits before the two buckets it splits
 * into so the arithmetic reads down the row.
 */
export const VIEWER_STATUS_BUCKETS: ReadonlyArray<ViewerStatusBucket> = [
  {
    key: "PENDING",
    label: "Pending Approval",
    description: "Raised and waiting for a decision",
    drillDownType: "PENDING",
    countField: "pendingCount",
  },
  {
    key: "APPROVED",
    label: "Active",
    description: "Approved and in flight",
    drillDownType: "APPROVED",
    countField: "approvedCount",
  },
  {
    key: "DELIVERED_UNACKNOWLEDGED",
    label: "Delivered, Pending Acknowledgment",
    description: "Arrived at the branch, receipt not yet confirmed",
    drillDownType: "DELIVERED_UNACKNOWLEDGED",
    countField: "deliveredCount",
  },
  {
    key: "UNFULFILLED",
    label: "Unfulfilled",
    description: "Approved, not yet delivered",
    drillDownType: "UNFULFILLED",
    countField: "notDeliveredCount",
  },
  {
    key: "DELIVERED",
    label: "Delivered",
    description: "Goods delivered, at any order status",
    drillDownType: "DELIVERED",
    countField: "deliveredTotalCount",
  },
  {
    key: "FULFILLED",
    label: "Fulfilled",
    description: "Receipt confirmed and settled",
    drillDownType: "FULFILLED",
    countField: "fulfilledCount",
  },
]

export function getViewerStatusBucket(key: ViewerStatusBucketKey): ViewerStatusBucket {
  const bucket = VIEWER_STATUS_BUCKETS.find((candidate) => candidate.key === key)
  if (!bucket) throw new Error(`Unknown viewer status bucket: ${key}`)
  return bucket
}

/** Count a set of orders into every bucket. Used by the tests and the oracle. */
export function countViewerStatusBuckets(
  orders: ReadonlyArray<OrderDeliverySource>,
): Record<ViewerStatusBucketKey, number> {
  const counts = {
    PENDING: 0,
    APPROVED: 0,
    DELIVERED: 0,
    DELIVERED_UNACKNOWLEDGED: 0,
    UNFULFILLED: 0,
    FULFILLED: 0,
  } as Record<ViewerStatusBucketKey, number>

  for (const order of orders) {
    for (const bucket of VIEWER_STATUS_BUCKETS) {
      if (matchesViewerStatusBucket(bucket.key, order)) counts[bucket.key] += 1
    }
  }

  return counts
}
