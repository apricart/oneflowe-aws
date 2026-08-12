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
    const result = await db.transaction(async (tx) => {
      // Revalidate the actor from the database so a stale session cannot edit
      // after a role, tenant, branch, or activation change.
      const [actor] = await tx
        .select({
          id: users.id,
          role: roles.name,
          organizationId: users.organizationId,
          branchId: users.branchId,
        })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(and(
          eq(users.id, user.id),
          eq(users.isActive, true),
          isNull(users.deletedAt),
        ))
        .limit(1)

      if (
        actor?.role !== "ORDER_PORTAL"
        || actor.organizationId !== organizationId
        || actor.branchId !== branchId
      ) {
        return { kind: "forbidden" } as const
      }

      // This row lock serializes an edit with approval/rejection. The scoped
      // predicates intentionally make another tenant's or user's order look
      // absent rather than revealing that it exists.
      const [existingOrder] = await tx
        .select()
        .from(orders)
        .where(and(
          eq(orders.id, orderId),
          eq(orders.createdByUserId, user.id),
          eq(orders.organizationId, organizationId),
          eq(orders.branchId, branchId),
        ))
        .for("update")
        .limit(1)

      if (!existingOrder) return { kind: "not-found" } as const

      const [orderBranch] = await tx
        .select({ organizationId: branches.organizationId })
        .from(branches)
        .where(eq(branches.id, existingOrder.branchId))
        .for("share")
        .limit(1)

      if (!canOrderPortalEditOrder({
        actorRole: actor.role,
        actorUserId: actor.id,
        actorOrganizationId: actor.organizationId,
        actorBranchId: actor.branchId,
        orderStatus: existingOrder.status,
        orderCreatedByUserId: existingOrder.createdByUserId,
        orderOrganizationId: existingOrder.organizationId,
        orderBranchId: existingOrder.branchId,
        branchOrganizationId: orderBranch?.organizationId,
      })) {
        if (String(existingOrder.status).toUpperCase() !== "PENDING") {
          return { kind: "invalid-state", status: existingOrder.status } as const
        }
        return { kind: "forbidden" } as const
      }

      const existingItems = await tx
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .for("update")

      const requestedInventoryIds = normalizedItems.map((item) => item.organizationInventoryId)

      const assignedInventory = await tx
        .select({ organizationInventoryId: branchInventory.organizationInventoryId })
        .from(branchInventory)
        .where(and(
          eq(branchInventory.branchId, branchId),
          eq(branchInventory.organizationId, organizationId),
          eq(branchInventory.isActive, true),
          eq(branchInventory.isVisible, true),
          isNull(branchInventory.deletedAt),
          inArray(branchInventory.organizationInventoryId, requestedInventoryIds),
        ))
        .for("update")

      if (assignedInventory.length !== requestedInventoryIds.length) {
        throw new Error("Some items are no longer available for this branch")
      }

      const inventoryRows = await tx
        .select()
        .from(organizationInventory)
        .where(and(
          eq(organizationInventory.organizationId, organizationId),
          eq(organizationInventory.isActive, true),
          isNull(organizationInventory.deletedAt),
          inArray(organizationInventory.id, requestedInventoryIds),
        ))
        .for("update")

      if (inventoryRows.length !== requestedInventoryIds.length) {
        throw new Error("Some items are no longer active for this organization")
      }

      const inventoryById = new Map(inventoryRows.map((item) => [item.id, item]))
      const requestedGlobalProductIds = inventoryRows.map((item) => item.globalProductId)
      const allGlobalProductIds = Array.from(new Set([
        ...requestedGlobalProductIds,
        ...existingItems.map((item) => item.globalProductId),
      ]))
      const productRows = await tx
        .select()
        .from(globalProducts)
        .where(inArray(globalProducts.id, allGlobalProductIds))
        .for("update")
      const productById = new Map(productRows.map((product) => [product.id, product]))

      const oldQuantityByGlobalProductId = new Map<number, number>()
      const oldQuantityByInventoryId = new Map<number, number>()
      for (const item of existingItems) {
        oldQuantityByGlobalProductId.set(
          item.globalProductId,
          roundQuantity((oldQuantityByGlobalProductId.get(item.globalProductId) || 0) + Number(item.quantity)),
        )
        if (item.organizationInventoryId) {
          oldQuantityByInventoryId.set(
            item.organizationInventoryId,
            roundQuantity((oldQuantityByInventoryId.get(item.organizationInventoryId) || 0) + Number(item.quantity)),
          )
        }
      }

      let subtotalCents = 0
      const calculatedItems = normalizedItems.map((requestedItem) => {
        const inventoryItem = inventoryById.get(requestedItem.organizationInventoryId)
        if (!inventoryItem) throw new Error("An inventory item is no longer available")

        const product = productById.get(inventoryItem.globalProductId)
        if (product?.status !== "active" || product.deletedAt) {
          throw new Error("A product is no longer available")
        }

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

        const availableStock = Number(product.stockQuantity)
          + (oldQuantityByGlobalProductId.get(product.id) || 0)
        if (quantityValidation.quantity > availableStock) {
          throw new Error(
            `Insufficient stock for ${product.name}. Available: ${formatQuantity(availableStock)}, Requested: ${formatQuantity(quantityValidation.quantity)}`,
          )
        }

        subtotalCents += calculateLineCents(priceCents, quantityValidation.quantity)
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

      const taxCents = 0
      const totalCents = subtotalCents + taxCents
      if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
        throw new Error("Calculated order total is invalid")
      }

      const orderPeriod = existingOrder.createdAt
        ? new Date(existingOrder.createdAt).toISOString().slice(0, 7)
        : new Date().toISOString().slice(0, 7)
      const [lockedBudget] = await tx
        .select()
        .from(budgets)
        .where(and(
          eq(budgets.organizationId, organizationId),
          eq(budgets.branchId, branchId),
          eq(budgets.period, orderPeriod),
        ))
        .for("update")
        .limit(1)

      if (!lockedBudget) throw new Error(`Budget not configured for order period (${orderPeriod})`)
      if (lockedBudget.amountHeldCents < existingOrder.totalCents) {
        throw new Error("BUDGET_LEDGER_INVARIANT")
      }

      const moneyAvailable = lockedBudget.amountAllocatedCents
        + lockedBudget.amountCreditedCents
        - lockedBudget.amountSpentCents
        - lockedBudget.amountHeldCents
        + existingOrder.totalCents
      if (totalCents > moneyAvailable) {
        throw new Error(pricesHidden
          ? "Insufficient budget. Please contact head office."
          : `Insufficient budget. Required: ${(totalCents / 100).toFixed(2)} PKR, Available: ${(moneyAvailable / 100).toFixed(2)} PKR`)
      }

      const newQuantityByInventoryId = new Map(
        calculatedItems.map((item) => [item.organizationInventoryId, item.quantity]),
      )
      const allQuantityInventoryIds = Array.from(new Set([
        ...oldQuantityByInventoryId.keys(),
        ...newQuantityByInventoryId.keys(),
      ]))
      const quantityBudgetRows = allQuantityInventoryIds.length > 0
        ? await tx
          .select()
          .from(productQuantityBudgets)
          .where(and(
            eq(productQuantityBudgets.organizationId, organizationId),
            eq(productQuantityBudgets.branchId, branchId),
            eq(productQuantityBudgets.period, orderPeriod),
            inArray(productQuantityBudgets.organizationInventoryId, allQuantityInventoryIds),
          ))
          .for("update")
        : []
      const quantityBudgetByInventoryId = new Map(
        quantityBudgetRows.map((row) => [row.organizationInventoryId, row]),
      )

      for (const organizationInventoryId of allQuantityInventoryIds) {
        const previousQuantity = oldQuantityByInventoryId.get(organizationInventoryId) || 0
        const nextQuantity = newQuantityByInventoryId.get(organizationInventoryId) || 0
        const quantityBudget = quantityBudgetByInventoryId.get(organizationInventoryId)

        if (
          nextQuantity > 0
          && budgetAllocationMode === "quantity"
          && (!quantityBudget || quantityBudget.allocatedQuantity + quantityBudget.creditedQuantity <= 0)
        ) {
          const productName = calculatedItems.find(
            (item) => item.organizationInventoryId === organizationInventoryId,
          )?.productName || "this product"
          throw new Error(`Quantity budget is not allocated for ${productName}. Please select an allocated product.`)
        }

        // Money-budget organizations legitimately have no quantity ledger row.
        if (!quantityBudget) continue
        if (quantityBudget.heldQuantity < previousQuantity) {
          throw new Error("QUANTITY_BUDGET_LEDGER_INVARIANT")
        }

        const quantityAvailable = quantityBudget.allocatedQuantity
          + quantityBudget.creditedQuantity
          - quantityBudget.usedQuantity
          - quantityBudget.heldQuantity
          + previousQuantity
        if (nextQuantity > quantityAvailable) {
          const productName = calculatedItems.find(
            (item) => item.organizationInventoryId === organizationInventoryId,
          )?.productName || "this product"
          throw new Error(
            `Insufficient quantity budget for ${productName}. Available: ${formatQuantity(quantityAvailable)}, Requested: ${formatQuantity(nextQuantity)}`,
          )
        }
      }

      // A second status predicate documents and enforces the lifecycle guard at
      // the actual write point, even though the row remains locked above.
      const [updatedOrder] = await tx
        .update(orders)
        .set({
          subtotalCents,
          taxCents,
          totalCents,
          ...(parsedBody.data.notes !== undefined
            ? { notes: parsedBody.data.notes || null }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(
          eq(orders.id, orderId),
          eq(orders.createdByUserId, user.id),
          eq(orders.organizationId, organizationId),
          eq(orders.branchId, branchId),
          sql`UPPER(${orders.status}) = 'PENDING'`,
        ))
        .returning(orderSelectColumns)

      if (!updatedOrder) throw new Error("ORDER_EDIT_CONFLICT")

      await tx
        .update(budgets)
        .set({
          amountHeldCents: lockedBudget.amountHeldCents - existingOrder.totalCents + totalCents,
          updatedAt: new Date(),
        })
        .where(eq(budgets.id, lockedBudget.id))

      for (const row of quantityBudgetRows) {
        const previousQuantity = oldQuantityByInventoryId.get(row.organizationInventoryId) || 0
        const nextQuantity = newQuantityByInventoryId.get(row.organizationInventoryId) || 0
        if (previousQuantity === nextQuantity) continue

        await tx
          .update(productQuantityBudgets)
          .set({
            heldQuantity: roundQuantity(row.heldQuantity - previousQuantity + nextQuantity),
            updatedByUserId: user.id,
            updatedAt: new Date(),
          })
          .where(eq(productQuantityBudgets.id, row.id))
      }

      const newQuantityByGlobalProductId = new Map<number, number>()
      for (const item of calculatedItems) {
        newQuantityByGlobalProductId.set(
          item.globalProductId,
          roundQuantity((newQuantityByGlobalProductId.get(item.globalProductId) || 0) + item.quantity),
        )
      }
      for (const globalProductId of allGlobalProductIds) {
        const product = productById.get(globalProductId)
        if (!product) throw new Error("A previously ordered product could not be reconciled")
        const previousQuantity = oldQuantityByGlobalProductId.get(globalProductId) || 0
        const nextQuantity = newQuantityByGlobalProductId.get(globalProductId) || 0
        const nextStock = roundQuantity(Number(product.stockQuantity) + previousQuantity - nextQuantity)
        if (nextStock < 0) throw new Error("STOCK_LEDGER_INVARIANT")
        if (previousQuantity === nextQuantity) continue

        await tx
          .update(globalProducts)
          .set({ stockQuantity: nextStock, updatedAt: new Date() })
          .where(eq(globalProducts.id, globalProductId))
      }

      await tx.delete(orderItems).where(eq(orderItems.orderId, orderId))
      await tx.insert(orderItems).values(calculatedItems.map((item) => ({
        ...item,
        orderId,
        organizationId,
      })))

      try {
        const receiptData = await generateReceiptData({
          orderId,
          orderTid: existingOrder.tid,
          status: "PENDING",
          organizationId,
          branchId,
          orderItemsData: calculatedItems,
          subtotalCents,
          taxCents,
          totalCents,
          discountCents: 0,
          deliveryChargesCents: 0,
        })
        const previousReceipt = existingOrder.receiptData as any
        receiptData.invoiceNumber = previousReceipt?.invoiceNumber || existingOrder.tid
        receiptData.date = previousReceipt?.date || receiptData.date
        await tx.update(orders).set({ receiptData: receiptData as any }).where(eq(orders.id, orderId))
      } catch (receiptError) {
        console.error("Receipt regeneration failed during order edit", receiptError)
        // Never retain a receipt snapshot for the previous item set.
        await tx.update(orders).set({ receiptData: null }).where(eq(orders.id, orderId))
      }

      await tx.insert(auditLogs).values({
        userId: user.id,
        organizationId,
        branchId,
        action: "ORDER_EDITED",
        entity: "order",
        entityId: String(orderId),
        metadata: {
          tid: existingOrder.tid,
          actorRole: actor.role,
          previousTotalCents: existingOrder.totalCents,
          totalCents,
          previousItemCount: existingItems.length,
          itemCount: calculatedItems.length,
        },
      })

      return { kind: "updated", order: updatedOrder } as const
    })

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
