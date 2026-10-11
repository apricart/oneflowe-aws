import { isRefundEligibleOrderStatus, normalizeOrderStatus } from "@/lib/business-rules"
import { roundQuantity } from "@/lib/quantity"
import { requesterRefundTimingReason } from "@/lib/refund-window"

/**
 * The rules a Group Order Portal refund request has to satisfy, with no
 * database or request context attached so they can be exercised directly.
 *
 * The requester tier — ORDER_PORTAL and GROUP_ORDER_PORTAL — may only ask for a
 * refund on an order it raised itself, once that order has actually been
 * delivered and fulfilled, and only within seven days of fulfilment
 * (`lib/refund-window.ts`). Those are the conditions the single-order endpoint
 * applies to every requester; nothing here loosens any of them for the group
 * flow, and nothing here is consulted by any other role's path.
 */

/** Upper bounds on one submission, so a single request's work stays bounded. */
export const MAX_ORDERS_PER_GROUP_REFUND = 100
export const MAX_ITEMS_PER_REFUNDED_ORDER = 200
/** Matches `refunds.reason`, which is varchar(255). */
export const MAX_GROUP_REFUND_REASON_LENGTH = 255

export const OUT_OF_SCOPE_REASON =
  "This branch is no longer in your assigned scope, so you cannot raise a refund for it."

export type RefundEligibilityInput = {
  status: unknown
  fulfillmentStatus: unknown
  /** When the order was fulfilled; the seven-day window runs from here. */
  fulfilledAt: Date | string | null
  /** Order total minus refunds already approved or still pending against it. */
  remainingRefundableCents: number
  /** Injected so the seven-day rule is testable rather than clock-bound. */
  now?: Date
}

/**
 * Why this order cannot be refunded by its requester, or null when it can.
 *
 * Returning the reason rather than a boolean is deliberate: the workspace shows
 * the user exactly why a branch is unavailable instead of silently dropping it,
 * and the submission path re-uses the identical check so the screen and the
 * server can never disagree about what is allowed.
 */
export function getRequesterRefundBlockReason({
  status,
  fulfillmentStatus,
  fulfilledAt,
  remainingRefundableCents,
  now = new Date(),
}: RefundEligibilityInput): string | null {
  const normalized = normalizeOrderStatus(status)

  if (normalized === "REJECTED") return "This order was rejected, so there is nothing to refund."
  if (normalized === "REFUNDED" || remainingRefundableCents <= 0) {
    return "This order has already been fully refunded."
  }
  if (!isRefundEligibleOrderStatus(normalized)) {
    return `An order in ${normalized || "an unknown"} state is not eligible for a refund.`
  }
  return requesterRefundTimingReason({ status: normalized, fulfillmentStatus, fulfilledAt }, now)
}

export type RefundLineAvailability = {
  quantityOrdered: number
  quantityApproved: number
  quantityPending: number
}

/**
 * How much of one order line is still refundable: what was ordered, minus what
 * has already been approved, minus what is already waiting on a decision.
 * Never negative, so a legacy over-refund can only ever read as "nothing left".
 *
 * Rounded to the scale quantities are stored at. Without it, subtracting binary
 * floats leaves a remainder like 0.09999999999999998, which displays as "0.1"
 * and then refuses a request for 0.1 — telling the user that the exact amount
 * the screen offered is more than is available.
 */
export function remainingRefundableQuantity({
  quantityOrdered,
  quantityApproved,
  quantityPending,
}: RefundLineAvailability): number {
  return Math.max(
    0,
    roundQuantity(roundQuantity(quantityOrdered) - roundQuantity(quantityApproved) - roundQuantity(quantityPending)),
  )
}

/**
 * How much money is still refundable against one order. Approved refunds are
 * taken as the larger of the itemised refund rows and the total stamped on the
 * order itself, so an order refunded before itemisation existed still reports
 * its true remaining capacity rather than an inflated one.
 */
export function remainingRefundableCents({
  orderTotalCents,
  approvedRefundCents,
  pendingRefundCents,
  orderRefundAmountCents,
}: {
  orderTotalCents: number
  approvedRefundCents: number
  pendingRefundCents: number
  orderRefundAmountCents: number
}): number {
  const approved = Math.max(approvedRefundCents, orderRefundAmountCents)
  return Math.max(0, orderTotalCents - approved - pendingRefundCents)
}
