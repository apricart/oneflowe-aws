import { NextResponse } from "next/server"
import { and, desc, eq, inArray, isNull, like } from "drizzle-orm"

import { notifications, orders } from "@/db/schema"
import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { loadWarehouseReach } from "@/lib/server/warehouse-scope"
import {
  toWarehouseNotificationItem,
  WAREHOUSE_NOTIFICATION_LIST_LIMIT,
  WAREHOUSE_NOTIFICATION_ROLE,
  warehouseNotificationActionSchema,
  type WarehouseNotificationItem,
} from "@/lib/warehouse-order-notifications"

export const dynamic = "force-dynamic"

/**
 * The warehouse user's own order-stage notices, for the bell in its workspace.
 * See plans/OF-WAREHOUSE-order-stage-notifications.md.
 *
 * Only this user's rows addressed to the warehouse role, and only for branches
 * it serves **now**: a branch or city withdrawn since takes its notices with
 * it. An empty reach lists nothing.
 */

function ownNotices(userId: string, reach: number[]) {
  return and(
    eq(notifications.userId, userId),
    eq(notifications.targetRole, WAREHOUSE_NOTIFICATION_ROLE),
    like(notifications.type, "WAREHOUSE_ORDER_%"),
    inArray(notifications.branchId, reach),
  )
}

export async function GET() {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const reach = await loadWarehouseReach(db, user.id)
    if (reach.length === 0) {
      return NextResponse.json({ items: [], unreadCount: 0 }, { headers: { "Cache-Control": "private, no-store" } })
    }

    const rows = await db
      .select({
        id: notifications.id,
        type: notifications.type,
        message: notifications.message,
        createdAt: notifications.createdAt,
        readAt: notifications.readAt,
        orderStatus: orders.status,
      })
      .from(notifications)
      .leftJoin(orders, eq(orders.id, notifications.orderId))
      .where(ownNotices(user.id, reach))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(WAREHOUSE_NOTIFICATION_LIST_LIMIT)

    const unread = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(ownNotices(user.id, reach), isNull(notifications.readAt)))
      .limit(WAREHOUSE_NOTIFICATION_LIST_LIMIT + 1)

    const items = rows
      .map(toWarehouseNotificationItem)
      .filter((item): item is WarehouseNotificationItem => item !== null)
    return NextResponse.json(
      { items, unreadCount: unread.length },
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/notifications")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

export async function PATCH(req: Request) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const parsed = warehouseNotificationActionSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return error("action must be \"mark-all-read\"", 400)

    const reach = await loadWarehouseReach(db, user.id)
    if (reach.length === 0) return NextResponse.json({ updated: 0 })

    const updated = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(ownNotices(user.id, reach), isNull(notifications.readAt)))
      .returning({ id: notifications.id })
    return NextResponse.json({ updated: updated.length })
  } catch (caught) {
    const handled = handleError(caught, "PATCH /api/v1/warehouse/notifications")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
