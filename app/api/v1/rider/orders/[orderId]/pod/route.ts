import { NextRequest } from "next/server"
import { withRateLimit } from "@/lib/rate-limiter"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { requireRiderSession } from "@/lib/server/rider-auth"
import {
  findRiderAssignmentByOrderRef,
  submitPod,
  toMobileOrder,
} from "@/lib/server/rider-assignments"

export async function POST(
  req: NextRequest,
  props: { params: Promise<{ orderId: string }> },
) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)

    const limited = await withRateLimit("upload", session.userId)
    if (limited) return riderFail("RATE_LIMITED", "Too many uploads", 429)

    const form = await req.formData().catch(() => null)
    if (!form) return riderFail("VALIDATION_ERROR", "Expected multipart form data", 400)

    const files = form
      .getAll("files")
      .filter((v): v is File => typeof File !== "undefined" && v instanceof File)

    const { orderId } = await props.params
    const result = await submitPod({
      riderUserId: session.userId,
      orderRef: orderId,
      files,
    })

    if (result.kind === "not_found") return riderFail("NOT_FOUND", "Order not found", 404)
    if (result.kind === "conflict") {
      return riderFail("CONFLICT", `Cannot submit POD from ${result.status}`, 409)
    }
    if (result.kind === "validation") {
      return riderFail("VALIDATION_ERROR", result.message, 400)
    }
    if (result.kind === "storage") {
      return riderFail("INTERNAL_ERROR", "Image storage is not configured", 503)
    }

    const row = await findRiderAssignmentByOrderRef(session.userId, orderId)
    return riderOk({
      order: row ? await toMobileOrder(row as any) : null,
      storageKeys: result.storageKeys,
    })
  } catch (error) {
    console.error("[rider/orders/:id/pod]", error)
    return riderFail("INTERNAL_ERROR", "Failed to submit proof of delivery", 500)
  }
}
