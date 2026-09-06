import { normalizeFulfillmentStatus } from "@/lib/fulfillment-status"

/**
 * What a fulfilment token hand-off means for the order behind it.
 *
 * Handing the token to admin operations is the last thing the ordering side of
 * the business does with an order, but it is not what completes it: the goods
 * still have to arrive. A hand-off therefore does two things — it is always
 * recorded against the order, and it settles the order to FULFILLED only once
 * the delivery status says DELIVERED. A hand-off that arrives first is
 * remembered, and the order settles the moment delivery is recorded.
 *
 * Every role that can share a token reaches this same rule — ORDER_PORTAL and
 * GROUP_ORDER_PORTAL from their own approved order, BRANCH_ADMIN / HEAD_OFFICE
 * / GROUP_USER from the order they approved — so the single-order hand-off and
 * the group-scale one cannot drift apart.
 *
 * The module is deliberately free of the database and of `server-only` so both
 * the eligibility rule and the wording can be unit tested directly.
 */

/** The only order status that carries a shareable token, and the only one that can settle. */
const TOKEN_HANDOFF_STATUS = "APPROVED"

/** The delivery status that means the goods have physically arrived. */
const DELIVERED_STATUS = "DELIVERED"

export type TokenHandoffResult = {
  /** How many tokens actually left in the message. */
  sentCount: number
  /** How many of those orders moved to FULFILLED as a result. */
  fulfilledCount: number
  /**
   * How many were recorded against an order that has not been delivered yet,
   * and will therefore settle when their delivery is recorded.
   */
  awaitingDeliveryCount?: number
}

/**
 * Whether an order may have its token handed over. A token only ever exists on
 * an approved order, so this is the send gate and the gate on recording the
 * hand-off; whether that hand-off *settles* the order is a further question,
 * answered by `tokenHandoffSettlesNow`.
 */
export function isTokenHandoffEligible(orderStatus?: string | null): boolean {
  return String(orderStatus ?? "").trim().toUpperCase() === TOKEN_HANDOFF_STATUS
}

/**
 * Whether a hand-off settles its order right now.
 *
 * An order is fulfilled once both halves are true: the token has reached admin
 * operations, and the goods have been delivered. This is the whole rule, and it
 * is the same rule whether the token arrives after the delivery (settle
 * immediately) or before it (settle when delivery is recorded).
 */
export function tokenHandoffSettlesNow(
  orderStatus?: string | null,
  fulfillmentStatus?: string | null,
): boolean {
  return isTokenHandoffEligible(orderStatus)
    && normalizeFulfillmentStatus(fulfillmentStatus) === DELIVERED_STATUS
}

/** The part of the message about orders the hand-off settled, if any. */
function settledClause(sentCount: number, fulfilledCount: number): string | null {
  if (fulfilledCount <= 0) return null
  if (fulfilledCount >= sentCount) {
    return sentCount === 1
      ? "the order is now marked fulfilled"
      : `all ${sentCount} orders are now marked fulfilled`
  }
  return `${fulfilledCount} of ${sentCount} orders are now marked fulfilled`
}

/** The part of the message about orders still waiting to be delivered, if any. */
function awaitingClause(
  sentCount: number,
  awaitingCount: number,
  hasSettledClause: boolean,
): string | null {
  if (awaitingCount <= 0) return null
  if (hasSettledClause) return `${awaitingCount} will be marked fulfilled once delivered`
  if (awaitingCount >= sentCount) {
    return sentCount === 1
      ? "the order will be marked fulfilled once it is delivered"
      : `all ${sentCount} orders will be marked fulfilled once they are delivered`
  }
  return `${awaitingCount} of ${sentCount} orders will be marked fulfilled once they are delivered`
}

/**
 * The message the caller shows after a hand-off.
 *
 * Fulfilment is attempted after the email has already left, so a partial result
 * is possible — an order that has not been delivered yet, one someone else
 * settled in the meantime, or one whose budget hold no longer adds up. The
 * wording reports what really happened rather than assuming every token settled
 * its order.
 */
export function tokenHandoffMessage({
  sentCount,
  fulfilledCount,
  awaitingDeliveryCount = 0,
}: TokenHandoffResult): string {
  const tokens = sentCount === 1 ? "1 fulfilment token" : `${sentCount} fulfilment tokens`
  const sent = `Sent ${tokens} to the admin`

  const settled = settledClause(sentCount, fulfilledCount)
  const awaiting = awaitingClause(sentCount, awaitingDeliveryCount, settled !== null)
  const clauses = [settled, awaiting].filter((clause): clause is string => clause !== null)

  return clauses.length === 0 ? sent : `${sent} — ${clauses.join("; ")}`
}
