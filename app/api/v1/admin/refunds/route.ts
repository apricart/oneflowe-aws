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
import { isPaidForRefund, isRefundEligibleOrderStatus } from "@/lib/business-rules"
import { withRateLimit } from "@/lib/rate-limiter"

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
        const refundRequestIdParam = searchParams.get("refundRequestId")
        const refundRequestId = refundRequestIdParam && /^\d+$/.test(refundRequestIdParam)
            ? Number(refundRequestIdParam)
            : null

        if (refundRequestIdParam && (!refundRequestId || refundRequestId <= 0)) {
            return NextResponse.json({ error: "Invalid refund request ID" }, { status: 400 })
        }

        if (searchParams.has("status") && searchParams.get("status") === "pending") {
            const pendingRefunds = await db
                .select({
                    id: refunds.id,
                    refundNumber: refunds.refundNumber,
                    amountCents: refunds.amountCents,
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
                    refundRequestId
                        ? and(eq(refunds.status, "PENDING"), eq(refunds.id, refundRequestId))
                        : eq(refunds.status, "PENDING")
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
        const approvedQuantityMap = new Map<number, number>()
        const pendingQuantityMap = new Map<number, number>()

        for (const record of refundedItemsData) {
            const status = refundStatusMap.get(record.refundId)
            if (status === "APPROVED" || status === "COMPLETED") {
                const current = approvedQuantityMap.get(record.orderItemId) || 0
                approvedQuantityMap.set(record.orderItemId, current + record.quantity)
            } else if (status === "PENDING") {
                const current = pendingQuantityMap.get(record.orderItemId) || 0
                pendingQuantityMap.set(record.orderItemId, current + record.quantity)
            }
        }

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
        const { orderId, items, reason, refundRequestId } = parsedBody.data

        // ===== INPUT VALIDATION =====

        // Validate orderId
        if (!orderId || !Number.isFinite(orderId) || orderId <= 0) {
            return NextResponse.json({ error: "Valid order ID is required" }, { status: 400 })
        }

        if (refundRequestId !== undefined && (!Number.isInteger(refundRequestId) || refundRequestId <= 0)) {
            return NextResponse.json({ error: "Valid refund request ID is required" }, { status: 400 })
        }

        // Validate items array
        if (!Array.isArray(items) || items.length === 0) {
            return NextResponse.json({ error: "At least one item must be selected for refund" }, { status: 400 })
        }

        // Validate each item
        for (const item of items) {
            if (!item.itemId || !Number.isFinite(item.itemId) || item.itemId <= 0) {
                return NextResponse.json({ error: "Invalid item ID in refund items" }, { status: 400 })
            }
            if (!item.quantity || !Number.isFinite(item.quantity) || item.quantity <= 0) {
                return NextResponse.json({ error: "Refund quantity must be positive" }, { status: 400 })
            }
        }

        // Validate reason
        if (reason !== undefined && reason !== null) {
            if (typeof reason !== "string") {
                return NextResponse.json({ error: "Reason must be a string" }, { status: 400 })
            }
            if (reason.trim().length > 500) {
                return NextResponse.json({ error: "Reason must not exceed 500 characters" }, { status: 400 })
            }
        }

        // ===== FETCH ORDER =====
        const [orderData] = await db
            .select({
                id: orders.id,
                tid: orders.tid,
                organizationId: orders.organizationId,
                branchId: orders.branchId,
                status: orders.status,
                paymentStatus: orders.paymentStatus,
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

        if (!orderData) {
            return NextResponse.json({ error: "Order not found" }, { status: 404 })
        }

        const [pendingRefundRequest] = refundRequestId
            ? await db
                .select({
                    id: refunds.id,
                    reason: refunds.reason,
                    refundNumber: refunds.refundNumber,
                })
                .from(refunds)
                .where(and(
                    eq(refunds.id, refundRequestId),
                    eq(refunds.orderId, orderData.id),
                    eq(refunds.organizationId, orderData.organizationId!),
                    eq(refunds.status, "PENDING"),
                ))
                .limit(1)
            : []

        if (refundRequestId && !pendingRefundRequest) {
            return NextResponse.json({
                error: "This refund request is no longer pending or does not belong to this order and organization."
            }, { status: 409 })
        }

        // ===== STATUS VALIDATION =====
        const currentStatus = String(orderData.status || "").toUpperCase()

        // No longer blocking PENDING orders as per user request

        if (!isRefundEligibleOrderStatus(currentStatus)) {
            return NextResponse.json({
                error: `Order in ${currentStatus || "unknown"} state is not eligible for a refund.`
            }, { status: 400 })
        }

        if (!isPaidForRefund(orderData.paymentStatus)) {
            return NextResponse.json({ error: "Only paid orders are eligible for a refund." }, { status: 400 })
        }

        // ===== VALIDATE REFUND PERIOD (SAME MONTH ONLY) =====
        const orderDate = new Date(orderData.createdAt || new Date())
        const now = new Date()
        const isSameMonth = orderDate.getMonth() === now.getMonth()
        const isSameYear = orderDate.getFullYear() === now.getFullYear()

        if (!isSameMonth || !isSameYear) {
            const orderMonthName = orderDate.toLocaleString('default', { month: 'long', year: 'numeric' })
            return NextResponse.json({
                error: `Refunds are only allowed for orders in the current month. This order is from ${orderMonthName}.`
            }, { status: 403 })
        }

        // ===== FETCH ORDER ITEMS & VALIDATE QUANTITIES =====
        const orderItemsData = await db
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

        if (orderItemsData.length === 0) {
            return NextResponse.json({ error: "No items found for this order" }, { status: 404 })
        }

        // Create a map for quick lookup
        const orderItemsMap = new Map(orderItemsData.map(item => [item.id, item]))

        // Fetch already refunded items to calculate remaining quantity
        const refundedItemsData = await db
            .select({
                refundId: refundItems.refundId, // Added to link to refund status
                orderItemId: refundItems.orderItemId,
                quantity: refundItems.quantity,
            })
            .from(refundItems)
            .innerJoin(refunds, eq(refunds.id, refundItems.refundId))
            .where(and(
                eq(refunds.orderId, orderId),
                or(
                    eq(refunds.status, "APPROVED"),
                    eq(refunds.status, "COMPLETED"),
                    eq(refunds.status, "PENDING")
                )
            ))

        // Fetch refund records with status to distinguish
        const refundRecords = await db
            .select({
                id: refunds.id,
                status: refunds.status,
            })
            .from(refunds)
            .where(eq(refunds.orderId, orderId))

        const refundStatusMap = new Map(refundRecords.map(r => [r.id, r.status]))

        const approvedQuantityMap = new Map<number, number>()
        const pendingQuantityMap = new Map<number, number>()

        for (const record of refundedItemsData) {
            const status = refundStatusMap.get(record.refundId)
            if (status === "APPROVED" || status === "COMPLETED") {
                const current = approvedQuantityMap.get(record.orderItemId) || 0
                approvedQuantityMap.set(record.orderItemId, current + record.quantity)
            } else if (status === "PENDING") {
                const current = pendingQuantityMap.get(record.orderItemId) || 0
                pendingQuantityMap.set(record.orderItemId, current + record.quantity)
            }
        }

        let totalRefundAmount = 0
        const refundDetails: Array<{
            itemId: number
            productName: string
            quantity: number
            priceCents: number
            totalCents: number
        }> = []

        // Validate each refund item and calculate total
        for (const refundItem of items) {
            const orderItem = orderItemsMap.get(refundItem.itemId)

            if (!orderItem) {
                return NextResponse.json({
                    error: `Item ID ${refundItem.itemId} not found in this order`
                }, { status: 400 })
            }

            const quantityValidation = validateProductQuantity(refundItem.quantity, {
                allowDecimalQuantity: orderItem.allowDecimalQuantity,
                quantityStep: orderItem.quantityStep,
                label: `Refund quantity for ${orderItem.productName}`,
            })
            if (!quantityValidation.ok) {
                return NextResponse.json({ error: quantityValidation.error }, { status: 400 })
            }

            const approvedQty = approvedQuantityMap.get(refundItem.itemId) || 0
            const pendingQty = pendingQuantityMap.get(refundItem.itemId) || 0
            const remainingQty = orderItem.quantity - approvedQty

            // Validate quantity doesn't exceed remaining amount
            if (quantityValidation.quantity > remainingQty) {
                return NextResponse.json({
                    error: `Refund quantity (${formatQuantity(quantityValidation.quantity)}) exceeds remaining quantity (${formatQuantity(remainingQty)}) for item: ${orderItem.productName} (Approved: ${formatQuantity(approvedQty)})`
                }, { status: 400 })
            }

            const itemTotal = calculateLineCents(orderItem.priceCents, quantityValidation.quantity)
            totalRefundAmount += itemTotal

            refundDetails.push({
                itemId: refundItem.itemId,
                productName: orderItem.productName,
                quantity: quantityValidation.quantity,
                priceCents: orderItem.priceCents,
                totalCents: itemTotal
            })
        }

        if (!Number.isSafeInteger(totalRefundAmount) || totalRefundAmount <= 0) {
            return NextResponse.json({ error: "Selected items do not have a positive refundable amount" }, { status: 400 })
        }

        // ===== VALIDATE REFUND AMOUNT =====
        const orderTotal = orderData.totalCents || 0
        const approvedTotal = await db
            .select({ amount: refunds.amountCents })
            .from(refunds)
            .where(and(eq(refunds.orderId, orderId), or(eq(refunds.status, "APPROVED"), eq(refunds.status, "COMPLETED"))))
            .then(res => res.reduce((sum, r) => sum + (r.amount || 0), 0))

        const pendingTotal = await db
            .select({ amount: refunds.amountCents })
            .from(refunds)
            .where(and(eq(refunds.orderId, orderId), eq(refunds.status, "PENDING")))
            .then(res => res.reduce((sum, r) => sum + (r.amount || 0), 0))

        const remainingRefundable = orderTotal - approvedTotal

        if (totalRefundAmount > remainingRefundable) {
            return NextResponse.json({
                error: `Total refund amount (PKR ${(totalRefundAmount / 100).toFixed(2)}) exceeds remaining capacity (Total: ${(orderTotal / 100).toFixed(2)}, Approved: ${(approvedTotal / 100).toFixed(2)}).`
            }, { status: 400 })
        }

        const effectiveReason = resolveAdminRefundReason(reason, pendingRefundRequest?.reason)

        // ===== PROCESS REFUND IN TRANSACTION =====
        const processed = await db.transaction(async (tx) => {
            const [lockedOrder] = await tx
                .select({
                    id: orders.id,
                    status: orders.status,
                    paymentStatus: orders.paymentStatus,
                    totalCents: orders.totalCents,
                    refundAmountCents: orders.refundAmountCents,
                    receiptData: orders.receiptData,
                })
                .from(orders)
                .where(eq(orders.id, orderId))
                .for('update')

            if (!lockedOrder || !isRefundEligibleOrderStatus(lockedOrder.status) || !isPaidForRefund(lockedOrder.paymentStatus)) {
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
            const liveApprovedQuantityByItem = new Map<number, number>()
            for (const line of liveApprovedLines) {
                liveApprovedQuantityByItem.set(
                    line.orderItemId,
                    (liveApprovedQuantityByItem.get(line.orderItemId) || 0) + Number(line.quantity || 0),
                )
            }
            for (const detail of refundDetails) {
                const originalItem = orderItemsMap.get(detail.itemId)
                const remainingQuantity = Number(originalItem?.quantity || 0) - (liveApprovedQuantityByItem.get(detail.itemId) || 0)
                if (!originalItem || detail.quantity > remainingQuantity) {
                    throw new Error("REFUND_AVAILABILITY_CONFLICT")
                }
            }

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
