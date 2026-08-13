import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, orderItems, organizations, branches, users, budgets, auditLogs, refunds, refundItems, globalProducts } from "@/db/schema"
import { eq, or, ilike, sql, and, desc, ne } from "drizzle-orm"
import { releaseRefundedQuantityBudget } from "@/lib/server/product-quantity-budget-ledger"
import { calculateLineCents, formatQuantity, validateProductQuantity } from "@/lib/quantity"
import { resolveAdminRefundReason } from "@/lib/admin-refund-approval"
import { adminRefundProcessSchema, validationMessage } from "@/lib/server/mutation-validation"
import { isRefundEligibleOrderStatus } from "@/lib/business-rules"
import { withRateLimit } from "@/lib/rate-limiter"

const parseRefundRequestId = (value: string | null) => {
    if (!value) return { id: null }
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
        return { id: null, response: NextResponse.json({ error: "Invalid refund request ID" }, { status: 400 }) }
    }
    return { id: Number(value) }
}

const getPendingRefundCondition = (refundRequestId: number | null) => (
    refundRequestId
        ? and(eq(refunds.status, "PENDING"), eq(refunds.id, refundRequestId))
        : eq(refunds.status, "PENDING")
)

function aggregateRefundQuantities(
    records: Array<{ refundId: number; orderItemId: number; quantity: number }>,
    statusByRefundId: Map<number, string>,
) {
    const approved = new Map<number, number>()
    const pending = new Map<number, number>()
    for (const record of records) {
        const status = statusByRefundId.get(record.refundId)
        const target = status === "PENDING" ? pending : approved
        if (["PENDING", "APPROVED", "COMPLETED"].includes(status || "")) {
            target.set(record.orderItemId, (target.get(record.orderItemId) || 0) + record.quantity)
        }
    }
    return { approved, pending }
}

function assertRefundQuantitiesAvailable(
    details: Array<{ itemId: number; quantity: number }>,
    orderItemsById: Map<number, any>,
    approvedLines: Array<{ orderItemId: number; quantity: number }>,
) {
    const approvedByItem = new Map<number, number>()
    for (const line of approvedLines) {
        approvedByItem.set(line.orderItemId, (approvedByItem.get(line.orderItemId) || 0) + Number(line.quantity || 0))
    }
    for (const detail of details) {
        const originalItem = orderItemsById.get(detail.itemId)
        const remainingQuantity = Number(originalItem?.quantity || 0) - (approvedByItem.get(detail.itemId) || 0)
        if (!originalItem || detail.quantity > remainingQuantity) throw new Error("REFUND_AVAILABILITY_CONFLICT")
    }
}

function validateAdminRefundRequest(input: any) {
    if (!input.orderId || !Number.isFinite(input.orderId) || input.orderId <= 0) return "Valid order ID is required"
    if (input.refundRequestId !== undefined && (!Number.isInteger(input.refundRequestId) || input.refundRequestId <= 0)) {
        return "Valid refund request ID is required"
    }
    if (!Array.isArray(input.items) || input.items.length === 0) return "At least one item must be selected for refund"
    for (const item of input.items) {
        if (!item.itemId || !Number.isFinite(item.itemId) || item.itemId <= 0) return "Invalid item ID in refund items"
        if (!item.quantity || !Number.isFinite(item.quantity) || item.quantity <= 0) return "Refund quantity must be positive"
    }
    if (input.reason !== undefined && input.reason !== null) {
        if (typeof input.reason !== "string") return "Reason must be a string"
        if (input.reason.trim().length > 500) return "Reason must not exceed 500 characters"
    }
    return null
}

