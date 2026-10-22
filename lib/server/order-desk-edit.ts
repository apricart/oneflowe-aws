import "server-only"

import { and, eq, inArray, sql } from "drizzle-orm"

import {
  budgets,
  globalProducts,
  orderItems,
  orders,
  productQuantityBudgets,
} from "@/db/schema"
import { db } from "@/lib/db"
import { budgetPeriodOf } from "@/lib/budget-consumption"
import { isOrderDelivered } from "@/lib/fulfillment-status"
import {
  DeskLineRefusal,
  priceDeskOrderLines,
  type DeskOrderLineRequest,
  type PricedDeskLine,
} from "@/lib/order-desk-lines"
import { enteredPriceLines } from "@/lib/order-line-price"
import { orderSelectColumns } from "@/lib/order-select"
import { orderTakesBudget } from "@/lib/organization-budget-policy"
import { formatQuantity, roundQuantity } from "@/lib/quantity"
import { generateReceiptData } from "@/lib/receipt-generator"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"
import { settleDueAddonsOnBudget } from "@/lib/server/budget-addon-expiry"
import { loadDeskBranchLineage } from "@/lib/server/order-desk-catalogue"
import { isOrderDeskTarget, loadOrderDeskReach, orderDeskOrderCondition } from "@/lib/server/order-desk-scope"
import { getOrganizationTaxRateBp } from "@/lib/server/tax-rate"
import { queueWarehouseOrderNotifications } from "@/lib/server/warehouse-order-notifications"

/**
 * An Order Desk edit: the lines, notes and PO number of a desk order that is
 * still `PENDING` — awaiting an Apricart Executive's approval, or returned by
 * one for correction. Never after approval: an edit then would change what the
 * executive approved (plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md).
 *
 * The requester edit (`PUT /api/v1/orders/[id]`) refuses desk orders — the
 * desk corrects its own entries, never the branch — so the desk has this path
 * instead. It follows the same ledger rules, all inside one transaction:
 *
 *   * the order, its lines and every product touched are locked before
 *     anything is read for a decision;
 *   * every line names an active global product and carries the price the
 *     desk entered, tax-inclusive, and is priced and taxed by the same rules
 *     as creation (`priceDeskOrderLines`) — the branch's catalogue entry is
 *     read only for the line's lineage and reference price
 *     (plans/OF-ORDER-DESK-assigned-reach-global-catalogue-budget-exemption.md);
 *   * stock moves by the difference only, and never below zero;
 *   * only an order that took a budget hold moves one (`orderTakesBudget`), on
 *     the row its own period names (`budgetPeriodOf`), after expired add-ons on
 *     that row are settled under its lock;
 *   * the invoice keeps its number and date.
 *
 * A pending order has no approval or fulfilment token to keep.
 */

export class DeskEditRefusal extends Error {}

export type DeskEditOutcome =
  | { kind: "updated"; totalCents: number }
  | { kind: "not-found" }
  | { kind: "target-unavailable" }
  | { kind: "not-editable"; status: string; delivered: boolean }
  | { kind: "invalid"; message: string }
  | { kind: "conflict" }

type EditInput = {
  orderId: number
  items: DeskOrderLineRequest[]
  notes?: string
  /** `undefined` leaves it, `null` clears it. */
  poNumber?: string | null
  actor: AuditActor & { id: string }
}

export async function editDeskOrder(input: EditInput): Promise<DeskEditOutcome> {
  try {
    return await db.transaction((tx) => editInTransaction(tx, input))
  } catch (error) {
    if (error instanceof DeskEditRefusal || error instanceof DeskLineRefusal) return { kind: "invalid", message: error.message }
    if (error instanceof Error && error.message === "ORDER_EDIT_CONFLICT") return { kind: "conflict" }
    throw error
  }
}

