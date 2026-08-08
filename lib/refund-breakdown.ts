export interface RefundBreakdownCents {
  itemRefundCents: number
  taxRefundCents: number
  grossRefundCents: number
}

function assertNonNegativeSafeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
}

/**
 * Refund reports and filters continue to consume grossRefundCents. The two
 * component values preserve the item/tax audit breakdown without changing
 * those existing semantics.
 */
export function buildRefundBreakdownCents(
  itemRefundCents: number,
  taxRefundCents: number,
): RefundBreakdownCents {
  assertNonNegativeSafeInteger(itemRefundCents, "itemRefundCents")
  assertNonNegativeSafeInteger(taxRefundCents, "taxRefundCents")
  const grossRefundCents = itemRefundCents + taxRefundCents
  assertNonNegativeSafeInteger(grossRefundCents, "grossRefundCents")
  return { itemRefundCents, taxRefundCents, grossRefundCents }
}

export function refundBreakdownReconciles(value: RefundBreakdownCents): boolean {
  return Number.isSafeInteger(value.itemRefundCents)
    && value.itemRefundCents >= 0
    && Number.isSafeInteger(value.taxRefundCents)
    && value.taxRefundCents >= 0
    && Number.isSafeInteger(value.grossRefundCents)
    && value.grossRefundCents > 0
    && value.itemRefundCents + value.taxRefundCents === value.grossRefundCents
}
