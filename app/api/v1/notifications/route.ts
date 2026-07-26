import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { and, desc, eq, isNull } from "drizzle-orm"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { notifications } from "@/db/schema"

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function getSessionUserId(session: any) {
  const userId = (session?.user as any)?.id
  return typeof userId === "string" && uuidPattern.test(userId) ? userId : null
}

function notificationTitle(type: string) {
  switch (type) {
    case "REFUND_REQUESTED":
      return "Refund request submitted"
    default:
      return "Notification"
  }
}

function notificationSeverity(type: string): "info" | "warning" | "critical" {
  switch (type) {
    case "REFUND_REQUESTED":
      return "warning"
    default:
      return "info"
  }
}

function notificationCta(type: string) {
  switch (type) {
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

    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        message: notifications.message,
        organizationId: notifications.organizationId,
        branchId: notifications.branchId,
        targetRole: notifications.targetRole,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .orderBy(desc(notifications.createdAt))
      .limit(25)

    return NextResponse.json({
      items: rows.map((notification) => ({
        id: `db-${notification.id}`,
        type: notification.type,
        title: notificationTitle(notification.type),
        message: notification.message,
        severity: notificationSeverity(notification.type),
        cta: notificationCta(notification.type),
        tag: notification.type.toLowerCase().replace(/_/g, "-"),
        createdAt: notification.createdAt,
        organizationId: notification.organizationId,
        branchId: notification.branchId,
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

    const body = await req.json().catch(() => ({}))
    if (body?.action !== "mark-all-read") {
      return NextResponse.json({ error: "Unsupported notification action" }, { status: 400 })
    }

    const updated = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id })

    return NextResponse.json({ updated: updated.length })
  } catch (error) {
    console.error("[Notifications] Failed to update notifications:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
