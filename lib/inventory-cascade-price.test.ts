import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { cascadeGlobalProductFieldUpdate } from "@/lib/inventory-cascade"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * A stand-in for the database that records what would have been written.
 *
 * `cascadeGlobalProductFieldUpdate` takes its client as an argument, so the
 * cascade can be run for real and inspected without a Postgres — what matters
 * is which columns it decides to clear.
 */
function recordingDatabase() {
  const updates: Array<Record<string, unknown>> = []
  const inserts: Array<Record<string, unknown>> = []

  const database = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values)
        return {
          where: () => ({ returning: async () => [] }),
        }
      },
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        inserts.push(values)
      },
    }),
  }

  /** The override columns the cascade decided to null out. */
  const clearedFields = () => updates.flatMap((values) =>
    Object.keys(values).filter((key) => key !== "updatedAt" && values[key] === null))

  return { database, updates, inserts, clearedFields }
}

describe("a global price change never reaches an organization or group price", () => {
  it("ignores a basePrice change entirely", async () => {
    const { database, updates, inserts, clearedFields } = recordingDatabase()

    const result = await cascadeGlobalProductFieldUpdate(
      42,
      [{ field: "basePrice", oldValue: 10_000, newValue: 12_000 }],
      "user-1",
      database,
    )

    // An organization that had priced this product at exactly the old global
    // price used to have that price deleted here. Nothing is written now.
    expect(updates).toEqual([])
    expect(inserts).toEqual([])
    expect(clearedFields()).toEqual([])
    expect(result.updatedCount).toBe(0)
  })

  it("never clears customPrice, whatever else is changing alongside it", async () => {
    const { database, clearedFields } = recordingDatabase()

    await cascadeGlobalProductFieldUpdate(
      42,
      [
        { field: "name", oldValue: "Old name", newValue: "New name" },
        { field: "basePrice", oldValue: 10_000, newValue: 12_000 },
      ],
      "user-1",
      database,
    )

    expect(clearedFields()).toEqual(["customName"])
    expect(clearedFields()).not.toContain("customPrice")
  })

  it("still cascades the descriptive fields it always did", async () => {
    const { database, clearedFields } = recordingDatabase()

    await cascadeGlobalProductFieldUpdate(
      42,
      [
        { field: "name", oldValue: "Old name", newValue: "New name" },
        { field: "description", oldValue: "Old", newValue: "New" },
        { field: "imageUrl", oldValue: "/old.png", newValue: "/new.png" },
      ],
      "user-1",
      database,
    )

    // Unchanged behaviour: only pricing was in question.
    expect(clearedFields()).toEqual(["customName", "customDescription", "customImageUrl"])
  })

  it("does nothing at all for an empty change set", async () => {
    const { database, updates } = recordingDatabase()
    const result = await cascadeGlobalProductFieldUpdate(42, [], "user-1", database)

    expect(updates).toEqual([])
    expect(result.updatedCount).toBe(0)
  })
})

describe("no path deletes a price to make it match the tier above", () => {
  it("keeps basePrice out of the cascadable field list", () => {
    const cascade = source("lib/inventory-cascade.ts")
    expect(cascade).toContain("const CASCADABLE_GLOBAL_FIELDS = {")
    // The mapping is what decides which override gets nulled; a price entry
    // here is what previously deleted organization prices.
    const mapping = cascade.slice(
      cascade.indexOf("const CASCADABLE_GLOBAL_FIELDS = {"),
      cascade.indexOf("} as const", cascade.indexOf("const CASCADABLE_GLOBAL_FIELDS = {")),
    )
    expect(mapping).not.toContain("customPrice")
    expect(mapping).not.toContain("basePrice")
  })

  it("no longer clears organization prices from the cleanup endpoint", () => {
    const cleanup = source("app/api/v1/admin/cleanup-inventory/route.ts")
    expect(cleanup).not.toContain("customPrice: null")
    // The maintenance tool kept its descriptive cleanup.
    expect(cleanup).toContain("customName: null")
  })

  it("leaves group prices untouched by every global and organization cascade", () => {
    // Group prices are written from exactly two places, and neither is a
    // cascade: the group pricing endpoint, and the propagation an
    // administrator explicitly chose when changing an organization price.
    const cascade = source("lib/inventory-cascade.ts")
    expect(cascade).not.toContain("groupInventoryPrices")
  })
})
