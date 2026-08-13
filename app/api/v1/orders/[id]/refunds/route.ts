import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { refunds, orders, budgets, auditLogs, users, orderItems, refundItems, globalProducts, roles, notifications, organizations, branches } from "@/db/schema"
import { eq, sql, desc, inArray, and, isNull } from "drizzle-orm"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { releaseRefundedQuantityBudget } from "@/lib/server/product-quantity-budget-ledger"
import { orderSelectColumns } from "@/lib/order-select"
import { calculateLineCents, formatQuantity, validateProductQuantity } from "@/lib/quantity"
import { sendRefundRequestEmail } from "@/lib/email"
import { withRateLimit } from "@/lib/rate-limiter"
import { ADMIN_OPERATIONS_EMAIL } from "@/lib/email/recipients"
import { buildRefundSuccessPayload, redactRefundHistoryForPriceHidden } from "@/lib/refund-visibility"
import { refundRequestSchema, validationMessage } from "@/lib/server/mutation-validation"
import { isOrderPortalRefundEligible, isRefundEligibleOrderStatus } from "@/lib/business-rules"

const refundRequestRoles = new Set(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL"])

const maskEmailAddress = (email: string) => {
  const [localPart, domain] = email.split("@")
  if (!localPart || !domain) return "invalid-email"

  const visibleLocal = localPart.length <= 2
    ? `${localPart[0] || ""}***`
    : `${localPart.slice(0, 2)}***${localPart.slice(-1)}`

  return `${visibleLocal}@${domain}`
}

function canAccessOrderForRefund(
  userRole: string,
  orderData: { organizationId: number | null; branchId: number; createdByUserId: string },
  userOrgId: unknown,
  userBranchId: unknown,
  userId: string,
) {
  if (!refundRequestRoles.has(userRole)) {
    return false
  }

  if (userRole === "SUPER_ADMIN") {
    return true
  }

  if (userRole === "HEAD_OFFICE") {
    return orderData.organizationId === userOrgId
  }

  if (userRole === "BRANCH_ADMIN") {
    return orderData.organizationId === userOrgId && orderData.branchId === userBranchId
  }

  if (userRole === "ORDER_PORTAL") {
    return (
      orderData.organizationId === userOrgId &&
      orderData.branchId === userBranchId &&
      orderData.createdByUserId === userId
    )
  }

  return false
}

function getRefundEligibilityError(orderData: any, role: string) {
  const status = String(orderData.status || "").toUpperCase()
  if (!isRefundEligibleOrderStatus(status)) return `Order in ${status || "unknown"} state is not eligible for a refund`
  const orderDate = new Date(orderData.createdAt)
  const now = new Date()
  if (orderDate.getMonth() !== now.getMonth() || orderDate.getFullYear() !== now.getFullYear()) {
    return "Refund period ended. Refunds are only allowed within the calendar month of the order."
  }
  if (role === "ORDER_PORTAL" && !isOrderPortalRefundEligible(status, orderData.fulfillmentStatus)) {
    return "Order Portal users can request a refund only after the order is fulfilled and delivered."
  }
  return null
}

function indexPreviousRefunds(rows: any[]) {
  const approved = new Map<number, number>()
  const pending = new Map<number, number>()
  rows.forEach((row) => {
    let target: Map<number, number> | null = null
    if (["APPROVED", "COMPLETED"].includes(row.status)) {
      target = approved
    } else if (row.status === "PENDING") {
      target = pending
    }
    if (target) target.set(row.orderItemId, (target.get(row.orderItemId) || 0) + row.quantity)
  })
  return { approved, pending }
}

function calculateRefundDetails(context: any) {
  const details: { orderItemId: number; name: string; quantity: number; amount: number }[] = []
  for (const item of context.items) {
    const original = context.orderItems.get(item.id)
    if (!original) return { error: `Item ${item.id} does not belong to this order` }
    const rule = context.quantityRules.get(original.globalProductId)
    const validation = validateProductQuantity(item.quantity, {
      allowDecimalQuantity: rule?.allowDecimalQuantity,
      quantityStep: rule?.quantityStep,
      label: `Refund quantity for ${original.productName}`,
    })
    if (!validation.ok) return { error: validation.error }
    const approved = context.approved.get(item.id) || 0
    const pending = context.pending.get(item.id) || 0
    const remaining = original.quantity - approved - pending
    if (validation.quantity > remaining) {
      return { error: `Cannot refund ${formatQuantity(validation.quantity)} of ${original.productName}. Only ${formatQuantity(remaining)} remaining (Ordered: ${formatQuantity(original.quantity)}, Approved: ${formatQuantity(approved)}, Pending: ${formatQuantity(pending)})` }
    }
    details.push({
      orderItemId: item.id,
      name: original.productName,
      quantity: validation.quantity,
      amount: calculateLineCents(original.priceCents, validation.quantity),
    })
  }
  const total = details.reduce((sum, detail) => sum + detail.amount, 0)
  return Number.isSafeInteger(total) && total > 0
    ? { details, total }
    : { error: "Selected items do not have a positive refundable amount" }
}

function getRefundCapacity(context: any) {
  const approvedRecords = context.refunds.filter((refund: any) => ["APPROVED", "COMPLETED"].includes(refund.status))
    .reduce((sum: number, refund: any) => sum + (refund.amountCents || 0), 0)
  const pending = context.refunds.filter((refund: any) => refund.status === "PENDING")
    .reduce((sum: number, refund: any) => sum + (refund.amountCents || 0), 0)
  const approved = Math.max(approvedRecords, Number(context.order.refundAmountCents || 0))
  const itemized = context.refundLines.filter((line: any) => ["APPROVED", "COMPLETED", "PENDING"].includes(line.status))
    .reduce((sum: number, line: any) => sum + Number(line.amountCents || 0), 0)
  return { approved, pending, remaining: context.order.totalCents - approved - pending, hasUnitemized: approved + pending > itemized }
}

function getRefundCapacityError(context: any) {
  if (context.pricesHidden && context.capacity.hasUnitemized) {
    return { message: "This order has a legacy refund that requires administrator review before another refund can be requested.", status: 409 }
  }
  if (context.total <= context.capacity.remaining) return null
  if (context.pricesHidden) return { message: "The selected quantities exceed this order's remaining refundable capacity.", status: 400 }
  return {
    message: `Refund amount (${(context.total / 100).toFixed(2)} PKR) exceeds remaining refundable capacity (Total: ${(context.order.totalCents / 100).toFixed(2)}, Approved: ${(context.capacity.approved / 100).toFixed(2)}, Pending: ${(context.capacity.pending / 100).toFixed(2)}).`,
    status: 400,
  }
}

async function loadRefundRequestData(orderId: number, requestedItems: any[]) {
  const orderItemsList = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))
  const productIds = [...new Set(orderItemsList.map((item) => item.globalProductId))]
  const [quantityRules, previousRefunds, existingRefunds] = await Promise.all([
    productIds.length > 0 ? db.select({
      id: globalProducts.id,
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      quantityStep: globalProducts.quantityStep,
    }).from(globalProducts).where(inArray(globalProducts.id, productIds)) : [],
    db.select({
      orderItemId: refundItems.orderItemId,
      quantity: refundItems.quantity,
      amountCents: refundItems.amountCents,
      status: refunds.status,
    }).from(refundItems).innerJoin(refunds, eq(refundItems.refundId, refunds.id)).where(eq(refunds.orderId, orderId)),
    db.select({ amountCents: refunds.amountCents, status: refunds.status }).from(refunds).where(eq(refunds.orderId, orderId)),
  ])
  const previous = indexPreviousRefunds(previousRefunds)
  const calculated = calculateRefundDetails({
    items: requestedItems,
    orderItems: new Map(orderItemsList.map((item) => [item.id, item])),
    quantityRules: new Map(quantityRules.map((rule) => [rule.id, rule])),
    ...previous,
  })
  return { calculated, orderItemsMap: new Map(orderItemsList.map((item) => [item.id, item])), previousRefunds, existingRefunds }
}

