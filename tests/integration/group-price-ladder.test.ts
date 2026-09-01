import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { and, eq } from "drizzle-orm"

import { branchInventory, branches, globalProducts, groupInventoryPrices, groups, organizationInventory } from "@/db/schema"
import { db, closePool } from "@/lib/db"
import { cascadeGlobalProductFieldUpdate } from "@/lib/inventory-cascade"
import {
  effectivePriceCentsSql,
  groupPriceJoinOn,
  groupPriceJoinOnBranchGroup,
  groupPriceTier,
  loadGroupPriceOverrides,
  resolveBranchGroupId,
  scopedOverrideCentsSql,
} from "@/lib/server/effective-price"

import {
  BASE_PRICE_CENTS,
  NO_DATABASE_REASON,
  createPricingFixtures,
  destroyPricingFixtures,
  hasTestDatabase,
  resetPriceTiers,
  setGroupPrice,
  setOrganizationPrice,
  type PricingFixtures,
} from "./helpers/pricing-fixtures"

/**
 * The price ladder against a real Postgres.
 *
 * The unit tests prove the TypeScript rule; these prove the SQL half agrees
 * with it — the COALESCE ordering, the `ON FALSE` join for a scope with no
 * group, the tenant pinning, and the table's own constraints. Those are exactly
 * the parts a pure unit test cannot reach, and exactly where a wrong price
 * would be charged rather than merely displayed.
 */
