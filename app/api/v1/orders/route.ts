import { NextRequest,NextResponse } from "next/server"
import { createHash,randomBytes } from "node:crypto"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { budgets,orders,orderItems,organizationInventory,branchInventory,branches,globalProducts,productQuantityBudgets,refunds,systemLogs,groupAuditLogs,organizations,refundItems } from "@/db/schema"
import { headers } from "next/headers"
import { and,desc,eq,gte,ilike,lte,or,sql,inArray,isNull } from "drizzle-orm"
import { logOrderActivity } from "@/lib/global-logger"
import { generateReceiptData } from "@/lib/receipt-generator"
import { generateNextInvoiceNumber,hasInvoiceSequenceTable } from "@/lib/invoice-number"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam,parseStartDateParam } from "@/lib/date-range-params"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"
import { orderSelectColumns } from "@/lib/order-select"
import { calculateLineCents,formatQuantity,roundQuantity,validateProductQuantity } from "@/lib/quantity"
import { orderCreateSchema,validationMessage } from "@/lib/server/mutation-validation"
import { withRateLimit } from "@/lib/rate-limiter"
import { attemptImmediateOrderEmailDelivery,queueOrderCreatedNotifications as enqueueCreatedOrderEvents } from "@/lib/server/order-notifications"
import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"
import { getOrderDecisionCapabilities } from "@/lib/server/order-decision-policy"
import { resolveScopedBranchIds,usesMultiBranchScope } from "@/lib/server/multi-branch-scope"
import { isValidRole } from "@/lib/rbac"
import { metricExpressions } from "@/lib/metric-utils"
import { getOrderStatusesForFilter,getOrderStatusFilter } from "@/lib/order-status"



function generateTid(): string {
  // Simple ULID-like: timestamp base36 + cryptographically secure random hex
  const ts = Date.now().toString(36)
  const rand = randomBytes(8).toString("hex")
  return (ts + rand).slice(0, 26)
}

function parseNumberList(value: string | undefined, minimum = -Infinity, maximum = Infinity) {
  return value
    ? value.split(",").map(Number).filter((number) => !Number.isNaN(number) && number >= minimum && number <= maximum)
    : []
}

function getOrderListParams(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get("id") || undefined
  const page = Math.min(Math.max(Math.trunc(Number(searchParams.get("page"))) || 1, 1), 10_000)
  const requestedLimit = Math.trunc(Number(searchParams.get("limit"))) || 200
  const limit = id ? 1 : Math.min(Math.max(requestedLimit, 1), 500)
  return {
    searchParams,
    rawStatus: searchParams.get("status") || undefined,
    branchId: searchParams.get("branchId") || undefined,
    branchIds: parseNumberList(searchParams.get("branchIds") || undefined),
    query: searchParams.get("q") || undefined,
    from: searchParams.get("from") || undefined,
    to: searchParams.get("to") || undefined,
    startDate: searchParams.get("startDate") || undefined,
    endDate: searchParams.get("endDate") || undefined,
    organizationId: searchParams.get("organizationId") || undefined,
    id,
    groupId: searchParams.get("groupId") || undefined,
    groupIds: parseNumberList(searchParams.get("groupIds") || undefined),
    months: parseNumberList(searchParams.get("months") || undefined, 1, 12),
    years: parseNumberList(searchParams.get("years") || undefined, 2000, 2100),
    page,
    limit,
    offset: id ? 0 : (page - 1) * limit,
  }
}

function addOrderSearchCondition(conditions: any[], query: string | undefined) {
  if (!query) return null
  const normalized = query.trim()
  if (normalized.length > 100) return "Search query must be at most 100 characters"
  if (!normalized) return null
  const escaped = normalized.replace(/[\\%_]/g, String.raw`\$&`)
  const searchConditions: any[] = [
    ilike(orders.tid, `%${escaped}%`),
    ilike(branches.costCenterId, `%${escaped}%`),
    sql`EXISTS (
      SELECT 1 FROM ${orderItems}
      WHERE ${orderItems.orderId} = ${orders.id}
      AND ${orderItems.productName} ILIKE ${("%" + String(escaped) + "%")}
    )`,
  ]
  const numericOrderId = Number(normalized)
  if (/^\d+$/.test(normalized) && Number.isSafeInteger(numericOrderId)) searchConditions.push(eq(orders.id, numericOrderId))
  conditions.push(or(...searchConditions))
  return null
}

// Matches no rows. Used wherever a role reaches the end of the scoping ladder
// without an explicit scope, so the absence of a filter can never mean "all".
const DENY_ALL_ORDERS = sql`false`

function addSuperAdminOrderScope(conditions: any[], organizationIdParam: unknown) {
  if (typeof organizationIdParam === "string" && /^\d+$/.test(organizationIdParam)) {
    conditions.push(eq(orders.organizationId, Number(organizationIdParam)))
  }
}

/**
 * Roles whose reach is a set of branches rather than one. The scope is resolved
 * from their assignments before the query runs; an empty set means no access,
 * never organization-wide access.
 */
