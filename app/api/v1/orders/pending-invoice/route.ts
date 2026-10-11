import { NextResponse } from "next/server"
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"

import { orders } from "@/db/schema"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { orderSelectColumns } from "@/lib/order-select"
import { PENDING_INVOICE_STATUSES } from "@/lib/pending-invoice"
import { invoiceStatusSql } from "@/lib/server/invoice-status-sql"
import { orderStillOwesSql } from "@/lib/server/overdue-payment-source"

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" }

/**
 * Return one outstanding invoice belonging to the authenticated user.
 *
 * Ownership is the security boundary here: the query never accepts a user,
 * organization, or branch identifier from the browser. It therefore behaves
 * the same for the single-branch and group storefronts without widening either
 * role's access to somebody else's invoice.
 */
export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE_HEADERS })
  }
  if (user.mustChangePassword) {
    return NextResponse.json(
      { error: "Forbidden", message: "Password change required" },
      { status: 403, headers: NO_STORE_HEADERS },
    )
  }

  const [pendingInvoice] = await db
    .select({
      orderId: orders.id,
      orderReference: orders.tid,
      invoiceNumber: sql<string | null>`${orders.receiptData} ->> 'invoiceNumber'`,
    })
    .from(orders)
    .where(and(
      eq(orders.createdByUserId, user.id),
      eq(orderSelectColumns.paymentStatus, "UNPAID"),
      isNotNull(orders.receiptData),
      // A tax invoice, issued at delivery and not fully credited
      // (lib/pending-invoice.ts). A proforma is not an invoice.
      inArray(invoiceStatusSql, [...PENDING_INVOICE_STATUSES]),
      // An invoice for goods delivered free of charge leaves nothing to pay.
      orderStillOwesSql,
    ))
    .orderBy(desc(orders.createdAt))
    .limit(1)

  const summary = pendingInvoice
    ? {
        orderId: pendingInvoice.orderId,
        invoiceNumber: pendingInvoice.invoiceNumber || pendingInvoice.orderReference,
        orderReference: pendingInvoice.orderReference,
      }
    : null

  return NextResponse.json(
    { hasPendingInvoice: summary !== null, pendingInvoice: summary },
    { headers: NO_STORE_HEADERS },
  )
}
