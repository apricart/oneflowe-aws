import { NextRequest } from "next/server"
import { lte, eq, and, isNull, or, sql } from "drizzle-orm"
import { db } from "@/lib/db"
import { orders, auditLogs, budgets } from "@/db/schema"
import { ok, error } from "@/lib/api"
import { moveHeldQuantityBudgetToUsedForOrder } from "@/lib/server/product-quantity-budget-ledger"
import { env } from "@/lib/server/env"

const BATCH_SIZE = 50
// Auto-fulfillment is measured from the immutable physical-delivery timestamp.
const DELIVERED_WINDOW_MS = 48 * 60 * 60 * 1000

function isCronAuthorized(req: NextRequest): boolean {
  return req.headers.get("authorization") === `Bearer ${env.CRON_SECRET}`
}

async function runAutoFulfill(dryRun = false) {
  const cutoff = new Date(Date.now() - DELIVERED_WINDOW_MS)

  // Conditions for auto-fulfillment:
  //   1. Order status is APPROVED (not yet fulfilled by staff)
  //   2. Delivery status is DELIVERED (physically received)
  //   3. No refund has been applied directly on the order (refundedAt / refundAmountCents)
  //   4. No refund record exists in any status (PENDING / APPROVED request blocks auto-fulfill)
  //   5. deliveredAt is older than 48 h (order has been in DELIVERED state for at least 48 h)
  const eligible = await db
    .select({
      id: orders.id,
      tid: orders.tid,
      organizationId: orders.organizationId,
      branchId: orders.branchId,
      totalCents: orders.totalCents,
      createdAt: orders.createdAt,
      status: orders.status,
    })
    .from(orders)
    .where(
      and(
        eq(orders.status, "APPROVED"),
        eq(orders.fulfillmentStatus, "DELIVERED"),
        isNull(orders.refundedAt),
        or(isNull(orders.refundAmountCents), eq(orders.refundAmountCents, 0)),
        lte(orders.deliveredAt, cutoff),
        sql`NOT EXISTS (SELECT 1 FROM "refunds" WHERE "refunds"."order_id" = ${orders.id})`
      )
    )
    .limit(BATCH_SIZE)

  if (eligible.length === 0) {
    return { fulfilled: 0, errors: 0, dryRun }
  }

  if (dryRun) {
    return { fulfilled: 0, errors: 0, dryRun, preview: eligible.map((o) => o.tid) }
  }

  let fulfilled = 0
  let errors = 0

  for (const order of eligible) {
    try {
      const now = new Date()

      const didFulfill = await db.transaction(async (tx) => {
        // Re-read inside the transaction to guard against a simultaneous manual fulfillment
        const [live] = await tx
          .select({ status: orders.status, fulfillmentStatus: orders.fulfillmentStatus })
          .from(orders)
          .where(eq(orders.id, order.id))
          .limit(1)

        if (
          !live ||
          live.status !== "APPROVED" ||
          live.fulfillmentStatus !== "DELIVERED"
        ) {
          // Already fulfilled (or rolled back) by another process — skip safely
          return false
        }

        // 1. Mark order as FULFILLED
        //    fulfillmentStatus stays DELIVERED — it is already correct
        //    fulfilledByUserId is null because this is a system action
        const [claimedOrder] = await tx
          .update(orders)
          .set({
            status: "FULFILLED",
            fulfilledAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(orders.id, order.id),
            eq(orders.status, "APPROVED"),
            eq(orders.fulfillmentStatus, "DELIVERED"),
            sql`NOT EXISTS (SELECT 1 FROM "refunds" WHERE "refunds"."order_id" = ${orders.id})`,
          ))
          .returning({ id: orders.id })

        if (!claimedOrder) return false

        // 2. Move budget: held → spent (mirrors the manual fulfill route exactly)
        const orderMonth = order.createdAt
          ? new Date(order.createdAt).toISOString().slice(0, 7)
          : now.toISOString().slice(0, 7)

        const [budget] = await tx
          .select()
          .from(budgets)
          .where(and(eq(budgets.branchId, order.branchId), eq(budgets.period, orderMonth)))
          .limit(1)

        if (budget) {
          await tx.update(budgets).set({
            amountHeldCents: sql`${budgets.amountHeldCents} - ${order.totalCents}`,
            amountSpentCents: sql`${budgets.amountSpentCents} + ${order.totalCents}`,
          }).where(eq(budgets.id, budget.id))
        }

        // 3. Move quantity budget: held → used
        await moveHeldQuantityBudgetToUsedForOrder(tx, order)

        // 4. Audit log
        await tx.insert(auditLogs).values({
          userId: null,
          organizationId: order.organizationId,
          branchId: order.branchId,
          action: "ORDER_AUTO_FULFILLED",
          entity: "Order",
          entityId: String(order.id),
          metadata: {
            tid: order.tid,
            reason: "Auto-fulfilled: delivered 48+ hours ago with no refund request",
            deliveryCutoff: cutoff.toISOString(),
          },
        })

        return true
      })

      if (didFulfill) fulfilled++
    } catch (e) {
      console.error(`[AutoFulfill] Failed on order ${order.tid}:`, e)
      errors++
    }
  }

  return { fulfilled, errors, dryRun }
}

// POST — EventBridge trigger or manual preview with { "dry_run": true }.
export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) return error("Unauthorized", 401)

  const body = await req.json().catch(() => ({}))
  const dryRun = body?.dry_run === true

  try {
    const result = await runAutoFulfill(dryRun)
    console.info("[AutoFulfill] Manual run complete:", result)
    return ok(result)
  } catch (e) {
    console.error("[AutoFulfill] Unexpected error:", e)
    return error("Auto-fulfillment run failed", 500)
  }
}
