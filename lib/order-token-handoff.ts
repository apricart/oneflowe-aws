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
export const TOKEN_HANDOFF_STATUS = "APPROVED"

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
  /**
   * How many had been delivered, so should have settled, but could not be
   * marked fulfilled. Their token did reach the admin; the settlement is what
   * failed, and `tokenSettlementNeedsRetry` is what offers it again.
   */
  failedCount?: number
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
 * Whether the order's token has already been emailed to admin operations.
 *
 * A token is emailed once per order: `token_handoff_at` is written when it
 * leaves, and both send routes refuse an order that carries it. The UI reads
 * the same field to stop offering a send the server would refuse.
 */
export function isTokenAlreadySent(tokenHandoffAt?: string | Date | null): boolean {
  if (tokenHandoffAt instanceof Date) return !Number.isNaN(tokenHandoffAt.getTime())
  return typeof tokenHandoffAt === "string" && tokenHandoffAt.trim().length > 0
}

/** Machine-readable refusal codes for a token email that was not sent. */
export const TOKEN_ALREADY_SENT_CODE = "TOKEN_ALREADY_SENT"
export const TOKEN_SEND_IN_PROGRESS_CODE = "TOKEN_SEND_IN_PROGRESS"

export const TOKEN_ALREADY_SENT_MESSAGE =
  "This order's fulfilment token has already been emailed to the admin. Each order's token is sent once."
export const GROUP_TOKENS_ALREADY_SENT_MESSAGE =
  "Every fulfilment token in this group order has already been emailed to the admin."
export const TOKEN_SEND_IN_PROGRESS_MESSAGE =
  "This fulfilment token is already being emailed. Refresh in a moment to see the result."

/** Shown in place of the send action once the token has gone. */
export const TOKEN_SENT_LABEL = "Token sent"

/**
 * A token that reached the admin for a delivered order whose fulfilment then
 * failed. The send routes answer a retry that fails again with this code; the
 * first send still answers 200, because its email did leave, and says so with
 * `settlementFailed`.
 */
export const TOKEN_SETTLEMENT_FAILED_CODE = "TOKEN_SETTLEMENT_FAILED"

/** Shown in place of "Token sent" while the order is waiting on a retry. */
export const TOKEN_SETTLEMENT_RETRY_LABEL = "Retry fulfilment"

export const TOKEN_SETTLEMENT_FAILED_TITLE = "Order not marked fulfilled"

export const TOKEN_SETTLEMENT_RETRY_FAILED_MESSAGE =
  "The order still could not be marked fulfilled. Please try again in a few minutes; if it keeps failing, contact support."

/**
 * Whether the order is waiting on a settlement that failed.
 *
 * Its token has reached the admin and its goods have arrived, which is the
 * whole of what fulfils an order (`tokenHandoffSettlesNow`), yet it is still
 * approved. In normal running that lasts only for the instant inside the request
 * that settles it, so an order seen in this state is one whose settlement failed
 * — after the hand-off, or when its delivery was recorded — and the send action
 * is offered again as a retry. The send routes apply the same rule to the live
 * row before they retry, and never email the token a second time.
 */
export function tokenSettlementNeedsRetry(order: {
  status?: string | null
  fulfillmentStatus?: string | null
  tokenHandoffAt?: string | Date | null
} | null | undefined): boolean {
  if (!order) return false
  return isTokenAlreadySent(order.tokenHandoffAt)
    && tokenHandoffSettlesNow(order.status, order.fulfillmentStatus)
}

/**
 * The order is no longer approved, so it has no token to send. A screen that
 * still offers the send is showing the order as it was when it loaded — most
 * often it has since been fulfilled by a hand-off from another screen or by
 * the auto-fulfil sweep — so the refusal carries the status it is in now.
 */
export const TOKEN_ORDER_NOT_APPROVED_CODE = "ORDER_NOT_APPROVED"

const FULFILLED_STATUSES = new Set(["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"])

