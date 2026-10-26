import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { riderDepots, riderProfiles } from "@/db/schema"
import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders } from "@/lib/rider-access"
import { isValidLatLng } from "@/lib/rider/assignment-status"
import { knownDepotForCity, resolveRiderCity } from "@/lib/rider/city-depots"

const putSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    latitude: z.number(),
    longitude: z.number(),
    address: z.string().trim().max(1000).nullable().optional(),
    city: z.string().trim().min(1).max(120).optional(),
  })
  .strict()

/**
 * Load the warehouse start pin. Prefer ?riderId= (uses the rider's city depot),
 * else ?city=, else the caller's own depot.
 */
export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const url = new URL(req.url)
    const riderId = url.searchParams.get("riderId")
    const cityParam = url.searchParams.get("city")

    if (riderId) {
      const [profile] = await db
        .select({
          cityKey: riderProfiles.cityKey,
          warehouseUserId: riderProfiles.warehouseUserId,
        })
        .from(riderProfiles)
        .where(eq(riderProfiles.userId, riderId))
        .limit(1)
      if (!profile) return error("Rider not found", 404)
      if (user.role === "WAREHOUSE" && profile.warehouseUserId !== user.id) {
        return error("Rider not found", 404)
      }
      if (profile.cityKey) {
        const [depot] = await db
          .select()
          .from(riderDepots)
          .where(eq(riderDepots.cityKey, profile.cityKey))
          .limit(1)
        if (depot) return ok({ depot })
      }
      if (profile.warehouseUserId) {
        const [depot] = await db
          .select()
          .from(riderDepots)
          .where(eq(riderDepots.warehouseUserId, profile.warehouseUserId))
          .limit(1)
        if (depot) return ok({ depot })
      }
      return ok({ depot: null })
    }

    if (cityParam) {
      const city = resolveRiderCity(cityParam)
      if (!city) return error("Unknown city", 400)
      const [depot] = await db
        .select()
        .from(riderDepots)
        .where(eq(riderDepots.cityKey, city.cityKey))
        .limit(1)
      return ok({ depot: depot ?? null })
    }

    const [depot] = await db
      .select()
      .from(riderDepots)
      .where(eq(riderDepots.warehouseUserId, user.id))
      .limit(1)

    // Auto-surface the known Karachi pin if this warehouse has none yet.
    if (!depot) {
      const known = knownDepotForCity("karachi")
      return ok({
        depot: known
          ? {
              id: null,
              warehouseUserId: user.id,
              name: known.name,
              latitude: known.latitude,
              longitude: known.longitude,
              address: known.address,
              cityKey: "karachi",
              cityLabel: "Karachi",
            }
          : null,
      })
    }

    return ok({ depot })
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

    const city = parsed.data.city ? resolveRiderCity(parsed.data.city) : null
    if (parsed.data.city && !city) return error("Pick a city from the Pakistan list", 400)

    if (city) {
      const [taken] = await db
        .select({ warehouseUserId: riderDepots.warehouseUserId })
        .from(riderDepots)
        .where(and(eq(riderDepots.cityKey, city.cityKey)))
        .limit(1)
      if (taken && taken.warehouseUserId !== user.id) {
        return error("Another warehouse already serves this city", 409)
      }
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
          ...(city
            ? { cityKey: city.cityKey, cityLabel: city.cityLabel }
            : {}),
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
        cityKey: city?.cityKey ?? null,
        cityLabel: city?.cityLabel ?? null,
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
