import "server-only"

import { and, eq, isNull } from "drizzle-orm"
import { notifications, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import { loadWarehouseReach } from "@/lib/server/warehouse-scope"

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Notify warehouse users whose reach includes the order's branch that a rider
 * submitted proof of delivery. Reuses the notifications table; warehouse bell
 * already lists WAREHOUSE_* types.
 */
export async function queueRiderPodSubmittedNotifications(
  tx: Tx | typeof db,
  input: {
    orderId: number
    orderTid: string
    branchId: number
    organizationId: number | null
    assignmentId: number
    riderUserId: string
  },
) {
  const [role] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, "WAREHOUSE"))
    .limit(1)
  if (!role) return

  const warehouseUsers = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.roleId, role.id), eq(users.isActive, true), isNull(users.deletedAt)))

  for (const wh of warehouseUsers) {
    const reach = await loadWarehouseReach(tx, wh.id)
    if (!reach.includes(input.branchId)) continue

    const eventKey = `WAREHOUSE_RIDER_POD_SUBMITTED:${input.assignmentId}:${wh.id}`
    await tx
      .insert(notifications)
      .values({
        userId: wh.id,
        type: "WAREHOUSE_RIDER_POD_SUBMITTED",
        targetRole: "WAREHOUSE",
        organizationId: input.organizationId,
        branchId: input.branchId,
        orderId: input.orderId,
        eventKey,
        message: `Rider submitted proof of delivery for order ${input.orderTid}`,
      })
      .onConflictDoNothing()
  }
}
