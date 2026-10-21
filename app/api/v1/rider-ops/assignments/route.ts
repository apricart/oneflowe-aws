import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"
import { orders, riderOrderAssignments, riderProfiles } from "@/db/schema"
import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders } from "@/lib/rider-access"
import { createAssignments } from "@/lib/server/rider-assignments"

const assignSchema = z
  .object({
    riderId: z.string().uuid(),
    orders: z
      .array(
        z
          .object({
            orderId: z.number().int().positive(),
            deliverySequence: z.number().int().positive(),
            deliveryLat: z.number(),
            deliveryLng: z.number(),
            deliveryAddressText: z.string().trim().max(1000).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
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

    const conditions = []
    if (riderId) conditions.push(eq(riderOrderAssignments.riderUserId, riderId))
    if (status) conditions.push(eq(riderOrderAssignments.status, status))

    const rows = await db
      .select({
        assignment: riderOrderAssignments,
        orderTid: orders.tid,
        orderStatus: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        riderCode: riderProfiles.code,
      })
      .from(riderOrderAssignments)
      .innerJoin(orders, eq(orders.id, riderOrderAssignments.orderId))
      .innerJoin(riderProfiles, eq(riderProfiles.userId, riderOrderAssignments.riderUserId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(riderOrderAssignments.deliverySequence))
    return ok({ items: rows })
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

    const parsed = assignSchema.safeParse(await readJson(req))
    if (!parsed.success) return error("Invalid body", 400)

    const result = await createAssignments({
      actorUserId: user.id,
      actorRole: user.role,
      riderUserId: parsed.data.riderId,
      items: parsed.data.orders.map((o) => ({
        orderId: o.orderId,
        deliverySequence: o.deliverySequence,
        deliveryLat: o.deliveryLat,
        deliveryLng: o.deliveryLng,
        deliveryAddressText: o.deliveryAddressText,
      })),
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
