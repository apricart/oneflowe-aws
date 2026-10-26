import { NextRequest } from "next/server"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { requireRiderSession, toRiderPublic } from "@/lib/server/rider-auth"

export async function GET(req: NextRequest) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)
    return riderOk({ rider: toRiderPublic(session) })
  } catch (error) {
    console.error("[rider/auth/me]", error)
    return riderFail("INTERNAL_ERROR", "Failed to load session", 500)
  }
}
