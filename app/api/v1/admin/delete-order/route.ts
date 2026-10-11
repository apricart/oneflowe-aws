import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, orderItems, budgets, globalProducts, refunds, invoices } from "@/db/schema"
import { eq, and, gte, sql } from "drizzle-orm"
import { releaseQuantityBudgetForDeletedOrder } from "@/lib/server/product-quantity-budget-ledger"
import { orderTakesBudget } from "@/lib/organization-budget-policy"
import { orderSelectColumns } from "@/lib/order-select"
import { auditActorFromSession, recordAuditEvent } from "@/lib/server/activity-audit"

const TAX_INVOICED_MESSAGE = "An order with a tax invoice cannot be deleted; refund it instead"

/**
 * A delivered order carries a tax invoice (plans/OF-INVOICE-invoice-ledger.md),
 * and an issued invoice is never destroyed: it is corrected by a credit note.
 * The database refuses it as well (invoices.order_id has no ON DELETE).
 */
function isSupplied(order: { fulfillmentStatus?: string | null }): boolean {
    return String(order.fulfillmentStatus || "").trim().toUpperCase() === "DELIVERED"
}

function invoiceNumberOf(receiptData: unknown): string | null {
    const value = (receiptData as { invoiceNumber?: unknown } | null)?.invoiceNumber
    return typeof value === "string" && value.trim() ? value.trim() : null
}

/**
 * DELETE /api/v1/admin/delete-order?id=94
 * 
 * Deletes an order and its items, releases its budget hold and restores its stock.
 *
 * The order's `system_logs` history is deliberately **not** deleted, and the
 * deletion itself is recorded in `audit_logs` — after this runs, that entry is
 * the only place the order existed.
 *
 * SUPER_ADMIN, or HEAD_OFFICE within its own organization.
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
        if (isSupplied(order)) {
            return NextResponse.json({ error: TAX_INVOICED_MESSAGE }, { status: 409 })
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
            const [invoice] = await tx.select({ id: invoices.id }).from(invoices)
                .where(eq(invoices.orderId, orderIdNum)).limit(1)
            if (invoice || isSupplied(lockedOrder)) throw new Error("ORDER_DELETE_TAX_INVOICED")

            const [refund] = await tx
                .select({ id: refunds.id })
                .from(refunds)
                .where(eq(refunds.orderId, orderIdNum))
                .limit(1)
            if (refund) throw new Error("ORDER_DELETE_HAS_REFUNDS")

            // 1. Get order items (need this to restore stock)
            const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderIdNum))

            // 2. Get the budget period in which this order was created. An
            // order that took no hold when it was placed (its tenant had budgets
            // off) has nothing to release, so no budget row is read for it.
            const releasesBudget = orderTakesBudget(lockedOrder)
            const currentMonth = lockedOrder.createdAt
                ? new Date(lockedOrder.createdAt).toISOString().slice(0, 7)
                : new Date().toISOString().slice(0, 7)
            const [budget] = releasesBudget ? await tx.select().from(budgets).where(
                and(
                    eq(budgets.branchId, order.branchId),
                    eq(budgets.period, currentMonth)
                )
            ) : []

            if (releasesBudget) await releaseQuantityBudgetForDeletedOrder(tx, lockedOrder)

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

            // 7. The order's `system_logs` rows stay.
            //
            // This step used to delete them. Audit rows are append-only by policy
            // (rule 06) precisely so that deleting the subject cannot erase the
            // history of it, and an administrative hard delete is the single case
            // where that history matters most. `system_logs.resource_id` carries
            // no foreign key, so the rows simply outlive the order, which is the
            // point of them.

            // 8. Delete the order, recording what it was.
            //
            // In the same transaction, and before the row goes: afterwards this
            // entry is the only place the order existed. It carries the money and
            // the lines, because those are what a reviewer will be asked about.
            await recordAuditEvent(tx, {
                action: "DELETE_ORDER",
                entity: "order",
                entityId: orderIdNum,
                actor: auditActorFromSession(session),
                organizationId: lockedOrder.organizationId,
                branchId: lockedOrder.branchId,
                before: {
                    tid: lockedOrder.tid,
                    // The invoice number this order held, so the gap it leaves
                    // in the tenant's series can be explained afterwards
                    // (plans/OF-INVOICE-invoice-ledger.md, D5/D6).
                    invoiceNumber: invoiceNumberOf(lockedOrder.receiptData),
                    status: lockedOrder.status,
                    fulfillmentStatus: lockedOrder.fulfillmentStatus,
                    paymentStatus: lockedOrder.paymentStatus,
                    totalCents: lockedOrder.totalCents,
                    createdAt: lockedOrder.createdAt,
                    createdByUserId: lockedOrder.createdByUserId,
                    items: items.map((item) => ({
                        globalProductId: item.globalProductId,
                        quantity: item.quantity,
                        priceCents: item.priceCents,
                    })),
                },
                context: {
                    budgetPeriod: currentMonth,
                    releasedHeldCents: budget ? lockedOrder.totalCents : 0,
                    stockRestoredForProducts: items.map((item) => item.globalProductId),
                    deletedByRole: role,
                },
            })

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
        if (e?.message === "ORDER_DELETE_TAX_INVOICED") {
            return NextResponse.json({ error: TAX_INVOICED_MESSAGE }, { status: 409 })
        }
        return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }
}
