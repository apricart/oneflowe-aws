import { z } from "zod"
import { error, ok, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders } from "@/lib/rider-access"

type NominatimHit = {
  display_name?: string
  lat?: string
  lon?: string
}

/**
 * Location search for Plan route pin placement (Nominatim, server-side).
 * Query: q=<search text>
 */
export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const limited = await withRateLimit("search", user.id)
    if (limited) return limited

    const q = (new URL(req.url).searchParams.get("q") ?? "").trim()
    if (q.length < 2) return error("Enter at least 2 characters", 400)
    if (q.length > 200) return error("Search too long", 400)

    const url = new URL("https://nominatim.openstreetmap.org/search")
    url.searchParams.set("format", "json")
    url.searchParams.set("limit", "6")
    url.searchParams.set("q", q)
    // Bias toward Pakistan / Karachi deliveries
    url.searchParams.set("countrycodes", "pk")
    url.searchParams.set("addressdetails", "0")

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "OneFloweWarehouseRoutePlanner/1.0",
      },
      next: { revalidate: 0 },
    })
    if (!response.ok) return error("Geocoder unavailable", 502)

    const rows = (await response.json()) as NominatimHit[]
    const items = rows
      .map((row) => {
        const latitude = Number(row.lat)
        const longitude = Number(row.lon)
        const parsed = z
          .object({
            label: z.string().min(1),
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
          })
          .safeParse({
            label: row.display_name ?? "",
            latitude,
            longitude,
          })
        return parsed.success ? parsed.data : null
      })
      .filter((row): row is NonNullable<typeof row> => row != null)

    return ok({ items })
  } catch (err) {
    console.error("[rider-ops/geocode]", err)
    return error("Failed to search location", 500)
  }
}
