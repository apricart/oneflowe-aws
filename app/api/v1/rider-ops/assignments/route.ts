import { and, asc, eq, ne, sql } from "drizzle-orm"
import { z } from "zod"
import {
  branches,
  orders,
  organizations,
  riderDepots,
  riderOrderAssignments,
  riderProfiles,
  users,
} from "@/db/schema"
import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders } from "@/lib/rider-access"
import { includeOnTodayRoute, isAssignmentDelivered, isAssignmentOverdue } from "@/lib/rider/same-day"
import { createAssignments } from "@/lib/server/rider-assignments"
import { queueRiderOverdueDeliveryNotifications } from "@/lib/server/rider-notifications"

/** Provisional pin until warehouse sets the real drop on Plan route. */
const PROVISIONAL_LAT = 24.8607
const PROVISIONAL_LNG = 67.0011

const assignOrderSchema = z
  .object({
    orderId: z.coerce.number().int().positive(),
    deliverySequence: z.coerce.number().int().positive().optional(),
    deliveryLat: z.coerce.number().optional(),
    deliveryLng: z.coerce.number().optional(),
    deliveryAddressText: z.union([z.string().trim().max(1000), z.null()]).optional(),
  })
  .strict()

const assignSchema = z
  .object({
    riderId: z.string().uuid(),
    orders: z.array(assignOrderSchema).min(1).max(50),
  })
  .strict()

export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const url = new URL(req.url)
    const riderId = url.searchParams.get("riderId")
    const status = url.searchParams.get("status")
    // day=today → Karachi service day + overdue carry-overs (Plan route / Track).
    const day = url.searchParams.get("day")

    const conditions = []
    if (riderId) conditions.push(eq(riderOrderAssignments.riderUserId, riderId))
    if (status) conditions.push(eq(riderOrderAssignments.status, status))
    // Warehouse sees only assignments for riders it created / owns.
    if (user.role === "WAREHOUSE") {
      conditions.push(eq(riderProfiles.warehouseUserId, user.id))
    }

    const creator = db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .as("assignment_creator")

    const riderUser = db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .as("assignment_rider")

    const rows = await db
      .select({
        assignment: riderOrderAssignments,
        orderTid: orders.tid,
        orderStatus: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        riderCode: riderProfiles.code,
        riderFullName: riderUser.fullName,
        warehouseUserId: riderProfiles.warehouseUserId,
        customerName: organizations.name,
        branchName: branches.name,
        placerName: creator.fullName,
        orderBranchId: orders.branchId,
        orderOrganizationId: orders.organizationId,
      })
      .from(riderOrderAssignments)
      .innerJoin(orders, eq(orders.id, riderOrderAssignments.orderId))
      .innerJoin(organizations, eq(organizations.id, orders.organizationId))
      .innerJoin(branches, eq(branches.id, orders.branchId))
      .innerJoin(riderProfiles, eq(riderProfiles.userId, riderOrderAssignments.riderUserId))
      .innerJoin(riderUser, eq(riderUser.id, riderProfiles.userId))
      .leftJoin(creator, eq(creator.id, orders.createdByUserId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(riderOrderAssignments.deliverySequence))

    const now = new Date()
    const enriched = []
    for (const row of rows) {
      const overdue = isAssignmentOverdue(row.assignment.assignedAt, row.assignment.status, now)
      const delivered = isAssignmentDelivered(row.assignment.status)
      if (day === "today" && !includeOnTodayRoute(row.assignment.assignedAt, row.assignment.status, now)) {
        continue
      }
      if (overdue && row.orderBranchId != null) {
        await queueRiderOverdueDeliveryNotifications(db, {
          orderId: row.assignment.orderId,
          orderTid: row.orderTid,
          branchId: row.orderBranchId,
          organizationId: row.orderOrganizationId,
          assignmentId: row.assignment.id,
          riderUserId: row.assignment.riderUserId,
          riderCode: row.riderCode,
          warehouseUserId: row.warehouseUserId,
          customerName: row.customerName,
        })
      }
      enriched.push({
        assignment: row.assignment,
        orderTid: row.orderTid,
        orderStatus: row.orderStatus,
        fulfillmentStatus: row.fulfillmentStatus,
        riderCode: row.riderCode,
        riderFullName: row.riderFullName,
        customerName: row.customerName,
        branchName: row.branchName,
        placerName: row.placerName,
        overdue,
        delivered,
      })
    }

    return ok({ items: enriched })
  } catch (err) {
    console.error("[rider-ops/assignments GET]", err)
    return error("Failed to list assignments", 500)
  }
}

export async function POST(req: Request) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const limited = await withRateLimit("write", user.id)
    if (limited) return limited

    const raw = await readJson(req)
    const parsed = assignSchema.safeParse(raw)
    if (!parsed.success) {
      console.warn("[rider-ops/assignments POST] invalid body", parsed.error.flatten(), raw)
      return error("Invalid body", 400)
    }

    // Provisional pin = this warehouse's city depot (Karachi pin when set), else Karachi centre.
    const [depot] = await db
      .select({ latitude: riderDepots.latitude, longitude: riderDepots.longitude })
      .from(riderDepots)
      .where(eq(riderDepots.warehouseUserId, user.id))
      .limit(1)
    const fallbackLat = depot?.latitude ?? PROVISIONAL_LAT
    const fallbackLng = depot?.longitude ?? PROVISIONAL_LNG

    // Warehouse may only assign its own riders.
    if (user.role === "WAREHOUSE") {
      const [owned] = await db
        .select({ userId: riderProfiles.userId })
        .from(riderProfiles)
        .where(
          and(
            eq(riderProfiles.userId, parsed.data.riderId),
            eq(riderProfiles.warehouseUserId, user.id),
          ),
        )
        .limit(1)
      if (!owned) return error("Rider not found", 404)
    }

    const [seqRow] = await db
      .select({
        maxSeq: sql<number>`coalesce(max(${riderOrderAssignments.deliverySequence}), 0)`,
      })
      .from(riderOrderAssignments)
      .where(
        and(
          eq(riderOrderAssignments.riderUserId, parsed.data.riderId),
          ne(riderOrderAssignments.status, "FULFILLMENT_COMPLETED"),
        ),
      )
    let nextSeq = Number(seqRow?.maxSeq ?? 0) + 1

    const result = await createAssignments({
      actorUserId: user.id,
      actorRole: user.role,
      riderUserId: parsed.data.riderId,
      items: parsed.data.orders.map((o) => {
        const deliverySequence = o.deliverySequence ?? nextSeq
        if (o.deliverySequence == null) nextSeq += 1
        return {
          orderId: o.orderId,
          deliverySequence,
          deliveryLat: o.deliveryLat ?? fallbackLat,
          deliveryLng: o.deliveryLng ?? fallbackLng,
          deliveryAddressText: o.deliveryAddressText ?? null,
        }
      }),
    })

    if (result.kind === "rider_not_found") return error("Rider not found", 404)
    if (result.kind === "invalid_coords") return error("Invalid delivery coordinates", 400)
    if (result.kind === "order_not_found") return error("Order not found", 404)
    if (result.kind === "already_assigned") {
      return error(`Order ${result.orderId} already has an active rider assignment`, 409)
    }
    if (result.kind === "order_not_eligible") {
      return error(
        `Order ${result.orderId} is not eligible (${result.reason}). Must be APPROVED and OUT_FOR_DELIVERY.`,
        409,
      )
    }

    return ok({ assignmentIds: result.assignmentIds }, { status: 201 })
  } catch (err) {
    console.error("[rider-ops/assignments POST]", err)
    return error("Failed to assign orders", 500)
  }
}
