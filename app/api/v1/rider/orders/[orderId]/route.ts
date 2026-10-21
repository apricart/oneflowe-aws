import { NextRequest } from "next/server"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { requireRiderSession } from "@/lib/server/rider-auth"
import { findRiderAssignmentByOrderRef, toMobileOrder } from "@/lib/server/rider-assignments"

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ orderId: string }> },
) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)

    const { orderId } = await props.params
    const row = await findRiderAssignmentByOrderRef(session.userId, orderId)
    if (!row) return riderFail("NOT_FOUND", "Order not found", 404)

    return riderOk({ order: await toMobileOrder(row as any) })
  } catch (error) {
    console.error("[rider/orders/:id]", error)
    return riderFail("INTERNAL_ERROR", "Failed to load order", 500)
  }
}