async function editInTransaction(tx: any, input: EditInput): Promise<DeskEditOutcome> {
  const reach = await loadOrderDeskReach(tx, input.actor.id, "manage")
  const [order] = await tx
    .select({ ...orderSelectColumns, intakeAttachmentKey: orders.intakeAttachmentKey })
    .from(orders)
    .where(and(eq(orders.id, input.orderId), orderDeskOrderCondition(reach)))
    .for("update")
    .limit(1)
  if (!order) return { kind: "not-found" }

  const delivered = isOrderDelivered(order.fulfillmentStatus)
  if (String(order.status).toUpperCase() !== "PENDING" || delivered) {
    return { kind: "not-editable", status: order.status, delivered }
  }
  // An edit adds demand, so the branch must still be one the desk may order for
  // — managed, assigned and active — re-read under the same locks as creation.
  if (!await isOrderDeskTarget(tx, {
    userId: input.actor.id,
    organizationId: order.organizationId,
    branchId: order.branchId,
    lock: true,
  })) {
    return { kind: "target-unavailable" }
  }

  const organizationId: number = order.organizationId
  const branchId: number = order.branchId
  const inventory = await lockEditProducts(tx, { orderId: order.id, organizationId, branchId, items: input.items })
  const orgTaxRateBp = await getOrganizationTaxRateBp(organizationId)
  const priced = priceEditedLines(input.items, inventory, orgTaxRateBp)

  const tracked = orderTakesBudget(order)
  const period = budgetPeriodOf(order.createdAt)
  const lockedBudget = tracked
    ? await lockAndCheckBudget(tx, { organizationId, branchId, period, order, nextTotalCents: priced.totalCents, actorId: input.actor.id })
    : null
  const quantityRows = tracked
    ? await lockAndCheckQuantityBudgets(tx, {
      organizationId,
      branchId,
      period,
      mode: await getBudgetAllocationModeForOrganization(organizationId),
      oldByInventory: inventory.oldByInventory,
      items: priced.items,
    })
    : []

  const now = new Date()
  const [updated] = await tx
    .update(orders)
    .set({
      subtotalCents: priced.subtotalCents,
      taxCents: priced.taxCents,
      totalCents: priced.totalCents,
      ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
      ...(input.poNumber !== undefined ? { poNumber: input.poNumber || null } : {}),
      updatedAt: now,
    })
    .where(and(
      eq(orders.id, order.id),
      eq(orders.organizationId, organizationId),
      eq(orders.branchId, branchId),
      // An executive's approval racing this edit: whichever claims the row
      // first wins, and an approval made first leaves nothing to edit.
      sql`UPPER(${orders.status}) = 'PENDING'`,
    ))
    .returning({ id: orders.id })
  if (!updated) throw new Error("ORDER_EDIT_CONFLICT")

  if (lockedBudget) {
    await tx
      .update(budgets)
      .set({ amountHeldCents: lockedBudget.amountHeldCents - order.totalCents + priced.totalCents, updatedAt: now })
      .where(eq(budgets.id, lockedBudget.id))
  }
  await moveQuantityHolds(tx, { rows: quantityRows, oldByInventory: inventory.oldByInventory, items: priced.items, actorId: input.actor.id })
  await moveStock(tx, { inventory, items: priced.items })

  await tx.delete(orderItems).where(eq(orderItems.orderId, order.id))
  await tx.insert(orderItems).values(priced.items.map((item) => ({ ...item, orderId: order.id, organizationId })))
  await regenerateReceipt(tx, { order, organizationId, branchId, priced, poNumber: input.poNumber })

  await recordAuditEvent(tx, {
    action: "ORDER_EDITED",
    entity: "order",
    entityId: order.id,
    actor: input.actor,
    organizationId,
    branchId,
    before: { totalCents: order.totalCents, itemCount: inventory.existingItems.length, ...enteredPriceDetails(inventory.existingItems) },
    after: { totalCents: priced.totalCents, itemCount: priced.items.length, ...enteredPriceDetails(priced.items) },
    context: { tid: order.tid, via: "ORDER_DESK" },
  })
  await queueWarehouseOrderNotifications(tx, {
    order: { id: order.id, tid: order.tid, organizationId, branchId },
    event: "EDITED",
    occurrence: now.getTime(),
  })

  return { kind: "updated", totalCents: priced.totalCents }
}

/** Hand-priced lines with the catalogue price each replaced; nothing when there are none. */
function enteredPriceDetails(items: any[]) {
  const enteredPrices = enteredPriceLines(items.map((item) => ({
    ...item,
    priceCents: Number(item.priceCents),
    cataloguePriceCents: item.cataloguePriceCents === null || item.cataloguePriceCents === undefined ? null : Number(item.cataloguePriceCents),
  })))
  return enteredPrices.length === 0 ? {} : { enteredPrices }
}

type EditInventory = Awaited<ReturnType<typeof lockEditProducts>>

