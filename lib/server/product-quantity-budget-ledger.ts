import { and, eq, inArray, sql } from "drizzle-orm"

import { orderItems, productQuantityBudgets, refundItems, refunds } from "@/db/schema"

type DbLike = any
type OrderLike = {
  id: number
  branchId: number
  createdAt?: Date | string | null
  status?: string | null
}

type QuantityLine = {
  organizationInventoryId: number | null
  quantity: number
}

const orderPeriod = (order: OrderLike) =>
  order.createdAt ? new Date(order.createdAt).toISOString().slice(0, 7) : new Date().toISOString().slice(0, 7)

const approvedRefundStatusSql = sql`UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED')`

async function getNetOrderQuantityLines(tx: DbLike, orderId: number): Promise<QuantityLine[]> {
  const rows = await tx
    .select({
      id: orderItems.id,
      organizationInventoryId: orderItems.organizationInventoryId,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))

  const orderItemIds = rows.map((row: any) => Number(row.id)).filter((id: number) => Number.isInteger(id) && id > 0)
  const refundedQuantityByOrderItemId = new Map<number, number>()

  if (orderItemIds.length > 0) {
    const refundedRows = await tx
      .select({
        orderItemId: refundItems.orderItemId,
        quantity: refundItems.quantity,
      })
      .from(refundItems)
      .innerJoin(refunds, eq(refundItems.refundId, refunds.id))
      .where(and(
        inArray(refundItems.orderItemId, orderItemIds),
        approvedRefundStatusSql,
      ))

    for (const row of refundedRows) {
      refundedQuantityByOrderItemId.set(
        row.orderItemId,
        (refundedQuantityByOrderItemId.get(row.orderItemId) || 0) + Number(row.quantity || 0),
      )
    }
  }

  return rows
    .map((row: any) => ({
      organizationInventoryId: row.organizationInventoryId,
      quantity: Math.max(0, Number(row.quantity || 0) - (refundedQuantityByOrderItemId.get(row.id) || 0)),
    }))
    .filter((row: QuantityLine) => row.organizationInventoryId && row.quantity > 0)
}

async function getRefundQuantityLines(
  tx: DbLike,
  requestedLines: Array<{ orderItemId?: number; itemId?: number; quantity: number }>,
): Promise<QuantityLine[]> {
  const orderItemIds = requestedLines
    .map((line) => line.orderItemId ?? line.itemId)
    .filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0)

  if (orderItemIds.length === 0) return []

  const itemRows = await tx
    .select({
      id: orderItems.id,
      organizationInventoryId: orderItems.organizationInventoryId,
    })
    .from(orderItems)
    .where(inArray(orderItems.id, orderItemIds))

  const organizationInventoryByItemId = new Map<number, number | null>(
    itemRows.map((item: any) => [Number(item.id), item.organizationInventoryId])
  )

  const quantityByOrganizationInventoryId = new Map<number, number>()
  for (const line of requestedLines) {
    const orderItemId = line.orderItemId ?? line.itemId
    if (!orderItemId) continue

    const organizationInventoryId = organizationInventoryByItemId.get(orderItemId)
    if (!organizationInventoryId) continue

    quantityByOrganizationInventoryId.set(
      organizationInventoryId,
      (quantityByOrganizationInventoryId.get(organizationInventoryId) || 0) + Number(line.quantity || 0),
    )
  }

  return Array.from(quantityByOrganizationInventoryId.entries())
    .map(([organizationInventoryId, quantity]) => ({ organizationInventoryId, quantity }))
    .filter((line) => line.quantity > 0)
}

async function applyQuantityDelta(
  tx: DbLike,
  order: OrderLike,
  lines: QuantityLine[],
  delta: "releaseHeld" | "moveHeldToUsed" | "releaseUsed",
) {
  const period = orderPeriod(order)

  for (const line of lines) {
    if (!line.organizationInventoryId || line.quantity <= 0) continue

    const conditions = and(
      eq(productQuantityBudgets.branchId, order.branchId),
      eq(productQuantityBudgets.period, period),
      eq(productQuantityBudgets.organizationInventoryId, line.organizationInventoryId),
    )
    const [current] = await tx
      .select({
        id: productQuantityBudgets.id,
        heldQuantity: productQuantityBudgets.heldQuantity,
        usedQuantity: productQuantityBudgets.usedQuantity,
      })
      .from(productQuantityBudgets)
      .where(conditions)
      .for("update")

    // Money-budget organizations legitimately have no product quantity row.
    if (!current) continue

    const available = delta === "releaseUsed"
      ? Number(current.usedQuantity || 0)
      : Number(current.heldQuantity || 0)
    if (available < line.quantity) {
      throw new Error("QUANTITY_BUDGET_LEDGER_INVARIANT")
    }

    const set =
      delta === "moveHeldToUsed"
        ? {
            heldQuantity: sql`${productQuantityBudgets.heldQuantity} - ${line.quantity}`,
            usedQuantity: sql`${productQuantityBudgets.usedQuantity} + ${line.quantity}`,
            updatedAt: new Date(),
          }
        : delta === "releaseUsed"
          ? {
              usedQuantity: sql`${productQuantityBudgets.usedQuantity} - ${line.quantity}`,
              updatedAt: new Date(),
            }
          : {
              heldQuantity: sql`${productQuantityBudgets.heldQuantity} - ${line.quantity}`,
              updatedAt: new Date(),
            }

    await tx
      .update(productQuantityBudgets)
      .set(set)
      .where(eq(productQuantityBudgets.id, current.id))
  }
}

export async function releaseHeldQuantityBudgetForOrder(tx: DbLike, order: OrderLike) {
  const lines = await getNetOrderQuantityLines(tx, order.id)
  await applyQuantityDelta(tx, order, lines, "releaseHeld")
}

export async function moveHeldQuantityBudgetToUsedForOrder(tx: DbLike, order: OrderLike) {
  const lines = await getNetOrderQuantityLines(tx, order.id)
  await applyQuantityDelta(tx, order, lines, "moveHeldToUsed")
}

export async function releaseQuantityBudgetForDeletedOrder(tx: DbLike, order: OrderLike) {
  const status = String(order.status || "").toUpperCase()
  const lines = await getNetOrderQuantityLines(tx, order.id)

  if (status === "FULFILLED" || status === "REFUNDED") {
    await applyQuantityDelta(tx, order, lines, "releaseUsed")
    return
  }

  if (status === "PENDING" || status === "APPROVED") {
    await applyQuantityDelta(tx, order, lines, "releaseHeld")
  }
}

export async function releaseRefundedQuantityBudget(
  tx: DbLike,
  order: OrderLike,
  requestedLines: Array<{ orderItemId?: number; itemId?: number; quantity: number }>,
) {
  const status = String(order.status || "").toUpperCase()
  const lines = await getRefundQuantityLines(tx, requestedLines)

  await applyQuantityDelta(
    tx,
    order,
    lines,
    status === "FULFILLED" || status === "REFUNDED" ? "releaseUsed" : "releaseHeld",
  )
}