function addMultiBranchOrderScope(conditions: any[], scopedBranchIds: unknown) {
  const branchIds: number[] = Array.isArray(scopedBranchIds) ? scopedBranchIds : []
  conditions.push(branchIds.length === 0 ? DENY_ALL_ORDERS : inArray(orders.branchId, branchIds))
}

function addOrderRoleConditions(conditions: any[], context: any) {
  const { role, organizationId: orgIdNum, branchId: branchIdFromUser, userId: currentUserId } = context
  if (role === "SUPER_ADMIN") {
    addSuperAdminOrderScope(conditions, context.organizationIdParam)
    return
  }

  conditions.push(typeof orgIdNum === "number"
    ? eq(orders.organizationId, orgIdNum)
    : DENY_ALL_ORDERS)
  if (role === "HEAD_OFFICE") return

  if (usesMultiBranchScope(role)) {
    addMultiBranchOrderScope(conditions, context.scopedBranchIds)
    return
  }

  if (role === "ORDER_PORTAL" && currentUserId) conditions.push(eq(orders.createdByUserId, currentUserId))
  // Fail closed: any remaining role must be pinned to its own branch. Without
  // this a branch-less role would otherwise fall through to the whole tenant.
  conditions.push(typeof branchIdFromUser === "number"
    ? eq(orders.branchId, branchIdFromUser)
    : DENY_ALL_ORDERS)
}

function addOrderDimensionConditions(conditions: any[], params: ReturnType<typeof getOrderListParams>) {
  if (params.id && /^\d+$/.test(params.id)) conditions.push(eq(orders.id, Number(params.id)))
  if (params.branchIds.length > 0) conditions.push(inArray(orders.branchId, params.branchIds))
  else if (params.branchId && /^\d+$/.test(params.branchId)) conditions.push(eq(orders.branchId, Number(params.branchId)))
  if (params.groupIds.length > 0) conditions.push(inArray(branches.groupId, params.groupIds))
  else if (params.groupId && /^\d+$/.test(params.groupId)) conditions.push(eq(branches.groupId, Number(params.groupId)))
}

function addOrderDateConditions(conditions: any[], params: ReturnType<typeof getOrderListParams>) {
  const start = params.startDate ? parseStartDateParam(params.startDate) : null
  const end = params.endDate ? parseEndDateParam(params.endDate) : null
  if (start) conditions.push(gte(orders.createdAt, start))
  if (end) conditions.push(lte(orders.createdAt, end))
  if (params.months.length > 0) conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(params.months, sql.raw(", "))})`)
  if (params.years.length > 0) conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(params.years, sql.raw(", "))})`)
  const legacyStart = params.from && !params.startDate ? parseStartDateParam(params.from) : null
  const legacyEnd = params.to && !params.endDate ? parseEndDateParam(params.to) : null
  if (legacyStart) conditions.push(gte(orders.createdAt, legacyStart))
  if (legacyEnd) conditions.push(lte(orders.createdAt, legacyEnd))
}

function auditOrderGroupAccess(params: ReturnType<typeof getOrderListParams>, context: any) {
  if (!params.groupId || !/^\d+$/.test(params.groupId)) return
  void db.insert(groupAuditLogs).values({
    organizationId: context.organizationId || 0,
    groupId: Number(params.groupId),
    action: "VIEW_GROUP_REPORT",
    performedByUserId: context.userId,
    performedByRole: context.role,
    metadata: { filters: Object.fromEntries(params.searchParams.entries()) },
  }).catch((error) => console.error("Audit log failed", error))
}

function sanitizeOrderListItems(items: any[], context: any) {
  return items.map((item) => {
    const canSeeToken = canViewFulfillmentToken({
      role: context.role,
      userId: context.userId,
      orderStatus: item.status,
      orderCreatedByUserId: item.createdByUserId,
      orderApprovedByUserId: item.approvedByUserId,
      configuredApproverRole: context.capabilities.orderApproverRole,
    })
    const { createdByUserId: _createdByUserId, ...publicItem } = item
    const safeItem = context.pricesHidden ? {
      ...publicItem,
      subtotalCents: null,
      taxCents: null,
      totalCents: null,
      refundAmountCents: null,
    } : publicItem
    return { ...safeItem, approvalToken: canSeeToken ? item.approvalToken : null }
  })
}

async function getSingleOrderListResponse(id: string | undefined, filtered: any[], context: any) {
  if (!id || !/^\d+$/.test(id) || !filtered[0]) return null
  const orderId = Number(id)
  const itemsData = await db.select({
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
      FROM ${refundItems} JOIN ${refunds} ON ${refundItems.refundId} = ${refunds.id}
      WHERE ${refundItems.orderItemId} = ${orderItems.id}
      AND UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED')
    ), 0)`.mapWith(Number),
  }).from(orderItems).leftJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
    .where(eq(orderItems.orderId, orderId))
  const approvedRefunds = await db.select({ amount: refunds.amountCents }).from(refunds)
    .where(and(eq(refunds.orderId, orderId), sql`UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED')`))
  const refundTotal = approvedRefunds.reduce((sum, refund) => sum + (refund.amount || 0), 0)
  return NextResponse.json({
    items: [{
      ...filtered[0],
      orderItems: context.pricesHidden ? itemsData.map((item) => ({ ...item, priceCents: null })) : itemsData,
      refundAmountCents: context.pricesHidden ? null : refundTotal,
      pricesHidden: context.pricesHidden,
    }],
    pricesHidden: context.pricesHidden,
    capabilities: context.capabilities,
  })
}

