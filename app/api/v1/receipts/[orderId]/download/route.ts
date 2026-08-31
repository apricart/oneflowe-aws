import { NextRequest, NextResponse } from "next/server"
import { safeFilenamePart } from "@/lib/security"
import { db } from "@/lib/db"
import { branches, orderItems, organizations, refundItems, refunds } from "@/db/schema"
import { and, eq, sql } from "drizzle-orm"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { aggregateReceiptRefundItems, getReceiptNetTotal } from "@/lib/receipt-display"
import { getOrderDerivedStatus } from "@/lib/order-status"
import { formatBranchAddress } from "@/lib/branch-address"
import { authorizeInvoiceRequest } from "@/lib/server/invoice-access"
import { loadInvoiceParticipants } from "@/lib/server/invoice-participants"
import { renderInvoicePdf } from "@/lib/server/invoice-pdf"

export async function GET(
    req: NextRequest,
    props: { params: Promise<{ orderId: string }> }
) {
    try {
        const params = await props.params
        const orderId = Number.parseInt(params.orderId)
        if (Number.isNaN(orderId)) {
            return NextResponse.json({ error: "Invalid order ID" }, { status: 400 })
        }

        // Single authority for authentication, tenant isolation, role access,
        // per-user ownership, and invoice availability.
        const access = await authorizeInvoiceRequest(orderId)
        if (!access.ok) {
            return NextResponse.json({ error: access.denial.error }, { status: access.denial.status })
        }
        const { order, role: userRole } = access

        const pricesHidden = await shouldHidePricesForRole(userRole, order.organizationId)
        if (pricesHidden) {
            return NextResponse.json({ error: "Invoice download is unavailable while prices are hidden" }, { status: 403 })
        }

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
        if (order.organizationId !== null) {
            const [organizationDetails] = await db
                .select({
                    name: organizations.name,
                    ntnNumber: organizations.ntnNumber,
                })
                .from(organizations)
                .where(eq(organizations.id, order.organizationId))
                .limit(1)
            organizationName = organizationDetails?.name || ""
            organizationNtn = organizationDetails?.ntnNumber || ""
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
                eq(refunds.orderId, orderId),
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

        const receiptData = {
            ...(order.receiptData as any),
            buyerAddress: branchAddress,
            organizationName: (order.receiptData as any)?.organizationName || organizationName || "",
            organizationNtn: organizationNtn || (order.receiptData as any)?.organizationNtn || "",
            // Recorded on the order rather than in the snapshot: the payment
            // can be settled long after the invoice was issued, and the
            // transaction reference identifies the order the invoice covers.
            orderTid: order.tid,
            paymentStatus: order.paymentStatus,
            placedByName: participants.placedByName,
            placedByPhone: participants.placedByPhone,
            approvedByName: participants.approvedByName,
            fulfilledByName: participants.fulfilledByName,
            status: derivedStatus.label,
            statusKey: derivedStatus.key,
            refund: totalApprovedRefundAmount,
            refundedItems,
            totalAmount: getReceiptNetTotal(order.receiptData as any, totalApprovedRefundAmount),
        }

        const pdfBuffer = renderInvoicePdf(receiptData)
        const invoiceFilePart = safeFilenamePart(receiptData.invoiceNumber, String(orderId))

        return new NextResponse(pdfBuffer, {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="invoice-${invoiceFilePart}.pdf"`,
                // An invoice is per-user tenant data, and a stale copy must
                // never be replayed from a browser or proxy cache.
                "Cache-Control": "no-store",
            },
        })
    } catch (e: any) {
        console.error("Invoice generation error:", e)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
