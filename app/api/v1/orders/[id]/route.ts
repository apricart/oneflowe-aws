import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { getServerSession } from "next-auth"
import {
  auditLogs,
  branches,
  branchInventory,
  budgets,
  globalProducts,
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
import { canOrderPortalEditOrder } from "@/lib/order-edit-policy"
import { orderSelectColumns } from "@/lib/order-select"
import { shouldHidePricesForRole } from "@/lib/price-visibility"

type CurrentOrderUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>

const isValidOrderPortalActor = (
  user: Awaited<ReturnType<typeof getCurrentUser>>,
  scope: Awaited<ReturnType<typeof getRequestScope>>,
): user is CurrentOrderUser => (
  user != null
  && user.id === scope?.userId
  && user.role === "ORDER_PORTAL"
  && scope?.role === "ORDER_PORTAL"
  && Boolean(scope.organizationId)
  && Boolean(scope.branchId)
)

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
import { getCurrentUser, getRequestScope } from "@/lib/auth"
import { calculateLineCents, formatQuantity, roundQuantity, validateProductQuantity } from "@/lib/quantity"
import { withRateLimit } from "@/lib/rate-limiter"
import { generateReceiptData } from "@/lib/receipt-generator"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"
import { orderUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"
import { getOrderDecisionCapabilities } from "@/lib/server/order-decision-policy"

async function lockOrderEditAccess(tx: any, context: any) {
  const { userId, organizationId, branchId, orderId } = context
  const user = { id: userId }
  const [actor] = await tx.select({
    id: users.id,
    role: roles.name,
    organizationId: users.organizationId,
    branchId: users.branchId,
  }).from(users).innerJoin(roles, eq(users.roleId, roles.id)).where(and(
    eq(users.id, user.id),
    eq(users.isActive, true),
    isNull(users.deletedAt),
  )).limit(1)
  if (actor?.role !== "ORDER_PORTAL"
    || actor.organizationId !== organizationId
    || actor.branchId !== branchId) return { kind: "forbidden" } as const

  const [existingOrder] = await tx.select().from(orders).where(and(
    eq(orders.id, orderId),
    eq(orders.createdByUserId, user.id),
    eq(orders.organizationId, organizationId),
    eq(orders.branchId, branchId),
  )).for("update").limit(1)
  if (!existingOrder) return { kind: "not-found" } as const

  const [orderBranch] = await tx.select({ organizationId: branches.organizationId })
    .from(branches).where(eq(branches.id, existingOrder.branchId)).for("share").limit(1)
  const canEdit = canOrderPortalEditOrder({
    actorRole: actor.role,
    actorUserId: actor.id,
    actorOrganizationId: actor.organizationId,
    actorBranchId: actor.branchId,
    orderStatus: existingOrder.status,
    orderCreatedByUserId: existingOrder.createdByUserId,
    orderOrganizationId: existingOrder.organizationId,
    orderBranchId: existingOrder.branchId,
    branchOrganizationId: orderBranch?.organizationId,
  })
  if (!canEdit && String(existingOrder.status).toUpperCase() !== "PENDING") {
    return { kind: "invalid-state", status: existingOrder.status } as const
  }
  if (!canEdit) return { kind: "forbidden" } as const
  return { actor, existingOrder }
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
  return {
    existingItems,
    allGlobalProductIds,
    inventoryById: new Map(inventoryRows.map((item: any) => [item.id, item])),
    productById: new Map(productRows.map((product: any) => [product.id, product])),
    oldQuantities: indexExistingOrderQuantities(existingItems),
  }
}

function calculateEditedItems(normalizedItems: any[], inventoryData: any) {
  let subtotalCents = 0
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
    const priceCents = inventoryItem.customPrice ?? product.basePrice
    if (!Number.isSafeInteger(priceCents) || priceCents < 0) throw new Error(`Pricing is unavailable for ${product.name}`)
    const availableStock = Number(product.stockQuantity) + (inventoryData.oldQuantities.byProduct.get(product.id) || 0)
    if (validation.quantity > availableStock) {
      throw new Error(`Insufficient stock for ${product.name}. Available: ${formatQuantity(availableStock)}, Requested: ${formatQuantity(validation.quantity)}`)
    }
    subtotalCents += calculateLineCents(priceCents, validation.quantity)
    return {
      organizationInventoryId: inventoryItem.id,
      globalProductId: product.id,
      quantity: validation.quantity,
      priceCents,
      productName: product.name,
      productCode: product.productCode,
      unit: product.unit,
    }
  })
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0) throw new Error("Calculated order total is invalid")
  return { items, subtotalCents, taxCents: 0, totalCents: subtotalCents }
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
  try {
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
    })
    const previousReceipt = context.existingOrder.receiptData as any
    receiptData.invoiceNumber = previousReceipt?.invoiceNumber || context.existingOrder.tid
    receiptData.date = previousReceipt?.date || receiptData.date
    await tx.update(orders).set({ receiptData: receiptData as any }).where(eq(orders.id, context.orderId))
  } catch (receiptError) {
    console.error("Receipt regeneration failed during order edit", receiptError)
    await tx.update(orders).set({ receiptData: null }).where(eq(orders.id, context.orderId))
  }
}