function getOrderListSummaryTotal(statusFilter: string, summaryRow: any) {
  return Number(statusFilter === "all" ? summaryRow?.all || 0 : summaryRow?.[statusFilter] || 0)
}

function parseScopedNumericId(value: unknown) {
  if (!value) return undefined
  if (typeof value !== "string" && typeof value !== "number") return undefined
  return /^\d+$/.test(String(value)) ? Number(value) : undefined
}

function getBudgetError(total: number, available: number, pricesHidden: boolean) {
  if (available < 0) return "Budget is in negative state. Please contact head office."
  if (total <= available) return null
  return pricesHidden
    ? "Insufficient budget. Please contact head office."
    : `Insufficient budget. Required: ${(total / 100).toFixed(2)} PKR, Available: ${(available / 100).toFixed(2)} PKR`
}

async function lockCreationMoneyBudget(tx: any, context: any) {
  const [budget] = await tx.select().from(budgets).where(eq(budgets.id, context.budgetId)).for('update')
  if (!budget) throw new Error(`Budget not configured for current month (${context.period})`)
  const lockedMoneyRemaining = budget.amountAllocatedCents + budget.amountCreditedCents - budget.amountSpentCents - budget.amountHeldCents
  const budgetError = getBudgetError(context.total, lockedMoneyRemaining, context.pricesHidden)
  if (budgetError) throw new Error(budgetError)
  return { budget, available: lockedMoneyRemaining }
}

async function lockCreationQuantityBudgets(tx: any, context: any) {
  if (context.mode !== "quantity") return new Map()
  const rows = await tx.select().from(productQuantityBudgets).where(and(
    eq(productQuantityBudgets.organizationId, context.organizationId),
    eq(productQuantityBudgets.branchId, context.branchId),
    eq(productQuantityBudgets.period, context.period),
    sql`(${productQuantityBudgets.allocatedQuantity} + ${productQuantityBudgets.creditedQuantity}) > 0`,
    inArray(productQuantityBudgets.organizationInventoryId, context.items.map((item: any) => item.organizationInventoryId)),
  )).for('update')
  const byInventory = new Map(rows.map((row: any) => [row.organizationInventoryId, row]))
  for (const item of context.items) {
    const quantityBudget: any = byInventory.get(item.organizationInventoryId)
    if (!quantityBudget) throw new Error(`Quantity budget is not allocated for ${item.productName}. Please select an allocated product.`)
    const remaining = quantityBudget.allocatedQuantity + quantityBudget.creditedQuantity
      - quantityBudget.usedQuantity - quantityBudget.heldQuantity
    if (remaining < 0) throw new Error(`Quantity budget for ${item.productName} is in negative state. Please contact head office.`)
    if (item.quantity > remaining) {
      throw new Error(`Insufficient quantity budget for ${item.productName}. Available: ${formatQuantity(remaining)}, Requested: ${formatQuantity(item.quantity)}`)
    }
  }
  return byInventory
}

async function lockCreationInventory(tx: any, context: any) {
  const assignments = await tx.select({ organizationInventoryId: branchInventory.organizationInventoryId })
    .from(branchInventory).where(and(
      eq(branchInventory.branchId, context.branchId),
      eq(branchInventory.organizationId, context.organizationId),
      eq(branchInventory.isActive, true),
      eq(branchInventory.isVisible, true),
      isNull(branchInventory.deletedAt),
      inArray(branchInventory.organizationInventoryId, context.inventoryIds),
    )).for('update')
  if (assignments.length !== context.inventoryIds.length) throw new Error("Some items are no longer available for this branch")
  const inventory = await tx.select().from(organizationInventory).where(and(
    eq(organizationInventory.organizationId, context.organizationId),
    eq(organizationInventory.isActive, true),
    isNull(organizationInventory.deletedAt),
    inArray(organizationInventory.id, context.inventoryIds),
  )).for('update')
  if (inventory.length !== context.inventoryIds.length) throw new Error("Some items are no longer active for this organization")
  const productIds = context.items.map((item: any) => item.globalProductId)
  const lockedGps = await tx.select().from(globalProducts).where(and(
    inArray(globalProducts.id, productIds),
    eq(globalProducts.status, "active"),
    isNull(globalProducts.deletedAt),
  )).for('update')
  return {
    inventoryById: new Map<number, any>(inventory.map((item: any) => [item.id, item])),
    productById: new Map<number, any>(lockedGps.map((product: any) => [product.id, product])),
  }
}

