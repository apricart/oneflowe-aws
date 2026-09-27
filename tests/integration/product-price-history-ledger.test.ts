import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { and, asc, eq } from "drizzle-orm"

import {
  globalProducts,
  groupInventoryPrices,
  organizationInventory,
  productPriceHistory,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"

import {
  BASE_PRICE_CENTS,
  NO_DATABASE_REASON,
  createPricingFixtures,
  destroyPricingFixtures,
  hasTestDatabase,
  resetPriceTiers,
  setGroupPrice,
  type PricingFixtures,
} from "./helpers/pricing-fixtures"

describe.skipIf(!hasTestDatabase)("product price history ledger triggers", () => {
  let fixtures: PricingFixtures

  beforeAll(async () => {
    fixtures = await createPricingFixtures()
  })

  beforeEach(async () => {
    await resetPriceTiers(fixtures)
    await db.update(globalProducts)
      .set({ basePrice: BASE_PRICE_CENTS })
      .where(eq(globalProducts.id, fixtures.globalProductId))
    await db.delete(productPriceHistory)
      .where(eq(productPriceHistory.globalProductId, fixtures.globalProductId))
  })

  afterAll(async () => {
    if (fixtures) await destroyPricingFixtures(fixtures)
    await closePool()
  })

  it("records a global change and tenant-scoped inherited changes exactly once", async () => {
    await db.update(globalProducts)
      .set({ basePrice: 12_000 })
      .where(eq(globalProducts.id, fixtures.globalProductId))
    // Re-saving the same price must not manufacture another event.
    await db.update(globalProducts)
      .set({ basePrice: 12_000 })
      .where(eq(globalProducts.id, fixtures.globalProductId))

    const rows = await db.select().from(productPriceHistory)
      .where(eq(productPriceHistory.globalProductId, fixtures.globalProductId))
      .orderBy(asc(productPriceHistory.id))

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      organizationId: null,
      scope: "GLOBAL",
      previousPriceCents: 10_000,
      priceCents: 12_000,
      changeType: "PRICE_CHANGED",
    })
    expect(rows.slice(1).map((row) => row.organizationId).sort((a, b) => Number(a) - Number(b))).toEqual([
      fixtures.organizationId,
      fixtures.neighbourOrganizationId,
    ].sort((a, b) => a - b))
    expect(rows.slice(1).every((row) => (
      row.scope === "ORGANIZATION"
      && row.previousPriceCents === 10_000
      && row.priceCents === 12_000
      && row.changeType === "INHERITED_GLOBAL_CHANGED"
    ))).toBe(true)
  })

  it("records organization override set, change, and removal as effective prices", async () => {
    await db.update(organizationInventory)
      .set({ customPrice: 8_000 })
      .where(eq(organizationInventory.id, fixtures.organizationInventoryId))
    await db.update(organizationInventory)
      .set({ customPrice: 9_000 })
      .where(eq(organizationInventory.id, fixtures.organizationInventoryId))
    await db.update(organizationInventory)
      .set({ customPrice: null })
      .where(eq(organizationInventory.id, fixtures.organizationInventoryId))

    const rows = await db.select().from(productPriceHistory)
      .where(and(
        eq(productPriceHistory.globalProductId, fixtures.globalProductId),
        eq(productPriceHistory.organizationId, fixtures.organizationId),
      ))
      .orderBy(asc(productPriceHistory.id))

    expect(rows.map((row) => [row.previousPriceCents, row.priceCents, row.changeType])).toEqual([
      [10_000, 8_000, "PRICE_CHANGED"],
      [8_000, 9_000, "PRICE_CHANGED"],
      [9_000, 10_000, "OVERRIDE_REMOVED"],
    ])
  })

  it("records group override set, change, and removal against the inherited price", async () => {
    await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 6_000)
    await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 7_000)
    await db.delete(groupInventoryPrices).where(and(
      eq(groupInventoryPrices.groupId, fixtures.groupId),
      eq(groupInventoryPrices.organizationInventoryId, fixtures.organizationInventoryId),
    ))

    const rows = await db.select().from(productPriceHistory)
      .where(and(
        eq(productPriceHistory.globalProductId, fixtures.globalProductId),
        eq(productPriceHistory.groupId, fixtures.groupId),
      ))
      .orderBy(asc(productPriceHistory.id))

    expect(rows.map((row) => [row.previousPriceCents, row.priceCents, row.changeType])).toEqual([
      [10_000, 6_000, "OVERRIDE_SET"],
      [6_000, 7_000, "PRICE_CHANGED"],
      [7_000, 10_000, "OVERRIDE_REMOVED"],
    ])
    expect(rows.every((row) => row.changedByUserId === fixtures.userId)).toBe(true)
  })

  it("rolls the ledger entry back when the price transaction fails", async () => {
    await expect(db.transaction(async (tx) => {
      await tx.update(globalProducts)
        .set({ basePrice: 14_000 })
        .where(eq(globalProducts.id, fixtures.globalProductId))
      throw new Error("force rollback")
    })).rejects.toThrow("force rollback")

    const [product] = await db.select({ basePrice: globalProducts.basePrice })
      .from(globalProducts)
      .where(eq(globalProducts.id, fixtures.globalProductId))
    const rows = await db.select({ id: productPriceHistory.id })
      .from(productPriceHistory)
      .where(eq(productPriceHistory.globalProductId, fixtures.globalProductId))

    expect(product.basePrice).toBe(BASE_PRICE_CENTS)
    expect(rows).toEqual([])
  })
})

describe.skipIf(hasTestDatabase)("product price history ledger integration suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})
