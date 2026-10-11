import "server-only"

import { and, eq, sql } from "drizzle-orm"

import { branches, orderItems, organizations, refundItems, refunds } from "@/db/schema"
import { formatBranchAddress } from "@/lib/branch-address"
import { db } from "@/lib/db"
import { getOrderDerivedStatus } from "@/lib/order-status"
import { aggregateReceiptRefundItems, getReceiptNetTotal } from "@/lib/receipt-display"
import { safeFilenamePart } from "@/lib/security"
import type { InvoiceOrder } from "@/lib/server/invoice-access"
import { loadInvoiceParticipants } from "@/lib/server/invoice-participants"
import { renderInvoicePdf } from "@/lib/server/invoice-pdf"
import { describeInvoiceStatus } from "@/lib/invoice-status"
import { invoiceDocumentForOrder } from "@/lib/server/invoice-ledger-reads"

/**
 * One order's invoice PDF — the document itself, with no access decision in
 * it. Every caller authorizes first: the tenant download through
 * `authorizeInvoiceRequest` (`/api/v1/receipts/[orderId]/download`), the
 * warehouse through its branch reach (`/api/v1/warehouse/orders/[id]/invoice`).
 * One builder, so the two can never print different invoices for one order.
 */
export async function buildInvoiceDocument(order: InvoiceOrder): Promise<{ pdf: ArrayBuffer; fileName: string }> {
  const participants = await loadInvoiceParticipants(order)

  let branchAddress = ""
  if (order.branchId !== null && order.organizationId !== null) {
    const [branchDetails] = await db
      .select({
        address: branches.address,
        city: branches.city,
        province: branches.province,
      })
      .from(branches)
      .where(and(
        eq(branches.id, order.branchId),
        eq(branches.organizationId, order.organizationId),
      ))
      .limit(1)
    branchAddress = formatBranchAddress(branchDetails)
  }

  let organizationName = ""
  let organizationNtn = ""
  let organizationStrn = ""
  if (order.organizationId !== null) {
    const [organizationDetails] = await db
      .select({
        name: organizations.name,
        ntnNumber: organizations.ntnNumber,
        strnNumber: organizations.strnNumber,
      })
      .from(organizations)
      .where(eq(organizations.id, order.organizationId))
      .limit(1)
    organizationName = organizationDetails?.name || ""
    organizationNtn = organizationDetails?.ntnNumber || ""
    organizationStrn = organizationDetails?.strnNumber || ""
  }

  const refundRows = await db
    .select({
      productName: orderItems.productName,
      quantity: refundItems.quantity,
      amount: refundItems.amountCents,
    })
    .from(refundItems)
    .innerJoin(refunds, eq(refundItems.refundId, refunds.id))
    .innerJoin(orderItems, eq(refundItems.orderItemId, orderItems.id))
    .where(and(
      eq(refunds.orderId, order.id),
      sql`UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED')`,
    ))

  const totalApprovedRefundAmount = (order.refundAmountCents || 0) / 100
  const refundedItems = aggregateReceiptRefundItems(refundRows.map((item) => ({
    productName: item.productName || "Unknown",
    quantity: item.quantity || 0,
    amount: (item.amount || 0) / 100,
  })))
  const derivedStatus = getOrderDerivedStatus({
    status: order.status,
    refundAmountCents: order.refundAmountCents,
  }, "fulfilled")

  const snapshotReceiptData = {
    ...(order.receiptData as any),
    buyerAddress: branchAddress,
    organizationName: (order.receiptData as any)?.organizationName || organizationName || "",
    organizationNtn: organizationNtn || (order.receiptData as any)?.organizationNtn || "",
    // Recorded on the order rather than in the snapshot: the payment can be
    // settled long after the invoice was issued, and the order reference
    // identifies the order the invoice covers.
    orderId: order.id,
    orderTid: order.tid,
    paymentStatus: order.paymentStatus,
    placedByName: participants.placedByName,
    placedByPhone: participants.placedByPhone,
    approvedByName: participants.approvedByName,
    fulfilledByName: participants.fulfilledByName,
    status: derivedStatus.label,
    statusKey: derivedStatus.key,
    ...describeInvoiceStatus(order, organizationStrn).fields,
    refund: totalApprovedRefundAmount,
    refundedItems,
    totalAmount: getReceiptNetTotal(order.receiptData as any, totalApprovedRefundAmount),
  }

  // An invoice issued at delivery prints from its own ledger rows.
  const receiptData: any = await invoiceDocumentForOrder(order, snapshotReceiptData)
  const pdf = renderInvoicePdf(receiptData)
  const invoiceFilePart = safeFilenamePart(receiptData.invoiceNumber, String(order.id))
  return { pdf, fileName: `invoice-${invoiceFilePart}.pdf` }
}