function getRefundProcessingErrorResponse(caughtError: any) {
  if (["REFUND_AVAILABILITY_CONFLICT", "REFUND_ELIGIBILITY_CONFLICT", "QUANTITY_BUDGET_LEDGER_INVARIANT"].includes(caughtError?.message)) {
    return NextResponse.json({ error: "Refund eligibility changed while the request was being processed. Refresh and try again." }, { status: 409 })
  }
  if (caughtError.code === "23503") return NextResponse.json({ error: "Referenced order or user not found" }, { status: 404 })
  return NextResponse.json({ error: "Internal server error while processing refund" }, { status: 500 })
}

async function lockAndValidateRefund(tx: any, context: any) {
  const [lockedOrder] = await tx.select(orderSelectColumns).from(orders).where(eq(orders.id, context.orderId)).for('update')
  if (!lockedOrder || !isRefundEligibleOrderStatus(lockedOrder.status)
    || (context.userRole === "ORDER_PORTAL" && !isOrderPortalRefundEligible(lockedOrder.status, lockedOrder.fulfillmentStatus))) {
    throw new Error("REFUND_ELIGIBILITY_CONFLICT")
  }
  const liveLines = await tx.select({
    orderItemId: refundItems.orderItemId,
    quantity: refundItems.quantity,
    status: refunds.status,
  }).from(refundItems).innerJoin(refunds, eq(refundItems.refundId, refunds.id)).where(and(
    eq(refunds.orderId, context.orderId),
    inArray(refunds.status, ["PENDING", "APPROVED", "COMPLETED"]),
  ))
  const quantityByItem = new Map<number, number>()
  liveLines.forEach((line: any) => quantityByItem.set(line.orderItemId, (quantityByItem.get(line.orderItemId) || 0) + Number(line.quantity || 0)))
  context.details.forEach((detail: any) => {
    const original = context.orderItems.get(detail.orderItemId)
    const remaining = Number(original?.quantity || 0) - (quantityByItem.get(detail.orderItemId) || 0)
    if (!original || detail.quantity > remaining) throw new Error("REFUND_AVAILABILITY_CONFLICT")
  })
  const liveRecords = await tx.select({ amountCents: refunds.amountCents, status: refunds.status }).from(refunds).where(eq(refunds.orderId, context.orderId))
  const approvedRecords = liveRecords.filter((record: any) => ["APPROVED", "COMPLETED"].includes(record.status))
    .reduce((sum: number, record: any) => sum + Number(record.amountCents || 0), 0)
  const pending = liveRecords.filter((record: any) => record.status === "PENDING")
    .reduce((sum: number, record: any) => sum + Number(record.amountCents || 0), 0)
  const approved = Math.max(approvedRecords, Number(lockedOrder.refundAmountCents || 0))
  if (context.total > Number(lockedOrder.totalCents) - approved - pending) throw new Error("REFUND_AVAILABILITY_CONFLICT")
  return { lockedOrder, approved }
}

