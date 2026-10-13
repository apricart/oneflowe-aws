import "server-only"

import { sql, type SQL } from "drizzle-orm"

import { invoices, orders } from "@/db/schema"
import { SUPPLIED_ORDER_STATUSES, type InvoiceStatus } from "@/lib/invoice-status"

const supplied = sql.join(SUPPLIED_ORDER_STATUSES.map((status) => sql`${status}`), sql`, `)

const status = sql`UPPER(BTRIM(COALESCE(${orders.status}, '')))`
const fulfillmentStatus = sql`UPPER(BTRIM(COALESCE(${orders.fulfillmentStatus}, '')))`
const statusAtRefund = sql`UPPER(BTRIM(COALESCE(${orders.statusAtRefund}, '')))`

/**
 * The SQL twin of `isOrderSupplied` (lib/invoice-status.ts): the goods behind
 * the order were supplied — delivered, or in a status only delivery reaches.
 */
export const orderSuppliedSql: SQL<boolean> = sql<boolean>`(${status} IN (${supplied})
    OR ${fulfillmentStatus} = 'DELIVERED'
    OR ${statusAtRefund} IN (${supplied}))`

/**
 * The order's tax invoice status, or NULL before one is issued. One row at most
 * (`invoices_order_uq`), and `invoices_status_ck` holds it to the three tax-invoice statuses.
 */
const ledgerStatus = sql`(SELECT ${invoices.status} FROM ${invoices} WHERE ${invoices.orderId} = ${orders.id} LIMIT 1)`

/**
 * The SQL twin of `deriveInvoiceStatus` (lib/invoice-status.ts), branch for
 * branch, for filtering and sorting the order list in the database: the
 * issued invoice's own status when there is one, otherwise derived from the
 * order. `tests/integration/invoice-status.test.ts` runs every combination of
 * status, fulfilment status, status at refund and refund amount through both
 * and requires the same answer.
 */
export const invoiceStatusSql: SQL<InvoiceStatus> = sql<InvoiceStatus>`COALESCE(${ledgerStatus}, CASE
  WHEN ${status} IN ('PENDING', 'REJECTED') THEN 'NOT_ISSUED'
  WHEN ${status} = 'CANCELLED' THEN 'CANCELLED'
  WHEN ${orderSuppliedSql} THEN CASE
    WHEN ${status} = 'REFUNDED' THEN 'CREDITED'
    WHEN COALESCE(${orders.refundAmountCents}, 0) > 0 THEN 'PARTIALLY_CREDITED'
    ELSE 'ISSUED'
  END
  WHEN ${status} = 'REFUNDED' THEN 'CANCELLED'
  WHEN ${status} = 'APPROVED' THEN 'PROFORMA_AVAILABLE'
  ELSE 'NOT_ISSUED'
END)`

/**
 * Sort rank following the document's life: not issued, proforma, issued,
 * partially credited, credited, cancelled.
 */
export const invoiceStatusSortSql: SQL<number> = sql<number>`CASE ${invoiceStatusSql}
  WHEN 'NOT_ISSUED' THEN 0
  WHEN 'PROFORMA_AVAILABLE' THEN 1
  WHEN 'ISSUED' THEN 2
  WHEN 'PARTIALLY_CREDITED' THEN 3
  WHEN 'CREDITED' THEN 4
  ELSE 5
END`
