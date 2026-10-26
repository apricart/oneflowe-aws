import { NextRequest } from "next/server"
import { riderFail, riderOk } from "@/lib/rider/envelope"
import { isValidLatLng } from "@/lib/rider/assignment-status"
import { requireRiderSession } from "@/lib/server/rider-auth"
import { getRiderRoute } from "@/lib/server/rider-assignments"

/**
 * Planned or live route for the rider map.
 *
 * - No query coords → `geometryMode: "planned"` (depot → remaining stops).
 * - `?latitude=&longitude=` (rider GPS) → `geometryMode: "live"`: OSRM from
 *   current location → next undelivered stop(s). Replace the map polyline with
 *   `geometry` on each update so the travelled path disappears.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireRiderSession(req)
    if (!session) return riderFail("UNAUTHORIZED", "Missing or invalid token", 401)

    const url = req.nextUrl
    const latRaw = url.searchParams.get("latitude")
    const lngRaw = url.searchParams.get("longitude")
    let current: { latitude: number; longitude: number } | null = null
    if (latRaw != null && lngRaw != null) {
      const latitude = Number(latRaw)
      const longitude = Number(lngRaw)
      if (!isValidLatLng(latitude, longitude)) {
        return riderFail("VALIDATION_ERROR", "Invalid latitude/longitude", 400)
      }
      current = { latitude, longitude }
    }

    const route = await getRiderRoute(session.userId, null, current)
    return riderOk(route)
  } catch (error) {
    console.error("[rider/route]", error)
    return riderFail("INTERNAL_ERROR", "Failed to load route", 500)
  }
}
