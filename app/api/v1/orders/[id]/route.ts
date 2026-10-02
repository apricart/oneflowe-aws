import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm"
import { getServerSession } from "next-auth"
import {
  auditLogs,
  branches,
  branchInventory,
  budgets,
  globalProducts,
  notifications,
  orderItems,
  orders,
  organizationInventory,
  productQuantityBudgets,
  refundItems,
  refunds,
  roles,
  users,
} from "@/db/schema"
import { error, ok, requireApiRole } from "@/lib/api"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { applyOrderCreatorContactVisibility } from "@/lib/order-detail-visibility"
import {
  canRequesterActOnOrder,
  canRequesterEditOrder,
  describeOrderWrite,
  isOrderWriteRole,
} from "@/lib/order-write-access"
import { orderSelectColumns } from "@/lib/order-select"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { notifyRaiserOfOrderWrite } from "@/lib/server/order-write-audit"

type CurrentOrderUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>

/**
 * The session identifies the actor; nothing about who may be edited comes from
 * the request. Both requester roles reach this endpoint, so the check is that
 * the session agrees with itself and names a tenant — the branch set is
 * resolved separately, and is what actually bounds the edit.
 */
const isValidOrderWriteActor = (
  user: Awaited<ReturnType<typeof getCurrentUser>>,
  scope: Awaited<ReturnType<typeof getRequestScope>>,
): user is CurrentOrderUser => (
  user != null
  && user.id === scope?.userId
  && isOrderWriteRole(user.role)
  && user.role === scope?.role
  && Boolean(scope.organizationId)
)

/**
 * Every branch the actor may write to.
 *
 * `ORDER_PORTAL` is pinned to the one branch on its user row.
 * `GROUP_ORDER_PORTAL` has none of its own and reaches the set an
 * administrator assigned it. An empty result denies every order rather than
 * falling through to the tenant.
 */
async function resolveWritableBranchIds(
  role: string,
  userId: string,
  scope: RequestScope | null,
): Promise<number[]> {
  if (usesMultiBranchScope(role)) return resolveScopedBranchIds(db, userId)
  return scope?.branchId ? [scope.branchId] : []
}

const getOrderEditResultResponse = (result: any, pricesHidden: boolean) => {
  if (result.kind === "not-found") return error("Order not found", 404)
  if (result.kind === "forbidden") return error("Forbidden", 403)
  if (result.kind === "invalid-state") {
    return error(`Only pending orders can be edited. This order is ${result.status}.`, 409)
  }
  return ok({
    message: "Order updated successfully",
    order: pricesHidden
      ? { ...result.order, subtotalCents: null, taxCents: null, totalCents: null }
      : result.order,
  })
}

