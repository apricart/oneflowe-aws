import { isNull } from "drizzle-orm"
import { eq } from "drizzle-orm"
import { riderProfiles, users } from "@/db/schema"
import { error, ok, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { canManageRiders } from "@/lib/rider-access"
import { getRiderLocations } from "@/lib/server/rider-location"

export async function GET() {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const riders = await db
      .select({
        userId: riderProfiles.userId,
        code: riderProfiles.code,
        fullName: users.fullName,
        isOnDuty: riderProfiles.isOnDuty,
      })
      .from(riderProfiles)
      .innerJoin(users, eq(users.id, riderProfiles.userId))
      .where(isNull(users.deletedAt))

    const locations = await getRiderLocations(riders.map((r) => r.userId))
    const byId = new Map(locations.map((l) => [l.riderUserId, l]))

    return ok({
      items: riders.map((r) => ({
        riderId: r.userId,
        code: r.code,
        fullName: r.fullName,
        isOnDuty: r.isOnDuty,
        location: byId.get(r.userId) ?? null,
      })),
    })
  } catch (err) {
    console.error("[rider-ops/riders/locations]", err)
    return error("Failed to load rider locations", 500)
  }
}
