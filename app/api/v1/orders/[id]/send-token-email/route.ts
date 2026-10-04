import { error, ok, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { auditLogs, branches, orderItems, orders, organizations } from "@/db/schema"
import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { getCurrentUser, getRequestScope, verifyResourceAccess } from "@/lib/auth"
import { sendOrderTokenEmail } from "@/lib/email"
import { ADMIN_OPERATIONS_EMAIL } from "@/lib/email/recipients"
import { withRateLimit } from "@/lib/rate-limiter"
import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"
import {
  TOKEN_ALREADY_SENT_CODE,
  TOKEN_ALREADY_SENT_MESSAGE,
  TOKEN_HANDOFF_STATUS,
  TOKEN_ORDER_NOT_APPROVED_CODE,
  TOKEN_SEND_IN_PROGRESS_CODE,
  TOKEN_SEND_IN_PROGRESS_MESSAGE,
  isTokenHandoffEligible,
  tokenHandoffMessage,
  tokenOrderNotApprovedMessage,
} from "@/lib/order-token-handoff"
import { getOrderDecisionCapabilities } from "@/lib/server/order-decision-policy"
import { settleOrdersAfterTokenHandoff } from "@/lib/server/order-fulfillment"
import { sendTokenEmailOncePerOrder } from "@/lib/server/order-token-handoff-store"
import { canUseScopedBranch, usesMultiBranchScope } from "@/lib/server/multi-branch-scope"

const TOKEN_EMAIL_RECIPIENT = ADMIN_OPERATIONS_EMAIL

/**
 * Branch authorization for this endpoint.
 *
 * `verifyResourceAccess` compares the order's branch against the single branch
 * pinned on the user row, which is exactly right for BRANCH_ADMIN and
 * ORDER_PORTAL and is left untouched for them. The group-based roles have no
 * single branch — their reach is a resolved set of assignments — so they are
 * checked against that set instead, with the tenant re-asserted explicitly
 * first. GROUP_ORDER_PORTAL additionally has to be the order's creator, which
 * `canViewFulfillmentToken` enforces below.
 */
async function hasBranchAccessForTokenEmail(
  role: string,
  userId: string,
  actorOrganizationId: number | null,
  order: { organizationId: number; branchId: number },
): Promise<boolean> {
  if (!usesMultiBranchScope(role)) {
    return verifyResourceAccess(order.organizationId, order.branchId)
  }
  if (!actorOrganizationId || actorOrganizationId !== order.organizationId) return false
  return canUseScopedBranch(userId, order.branchId)
}

/**
 * What the caller is told once the token has left.
 *
 * The order is reported as it actually stands. A token that reaches the
 * administrator before the goods do leaves the order approved with the hand-off
 * recorded — it settles when the delivery is recorded, and the caller is told
 * that rather than being told the order is fulfilled. A hand-off that could not
 * even be recorded — one someone else already fulfilled, or one whose status
 * moved underneath the request — still delivered the token, and says so.
 */
function tokenHandoffResponse(
  orderStatus: string,
  { fulfilled, awaitingDelivery }: { fulfilled: boolean; awaitingDelivery: boolean },
) {
  return ok({
    message: tokenHandoffMessage({
      sentCount: 1,
      fulfilledCount: fulfilled ? 1 : 0,
      awaitingDeliveryCount: awaitingDelivery ? 1 : 0,
    }),
    recipient: TOKEN_EMAIL_RECIPIENT,
    fulfilled,
    awaitingDelivery,
    status: fulfilled ? "FULFILLED" : orderStatus,
  })
}

export async function POST(
  _req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const roleError = await requireApiRole([
    "HEAD_OFFICE",
    "BRANCH_ADMIN",
    "GROUP_USER",
    "GROUP_ORDER_PORTAL",
    "ORDER_PORTAL",
  ])
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
  // Asked as though the order were still approved. The requester roles hold a
  // token only while it is, so asking with the live status would answer a
  // since-fulfilled order with "no access" — and the person who could have
  // sent its token would never learn the order simply moved on. Only someone
  // this check admits is told the order's current status below.
  const canShareToken = canViewFulfillmentToken({
    role: user.role,
    userId: user.id,
    orderStatus: TOKEN_HANDOFF_STATUS,
    orderCreatedByUserId: order.createdByUserId,
    orderApprovedByUserId: order.approvedByUserId,
    configuredApproverRole: capabilities.orderApproverRole,
  })
  if (!canShareToken) return error("Forbidden: You do not have access to this fulfillment token", 403)

  // The token exists only on an approved order; this is the status gate.
  if (!isTokenHandoffEligible(order.status)) {
    // Told the status it is in now, so a screen that still showed it approved
    // can correct itself instead of reporting a failure.
    const currentStatus = String(order.status ?? "").trim().toUpperCase() || null
    return NextResponse.json({
      error: tokenOrderNotApprovedMessage(currentStatus),
      code: TOKEN_ORDER_NOT_APPROVED_CODE,
      status: currentStatus,
    }, { status: 409 })
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

  const approvalToken = order.approvalToken
  const sendOutcome = await sendTokenEmailOncePerOrder(
    [{ orderId: order.id, organizationId: order.organizationId, branchId: order.branchId }],
    user.id,
    async () => {
      try {
        await sendOrderTokenEmail({
          to: TOKEN_EMAIL_RECIPIENT,
          token: approvalToken,
          tid: order.tid,
          organizationName: order.organizationName || `Organization ${order.organizationId || ""}`,
          branchName: order.branchName || `Branch ${order.branchId}`,
          status: order.status,
          createdAt: order.createdAt,
          items,
        })
        return { delivered: true }
      } catch (emailError) {
        const reason = emailError instanceof Error
          ? `${emailError.name}: ${emailError.message}`
          : String(emailError)
        return { delivered: false, reason }
      }
    },
  )

  if (sendOutcome.outcome === "already-sent") {
    return NextResponse.json({ error: TOKEN_ALREADY_SENT_MESSAGE, code: TOKEN_ALREADY_SENT_CODE }, { status: 409 })
  }
  if (sendOutcome.outcome === "in-progress") {
    return NextResponse.json({ error: TOKEN_SEND_IN_PROGRESS_MESSAGE, code: TOKEN_SEND_IN_PROGRESS_CODE }, { status: 409 })
  }
  if (sendOutcome.outcome === "failed") {
    return error(`Failed to send token email through AWS SES: ${sendOutcome.reason}`, 400)
  }

  // The token has reached the administrator, so the hand-off is recorded
  // against the order — and settles it if the order has already been delivered.
  // Both run on the order this request already authorized, under the same
  // tenant and branch, and never fail a hand-off that did go out.
  const settlement = await settleOrdersAfterTokenHandoff([{
    orderId: order.id,
    organizationId: order.organizationId,
    branchId: order.branchId,
    status: order.status,
    handedOffByUserId: user.id,
  }])
  const fulfilled = settlement.fulfilledOrderIds.has(order.id)
  const awaitingDelivery = settlement.awaitingDeliveryOrderIds.has(order.id)

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
      fulfilled,
      awaitingDelivery,
    },
  })

  return tokenHandoffResponse(order.status, { fulfilled, awaitingDelivery })
}
