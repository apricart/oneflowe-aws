/**
 * Sort allowlists for the three paginated tables whose sort runs on the server
 * (`plans/OF-TABLE-column-sorting.md`). The keys are the tables' own column
 * keys, so the client sends the key of the header that was clicked; each route
 * maps every key to SQL through a `Record`, which the compiler keeps complete.
 *
 * A price key is refused for a caller whose prices are hidden
 * (`lib/price-visibility.ts`): ordering rows by a figure the caller may not see
 * would disclose its ranking even with the figure itself redacted.
 */

export const ORDER_LIST_SORT_KEYS = [
  "id",
  "tid",
  "branch",
  "costCenter",
  "orderStatus",
  "progress",
  "paymentStatus",
  "refundStatus",
  "orderDate",
  "approvalDate",
  "deliveryDate",
  // Sorts by the document's stage (lib/invoice-status.ts), never an amount.
  "invoiceStatus",
  "amount",
] as const
export type OrderListSortKey = (typeof ORDER_LIST_SORT_KEYS)[number]
// `refundStatus` sorts by the badge (none / partial / full), never the amount.
export const ORDER_LIST_PRICE_SORT_KEYS: readonly OrderListSortKey[] = ["amount"]

export const ORDER_REPORT_SORT_KEYS = [
  "tid",
  "orderDate",
  "userName",
  "employeeId",
  "organizationName",
  "group",
  "groupOrderReference",
  "branchName",
  "status",
  "deliveryStatus",
  "paymentStatus",
  "approvalLevel",
  "financialApproverLevel",
  "approver",
  "quantityOrdered",
  "quantityDelivered",
  "quantityRefunded",
  "subtotalValue",
  "refundValue",
  "netTotalValue",
] as const
export type OrderReportSortKey = (typeof ORDER_REPORT_SORT_KEYS)[number]
export const ORDER_REPORT_PRICE_SORT_KEYS: readonly OrderReportSortKey[] = ["subtotalValue", "refundValue", "netTotalValue"]

export const REFUND_REPORT_SORT_KEYS = [
  "refundNumber",
  "refundDate",
  "tid",
  "reason",
  "requestedBy",
  "organization",
  "group",
  "branch",
  "status",
  "refundType",
  "quantity",
  "amount",
  "processedBy",
] as const
export type RefundReportSortKey = (typeof REFUND_REPORT_SORT_KEYS)[number]
export const REFUND_REPORT_PRICE_SORT_KEYS: readonly RefundReportSortKey[] = ["amount"]

/** The keys a caller may sort by: price keys drop out when prices are hidden. */
export function sortKeysForCaller<K extends string>(
  keys: readonly K[],
  priceKeys: readonly K[],
  pricesHidden: boolean,
): readonly K[] {
  return pricesHidden ? keys.filter((key) => !priceKeys.includes(key)) : keys
}

/**
 * The Consolidated Invoice Report (plans/OF-INVOICE-consolidated-invoices.md).
 * Sorted on the server, in memory, over the bounded row set, so the preview and
 * the PDF print in the same order. No key is withheld: only roles that see
 * prices read this report.
 */
export const CONSOLIDATED_INVOICE_SORT_KEYS = [
  "invoiceNumber",
  "invoiceDate",
  "orderId",
  "orderStatus",
  "department",
  "approver",
  "approverLevel",
  "crc",
  "quantity",
  "valueExclTax",
  "taxRate",
  "tax",
  "total",
] as const
export type ConsolidatedInvoiceSortKey = (typeof CONSOLIDATED_INVOICE_SORT_KEYS)[number]
