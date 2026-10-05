import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { and, desc, eq, isNull, notInArray, or, type SQL } from "drizzle-orm"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { notifications } from "@/db/schema"
import { getOrderDecisionCapabilities } from "@/lib/server/order-decision-policy"

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function getSessionUserId(session: any) {
  const userId = (session?.user as any)?.id
  return typeof userId === "string" && uuidPattern.test(userId) ? userId : null
}

function scopedNotificationConditions(session: any, userId: string): SQL[] | null {
  const role = (session?.user as any)?.role
  // The two group roles have no branch of their own; their notices are their
  // own rows inside their own organization, which the user and tenant filters
  // below already say.
  if (!["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "GROUP_ORDER_PORTAL"].includes(role)) return null

  const conditions: SQL[] = [
    eq(notifications.userId, userId),
    isNull(notifications.readAt),
    or(isNull(notifications.targetRole), eq(notifications.targetRole, role))!,
  ]
  const organizationId = Number((session?.user as any)?.organizationId)
  const branchId = Number((session?.user as any)?.branchId)

  if (role !== "SUPER_ADMIN") {
    if (!Number.isInteger(organizationId) || organizationId <= 0) return null
    conditions.push(eq(notifications.organizationId, organizationId))
  }
  if (role === "BRANCH_ADMIN" || role === "ORDER_PORTAL") {
    if (!Number.isInteger(branchId) || branchId <= 0) return null
    conditions.push(eq(notifications.branchId, branchId))
  }

  return conditions
}

function notificationTitle(type: string) {
  switch (type) {
    case "ORDER_CREATED":
      return "New order awaiting approval"
    case "ORDER_APPROVED":
      return "Order approved"
    case "ORDER_APPROVED_ADMIN":
      return "Order approved and ready for review"
    case "ORDER_REJECTED":
      return "Order rejected"
    case "ORDER_RETURNED":
      return "Order returned for correction"
    case "ORDER_RESUBMITTED":
      return "Corrected order awaiting approval"
    case "ORDER_RESUBMITTED_BY_COLLEAGUE":
      return "Order resubmitted by a colleague"
    case "REFUND_REQUESTED":
      return "Refund request submitted"
    case "SUPPORT_THREAD_OPENED":
      return "New support request"
    case "SUPPORT_MESSAGE_RECEIVED":
      return "New reply on a support request"
    case "SUPPORT_THREAD_RESOLVED":
      return "Support request resolved"
    case "SUPPORT_THREAD_CLOSED":
      return "Support request closed"
    default:
      return "Notification"
  }
}

function notificationSeverity(type: string): "info" | "warning" | "critical" {
  switch (type) {
    case "ORDER_CREATED":
    case "ORDER_APPROVED_ADMIN":
    case "ORDER_REJECTED":
    case "ORDER_RETURNED":
    case "ORDER_RESUBMITTED":
    case "REFUND_REQUESTED":
    case "SUPPORT_THREAD_OPENED":
    case "SUPPORT_MESSAGE_RECEIVED":
      return "warning"
    default:
      return "info"
  }
}

type NotificationCta = { label: string; href: string } | undefined

/** "Review order" for someone who may still decide it. */
function reviewOrderCta(orderId: number | null, allowed: boolean): NotificationCta {
  return orderId && allowed ? { label: "Review order", href: `/orders/${orderId}` } : undefined
}

/** The requester's own order list, in whichever portal it uses. */
function requesterOrdersCta(role: string | undefined): NotificationCta {
  if (role === "ORDER_PORTAL") return { label: "View my orders", href: "/shop" }
  if (role === "GROUP_ORDER_PORTAL") return { label: "Open my orders", href: "/group-portal" }
  return undefined
}

function notificationCta(
  type: string,
  orderId: number | null,
  role: string | undefined,
  canDecideOrders: boolean,
  supportThreadId: number | null,
): NotificationCta {
  // The support area is shared by every role, and the endpoints behind it
  // decide what each caller may read, so the link needs no role gate here.
  if (type.startsWith("SUPPORT_")) {
    return supportThreadId
      ? { label: "Open the request", href: `/support/${supportThreadId}` }
      : { label: "Open support", href: "/support" }
  }

  switch (type) {
    case "ORDER_CREATED":
    case "ORDER_RESUBMITTED":
      return reviewOrderCta(orderId, canDecideOrders)
    case "ORDER_APPROVED":
    case "ORDER_REJECTED":
      return role === "ORDER_PORTAL" ? requesterOrdersCta(role) : undefined
    case "ORDER_RETURNED":
    case "ORDER_RESUBMITTED_BY_COLLEAGUE":
      return requesterOrdersCta(role)
    case "ORDER_APPROVED_ADMIN":
      return reviewOrderCta(orderId, role === "SUPER_ADMIN")
    case "REFUND_REQUESTED":
      return { label: "Review refund", href: "/refunds" }
    default:
      return undefined
  }
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = getSessionUserId(session)
    if (!userId) {
      return NextResponse.json({ items: [] })
    }
    const scopeConditions = scopedNotificationConditions(session, userId)
    if (!scopeConditions) return NextResponse.json({ items: [] })
    const role = (session.user as any)?.role
    const organizationId = Number((session.user as any)?.organizationId)
    const branchId = Number((session.user as any)?.branchId)
    const capabilities = await getOrderDecisionCapabilities({
      role,
      userId,
      organizationId: Number.isInteger(organizationId) && organizationId > 0 ? organizationId : null,
      branchId: Number.isInteger(branchId) && branchId > 0 ? branchId : null,
    })
    if (!capabilities.canApproveOrders) {
      // "Awaiting your approval" is only true for someone who may still decide.
      scopeConditions.push(notInArray(notifications.type, ["ORDER_CREATED", "ORDER_RESUBMITTED"]))
    }

    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        message: notifications.message,
        organizationId: notifications.organizationId,
        branchId: notifications.branchId,
        orderId: notifications.orderId,
        supportThreadId: notifications.supportThreadId,
        targetRole: notifications.targetRole,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(and(...scopeConditions))
      .orderBy(desc(notifications.createdAt))
      .limit(25)

    return NextResponse.json({
      items: rows.map((notification) => ({
        id: `db-${notification.id}`,
        type: notification.type,
        title: notificationTitle(notification.type),
        message: notification.message,
        severity: notificationSeverity(notification.type),
        cta: notificationCta(
          notification.type,
          notification.orderId,
          role,
          capabilities.canApproveOrders,
          notification.supportThreadId,
        ),
        tag: notification.type.toLowerCase().replace(/_/g, "-"),
        createdAt: notification.createdAt,
        organizationId: notification.organizationId,
        branchId: notification.branchId,
        orderId: notification.orderId,
        supportThreadId: notification.supportThreadId,
        targetRole: notification.targetRole,
      })),
    })
  } catch (error) {
    console.error("[Notifications] Failed to fetch notifications:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = getSessionUserId(session)
    if (!userId) {
      return NextResponse.json({ updated: 0 })
    }
    const scopeConditions = scopedNotificationConditions(session, userId)
    if (!scopeConditions) return NextResponse.json({ updated: 0 })

    const body = await req.json().catch(() => ({}))
    if (body?.action !== "mark-all-read") {
      return NextResponse.json({ error: "Unsupported notification action" }, { status: 400 })
    }

    const updated = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(...scopeConditions))
      .returning({ id: notifications.id })

    return NextResponse.json({ updated: updated.length })
  } catch (error) {
    console.error("[Notifications] Failed to update notifications:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