async function loadRefundOrder(orderId: number) {
    const [order] = await db
        .select({
            id: orders.id,
            tid: orders.tid,
            organizationId: orders.organizationId,
            branchId: orders.branchId,
            status: orders.status,
            totalCents: orders.totalCents,
            subtotalCents: orders.subtotalCents,
            taxCents: orders.taxCents,
            statusAtRefund: orders.statusAtRefund,
            refundedAt: orders.refundedAt,
            refundAmountCents: orders.refundAmountCents,
            refundReason: orders.refundReason,
            createdAt: orders.createdAt,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1)
    return order
}

async function loadPendingRefundRequest(refundRequestId: number | undefined, order: any) {
    if (!refundRequestId) return null
    const [pendingRequest] = await db
        .select({ id: refunds.id, reason: refunds.reason, refundNumber: refunds.refundNumber })
        .from(refunds)
        .where(and(
            eq(refunds.id, refundRequestId),
            eq(refunds.orderId, order.id),
            eq(refunds.organizationId, order.organizationId),
            eq(refunds.status, "PENDING"),
        ))
        .limit(1)
    return pendingRequest
}

function getRefundEligibilityError(order: any) {
    const currentStatus = String(order.status || "").toUpperCase()
    if (!isRefundEligibleOrderStatus(currentStatus)) {
        return `Order in ${currentStatus || "unknown"} state is not eligible for a refund.`
    }
    const orderDate = new Date(order.createdAt || new Date())
    const now = new Date()
    if (orderDate.getMonth() === now.getMonth() && orderDate.getFullYear() === now.getFullYear()) return null
    const orderMonthName = orderDate.toLocaleString('default', { month: 'long', year: 'numeric' })
    return `Refunds are only allowed for orders in the current month. This order is from ${orderMonthName}.`
}

async function loadRefundOrderItems(orderId: number) {
    return db
        .select({
            id: orderItems.id,
            organizationId: orderItems.organizationId,
            organizationInventoryId: orderItems.organizationInventoryId,
            orderId: orderItems.orderId,
            globalProductId: orderItems.globalProductId,
            productName: orderItems.productName,
            productCode: orderItems.productCode,
            unit: orderItems.unit,
            quantity: orderItems.quantity,
            priceCents: orderItems.priceCents,
            createdAt: orderItems.createdAt,
            allowDecimalQuantity: globalProducts.allowDecimalQuantity,
            quantityStep: globalProducts.quantityStep,
        })
        .from(orderItems)
        .leftJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
        .where(eq(orderItems.orderId, orderId))
}

async function loadApprovedQuantities(orderId: number) {
    const rows = await db
        .select({ refundId: refundItems.refundId, orderItemId: refundItems.orderItemId, quantity: refundItems.quantity })
        .from(refundItems)
        .innerJoin(refunds, eq(refunds.id, refundItems.refundId))
        .where(and(
            eq(refunds.orderId, orderId),
            or(eq(refunds.status, "APPROVED"), eq(refunds.status, "COMPLETED"), eq(refunds.status, "PENDING")),
        ))
    const records = await db.select({ id: refunds.id, status: refunds.status }).from(refunds).where(eq(refunds.orderId, orderId))
    const statuses = new Map(records.map((record) => [record.id, record.status]))
    const approved = new Map<number, number>()
    for (const row of rows) {
        if (!["APPROVED", "COMPLETED"].includes(statuses.get(row.refundId) || "")) continue
        approved.set(row.orderItemId, (approved.get(row.orderItemId) || 0) + row.quantity)
    }
    return approved
}

function calculateRefundDetails(items: any[], orderItemsById: Map<number, any>, approvedQuantities: Map<number, number>) {
    const details: any[] = []
    let total = 0
    for (const requestedItem of items) {
        const orderItem = orderItemsById.get(requestedItem.itemId)
        if (!orderItem) return { error: `Item ID ${requestedItem.itemId} not found in this order` }
        const validation = validateProductQuantity(requestedItem.quantity, {
            allowDecimalQuantity: orderItem.allowDecimalQuantity,
            quantityStep: orderItem.quantityStep,
            label: `Refund quantity for ${orderItem.productName}`,
        })
        if (!validation.ok) return { error: validation.error }
        const approved = approvedQuantities.get(requestedItem.itemId) || 0
        const remaining = orderItem.quantity - approved
        if (validation.quantity > remaining) {
            return { error: `Refund quantity (${formatQuantity(validation.quantity)}) exceeds remaining quantity (${formatQuantity(remaining)}) for item: ${orderItem.productName} (Approved: ${formatQuantity(approved)})` }
        }
        const itemTotal = calculateLineCents(orderItem.priceCents, validation.quantity)
        total += itemTotal
        details.push({
            itemId: requestedItem.itemId,
            productName: orderItem.productName,
            quantity: validation.quantity,
            priceCents: orderItem.priceCents,
            totalCents: itemTotal,
        })
    }
    if (!Number.isSafeInteger(total) || total <= 0) return { error: "Selected items do not have a positive refundable amount" }
    return { details, total }
}

async function prepareAdminRefund(input: any) {
    const inputError = validateAdminRefundRequest(input)
    if (inputError) return { response: NextResponse.json({ error: inputError }, { status: 400 }) }
    const order = await loadRefundOrder(input.orderId)
    if (!order) return { response: NextResponse.json({ error: "Order not found" }, { status: 404 }) }
    const pendingRequest = await loadPendingRefundRequest(input.refundRequestId, order)
    if (input.refundRequestId && !pendingRequest) {
        return { response: NextResponse.json({
            error: "This refund request is no longer pending or does not belong to this order and organization.",
        }, { status: 409 }) }
    }
    const eligibilityError = getRefundEligibilityError(order)
    if (eligibilityError) return { response: NextResponse.json({ error: eligibilityError }, { status: 400 }) }
    const orderItems = await loadRefundOrderItems(input.orderId)
    if (orderItems.length === 0) {
        return { response: NextResponse.json({ error: "No items found for this order" }, { status: 404 }) }
    }
    const orderItemsById = new Map(orderItems.map((item) => [item.id, item]))
    const approvedQuantities = await loadApprovedQuantities(input.orderId)
    const calculation = calculateRefundDetails(input.items, orderItemsById, approvedQuantities)
    if (calculation.error) {
        return { response: NextResponse.json({ error: calculation.error }, { status: 400 }) }
    }
    const approvedTotal = await db
        .select({ amount: refunds.amountCents })
        .from(refunds)
        .where(and(
            eq(refunds.orderId, input.orderId),
            or(eq(refunds.status, "APPROVED"), eq(refunds.status, "COMPLETED")),
        ))
        .then((rows) => rows.reduce((sum, row) => sum + (row.amount || 0), 0))
    const total = calculation.total!
    if (total > (order.totalCents || 0) - approvedTotal) {
        return { response: NextResponse.json({
            error: `Total refund amount (PKR ${(total / 100).toFixed(2)}) exceeds remaining capacity (Total: ${((order.totalCents || 0) / 100).toFixed(2)}, Approved: ${(approvedTotal / 100).toFixed(2)}).`,
        }, { status: 400 }) }
    }
    return {
        order,
        pendingRequest,
        orderItemsById,
        details: calculation.details!,
        total,
    }
}

/**
 * GET /api/v1/admin/refunds/search?q=<order_tid_or_id>
 * Search for an order by TID or internal ID (Super Admin only)
 */
export async function GET(req: NextRequest) {
    console.log("[Refunds API] GET endpoint called")
    try {
        // Auth check
        const session = await getServerSession(authOptions)
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const userRole = (session.user as any).role
        if (userRole !== "SUPER_ADMIN") {
            return NextResponse.json({ error: "Forbidden: Super Admin access required" }, { status: 403 })
        }

        // Get search query
        const { searchParams } = new URL(req.url)
        const query = searchParams.get("q")?.trim()
        const parsedRefundRequestId = parseRefundRequestId(searchParams.get("refundRequestId"))
        if (parsedRefundRequestId.response) return parsedRefundRequestId.response
        const refundRequestId = parsedRefundRequestId.id

        if (searchParams.has("status") && searchParams.get("status") === "pending") {
            const pendingRefunds = await db
                .select({
                    id: refunds.id,
                    refundNumber: refunds.refundNumber,
                    amountCents: refunds.amountCents,
                    taxRefundCents: refunds.taxRefundCents,
                    reason: refunds.reason,
                    status: refunds.status,
                    createdAt: refunds.createdAt,
                    orderId: orders.id,
                    tid: orders.tid,
                    totalCents: orders.totalCents,
                    organizationName: organizations.name,
                    branchName: branches.name,
                    requestedByName: users.fullName,
                })
                .from(refunds)
                .innerJoin(orders, eq(refunds.orderId, orders.id))
                .leftJoin(organizations, eq(orders.organizationId, organizations.id))
                .leftJoin(branches, eq(orders.branchId, branches.id))
                .leftJoin(users, eq(refunds.requestedByUserId, users.id))
                .where(eq(refunds.status, "PENDING"))
                .orderBy(desc(refunds.createdAt))
                .limit(100)

            return NextResponse.json({ refunds: pendingRefunds })
        }

        if (!query) {
            return NextResponse.json({ error: "Search query or status is required" }, { status: 400 })
        }

        // Sanitize and validate input - TID only
        if (query.length > 50) {
            return NextResponse.json({ error: "Search query too long" }, { status: 400 })
        }

        // Search by TID only (case-insensitive)
        const [orderData] = await db
            .select({
                id: orders.id,
                tid: orders.tid,
                organizationId: orders.organizationId,
                branchId: orders.branchId,
                status: orders.status,
                paymentStatus: orders.paymentStatus,
                subtotalCents: orders.subtotalCents,
                taxCents: orders.taxCents,
                totalCents: orders.totalCents,
                notes: orders.notes,
                createdAt: orders.createdAt,
                fulfilledAt: orders.fulfilledAt,
                approvedAt: orders.approvedAt,
                statusAtRefund: orders.statusAtRefund,
                refundedAt: orders.refundedAt,
                refundAmountCents: orders.refundAmountCents,
                refundReason: orders.refundReason,
                createdByUserId: orders.createdByUserId,
            })
            .from(orders)
            .where(ilike(orders.tid, `%${query}%`))
            .limit(1)

        if (!orderData) {
            return NextResponse.json({ error: "Order not found" }, { status: 404 })
        }

        if (refundRequestId) {
            const [pendingRequest] = await db
                .select({ id: refunds.id })
                .from(refunds)
                .where(and(
                    eq(refunds.id, refundRequestId),
                    eq(refunds.orderId, orderData.id),
                    eq(refunds.organizationId, orderData.organizationId!),
                    eq(refunds.status, "PENDING"),
                ))
                .limit(1)

            if (!pendingRequest) {
                return NextResponse.json({
                    error: "This refund request is no longer pending or does not belong to the selected order."
                }, { status: 409 })
            }
        }

        // Get organization and branch names
        const [org] = await db
            .select({ name: organizations.name })
            .from(organizations)
            .where(eq(organizations.id, orderData.organizationId!))
            .limit(1)

        const [branch] = await db
            .select({ name: branches.name })
            .from(branches)
            .where(eq(branches.id, orderData.branchId))
            .limit(1)

        // Get user name
        const [user] = await db
            .select({ fullName: users.fullName, email: users.email })
            .from(users)
            .where(eq(users.id, orderData.createdByUserId))
            .limit(1)

        // Get order items
        const items = await db
            .select({
                id: orderItems.id,
                productName: orderItems.productName,
                productCode: orderItems.productCode,
                quantity: orderItems.quantity,
                priceCents: orderItems.priceCents,
                unit: orderItems.unit,
                globalProductId: orderItems.globalProductId,
                allowDecimalQuantity: globalProducts.allowDecimalQuantity,
                quantityStep: globalProducts.quantityStep,
            })
            .from(orderItems)
            .leftJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
            .where(eq(orderItems.orderId, orderData.id))

        // Fetch already refunded quantities
        const refundedItemsData = await db
            .select({
                refundId: refundItems.refundId, // Added to link to refund status
                orderItemId: refundItems.orderItemId,
                quantity: refundItems.quantity,
            })
            .from(refundItems)
            .innerJoin(refunds, eq(refunds.id, refundItems.refundId))
            .where(and(
                eq(refunds.orderId, orderData.id),
                or(
                    eq(refunds.status, "APPROVED"),
                    eq(refunds.status, "COMPLETED"),
                    getPendingRefundCondition(refundRequestId)
                )
            ))

        // Fetch refund records with status to distinguish
        const refundRecords = await db
            .select({
                id: refunds.id,
                status: refunds.status,
            })
            .from(refunds)
            .where(eq(refunds.orderId, orderData.id))

        const refundStatusMap = new Map(refundRecords.map(r => [r.id, r.status]))

        // Aggregate refunded vs requested quantities
        const { approved: approvedQuantityMap, pending: pendingQuantityMap } = aggregateRefundQuantities(
            refundedItemsData,
            refundStatusMap,
        )

        // Merge with items
        const itemsWithRefundStats = items.map(item => {
            const approved = approvedQuantityMap.get(item.id) || 0
            const pending = pendingQuantityMap.get(item.id) || 0
            return {
                ...item,
                refundedQuantity: approved, // Represents approved/completed refunds
                requestedQuantity: pending, // Represents pending refunds
                remainingQuantity: item.quantity - approved
            }
        })

        return NextResponse.json({
            order: {
                ...orderData,
                organizationName: org?.name || "Unknown",
                branchName: branch?.name || "Unknown",
                createdByUserName: user?.fullName || user?.email || "Unknown",
                items: itemsWithRefundStats,
            }
        })

    } catch (error: any) {
        console.error("[Refunds Search] Error:", error)
        console.error("[Refunds Search] Error message:", error?.message)
        console.error("[Refunds Search] Error stack:", error?.stack)
        return NextResponse.json({ error: "Internal server error", details: "Request failed" }, { status: 500 })
    }
}

/**
 * POST /api/v1/admin/refunds
 * Process an item-level refund (Super Admin only)
 *
 * Body: { orderId: number, items: Array<{itemId: number, quantity: number}>, reason?: string, refundRequestId?: number }
 */
export async function POST(req: NextRequest) {
    console.log("[Refunds API] POST endpoint called")
    try {
        // Auth check
        const session = await getServerSession(authOptions)
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const userRole = (session.user as any).role
        const userId = (session.user as any).id as string

        if (userRole !== "SUPER_ADMIN") {
            return NextResponse.json({ error: "Forbidden: Super Admin access required" }, { status: 403 })
        }

        const rateLimit = await withRateLimit("refund", userId)
        if (rateLimit) return rateLimit

        // Parse request body
        const rawBody = await req.json().catch(() => null)
        if (!rawBody) {
            return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 })
        }
        const parsedBody = adminRefundProcessSchema.safeParse(rawBody)
        if (!parsedBody.success) {
            return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
        }
        const { orderId, reason } = parsedBody.data
        const preparation = await prepareAdminRefund(parsedBody.data)
        if (preparation.response) return preparation.response
        const orderData = preparation.order!
        const pendingRefundRequest = preparation.pendingRequest
        const orderItemsMap = preparation.orderItemsById!
        const refundDetails = preparation.details!
        const totalRefundAmount = preparation.total!
        const effectiveReason = resolveAdminRefundReason(reason, pendingRefundRequest?.reason)

        // ===== PROCESS REFUND IN TRANSACTION =====
        const processed = await db.transaction(async (tx) => {
            const [lockedOrder] = await tx
                .select({
                    id: orders.id,
                    status: orders.status,
                    totalCents: orders.totalCents,
                    refundAmountCents: orders.refundAmountCents,
                    receiptData: orders.receiptData,
                })
                .from(orders)
                .where(eq(orders.id, orderId))
                .for('update')

            if (!lockedOrder || !isRefundEligibleOrderStatus(lockedOrder.status)) {
                throw new Error("REFUND_ELIGIBILITY_CONFLICT")
            }

            const liveApprovedLines = await tx
                .select({
                    orderItemId: refundItems.orderItemId,
                    quantity: refundItems.quantity,
                })
                .from(refundItems)
                .innerJoin(refunds, eq(refunds.id, refundItems.refundId))
                .where(and(
                    eq(refunds.orderId, orderId),
                    or(eq(refunds.status, "APPROVED"), eq(refunds.status, "COMPLETED")),
                ))
            assertRefundQuantitiesAvailable(refundDetails, orderItemsMap, liveApprovedLines)

            const liveApprovedRefunds = await tx
                .select({ amountCents: refunds.amountCents })
                .from(refunds)
                .where(and(
                    eq(refunds.orderId, orderId),
                    or(eq(refunds.status, "APPROVED"), eq(refunds.status, "COMPLETED")),
                ))
            const liveApprovedRecordTotal = liveApprovedRefunds.reduce(
                (sum, record) => sum + Number(record.amountCents || 0),
                0,
            )
            const liveApprovedTotal = Math.max(liveApprovedRecordTotal, Number(lockedOrder.refundAmountCents || 0))
            if (totalRefundAmount > Number(lockedOrder.totalCents) - liveApprovedTotal) {
                throw new Error("REFUND_AVAILABILITY_CONFLICT")
            }
            const liveCurrentStatus = String(lockedOrder.status || "").toUpperCase()
            const liveNewApprovedTotal = liveApprovedTotal + totalRefundAmount
            const liveIsFullRefund = liveNewApprovedTotal >= Number(lockedOrder.totalCents)

            // 1. Update order with refund info and update receipt data
            let updatedReceiptData = lockedOrder.receiptData as any
            if (updatedReceiptData) {
                // Update receipt with new refund amount and itemized details
                const { updateReceiptWithRefund } = await import('@/lib/receipt-generator')
                updatedReceiptData = updateReceiptWithRefund(
                    updatedReceiptData,
                    totalRefundAmount,
                    refundDetails.map(d => ({
                        productName: d.productName,
                        quantity: d.quantity,
                        amount: d.totalCents / 100
                    }))
                )
            }

            await tx
                .update(orders)
                .set({
                    // Change status to REFUNDED if this is a full refund
                    status: liveIsFullRefund ? "REFUNDED" : liveCurrentStatus,
                    statusAtRefund: liveCurrentStatus,
                    refundedAt: new Date(),
                    refundedByUserId: userId,
                    refundAmountCents: liveNewApprovedTotal,
                    refundReason: effectiveReason || orderData.refundReason,
                    receiptData: updatedReceiptData || lockedOrder.receiptData,
                    updatedAt: new Date(),
                })
                .where(eq(orders.id, orderId))

            // 2. Credit branch budget (add back the refunded amount)
            // Must match the current month's budget period
            const currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM format
            const [budget] = await tx
                .select()
                .from(budgets)
                .where(and(
                    eq(budgets.branchId, orderData.branchId),
                    eq(budgets.period, currentMonth)
                ))
                .limit(1)

            if (budget) {
                // Credit refund amount back to budget (increases available funds)
                await tx
                    .update(budgets)
                    .set({
                        amountCreditedCents: sql`${budgets.amountCreditedCents} + ${totalRefundAmount}`,
                        updatedAt: new Date(),
                    })
                    .where(eq(budgets.id, budget.id))

                console.log(`[Refunds] Budget credited: ${totalRefundAmount} cents added to amountCreditedCents, branch ${orderData.branchId}, period ${currentMonth}`)
            } else {
                console.warn(`[Refunds] No budget found for branch ${orderData.branchId}, period ${currentMonth}. Refund credit skipped.`)
            }

            await releaseRefundedQuantityBudget(
                tx,
                { ...orderData, status: liveCurrentStatus },
                refundDetails.map((item) => ({
                    itemId: item.itemId,
                    quantity: item.quantity,
                })),
            )

            // 3. Create audit log
            await tx.insert(auditLogs).values({
                userId,
                action: "REFUND_PROCESSED",
                entity: "Order",
                entityId: String(orderId),
                organizationId: orderData.organizationId,
                branchId: orderData.branchId,
                metadata: {
                    tid: orderData.tid,
                    previousStatus: liveCurrentStatus,
                    statusPreserved: liveCurrentStatus,
                    refundItems: refundDetails,
                    totalRefundAmountCents: totalRefundAmount,
                    totalRefundAmountPKR: (totalRefundAmount / 100).toFixed(2),
                    totalRefunded: liveNewApprovedTotal,
                    isFullRefund: liveIsFullRefund,
                    reason: effectiveReason || "No reason provided",
                    approvedRefundRequestId: pendingRefundRequest?.id || null,
                },
            })

            // 4. Approve the exact pending request when reviewing one. Direct
            // refunds keep the existing behavior of creating a new record.
            let approvedRefundId: number
            if (pendingRefundRequest) {
                const [approvedRequest] = await tx
                    .update(refunds)
                    .set({
                        amountCents: totalRefundAmount,
                        reason: effectiveReason,
                        status: "APPROVED",
                        processedByUserId: userId,
                        updatedAt: new Date(),
                    })
                    .where(and(
                        eq(refunds.id, pendingRefundRequest.id),
                        eq(refunds.orderId, orderId),
                        eq(refunds.organizationId, orderData.organizationId!),
                        eq(refunds.status, "PENDING"),
                    ))
                    .returning({ id: refunds.id })

                if (!approvedRequest) {
                    throw new Error("PENDING_REFUND_APPROVAL_CONFLICT")
                }

                approvedRefundId = approvedRequest.id
                await tx.delete(refundItems).where(eq(refundItems.refundId, approvedRefundId))
            } else {
                const [newRefund] = await tx.insert(refunds).values({
                    organizationId: orderData.organizationId,
                    orderId,
                    amountCents: totalRefundAmount,
                    reason: effectiveReason,
                    status: "APPROVED",
                    processedByUserId: userId,
                }).returning({ id: refunds.id })

                approvedRefundId = newRefund.id
                await tx.update(refunds)
                    .set({ refundNumber: `Refund-${String(newRefund.id).padStart(6, '0')}` })
                    .where(eq(refunds.id, newRefund.id))
            }

            // 5. Insert refund items
            if (refundDetails.length > 0) {
                await tx.insert(refundItems).values(
                    refundDetails.map(item => ({
                        refundId: approvedRefundId,
                        orderItemId: item.itemId,
                        quantity: item.quantity,
                        amountCents: item.totalCents
                    }))
                )
            }

            // 6. Mark only other pending requests for this order as superseded.
            // This ensures that 'hasRefundRequests' in order list becomes 0 and the "REQUESTED" badge disappears.
            const supersedeConditions = [
                eq(refunds.orderId, orderId),
                eq(refunds.status, "PENDING"),
            ]
            if (pendingRefundRequest) {
                supersedeConditions.push(ne(refunds.id, pendingRefundRequest.id))
            }

            await tx.update(refunds)
                .set({
                    status: "SUPERSEDED",
                    processedByUserId: userId,
                    updatedAt: new Date()
                })
                .where(and(...supersedeConditions))

            return {
                totalRefundedCents: liveNewApprovedTotal,
                orderTotalCents: Number(lockedOrder.totalCents),
            }
        })

        return NextResponse.json({
            message: `Refund of PKR ${(totalRefundAmount / 100).toFixed(2)} processed successfully`,
            refundAmount: (totalRefundAmount / 100).toFixed(2),
            itemsRefunded: refundDetails.length,
            totalRefunded: (processed.totalRefundedCents / 100).toFixed(2),
            orderTotal: (processed.orderTotalCents / 100).toFixed(2),
        })

    } catch (error: any) {
        if (["REFUND_AVAILABILITY_CONFLICT", "REFUND_ELIGIBILITY_CONFLICT", "QUANTITY_BUDGET_LEDGER_INVARIANT"].includes(error?.message)) {
            return NextResponse.json({
                error: "Refund eligibility changed while the request was being processed. Refresh and try again."
            }, { status: 409 })
        }
        if (error?.message === "PENDING_REFUND_APPROVAL_CONFLICT") {
            return NextResponse.json({
                error: "This refund request was already processed or changed. Refresh and try again."
            }, { status: 409 })
        }
        console.error("[Refunds Process] Error:", error)
        console.error("[Refunds Process] Error message:", error?.message)
        console.error("[Refunds Process] Error code:", error?.code)
        console.error("[Refunds Process] Stack:", error?.stack)

        // Handle specific database errors
        if (error.code === "23503") {
            return NextResponse.json({ error: "Referenced order or user not found" }, { status: 404 })
        }

        return NextResponse.json({
            error: "Internal server error while processing refund",
            details: "Request failed"
        }, { status: 500 })
    }
}