async function lockEditProducts(
  tx: any,
  scope: { orderId: number; organizationId: number; branchId: number; items: EditInput["items"] },
) {
  const existingItems = await tx.select().from(orderItems).where(eq(orderItems.orderId, scope.orderId)).for("update")
  const requestedIds = scope.items.map((item) => item.globalProductId)

  // Every product the edit touches — kept, added or removed — so the stock
  // moves below are made against rows nobody else can move meanwhile.
  const productIds = [...new Set<number>([
    ...requestedIds,
    ...existingItems.map((row: any) => row.globalProductId),
  ])]
  const productRows = await tx.select().from(globalProducts)
    .where(inArray(globalProducts.id, productIds))
    .orderBy(globalProducts.id)
    .for("update")

  // Lineage and reference price only; never what makes a product orderable.
  const lineageByProductId = await loadDeskBranchLineage(tx, {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    globalProductIds: requestedIds,
  })

  const oldByProduct = new Map<number, number>()
  const oldByInventory = new Map<number, number>()
  for (const item of existingItems) {
    oldByProduct.set(item.globalProductId, roundQuantity((oldByProduct.get(item.globalProductId) ?? 0) + Number(item.quantity)))
    if (item.organizationInventoryId) {
      oldByInventory.set(item.organizationInventoryId, roundQuantity((oldByInventory.get(item.organizationInventoryId) ?? 0) + Number(item.quantity)))
    }
  }

  return {
    existingItems,
    productIds,
    productById: new Map<number, any>(productRows.map((row: any) => [row.id, row])),
    lineageByProductId,
    oldByProduct,
    oldByInventory,
  }
}

type PricedLine = PricedDeskLine

function priceEditedLines(items: EditInput["items"], inventory: EditInventory, orgTaxRateBp: number) {
  const priced = priceDeskOrderLines(items, {
    productById: inventory.productById,
    lineageByProductId: inventory.lineageByProductId,
    organizationTaxRateBp: orgTaxRateBp,
  })
  for (const line of priced.items) {
    const product = inventory.productById.get(line.globalProductId)
    // Stock this order already holds counts as available to it.
    const available = Number(product.stockQuantity) + (inventory.oldByProduct.get(line.globalProductId) ?? 0)
    if (line.quantity > available) {
      throw new DeskEditRefusal(`Insufficient stock for ${line.productName}. Available: ${formatQuantity(available)}, Requested: ${formatQuantity(line.quantity)}`)
    }
  }
  return priced
}

async function lockAndCheckBudget(
  tx: any,
  input: { organizationId: number; branchId: number; period: string; order: any; nextTotalCents: number; actorId: string },
) {
  const [lockedBudget] = await tx
    .select()
    .from(budgets)
    .where(and(
      eq(budgets.organizationId, input.organizationId),
      eq(budgets.branchId, input.branchId),
      eq(budgets.period, input.period),
    ))
    .for("update")
    .limit(1)
  if (!lockedBudget) throw new DeskEditRefusal(`Budget not configured for order period (${input.period})`)
  // A due add-on is withdrawn under this lock first, so an edit can never grow
  // into money that has expired.
  const settlement = await settleDueAddonsOnBudget(tx, lockedBudget.id, new Date(), { actorUserId: input.actorId })
  if (settlement) lockedBudget.amountCreditedCents = settlement.plan.creditedAfterCents
  if (lockedBudget.amountHeldCents < input.order.totalCents) throw new Error("BUDGET_LEDGER_INVARIANT")
  const available = lockedBudget.amountAllocatedCents + lockedBudget.amountCreditedCents
    - lockedBudget.amountSpentCents - lockedBudget.amountHeldCents + input.order.totalCents
  if (input.nextTotalCents > available) {
    throw new DeskEditRefusal(`Insufficient budget. Required: ${(input.nextTotalCents / 100).toFixed(2)} PKR, Available: ${(available / 100).toFixed(2)} PKR`)
  }
  return lockedBudget as { id: number; amountHeldCents: number }
}

async function lockAndCheckQuantityBudgets(
  tx: any,
  input: {
    organizationId: number
    branchId: number
    period: string
    mode: string
    oldByInventory: Map<number, number>
    items: PricedLine[]
  },
) {
  // Only an order placed before the exemption still takes a budget. In quantity
  // mode every line it holds needs an allocation, which a product outside the
  // branch catalogue cannot have.
  const uncatalogued = input.items.find((item) => item.organizationInventoryId === null)
  if (uncatalogued && input.mode === "quantity") {
    throw new DeskEditRefusal(`Quantity budget is not allocated for ${uncatalogued.productName}`)
  }
  const nextByInventory = quantitiesByInventory(input.items)
  const inventoryIds = [...new Set<number>([...input.oldByInventory.keys(), ...nextByInventory.keys()])]
  if (inventoryIds.length === 0) return []
  const rows = await tx
    .select()
    .from(productQuantityBudgets)
    .where(and(
      eq(productQuantityBudgets.organizationId, input.organizationId),
      eq(productQuantityBudgets.branchId, input.branchId),
      eq(productQuantityBudgets.period, input.period),
      inArray(productQuantityBudgets.organizationInventoryId, inventoryIds),
    ))
    .for("update")
  const rowByInventory = new Map<number, any>(rows.map((row: any) => [row.organizationInventoryId, row]))
  for (const inventoryId of inventoryIds) {
    const previous = input.oldByInventory.get(inventoryId) ?? 0
    const next = nextByInventory.get(inventoryId) ?? 0
    const row = rowByInventory.get(inventoryId)
    const name = input.items.find((item) => item.organizationInventoryId === inventoryId)?.productName ?? "this product"
    if (next > 0 && input.mode === "quantity" && (!row || row.allocatedQuantity + row.creditedQuantity <= 0)) {
      throw new DeskEditRefusal(`Quantity budget is not allocated for ${name}`)
    }
    if (!row) continue
    if (row.heldQuantity < previous) throw new Error("QUANTITY_BUDGET_LEDGER_INVARIANT")
    const available = row.allocatedQuantity + row.creditedQuantity - row.usedQuantity - row.heldQuantity + previous
    if (next > available) {
      throw new DeskEditRefusal(`Insufficient quantity budget for ${name}. Available: ${formatQuantity(available)}, Requested: ${formatQuantity(next)}`)
    }
  }
  return rows as any[]
}

