import { NextRequest } from "next/server"
import { z } from "zod"
import { withRateLimit } from "@/lib/rate-limiter"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { requireRiderSession } from "@/lib/server/rider-auth"
import {
  findRiderAssignmentByOrderRef,
  toMobileOrder,
  verifyRiderFulfillmentToken,
} from "@/lib/server/rider-assignments"

const bodySchema = z.object({ token: z.string().trim().min(4).max(32) }).strict()

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ orderId: string }> },
) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)

    const limited = await withRateLimit("sensitive", session.userId)
    if (limited) return riderFail("RATE_LIMITED", "Too many attempts", 429)

    const parsed = bodySchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return riderFail("VALIDATION_ERROR", "token is required", 400)
    }

    const { orderId } = await props.params
    const result = await verifyRiderFulfillmentToken({
      riderUserId: session.userId,
      orderRef: orderId,
      token: parsed.data.token,
    })

    if (result.kind === "not_found") return riderFail("NOT_FOUND", "Order not found", 404)
    if (result.kind === "conflict") {
      return riderFail("CONFLICT", `Cannot verify token in status ${result.status}`, 409)
    }
    if (result.kind === "not_delivered") {
      return riderFail("CONFLICT", "Order must be delivered before fulfilment", 409)
    }
    if (result.kind === "no_token" || result.kind === "invalid_token") {
      return riderFail("FORBIDDEN", "Invalid fulfilment token", 403)
    }
    if (result.kind === "fulfill_failed") {
      return riderFail("CONFLICT", "Fulfilment could not be completed", 409)
    }

    const row = await findRiderAssignmentByOrderRef(session.userId, orderId)
    return riderOk({ order: row ? await toMobileOrder(row as any) : null, fulfilled: true })
  } catch (error) {
    console.error("[rider/orders/:id/fulfillment-token]", error)
    return riderFail("INTERNAL_ERROR", "Failed to verify token", 500)
  }
}