const getOrderEditErrorResponse = (editError: any) => {
  const message = String(editError?.message || "")
  const normalizedMessage = message.toLowerCase()
  if (message === "ORDER_EDIT_CONFLICT") {
    return error("Order was already approved, rejected, or otherwise changed", 409)
  }
  if (message === DELIVERY_ADDRESS_UNAVAILABLE) return error(message, 400)
  if (["BUDGET_LEDGER_INVARIANT", "QUANTITY_BUDGET_LEDGER_INVARIANT", "STOCK_LEDGER_INVARIANT"].includes(message)) {
    return error("Order reservations are inconsistent; the order was not changed", 409)
  }
  const isCustomerError = message.startsWith("Insufficient stock")
    || message.startsWith("Budget not configured")
    || message.includes("Insufficient budget")
    || normalizedMessage.includes("quantity budget")
    || normalizedMessage.includes("no longer")
    || normalizedMessage.includes("pricing is unavailable")
    || normalizedMessage.includes("quantity for")
  return isCustomerError ? error(message, 400) : null
}
import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"
import { getCurrentUser, getRequestScope, type RequestScope } from "@/lib/auth"
import { calculateLineCents, formatQuantity, roundQuantity, validateProductQuantity } from "@/lib/quantity"
import { resolveTaxRateBp, splitInclusiveCents } from "@/lib/tax"
import { getOrganizationTaxRateBp } from "@/lib/server/tax-rate"
import { withRateLimit } from "@/lib/rate-limiter"
import { generateReceiptData } from "@/lib/receipt-generator"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"
import { settleDueAddonsOnBudget } from "@/lib/server/budget-addon-expiry"
import { orderTakesBudget } from "@/lib/organization-budget-policy"
import { orderUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"
import { DELIVERY_ADDRESS_UNAVAILABLE } from "@/lib/delivery-address"
import { loadApprovedDeliveryAddress } from "@/lib/server/delivery-addresses"
import { getOrderDecisionCapabilities } from "@/lib/server/order-decision-policy"
import {
  canUseScopedBranch,
  resolveScopedBranchIds,
  usesMultiBranchScope,
} from "@/lib/server/multi-branch-scope"
import { canOrderPortalReadOrder, isGroupPortalOrder } from "@/lib/group-order-visibility"
import { loadGroupPriceOverrides, resolveBranchGroupId, resolveEffectivePriceCents } from "@/lib/server/effective-price"

/**
 * Branch authorization for reading one order.
 *
 * `verifyResourceAccess` compares the order's branch against the single branch
 * pinned on the user row, which is exactly right for SUPER_ADMIN, HEAD_OFFICE,
 * BRANCH_ADMIN and ORDER_PORTAL and is left untouched for them. Neither group
 * role has a single branch — each reaches the set of branches an administrator
 * assigned it — so both are checked against that resolved set instead, with the
 * tenant re-asserted explicitly first. An empty assignment set denies access
 * rather than widening to the organization.
 *
 * The approver was the first role to need this; the requester needs the same
 * check for the same reason, and keying it on `usesMultiBranchScope` says that
 * once rather than naming one role and quietly meaning both.
 */
async function hasBranchAccessForOrderRead(
  role: unknown,
  userId: unknown,
  scope: RequestScope | null,
  order: { organizationId: number; branchId: number },
): Promise<boolean> {
  const { verifyResourceAccess } = await import("@/lib/auth")
  if (!usesMultiBranchScope(role)) {
    return verifyResourceAccess(order.organizationId, order.branchId)
  }
  if (typeof userId !== "string" || !scope || scope.userId !== userId || scope.role !== role) {
    return false
  }
  if (!scope.organizationId || scope.organizationId !== order.organizationId) return false
  return canUseScopedBranch(userId, order.branchId)
}

/**
 * Lock the order and decide whether this actor may edit it.
 *
 * The order is located by id and tenant only — **not** by creator and not by
 * the actor's branch — because the branch that owns the order is what decides
 * access, and a `GROUP_ORDER_PORTAL` actor has no branch of its own to match
 * against. Authorization is then the branch-set test in
 * `lib/order-write-access.ts`, so an order at a branch this actor was never
 * assigned is refused here, after the row is read but before anything is
 * written.
 *
 * The actor's role and tenant are re-read from the database inside the
 * transaction rather than trusted from the session, so a role or assignment
 * revoked mid-request cannot be used.
 */
async function lockOrderEditAccess(tx: any, context: any) {
  const { userId, organizationId, orderId } = context
  const [actor] = await tx.select({
    id: users.id,
    role: roles.name,
    organizationId: users.organizationId,
    branchId: users.branchId,
  }).from(users).innerJoin(roles, eq(users.roleId, roles.id)).where(and(
    eq(users.id, userId),
    eq(users.isActive, true),
    isNull(users.deletedAt),
  )).limit(1)
  if (!isOrderWriteRole(actor?.role) || actor.organizationId !== organizationId) {
    return { kind: "forbidden" } as const
  }

  // Re-resolved on the transaction handle, not taken from the pre-flight check
  // in the handler: an assignment revoked between the two must deny the edit,
  // and this is the copy the decision is actually made on.
  const allowedBranchIds = usesMultiBranchScope(actor.role)
    ? await resolveScopedBranchIds(tx, actor.id)
    : (actor.branchId ? [actor.branchId] : [])
  if (allowedBranchIds.length === 0) return { kind: "forbidden" } as const

  const [existingOrder] = await tx.select().from(orders).where(and(
    eq(orders.id, orderId),
    eq(orders.organizationId, organizationId),
  )).for("update").limit(1)
  if (!existingOrder) return { kind: "not-found" } as const

  const [orderBranch] = await tx.select({ organizationId: branches.organizationId })
    .from(branches).where(eq(branches.id, existingOrder.branchId)).for("share").limit(1)

  const writeActor = {
    role: actor.role,
    userId: actor.id,
    organizationId: actor.organizationId,
    branchIds: allowedBranchIds,
  }
  const subject = {
    status: existingOrder.status,
    createdByUserId: existingOrder.createdByUserId,
    organizationId: existingOrder.organizationId,
    branchId: existingOrder.branchId,
    branchOrganizationId: orderBranch?.organizationId,
  }

  // Out of scope reads as "not found", matching the read path, so the response
  // cannot be used to discover that an order exists at another branch.
  if (!canRequesterActOnOrder(writeActor, subject)) return { kind: "not-found" } as const
  if (!canRequesterEditOrder(writeActor, subject)) {
    return { kind: "invalid-state", status: existingOrder.status } as const
  }

  return { actor, existingOrder, write: describeOrderWrite(writeActor, subject) }
}

function indexExistingOrderQuantities(existingItems: any[]) {
  const byProduct = new Map<number, number>()
  const byInventory = new Map<number, number>()
  for (const item of existingItems) {
    byProduct.set(item.globalProductId, roundQuantity((byProduct.get(item.globalProductId) || 0) + Number(item.quantity)))
    if (item.organizationInventoryId) {
      byInventory.set(item.organizationInventoryId, roundQuantity((byInventory.get(item.organizationInventoryId) || 0) + Number(item.quantity)))
    }
  }
  return { byProduct, byInventory }
}

async function loadOrderEditInventory(tx: any, context: any) {
  const existingItems = await tx.select().from(orderItems)
    .where(eq(orderItems.orderId, context.orderId)).for("update")
  const requestedInventoryIds = context.normalizedItems.map((item: any) => item.organizationInventoryId)
  const assignedInventory = await tx.select({ organizationInventoryId: branchInventory.organizationInventoryId })
    .from(branchInventory).where(and(
      eq(branchInventory.branchId, context.branchId),
      eq(branchInventory.organizationId, context.organizationId),
      eq(branchInventory.isActive, true),
      eq(branchInventory.isVisible, true),
      isNull(branchInventory.deletedAt),
      inArray(branchInventory.organizationInventoryId, requestedInventoryIds),
    )).for("update")
  if (assignedInventory.length !== requestedInventoryIds.length) {
    throw new Error("Some items are no longer available for this branch")
  }
  const inventoryRows = await tx.select().from(organizationInventory).where(and(
    eq(organizationInventory.organizationId, context.organizationId),
    eq(organizationInventory.isActive, true),
    isNull(organizationInventory.deletedAt),
    inArray(organizationInventory.id, requestedInventoryIds),
  )).for("update")
  if (inventoryRows.length !== requestedInventoryIds.length) {
    throw new Error("Some items are no longer active for this organization")
  }
  const allGlobalProductIds = Array.from(new Set([
    ...inventoryRows.map((item: any) => item.globalProductId),
    ...existingItems.map((item: any) => item.globalProductId),
  ]))
  const productRows = await tx.select().from(globalProducts)
    .where(inArray(globalProducts.id, allGlobalProductIds)).for("update")
  // The group tier of the price ladder, read inside the same transaction that
  // re-prices the order. An edited order is always re-priced at the rates in
  // force now, which is the behaviour that was already documented below.
  const groupId = await resolveBranchGroupId(tx, {
    branchId: context.branchId,
    organizationId: context.organizationId,
  })
  const groupPriceByInventoryId = await loadGroupPriceOverrides(tx, {
    organizationId: context.organizationId,
    groupId,
    organizationInventoryIds: requestedInventoryIds,
  })
  return {
    existingItems,
    allGlobalProductIds,
    inventoryById: new Map(inventoryRows.map((item: any) => [item.id, item])),
    productById: new Map(productRows.map((product: any) => [product.id, product])),
    groupPriceByInventoryId,
    oldQuantities: indexExistingOrderQuantities(existingItems),
  }
}

function calculateEditedItems(normalizedItems: any[], inventoryData: any, orgTaxRateBp: number) {
  let subtotalCents = 0
  let taxCents = 0
  let totalCents = 0
  const items = normalizedItems.map((requestedItem) => {
    const inventoryItem: any = inventoryData.inventoryById.get(requestedItem.organizationInventoryId)
    if (!inventoryItem) throw new Error("An inventory item is no longer available")
    const product: any = inventoryData.productById.get(inventoryItem.globalProductId)
    if (product?.status !== "active" || product.deletedAt) throw new Error("A product is no longer available")
    const validation = validateProductQuantity(requestedItem.quantity, {
      allowDecimalQuantity: product.allowDecimalQuantity,
      quantityStep: product.quantityStep,
      label: `Quantity for ${product.name}`,
    })
    if (!validation.ok) throw new Error(validation.error)
    const priceCents = resolveEffectivePriceCents({
      groupPriceCents: inventoryData.groupPriceByInventoryId?.get(inventoryItem.id),
      organizationPriceCents: inventoryItem.customPrice,
      basePriceCents: product.basePrice,
    })
    if (priceCents === null || !Number.isSafeInteger(priceCents) || priceCents < 0) throw new Error(`Pricing is unavailable for ${product.name}`)
    const availableStock = Number(product.stockQuantity) + (inventoryData.oldQuantities.byProduct.get(product.id) || 0)
    if (validation.quantity > availableStock) {
      throw new Error(`Insufficient stock for ${product.name}. Available: ${formatQuantity(availableStock)}, Requested: ${formatQuantity(validation.quantity)}`)
    }
    // Prices are tax-inclusive, so the gross line amount is what the branch
    // pays and the split only records how much of it is tax. Recomputing rather
    // than carrying the old figures forward is what keeps an edited order
    // consistent with the rates in force when it is re-priced.
    const lineTaxRateBp = resolveTaxRateBp(product.taxRateBp, orgTaxRateBp)
    const line = splitInclusiveCents(calculateLineCents(priceCents, validation.quantity), lineTaxRateBp)
    subtotalCents += line.netCents
    taxCents += line.taxCents
    totalCents += line.grossCents
    return {
      organizationInventoryId: inventoryItem.id,
      globalProductId: product.id,
      quantity: validation.quantity,
      priceCents,
      taxRateBp: lineTaxRateBp,
      taxCents: line.taxCents,
      productName: product.name,
      productCode: product.productCode,
      unit: product.unit,
    }
  })
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new Error("Calculated order total is invalid")
  return { items, subtotalCents, taxCents, totalCents }
}

async function lockAndValidateOrderBudget(tx: any, context: any) {
  const orderPeriod = context.existingOrder.createdAt
    ? new Date(context.existingOrder.createdAt).toISOString().slice(0, 7)
    : new Date().toISOString().slice(0, 7)
  const [lockedBudget] = await tx.select().from(budgets).where(and(
    eq(budgets.organizationId, context.organizationId),
    eq(budgets.branchId, context.branchId),
    eq(budgets.period, orderPeriod),
  )).for("update").limit(1)
  if (!lockedBudget) throw new Error(`Budget not configured for order period (${orderPeriod})`)
  // A due add-on is withdrawn under this lock before the edited total is
  // checked, so an edit cannot grow into money that has expired.
  const settlement = await settleDueAddonsOnBudget(tx, lockedBudget.id, new Date(), { actorUserId: context.userId })
  if (settlement) lockedBudget.amountCreditedCents = settlement.plan.creditedAfterCents
  if (lockedBudget.amountHeldCents < context.existingOrder.totalCents) throw new Error("BUDGET_LEDGER_INVARIANT")
  const available = lockedBudget.amountAllocatedCents + lockedBudget.amountCreditedCents
    - lockedBudget.amountSpentCents - lockedBudget.amountHeldCents + context.existingOrder.totalCents
  if (context.totalCents > available) {
    throw new Error(context.pricesHidden
      ? "Insufficient budget. Please contact head office."
      : `Insufficient budget. Required: ${(context.totalCents / 100).toFixed(2)} PKR, Available: ${(available / 100).toFixed(2)} PKR`)
  }
  return { lockedBudget, orderPeriod }
}

function validateQuantityBudget(context: any) {
  const previous = context.previousQuantity
  const next = context.nextQuantity
  const row = context.row
  if (next > 0 && context.mode === "quantity" && (!row || row.allocatedQuantity + row.creditedQuantity <= 0)) {
    throw new Error(`Quantity budget is not allocated for ${context.productName}. Please select an allocated product.`)
  }
  if (!row) return
  if (row.heldQuantity < previous) throw new Error("QUANTITY_BUDGET_LEDGER_INVARIANT")
  const available = row.allocatedQuantity + row.creditedQuantity - row.usedQuantity - row.heldQuantity + previous
  if (next > available) {
    throw new Error(`Insufficient quantity budget for ${context.productName}. Available: ${formatQuantity(available)}, Requested: ${formatQuantity(next)}`)
  }
}

async function lockOrderQuantityBudgets(tx: any, context: any) {
  const nextByInventory = new Map(context.calculatedItems.map((item: any) => [item.organizationInventoryId, item.quantity]))
  const inventoryIds = Array.from(new Set([
    ...context.oldByInventory.keys(),
    ...nextByInventory.keys(),
  ])) as number[]
  const rows = inventoryIds.length > 0 ? await tx.select().from(productQuantityBudgets).where(and(
    eq(productQuantityBudgets.organizationId, context.organizationId),
    eq(productQuantityBudgets.branchId, context.branchId),
    eq(productQuantityBudgets.period, context.orderPeriod),
    inArray(productQuantityBudgets.organizationInventoryId, inventoryIds),
  )).for("update") : []
  const rowByInventory = new Map(rows.map((row: any) => [row.organizationInventoryId, row]))
  for (const inventoryId of inventoryIds) {
    const productName = context.calculatedItems.find((item: any) => item.organizationInventoryId === inventoryId)?.productName || "this product"
    validateQuantityBudget({
      previousQuantity: context.oldByInventory.get(inventoryId) || 0,
      nextQuantity: nextByInventory.get(inventoryId) || 0,
      row: rowByInventory.get(inventoryId),
      mode: context.mode,
      productName,
    })
  }
  return { rows, nextByInventory }
}

async function updateOrderQuantityBudgets(tx: any, context: any) {
  for (const row of context.rows) {
    const previous = context.oldByInventory.get(row.organizationInventoryId) || 0
    const next = context.nextByInventory.get(row.organizationInventoryId) || 0
    if (previous === next) continue
    await tx.update(productQuantityBudgets).set({
      heldQuantity: roundQuantity(row.heldQuantity - previous + next),
      updatedByUserId: context.userId,
      updatedAt: new Date(),
    }).where(eq(productQuantityBudgets.id, row.id))
  }
}

async function updateOrderStock(tx: any, context: any) {
  const nextByProduct = new Map<number, number>()
  for (const item of context.calculatedItems) {
    nextByProduct.set(item.globalProductId, roundQuantity((nextByProduct.get(item.globalProductId) || 0) + item.quantity))
  }
  for (const productId of context.productIds) {
    const product: any = context.productById.get(productId)
    if (!product) throw new Error("A previously ordered product could not be reconciled")
    const previousQuantity = context.oldByProduct.get(productId) || 0
    const nextQuantity = nextByProduct.get(productId) || 0
    const nextStock = roundQuantity(Number(product.stockQuantity) + previousQuantity - nextQuantity)
    if (nextStock < 0) throw new Error("STOCK_LEDGER_INVARIANT")
    if (previousQuantity === nextQuantity) continue
    await tx.update(globalProducts).set({ stockQuantity: nextStock, updatedAt: new Date() })
      .where(eq(globalProducts.id, productId))
  }
}

async function regenerateEditedOrderReceipt(tx: any, context: any) {
  const receiptData = await generateReceiptData({
    orderId: context.orderId,
    orderTid: context.existingOrder.tid,
    status: "PENDING",
    organizationId: context.organizationId,
    branchId: context.branchId,
    orderItemsData: context.calculatedItems,
    subtotalCents: context.subtotalCents,
    taxCents: context.taxCents,
    totalCents: context.totalCents,
    discountCents: 0,
    deliveryChargesCents: 0,
    // Resolved and verified above — the order's own address when the edit did
    // not mention it, the newly chosen one when it did, null when the edit
    // sent it back to the branch's own address.
    deliveryAddress: context.deliveryAddress ?? null,
  })
  const previousReceipt = context.existingOrder.receiptData as any
  receiptData.invoiceNumber = previousReceipt?.invoiceNumber || context.existingOrder.tid
  receiptData.date = previousReceipt?.date || receiptData.date
  // The invoice identity survives an edit, and so does the buyer's purchase
  // order reference: the edited value when one was sent, the recorded one
  // otherwise.
  const poNumber = context.poNumber !== undefined
    ? context.poNumber
    : (context.existingOrder.poNumber || previousReceipt?.poNumber)
  if (poNumber) receiptData.poNumber = poNumber
  await tx.update(orders).set({ receiptData: receiptData as any }).where(eq(orders.id, context.orderId))
}

async function persistEditedOrder(tx: any, context: any) {
  const { lockedBudget, existingOrder, totalCents } = context
  const [updatedOrder] = await tx.update(orders).set({
    subtotalCents: context.subtotalCents,
    taxCents: context.taxCents,
    totalCents: context.totalCents,
    ...(context.notes !== undefined ? { notes: context.notes || null } : {}),
    ...(context.poNumber !== undefined ? { poNumber: context.poNumber || null } : {}),
    // Written only when the client said something about the address, so an
    // ordinary edit of an order placed before this column existed still
    // produces the UPDATE it always did.
    ...(context.deliveryAddressId !== undefined
      ? { deliveryAddressId: context.deliveryAddress?.id ?? null }
      : {}),
    updatedAt: new Date(),
    // The creator is deliberately not a predicate here: the branch owns the
    // order. Id, tenant, branch and PENDING still make this the optimistic
    // guard that turns a concurrent approval into ORDER_EDIT_CONFLICT.
  }).where(and(
    eq(orders.id, context.orderId),
    eq(orders.organizationId, context.organizationId),
    eq(orders.branchId, context.branchId),
    sql`UPPER(${orders.status}) = 'PENDING'`,
  )).returning(orderSelectColumns)
  if (!updatedOrder) throw new Error("ORDER_EDIT_CONFLICT")
  // Null for an order that took no hold: there is nothing to move.
  if (lockedBudget) {
    await tx.update(budgets).set({
      amountHeldCents: lockedBudget.amountHeldCents - existingOrder.totalCents + totalCents,
      updatedAt: new Date(),
    }).where(eq(budgets.id, lockedBudget.id))
  }
  await updateOrderQuantityBudgets(tx, context)
  await updateOrderStock(tx, context)
  await tx.delete(orderItems).where(eq(orderItems.orderId, context.orderId))
  await tx.insert(orderItems).values(context.calculatedItems.map((item: any) => ({
    ...item,
    orderId: context.orderId,
    organizationId: context.organizationId,
  })))
  await regenerateEditedOrderReceipt(tx, context)
  await tx.insert(auditLogs).values({
    userId: context.userId,
    organizationId: context.organizationId,
    branchId: context.branchId,
    action: "ORDER_EDITED",
    entity: "order",
    entityId: String(context.orderId),
    metadata: {
      tid: context.existingOrder.tid,
      actorRole: context.actor.role,
      previousTotalCents: context.existingOrder.totalCents,
      totalCents: context.totalCents,
      previousItemCount: context.existingItems.length,
      itemCount: context.calculatedItems.length,
      // Branch ownership replaced creator equality as the access rule, so the
      // trail is what now carries accountability: both parties are named
      // whenever the editor is not the person who raised the order.
      onBehalfOfUserId: context.write?.onBehalfOfUserId ?? null,
      crossRequesterWrite: Boolean(context.write?.isCrossRequesterWrite),
    },
  })
  await notifyRaiserOfOrderWrite(tx, {
    write: context.write,
    organizationId: context.organizationId,
    branchId: context.branchId,
    orderId: context.orderId,
    tid: context.existingOrder.tid,
    message: `Order ${context.existingOrder.tid} was edited by a colleague at your branch.`,
    type: "ORDER_EDITED_BY_COLLEAGUE",
  })
  return { kind: "updated", order: updatedOrder } as const
}

/**
 * Where this edited order is to be delivered, and whether that changed.
 *
 * Three cases, matching the three states `orderUpdateSchema` can send:
 *   * `undefined` — the client said nothing about the address, so the order
 *     keeps the one it has. It is re-read (not assumed) because the receipt is
 *     regenerated from scratch on every edit, and dropping it here would
 *     silently send the invoice back to the branch's own address.
 *   * `null` — an explicit instruction to deliver to the branch's own address
 *     again.
 *   * an id — verified exactly as creation verifies it, against the tenant,
 *     **the branch that owns this order** (not the actor's), and `approved`.
 *
 * Runs after `lockOrderEditAccess`, because until that lock the order's branch
 * is not yet authoritative and an address must never be checked against the
 * wrong one.
 */
async function resolveEditDeliveryAddress(tx: any, context: any) {
  const requested = context.deliveryAddressId === undefined
    ? context.existingOrder?.deliveryAddressId ?? null
    : context.deliveryAddressId

  if (!requested) return null

  const address = await loadApprovedDeliveryAddress(tx, {
    organizationId: context.organizationId,
    branchId: context.branchId,
    addressId: Number(requested),
  })
  if (!address) throw new Error(DELIVERY_ADDRESS_UNAVAILABLE)
  return address
}

async function processOrderEditTransaction(tx: any, baseContext: any) {
  const access = await lockOrderEditAccess(tx, baseContext)
  if ("kind" in access) return access
  // Everything below keys on the branch that owns the order, not on the actor:
  // a group requester has no branch of its own, and a branch colleague editing
  // a group order must still move that branch's budget and stock.
  const context = { ...baseContext, branchId: access.existingOrder.branchId }
  const deliveryAddress = await resolveEditDeliveryAddress(tx, {
    ...context,
    existingOrder: access.existingOrder,
  })
  const inventory = await loadOrderEditInventory(tx, context)
  const orgTaxRateBp = await getOrganizationTaxRateBp(context.organizationId)
  const calculated = calculateEditedItems(context.normalizedItems, inventory, orgTaxRateBp)
  // An order placed while its tenant had budgets off took no hold, so an edit
  // neither checks nor moves one — whatever the tenant's setting is now. Stock
  // is still re-validated above.
  const tracked = orderTakesBudget(access.existingOrder)
  const budget = tracked
    ? await lockAndValidateOrderBudget(tx, { ...context, ...access, ...calculated })
    : null
  const quantityBudgets = budget
    ? await lockOrderQuantityBudgets(tx, {
      ...context,
      orderPeriod: budget.orderPeriod,
      calculatedItems: calculated.items,
      oldByInventory: inventory.oldQuantities.byInventory,
    })
    : { rows: [], nextByInventory: new Map() }
  return persistEditedOrder(tx, {
    ...context,
    ...access,
    ...calculated,
    calculatedItems: calculated.items,
    existingItems: inventory.existingItems,
    productIds: inventory.allGlobalProductIds,
    productById: inventory.productById,
    oldByProduct: inventory.oldQuantities.byProduct,
    oldByInventory: inventory.oldQuantities.byInventory,
    lockedBudget: budget?.lockedBudget ?? null,
    rows: quantityBudgets.rows,
    nextByInventory: quantityBudgets.nextByInventory,
    deliveryAddress,
  })
}

export async function GET(
  _: Request,
  props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "GROUP_ORDER_PORTAL", "ORDER_PORTAL"])
  if (authError) return authError

  const { id } = await props.params
  const orderId = Number(id)
  if (!Number.isInteger(orderId) || orderId <= 0) return error("Invalid order ID", 400)

  const session = await getServerSession(authOptions)
  const currentUserId = (session?.user as any)?.id
  const currentRole = (session?.user as any)?.role
  const [item] = await db
    .select({
      ...orderSelectColumns,
      // Selected so the ownership rule below and the requester's history agree
      // on which orders came from a Group Order Portal submission.
      groupOrderId: orders.groupOrderId,
      branchName: branches.name,
      branchOrganizationId: branches.organizationId,
      creatorName: sql<string | null>`COALESCE(
        NULLIF(TRIM(${users.fullName}), ''),
        NULLIF(TRIM(CONCAT_WS(' ', ${users.firstName}, ${users.lastName})), ''),
        ${users.email}
      )`,
      creatorEmail: users.email,
      creatorPhone: users.phone,
      creatorEmployeeId: users.employeeId,
    })
    .from(orders)
    .leftJoin(users, eq(orders.createdByUserId, users.id))
    .leftJoin(branches, eq(orders.branchId, branches.id))
    // A requester reads its own orders and the group orders raised for its
    // branch; the branch and tenant checks below still apply to both.
    .where(currentRole === "ORDER_PORTAL"
      ? and(
        eq(orders.id, orderId),
        or(eq(orders.createdByUserId, currentUserId), isNotNull(orders.groupOrderId)),
      )
      : eq(orders.id, orderId))
  if (!item) return error("Not found", 404)
  if (!item.organizationId || item.branchOrganizationId !== item.organizationId) {
    return currentRole === "ORDER_PORTAL"
      ? error("Not found", 404)
      : error("Forbidden: Invalid order tenant scope", 403)
  }

  const requestScope = await getRequestScope()
  const hasAccess = await hasBranchAccessForOrderRead(currentRole, currentUserId, requestScope, {
    organizationId: item.organizationId,
    branchId: item.branchId,
  })
  if (!hasAccess) {
    return currentRole === "ORDER_PORTAL"
      ? error("Not found", 404)
      : error("Forbidden: You do not have access to this order", 403)
  }

  if (
    currentRole === "ORDER_PORTAL"
    && !canOrderPortalReadOrder({ viewerUserId: currentUserId, order: item })
  ) {
    return error("Not found", 404)
  }
  const capabilities = await getOrderDecisionCapabilities(requestScope)
  const pricesHidden = await shouldHidePricesForRole(currentRole, item.organizationId)
  const {
    approvalToken,
    approvalTokenHash: _approvalTokenHash,
    approvalTokenCreatedAt: _approvalTokenCreatedAt,
    branchOrganizationId: _branchOrganizationId,
    groupOrderId: _groupOrderId,
    ...detailItem
  } = item
  // Same derived, read-only flag the list returns; the envelope id stays here.
  // The creator's contact row is then withheld from a requester reading an
  // order it did not raise, so reaching many branches does not turn this into a
  // staff directory. Every other role's response is unchanged.
  const safeItem = applyOrderCreatorContactVisibility(
    { ...detailItem, placedByGroupPortal: isGroupPortalOrder(item) },
    {
      role: currentRole,
      viewerUserId: currentUserId,
      orderCreatedByUserId: item.createdByUserId,
    },
  )
  const canSeeToken = canViewFulfillmentToken({
    role: currentRole,
    userId: currentUserId,
    orderStatus: item.status,
    orderCreatedByUserId: item.createdByUserId,
    orderApprovedByUserId: item.approvedByUserId,
    configuredApproverRole: capabilities.orderApproverRole,
  })

  const itemsData = await db
    .select({
      id: orderItems.id,
      productName: orderItems.productName,
      productCode: orderItems.productCode,
      quantity: orderItems.quantity,
      priceCents: orderItems.priceCents,
      unit: orderItems.unit,
      globalProductId: orderItems.globalProductId,
      organizationInventoryId: orderItems.organizationInventoryId,
      imageUrl: globalProducts.imageUrl,
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      quantityStep: globalProducts.quantityStep,
      quantityRefunded: sql<number>`COALESCE((
        SELECT COALESCE(SUM(${refundItems.quantity}), 0)::numeric
        FROM ${refundItems}
        JOIN ${refunds} ON ${refundItems.refundId} = ${refunds.id}
        WHERE ${refundItems.orderItemId} = ${orderItems.id}
        AND UPPER(${refunds.status}) = 'APPROVED'
      ), 0)`.mapWith(Number),
    })
    .from(orderItems)
    .leftJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
    .where(eq(orderItems.orderId, orderId))

  return ok({
    item: {
      ...(pricesHidden
        ? {
          ...safeItem,
          subtotalCents: null,
          taxCents: null,
          totalCents: null,
          refundAmountCents: null,
        }
        : safeItem),
      orderItems: pricesHidden
        ? itemsData.map((orderItem) => ({ ...orderItem, priceCents: null }))
        : itemsData,
      approvalToken: canSeeToken ? approvalToken : null,
      pricesHidden,
    },
    capabilities,
  })
}

