import { z } from "zod"
import { error, ok, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders } from "@/lib/rider-access"
import { fetchDrivingGeometry, type LatLng } from "@/lib/rider/osrm-route"

/**
 * Server-side OSRM proxy so the warehouse map is not blocked by browser CSP.
 * Query: points=lat,lng;lat,lng;...
 */
export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const limited = await withRateLimit("api", user.id)
    if (limited) return limited

    const raw = new URL(req.url).searchParams.get("points") ?? ""
    const parts = raw.split(";").filter(Boolean)
    if (parts.length < 2 || parts.length > 25) {
      return error("Provide 2–25 points as lat,lng;lat,lng;…", 400)
    }

    const waypoints: LatLng[] = []
    for (const part of parts) {
      const [latRaw, lngRaw] = part.split(",")
      const latitude = Number(latRaw)
      const longitude = Number(lngRaw)
      const point = z
        .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
        .safeParse({ latitude, longitude })
      if (!point.success) return error("Invalid point", 400)
      waypoints.push(point.data)
    }

    const geometry = await fetchDrivingGeometry(waypoints)
    if (!geometry?.length) {
      return ok({ geometry: null, mode: "unavailable" as const })
    }
    return ok({ geometry, mode: "road" as const })
  } catch (err) {
    console.error("[rider-ops/route-geometry]", err)
    return error("Failed to load route geometry", 500)
  }
}