describe.skipIf(!hasTestDatabase)("group price ladder in Postgres", () => {
  let fixtures: PricingFixtures

  beforeAll(async () => {
    fixtures = await createPricingFixtures()
  })

  afterEach(async () => {
    await resetPriceTiers(fixtures)
  })

  afterAll(async () => {
    if (fixtures) await destroyPricingFixtures(fixtures)
    await closePool()
  })

  /** The full ladder as a branch-scoped read would resolve it. */
  async function readEffectivePrice(groupId: number | null): Promise<number | null> {
    const [row] = await db
      .select({ priceCents: effectivePriceCentsSql().mapWith(Number) })
      .from(organizationInventory)
      .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
      .leftJoin(groupPriceTier, groupPriceJoinOn({
        organizationId: fixtures.organizationId,
        groupId,
      }))
      .where(eq(organizationInventory.id, fixtures.organizationInventoryId))
      .limit(1)
    return row?.priceCents ?? null
  }

  /** The override tier only, as the branch-scoped listings expose `customPrice`. */
  async function readScopedOverride(groupId: number | null): Promise<number | null> {
    const [row] = await db
      .select({ customPrice: scopedOverrideCentsSql() })
      .from(organizationInventory)
      .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
      .leftJoin(groupPriceTier, groupPriceJoinOn({
        organizationId: fixtures.organizationId,
        groupId,
      }))
      .where(eq(organizationInventory.id, fixtures.organizationInventoryId))
      .limit(1)
    return row?.customPrice === null || row?.customPrice === undefined ? null : Number(row.customPrice)
  }

  it("falls through to the global base price when no override exists", async () => {
    expect(await readEffectivePrice(fixtures.groupId)).toBe(BASE_PRICE_CENTS)
    // No tenant set a price, so the listings must report no override at all
    // rather than echoing the base price back as one.
    expect(await readScopedOverride(fixtures.groupId)).toBeNull()
  })

  it("prefers the organization override over the base price", async () => {
    await setOrganizationPrice(fixtures, 8_000)

    expect(await readEffectivePrice(fixtures.groupId)).toBe(8_000)
    expect(await readScopedOverride(fixtures.groupId)).toBe(8_000)
  })

  it("prefers the group override over the organization price", async () => {
    await setOrganizationPrice(fixtures, 8_000)
    await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 6_500)

    expect(await readEffectivePrice(fixtures.groupId)).toBe(6_500)
    expect(await readScopedOverride(fixtures.groupId)).toBe(6_500)
  })

  it("leaves the organization price untouched when a group price is set", async () => {
    await setOrganizationPrice(fixtures, 8_000)
    await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 6_500)

    const [item] = await db
      .select({ customPrice: organizationInventory.customPrice })
      .from(organizationInventory)
      .where(eq(organizationInventory.id, fixtures.organizationInventoryId))

    expect(item.customPrice).toBe(8_000)
  })

  it("treats a group price of zero as a price, not as an absent one", async () => {
    await setOrganizationPrice(fixtures, 8_000)
    await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 0)

    // COALESCE keeps the zero; a falsy check in SQL would charge 8000 here.
    expect(await readEffectivePrice(fixtures.groupId)).toBe(0)
    expect(await readScopedOverride(fixtures.groupId)).toBe(0)
  })

  it("returns the organization price for a read with no group scope", async () => {
    await setOrganizationPrice(fixtures, 8_000)
    await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 6_500)

    // A branch belonging to no group joins the tier `ON FALSE`, so it must be
    // priced as if the group tier did not exist.
    expect(await readEffectivePrice(null)).toBe(8_000)
  })

  it("clearing the group price returns the product to the organization price", async () => {
    await setOrganizationPrice(fixtures, 8_000)
    await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 6_500)
    expect(await readEffectivePrice(fixtures.groupId)).toBe(6_500)

    await db.delete(groupInventoryPrices).where(and(
      eq(groupInventoryPrices.groupId, fixtures.groupId),
      eq(groupInventoryPrices.organizationInventoryId, fixtures.organizationInventoryId),
    ))

    expect(await readEffectivePrice(fixtures.groupId)).toBe(8_000)
  })

  it("prices each branch by its own group in a listing that spans several", async () => {
    await setOrganizationPrice(fixtures, 8_000)
    await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 6_500)

    // Assign the product to both branches so the per-row join has rows to price.
    await db.insert(branchInventory).values([
      {
        branchId: fixtures.groupedBranchId,
        organizationId: fixtures.organizationId,
        organizationInventoryId: fixtures.organizationInventoryId,
        assignedByUserId: fixtures.userId,
      },
      {
        branchId: fixtures.looseBranchId,
        organizationId: fixtures.organizationId,
        organizationInventoryId: fixtures.organizationInventoryId,
        assignedByUserId: fixtures.userId,
      },
    ])

    try {
      const rows = await db
        .select({
          branchId: branchInventory.branchId,
          customPrice: scopedOverrideCentsSql(),
        })
        .from(branchInventory)
        .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
        .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
        .leftJoin(branches, eq(branchInventory.branchId, branches.id))
        .leftJoin(groupPriceTier, groupPriceJoinOnBranchGroup())
        .where(eq(branchInventory.organizationInventoryId, fixtures.organizationInventoryId))

      const priceByBranch = new Map(rows.map((row) => [row.branchId, Number(row.customPrice)]))

      // The grouped branch pays its group's price; the ungrouped one, in the
      // same result set, keeps the organization price.
      expect(priceByBranch.get(fixtures.groupedBranchId)).toBe(6_500)
      expect(priceByBranch.get(fixtures.looseBranchId)).toBe(8_000)
    } finally {
      await db
        .delete(branchInventory)
        .where(eq(branchInventory.organizationInventoryId, fixtures.organizationInventoryId))
    }
  })

  it("never lets one tenant's group price reach another tenant", async () => {
    await setOrganizationPrice(fixtures, 8_000)
    // A price row written under the neighbour's group, for this tenant's item.
    await setGroupPrice(
      fixtures,
      fixtures.neighbourGroupId,
      fixtures.neighbourOrganizationId,
      1,
    )

    // Read under this tenant's group: the neighbour's row must not appear.
    expect(await readEffectivePrice(fixtures.groupId)).toBe(8_000)

    // And the loader pinned to this tenant must not return it either, even when
    // asked for the neighbour's group id.
    const overrides = await loadGroupPriceOverrides(db, {
      organizationId: fixtures.organizationId,
      groupId: fixtures.neighbourGroupId,
      organizationInventoryIds: [fixtures.organizationInventoryId],
    })
    expect(overrides.size).toBe(0)
  })

  it("loads overrides as a map keyed by catalogue item", async () => {
    await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 5_500)

    const overrides = await loadGroupPriceOverrides(db, {
      organizationId: fixtures.organizationId,
      groupId: fixtures.groupId,
      organizationInventoryIds: [fixtures.organizationInventoryId],
    })

    expect(overrides.get(fixtures.organizationInventoryId)).toBe(5_500)
  })

  it("returns an empty map, never every group's prices, for a scope with no group", async () => {
    await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 5_500)

    const overrides = await loadGroupPriceOverrides(db, {
      organizationId: fixtures.organizationId,
      groupId: null,
      organizationInventoryIds: [fixtures.organizationInventoryId],
    })

    expect(overrides.size).toBe(0)
  })

  it("resolves a branch to its own group, and to none across tenants", async () => {
    await expect(resolveBranchGroupId(db, {
      branchId: fixtures.groupedBranchId,
      organizationId: fixtures.organizationId,
    })).resolves.toBe(fixtures.groupId)

    await expect(resolveBranchGroupId(db, {
      branchId: fixtures.looseBranchId,
      organizationId: fixtures.organizationId,
    })).resolves.toBeNull()

    // A branch id from another tenant must resolve to no group rather than to
    // that tenant's group.
    await expect(resolveBranchGroupId(db, {
      branchId: fixtures.foreignBranchId,
      organizationId: fixtures.organizationId,
    })).resolves.toBeNull()
  })

  it("keeps one price per product per group", async () => {
    await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 5_500)

    await expect(db.insert(groupInventoryPrices).values({
      groupId: fixtures.groupId,
      organizationId: fixtures.organizationId,
      organizationInventoryId: fixtures.organizationInventoryId,
      customPriceCents: 4_000,
    })).rejects.toThrow()
  })

  it("rejects a negative price at the database, not only in the API", async () => {
    await expect(db.insert(groupInventoryPrices).values({
      groupId: fixtures.groupId,
      organizationId: fixtures.organizationId,
      organizationInventoryId: fixtures.organizationInventoryId,
      customPriceCents: -1,
    })).rejects.toThrow()
  })

  it("a global price change leaves organization and group prices untouched", async () => {
    // Prices flow downward and never past a tier that has set its own. An
    // organization override that happens to equal the old global price used to
    // be deleted by this, silently revoking a price somebody chose.
    await setOrganizationPrice(fixtures, BASE_PRICE_CENTS)
    await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, BASE_PRICE_CENTS)

    await cascadeGlobalProductFieldUpdate(
      fixtures.globalProductId,
      [{ field: "basePrice", oldValue: BASE_PRICE_CENTS, newValue: BASE_PRICE_CENTS * 2 }],
      fixtures.userId,
      db,
    )

    const [item] = await db
      .select({ customPrice: organizationInventory.customPrice })
      .from(organizationInventory)
      .where(eq(organizationInventory.id, fixtures.organizationInventoryId))
    expect(item.customPrice).toBe(BASE_PRICE_CENTS)

    const [groupRow] = await db
      .select({ customPriceCents: groupInventoryPrices.customPriceCents })
      .from(groupInventoryPrices)
      .where(and(
        eq(groupInventoryPrices.groupId, fixtures.groupId),
        eq(groupInventoryPrices.organizationInventoryId, fixtures.organizationInventoryId),
      ))
    expect(groupRow.customPriceCents).toBe(BASE_PRICE_CENTS)
  })

  it("removes a group's prices when the group row is deleted", async () => {
    // The application soft-deletes and clears prices explicitly; this asserts
    // the hard-delete cascade behind it, so a removed group can never leave
    // price rows that a recycled id could pick up.
    const [temporaryGroup] = await db
      .insert(groups)
      .values({
        organizationId: fixtures.organizationId,
        name: `Cascade Group ${fixtures.suffix}`,
        createdByUserId: fixtures.userId,
      })
      .returning({ id: groups.id })

    await db.insert(groupInventoryPrices).values({
      groupId: temporaryGroup.id,
      organizationId: fixtures.organizationId,
      organizationInventoryId: fixtures.organizationInventoryId,
      customPriceCents: 3_000,
    })

    await db.delete(groups).where(eq(groups.id, temporaryGroup.id))

    const remaining = await db
      .select({ id: groupInventoryPrices.id })
      .from(groupInventoryPrices)
      .where(eq(groupInventoryPrices.groupId, temporaryGroup.id))

    expect(remaining).toHaveLength(0)
  })
})

describe.skipIf(hasTestDatabase)("group price ladder integration suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})