export async function PUT(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(["ORDER_PORTAL", "GROUP_ORDER_PORTAL"])
  if (authError) return authError

  const [{ id }, user, scope] = await Promise.all([
    props.params,
    getCurrentUser(),
    getRequestScope(),
  ])
  const orderId = Number(id)

  if (!Number.isInteger(orderId) || orderId <= 0) return error("Invalid order ID", 400)
  if (!isValidOrderWriteActor(user, scope)) {
    return error("Unauthorized", 401)
  }

  // Resolved from the session, never from the request. A fast fail only — the
  // set the decision is made on is re-resolved inside the transaction.
  const allowedBranchIds = await resolveWritableBranchIds(user.role, user.id, scope)
  if (allowedBranchIds.length === 0) return error("Forbidden", 403)

  const rateLimit = await withRateLimit("order", user.id)
  if (rateLimit) return rateLimit

  const parsedBody = orderUpdateSchema.safeParse(await req.json().catch(() => null))
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)

  const normalizedItems = parsedBody.data.items.map((item) => ({
    organizationInventoryId: item.organizationInventoryId,
    quantity: roundQuantity(Number(item.quantity)),
  }))
  if (normalizedItems.some((item) => !Number.isFinite(item.quantity) || item.quantity <= 0)) {
    return error("Quantities must be greater than zero", 400)
  }

  const organizationId = scope!.organizationId!
  const budgetAllocationMode = await getBudgetAllocationModeForOrganization(organizationId)
  const pricesHidden = await shouldHidePricesForRole(user.role, organizationId)

  try {
    const result = await db.transaction((tx) => processOrderEditTransaction(tx, {
      orderId,
      userId: user.id,
      organizationId,
      normalizedItems,
      mode: budgetAllocationMode,
      pricesHidden,
      notes: parsedBody.data.notes,
      poNumber: parsedBody.data.poNumber,
      deliveryAddressId: parsedBody.data.deliveryAddressId,
    }))


    return getOrderEditResultResponse(result, pricesHidden)
  } catch (editError: any) {
    const response = getOrderEditErrorResponse(editError)
    if (response) return response

    console.error("Order PUT error", editError)
    return error("Internal Server Error", 500)
  }
}

export async function DELETE(
  _: Request,
  _props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(["SUPER_ADMIN"])
  if (authError) return authError
  return error("Use the administrative order-deletion workflow", 405)
}
