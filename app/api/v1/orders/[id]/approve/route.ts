import { ok, error, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { auditLogs, orders } from "@/db/schema"
import { and, eq, sql } from "drizzle-orm"
import { getCurrentUser, getRequestScope } from "@/lib/auth"
import { generateApprovalToken, hashApprovalToken } from "@/lib/approval-token"
import { logTokenGenerated } from "@/lib/global-logger"
import {
  attemptImmediateOrderEmailDelivery,
  queueOrderDecisionNotification,
  queueSuperAdminApprovalNotifications,
} from "@/lib/server/order-notifications"
import { authorizeOrderDecision } from "@/lib/server/order-decision-policy"

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["BRANCH_ADMIN", "HEAD_OFFICE", "GROUP_USER"])
  if (err) return err

  const params = await props.params
  const orderId = Number(params.id)
  if (!Number.isInteger(orderId) || orderId <= 0) return error("Invalid order ID", 400)
  const user = await getCurrentUser()
  const scope = await getRequestScope()

  if (!user || !scope || user.id !== scope.userId || user.role !== scope.role) {
    return error("Unauthorized", 401)
  }

  // Generate secure approval token
  const plainToken = generateApprovalToken(10)

  const decisionResult = await db.transaction(async (tx) => {
    const authorization = await authorizeOrderDecision(tx, { orderId, scope })
    if (!authorization.ok) return { kind: authorization.reason } as const
    const ord = authorization.order

    if (ord.status.toUpperCase() !== "PENDING") {
      return { kind: "invalid-state", status: ord.status } as const
    }

    const tokenHash = await hashApprovalToken(plainToken)
    const [approved] = await tx.update(orders).set({
      status: "APPROVED",
      approvedByUserId: user.id,
      approvedAt: new Date(),
      approvalToken: plainToken,
      approvalTokenHash: tokenHash,
      approvalTokenCreatedAt: new Date(),
      updatedAt: new Date()
    }).where(and(
      eq(orders.id, orderId),
      sql`UPPER(${orders.status}) = 'PENDING'`,
    )).returning({ id: orders.id })

    if (!approved) return { kind: "conflict" } as const

    const creatorNotifications = await queueOrderDecisionNotification(tx, {
      order: ord,
      decision: "APPROVED",
    })
    const superAdminNotifications = await queueSuperAdminApprovalNotifications(tx, {
      order: ord,
      approvedByUserId: user.id,
      approvedByRole: authorization.decisionRole,
    })

    await tx.insert(auditLogs).values({
      userId: user.id,
      organizationId: ord.organizationId,
      branchId: ord.branchId,
      action: "ORDER_APPROVED",
      entity: "order",
      entityId: String(ord.id),
      metadata: {
        tid: ord.tid,
        actorRole: user.role,
        decisionRole: authorization.decisionRole,
        configuredApproverRole: authorization.configuredApproverRole,
      },
    })

    return {
      kind: "approved",
      order: ord,
      creatorNotifications,
      superAdminNotifications,
    } as const
  })

  if (decisionResult.kind === "not-found") return error("Order not found", 404)
  if (decisionResult.kind === "forbidden") return error("Forbidden", 403)
  if (decisionResult.kind === "invalid-state") {
    return error(`Cannot approve order in ${decisionResult.status} state`, 400)
  }
  if (decisionResult.kind === "conflict") {
    return error("Order was already approved, rejected, or otherwise changed", 409)
  }
  if (decisionResult.kind !== "approved") {
    return error("Order approval could not be completed", 409)
  }
  const ord = decisionResult.order

  // Log token generation
  logTokenGenerated(
    orderId,
    ord.tid,
    user.id,
    user.email || "unknown"
  )

  if (decisionResult.creatorNotifications.recipientCount === 0) {
    console.warn("[OrderNotifications] Approved order creator was not an active scoped Order Portal user", {
      orderId,
      organizationId: ord.organizationId,
      branchId: ord.branchId,
    })
  }
  if (decisionResult.superAdminNotifications.recipientCount === 0) {
    console.warn("[OrderNotifications] No active Super Admin recipient was available", {
      orderId,
      organizationId: ord.organizationId,
      branchId: ord.branchId,
    })
  }
  await attemptImmediateOrderEmailDelivery([
    ...decisionResult.creatorNotifications.eventKeys,
    ...decisionResult.superAdminNotifications.eventKeys,
  ])

  return ok({
    message: "Order approved successfully",
    approvalToken: plainToken,
    warning: "SAVE THIS TOKEN! It will not be shown again."
  })
}
