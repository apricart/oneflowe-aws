import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { and, desc, eq, isNull, or, type SQL } from "drizzle-orm"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { notifications } from "@/db/schema"

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function getSessionUserId(session: any) {
  const userId = (session?.user as any)?.id
  return typeof userId === "string" && uuidPattern.test(userId) ? userId : null
}

function scopedNotificationConditions(session: any, userId: string): SQL[] | null {
  const role = (session?.user as any)?.role
  if (!["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL"].includes(role)) return null

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
      return "Order approved by Branch Admin"
    case "ORDER_REJECTED":
      return "Order rejected"
    case "REFUND_REQUESTED":
      return "Refund request submitted"
    default:
      return "Notification"
  }
}

function notificationSeverity(type: string): "info" | "warning" | "critical" {
  switch (type) {
    case "ORDER_CREATED":
    case "ORDER_APPROVED_ADMIN":
    case "ORDER_REJECTED":
    case "REFUND_REQUESTED":
      return "warning"
    default:
      return "info"
  }
}

function notificationCta(type: string, orderId: number | null, role: string | undefined) {
  switch (type) {
    case "ORDER_CREATED":
      return orderId && role === "BRANCH_ADMIN"
        ? { label: "Review order", href: `/orders/${orderId}` }
        : undefined
    case "ORDER_APPROVED":
    case "ORDER_REJECTED":
      return role === "ORDER_PORTAL" ? { label: "View my orders", href: "/shop" } : undefined
    case "ORDER_APPROVED_ADMIN":
      return orderId && role === "SUPER_ADMIN"
        ? { label: "Review order", href: `/orders/${orderId}` }
        : undefined
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

    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        message: notifications.message,
        organizationId: notifications.organizationId,
        branchId: notifications.branchId,
        orderId: notifications.orderId,
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
        cta: notificationCta(notification.type, notification.orderId, (session.user as any)?.role),
        tag: notification.type.toLowerCase().replace(/_/g, "-"),
        createdAt: notification.createdAt,
        organizationId: notification.organizationId,
        branchId: notification.branchId,
        orderId: notification.orderId,
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
