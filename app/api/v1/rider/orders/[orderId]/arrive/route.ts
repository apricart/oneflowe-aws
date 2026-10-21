import { NextRequest } from "next/server"
import { z } from "zod"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { requireRiderSession } from "@/lib/server/rider-auth"
import { recordArrival } from "@/lib/server/rider-assignments"

const bodySchema = z
  .object({
    latitude: z.number(),
    longitude: z.number(),
  })
  .strict()

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ orderId: string }> },
) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)

    const parsed = bodySchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return riderFail("VALIDATION_ERROR", "latitude and longitude are required", 400)
    }

    const { orderId } = await props.params
    const result = await recordArrival({
      riderUserId: session.userId,
      orderRef: orderId,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
    })
    if (result.kind === "not_found") return riderFail("NOT_FOUND", "Order not found", 404)
    if (result.kind === "invalid") {
      return riderFail("VALIDATION_ERROR", "Invalid coordinates", 400)
    }

    return riderOk({
      arrived: true,
      distanceMeters: result.distanceMeters,
    })
  } catch (error) {
    console.error("[rider/orders/:id/arrive]", error)
    return riderFail("INTERNAL_ERROR", "Failed to record arrival", 500)
  }
}
