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
import { isPaidForRefund, isRefundEligibleOrderStatus } from "@/lib/business-rules"

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

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const params = await props.params
    const { id } = params
    const orderId = parseInt(id)
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

    const orderId = parseInt(id, 10)
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

    // Validate order status
    const orderStatus = String(orderData.status || '').toUpperCase()

    if (!isRefundEligibleOrderStatus(orderStatus)) {
      return NextResponse.json({
        error: `Order in ${orderStatus || "unknown"} state is not eligible for a refund`
      }, { status: 400 })
    }

    if (!isPaidForRefund(orderData.paymentStatus)) {
      return NextResponse.json({ error: "Only paid orders are eligible for a refund" }, { status: 400 })
    }

    // Validate refund window (must be same month/year)
    const orderDate = new Date(orderData.createdAt)
    const now = new Date()
    if (orderDate.getMonth() !== now.getMonth() || orderDate.getFullYear() !== now.getFullYear()) {
      return NextResponse.json({
        error: 'Refund period ended. Refunds are only allowed within the calendar month of the order.'
      }, { status: 400 })
    }

    const userRole = (session.user as any).role
    const userId = (session.user as any).id as string
    const userOrgId = (session.user as any).organizationId
    const userBranchId = (session.user as any).branchId
    const pricesHidden = await shouldHidePricesForRole(userRole, orderData.organizationId)

    if (!canAccessOrderForRefund(userRole, orderData, userOrgId, userBranchId, userId)) {
      return NextResponse.json({ error: "Forbidden: Cannot request a refund for this order" }, { status: 403 })
    }

    // 1. Fetch original order items to validate prices and quantities
    const orderItemsList = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))
    const orderItemsMap = new Map(orderItemsList.map(i => [i.id, i]))
    const productIds = Array.from(new Set(orderItemsList.map((item) => item.globalProductId)))
    const productQuantityRules = productIds.length > 0
      ? await db
        .select({
          id: globalProducts.id,
          allowDecimalQuantity: globalProducts.allowDecimalQuantity,
          quantityStep: globalProducts.quantityStep,
        })
        .from(globalProducts)
        .where(inArray(globalProducts.id, productIds))
      : []
    const productQuantityRulesById = new Map(productQuantityRules.map((product) => [product.id, product]))

    // Check previously refunded quantities
    // We need to fetch all refund_items associated with refunds for this order
    // But since we can query refund_items directly joined with refund...
    const previousRefunds = await db
      .select({
        orderItemId: refundItems.orderItemId,
        quantity: refundItems.quantity,
        amountCents: refundItems.amountCents,
        status: refunds.status
      })
      .from(refundItems)
      .innerJoin(refunds, eq(refundItems.refundId, refunds.id))
      .where(eq(refunds.orderId, orderId))

    // Aggregate previously refunded quantities per item
    const approvedRefundedMap = new Map<number, number>()
    const pendingRefundedMap = new Map<number, number>()

    for (const p of previousRefunds) {
      if (p.status === 'APPROVED' || p.status === 'COMPLETED') {
        approvedRefundedMap.set(p.orderItemId, (approvedRefundedMap.get(p.orderItemId) || 0) + p.quantity)
      } else if (p.status === 'PENDING') {
        pendingRefundedMap.set(p.orderItemId, (pendingRefundedMap.get(p.orderItemId) || 0) + p.quantity)
      }
    }

    // 2. Calculate refund amount from server-side data
    let totalRefundAmount = 0
    const refundDetails: { orderItemId: number, name: string, quantity: number, amount: number }[] = []

    for (const item of items) {
      const originalItem = orderItemsMap.get(item.id)
      if (!originalItem) {
        return NextResponse.json({ error: `Item ${item.id} does not belong to this order` }, { status: 400 })
      }

      const quantityRule = productQuantityRulesById.get(originalItem.globalProductId)
      const quantityValidation = validateProductQuantity(item.quantity, {
        allowDecimalQuantity: quantityRule?.allowDecimalQuantity,
        quantityStep: quantityRule?.quantityStep,
        label: `Refund quantity for ${originalItem.productName}`,
      })
      if (!quantityValidation.ok) {
        return NextResponse.json({ error: quantityValidation.error }, { status: 400 })
      }

      const approvedRefunded = approvedRefundedMap.get(item.id) || 0
      const pendingRefunded = pendingRefundedMap.get(item.id) || 0
      const remainingQty = originalItem.quantity - (approvedRefunded + pendingRefunded)

      if (quantityValidation.quantity > remainingQty) {
        return NextResponse.json({
          error: `Cannot refund ${formatQuantity(quantityValidation.quantity)} of ${originalItem.productName}. Only ${formatQuantity(remainingQty)} remaining (Ordered: ${formatQuantity(originalItem.quantity)}, Approved: ${formatQuantity(approvedRefunded)}, Pending: ${formatQuantity(pendingRefunded)})`
        }, { status: 400 })
      }

      const itemTotal = calculateLineCents(originalItem.priceCents, quantityValidation.quantity)
      totalRefundAmount += itemTotal

      refundDetails.push({
        orderItemId: item.id,
        name: originalItem.productName,
        quantity: quantityValidation.quantity,
        amount: itemTotal
      })
    }

    if (!Number.isSafeInteger(totalRefundAmount) || totalRefundAmount <= 0) {
      return NextResponse.json({ error: "Selected items do not have a positive refundable amount" }, { status: 400 })
    }

    // Check for existing refunds to prevent over-refunding (amount check as safety net)
    const existingRefunds = await db
      .select({ amountCents: refunds.amountCents, status: refunds.status })
      .from(refunds)
      .where(eq(refunds.orderId, orderId))

    const approvedRefundRecordTotal = existingRefunds
      .filter(r => r.status === 'APPROVED' || r.status === 'COMPLETED')
      .reduce((sum, r) => sum + (r.amountCents || 0), 0)

    const pendingTotal = existingRefunds
      .filter(r => r.status === 'PENDING')
      .reduce((sum, r) => sum + (r.amountCents || 0), 0)

    // Some legacy orders only have the order-level refund amount. Use the larger
    // approved value so neither visible nor hidden flows can over-refund them.
    const approvedTotal = Math.max(approvedRefundRecordTotal, Number(orderData.refundAmountCents || 0))
    const trackedApprovedOrPendingTotal = previousRefunds
      .filter(r => r.status === 'APPROVED' || r.status === 'COMPLETED' || r.status === 'PENDING')
      .reduce((sum, r) => sum + Number(r.amountCents || 0), 0)
    const hasUnitemizedRefundAmount = approvedTotal + pendingTotal > trackedApprovedOrPendingTotal

    if (pricesHidden && hasUnitemizedRefundAmount) {
      return NextResponse.json({
        error: "This order has a legacy refund that requires administrator review before another refund can be requested."
      }, { status: 409 })
    }

    const remainingRefundableAmount = orderData.totalCents - (approvedTotal + pendingTotal)

    if (totalRefundAmount > remainingRefundableAmount) {
      if (pricesHidden) {
        return NextResponse.json({
          error: "The selected quantities exceed this order's remaining refundable capacity."
        }, { status: 400 })
      }
      return NextResponse.json({
        error: `Refund amount (${(totalRefundAmount / 100).toFixed(2)} PKR) exceeds remaining refundable capacity (Total: ${(orderData.totalCents / 100).toFixed(2)}, Approved: ${(approvedTotal / 100).toFixed(2)}, Pending: ${(pendingTotal / 100).toFixed(2)}).`
      }, { status: 400 })
    }

    const shouldNotifySuperAdmins = userRole !== "SUPER_ADMIN"
    const refundRequestContext = shouldNotifySuperAdmins
      ? await db
        .select({
          organizationName: organizations.name,
          branchName: branches.name,
        })
        .from(orders)
        .leftJoin(organizations, eq(orders.organizationId, organizations.id))
        .leftJoin(branches, eq(orders.branchId, branches.id))
        .where(eq(orders.id, orderId))
        .limit(1)
        .then((rows) => rows[0])
      : null

    const superAdminRecipients = shouldNotifySuperAdmins
      ? await db
        .select({
          id: users.id,
          email: users.email,
          fullName: users.fullName,
        })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(and(
          eq(roles.name, "SUPER_ADMIN"),
          eq(users.isActive, true),
          isNull(users.deletedAt),
        ))
      : []

    const requesterName = String(
      (session.user as any).fullName ||
      session.user.email ||
      "A user",
    )
    const refundRequestMessage = `Refund request for Transaction ID ${orderData.tid}: PKR ${(totalRefundAmount / 100).toFixed(2)} from ${refundRequestContext?.branchName || "Unknown branch"}`

    // Execute refund in transaction
    await db.transaction(async (tx) => {
      const [lockedOrder] = await tx
        .select(orderSelectColumns)
        .from(orders)
        .where(eq(orders.id, orderId))
        .for('update')

      if (!lockedOrder || !isRefundEligibleOrderStatus(lockedOrder.status) || !isPaidForRefund(lockedOrder.paymentStatus)) {
        throw new Error("REFUND_ELIGIBILITY_CONFLICT")
      }

      const liveRefundLines = await tx
        .select({
          orderItemId: refundItems.orderItemId,
          quantity: refundItems.quantity,
          status: refunds.status,
        })
        .from(refundItems)
        .innerJoin(refunds, eq(refundItems.refundId, refunds.id))
        .where(and(
          eq(refunds.orderId, orderId),
          inArray(refunds.status, ["PENDING", "APPROVED", "COMPLETED"]),
        ))

      const liveRefundedQuantityByItem = new Map<number, number>()
      for (const line of liveRefundLines) {
        liveRefundedQuantityByItem.set(
          line.orderItemId,
          (liveRefundedQuantityByItem.get(line.orderItemId) || 0) + Number(line.quantity || 0),
        )
      }

      for (const detail of refundDetails) {
        const originalItem = orderItemsMap.get(detail.orderItemId)
        const remainingQuantity = Number(originalItem?.quantity || 0) - (liveRefundedQuantityByItem.get(detail.orderItemId) || 0)
        if (!originalItem || detail.quantity > remainingQuantity) {
          throw new Error("REFUND_AVAILABILITY_CONFLICT")
        }
      }

      const liveRefundRecords = await tx
        .select({ amountCents: refunds.amountCents, status: refunds.status })
        .from(refunds)
        .where(eq(refunds.orderId, orderId))
      const liveApprovedRecordTotal = liveRefundRecords
        .filter((record) => record.status === "APPROVED" || record.status === "COMPLETED")
        .reduce((sum, record) => sum + Number(record.amountCents || 0), 0)
      const livePendingTotal = liveRefundRecords
        .filter((record) => record.status === "PENDING")
        .reduce((sum, record) => sum + Number(record.amountCents || 0), 0)
      const liveApprovedTotal = Math.max(liveApprovedRecordTotal, Number(lockedOrder.refundAmountCents || 0))

      if (totalRefundAmount > Number(lockedOrder.totalCents) - liveApprovedTotal - livePendingTotal) {
        throw new Error("REFUND_AVAILABILITY_CONFLICT")
      }

      let refundId: number;

      // Check if this is a full refund
      const newApprovedTotal = liveApprovedTotal + (userRole === "SUPER_ADMIN" ? totalRefundAmount : 0)
      const liveOrderStatus = String(lockedOrder.status || "").toUpperCase()
      const isFullRefund = newApprovedTotal >= Number(lockedOrder.totalCents)
      const refundType = isFullRefund ? "FULL" : "PARTIAL"

      if (userRole === "SUPER_ADMIN") {
        // Super Admin: approve/process refund and adjust budgets
        const [insertedRefund] = await tx.insert(refunds).values({
          organizationId: orderData.organizationId,
          orderId,
          amountCents: totalRefundAmount,
          reason: reason?.trim() || null,
          status: "APPROVED",
          processedByUserId: userId,
        }).returning({ id: refunds.id })

        refundId = insertedRefund.id;
        await tx.update(refunds)
          .set({ refundNumber: `Refund-${String(insertedRefund.id).padStart(6, '0')}` })
          .where(eq(refunds.id, insertedRefund.id))

        // Adjust budget - credit back the refunded amount
        const currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM format
        const [budget] = await tx
          .select()
          .from(budgets)
          .where(
            and(
              eq(budgets.branchId, orderData.branchId),
              eq(budgets.period, currentMonth)
            )
          )
          .limit(1)

        if (budget) {
          // Determine which bucket the order money was in:
          // FULFILLED → amountSpentCents; APPROVED/PENDING → amountHeldCents
          // We NEVER touch amountCreditedCents (addon) on a refund — that field
          // is exclusively for manual Head-Office add-on credits.
          const isFulfilled = liveOrderStatus === "FULFILLED"
          await tx
            .update(budgets)
            .set(
              isFulfilled
                ? {
                    // Money was already moved to spent; give it back
                    amountSpentCents: sql`GREATEST(0, ${budgets.amountSpentCents} - ${totalRefundAmount})`,
                    updatedAt: new Date(),
                  }
                : {
                    // Money was still on hold; release the held amount
                    amountHeldCents: sql`GREATEST(0, ${budgets.amountHeldCents} - ${totalRefundAmount})`,
                    updatedAt: new Date(),
                  }
            )
            .where(eq(budgets.id, budget.id))
        }

        await releaseRefundedQuantityBudget(
          tx,
          lockedOrder,
          refundDetails.map((item) => ({
            orderItemId: item.orderItemId,
            quantity: item.quantity,
          })),
        )

        // Update order refund amount and preserve original status
        await tx
          .update(orders)
          .set({
            refundAmountCents: sql`COALESCE(${orders.refundAmountCents}, 0) + ${totalRefundAmount}`,
            statusAtRefund: liveOrderStatus, // Preserve original order status
            refundedAt: new Date(),
            refundedByUserId: userId,
            // Change status to REFUNDED only if this is a full refund
            status: isFullRefund ? "REFUNDED" : liveOrderStatus,
            updatedAt: new Date()
          })
          .where(eq(orders.id, orderId))

        // statusAtRefund preserves what the status was before any refund
        // status will be REFUNDED for full refunds, or remain APPROVED/FULFILLED for partial

        await tx.insert(auditLogs).values({
          userId,
          action: "REFUND_APPROVED",
          entity: "Order",
          entityId: String(orderId),
          organizationId: orderData.organizationId,
          branchId: orderData.branchId,
          metadata: {
            tid: orderData.tid,
            amountCents: totalRefundAmount,
            reason: reason?.trim() || 'Itemized refund',
            items: refundDetails
          },
        })

        // Supersede any existing PENDING refund requests so they no longer
        // block future refund submissions (mirrors what admin/refunds POST does).
        await tx.update(refunds)
          .set({ status: "SUPERSEDED", processedByUserId: userId, updatedAt: new Date() })
          .where(and(eq(refunds.orderId, orderId), eq(refunds.status, "PENDING")))
      } else {
        // Branch Admin / Head Office: create refund REQUEST
        const [insertedRefund] = await tx.insert(refunds).values({
          organizationId: orderData.organizationId,
          orderId,
          amountCents: totalRefundAmount,
          reason: reason?.trim() || null,
          status: "PENDING",
          requestedByUserId: userId,
        }).returning({ id: refunds.id })

        refundId = insertedRefund.id;
        await tx.update(refunds)
          .set({ refundNumber: `Refund-${String(insertedRefund.id).padStart(6, '0')}` })
          .where(eq(refunds.id, insertedRefund.id))

        await tx.insert(auditLogs).values({
          userId,
          action: "REFUND_REQUESTED",
          entity: "Order",
          entityId: String(orderId),
          organizationId: orderData.organizationId,
          branchId: orderData.branchId,
          metadata: {
            tid: orderData.tid,
            amountCents: totalRefundAmount,
            reason: reason?.trim() || 'Itemized refund',
            items: refundDetails
          },
        })

        if (superAdminRecipients.length > 0) {
          await tx.insert(notifications).values(
            superAdminRecipients.map((recipient) => ({
              userId: recipient.id,
              organizationId: orderData.organizationId,
              branchId: orderData.branchId,
              type: "REFUND_REQUESTED",
              targetRole: "SUPER_ADMIN",
              message: refundRequestMessage,
            }))
          )
        }
      }

      // Insert refund items
      if (refundId && refundDetails.length > 0) {
        await tx.insert(refundItems).values(
          refundDetails.map(item => ({
            refundId,
            orderItemId: item.orderItemId,
            quantity: item.quantity,
            amountCents: item.amount
          }))
        )
      }
    })

    if (shouldNotifySuperAdmins) {
      const recipientEmails = [ADMIN_OPERATIONS_EMAIL].filter((email): email is string => Boolean(email))

      if (recipientEmails.length > 0) {
        const sent = await sendRefundRequestEmail({
          to: recipientEmails,
          tid: orderData.tid,
          organizationName: refundRequestContext?.organizationName || "Unknown organization",
          branchName: refundRequestContext?.branchName || "Unknown branch",
          requestedBy: requesterName,
          amountCents: totalRefundAmount,
          reason: reason?.trim() || null,
          items: refundDetails.map((item) => ({
            productName: item.name,
            quantity: item.quantity,
            amountCents: item.amount,
          })),
        })

        console.info("[Refunds] Refund request email recipients", {
          orderId,
          tid: orderData.tid,
          recipientCount: recipientEmails.length,
          recipients: recipientEmails.map(maskEmailAddress),
          sent,
        })

        if (!sent) {
          console.error("[Refunds] Refund request email failed after request creation", {
            orderId,
            tid: orderData.tid,
            recipients: recipientEmails.length,
          })
        }
      }
    }

    return NextResponse.json(buildRefundSuccessPayload({
      pricesHidden,
      isSuperAdmin: userRole === "SUPER_ADMIN",
      totalRefundAmount,
      remainingRefundableAmount,
    }))
  } catch (e: any) {
    console.error('[Refunds] Error processing refund:', e)
    if (["REFUND_AVAILABILITY_CONFLICT", "REFUND_ELIGIBILITY_CONFLICT", "QUANTITY_BUDGET_LEDGER_INVARIANT"].includes(e?.message)) {
      return NextResponse.json({
        error: "Refund eligibility changed while the request was being processed. Refresh and try again."
      }, { status: 409 })
    }
    if (e.code === '23503') {
      return NextResponse.json({ error: 'Referenced order or user not found' }, { status: 404 })
    }
    return NextResponse.json({
      error: 'Internal server error while processing refund'
    }, { status: 500 })
  }
}