function calculateLockedOrderItems(normalizedItems: any[], locked: any) {
  let subtotal = 0
  const items = normalizedItems.map((requestedItem) => {
    const inventoryItem: any = locked.inventoryById.get(requestedItem.organizationInventoryId)
    if (!inventoryItem) throw new Error("An inventory item is no longer available")
    const product: any = locked.productById.get(inventoryItem.globalProductId)
    if (!product) throw new Error("A product is no longer available")
    const validation = validateProductQuantity(requestedItem.quantity, {
      allowDecimalQuantity: product.allowDecimalQuantity,
      quantityStep: product.quantityStep,
      label: `Quantity for ${product.name}`,
    })
    if (!validation.ok) throw new Error(validation.error)
    const priceCents = inventoryItem.customPrice ?? product.basePrice
    if (!Number.isSafeInteger(priceCents) || priceCents < 0) throw new Error(`Pricing is unavailable for ${product.name}`)
    subtotal += calculateLineCents(priceCents, validation.quantity)
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
  if (!Number.isSafeInteger(subtotal) || subtotal < 0) throw new Error("Calculated order total is invalid")
  return { items, subtotal, tax: 0, total: subtotal }
}

function validateCreationStock(items: any[], productById: Map<number, any>) {
  for (const item of items) {
    const product = productById.get(item.globalProductId)
    if (!product) throw new Error(`Product not found: ${item.productName}`)
    if (product.stockQuantity < item.quantity) {
      throw new Error(`Insufficient stock for ${product.name}. Available: ${formatQuantity(product.stockQuantity)}, Requested: ${formatQuantity(item.quantity)}`)
    }
  }
}

async function saveOrderReceipt(tx: any, context: any) {
  let receiptData: Awaited<ReturnType<typeof generateReceiptData>> | null = null
  try {
    receiptData = await generateReceiptData({
      orderId: context.order.id,
      orderTid: context.tid,
      status: "PENDING",
      organizationId: context.organizationId,
      branchId: context.branchId,
      orderItemsData: context.items,
      subtotalCents: context.subtotal,
      taxCents: context.tax,
      totalCents: context.total,
      discountCents: 0,
      deliveryChargesCents: 0,
    })
  } catch (receiptError) {
    console.error("Receipt generation failed during order creation", receiptError)
  }
  if (!receiptData) return
  if (context.invoiceSequenceReady) receiptData.invoiceNumber = await generateNextInvoiceNumber(tx, context.organizationId)
  else {
    console.error("Invoice sequence table is missing; falling back to order TID for invoice number. Run the invoice sequence migration.")
    receiptData.invoiceNumber = context.tid
  }
  await tx.update(orders).set({ receiptData: receiptData as any }).where(eq(orders.id, context.order.id))
}

async function saveCreationLedgers(tx: any, context: any) {
  for (const item of context.items) {
    await tx.update(globalProducts).set({
      stockQuantity: sql`${globalProducts.stockQuantity} - ${item.quantity}`,
      updatedAt: new Date(),
    }).where(eq(globalProducts.id, item.globalProductId))
  }
  await tx.update(budgets).set({ amountHeldCents: sql`${budgets.amountHeldCents} + ${context.total}` })
    .where(eq(budgets.id, context.budgetId))
  for (const item of context.items) {
    const row: any = context.quantityBudgets.get(item.organizationInventoryId)
    if (!row) continue
    await tx.update(productQuantityBudgets).set({
      heldQuantity: sql`${productQuantityBudgets.heldQuantity} + ${item.quantity}`,
      updatedAt: new Date(),
    }).where(eq(productQuantityBudgets.id, row.id))
  }
}

async function logCreatedOrder(tx: any, context: any) {
  try {
    logOrderActivity("CREATE", { ...context.order, orderItems: context.items }, {
      id: context.userId,
      email: context.userEmail || "unknown",
      role: context.role,
    })
  } catch (logError) {
    console.error("File logging failed during order creation", logError)
  }
  const headersList = await headers()
  const forwardedFor = headersList.get("x-forwarded-for")
  await tx.insert(systemLogs).values({
    userId: context.userId,
    userRole: context.role,
    organizationId: context.organizationId,
    branchId: context.branchId,
    action: "ORDER_CREATE",
    resourceType: "order",
    resourceId: String(context.order.id),
    details: { tid: context.tid, total: context.total, items: context.itemCount },
    ipAddress: forwardedFor ? forwardedFor.split(",")[0] : "unknown",
    userAgent: headersList.get("user-agent"),
    success: true,
  })
}

async function persistCreatedOrder(tx: any, context: any) {
  const [order] = await tx.insert(orders).values({
    tid: context.tid,
    idempotencyKey: context.idempotencyKey,
    requestFingerprint: context.requestFingerprint,
    organizationId: context.organizationId,
    branchId: context.branchId,
    status: "PENDING",
    subtotalCents: context.subtotal,
    taxCents: context.tax,
    totalCents: context.total,
    notes: context.notes || null,
    createdByUserId: context.userId,
  }).returning(orderSelectColumns)
  await tx.insert(orderItems).values(context.items.map((item: any) => ({
    ...item,
    orderId: order.id,
    organizationId: context.organizationId,
  })))
  await saveCreationLedgers(tx, { ...context, order })
  await saveOrderReceipt(tx, { ...context, order })
  await logCreatedOrder(tx, { ...context, order })
  const queuedNotifications = context.role === "ORDER_PORTAL"
    ? await enqueueCreatedOrderEvents(tx, { order, requestedBy: context.requestedBy })
    : { eventKeys: [], recipientCount: 0 }
  return { order, queuedNotifications }
}

async function processOrderCreationTransaction(tx: any, context: any) {
  const money = await lockCreationMoneyBudget(tx, context)
  const quantityBudgets = await lockCreationQuantityBudgets(tx, context)
  const lockedInventory = await lockCreationInventory(tx, context)
  const calculated = calculateLockedOrderItems(context.normalizedItems, lockedInventory)
  const budgetError = getBudgetError(calculated.total, money.available, context.pricesHidden)
  if (budgetError) throw new Error(budgetError)
  validateCreationStock(calculated.items, lockedInventory.productById)
  return persistCreatedOrder(tx, {
    ...context,
    items: calculated.items,
    subtotal: calculated.subtotal,
    tax: calculated.tax,
    total: calculated.total,
    quantityBudgets,
  })
}

function getOrderReplayResponse(existingOrder: any, requestFingerprint: string, pricesHidden: boolean) {
  if (!existingOrder) return null
  if (existingOrder.requestFingerprint !== requestFingerprint) {
    return NextResponse.json({ error: "Idempotency key was already used for a different order" }, { status: 409 })
  }
  const { requestFingerprint: _requestFingerprint, ...replayedOrder } = existingOrder
  return NextResponse.json({
    message: "Order already created",
    order: pricesHidden
      ? { ...replayedOrder, subtotalCents: null, taxCents: null, totalCents: null }
      : replayedOrder,
    replayed: true,
  })
}

function resolveOrderTenant(role: string, sessionOrganizationId: unknown, requestedOrganizationId: number | undefined) {
  const organizationId = typeof sessionOrganizationId === "string" || typeof sessionOrganizationId === "number"
    ? Number.parseInt(String(sessionOrganizationId))
    : Number.NaN
  if (role === "SUPER_ADMIN" && requestedOrganizationId && Number.isFinite(requestedOrganizationId)) {
    return { organizationId: requestedOrganizationId }
  }
  if (role === "HEAD_OFFICE" && requestedOrganizationId !== undefined && requestedOrganizationId !== organizationId) {
    return { error: "Tenant reassignment is not permitted" }
  }
  return Number.isFinite(organizationId) ? { organizationId } : { error: "Organization ID not found" }
}

function getCreationBranchId(role: string, requestedBranchId: number | undefined, sessionBranchId: unknown) {
  return Number.parseInt(String(["HEAD_OFFICE", "SUPER_ADMIN"].includes(role) ? requestedBranchId : sessionBranchId))
}

async function validateCreationBranch(organizationId: number, branchId: number) {
  const [branch] = await db.select({ id: branches.id }).from(branches).where(and(
    eq(branches.id, branchId),
    eq(branches.organizationId, organizationId),
  )).limit(1)
  return Boolean(branch)
}

function getCreatedOrderResponse(order: any, pricesHidden: boolean) {
  return NextResponse.json({
    message: "Order created",
    order: pricesHidden ? { ...order, subtotalCents: null, taxCents: null, totalCents: null } : order,
  })
}

function getTenantErrorStatus(message: string) {
  return message.startsWith("Tenant") ? 403 : 400
}

function warnAboutMissingOrderApprover(role: string, result: any) {
  if (role !== "ORDER_PORTAL" || result.queuedNotifications.recipientCount > 0) return
  console.warn("[OrderNotifications] No active configured order approver recipient was available", {
    orderId: result.order.id,
    organizationId: result.order.organizationId,
    branchId: result.order.branchId,
  })
}

async function loadCreationInventory(context: any) {
  const inventoryRows = await db.select({
    id: organizationInventory.id,
    globalProductId: organizationInventory.globalProductId,
    customPrice: organizationInventory.customPrice,
  }).from(branchInventory).innerJoin(
    organizationInventory,
    eq(branchInventory.organizationInventoryId, organizationInventory.id),
  ).where(and(
    eq(branchInventory.branchId, context.branchId),
    eq(branchInventory.organizationId, context.organizationId),
    eq(branchInventory.isActive, true),
    eq(branchInventory.isVisible, true),
    isNull(branchInventory.deletedAt),
    eq(organizationInventory.organizationId, context.organizationId),
    eq(organizationInventory.isActive, true),
    isNull(organizationInventory.deletedAt),
    inArray(organizationInventory.id, context.inventoryIds),
  ))
  if (inventoryRows.length !== context.inventoryIds.length) return null
  const productRows = await db.select().from(globalProducts).where(and(
    inArray(globalProducts.id, inventoryRows.map((row) => row.globalProductId)),
    eq(globalProducts.status, "active"),
    isNull(globalProducts.deletedAt),
  ))
  return {
    inventoryById: new Map(inventoryRows.map((row) => [row.id, row])),
    productById: new Map(productRows.map((row) => [row.id, row])),
  }
}

function calculateCreationItems(normalizedItems: any[], inventory: any) {
  let subtotal = 0
  const items = normalizedItems.map((requestedItem) => {
    const inventoryItem = inventory.inventoryById.get(requestedItem.organizationInventoryId)
    if (!inventoryItem) throw new Error(`Inventory item ${requestedItem.organizationInventoryId} not found`)
    const product = inventory.productById.get(inventoryItem.globalProductId)
    if (!product) throw new Error(`Global product for inventory ${inventoryItem.globalProductId} not found`)
    const validation = validateProductQuantity(requestedItem.quantity, {
      allowDecimalQuantity: product.allowDecimalQuantity,
      quantityStep: product.quantityStep,
      label: `Quantity for ${product.name}`,
    })
    if (!validation.ok) throw new Error(validation.error)
    const priceCents = inventoryItem.customPrice ?? product.basePrice
    if (priceCents === null || priceCents === undefined) throw new Error(`Price not found for item ${requestedItem.organizationInventoryId}. Custom: ${inventoryItem.customPrice}, Base: ${product.basePrice}`)
    subtotal += calculateLineCents(priceCents, validation.quantity)
    return {
      organizationInventoryId: requestedItem.organizationInventoryId,
      globalProductId: inventoryItem.globalProductId,
      quantity: validation.quantity,
      priceCents,
      productName: product.name,
      productCode: product.productCode,
      unit: product.unit,
    }
  })
  return { items, subtotal, total: subtotal }
}

async function getOrCreateCurrentBudget(branchId: number, period: string) {
  const [existing] = await db.select().from(budgets).where(and(
    eq(budgets.branchId, branchId),
    eq(budgets.period, period),
  )).limit(1)
  if (existing) return existing
  const [branch] = await db.select({
    baselineBudgetCents: branches.baselineBudgetCents,
    organizationId: branches.organizationId,
  }).from(branches).where(eq(branches.id, branchId)).limit(1)
  if (!branch?.baselineBudgetCents || branch.baselineBudgetCents <= 0) return null
  const [inserted] = await db.insert(budgets).values({
    organizationId: branch.organizationId,
    branchId,
    period,
    amountAllocatedCents: branch.baselineBudgetCents,
    amountSpentCents: 0,
    amountHeldCents: 0,
    amountCreditedCents: 0,
  }).onConflictDoNothing().returning()
  if (inserted) return inserted
  return (await db.select().from(budgets).where(and(
    eq(budgets.branchId, branchId),
    eq(budgets.period, period),
  )).limit(1))[0]
}

async function getOrderCreationErrorResponse(caughtError: any, replayContext: any) {
  if (caughtError?.code === "23505" && replayContext) {
    const [existingOrder] = await db.select({ ...orderSelectColumns, requestFingerprint: orders.requestFingerprint })
      .from(orders).where(and(
        eq(orders.createdByUserId, replayContext.userId),
        eq(orders.idempotencyKey, replayContext.idempotencyKey),
      )).limit(1)
    const replayResponse = getOrderReplayResponse(existingOrder, replayContext.requestFingerprint, replayContext.pricesHidden)
    if (replayResponse) return replayResponse
  }
  const message = String(caughtError.message || "")
  const normalized = message.toLowerCase()
  const isCustomerError = message.startsWith("Insufficient stock")
    || message.startsWith("Budget not configured")
    || message.includes("Insufficient budget")
    || normalized.includes("quantity budget")
    || normalized.includes("negative state")
    || normalized.includes("no longer")
    || normalized.includes("pricing is unavailable")
  return isCustomerError
    ? NextResponse.json({ error: message }, { status: 400 })
    : NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
}


export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if ((session.user as any).mustChangePassword === true) {
      return NextResponse.json({ error: "Forbidden", message: "Password change required" }, { status: 403 })
    }

    const role = (session.user as any).role
    const organizationIdRaw = (session.user as any).organizationId
    const branchIdFromUserRaw = (session.user as any).branchId

    const orgIdNum = parseScopedNumericId(organizationIdRaw)
    const branchIdFromUser = parseScopedNumericId(branchIdFromUserRaw)
    const currentUserId = (session.user as any).id
    const decisionCapabilities = await getOrderDecisionCapabilities(
      isValidRole(role) && typeof currentUserId === "string"
        ? {
          role,
          userId: currentUserId,
          organizationId: orgIdNum ?? null,
          branchId: branchIdFromUser ?? null,
        }
        : null,
    )

    const params = getOrderListParams(req)
    const statusFilter = getOrderStatusFilter(params.rawStatus)
    const conditions: any[] = []
    const searchError = addOrderSearchCondition(conditions, params.query)
    if (searchError) return NextResponse.json({ error: searchError }, { status: 400 })
    const scopedBranchIds = usesMultiBranchScope(role) && typeof currentUserId === "string"
      ? await resolveScopedBranchIds(db, currentUserId)
      : null
    addOrderRoleConditions(conditions, {
      role,
      organizationId: orgIdNum,
      branchId: branchIdFromUser,
      organizationIdParam: params.organizationId,
      userId: currentUserId,
      scopedBranchIds,
    })

    const pricesHidden = await shouldHidePricesForRole(role, orgIdNum)
    addOrderDimensionConditions(conditions, params)
    addOrderDateConditions(conditions, params)

    // Status changes which rows are returned, but not the KPI scope. Keeping a
    // separate snapshot prevents a selected tab from zeroing the other cards.
    const summaryConditions = [...conditions]
    const requestedStatuses = getOrderStatusesForFilter(statusFilter)
    if (requestedStatuses.length > 0) {
      conditions.push(inArray(orders.status, requestedStatuses))
    }

    // --- Audit Logging for Group Access ---
    auditOrderGroupAccess(params, { organizationId: orgIdNum, userId: currentUserId, role })




    // --- Base query (non-sales) ---
    const selectBase = db
      .select({
        id: orders.id,
        tid: orders.tid,
        organizationId: orders.organizationId,
        organizationName: organizations.name,
        branchId: orders.branchId,
        status: orders.status,
        fulfillmentStatus: orderSelectColumns.fulfillmentStatus,
        paymentStatus: orderSelectColumns.paymentStatus,
        paidAt: orderSelectColumns.paidAt,
        statusAtRefund: orders.statusAtRefund,
        refundedAt: orders.refundedAt,
        refundedByUserId: orders.refundedByUserId,
        refundAmountCents: orders.refundAmountCents,
        refundReason: orders.refundReason,
        rejectionReason: orders.rejectionReason,
        subtotalCents: orders.subtotalCents,
        taxCents: orders.taxCents,
        totalCents: orders.totalCents,
        createdAt: orders.createdAt,
        approvedAt: orders.approvedAt,
        deliveredAt: orders.deliveredAt,
        fulfilledAt: orders.fulfilledAt,
        branchName: branches.name,
        branchAddress: branches.address,
        branchCity: branches.city,
        branchProvince: branches.province,
        branchCostCenterId: branches.costCenterId,
        hasRefundRequests: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${refunds}
          WHERE ${refunds.orderId} = ${orders.id}
          AND UPPER(${refunds.status}) = 'PENDING'
        )`,
        itemCount: sql<number>`(
          SELECT COALESCE(SUM(${orderItems.quantity}), 0)::numeric
          FROM ${orderItems}
          WHERE ${orderItems.orderId} = ${orders.id}
        )`,
        itemNames: sql<string>`(
          SELECT STRING_AGG(${orderItems.productName}, ', ')
          FROM ${orderItems}
          WHERE ${orderItems.orderId} = ${orders.id}
        )`,
        createdByUserId: orders.createdByUserId,
        approvedByUserId: orders.approvedByUserId,
        approvalToken: orders.approvalToken, // Will be filtered before return
      })
      .from(orders)
      .leftJoin(branches, eq(orders.branchId, branches.id))
      .leftJoin(organizations, eq(orders.organizationId, organizations.id))

    const { page, limit, offset } = params
    const items = await (conditions.length
      ? selectBase.where(and(...conditions)).orderBy(desc(orders.createdAt)).limit(limit).offset(offset)
      : selectBase.orderBy(desc(orders.createdAt)).limit(limit).offset(offset))

    // The list is intentionally paginated, but the summary cards must describe
    // the complete filtered scope rather than only the current page of rows.
    const summaryCondition = summaryConditions.length ? and(...summaryConditions) : undefined
    const [summaryRow] = params.id
      ? []
      : await db
        .select({
          all: metricExpressions.totalOrderCount,
          pending: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'PENDING' THEN 1 END), 0)`.mapWith(Number),
          approved: metricExpressions.approvedCount,
          fulfilled: metricExpressions.fulfilledCount,
          rejected: metricExpressions.rejectedCount,
          refunded: metricExpressions.refundedCount,
        })
        .from(orders)
        .leftJoin(branches, eq(orders.branchId, branches.id))
        .where(summaryCondition)

    // Sanitize items: Only show approvalToken to authorized roles
    const filtered = sanitizeOrderListItems(items, {
      role,
      userId: currentUserId,
      pricesHidden,
      capabilities: decisionCapabilities,
    })
    const singleOrderResponse = await getSingleOrderListResponse(params.id, filtered, {
      pricesHidden,
      capabilities: decisionCapabilities,
    })
    if (singleOrderResponse) return singleOrderResponse

    const paginationTotal = Number(getOrderListSummaryTotal(statusFilter, summaryRow))

    return NextResponse.json({
      items: filtered,
      summary: {
        all: Number(summaryRow?.all || 0),
        pending: Number(summaryRow?.pending || 0),
        approved: Number(summaryRow?.approved || 0),
        fulfilled: Number(summaryRow?.fulfilled || 0),
        rejected: Number(summaryRow?.rejected || 0),
        refunded: Number(summaryRow?.refunded || 0),
      },
      pricesHidden,
      capabilities: decisionCapabilities,
      pagination: {
        page,
        limit,
        total: paginationTotal,
        totalPages: Math.ceil(paginationTotal / limit),
        hasMore: page * limit < paginationTotal,
      },
    })
  } catch (e: any) {
    console.error("Orders GET error:", e)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let replayContext: {
    userId: string
    idempotencyKey: string
    requestFingerprint: string
    pricesHidden: boolean
  } | null = null

  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if ((session.user as any).mustChangePassword === true) return NextResponse.json({ error: "Forbidden", message: "Password change required" }, { status: 403 })
    const role = (session.user as any).role
    const userId = (session.user as any).id
    const rateLimit = await withRateLimit("order", userId)
    if (rateLimit) return rateLimit
    const idempotencyKey = req.headers.get("idempotency-key")?.trim() || ""
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return NextResponse.json({
        error: "A valid Idempotency-Key header (8-128 letters, numbers, '.', '_', ':', or '-') is required",
      }, { status: 400 })
    }

    const rawBody = await req.json().catch(() => null)
    const parsedBody = orderCreateSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
    }
    const { items, branchId: branchIdInput, organizationId: orgIdInput, notes } = parsedBody.data

    const normalizedItems = items.map((item) => ({
      organizationInventoryId: item.organizationInventoryId,
      quantity: roundQuantity(Number(item.quantity)),
    }))

    // Validate quantities are positive
    if (normalizedItems.some(i => !Number.isFinite(i.quantity) || i.quantity <= 0)) {
      return NextResponse.json({ error: "Quantities must be greater than zero" }, { status: 400 })
    }

    const tenant = resolveOrderTenant(role, (session.user as any).organizationId, orgIdInput)
    if (tenant.error) return NextResponse.json({ error: tenant.error }, { status: getTenantErrorStatus(tenant.error) })
    const organizationId = tenant.organizationId!

    const branchId = getCreationBranchId(role, branchIdInput, (session.user as any).branchId)
    if (!Number.isFinite(branchId)) return NextResponse.json({ error: "Branch context required" }, { status: 400 })
    if (!await validateCreationBranch(organizationId, branchId)) {
      return NextResponse.json({ error: "Branch does not belong to the selected organization" }, { status: 400 })
    }
    const pricesHidden = await shouldHidePricesForRole(role, organizationId)
    const budgetAllocationMode = await getBudgetAllocationModeForOrganization(Number(organizationId))
    const requestFingerprint = orderRequestFingerprint({
      organizationId: Number(organizationId),
      branchId,
      notes,
      items: normalizedItems,
    })
    replayContext = { userId, idempotencyKey, requestFingerprint, pricesHidden }

    const [existingOrder] = await db
      .select({ ...orderSelectColumns, requestFingerprint: orders.requestFingerprint })
      .from(orders)
      .where(and(
        eq(orders.createdByUserId, userId),
        eq(orders.idempotencyKey, idempotencyKey),
      ))
      .limit(1)

    const replayResponse = getOrderReplayResponse(existingOrder, requestFingerprint, pricesHidden)
    if (replayResponse) return replayResponse

    // Fetch inventory details and prices
    const orgInvIds = normalizedItems.map(i => i.organizationInventoryId)
    const creationInventory = await loadCreationInventory({ organizationId, branchId, inventoryIds: orgInvIds })
    if (!creationInventory) return NextResponse.json({ error: "Some items invalid" }, { status: 400 })
    const calculated = calculateCreationItems(normalizedItems, creationInventory)
    const calculatedItems = calculated.items
    const total = calculated.total

    // budget check and hold - must be for current month period
    const currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM format
    const currentBudget = await getOrCreateCurrentBudget(branchId, currentMonth)
    if (!currentBudget) return NextResponse.json({
      error: `Budget not configured for current month (${currentMonth}). Please contact head office to allocate budget.`,
    }, { status: 400 })

    const remaining = (currentBudget.amountAllocatedCents + currentBudget.amountCreditedCents) - (currentBudget.amountSpentCents + currentBudget.amountHeldCents)

    const budgetError = getBudgetError(total, remaining, pricesHidden)
    if (budgetError) return NextResponse.json({ error: budgetError }, { status: 400 })

    const tid = generateTid()
    const invoiceSequenceReady = await hasInvoiceSequenceTable(db)

    const creationResult = await db.transaction((tx) => processOrderCreationTransaction(tx, {
      budgetId: currentBudget.id,
      period: currentMonth,
      total,
      pricesHidden,
      mode: budgetAllocationMode,
      organizationId: Number(organizationId),
      branchId,
      inventoryIds: orgInvIds,
      normalizedItems,
      items: calculatedItems,
      tid,
      idempotencyKey,
      requestFingerprint,
      notes,
      userId,
      role,
      userEmail: session.user?.email,
      requestedBy: String((session.user as any)?.fullName || "Order Portal user").trim().slice(0, 255),
      itemCount: items.length,
      invoiceSequenceReady,
    }))
    // queueOrderCreatedNotifications(tx) runs inside processOrderCreationTransaction.


    const created = creationResult.order
    warnAboutMissingOrderApprover(role, creationResult)
    await attemptImmediateOrderEmailDelivery(creationResult.queuedNotifications.eventKeys)
    return getCreatedOrderResponse(created, pricesHidden)
  } catch (e: any) {
    console.error("Order creation error:", e)
    console.error("Error stack:", e.stack)
    return getOrderCreationErrorResponse(e, replayContext)
  }
}

export async function PUT(_: NextRequest) {
  return NextResponse.json(
    { error: "Use the dedicated approve, reject, or fulfill operation" },
    { status: 405 },
  )
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/

function orderRequestFingerprint(input: {
  organizationId: number
  branchId: number
  notes?: string
  items: Array<{ organizationInventoryId: number; quantity: number }>
}) {
  const canonical = {
    organizationId: input.organizationId,
    branchId: input.branchId,
    notes: input.notes || null,
    items: input.items.slice().sort((a, b) => a.organizationInventoryId - b.organizationInventoryId),
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}
