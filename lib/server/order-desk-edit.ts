import "server-only"

import { and, eq, inArray, isNull, sql } from "drizzle-orm"

import {
  branchInventory,
  budgets,
  globalProducts,
  orderItems,
  orders,
  organizationInventory,
  productQuantityBudgets,
} from "@/db/schema"
import { db } from "@/lib/db"
import { budgetPeriodOf } from "@/lib/budget-consumption"
import { isOrderDelivered } from "@/lib/fulfillment-status"
import { orderSelectColumns } from "@/lib/order-select"
import { orderTakesBudget } from "@/lib/organization-budget-policy"
import { calculateLineCents, formatQuantity, roundQuantity, validateProductQuantity } from "@/lib/quantity"
import { generateReceiptData } from "@/lib/receipt-generator"
import { resolveTaxRateBp, splitInclusiveCents } from "@/lib/tax"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"
import { settleDueAddonsOnBudget } from "@/lib/server/budget-addon-expiry"
import { loadGroupPriceOverrides, resolveBranchGroupId, resolveEffectivePriceCents } from "@/lib/server/effective-price"
import { isOrderDeskTarget, loadOrderDeskReach, orderDeskOrderCondition } from "@/lib/server/order-desk-scope"
import { getOrganizationTaxRateBp } from "@/lib/server/tax-rate"

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
 *   * the order, its lines, the branch and organization catalogue rows and every
 *     product touched are locked before anything is read for a decision;
 *   * every line is re-priced through the price ladder and re-taxed, exactly as
 *     creation does — an edited order is charged at today's prices;
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
  items: { organizationInventoryId: number; quantity: number }[]
  notes?: string
  /** `undefined` leaves it, `null` clears it. */
  poNumber?: string | null
  actor: AuditActor & { id: string }
}

export async function editDeskOrder(input: EditInput): Promise<DeskEditOutcome> {
  try {
    return await db.transaction((tx) => editInTransaction(tx, input))
  } catch (error) {
    if (error instanceof DeskEditRefusal) return { kind: "invalid", message: error.message }
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
  const inventory = await lockEditInventory(tx, { orderId: order.id, organizationId, branchId, items: input.items })
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
    before: { totalCents: order.totalCents, itemCount: inventory.existingItems.length },
    after: { totalCents: priced.totalCents, itemCount: priced.items.length },
    context: { tid: order.tid, via: "ORDER_DESK" },
  })

  return { kind: "updated", totalCents: priced.totalCents }
}

type EditInventory = Awaited<ReturnType<typeof lockEditInventory>>

