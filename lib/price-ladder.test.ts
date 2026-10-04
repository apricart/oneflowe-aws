import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { resolveEffectivePriceCents, resolveScopedOverrideCents } from "@/lib/price-ladder"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("price ladder", () => {
  it("prefers the group price over the organization and base prices", () => {
    expect(resolveEffectivePriceCents({
      groupPriceCents: 900,
      organizationPriceCents: 1200,
      basePriceCents: 1500,
    })).toBe(900)
  })

  it("falls back to the organization price when the group sets none", () => {
    expect(resolveEffectivePriceCents({
      groupPriceCents: null,
      organizationPriceCents: 1200,
      basePriceCents: 1500,
    })).toBe(1200)
    // An absent tier and an explicitly null one must behave identically: a read
    // without a group scope simply omits the field.
    expect(resolveEffectivePriceCents({
      organizationPriceCents: 1200,
      basePriceCents: 1500,
    })).toBe(1200)
  })

  it("falls back to the base price when neither override is set", () => {
    expect(resolveEffectivePriceCents({
      groupPriceCents: null,
      organizationPriceCents: null,
      basePriceCents: 1500,
    })).toBe(1500)
  })

  it("treats zero as a deliberate price, never as an absent one", () => {
    // The whole ladder is nullish-coalescing, matching the COALESCE on the SQL
    // side. A falsy check here would silently charge the tier below.
    expect(resolveEffectivePriceCents({
      groupPriceCents: 0,
      organizationPriceCents: 1200,
      basePriceCents: 1500,
    })).toBe(0)
    expect(resolveEffectivePriceCents({
      organizationPriceCents: 0,
      basePriceCents: 1500,
    })).toBe(0)
    expect(resolveScopedOverrideCents({ groupPriceCents: 0, organizationPriceCents: 900 })).toBe(0)
  })

  it("returns null when no tier carries a price at all", () => {
    // Callers keep their own "pricing is unavailable" guard, so this must be
    // reportable rather than coerced into a zero charge.
    expect(resolveEffectivePriceCents({})).toBeNull()
    expect(resolveEffectivePriceCents({
      groupPriceCents: null,
      organizationPriceCents: null,
      basePriceCents: null,
    })).toBeNull()
  })

  it("reports only the override tiers for the scoped override", () => {
    // `customPrice` on a branch-scoped listing means "the tenant set this
    // price"; inheriting the global base price is not the tenant setting one.
    expect(resolveScopedOverrideCents({
      groupPriceCents: 900,
      organizationPriceCents: 1200,
      basePriceCents: 1500,
    })).toBe(900)
    expect(resolveScopedOverrideCents({
      organizationPriceCents: 1200,
      basePriceCents: 1500,
    })).toBe(1200)
    expect(resolveScopedOverrideCents({ basePriceCents: 1500 })).toBeNull()
  })

  it("keeps the rule free of the database so it stays directly testable", () => {
    // Asserted on the import statements, not on the prose, so the module's own
    // explanation of the split does not satisfy the check.
    const imports = source("lib/price-ladder.ts")
      .split("\n")
      .filter((line) => line.startsWith("import "))
    expect(imports).toEqual([])
  })
})

describe("price ladder wiring", () => {
  it("resolves the same three tiers in SQL as in TypeScript", () => {
    const helpers = source("lib/server/effective-price.ts")
    // COALESCE and `??` agree on null and on zero; a falsy-based SQL expression
    // would diverge from the TypeScript rule on a zero price.
    expect(helpers).toContain(
      "COALESCE(${groupPriceTier.customPriceCents}, ${organizationInventory.customPrice}, ${globalProducts.basePrice})",
    )
    expect(helpers).toContain(
      "COALESCE(${groupPriceTier.customPriceCents}, ${organizationInventory.customPrice})",
    )
  })

  it("contributes no group row when a read has no group scope", () => {
    const helpers = source("lib/server/effective-price.ts")
    // Without this, a read with no group would join every group's prices and
    // could price a branch from a group it does not belong to.
    expect(helpers).toContain("if (!scope.groupId) return sql`FALSE`")
  })

  it("pins every group price read to the tenant it was written under", () => {
    const helpers = source("lib/server/effective-price.ts")
    expect(helpers).toContain("eq(groupPriceTier.organizationId, scope.organizationId)")
    expect(helpers).toContain("eq(groupPriceTier.organizationId, branches.organizationId)")
    expect(helpers).toContain("eq(groupInventoryPrices.organizationId, scope.organizationId)")
    // A branch id from another tenant must resolve to no group, not to that
    // tenant's group.
    expect(helpers).toContain("eq(branches.organizationId, scope.organizationId)")
  })

  it("never widens an empty scope into every group's prices", () => {
    const helpers = source("lib/server/effective-price.ts")
    expect(helpers).toContain(
      "if (!scope.groupId || scope.organizationInventoryIds.length === 0) return new Map()",
    )
  })
})

