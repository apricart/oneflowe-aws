import "server-only"
import { sql, type SQL } from "drizzle-orm"
import { orders } from "@/db/schema"
import {
  DELIVERED_FULFILLMENT_STATUS,
  FULFILLED_ORDER_STATUSES,
  type ViewerStatusBucketKey,
} from "@/lib/order-delivery-status"

/**
 * The Postgres counterpart of `lib/order-delivery-status.ts`.
 *
 * Every bucket on the Viewer dashboard is answered twice — once as an
 * aggregate for the KPI card, once as a row filter for the drill-down behind
 * it — and both come from this file, so a card can never report a number the
 * list behind it contradicts. The pure rules and these predicates are held
 * together by `lib/server/order-delivery-status-sql.test.ts`.
 *
 * `fulfillment_status` is nullable on rows written before it existed, so every
 * read of it coalesces to NOT_STARTED, matching `normalizeFulfillmentStatus`.
 */

const fulfillmentStatus = sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED'))`
const orderStatus = sql`UPPER(${orders.status})`

const deliveredPredicate = sql`${fulfillmentStatus} = ${DELIVERED_FULFILLMENT_STATUS}`
const notDeliveredPredicate = sql`${fulfillmentStatus} <> ${DELIVERED_FULFILLMENT_STATUS}`
const fulfilledPredicate = sql`${orderStatus} IN (${sql.join(
  FULFILLED_ORDER_STATUSES.map((status) => sql`${status}`),
  sql`, `,
)})`

/** The row filter for one bucket, for a WHERE clause. */
export function viewerStatusBucketCondition(bucket: ViewerStatusBucketKey): SQL {
  switch (bucket) {
    case "PENDING":
      return sql`${orderStatus} = 'PENDING'`
    case "APPROVED":
      return sql`${orderStatus} = 'APPROVED'`
    case "DELIVERED":
      return deliveredPredicate
    case "DELIVERED_UNACKNOWLEDGED":
      return sql`${orderStatus} = 'APPROVED' AND ${deliveredPredicate}`
    case "UNFULFILLED":
      return sql`${orderStatus} = 'APPROVED' AND ${notDeliveredPredicate}`
    case "FULFILLED":
      return fulfilledPredicate
    default: {
      const unreachable: never = bucket
      throw new Error(`Unknown viewer status bucket: ${String(unreachable)}`)
    }
  }
}

/** The aggregate for one bucket, for a SELECT list. */
export function viewerStatusBucketCount(bucket: ViewerStatusBucketKey) {
  return sql<number>`COALESCE(COUNT(CASE WHEN ${viewerStatusBucketCondition(bucket)} THEN 1 END), 0)`
    .mapWith(Number)
}

/**
 * Delivered orders at any order status.
 *
 * Deliberately distinct from `deliveredCount` in
 * `app/api/v1/analytics/sales-performance/route.ts`, which is the narrower
 * approved-and-delivered bucket that the three existing dashboards print as
 * "Delivered/Unacknowledged". That field keeps its meaning and its readers.
 */
export const deliveredTotalCountExpression = viewerStatusBucketCount("DELIVERED")
