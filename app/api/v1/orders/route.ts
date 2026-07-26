import { NextRequest, NextResponse } from "next/server"
import { createHash } from "node:crypto"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { budgets, orders, orderItems, organizationInventory, branchInventory, auditLogs, branches, globalProducts, productQuantityBudgets, refunds, systemLogs, groupAuditLogs, organizations, refundItems } from "@/db/schema"
import { headers } from "next/headers"
import { and, desc, eq, gte, ilike, lte, or, sql, inArray, isNull } from "drizzle-orm"
import { logOrderActivity } from "@/lib/global-logger"
import { generateReceiptData } from "@/lib/receipt-generator"
import { generateNextInvoiceNumber, hasInvoiceSequenceTable } from "@/lib/invoice-number"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"
import { orderSelectColumns } from "@/lib/order-select"
import { calculateLineCents, formatQuantity, roundQuantity, validateProductQuantity } from "@/lib/quantity"
import { orderCreateSchema, validationMessage } from "@/lib/server/mutation-validation"
import { withRateLimit } from "@/lib/rate-limiter"
import { attemptImmediateOrderEmailDelivery, queueOrderCreatedNotifications } from "@/lib/server/order-notifications"
import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"



function generateTid(): string {
  // Simple ULID-like: timestamp base36 + random base36
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return (ts + rand).slice(0, 26)
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

    const orgIdNum =
      organizationIdRaw && /^\d+$/.test(String(organizationIdRaw))
        ? Number(organizationIdRaw)
        : undefined
    const branchIdFromUser =
      branchIdFromUserRaw && /^\d+$/.test(String(branchIdFromUserRaw))
        ? Number(branchIdFromUserRaw)
        : undefined

    const { searchParams } = new URL(req.url)
    const rawStatus = searchParams.get("status") || undefined
    const status = rawStatus?.toUpperCase()
    const branchId = searchParams.get("branchId") || undefined
    const branchIdsRaw = searchParams.get("branchIds") || undefined
    const q = searchParams.get("q") || undefined
    const from = searchParams.get("from") || undefined
    const to = searchParams.get("to") || undefined
    const startDate = searchParams.get("startDate") || undefined
    const endDate = searchParams.get("endDate") || undefined
    const organizationIdParam = searchParams.get("organizationId") || undefined
    const idParam = searchParams.get("id") || undefined
    const mode = searchParams.get("mode") || undefined // weeklySales | monthlySales
    const groupId = searchParams.get("groupId") || undefined
    const groupIdsRaw = searchParams.get("groupIds") || undefined
    const monthsRaw = searchParams.get("months") || undefined
    const yearsRaw = searchParams.get("years") || undefined
    const page = Math.min(Math.max(Math.trunc(Number(searchParams.get("page"))) || 1, 1), 10_000)
    const requestedLimit = Math.trunc(Number(searchParams.get("limit"))) || 200
    const limit = idParam ? 1 : Math.min(Math.max(requestedLimit, 1), 500)
    const offset = idParam ? 0 : (page - 1) * limit
    const conditions: any[] = []

    if (q) {
      if (q.length > 100) {
        return NextResponse.json({ error: "Search query must be at most 100 characters" }, { status: 400 })
      }
      const escapedQuery = q.replace(/[\\%_]/g, "\\$&")
      conditions.push(or(
        ilike(orders.tid, `%${escapedQuery}%`),
        ilike(branches.costCenterId, `%${escapedQuery}%`),
      ))
    }

    // Parsing branchIds
    const parsedBranchIds = branchIdsRaw
      ? branchIdsRaw.split(",").map(id => Number(id)).filter(id => !isNaN(id))
      : []

    // Parsing groupIds
    const parsedGroupIds = groupIdsRaw
      ? groupIdsRaw.split(",").map(id => Number(id)).filter(id => !isNaN(id))
      : []

    const parsedMonths = monthsRaw
      ? monthsRaw.split(",").map(id => Number(id)).filter(id => !isNaN(id) && id >= 1 && id <= 12)
      : []

    const parsedYears = yearsRaw
      ? yearsRaw.split(",").map(id => Number(id)).filter(id => !isNaN(id) && id >= 2000 && id <= 2100)
      : []

    // --- Role-based access ---
    if (role === "SUPER_ADMIN") {
      if (organizationIdParam && /^\d+$/.test(organizationIdParam))
        conditions.push(eq(orders.organizationId, Number(organizationIdParam)))
      // Super Admin sees ALL orders for visibility consistency
      // conditions.push(sql`UPPER(${orders.status}) IN ('APPROVED', 'FULFILLED', 'REFUNDED')`)
    } else if (role === "HEAD_OFFICE") {
      if (typeof orgIdNum === "number") conditions.push(eq(orders.organizationId, orgIdNum))
    } else if (role === "ORDER_PORTAL") {
      // CRITICAL: ORDER_PORTAL users should only see THEIR OWN orders
      const currentUserId = (session.user as any).id
      if (currentUserId) {
        conditions.push(eq(orders.createdByUserId, currentUserId))
      }
      // Also restrict to their organization and branch
      if (typeof orgIdNum === "number") conditions.push(eq(orders.organizationId, orgIdNum))
      if (typeof branchIdFromUser === "number") conditions.push(eq(orders.branchId, branchIdFromUser))
    } else {
      // BRANCH_ADMIN and other roles
      if (typeof orgIdNum === "number") conditions.push(eq(orders.organizationId, orgIdNum))
      if (typeof branchIdFromUser === "number") conditions.push(eq(orders.branchId, branchIdFromUser))
    }

    const pricesHidden = await shouldHidePricesForRole(role, orgIdNum)

    if (status) conditions.push(eq(orders.status, status))
    if (idParam && /^\d+$/.test(idParam)) conditions.push(eq(orders.id, Number(idParam)))

    // Branch filtering
    if (parsedBranchIds.length > 0) {
      conditions.push(inArray(orders.branchId, parsedBranchIds))
    } else if (branchId && /^\d+$/.test(branchId)) {
      conditions.push(eq(orders.branchId, Number(branchId)))
    }

    // Group filtering
    if (parsedGroupIds.length > 0) {
      conditions.push(inArray(branches.groupId, parsedGroupIds))
    } else if (groupId && /^\d+$/.test(groupId)) {
      conditions.push(eq(branches.groupId, Number(groupId)))
    }

    // Date range filtering (standardized)
    if (startDate) {
      const start = parseStartDateParam(startDate)
      if (start) conditions.push(gte(orders.createdAt, start))
    }
    if (endDate) {
      const end = parseEndDateParam(endDate)
      if (end) conditions.push(lte(orders.createdAt, end))
    }

    // Arbitrary month/year filtering from GlobalDateFilter.
    if (parsedMonths.length > 0) {
      conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedMonths, sql`, `)})`)
    }

    if (parsedYears.length > 0) {
      conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedYears, sql`, `)})`)
    }

    // Legacy date filters
    if (from && !startDate) {
      const start = parseStartDateParam(from)
      if (start) conditions.push(gte(orders.createdAt, start))
    }
    if (to && !endDate) {
      const end = parseEndDateParam(to)
      if (end) conditions.push(lte(orders.createdAt, end))
    }

    // --- Audit Logging for Group Access ---
    if (groupId && /^\d+$/.test(groupId)) {
      // Log access to group-specific data
      // We do this asynchronously to not block the response
      (async () => {
        try {
          await db.insert(groupAuditLogs).values({
            organizationId: orgIdNum || 0, // Best effort
            groupId: Number(groupId),
            action: "VIEW_GROUP_REPORT",
            performedByUserId: (session.user as any).id,
            performedByRole: role,
            metadata: {
              filters: Object.fromEntries(searchParams.entries())
            },
          })
        } catch (err) {
          console.error("Audit log failed", err)
        }
      })()
    }




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

    const items = await (conditions.length
      ? selectBase.where(and(...conditions)).orderBy(desc(orders.createdAt)).limit(limit).offset(offset)
      : selectBase.orderBy(desc(orders.createdAt)).limit(limit).offset(offset))

    const currentUserId = (session.user as any).id

    // Sanitize items: Only show approvalToken to authorized roles
    const sanitizedItems = items.map(item => {
      const canSeeToken = canViewFulfillmentToken({
        role,
        userId: currentUserId,
        orderStatus: item.status,
        orderCreatedByUserId: item.createdByUserId,
        orderApprovedByUserId: item.approvedByUserId,
      })
      const { createdByUserId: _createdByUserId, ...publicItem } = item

      const safeItem = pricesHidden
        ? {
          ...publicItem,
          subtotalCents: null,
          taxCents: null,
          totalCents: null,
          refundAmountCents: null,
        }
        : publicItem

      return {
        ...safeItem,
        approvalToken: canSeeToken ? item.approvalToken : null
      }
    })

    const filtered = sanitizedItems

    // Single order with items
    if (idParam && /^\d+$/.test(idParam)) {
      const orderId = Number(idParam)
      const order = filtered[0]
      if (order) {
        const itemsData = await db
          .select({
            id: orderItems.id,
            productName: orderItems.productName,
            productCode: orderItems.productCode,
            quantity: orderItems.quantity,
            priceCents: orderItems.priceCents,
            unit: orderItems.unit,
            globalProductId: orderItems.globalProductId,
            imageUrl: globalProducts.imageUrl,
            allowDecimalQuantity: globalProducts.allowDecimalQuantity,
            quantityStep: globalProducts.quantityStep,
            quantityRefunded: sql<number>`COALESCE((
              SELECT COALESCE(SUM(${refundItems.quantity}), 0)::numeric
              FROM ${refundItems}
              JOIN ${refunds} ON ${refundItems.refundId} = ${refunds.id}
              WHERE ${refundItems.orderItemId} = ${orderItems.id}
              AND UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED')
            ), 0)`.mapWith(Number),
          })
          .from(orderItems)
          .leftJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
          .where(eq(orderItems.orderId, orderId))

        // Calculate total refund amount from APPROVED refund records
        const approvedRefunds = await db
          .select({ amount: refunds.amountCents })
          .from(refunds)
          .where(and(eq(refunds.orderId, orderId), sql`UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED')`))

        const totalApprovedAmount = approvedRefunds.reduce((sum, r) => sum + (r.amount || 0), 0)

        return NextResponse.json({
          items: [{
            ...order,
            orderItems: pricesHidden
              ? itemsData.map((item) => ({ ...item, priceCents: null }))
              : itemsData,
            refundAmountCents: pricesHidden ? null : totalApprovedAmount,
            pricesHidden,
          }],
          pricesHidden,
        })
      }
    }

    return NextResponse.json({
      items: filtered,
      pricesHidden,
      pagination: {
        page,
        limit,
        hasMore: filtered.length === limit,
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
    let organizationId = (session.user as any).organizationId
    if (organizationId) organizationId = parseInt(String(organizationId))
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

    // Only Super Admin may select a tenant. Head Office remains session-scoped.
    if (role === "SUPER_ADMIN") {
      if (orgIdInput && Number.isFinite(orgIdInput)) {
        organizationId = orgIdInput
      }
    } else if (role === "HEAD_OFFICE" && orgIdInput !== undefined && orgIdInput !== organizationId) {
      return NextResponse.json({ error: "Tenant reassignment is not permitted" }, { status: 403 })
    }

    if (!Number.isFinite(organizationId)) {
      return NextResponse.json({ error: "Organization ID not found" }, { status: 400 })
    }

    const branchId = role === "HEAD_OFFICE" || role === "SUPER_ADMIN" ? parseInt(String(branchIdInput)) : parseInt(String((session.user as any).branchId))
    if (!Number.isFinite(branchId)) return NextResponse.json({ error: "Branch context required" }, { status: 400 })

    const [selectedBranch] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(
        eq(branches.id, branchId),
        eq(branches.organizationId, Number(organizationId)),
      ))
      .limit(1)
    if (!selectedBranch) {
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

    if (existingOrder) {
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

    // Fetch inventory details and prices
    const orgInvIds = normalizedItems.map(i => i.organizationInventoryId)
    const allInvRows = await db
      .select({
        id: organizationInventory.id,
        globalProductId: organizationInventory.globalProductId,
        customPrice: organizationInventory.customPrice,
      })
      .from(branchInventory)
      .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
      .where(and(
        eq(branchInventory.branchId, branchId),
        eq(branchInventory.organizationId, Number(organizationId)),
        eq(branchInventory.isActive, true),
        eq(branchInventory.isVisible, true),
        isNull(branchInventory.deletedAt),
        eq(organizationInventory.organizationId, organizationId),
        eq(organizationInventory.isActive, true),
        isNull(organizationInventory.deletedAt),
        inArray(organizationInventory.id, orgInvIds as any)
      ))

    const invRows = allInvRows.map(r => ({
      id: r.id,
      globalProductId: r.globalProductId,
      customPrice: r.customPrice // Use customPrice not customPriceCents
    }))

    console.log("Organization ID:", organizationId)
    console.log("Org Inventory IDs:", orgInvIds)
    console.log("Inventory rows fetched:", invRows.length)

    if (invRows.length !== orgInvIds.length) return NextResponse.json({ error: "Some items invalid" }, { status: 400 })

    // join to global products for base price and unit
    const gpIds = invRows.map(r => r.globalProductId)
    const allGpRows = await db.select().from(globalProducts).where(and(
      inArray(globalProducts.id, gpIds as any),
      eq(globalProducts.status, "active"),
      isNull(globalProducts.deletedAt),
    ))

    console.log("Global product rows:", allGpRows.map(r => ({ id: r.id, unit: r.unit, name: r.name })))

    const gpRows = allGpRows.map(r => ({
      id: r.id,
      basePrice: r.basePrice, // Use basePrice not basePriceCents
      name: r.name,
      productCode: r.productCode,
      unit: r.unit,
      stockQuantity: r.stockQuantity,
      allowDecimalQuantity: r.allowDecimalQuantity,
      quantityStep: r.quantityStep,
    }))

    console.log("Mapped gp rows:", gpRows)

    const gpById = new Map(gpRows.map(r => [r.id, r]))
    const invById = new Map(invRows.map(r => [r.id, r]))

    // We will do the stock check inside the transaction with FOR UPDATE locking
    // to prevent race conditions that lead to negative stock.

    let subtotal = 0
    const calculatedItems = normalizedItems.map(i => {
      const inv = invById.get(i.organizationInventoryId)
      if (!inv) throw new Error(`Inventory item ${i.organizationInventoryId} not found`)
      const gp = gpById.get(inv.globalProductId)
      if (!gp) throw new Error(`Global product for inventory ${inv.globalProductId} not found`)

      console.log(`Item ${i.organizationInventoryId}:`, {
        customPriceCents: inv.customPrice,
        basePriceCents: gp.basePrice,
        gpId: gp.id,
      })

      const quantityValidation = validateProductQuantity(i.quantity, {
        allowDecimalQuantity: gp.allowDecimalQuantity,
        quantityStep: gp.quantityStep,
        label: `Quantity for ${gp.name}`,
      })
      if (!quantityValidation.ok) throw new Error(quantityValidation.error)

      const unitPrice = inv.customPrice ?? gp.basePrice
      if (unitPrice === null || unitPrice === undefined) throw new Error(`Price not found for item ${i.organizationInventoryId}. Custom: ${inv.customPrice}, Base: ${gp.basePrice}`)
      const line = calculateLineCents(unitPrice, quantityValidation.quantity)
      subtotal += line
      return {
        organizationInventoryId: i.organizationInventoryId,
        globalProductId: inv.globalProductId,
        quantity: quantityValidation.quantity,
        priceCents: unitPrice,
        productName: gp.name,
        productCode: gp.productCode,
        unit: gp.unit,
      }
    })
    const tax = 0
    const total = subtotal + tax

    // budget check and hold - must be for current month period
    const currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM format
    const budgetRows = await db.select().from(budgets).where(
      and(
        eq(budgets.branchId, branchId),
        eq(budgets.period, currentMonth)
      )
    ).limit(1)
    const budget = budgetRows[0]

    let currentBudget = budget
    if (!currentBudget) {
      // Check if branch has a baseline budget to auto-initialize
      const [branchData] = await db.select({
        baselineBudgetCents: branches.baselineBudgetCents,
        organizationId: branches.organizationId
      })
        .from(branches)
        .where(eq(branches.id, branchId))
        .limit(1)

      if (branchData?.baselineBudgetCents && branchData.baselineBudgetCents > 0) {
        // Auto-initialize budget from baseline
        const [newBudget] = await db.insert(budgets).values({
          organizationId: branchData.organizationId,
          branchId,
          period: currentMonth,
          amountAllocatedCents: branchData.baselineBudgetCents,
          amountSpentCents: 0,
          amountHeldCents: 0,
          amountCreditedCents: 0,
        }).onConflictDoNothing().returning()
        currentBudget = newBudget || (await db.select().from(budgets).where(and(
          eq(budgets.branchId, branchId),
          eq(budgets.period, currentMonth),
        )).limit(1))[0]
      } else {
        return NextResponse.json({
          error: `Budget not configured for current month (${currentMonth}). Please contact head office to allocate budget.`
        }, { status: 400 })
      }
    }

    const remaining = (currentBudget.amountAllocatedCents + currentBudget.amountCreditedCents) - (currentBudget.amountSpentCents + currentBudget.amountHeldCents)

    // Prevent negative budgets
    if (remaining < 0) {
      return NextResponse.json({
        error: "Budget is in negative state. Please contact head office."
      }, { status: 400 })
    }

    if (total > remaining) {
      return NextResponse.json({
        error: pricesHidden
          ? "Insufficient budget. Please contact head office."
          : `Insufficient budget. Required: ${(total / 100).toFixed(2)} PKR, Available: ${(remaining / 100).toFixed(2)} PKR`
      }, { status: 400 })
    }

    const tid = generateTid()
    const invoiceSequenceReady = await hasInvoiceSequenceTable(db)

    const creationResult = await db.transaction(async (tx) => {
      const budgetId = currentBudget?.id
      if (!budgetId) throw new Error("Budget ID missing")

      // Re-check the money budget under lock before placing a hold.
      const [lockedBudget] = await tx.select()
        .from(budgets)
        .where(eq(budgets.id, budgetId))
        .for('update')

      if (!lockedBudget) throw new Error(`Budget not configured for current month (${currentMonth})`)

      const lockedMoneyRemaining =
        (lockedBudget.amountAllocatedCents + lockedBudget.amountCreditedCents) -
        (lockedBudget.amountSpentCents + lockedBudget.amountHeldCents)

      if (lockedMoneyRemaining < 0) {
        throw new Error("Budget is in negative state. Please contact head office.")
      }

      if (total > lockedMoneyRemaining) {
        throw new Error(pricesHidden
          ? "Insufficient budget. Please contact head office."
          : `Insufficient budget. Required: ${(total / 100).toFixed(2)} PKR, Available: ${(lockedMoneyRemaining / 100).toFixed(2)} PKR`)
      }

      const positiveQuantityBudgetTotal = sql`(${productQuantityBudgets.allocatedQuantity} + ${productQuantityBudgets.creditedQuantity}) > 0`
      const quantityBudgetModeActive = budgetAllocationMode === "quantity"

      const quantityBudgetRows = quantityBudgetModeActive
        ? await tx.select()
          .from(productQuantityBudgets)
          .where(and(
            eq(productQuantityBudgets.organizationId, Number(organizationId)),
            eq(productQuantityBudgets.branchId, Number(branchId)),
            eq(productQuantityBudgets.period, currentMonth),
            positiveQuantityBudgetTotal,
            inArray(productQuantityBudgets.organizationInventoryId, calculatedItems.map((item) => item.organizationInventoryId)),
          ))
          .for('update')
        : []

      const quantityBudgetByOrgInventoryId = new Map(
        quantityBudgetRows.map((row) => [row.organizationInventoryId, row])
      )

      for (const item of calculatedItems) {
        const quantityBudget = quantityBudgetByOrgInventoryId.get(item.organizationInventoryId)
        if (!quantityBudget) {
          if (quantityBudgetModeActive) {
            throw new Error(`Quantity budget is not allocated for ${item.productName}. Please select an allocated product.`)
          }
          continue
        }

        const quantityRemaining =
          quantityBudget.allocatedQuantity +
          quantityBudget.creditedQuantity -
          quantityBudget.usedQuantity -
          quantityBudget.heldQuantity

        if (quantityRemaining < 0) {
          throw new Error(`Quantity budget for ${item.productName} is in negative state. Please contact head office.`)
        }

        if (item.quantity > quantityRemaining) {
          throw new Error(`Insufficient quantity budget for ${item.productName}. Available: ${formatQuantity(quantityRemaining)}, Requested: ${formatQuantity(item.quantity)}`)
        }
      }

      // Revalidate branch and organization availability at the write point.
      const lockedBranchAssignments = await tx
        .select({ organizationInventoryId: branchInventory.organizationInventoryId })
        .from(branchInventory)
        .where(and(
          eq(branchInventory.branchId, branchId),
          eq(branchInventory.organizationId, Number(organizationId)),
          eq(branchInventory.isActive, true),
          eq(branchInventory.isVisible, true),
          isNull(branchInventory.deletedAt),
          inArray(branchInventory.organizationInventoryId, orgInvIds),
        ))
        .for('update')

      if (lockedBranchAssignments.length !== orgInvIds.length) {
        throw new Error("Some items are no longer available for this branch")
      }

      const lockedOrganizationInventory = await tx
        .select()
        .from(organizationInventory)
        .where(and(
          eq(organizationInventory.organizationId, Number(organizationId)),
          eq(organizationInventory.isActive, true),
          isNull(organizationInventory.deletedAt),
          inArray(organizationInventory.id, orgInvIds),
        ))
        .for('update')

      if (lockedOrganizationInventory.length !== orgInvIds.length) {
        throw new Error("Some items are no longer active for this organization")
      }

      // Lock global products to update stock safely and snapshot current prices.
      const gpIdsForLock = calculatedItems.map(i => i.globalProductId)
      const lockedGps = await tx.select()
        .from(globalProducts)
        .where(and(
          inArray(globalProducts.id, gpIdsForLock),
          eq(globalProducts.status, "active"),
          isNull(globalProducts.deletedAt),
        ))
        .for('update')

      const lockedGpMap = new Map(lockedGps.map(g => [g.id, g]))
      const lockedOrgInventoryMap = new Map(lockedOrganizationInventory.map((item) => [item.id, item]))

      let finalSubtotal = 0
      const finalCalculatedItems = normalizedItems.map((requestedItem) => {
        const inventoryItem = lockedOrgInventoryMap.get(requestedItem.organizationInventoryId)
        if (!inventoryItem) throw new Error("An inventory item is no longer available")

        const product = lockedGpMap.get(inventoryItem.globalProductId)
        if (!product) throw new Error("A product is no longer available")

        const quantityValidation = validateProductQuantity(requestedItem.quantity, {
          allowDecimalQuantity: product.allowDecimalQuantity,
          quantityStep: product.quantityStep,
          label: `Quantity for ${product.name}`,
        })
        if (!quantityValidation.ok) throw new Error(quantityValidation.error)

        const priceCents = inventoryItem.customPrice ?? product.basePrice
        if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
          throw new Error(`Pricing is unavailable for ${product.name}`)
        }

        finalSubtotal += calculateLineCents(priceCents, quantityValidation.quantity)
        return {
          organizationInventoryId: inventoryItem.id,
          globalProductId: product.id,
          quantity: quantityValidation.quantity,
          priceCents,
          productName: product.name,
          productCode: product.productCode,
          unit: product.unit,
        }
      })
      const finalTax = 0
      const finalTotal = finalSubtotal + finalTax

      if (!Number.isSafeInteger(finalSubtotal) || !Number.isSafeInteger(finalTotal) || finalTotal < 0) {
        throw new Error("Calculated order total is invalid")
      }

      if (finalTotal > lockedMoneyRemaining) {
        throw new Error(pricesHidden
          ? "Insufficient budget. Please contact head office."
          : `Insufficient budget. Required: ${(finalTotal / 100).toFixed(2)} PKR, Available: ${(lockedMoneyRemaining / 100).toFixed(2)} PKR`)
      }

      // 2. Perform FINAL stock check inside the lock
      for (const ci of finalCalculatedItems) {
        const gp = lockedGpMap.get(ci.globalProductId)
        if (!gp) throw new Error(`Product not found: ${ci.productName}`)

        if (gp.stockQuantity < ci.quantity) {
          // Inside transaction, throwing error will rollback
          throw new Error(`Insufficient stock for ${gp.name}. Available: ${formatQuantity(gp.stockQuantity)}, Requested: ${formatQuantity(ci.quantity)}`)
        }
      }

      // 3. Create Order in PENDING state
      const [ord] = await tx.insert(orders).values({
        tid,
        idempotencyKey,
        requestFingerprint,
        organizationId: Number(organizationId),
        branchId: Number(branchId),
        status: 'PENDING',
        subtotalCents: finalSubtotal,
        taxCents: finalTax,
        totalCents: finalTotal,
        notes: notes || null,
        createdByUserId: userId,
      }).returning(orderSelectColumns)

      // 4. Create Order Items
      await tx.insert(orderItems).values(finalCalculatedItems.map(ci => ({
        ...ci,
        orderId: ord.id,
        organizationId: Number(organizationId),
      })))

      // 5. Deduct stock using the lock
      for (const ci of finalCalculatedItems) {
        await tx.update(globalProducts)
          .set({
            stockQuantity: sql`${globalProducts.stockQuantity} - ${ci.quantity}`,
            updatedAt: new Date()
          })
          .where(eq(globalProducts.id, ci.globalProductId))
      }

      // 6. Generate and store receipt data
      let receiptData: Awaited<ReturnType<typeof generateReceiptData>> | null = null
      try {
        receiptData = await generateReceiptData({
          orderId: ord.id,
          orderTid: tid,
          status: 'PENDING',
          organizationId: Number(organizationId),
          branchId: Number(branchId),
          orderItemsData: finalCalculatedItems,
          subtotalCents: finalSubtotal,
          taxCents: finalTax,
          totalCents: finalTotal,
          discountCents: 0,
          deliveryChargesCents: 0,
        })
      } catch (receiptErr) {
        console.error("Receipt generation failed during order creation", receiptErr)
        // Don't fail the order if receipt generation fails
      }

      if (receiptData) {
        if (invoiceSequenceReady) {
          receiptData.invoiceNumber = await generateNextInvoiceNumber(tx, Number(organizationId))
        } else {
          console.error("Invoice sequence table is missing; falling back to order TID for invoice number. Run the invoice sequence migration.")
          receiptData.invoiceNumber = tid
        }

        // Update order with receipt data. If invoice persistence fails, rollback the order and counter.
        await tx.update(orders)
          .set({ receiptData: receiptData as any })
          .where(eq(orders.id, ord.id))
      }

      await tx.update(budgets).set({ amountHeldCents: sql`${budgets.amountHeldCents} + ${finalTotal}` }).where(eq(budgets.id, budgetId))

      for (const item of finalCalculatedItems) {
        const quantityBudget = quantityBudgetByOrgInventoryId.get(item.organizationInventoryId)
        if (!quantityBudget) continue

        await tx.update(productQuantityBudgets)
          .set({
            heldQuantity: sql`${productQuantityBudgets.heldQuantity} + ${item.quantity}`,
            updatedAt: new Date(),
          })
          .where(eq(productQuantityBudgets.id, quantityBudget.id))
      }

      // --- NEW: Detailed File Logging ---
      try {
        // Log complete order details for archival
        logOrderActivity('CREATE', {
          ...ord,
          orderItems: finalCalculatedItems
        }, {
          id: userId,
          email: session.user?.email || 'unknown',
          role: role
        })
      } catch (logErr) {
        console.error("File logging failed during order creation", logErr)
      }

      const headersList = await headers()
      const userAgent = headersList.get("user-agent")
      const forwardedFor = headersList.get("x-forwarded-for")
      const ip = forwardedFor ? forwardedFor.split(',')[0] : "unknown"

      await tx.insert(systemLogs).values({
        userId,
        userRole: role,
        organizationId: Number(organizationId),
        branchId: Number(branchId),
        action: 'ORDER_CREATE',
        resourceType: 'order',
        resourceId: String(ord.id),
        details: { tid, total: finalTotal, items: items.length },
        ipAddress: ip,
        userAgent: userAgent,
        success: true
      })

      const queuedNotifications = role === "ORDER_PORTAL"
        ? await queueOrderCreatedNotifications(tx, {
          order: ord,
          requestedBy: String(
            (session.user as any)?.fullName || "Order Portal user",
          ).trim().slice(0, 255),
        })
        : { eventKeys: [], recipientCount: 0 }

      return { order: ord, queuedNotifications }
    })

    const created = creationResult.order
    if (role === "ORDER_PORTAL" && creationResult.queuedNotifications.recipientCount === 0) {
      console.warn("[OrderNotifications] No active Branch Admin recipient was available", {
        orderId: created.id,
        organizationId: created.organizationId,
        branchId: created.branchId,
      })
    }
    await attemptImmediateOrderEmailDelivery(creationResult.queuedNotifications.eventKeys)

    const safeOrder = pricesHidden
      ? {
        ...created,
        subtotalCents: null,
        taxCents: null,
        totalCents: null,
      }
      : created

    return NextResponse.json({
      message: 'Order created',
      order: safeOrder,
    })
  } catch (e: any) {
    console.error("Order creation error:", e)
    console.error("Error stack:", e.stack)

    if (e?.code === "23505" && replayContext) {
      const [existingOrder] = await db
        .select({ ...orderSelectColumns, requestFingerprint: orders.requestFingerprint })
        .from(orders)
        .where(and(
          eq(orders.createdByUserId, replayContext.userId),
          eq(orders.idempotencyKey, replayContext.idempotencyKey),
        ))
        .limit(1)

      if (existingOrder) {
        if (existingOrder.requestFingerprint !== replayContext.requestFingerprint) {
          return NextResponse.json({ error: "Idempotency key was already used for a different order" }, { status: 409 })
        }
        const { requestFingerprint: _requestFingerprint, ...replayedOrder } = existingOrder

        return NextResponse.json({
          message: "Order already created",
          order: replayContext.pricesHidden
            ? { ...replayedOrder, subtotalCents: null, taxCents: null, totalCents: null }
            : replayedOrder,
          replayed: true,
        })
      }
    }

    const orderErrorMessage = String(e.message || "")
    const normalizedOrderErrorMessage = orderErrorMessage.toLowerCase()

    if (orderErrorMessage && (
      orderErrorMessage.startsWith("Insufficient stock") ||
      orderErrorMessage.startsWith("Budget not configured") ||
      orderErrorMessage.includes("Insufficient budget") ||
      normalizedOrderErrorMessage.includes("quantity budget") ||
      normalizedOrderErrorMessage.includes("negative state") ||
      normalizedOrderErrorMessage.includes("no longer") ||
      normalizedOrderErrorMessage.includes("pricing is unavailable")
    )) {
      return NextResponse.json({ error: orderErrorMessage }, { status: 400 })
    }

    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
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
