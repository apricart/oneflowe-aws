import { and, desc, eq, isNull } from "drizzle-orm"
import { NextRequest } from "next/server"
import { notifications } from "@/db/schema"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { db } from "@/lib/db"
import { requireRiderSession } from "@/lib/server/rider-auth"

/** Rider in-app notices (overdue same-day deliveries, etc.). */
export async function GET(req: NextRequest) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)

    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        message: notifications.message,
        orderId: notifications.orderId,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(and(eq(notifications.userId, session.userId), eq(notifications.targetRole, "RIDER")))
      .orderBy(desc(notifications.createdAt))
      .limit(50)

    return riderOk({
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        message: row.message,
        orderId: row.orderId,
        read: row.readAt != null,
        createdAt: row.createdAt?.toISOString?.() ?? null,
      })),
      unreadCount: rows.filter((row) => row.readAt == null).length,
    })
  } catch (error) {
    console.error("[rider/notifications]", error)
    return riderFail("INTERNAL_ERROR", "Failed to load notifications", 500)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)

    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, session.userId),
          eq(notifications.targetRole, "RIDER"),
          isNull(notifications.readAt),
        ),
      )

    return riderOk({ markedRead: true })
  } catch (error) {
    console.error("[rider/notifications PATCH]", error)
    return riderFail("INTERNAL_ERROR", "Failed to mark notifications read", 500)
  }
}