async function createApprovedRefund(tx: any, context: any) {
  const [inserted] = await tx.insert(refunds).values({
    organizationId: context.order.organizationId,
    orderId: context.orderId,
    amountCents: context.total,
    reason: context.reason?.trim() || null,
    status: "APPROVED",
    processedByUserId: context.userId,
  }).returning({ id: refunds.id })
  await tx.update(refunds).set({ refundNumber: `Refund-${String(inserted.id).padStart(6, "0")}` }).where(eq(refunds.id, inserted.id))
  const [budget] = await tx.select().from(budgets).where(and(
    eq(budgets.branchId, context.order.branchId),
    eq(budgets.period, new Date().toISOString().slice(0, 7)),
  )).limit(1)
  const status = String(context.lockedOrder.status || "").toUpperCase()
  if (budget) await tx.update(budgets).set(status === "FULFILLED" ? {
    amountSpentCents: sql`GREATEST(0, ${budgets.amountSpentCents} - ${context.total})`, updatedAt: new Date(),
  } : {
    amountHeldCents: sql`GREATEST(0, ${budgets.amountHeldCents} - ${context.total})`, updatedAt: new Date(),
  }).where(eq(budgets.id, budget.id))
  await releaseRefundedQuantityBudget(tx, context.lockedOrder, context.details.map((item: any) => ({ orderItemId: item.orderItemId, quantity: item.quantity })))
  const isFullRefund = context.approved + context.total >= Number(context.lockedOrder.totalCents)
  await tx.update(orders).set({
    refundAmountCents: sql`COALESCE(${orders.refundAmountCents}, 0) + ${context.total}`,
    statusAtRefund: status,
    refundedAt: new Date(),
    refundedByUserId: context.userId,
    status: isFullRefund ? "REFUNDED" : status,
    updatedAt: new Date(),
  }).where(eq(orders.id, context.orderId))
  await tx.insert(auditLogs).values({
    userId: context.userId,
    action: "REFUND_APPROVED",
    entity: "Order",
    entityId: String(context.orderId),
    organizationId: context.order.organizationId,
    branchId: context.order.branchId,
    metadata: { tid: context.order.tid, amountCents: context.total, reason: context.reason?.trim() || "Itemized refund", items: context.details },
  })
  await tx.update(refunds).set({ status: "SUPERSEDED", processedByUserId: context.userId, updatedAt: new Date() })
    .where(and(eq(refunds.orderId, context.orderId), eq(refunds.status, "PENDING")))
  return inserted.id
}

