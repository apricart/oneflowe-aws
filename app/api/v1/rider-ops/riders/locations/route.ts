import { and, asc, eq, isNull } from "drizzle-orm"
import { branches, orders, organizations, riderOrderAssignments, riderProfiles, users } from "@/db/schema"
import { error, ok, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { canManageRiders } from "@/lib/rider-access"
import { includeOnTodayRoute, isAssignmentDelivered, isAssignmentOverdue } from "@/lib/rider/same-day"
import { getRiderLocations } from "@/lib/server/rider-location"

/**
 * Live locations for this warehouse's riders + today's planned stops
 * (for the Track map). WAREHOUSE / SUPER_ADMIN only.
 */
export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE", "SUPER_ADMIN"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const url = new URL(req.url)
    const riderId = url.searchParams.get("riderId")

    const riderConditions = [isNull(users.deletedAt)]
    if (user.role === "WAREHOUSE") {
      riderConditions.push(eq(riderProfiles.warehouseUserId, user.id))
    }
    if (riderId) {
      riderConditions.push(eq(riderProfiles.userId, riderId))
    }

    const riders = await db
      .select({
        userId: riderProfiles.userId,
        code: riderProfiles.code,
        fullName: users.fullName,
        isOnDuty: riderProfiles.isOnDuty,
      })
      .from(riderProfiles)
      .innerJoin(users, eq(users.id, riderProfiles.userId))
      .where(and(...riderConditions))

    const locations = await getRiderLocations(riders.map((r) => r.userId))
    const byId = new Map(locations.map((l) => [l.riderUserId, l]))

    const now = new Date()
    const items = []

    for (const rider of riders) {
      const assignmentRows = await db
        .select({
          assignment: riderOrderAssignments,
          orderTid: orders.tid,
          customerName: organizations.name,
          branchName: branches.name,
        })
        .from(riderOrderAssignments)
        .innerJoin(orders, eq(orders.id, riderOrderAssignments.orderId))
        .innerJoin(organizations, eq(organizations.id, orders.organizationId))
        .innerJoin(branches, eq(branches.id, orders.branchId))
        .where(eq(riderOrderAssignments.riderUserId, rider.userId))
        .orderBy(asc(riderOrderAssignments.deliverySequence))

      const stops = assignmentRows
        .filter((row) =>
          includeOnTodayRoute(row.assignment.assignedAt, row.assignment.status, now),
        )
        .map((row) => ({
          assignmentId: row.assignment.id,
          sequence: row.assignment.deliverySequence,
          orderTid: row.orderTid,
          customerName: row.customerName,
          branchName: row.branchName,
          latitude: row.assignment.deliveryLat,
          longitude: row.assignment.deliveryLng,
          address: row.assignment.deliveryAddressText,
          status: row.assignment.status,
          delivered: isAssignmentDelivered(row.assignment.status),
          overdue: isAssignmentOverdue(row.assignment.assignedAt, row.assignment.status, now),
        }))

      items.push({
        riderId: rider.userId,
        code: rider.code,
        fullName: rider.fullName,
        isOnDuty: rider.isOnDuty,
        location: byId.get(rider.userId) ?? null,
        stops,
      })
    }

    return ok({ items })
  } catch (err) {
    console.error("[rider-ops/riders/locations]", err)
    return error("Failed to load rider locations", 500)
  }
}