/** Why a token cannot be sent for an order in this status, in the user's words. */
export function tokenOrderNotApprovedMessage(orderStatus?: string | null): string {
  const status = String(orderStatus ?? "").trim().toUpperCase()
  if (FULFILLED_STATUSES.has(status)) {
    return "This order has already been fulfilled, so its token no longer needs to be sent."
  }
  if (status === "PENDING") return "This order has not been approved yet, so it has no token to send."
  if (status) {
    return `This order is ${status.toLowerCase().replace(/_/g, " ")}, so it has no token to send.`
  }
  return "A token can only be sent for an active order."
}

export type TokenSendRefusal =
  | { kind: "already-sent"; message: string }
  | { kind: "not-approved"; message: string; status: string | null }

/**
 * Read a refused send as one of the two refusals that mean "this screen is out
 * of date" rather than "something failed", so every send surface refreshes
 * instead of showing an error. Anything else is a real failure: null.
 */
export function readTokenSendRefusal(
  httpStatus: number,
  body: { code?: unknown; error?: unknown; status?: unknown } | null | undefined,
): TokenSendRefusal | null {
  if (httpStatus !== 409 || !body) return null
  const message = typeof body.error === "string" ? body.error : ""
  if (body.code === TOKEN_ALREADY_SENT_CODE) {
    return { kind: "already-sent", message: message || TOKEN_ALREADY_SENT_MESSAGE }
  }
  if (body.code === TOKEN_ORDER_NOT_APPROVED_CODE) {
    const status = typeof body.status === "string" && body.status.trim() ? body.status.trim().toUpperCase() : null
    return { kind: "not-approved", message: message || tokenOrderNotApprovedMessage(status), status }
  }
  return null
}

/**
 * Read a send-route answer as "the order is still not fulfilled", whichever way
 * it came: a first send whose email left but whose settlement failed (200), or
 * a retry that failed again (503). Either way the caller shows it as an error
 * and offers the retry; null means anything else.
 */
export function readTokenSettlementFailure(
  body: { code?: unknown; error?: unknown; message?: unknown } | null | undefined,
): { message: string } | null {
  if (!body || body.code !== TOKEN_SETTLEMENT_FAILED_CODE) return null
  const text = [body.message, body.error].find((value) => typeof value === "string" && value.trim())
  return { message: typeof text === "string" ? text : TOKEN_SETTLEMENT_RETRY_FAILED_MESSAGE }
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
  failedCount = 0,
}: TokenHandoffResult): string {
  const tokens = sentCount === 1 ? "1 fulfilment token" : `${sentCount} fulfilment tokens`
  const sent = `Sent ${tokens} to the admin`

  const settled = settledClause(sentCount, fulfilledCount)
  const awaiting = awaitingClause(sentCount, awaitingDeliveryCount, settled !== null)
  const clauses = [settled, awaiting].filter((clause): clause is string => clause !== null)
  const message = clauses.length === 0 ? sent : `${sent} — ${clauses.join("; ")}`

  return failedCount > 0 ? `${message}. ${failedClause(sentCount, failedCount)}` : message
}

/** The part of the message about delivered orders that could not be settled. */
function failedClause(sentCount: number, failedCount: number): string {
  const which = sentCount === 1
    ? "the order could not be marked fulfilled"
    : `${failedCount} of ${sentCount} orders could not be marked fulfilled`
  const tokens = failedCount === 1 ? "Its token has" : "Their tokens have"
  return `However, ${which}. ${tokens} reached the admin, so press "${TOKEN_SETTLEMENT_RETRY_LABEL}" to try again — nothing will be emailed twice.`
}

/**
 * The message after a retry, which sends no email: it only settles orders whose
 * token had already reached the admin.
 */
export function tokenSettlementRetryMessage({
  fulfilledCount,
  failedCount,
}: { fulfilledCount: number; failedCount: number }): string {
  if (failedCount > 0) {
    return fulfilledCount > 0
      ? `${fulfilledCount} order${fulfilledCount === 1 ? " is" : "s are"} now marked fulfilled, but ${failedCount} still could not be. Please try again in a few minutes; if it keeps failing, contact support.`
      : TOKEN_SETTLEMENT_RETRY_FAILED_MESSAGE
  }
  return fulfilledCount === 1
    ? "The order is now marked fulfilled. Its token had already reached the admin, so it was not emailed again."
    : `All ${fulfilledCount} orders are now marked fulfilled. Their tokens had already reached the admin, so they were not emailed again.`
}