async function moveQuantityHolds(
  tx: any,
  input: { rows: any[]; oldByInventory: Map<number, number>; items: PricedLine[]; actorId: string },
) {
  const nextByInventory = quantitiesByInventory(input.items)
  for (const row of input.rows) {
    const previous = input.oldByInventory.get(row.organizationInventoryId) ?? 0
    const next = nextByInventory.get(row.organizationInventoryId) ?? 0
    if (previous === next) continue
    await tx
      .update(productQuantityBudgets)
      .set({ heldQuantity: roundQuantity(row.heldQuantity - previous + next), updatedByUserId: input.actorId, updatedAt: new Date() })
      .where(eq(productQuantityBudgets.id, row.id))
  }
}

function quantitiesByInventory(items: readonly PricedLine[]): Map<number, number> {
  const byInventory = new Map<number, number>()
  for (const item of items) {
    if (item.organizationInventoryId !== null) byInventory.set(item.organizationInventoryId, item.quantity)
  }
  return byInventory
}

async function moveStock(tx: any, input: { inventory: EditInventory; items: PricedLine[] }) {
  const nextByProduct = new Map<number, number>()
  for (const item of input.items) {
    nextByProduct.set(item.globalProductId, roundQuantity((nextByProduct.get(item.globalProductId) ?? 0) + item.quantity))
  }
  for (const productId of input.inventory.productIds) {
    const product = input.inventory.productById.get(productId)
    if (!product) throw new Error("A previously ordered product could not be reconciled")
    const previous = input.inventory.oldByProduct.get(productId) ?? 0
    const next = nextByProduct.get(productId) ?? 0
    if (previous === next) continue
    const nextStock = roundQuantity(Number(product.stockQuantity) + previous - next)
    if (nextStock < 0) throw new Error("STOCK_LEDGER_INVARIANT")
    await tx.update(globalProducts).set({ stockQuantity: nextStock, updatedAt: new Date() }).where(eq(globalProducts.id, productId))
  }
}

async function regenerateReceipt(
  tx: any,
  input: {
    order: any
    organizationId: number
    branchId: number
    priced: ReturnType<typeof priceEditedLines>
    poNumber: string | null | undefined
  },
) {
  const receiptData = await generateReceiptData({
    orderId: input.order.id,
    orderTid: input.order.tid,
    status: input.order.status,
    organizationId: input.organizationId,
    branchId: input.branchId,
    orderItemsData: input.priced.items,
    subtotalCents: input.priced.subtotalCents,
    taxCents: input.priced.taxCents,
    totalCents: input.priced.totalCents,
    discountCents: 0,
    deliveryChargesCents: 0,
    deliveryAddress: null,
  })
  // The invoice keeps its number, its date and its purchase order reference.
  const previous = input.order.receiptData as any
  // A number drawn at placement survives; otherwise it is issued at delivery.
  if (previous?.invoiceNumber) receiptData.invoiceNumber = previous.invoiceNumber
  receiptData.date = previous?.date || receiptData.date
  // An edit never changes where the goods go, so an order sent to a chosen
  // delivery address keeps that address on its invoice.
  if (previous?.deliveryAddressLabel) {
    receiptData.buyerAddress = previous.buyerAddress
    receiptData.deliveryAddressLabel = previous.deliveryAddressLabel
  }
  const poNumber = input.poNumber !== undefined ? input.poNumber : (input.order.poNumber || previous?.poNumber)
  if (poNumber) receiptData.poNumber = poNumber
  await tx.update(orders).set({ receiptData: receiptData as any }).where(eq(orders.id, input.order.id))
}
