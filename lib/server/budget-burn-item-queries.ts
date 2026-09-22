import "server-only"

import { and, desc, eq, sql } from "drizzle-orm"

import { orderItems, orders } from "@/db/schema"
import {
  BUDGET_BURN_ITEM_ROW_CAP,
  type ProductWindowRow,
} from "@/lib/budget-burn-item-comparison"
import { db } from "@/lib/db"
import {
  lineConditions,
  lineNetQuantity,
  lineNetValue,
  type ExecutiveFilters,
} from "@/lib/server/executive-analytics-queries"
import type { ExecutiveScope } from "@/lib/server/executive-analytics-scope"

/**
 * Product/unit totals for one requester's month window.
 *
 * This is deliberately line-grain and reuses the Center's refund-aware value,
 * quantity and tenant-fence expressions. `filters.statusSet` decides which
 * order statuses count; the MoM endpoint always passes `consumed` so these
 * rows reconcile with the Spend + Pending figure that was clicked.
 */
export async function loadProductWindow(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
): Promise<ProductWindowRow[]> {
  const rows = await db
    .select({
      productId: orderItems.globalProductId,
      productName: sql<string>`MIN(${orderItems.productName})`,
      unit: orderItems.unit,
      quantity: lineNetQuantity,
      valueCents: lineNetValue,
      orderCount: sql<number>`COUNT(DISTINCT ${orders.id})`.mapWith(Number),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(...lineConditions(scope, filters)))
    .groupBy(orderItems.globalProductId, orderItems.unit)
    .orderBy(desc(lineNetValue))
    .limit(BUDGET_BURN_ITEM_ROW_CAP)

  return rows.map((row) => ({
    productId: row.productId === null ? null : Number(row.productId),
    productName: String(row.productName ?? "Unknown product"),
    unit: String(row.unit ?? ""),
    quantity: Number(row.quantity) || 0,
    valueCents: Number(row.valueCents) || 0,
    orderCount: Number(row.orderCount) || 0,
  }))
}
