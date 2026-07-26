type InvoiceOrderSource = {
  status?: string | null
  statusAtRefund?: string | null
}

const POST_APPROVAL_STATUSES = new Set([
  "APPROVED",
  "FULFILLED",
  "PARTIAL",
  "PARTIALLY_FULFILLED",
])

function normalizeStatus(status?: string | null) {
  return (status || "").trim().toUpperCase()
}

/**
 * An invoice becomes available once an order reaches approval and remains
 * available through later fulfillment/refund states.
 */
export function isInvoiceAvailableForOrder(order: InvoiceOrderSource): boolean {
  const status = normalizeStatus(order.status)

  if (POST_APPROVAL_STATUSES.has(status)) return true

  if (status === "REFUNDED") {
    return POST_APPROVAL_STATUSES.has(normalizeStatus(order.statusAtRefund))
  }

  return false
}
