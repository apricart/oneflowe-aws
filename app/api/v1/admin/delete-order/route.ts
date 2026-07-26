import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, orderItems, budgets, systemLogs, globalProducts, refunds } from "@/db/schema"
import { eq, and, gte, sql } from "drizzle-orm"
import { releaseQuantityBudgetForDeletedOrder } from "@/lib/server/product-quantity-budget-ledger"
import { orderSelectColumns } from "@/lib/order-select"

/**
 * DELETE /api/v1/admin/delete-order?id=94
 * 
 * Deletes an order and all related data (items, logs, budget adjustments, stock restoration)
 * SUPER_ADMIN only
 */
export async function DELETE(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const role = (session.user as any).role
        const organizationId = (session.user as any).organizationId

        if (role !== "SUPER_ADMIN" && role !== "HEAD_OFFICE") {
            return NextResponse.json({ error: "Admin access required" }, { status: 403 })
        }

        const { searchParams } = new URL(req.url)
        const orderId = searchParams.get("id")

        if (!orderId || !/^\d+$/.test(orderId)) {
            return NextResponse.json({ error: "Valid order ID required" }, { status: 400 })
        }

        const orderIdNum = Number(orderId)

        // Get order details first
        const [order] = await db.select(orderSelectColumns).from(orders).where(eq(orders.id, orderIdNum))

        if (!order) {
            return NextResponse.json({ error: `Order ${orderId} not found` }, { status: 404 })
        }

        // HEAD_OFFICE can only delete orders from their organization
        if (role === "HEAD_OFFICE" && order.organizationId !== organizationId) {
            return NextResponse.json({ error: "Cannot delete orders from other organizations" }, { status: 403 })
        }

        if (!["PENDING", "APPROVED"].includes(String(order.status || "").toUpperCase())) {
            return NextResponse.json({ error: "Only pending or approved orders without financial completion can be deleted" }, { status: 409 })
        }
        if (String(order.paymentStatus || "").toUpperCase() === "PAID") {
            return NextResponse.json({ error: "Paid orders cannot be deleted" }, { status: 409 })
        }

        // Start transaction to safely delete everything
        await db.transaction(async (tx) => {
            const [lockedOrder] = await tx
                .select(orderSelectColumns)
                .from(orders)
                .where(eq(orders.id, orderIdNum))
                .for('update')
            if (!lockedOrder || !["PENDING", "APPROVED"].includes(String(lockedOrder.status || "").toUpperCase())) {
                throw new Error("ORDER_DELETE_CONFLICT")
            }
            if (String(lockedOrder.paymentStatus || "").toUpperCase() === "PAID") {
                throw new Error("ORDER_DELETE_CONFLICT")
            }

            const [refund] = await tx
                .select({ id: refunds.id })
                .from(refunds)
                .where(eq(refunds.orderId, orderIdNum))
                .limit(1)
            if (refund) throw new Error("ORDER_DELETE_HAS_REFUNDS")

            // 1. Get order items (need this to restore stock)
            const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderIdNum))

            // 2. Get the budget period in which this order was created.
            const currentMonth = lockedOrder.createdAt
                ? new Date(lockedOrder.createdAt).toISOString().slice(0, 7)
                : new Date().toISOString().slice(0, 7)
            const [budget] = await tx.select().from(budgets).where(
                and(
                    eq(budgets.branchId, order.branchId),
                    eq(budgets.period, currentMonth)
                )
            )

            await releaseQuantityBudgetForDeletedOrder(tx, lockedOrder)

            // 3. Delete refunds first (foreign key to order_items)
            await tx.delete(refunds).where(eq(refunds.orderId, orderIdNum))

            // 4. Delete order items
            await tx.delete(orderItems).where(eq(orderItems.orderId, orderIdNum))

            // 5. Restore stock to global products
            for (const item of items) {
                await tx.update(globalProducts)
                    .set({
                        stockQuantity: sql`${globalProducts.stockQuantity} + ${item.quantity}`,
                        updatedAt: new Date()
                    })
                    .where(eq(globalProducts.id, item.globalProductId))
            }

            // 6. Release budget hold or remove from spent
            if (budget) {
                const orderStatus = lockedOrder.status.toLowerCase()
                if (orderStatus === 'approved' || orderStatus === 'pending') {
                    // Release from held
                    const [releasedBudget] = await tx.update(budgets)
                        .set({
                            amountHeldCents: sql`${budgets.amountHeldCents} - ${lockedOrder.totalCents}`
                        })
                        .where(and(
                            eq(budgets.id, budget.id),
                            gte(budgets.amountHeldCents, lockedOrder.totalCents),
                        ))
                        .returning({ id: budgets.id })
                    if (!releasedBudget) throw new Error("BUDGET_LEDGER_INVARIANT")
                }
            }

            // 7. Delete system logs
            await tx.delete(systemLogs).where(
                and(
                    eq(systemLogs.resourceType, 'order'),
                    eq(systemLogs.resourceId, String(orderIdNum))
                )
            )

            // 8. Delete the order
            await tx.delete(orders).where(eq(orders.id, orderIdNum))
        })

        return NextResponse.json({
            success: true,
            message: `Order ${orderId} (${order.tid}) deleted successfully`,
            deletedOrder: {
                id: order.id,
                tid: order.tid,
                status: order.status,
                totalPKR: order.totalCents / 100,
                branchId: order.branchId
            }
        })

    } catch (e: any) {
        console.error("Delete order error:", e)
        if (["ORDER_DELETE_CONFLICT", "ORDER_DELETE_HAS_REFUNDS", "BUDGET_LEDGER_INVARIANT", "QUANTITY_BUDGET_LEDGER_INVARIANT"].includes(e?.message)) {
            return NextResponse.json({ error: "Order changed or has financial/refund history and was not deleted" }, { status: 409 })
        }
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}
