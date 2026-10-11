import "server-only"

import { sql, type SQL } from "drizzle-orm"

import { orders } from "@/db/schema"
import { SUPPLIED_ORDER_STATUSES, type InvoiceStatus } from "@/lib/invoice-status"

const supplied = sql.join(SUPPLIED_ORDER_STATUSES.map((status) => sql`${status}`), sql`, `)

const status = sql`UPPER(BTRIM(COALESCE(${orders.status}, '')))`
const fulfillmentStatus = sql`UPPER(BTRIM(COALESCE(${orders.fulfillmentStatus}, '')))`
const statusAtRefund = sql`UPPER(BTRIM(COALESCE(${orders.statusAtRefund}, '')))`

/**
 * The SQL twin of `deriveInvoiceStatus` (lib/invoice-status.ts), branch for
 * branch, for filtering and sorting the order list in the database.
 * `tests/integration/invoice-status-sql.test.ts` runs every combination of
 * status, fulfilment status, status at refund and refund amount through both
 * and requires the same answer.
 */
export const invoiceStatusSql: SQL<InvoiceStatus> = sql<InvoiceStatus>`CASE
  WHEN ${status} IN ('PENDING', 'REJECTED') THEN 'NOT_ISSUED'
  WHEN ${status} = 'CANCELLED' THEN 'CANCELLED'
  WHEN ${status} IN (${supplied})
    OR ${fulfillmentStatus} = 'DELIVERED'
    OR ${statusAtRefund} IN (${supplied})
  THEN CASE
    WHEN ${status} = 'REFUNDED' THEN 'CREDITED'
    WHEN COALESCE(${orders.refundAmountCents}, 0) > 0 THEN 'PARTIALLY_CREDITED'
    ELSE 'ISSUED'
  END
  WHEN ${status} = 'REFUNDED' THEN 'CANCELLED'
  WHEN ${status} = 'APPROVED' THEN 'PROFORMA_AVAILABLE'
  ELSE 'NOT_ISSUED'
END`

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
