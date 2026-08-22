/**
 * What a fulfilment token hand-off means for the order behind it.
 *
 * Handing the token to admin operations is the last thing the ordering side of
 * the business does with an order: once the credential has left, the order is
 * settled and moves to FULFILLED. Every role that can share a token reaches
 * this same rule — ORDER_PORTAL and GROUP_ORDER_PORTAL from their own approved
 * order, BRANCH_ADMIN / HEAD_OFFICE / GROUP_USER from the order they approved —
 * so the single-order hand-off and the group-scale one cannot drift apart.
 *
 * The module is deliberately free of the database and of `server-only` so both
 * the eligibility rule and the wording can be unit tested directly.
 */

/** The only order status that carries a shareable token, and the only one that can settle. */
const TOKEN_HANDOFF_STATUS = "APPROVED"

export type TokenHandoffResult = {
  /** How many tokens actually left in the message. */
  sentCount: number
  /** How many of those orders moved to FULFILLED as a result. */
  fulfilledCount: number
}

/**
 * Whether an order may have its token handed over — and therefore whether that
 * hand-off settles it. A token only ever exists on an approved order, so this
 * is both the send gate and the fulfilment gate.
 */
export function isTokenHandoffEligible(orderStatus?: string | null): boolean {
  return String(orderStatus ?? "").trim().toUpperCase() === TOKEN_HANDOFF_STATUS
}

/**
 * The message the caller shows after a hand-off.
 *
 * Fulfilment is attempted after the email has already left, so a partial result
 * is possible — an order someone else settled in the meantime, or one whose
 * budget hold no longer adds up. The wording reports what really happened
 * rather than assuming every token settled its order.
 */
export function tokenHandoffMessage({ sentCount, fulfilledCount }: TokenHandoffResult): string {
  const tokens = sentCount === 1 ? "1 fulfilment token" : `${sentCount} fulfilment tokens`
  const sent = `Sent ${tokens} to the admin`

  if (fulfilledCount <= 0) return sent
  if (fulfilledCount >= sentCount) {
    const settled = sentCount === 1 ? "the order is" : `all ${sentCount} orders are`
    return `${sent} — ${settled} now marked fulfilled`
  }
  return `${sent} — ${fulfilledCount} of ${sentCount} orders are now marked fulfilled`
}