describe("group pricing surfaces", () => {
  it("prices every order write path through the one resolver", () => {
    // These are the paths that decide what a branch is charged. A price
    // expression written by hand in any of them is how the charged price and
    // the displayed price drift apart.
    for (const path of [
      "app/api/v1/orders/route.ts",
      "app/api/v1/orders/[id]/route.ts",
      "lib/server/group-order-creation.ts",
    ]) {
      const route = source(path)
      expect(route).toContain("resolveEffectivePriceCents({")
      expect(route).toContain("loadGroupPriceOverrides(")
      // The old two-tier expression must not survive anywhere alongside it.
      expect(route).not.toContain("inventoryItem.customPrice ?? product.basePrice")
    }
  })

  it("resolves the group tier inside the transaction that locks the rows", () => {
    for (const path of [
      "app/api/v1/orders/[id]/route.ts",
      "lib/server/group-order-creation.ts",
    ]) {
      expect(source(path)).toContain("resolveBranchGroupId(tx, {")
    }
  })

  it("prices the branch-scoped listings by the branch's own group", () => {
    for (const path of [
      "app/api/v1/branch/inventory/route.ts",
      "app/api/v1/budget-quantity/route.ts",
      "app/api/v1/head-office/branch-assignments/route.ts",
    ]) {
      const route = source(path)
      expect(route).toContain("scopedOverrideCentsSql()")
      expect(route).toContain("leftJoin(groupPriceTier")
      expect(route).not.toContain("customPrice: organizationInventory.customPrice")
    }
  })

  it("prices the group portal catalogue by the group the scope was authorized against", () => {
    const catalogRoute = source("app/api/v1/group-portal/catalog/route.ts")
    const catalog = source("lib/server/group-order-catalog.ts")
    // Never a group id taken straight from the query string.
    expect(catalogRoute).toContain("groupId: scope.group.id")
    expect(catalog).toContain("effectivePriceCentsSql()")
    expect(catalog).toContain("groupPriceJoinOn({ organizationId, groupId: query.groupId })")
  })

  it("refuses to price a draft without knowing its group", () => {
    const prices = source("app/api/v1/group-portal/prices/route.ts")
    // Answering at organization prices when the group was not supplied would
    // show a total the server will not charge.
    expect(prices).toContain('if (!searchParams.has("groupId"))')
    expect(prices).toContain("const group = scopedGroups.find((candidate) => candidate.id === groupId)")
    expect(prices).toContain("if (!group) return ok({ items: [] })")

    const draftHook = source("components/group-portal/storefront/use-storefront-draft.ts")
    expect(draftHook).toContain("groupId=${groupParam}")
  })
})

