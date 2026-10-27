import "server-only"

import { eq } from "drizzle-orm"
import { riderDepots } from "@/db/schema"
import { knownDepotForCity } from "@/lib/rider/city-depots"
import type { db as DbType } from "@/lib/db"

type Tx = Parameters<Parameters<typeof DbType.transaction>[0]>[0]

/**
 * Ensure this warehouse owns the city depot (route start pin).
 * Rule: one warehouse per city; one depot row per warehouse.
 */
export async function ensureCityDepotForWarehouse(
  tx: Tx,
  input: {
    warehouseUserId: string
    cityKey: string
    cityLabel: string
  },
): Promise<
  | { kind: "ok"; depotId: number }
  | { kind: "city_taken" }
  | { kind: "warehouse_other_city"; cityLabel: string }
  | { kind: "no_coords" }
> {
  const [byCity] = await tx
    .select({
      id: riderDepots.id,
      warehouseUserId: riderDepots.warehouseUserId,
    })
    .from(riderDepots)
    .where(eq(riderDepots.cityKey, input.cityKey))
    .limit(1)

  if (byCity && byCity.warehouseUserId !== input.warehouseUserId) {
    return { kind: "city_taken" }
  }
  if (byCity) return { kind: "ok", depotId: byCity.id }

  const [mine] = await tx
    .select({
      id: riderDepots.id,
      cityKey: riderDepots.cityKey,
      cityLabel: riderDepots.cityLabel,
    })
    .from(riderDepots)
    .where(eq(riderDepots.warehouseUserId, input.warehouseUserId))
    .limit(1)

  const known = knownDepotForCity(input.cityKey)

  if (mine) {
    if (mine.cityKey && mine.cityKey !== input.cityKey) {
      return { kind: "warehouse_other_city", cityLabel: mine.cityLabel ?? mine.cityKey }
    }
    await tx
      .update(riderDepots)
      .set({
        cityKey: input.cityKey,
        cityLabel: input.cityLabel,
        ...(known
          ? {
              name: known.name,
              latitude: known.latitude,
              longitude: known.longitude,
              address: known.address,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(riderDepots.id, mine.id))
    return { kind: "ok", depotId: mine.id }
  }

  if (!known) return { kind: "no_coords" }

  const [created] = await tx
    .insert(riderDepots)
    .values({
      warehouseUserId: input.warehouseUserId,
      name: known.name,
      latitude: known.latitude,
      longitude: known.longitude,
      address: known.address,
      cityKey: input.cityKey,
      cityLabel: input.cityLabel,
    })
    .returning({ id: riderDepots.id })

  return { kind: "ok", depotId: created.id }
}
