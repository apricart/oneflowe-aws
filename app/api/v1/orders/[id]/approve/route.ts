import { ok, error, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { orders } from "@/db/schema"
import { and, eq, sql } from "drizzle-orm"
import { getCurrentUser } from "@/lib/auth"
import { generateApprovalToken, hashApprovalToken } from "@/lib/approval-token"
import { logTokenGenerated } from "@/lib/global-logger"
import { orderSelectColumns } from "@/lib/order-select"
import {
  attemptImmediateOrderEmailDelivery,
  queueOrderDecisionNotification,
  queueSuperAdminApprovalNotifications,
} from "@/lib/server/order-notifications"

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  // BRANCH_ADMIN can approve orders for their branch
  const err = await requireApiRole(["BRANCH_ADMIN", "HEAD_OFFICE", "SUPER_ADMIN"])
  if (err) return err

  const params = await props.params
  const orderId = Number(params.id)
  if (!Number.isInteger(orderId) || orderId <= 0) return error("Invalid order ID", 400)
  const user = await getCurrentUser()

  if (!user) return error("Unauthorized", 401)

  // Fetch order
  const [ord] = await db.select(orderSelectColumns).from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!ord) return error("Order not found", 404)

  // BOLA: Verify user has access to this order's branch
  const { verifyResourceAccess } = await import("@/lib/auth")
  const hasAccess = await verifyResourceAccess(ord.organizationId, ord.branchId)
  if (!hasAccess) return error("Forbidden", 403)

  if (ord.status.toUpperCase() !== "PENDING") {
    return error(`Cannot approve order in ${ord.status} state`, 400)
  }

  // Generate secure approval token
  const plainToken = generateApprovalToken(10)
  const tokenHash = await hashApprovalToken(plainToken)

  const queuedNotifications = await db.transaction(async (tx) => {
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

    if (!approved) return null

    const creatorNotifications = await queueOrderDecisionNotification(tx, {
      order: ord,
      decision: "APPROVED",
    })
    const superAdminNotifications = user.role === "BRANCH_ADMIN"
      ? await queueSuperAdminApprovalNotifications(tx, {
        order: ord,
        approvedByUserId: user.id,
      })
      : { eventKeys: [], recipientCount: 0 }

    return { creatorNotifications, superAdminNotifications }
  })

  if (!queuedNotifications) {
    return error("Order was already approved, rejected, or otherwise changed", 409)
  }

  // Log token generation
  logTokenGenerated(
    orderId,
    ord.tid,
    user.id,
    user.email || "unknown"
  )

  if (queuedNotifications.creatorNotifications.recipientCount === 0) {
    console.warn("[OrderNotifications] Approved order creator was not an active scoped Order Portal user", {
      orderId,
      organizationId: ord.organizationId,
      branchId: ord.branchId,
    })
  }
  if (user.role === "BRANCH_ADMIN" && queuedNotifications.superAdminNotifications.recipientCount === 0) {
    console.warn("[OrderNotifications] No active Super Admin recipient was available", {
      orderId,
      organizationId: ord.organizationId,
      branchId: ord.branchId,
    })
  }
  await attemptImmediateOrderEmailDelivery([
    ...queuedNotifications.creatorNotifications.eventKeys,
    ...queuedNotifications.superAdminNotifications.eventKeys,
  ])

  return ok({
    message: "Order approved successfully",
    approvalToken: plainToken,
    warning: "SAVE THIS TOKEN! It will not be shown again."
  })
}
