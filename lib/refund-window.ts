import { isOrderPortalRefundEligible } from "@/lib/business-rules"

/**
 * When a refund may be asked for (`plans/OF-REFUND-seven-day-requester-window.md`).
 *
 * Every role that can raise a refund request may do so from the moment the
 * order is fulfilled until seven days after it. The window opens at fulfilment
 * rather than delivery because nobody may claim before fulfilment, and no order
 * is fulfilled before it is delivered — so the requester always gets the full
 * seven days. Super Admin, who decides refunds, has no time limit at all.
 *
 * Pure, so the routes, the group rules, the Order Desk list and the browser all
 * read the same rule.
 */

export const REQUESTER_REFUND_WINDOW_DAYS = 7
export const REQUESTER_REFUND_WINDOW_MS = REQUESTER_REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000

export const REFUND_NOT_YET_AVAILABLE_REASON =
  "A refund can be requested once this order has been fulfilled and delivered."
export const REFUND_WINDOW_CLOSED_REASON =
  `The refund period has ended. Refunds can be requested within ${REQUESTER_REFUND_WINDOW_DAYS} days of the order being fulfilled.`

type Instant = Date | string | null | undefined

function toDate(value: Instant): Date | null {
  if (value === null || value === undefined || value === "") return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Super Admin decides refunds and is never held to the requester window. */
export function isRefundWindowExemptRole(role: unknown): boolean {
  return role === "SUPER_ADMIN"
}

/** The last instant a requester may ask, or null when the order has no fulfilment time. */
export function requesterRefundDeadline(fulfilledAt: Instant): Date | null {
  const fulfilled = toDate(fulfilledAt)
  return fulfilled ? new Date(fulfilled.getTime() + REQUESTER_REFUND_WINDOW_MS) : null
}

/**
 * True up to and including the deadline. An order without a fulfilment time
 * cannot show when its window opened, so it is outside it.
 */
export function isWithinRequesterRefundWindow(fulfilledAt: Instant, now: Date = new Date()): boolean {
  const deadline = requesterRefundDeadline(fulfilledAt)
  return deadline !== null && now.getTime() <= deadline.getTime()
}

export type RequesterRefundTiming = {
  status: unknown
  fulfillmentStatus: unknown
  fulfilledAt: Instant
}

/**
 * Why a requester cannot ask for a refund on this order yet or any more, or
 * null when they can. Status and capacity checks are the caller's; this is only
 * the "fulfilled, delivered, and within seven days" part.
 */
export function requesterRefundTimingReason(
  order: RequesterRefundTiming,
  now: Date = new Date(),
): string | null {
  if (!isOrderPortalRefundEligible(order.status, order.fulfillmentStatus)) return REFUND_NOT_YET_AVAILABLE_REASON
  if (!isWithinRequesterRefundWindow(order.fulfilledAt, now)) return REFUND_WINDOW_CLOSED_REASON
  return null
}

/** The timing rule for `role`: none for Super Admin, the requester window for everyone else. */
export function refundTimingReasonForRole(
  role: unknown,
  order: RequesterRefundTiming,
  now: Date = new Date(),
): string | null {
  return isRefundWindowExemptRole(role) ? null : requesterRefundTimingReason(order, now)
}
