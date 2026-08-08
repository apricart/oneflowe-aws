import { eq, sql } from "drizzle-orm"
import { getServerSession } from "next-auth"
import { branches, globalProducts, orderItems, orders, refundItems, refunds, users } from "@/db/schema"
import { error, ok, requireApiRole } from "@/lib/api"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orderSelectColumns } from "@/lib/order-select"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"
import { getRequestScope } from "@/lib/auth"
import { getOrderDecisionCapabilities } from "@/lib/server/order-decision-policy"

export async function GET(
  _: Request,
  props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"])
  if (authError) return authError

  const { id } = await props.params
  const orderId = Number(id)
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
    .where(eq(orders.id, orderId))
  if (!item) return error("Not found", 404)
  if (!item.organizationId || item.branchOrganizationId !== item.organizationId) {
    return error("Forbidden: Invalid order tenant scope", 403)
  }

  const { verifyResourceAccess } = await import("@/lib/auth")
  const hasAccess = await verifyResourceAccess(item.organizationId, item.branchId)
  if (!hasAccess) return error("Forbidden: You do not have access to this order", 403)

  const session = await getServerSession(authOptions)
  const currentUserId = (session?.user as any)?.id
  const currentRole = (session?.user as any)?.role
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

export async function DELETE(
  _: Request,
  _props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(["SUPER_ADMIN"])
  if (authError) return authError
  return error("Use the administrative order-deletion workflow", 405)
}
