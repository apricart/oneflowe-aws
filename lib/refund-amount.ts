/**
 * What refunding part of an order line gives back, in integer cents.
 *
 * A line charged `round(price × quantity)`, once. Pricing each refund the same
 * way rounds once per refund, so refunding the line in pieces could give back
 * a paisa more or less than it charged: three refunds of 0.1 at 103 paisa give
 * back 10 + 10 + 10 = 30 of a line that charged round(103 × 0.3) = 31, and the
 * paisa left is on no invoice and in no refund (plans/OF-INVOICE-invoice-ledger.md,
 * "Fixes after the edge-case review"). So the refund that takes a line's last
 * units gives back exactly what is left of its charge, and no refund gives back
 * more than is left.
 */
import { calculateLineCents, roundQuantity } from "@/lib/quantity"

export type LineRefundHistory = { quantity: number; amountCents: number }

export function refundLineAmountCents(input: {
  priceCents: number
  /** The order line's quantity. */
  lineQuantity: number
  /** What refunds already took (or hold) from this line. */
  already: LineRefundHistory
  refundQuantity: number
}): number {
  const lineGross = calculateLineCents(input.priceCents, input.lineQuantity)
  const remainingGross = Math.max(0, lineGross - Math.max(0, Math.round(Number(input.already.amountCents) || 0)))
  const takesTheRest = roundQuantity(Number(input.already.quantity) + Number(input.refundQuantity)) >= roundQuantity(Number(input.lineQuantity))
  if (takesTheRest) return remainingGross
  return Math.min(calculateLineCents(input.priceCents, input.refundQuantity), remainingGross)
}

/** Refund lines summed per order line. */
export function refundHistoryByLine(
  lines: ReadonlyArray<{ orderItemId: number; quantity: number | string; amountCents: number | string | null }>,
): Map<number, LineRefundHistory> {
  const byLine = new Map<number, LineRefundHistory>()
  for (const line of lines) {
    const current = byLine.get(line.orderItemId) ?? { quantity: 0, amountCents: 0 }
    byLine.set(line.orderItemId, {
      quantity: roundQuantity(current.quantity + Number(line.quantity || 0)),
      amountCents: current.amountCents + Number(line.amountCents || 0),
    })
  }
  return byLine
}

const NO_HISTORY: LineRefundHistory = { quantity: 0, amountCents: 0 }

/**
 * Whether refund details priced before the order was locked still price the
 * same against the refund lines read under the lock. A concurrent refund on the
 * same line can turn a refund into the one that takes the last units; it is
 * then refused as a conflict and retried, rather than written at a stale amount.
 */
export function refundDetailsStillPriced(
  details: ReadonlyArray<{ orderItemId: number; quantity: number; amountCents: number }>,
  lines: ReadonlyMap<number, { priceCents: number; quantity: number }>,
  history: ReadonlyMap<number, LineRefundHistory>,
): boolean {
  return details.every((detail) => {
    const line = lines.get(detail.orderItemId)
    if (!line) return false
    return refundLineAmountCents({
      priceCents: line.priceCents,
      lineQuantity: line.quantity,
      already: history.get(detail.orderItemId) ?? NO_HISTORY,
      refundQuantity: detail.quantity,
    }) === detail.amountCents
  })
}
