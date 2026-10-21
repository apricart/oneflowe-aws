import { NextRequest } from "next/server"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { requireRiderSession } from "@/lib/server/rider-auth"
import { getRiderRoute } from "@/lib/server/rider-assignments"

export async function GET(req: NextRequest) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)
    const route = await getRiderRoute(session.userId)
    return riderOk(route)
  } catch (error) {
    console.error("[rider/route]", error)
    return riderFail("INTERNAL_ERROR", "Failed to load route", 500)
  }
}
