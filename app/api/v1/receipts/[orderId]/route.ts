import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { branches, organizations, refunds, refundItems, orderItems, users } from "@/db/schema"
import { and, eq } from "drizzle-orm"
import { shouldHidePricesForRole, redactReceiptPrices } from "@/lib/price-visibility"
import { aggregateReceiptRefundItems, getReceiptNetTotal, type ReceiptRefundItem } from "@/lib/receipt-display"
import { getOrderDerivedStatus } from "@/lib/order-status"
import { formatBranchAddress } from "@/lib/branch-address"
import { authorizeInvoiceRequest } from "@/lib/server/invoice-access"
import { getReceiptUserDisplayName } from "@/lib/receipt-user"

function refundHistoryLine(item: any, pricesHidden: boolean) {
    return {
        orderItemId: item.orderItemId,
        productName: item.productName || "Unknown",
        quantity: item.refundedQuantity || 0,
        amount: pricesHidden ? null : (item.refundedAmount || 0) / 100,
    }
}

function mergeRefundHistoryItem(accumulator: any[], item: any, pricesHidden: boolean): any[] {
    if (!item.refundId) return accumulator
    const existing = accumulator.find((refund) => refund.refundId === item.refundId)
    if (existing) {
        if (item.orderItemId) existing.items.push(refundHistoryLine(item, pricesHidden))
        return accumulator
    }
    accumulator.push({
        refundId: item.refundId,
        amount: pricesHidden ? null : (item.refundAmount || 0) / 100,
        taxRefundAmount: pricesHidden ? null : (item.taxRefundAmount || 0) / 100,
        reason: item.refundReason || "",
        status: item.refundStatus || "PENDING",
        createdAt: item.refundCreatedAt || new Date(),
        items: item.orderItemId ? [refundHistoryLine(item, pricesHidden)] : [],
    })
    return accumulator
}

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

        const userIdentityColumns = {
            fullName: users.fullName,
            firstName: users.firstName,
            lastName: users.lastName,
            username: users.username,
            email: users.email,
            phone: users.phone,
        }
        const [creatorRows, approverRows] = await Promise.all([
            db
                .select(userIdentityColumns)
                .from(users)
                .where(eq(users.id, order.createdByUserId))
                .limit(1),
            order.approvedByUserId
                ? db
                    .select(userIdentityColumns)
                    .from(users)
                    .where(eq(users.id, order.approvedByUserId))
                    .limit(1)
                : Promise.resolve([]),
        ])
        const creator = creatorRows[0]
        const approver = approverRows[0]
        const creatorName = getReceiptUserDisplayName(creator, "Unknown")
        const approverName = getReceiptUserDisplayName(
            approver,
            order.approvedByUserId ? "Unknown" : "N/A"
        )

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

        // Fetch refund information
        const refundData = await db
            .select({
                refundId: refunds.id,
                refundAmount: refunds.amountCents,
                taxRefundAmount: refunds.taxRefundCents,
                refundReason: refunds.reason,
                refundStatus: refunds.status,
                refundCreatedAt: refunds.createdAt,
                orderItemId: refundItems.orderItemId,
                refundedQuantity: refundItems.quantity,
                refundedAmount: refundItems.amountCents,
                productName: orderItems.productName,
            })
            .from(refunds)
            .leftJoin(refundItems, eq(refunds.id, refundItems.refundId))
            .leftJoin(orderItems, eq(refundItems.orderItemId, orderItems.id))
            .where(eq(refunds.orderId, orderId))

        // Group refund items by refund
        const refundHistory = refundData.reduce(
            (accumulator, item) => mergeRefundHistoryItem(accumulator, item, pricesHidden),
            [] as any[],
        )

        const approvedRefunds = refundHistory.filter((refund) =>
            ["APPROVED", "COMPLETED"].includes(String(refund.status || "").toUpperCase())
        )
        const totalApprovedRefundAmount = (order.refundAmountCents || 0) / 100
        const refundedItems = aggregateReceiptRefundItems(
            approvedRefunds.flatMap((refund) => refund.items.map((item: ReceiptRefundItem) => ({
                productName: item.productName,
                quantity: item.quantity,
                amount: item.amount,
            })))
        )
        const derivedStatus = getOrderDerivedStatus({
            status: order.status,
            refundAmountCents: order.refundAmountCents,
        }, "fulfilled")

        // Dynamically override receipt data status with actual order status for accuracy
        const finalReceiptData = order.receiptData ? {
            ...(order.receiptData as any),
            buyerAddress: branchAddress,
            organizationName: (order.receiptData as any)?.organizationName || organizationName || "",
            organizationNtn: organizationNtn || (order.receiptData as any)?.organizationNtn || "",
            // The order row is the record of the buyer's purchase order; the
            // snapshot is the fallback for orders whose row predates the column.
            poNumber: order.poNumber || (order.receiptData as any)?.poNumber || "",
            placedByName: creatorName,
            placedByPhone: creator?.phone || null,
            approvedByName: approverName,
            status: derivedStatus.label,
            statusKey: derivedStatus.key,
            refund: totalApprovedRefundAmount,
            refundedItems,
            totalAmount: getReceiptNetTotal(order.receiptData as any, totalApprovedRefundAmount),
        } : null
        const safeReceiptData = pricesHidden ? redactReceiptPrices(finalReceiptData) : finalReceiptData

        return NextResponse.json({
            orderId: order.id,
            orderTid: order.tid,
            status: order.status,
            receiptData: safeReceiptData,
            refundHistory,
            totalRefundAmount: pricesHidden ? null : totalApprovedRefundAmount,
            pricesHidden,
        })
    } catch (e: any) {
        console.error("Invoice retrieval error:", e)
        return NextResponse.json(
            { error: "Internal Server Error" },
            { status: 500 }
        )
    }
}
