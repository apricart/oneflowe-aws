import { NextRequest } from "next/server"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { requireRiderSession } from "@/lib/server/rider-auth"
import { listRiderAssignments, toMobileOrder } from "@/lib/server/rider-assignments"

export async function GET(req: NextRequest) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)

    const rows = await listRiderAssignments(session.userId)
    const items = []
    for (const row of rows) {
      items.push(await toMobileOrder(row as any))
    }
    return riderOk({ items })
  } catch (error) {
    console.error("[rider/orders]", error)
    return riderFail("INTERNAL_ERROR", "Failed to load orders", 500)
  }
}