async function createPendingRefund(tx: any, context: any) {
  const [inserted] = await tx.insert(refunds).values({
    organizationId: context.order.organizationId,
    orderId: context.orderId,
    amountCents: context.total,
    reason: context.reason?.trim() || null,
    status: "PENDING",
    requestedByUserId: context.userId,
  }).returning({ id: refunds.id })
  await tx.update(refunds).set({ refundNumber: `Refund-${String(inserted.id).padStart(6, "0")}` }).where(eq(refunds.id, inserted.id))
  await tx.insert(auditLogs).values({
    userId: context.userId,
    action: "REFUND_REQUESTED",
    entity: "Order",
    entityId: String(context.orderId),
    organizationId: context.order.organizationId,
    branchId: context.order.branchId,
    metadata: { tid: context.order.tid, amountCents: context.total, reason: context.reason?.trim() || "Itemized refund", items: context.details },
  })
  if (context.recipients.length > 0) await tx.insert(notifications).values(context.recipients.map((recipient: any) => ({
    userId: recipient.id,
    organizationId: context.order.organizationId,
    branchId: context.order.branchId,
    type: "REFUND_REQUESTED",
    targetRole: "SUPER_ADMIN",
    message: context.message,
  })))
  return inserted.id
}

async function loadRefundNotificationData(shouldNotify: boolean, orderId: number) {
  if (!shouldNotify) return { requestContext: null, recipients: [] }
  const [requestContext, recipients] = await Promise.all([
    db.select({ organizationName: organizations.name, branchName: branches.name })
      .from(orders)
      .leftJoin(organizations, eq(orders.organizationId, organizations.id))
      .leftJoin(branches, eq(orders.branchId, branches.id))
      .where(eq(orders.id, orderId))
      .limit(1)
      .then((rows) => rows[0]),
    db.select({ id: users.id, email: users.email, fullName: users.fullName })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(and(eq(roles.name, "SUPER_ADMIN"), eq(users.isActive, true), isNull(users.deletedAt))),
  ])
  return { requestContext, recipients }
}

async function sendRefundRequestNotification(context: any) {
  if (!context.shouldNotify) return
  const recipientEmails = [ADMIN_OPERATIONS_EMAIL].filter((email): email is string => Boolean(email))
  if (recipientEmails.length === 0) return
  const sent = await sendRefundRequestEmail({
    to: recipientEmails,
    tid: context.order.tid,
    organizationName: context.requestContext?.organizationName || "Unknown organization",
    branchName: context.requestContext?.branchName || "Unknown branch",
    requestedBy: context.requesterName,
    amountCents: context.total,
    reason: context.reason?.trim() || null,
    items: context.details.map((item: any) => ({
      productName: item.name,
      quantity: item.quantity,
      amountCents: item.amount,
    })),
  })
  console.info("[Refunds] Refund request email recipients", {
    orderId: context.orderId,
    tid: context.order.tid,
    recipientCount: recipientEmails.length,
    recipients: recipientEmails.map(maskEmailAddress),
    sent,
  })
  if (!sent) console.error("[Refunds] Refund request email failed after request creation", {
    orderId: context.orderId,
    tid: context.order.tid,
    recipients: recipientEmails.length,
  })
}