async function persistEditedOrder(tx: any, context: any) {
  const { lockedBudget, existingOrder, totalCents } = context
  const [updatedOrder] = await tx.update(orders).set({
    subtotalCents: context.subtotalCents,
    taxCents: context.taxCents,
    totalCents: context.totalCents,
    ...(context.notes !== undefined ? { notes: context.notes || null } : {}),
    updatedAt: new Date(),
  }).where(and(
    eq(orders.id, context.orderId),
    eq(orders.createdByUserId, context.userId),
    eq(orders.organizationId, context.organizationId),
    eq(orders.branchId, context.branchId),
    sql`UPPER(${orders.status}) = 'PENDING'`,
  )).returning(orderSelectColumns)
  if (!updatedOrder) throw new Error("ORDER_EDIT_CONFLICT")
  await tx.update(budgets).set({
    amountHeldCents: lockedBudget.amountHeldCents - existingOrder.totalCents + totalCents,
    updatedAt: new Date(),
  }).where(eq(budgets.id, lockedBudget.id))
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
    },
  })
  return { kind: "updated", order: updatedOrder } as const
}

async function processOrderEditTransaction(tx: any, context: any) {
  const access = await lockOrderEditAccess(tx, context)
  if ("kind" in access) return access
  const inventory = await loadOrderEditInventory(tx, context)
  const calculated = calculateEditedItems(context.normalizedItems, inventory)
  const budget = await lockAndValidateOrderBudget(tx, { ...context, ...access, ...calculated })
  const quantityBudgets = await lockOrderQuantityBudgets(tx, {
    ...context,
    orderPeriod: budget.orderPeriod,
    calculatedItems: calculated.items,
    oldByInventory: inventory.oldQuantities.byInventory,
  })
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
    lockedBudget: budget.lockedBudget,
    rows: quantityBudgets.rows,
    nextByInventory: quantityBudgets.nextByInventory,
  })
}

export async function GET(
  _: Request,
  props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL"])
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
    .where(currentRole === "ORDER_PORTAL"
      ? and(eq(orders.id, orderId), eq(orders.createdByUserId, currentUserId))
      : eq(orders.id, orderId))
  if (!item) return error("Not found", 404)
  if (!item.organizationId || item.branchOrganizationId !== item.organizationId) {
    return currentRole === "ORDER_PORTAL"
      ? error("Not found", 404)
      : error("Forbidden: Invalid order tenant scope", 403)
  }

  const { verifyResourceAccess } = await import("@/lib/auth")
  const hasAccess = await verifyResourceAccess(item.organizationId, item.branchId)
  if (!hasAccess) {
    return currentRole === "ORDER_PORTAL"
      ? error("Not found", 404)
      : error("Forbidden: You do not have access to this order", 403)
  }

  if (currentRole === "ORDER_PORTAL" && item.createdByUserId !== currentUserId) {
    return error("Not found", 404)
  }
  const capabilities = await getOrderDecisionCapabilities(await getRequestScope())
  const pricesHidden = await shouldHidePricesForRole(currentRole, item.organizationId)
  const {
    approvalToken,
    approvalTokenHash: _approvalTokenHash,
    approvalTokenCreatedAt: _approvalTokenCreatedAt,
    branchOrganizationId: _branchOrganizationId,
    ...safeItem
  } = item
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
  const authError = await requireApiRole(["ORDER_PORTAL"])
  if (authError) return authError

  const [{ id }, user, scope] = await Promise.all([
    props.params,
    getCurrentUser(),
    getRequestScope(),
  ])
  const orderId = Number(id)

  if (!Number.isInteger(orderId) || orderId <= 0) return error("Invalid order ID", 400)
  if (!isValidOrderPortalActor(user, scope)) {
    return error("Unauthorized", 401)
  }

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
  const branchId = scope!.branchId!
  const budgetAllocationMode = await getBudgetAllocationModeForOrganization(organizationId)
  const pricesHidden = await shouldHidePricesForRole(user.role, organizationId)

  try {
    const result = await db.transaction((tx) => processOrderEditTransaction(tx, {
      orderId,
      userId: user.id,
      organizationId,
      branchId,
      normalizedItems,
      mode: budgetAllocationMode,
      pricesHidden,
      notes: parsedBody.data.notes,
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
