import { NextRequest } from "next/server"
import { z } from "zod"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { requireRiderSession } from "@/lib/server/rider-auth"
import {
  findRiderAssignmentByOrderRef,
  startRiderDelivery,
  toMobileOrder,
} from "@/lib/server/rider-assignments"

const bodySchema = z
  .object({ status: z.enum(["picked_up", "in_transit"]) })
  .strict()

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ orderId: string }> },
) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)

    const parsed = bodySchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return riderFail("VALIDATION_ERROR", "status must be picked_up or in_transit", 400)
    }

    const { orderId } = await props.params
    const result = await startRiderDelivery(session.userId, orderId)
    if (result.kind === "not_found") return riderFail("NOT_FOUND", "Order not found", 404)
    if (result.kind === "conflict") {
      return riderFail("CONFLICT", `Cannot advance from ${result.status}`, 409)
    }

    const row = await findRiderAssignmentByOrderRef(session.userId, orderId)
    return riderOk({ order: row ? await toMobileOrder(row as any) : null })
  } catch (error) {
    console.error("[rider/orders/:id/status]", error)
    return riderFail("INTERNAL_ERROR", "Failed to update status", 500)
  }
}
