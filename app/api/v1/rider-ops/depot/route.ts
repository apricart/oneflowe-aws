import { eq } from "drizzle-orm"
import { z } from "zod"
import { riderDepots } from "@/db/schema"
import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders } from "@/lib/rider-access"
import { isValidLatLng } from "@/lib/rider/assignment-status"

const putSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    latitude: z.number(),
    longitude: z.number(),
    address: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()

export async function GET() {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const ownerId = user.role === "SUPER_ADMIN" ? user.id : user.id
    const [depot] = await db
      .select()
      .from(riderDepots)
      .where(eq(riderDepots.warehouseUserId, ownerId))
      .limit(1)

    return ok({ depot: depot ?? null })
  } catch (err) {
    console.error("[rider-ops/depot GET]", err)
    return error("Failed to load depot", 500)
  }
}

export async function PUT(req: Request) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const limited = await withRateLimit("write", user.id)
    if (limited) return limited

    const parsed = putSchema.safeParse(await readJson(req))
    if (!parsed.success) return error("Invalid body", 400)
    if (!isValidLatLng(parsed.data.latitude, parsed.data.longitude)) {
      return error("Invalid coordinates", 400)
    }

    const [existing] = await db
      .select({ id: riderDepots.id })
      .from(riderDepots)
      .where(eq(riderDepots.warehouseUserId, user.id))
      .limit(1)

    if (existing) {
      await db
        .update(riderDepots)
        .set({
          name: parsed.data.name ?? "Warehouse",
          latitude: parsed.data.latitude,
          longitude: parsed.data.longitude,
          address: parsed.data.address ?? null,
          updatedAt: new Date(),
        })
        .where(eq(riderDepots.id, existing.id))
    } else {
      await db.insert(riderDepots).values({
        warehouseUserId: user.id,
        name: parsed.data.name ?? "Warehouse",
        latitude: parsed.data.latitude,
        longitude: parsed.data.longitude,
        address: parsed.data.address ?? null,
      })
    }

    const [depot] = await db
      .select()
      .from(riderDepots)
      .where(eq(riderDepots.warehouseUserId, user.id))
      .limit(1)

    return ok({ depot })
  } catch (err) {
    console.error("[rider-ops/depot PUT]", err)
    return error("Failed to save depot", 500)
  }
}