async function lockEditInventory(
  tx: any,
  scope: { orderId: number; organizationId: number; branchId: number; items: EditInput["items"] },
) {
  const existingItems = await tx.select().from(orderItems).where(eq(orderItems.orderId, scope.orderId)).for("update")
  const requestedIds = scope.items.map((item) => item.organizationInventoryId)

  // The same availability rule as creation: on the branch, visible and active;
  // active in the organization; the global product active.
  const assigned = await tx
    .select({ organizationInventoryId: branchInventory.organizationInventoryId })
    .from(branchInventory)
    .where(and(
      eq(branchInventory.branchId, scope.branchId),
      eq(branchInventory.organizationId, scope.organizationId),
      eq(branchInventory.isActive, true),
      eq(branchInventory.isVisible, true),
      isNull(branchInventory.deletedAt),
      inArray(branchInventory.organizationInventoryId, requestedIds),
    ))
    .for("update")
  if (assigned.length !== requestedIds.length) throw new DeskEditRefusal("Some items are no longer available for this branch")

  const inventoryRows = await tx
    .select()
    .from(organizationInventory)
    .where(and(
      eq(organizationInventory.organizationId, scope.organizationId),
      eq(organizationInventory.isActive, true),
      isNull(organizationInventory.deletedAt),
      inArray(organizationInventory.id, requestedIds),
    ))
    .for("update")
  if (inventoryRows.length !== requestedIds.length) throw new DeskEditRefusal("Some items are no longer active for this organization")

  const productIds = [...new Set<number>([
    ...inventoryRows.map((row: any) => row.globalProductId),
    ...existingItems.map((row: any) => row.globalProductId),
  ])]
  const productRows = await tx.select().from(globalProducts).where(inArray(globalProducts.id, productIds)).for("update")

  const groupId = await resolveBranchGroupId(tx, { branchId: scope.branchId, organizationId: scope.organizationId })
  const groupPriceByInventoryId = await loadGroupPriceOverrides(tx, {
    organizationId: scope.organizationId,
    groupId,
    organizationInventoryIds: requestedIds,
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
    inventoryById: new Map<number, any>(inventoryRows.map((row: any) => [row.id, row])),
    productById: new Map<number, any>(productRows.map((row: any) => [row.id, row])),
    groupPriceByInventoryId,
    oldByProduct,
    oldByInventory,
  }
}

type PricedLine = {
  organizationInventoryId: number
  globalProductId: number
  quantity: number
  priceCents: number
  taxRateBp: number
  taxCents: number
  productName: string
  productCode: string
  unit: string
}

function priceEditedLines(items: EditInput["items"], inventory: EditInventory, orgTaxRateBp: number) {
  let subtotalCents = 0
  let taxCents = 0
  let totalCents = 0
  const lines: PricedLine[] = items.map((requested) => {
    const inventoryRow = inventory.inventoryById.get(requested.organizationInventoryId)
    const product = inventoryRow ? inventory.productById.get(inventoryRow.globalProductId) : undefined
    if (!inventoryRow || product?.status !== "active" || product.deletedAt) {
      throw new DeskEditRefusal("A product is no longer available")
    }
    const quantity = validateProductQuantity(requested.quantity, {
      allowDecimalQuantity: product.allowDecimalQuantity,
      quantityStep: product.quantityStep,
      label: `Quantity for ${product.name}`,
    })
    if (!quantity.ok) throw new DeskEditRefusal(quantity.error)
    const priceCents = resolveEffectivePriceCents({
      groupPriceCents: inventory.groupPriceByInventoryId.get(inventoryRow.id),
      organizationPriceCents: inventoryRow.customPrice,
      basePriceCents: product.basePrice,
    })
    if (priceCents === null || !Number.isSafeInteger(priceCents) || priceCents < 0) {
      throw new DeskEditRefusal(`Pricing is unavailable for ${product.name}`)
    }
    // Stock this order already holds counts as available to it.
    const available = Number(product.stockQuantity) + (inventory.oldByProduct.get(product.id) ?? 0)
    if (quantity.quantity > available) {
      throw new DeskEditRefusal(`Insufficient stock for ${product.name}. Available: ${formatQuantity(available)}, Requested: ${formatQuantity(quantity.quantity)}`)
    }
    const taxRateBp = resolveTaxRateBp(product.taxRateBp, orgTaxRateBp)
    const line = splitInclusiveCents(calculateLineCents(priceCents, quantity.quantity), taxRateBp)
    subtotalCents += line.netCents
    taxCents += line.taxCents
    totalCents += line.grossCents
    return {
      organizationInventoryId: inventoryRow.id,
      globalProductId: product.id,
      quantity: quantity.quantity,
      priceCents,
      taxRateBp,
      taxCents: line.taxCents,
      productName: product.name,
      productCode: product.productCode,
      unit: product.unit,
    }
  })
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new DeskEditRefusal("Calculated order total is invalid")
  return { items: lines, subtotalCents, taxCents, totalCents }
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
  const nextByInventory = new Map(input.items.map((item) => [item.organizationInventoryId, item.quantity]))
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
  const nextByInventory = new Map(input.items.map((item) => [item.organizationInventoryId, item.quantity]))
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
