import { error, ok, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { auditLogs, branches, orderItems, orders, organizations } from "@/db/schema"
import { eq } from "drizzle-orm"
import { getCurrentUser, getRequestScope, verifyResourceAccess } from "@/lib/auth"
import { sendOrderTokenEmail } from "@/lib/email"
import { ADMIN_OPERATIONS_EMAIL } from "@/lib/email/recipients"
import { withRateLimit } from "@/lib/rate-limiter"
import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"
import { getOrderDecisionCapabilities } from "@/lib/server/order-decision-policy"
import { GROUP_USER_ROLE, canUseScopedBranch } from "@/lib/server/multi-branch-scope"

const TOKEN_EMAIL_RECIPIENT = ADMIN_OPERATIONS_EMAIL

/**
 * Branch authorization for this endpoint.
 *
 * `verifyResourceAccess` compares the order's branch against the single branch
 * pinned on the user row, which is exactly right for BRANCH_ADMIN and
 * ORDER_PORTAL and is left untouched for them. A GROUP_USER has no single
 * branch — its reach is a resolved set of assignments — so it is checked
 * against that set instead, with the tenant re-asserted explicitly first.
 */
async function hasBranchAccessForTokenEmail(
  role: string,
  userId: string,
  actorOrganizationId: number | null,
  order: { organizationId: number; branchId: number },
): Promise<boolean> {
  if (role !== GROUP_USER_ROLE) {
    return verifyResourceAccess(order.organizationId, order.branchId)
  }
  if (!actorOrganizationId || actorOrganizationId !== order.organizationId) return false
  return canUseScopedBranch(userId, order.branchId)
}

export async function POST(
  _req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const roleError = await requireApiRole(["HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL"])
  if (roleError) return roleError

  const user = await getCurrentUser()
  if (!user) return error("Unauthorized", 401)

  const rateLimit = await withRateLimit("email", user.id)
  if (rateLimit) return rateLimit

  const params = await props.params
  const orderId = Number(params.id)
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return error("Invalid order ID", 400)
  }

  const [order] = await db
    .select({
      id: orders.id,
      tid: orders.tid,
      organizationId: orders.organizationId,
      branchId: orders.branchId,
      status: orders.status,
      createdByUserId: orders.createdByUserId,
      approvedByUserId: orders.approvedByUserId,
      approvalToken: orders.approvalToken,
      createdAt: orders.createdAt,
      organizationName: organizations.name,
      orderApproverRole: organizations.orderApproverRole,
      branchName: branches.name,
      branchOrganizationId: branches.organizationId,
    })
    .from(orders)
    .leftJoin(organizations, eq(orders.organizationId, organizations.id))
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .where(eq(orders.id, orderId))
    .limit(1)

  if (!order) return error("Order not found", 404)
  if (!order.organizationId || order.branchOrganizationId !== order.organizationId) {
    return error("Forbidden: Invalid order tenant scope", 403)
  }

  const scope = await getRequestScope()
  if (!scope || scope.userId !== user.id || scope.role !== user.role) {
    return error("Unauthorized", 401)
  }

  const hasAccess = await hasBranchAccessForTokenEmail(
    user.role,
    user.id,
    scope.organizationId,
    { organizationId: order.organizationId, branchId: order.branchId },
  )
  if (!hasAccess) return error("Forbidden: You do not have access to this order", 403)

  const capabilities = await getOrderDecisionCapabilities(scope)
  const canShareToken = canViewFulfillmentToken({
    role: user.role,
    userId: user.id,
    orderStatus: order.status,
    orderCreatedByUserId: order.createdByUserId,
    orderApprovedByUserId: order.approvedByUserId,
    configuredApproverRole: capabilities.orderApproverRole,
  })
  if (!canShareToken) return error("Forbidden: You do not have access to this fulfillment token", 403)

  if (String(order.status || "").toUpperCase() !== "APPROVED") {
    return error("Token email can only be sent for approved orders", 400)
  }

  if (!order.approvalToken) {
    return error("This order does not have a fulfillment token available", 400)
  }

  const items = await db
    .select({
      productName: orderItems.productName,
      productCode: orderItems.productCode,
      quantity: orderItems.quantity,
      unit: orderItems.unit,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))

  try {
    await sendOrderTokenEmail({
      to: TOKEN_EMAIL_RECIPIENT,
      token: order.approvalToken,
      tid: order.tid,
      organizationName: order.organizationName || `Organization ${order.organizationId || ""}`,
      branchName: order.branchName || `Branch ${order.branchId}`,
      status: order.status,
      createdAt: order.createdAt,
      items,
    })
  } catch (emailError) {
    const emailErrorMessage = emailError instanceof Error
      ? `${emailError.name}: ${emailError.message}`
      : String(emailError)

    return error(`Failed to send token email through AWS SES: ${emailErrorMessage}`, 400)
  }

  await db.insert(auditLogs).values({
    userId: user.id,
    organizationId: order.organizationId,
    branchId: order.branchId,
    action: "SEND_ORDER_TOKEN_EMAIL",
    entity: "ORDER",
    entityId: String(order.id),
    metadata: {
      tid: order.tid,
      recipient: TOKEN_EMAIL_RECIPIENT,
    },
  })

  return ok({
    message: "Token email sent successfully",
    recipient: TOKEN_EMAIL_RECIPIENT,
  })
}