async function processRefundTransaction(tx: any, context: any) {
  const availability = await lockAndValidateRefund(tx, context)
  const refundId = context.userRole === "SUPER_ADMIN"
    ? await createApprovedRefund(tx, { ...context, ...availability })
    : await createPendingRefund(tx, context)
  if (context.details.length > 0) await tx.insert(refundItems).values(context.details.map((item: any) => ({
    refundId, orderItemId: item.orderItemId, quantity: item.quantity, amountCents: item.amount,
  })))
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const params = await props.params
    const { id } = params
    const orderId = Number.parseInt(id)
    if (!Number.isFinite(orderId)) return NextResponse.json({ error: "Invalid order ID" }, { status: 400 })

    // Get order details first to check permissions
    const [order] = await db.select(orderSelectColumns).from(orders).where(eq(orders.id, orderId)).limit(1)
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 })

    const userRole = (session.user as any).role
    const userOrgId = (session.user as any).organizationId
    const userBranchId = (session.user as any).branchId
    const userId = (session.user as any).id as string
    const pricesHidden = await shouldHidePricesForRole(userRole, order.organizationId)

    if (!canAccessOrderForRefund(userRole, order, userOrgId, userBranchId, userId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // Fetch refunds with user details
    const refundsData = await db
      .select({
        id: refunds.id,
        refundNumber: refunds.refundNumber,
        amountCents: refunds.amountCents,
        taxRefundCents: refunds.taxRefundCents,
        reason: refunds.reason,
        createdAt: refunds.createdAt,
        status: refunds.status,
        requestedByUserId: refunds.requestedByUserId,
        processedByUserId: refunds.processedByUserId,
        processedByUser: {
          email: users.email,
          fullName: users.fullName,
        }
      })
      .from(refunds)
      .leftJoin(users, eq(refunds.processedByUserId, users.id))
      .where(eq(refunds.orderId, orderId))
      .orderBy(desc(refunds.createdAt))

    // Fetch refund items if any refunds exist
    let refundsWithItems = refundsData.map(r => ({ ...r, items: [] as any[] }))

    if (refundsData.length > 0) {
      const refundIds = refundsData.map(r => r.id)
      const items = await db
        .select({
          refundId: refundItems.refundId,
          orderItemId: refundItems.orderItemId,
          quantity: refundItems.quantity,
          amountCents: refundItems.amountCents,
          productName: orderItems.productName,
          unit: orderItems.unit
        })
        .from(refundItems)
        .innerJoin(orderItems, eq(refundItems.orderItemId, orderItems.id))
        .where(inArray(refundItems.refundId, refundIds))

      // Attach items to refunds
      const itemsMap = new Map<number, typeof items>()
      items.forEach(item => {
        if (!itemsMap.has(item.refundId)) itemsMap.set(item.refundId, [])
        itemsMap.get(item.refundId)?.push(item)
      })

      refundsWithItems = refundsData.map(r => ({
        ...r,
        items: itemsMap.get(r.id) || []
      }))
    }

    if (pricesHidden) {
      const approvedRecordTotal = refundsWithItems
        .filter((refund) => ["APPROVED", "COMPLETED"].includes(String(refund.status).toUpperCase()))
        .reduce((sum, refund) => sum + Number(refund.amountCents || 0), 0)
      const pendingRecordTotal = refundsWithItems
        .filter((refund) => String(refund.status).toUpperCase() === "PENDING")
        .reduce((sum, refund) => sum + Number(refund.amountCents || 0), 0)
      const trackedItemTotal = refundsWithItems
        .filter((refund) => ["APPROVED", "COMPLETED", "PENDING"].includes(String(refund.status).toUpperCase()))
        .flatMap((refund) => refund.items)
        .reduce((sum, item) => sum + Number(item.amountCents || 0), 0)
      const effectiveRefundTotal = Math.max(approvedRecordTotal, Number(order.refundAmountCents || 0)) + pendingRecordTotal

      return NextResponse.json({
        refunds: redactRefundHistoryForPriceHidden(refundsWithItems),
        pricesHidden: true,
        quantityOnlyRefundAvailable: effectiveRefundTotal <= trackedItemTotal,
      })
    }

    return NextResponse.json({ refunds: refundsWithItems, pricesHidden: false })
  } catch (error: any) {
    console.error("Error fetching refunds:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const rateLimit = await withRateLimit("refund", (session.user as any).id)
    if (rateLimit) return rateLimit

    const { id } = await params

    // Validate order ID
    if (!/^\d+$/.test(id)) {
      return NextResponse.json({ error: "Invalid order ID format" }, { status: 400 })
    }

    const orderId = Number.parseInt(id, 10)
    if (!Number.isFinite(orderId) || orderId <= 0) {
      return NextResponse.json({ error: "Invalid order ID" }, { status: 400 })
    }

    let rawBody
    try {
      rawBody = await req.json()
    } catch (jsonError) {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 })
    }

    const parsedBody = refundRequestSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
    }
    const { items, reason } = parsedBody.data

    // Fetch order with validation
    const [ord] = await db.select(orderSelectColumns).from(orders).where(eq(orders.id, orderId)).limit(1)

    if (!ord) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    const orderData = ord as any

    const userRole = (session.user as any).role
    const userId = (session.user as any).id as string
    const userOrgId = (session.user as any).organizationId
    const userBranchId = (session.user as any).branchId
    const pricesHidden = await shouldHidePricesForRole(userRole, orderData.organizationId)
    const eligibilityError = getRefundEligibilityError(orderData, userRole)
    if (eligibilityError) return NextResponse.json({ error: eligibilityError }, { status: 400 })
    if (!canAccessOrderForRefund(userRole, orderData, userOrgId, userBranchId, userId)) {
      return NextResponse.json({ error: "Forbidden: Cannot request a refund for this order" }, { status: 403 })
    }
    const requestData = await loadRefundRequestData(orderId, items)
    if (requestData.calculated.error) return NextResponse.json({ error: requestData.calculated.error }, { status: 400 })
    const refundDetails = requestData.calculated.details!
    const totalRefundAmount = requestData.calculated.total!
    const orderItemsMap = requestData.orderItemsMap
    const previousRefunds = requestData.previousRefunds
    const capacity = getRefundCapacity({
      refunds: requestData.existingRefunds,
      refundLines: previousRefunds,
      order: orderData,
    })
    const capacityError = getRefundCapacityError({ pricesHidden, capacity, total: totalRefundAmount, order: orderData })
    if (capacityError) return NextResponse.json({ error: capacityError.message }, { status: capacityError.status })
    const remainingRefundableAmount = capacity.remaining
    const shouldNotifySuperAdmins = userRole !== "SUPER_ADMIN"
    const notificationData = await loadRefundNotificationData(shouldNotifySuperAdmins, orderId)

    const requesterName = String(
      (session.user as any).fullName ||
      session.user.email ||
      "A user",
    )
    const refundRequestMessage = `Refund request for Transaction ID ${orderData.tid}: PKR ${(totalRefundAmount / 100).toFixed(2)} from ${notificationData.requestContext?.branchName || "Unknown branch"}`

    await db.transaction((tx) => processRefundTransaction(tx, {
      orderId,
      order: orderData,
      userRole,
      userId,
      total: totalRefundAmount,
      reason,
      details: refundDetails,
      orderItems: orderItemsMap,
      recipients: notificationData.recipients,
      message: refundRequestMessage,
    }))

    await sendRefundRequestNotification({
      shouldNotify: shouldNotifySuperAdmins,
      orderId,
      order: orderData,
      requestContext: notificationData.requestContext,
      requesterName,
      total: totalRefundAmount,
      reason,
      details: refundDetails,
    })

    return NextResponse.json(buildRefundSuccessPayload({
      pricesHidden,
      isSuperAdmin: userRole === "SUPER_ADMIN",
      totalRefundAmount,
      remainingRefundableAmount,
    }))
  } catch (e: any) {
    console.error('[Refunds] Error processing refund:', e)
    return getRefundProcessingErrorResponse(e)
  }
}