describe("the product reports price down the ladder", () => {
  const performance = source("app/api/v1/analytics/products/performance/route.ts")
  const catalogue = source("app/api/v1/analytics/products/catalog-performance/route.ts")

  it("never reports the raw base price as a unit price", () => {
    // A product with no sales in the period has no charged amount to report, so
    // its price comes from the catalogue — down the ladder, not straight off
    // `global_products`. Reporting the base price to an organization that has
    // negotiated its own is both the wrong number and a way around the
    // redaction on `basePriceCents`: the same figure under another name.
    expect(performance).not.toContain("unitPriceCents: product.basePriceCents || 0")
    expect(performance).toContain("unitPriceCents: reportedUnitPriceCents(product, organizationPriceApplies)")

    for (const route of [performance, catalogue]) {
      expect(route).toContain('from "@/lib/server/effective-price"')
      expect(route).toContain("resolveEffectivePriceCents({")
    }
  })

  it("reports what was actually charged wherever a charge exists", () => {
    // The charged snapshot already reflects every tier that applied, the group
    // tier included, so a sold product is reported from it rather than re-priced.
    expect(performance).toContain("unitPriceCents: row.priceCents || 0")
    expect(catalogue).toContain("totalRevenueCents")
  })

  it("reads an organization price only where exactly one organization is in scope", () => {
    // The join admits every organization in scope; with several, a product
    // assigned to more than one joins more than one row and the last read would
    // win — one tenant's negotiated price printed against another's product.
    expect(performance).toContain("function hasSingleOrganizationInScope(")
    expect(performance).toContain("if (organizationIds.length === 1) return true")
    expect(performance).toContain("return organizationIds.length === 0 && Boolean(userOrganizationId)")
    expect(performance).toContain("const organizationPriceApplies = !isSuperAdmin")

    // The catalogue report fails closed the same way, in SQL.
    expect(catalogue).toContain("targetOrgId ? eq(organizationInventory.organizationId, targetOrgId) : sql`FALSE`")
  })

  it("leaves the base price redaction exactly as it was", () => {
    // Resolving the unit price must not widen who sees the base price itself.
    expect(performance).toContain("basePriceCents: isSuperAdmin ? (product.basePriceCents || 0) : 0")
    expect(performance).toContain("basePriceCents: isSuperAdmin ? (row.basePriceCents || 0) : 0")
    expect(catalogue).toContain("basePriceCents: isSuperAdmin ? (p.basePrice || 0) : 0")
  })

  it("resolves nullish, never falsy, so a price of 0 is a price", () => {
    for (const route of [performance, catalogue]) {
      expect(route).not.toContain("customPrice || p.basePrice")
      expect(route).not.toContain("p.customPrice || p.basePrice")
    }
  })
})

describe("group pricing access control", () => {
  const route = source("app/api/v1/groups/[id]/prices/route.ts")

  it("opens the screen only to the two roles that already administer groups", () => {
    expect(route).toContain('const PRICING_READ_ROLES = ["SUPER_ADMIN", "HEAD_OFFICE"] as const')
    expect(route).toContain("if (!PRICING_READ_ROLES.includes(role))")
    // Belonging to a group grants the right to order at its prices, never to
    // see or set them.
    expect(route).not.toContain("GROUP_ORDER_PORTAL")
    expect(route).not.toContain("GROUP_USER")
  })

  it("lets only a Super Admin change a price on it", () => {
    // Head Office reads this screen because it has to know what its branches
    // pay; the write goes through the one shared pricing rule, which admits
    // Super Admin alone.
    expect(route).toContain('from "@/lib/pricing-access"')
    expect(route).toContain("const priceAccess = priceMutationFailure(authorized.role)")
  })

  it("confines Head Office to its own organization on both reads and writes", () => {
    expect(route).toContain('if (role === "HEAD_OFFICE" && group.organizationId !== (session.user as any).organizationId)')
    // One authorization helper serves GET and PUT, so the two cannot drift.
    expect(route).toContain("const { authorized, failure } = await authorizeGroupPricing(id)")
    expect(route.match(/await authorizeGroupPricing\(id\)/g) || []).toHaveLength(2)
  })

  it("verifies every priced product belongs to the group's own organization", () => {
    expect(route).toContain("eq(organizationInventory.organizationId, authorized.group.organizationId)")
    expect(route).toContain("if (ownedItems.length !== requestedIds.length)")
  })

  it("applies a repricing atomically and records who did it", () => {
    expect(route).toContain("await db.transaction(async (tx) => {")
    expect(route).toContain('action: "SET_GROUP_PRICES"')
    expect(route).toContain("performedByUserId: authorized.userId")
    expect(route).toContain("performedByRole: authorized.role")
  })

  it("clears an override by deleting the row rather than storing a null", () => {
    // "No group price" must mean exactly one thing, so the fallback to the
    // organization price is never ambiguous.
    expect(route).toContain("tx.delete(groupInventoryPrices)")
    expect(source("db/schema.ts")).toContain('customPriceCents: integer("custom_price_cents").notNull()')
  })

  it("invalidates the caches that carry prices", () => {
    expect(route).toContain('invalidateByPrefix("branch-inv")')
    expect(route).toContain('invalidateByPrefix("group")')
  })
})
