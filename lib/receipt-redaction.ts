/**
 * Stripping prices out of an invoice snapshot for roles that may not see them.
 *
 * Kept free of any database import so the rule can be unit-tested directly:
 * this is the boundary that decides what a price-restricted role receives, and
 * it is worth being able to assert on rather than infer.
 *
 * `lib/price-visibility` re-exports `redactReceiptPrices`, so callers keep
 * importing it from there.
 */

/**
 * Every monetary field on an invoice line. The tax-exclusive figures the
 * invoice prints are money just as much as the gross ones, so they are redacted
 * together — leaving any of them behind would hand the price back through the
 * invoice.
 *
 * `taxPercent` is deliberately kept: a rate discloses no amount, and the
 * invoice still has to show which rate applied.
 */
function redactReceiptLine(item: any) {
  return { ...item, rate: null, total: null, netRate: null, netAmount: null, tax: null }
}

function redactReceiptLines(items: unknown) {
  return Array.isArray(items) ? items.map(redactReceiptLine) : items
}

function redactReceiptItems(items: unknown) {
  if (!Array.isArray(items)) return items

  return items.map((category: any) => ({
    ...category,
    items: redactReceiptLines(category.items),
    subCategories: Array.isArray(category.subCategories)
      ? category.subCategories.map((subCategory: any) => ({
        ...subCategory,
        items: redactReceiptLines(subCategory.items),
      }))
      : category.subCategories,
  }))
}

export function redactReceiptPrices(receiptData: any) {
  if (!receiptData) return receiptData

  return {
    ...receiptData,
    subtotal: null,
    tax: null,
    discount: null,
    deliveryCharges: null,
    refund: null,
    totalAmount: null,
    refundedItems: Array.isArray(receiptData.refundedItems)
      ? receiptData.refundedItems.map((item: any) => ({ ...item, amount: null }))
      : receiptData.refundedItems,
    items: redactReceiptItems(receiptData.items),
  }
}
