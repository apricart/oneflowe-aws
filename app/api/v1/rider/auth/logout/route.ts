import { NextRequest } from "next/server"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { logoutRider, requireRiderSession } from "@/lib/server/rider-auth"

export async function POST(req: NextRequest) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)

    const header = req.headers.get("authorization")
    const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null
    await logoutRider(token)
    return riderOk({ loggedOut: true })
  } catch (error) {
    console.error("[rider/auth/logout]", error)
    return riderFail("INTERNAL_ERROR", "Logout failed", 500)
  }
}
