import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import {
  applyGroupLocations,
  applyLocationToggle,
  cartSignature,
  cartToBranchPlans,
  selectedBranches,
  setCartLineQuantity,
  setCartQuantity,
} from "@/components/group-portal/storefront/storefront-plan"
import type { CatalogItem, ScopedBranch, SelectedLine } from "@/components/group-portal/types"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

const branch = (id: number, name = `Branch ${id}`): ScopedBranch => ({
  id,
  name,
  city: null,
  costCenterId: null,
  groupId: 1,
})

const catalogItem = (id: number, overrides: Partial<CatalogItem> = {}): CatalogItem => ({
  organizationInventoryId: id,
  globalProductId: id * 10,
  name: `Product ${id}`,
  productCode: `P-${id}`,
  description: null,
  imageUrl: null,
  unit: "pack",
  priceCents: 1000,
  stockQuantity: 100,
  allowDecimalQuantity: false,
  quantityStep: null,
  categoryName: null,
  quantityBudgetRemaining: null,
  ...overrides,
})

const line = (id: number, quantity: number, priceCents = 1000): SelectedLine => ({
  organizationInventoryId: id,
  quantity,
  name: `Product ${id}`,
  unit: "pack",
  priceCents,
})

describe("storefront cart edits", () => {
  it("adds a product with the rules it will later be stepped by", () => {
    const cart = setCartQuantity([], catalogItem(1, { allowDecimalQuantity: true, quantityStep: 0.5 }), 2.5)

    expect(cart).toHaveLength(1)
    expect(cart[0]).toMatchObject({
      organizationInventoryId: 1,
      quantity: 2.5,
      allowDecimalQuantity: true,
      quantityStep: 0.5,
    })
  })

  it("keeps a corrected line where the user is reading it", () => {
    // Moving an edited line to the end of the cart reshuffles the list under
    // the user mid-correction.
    const cart = [line(1, 1), line(2, 1), line(3, 1)]
    const updated = setCartQuantity(cart, catalogItem(2), 9)

    expect(updated.map((entry) => entry.organizationInventoryId)).toEqual([1, 2, 3])
    expect(updated[1].quantity).toBe(9)
  })

  it("treats zero as removal from either entry point", () => {
    const cart = [line(1, 4), line(2, 4)]

    expect(setCartQuantity(cart, catalogItem(1), 0).map((entry) => entry.organizationInventoryId)).toEqual([2])
    expect(setCartLineQuantity(cart, 2, 0).map((entry) => entry.organizationInventoryId)).toEqual([1])
  })

  it("edits a cart line without a catalogue row in hand", () => {
    // The product may have been paged out of the storefront by the time its
    // quantity is corrected in the cart.
    expect(setCartLineQuantity([line(1, 2)], 1, 7)[0]).toMatchObject({ quantity: 7, name: "Product 1" })
  })
})

describe("storefront per-location preview", () => {
  it("gives every ticked location the same cart", () => {
    const plans = cartToBranchPlans([line(1, 3, 500), line(2, 1, 250)], [branch(7), branch(9)])

    expect(plans.map((plan) => plan.branch.id)).toEqual([7, 9])
    for (const plan of plans) {
      expect(plan.lines.map((entry) => entry.quantity)).toEqual([3, 1])
      expect(plan.totalCents).toBe(3 * 500 + 250)
    }
  })

  it("has nothing to preview without a cart or without locations", () => {
    expect(cartToBranchPlans([], [branch(1)])).toEqual([])
    expect(cartToBranchPlans([line(1, 1)], [])).toEqual([])
  })

  it("drops a ticked location that is no longer in the group", () => {
    // A location deactivated since it was ticked disappears from the group's
    // branch list. Carrying its id forward would submit a branch the server
    // refuses for the whole request.
    expect(selectedBranches([branch(1), branch(2)], [1, 99]).map((entry) => entry.id)).toEqual([1])
  })

  it("lists locations in the group's own order, not the order they were ticked", () => {
    expect(selectedBranches([branch(1), branch(2), branch(3)], [3, 1]).map((entry) => entry.id))
      .toEqual([1, 3])
  })
})

describe("storefront single-group location selection", () => {
  it("ticks and unticks freely inside the selected group", () => {
    const ticked = applyLocationToggle({ groupId: 1, branchIds: [2] }, { groupId: 1, branchId: 7 })
    expect(ticked).toEqual({ groupId: 1, branchIds: [2, 7], switchedGroup: false })

    const unticked = applyLocationToggle({ groupId: 1, branchIds: [2, 7] }, { groupId: 1, branchId: 2 })
    expect(unticked).toEqual({ groupId: 1, branchIds: [7], switchedGroup: false })
  })

  it("drops the other group's locations when one is ticked elsewhere", () => {
    // The server accepts one group per submission, so a selection spanning two
    // groups could never be submitted. Moving is the only coherent outcome.
    const moved = applyLocationToggle({ groupId: 1, branchIds: [2, 7] }, { groupId: 3, branchId: 12 })

    expect(moved).toEqual({ groupId: 3, branchIds: [12], switchedGroup: true })
  })

  it("carries over only the location that was clicked, not its whole group", () => {
    const moved = applyLocationToggle({ groupId: 1, branchIds: [2] }, { groupId: 3, branchId: 13 })

    expect(moved.branchIds).toEqual([13])
  })

  it("treats the ungrouped bucket as a group of its own", () => {
    const moved = applyLocationToggle({ groupId: 1, branchIds: [2] }, { groupId: null, branchId: 20 })

    expect(moved).toEqual({ groupId: null, branchIds: [20], switchedGroup: true })
  })

  it("replaces rather than merges when a whole group is selected", () => {
    const selectAll = applyGroupLocations({ groupId: 1, branchIds: [2, 7] }, { groupId: 3, branchIds: [12, 13, 14] })
    expect(selectAll).toEqual({ groupId: 3, branchIds: [12, 13, 14], switchedGroup: true })

    const clearAll = applyGroupLocations({ groupId: 3, branchIds: [12, 13] }, { groupId: 3, branchIds: [] })
    expect(clearAll).toEqual({ groupId: 3, branchIds: [], switchedGroup: false })
  })

  it("does not report a group switch for the very first selection", () => {
    // Nothing was selected, so nothing is being taken away — the caller must
    // not ask the user to confirm discarding a cart that cannot exist yet.
    const first = applyGroupLocations({ groupId: undefined, branchIds: [] }, { groupId: 1, branchIds: [2] })

    expect(first.switchedGroup).toBe(false)
    expect(first.branchIds).toEqual([2])
  })

  it("never yields a duplicate location", () => {
    expect(applyGroupLocations({ groupId: 1, branchIds: [] }, { groupId: 1, branchIds: [2, 2, 7] }).branchIds)
      .toEqual([2, 7])
  })
})

describe("storefront review continuity", () => {
  it("recognises a return trip that changed nothing", () => {
    // Leaving review to add more products must not throw away per-location
    // corrections when nothing was actually added.
    const before = cartSignature([line(1, 2), line(2, 3)], [branch(1), branch(2)])
    const after = cartSignature([line(2, 3), line(1, 2)], [branch(2), branch(1)])

    expect(after).toBe(before)
  })

  it("notices a changed cart or a changed set of locations", () => {
    const base = cartSignature([line(1, 2)], [branch(1)])

    expect(cartSignature([line(1, 3)], [branch(1)])).not.toBe(base)
    expect(cartSignature([line(1, 2), line(2, 1)], [branch(1)])).not.toBe(base)
    expect(cartSignature([line(1, 2)], [branch(1), branch(2)])).not.toBe(base)
  })
})

describe("storefront catalogue scoping", () => {
  const catalogRoute = source("app/api/v1/group-portal/catalog/route.ts")
  const catalogLoader = source("lib/server/group-order-catalog.ts")

  it("still authorizes the branch set before reading any catalogue row", () => {
    expect(catalogRoute).toContain("const { actor, response } = await requireGroupOrderPortal()")
    expect(catalogRoute).toContain("await resolveSubmissionScope({")
    expect(catalogRoute).toContain("branchIds: scope.branches.map((branch) => branch.id)")
  })

  it("matches the requested sort against an allowlist rather than forwarding it", () => {
    // Anything reaching an ORDER BY clause from the query string would be an
    // injection point; matching against a constant list cannot be one.
    expect(catalogRoute).toContain("GROUP_CATALOG_SORTS.find((sort) => sort === value)")
    expect(catalogLoader).toContain('export const GROUP_CATALOG_SORTS = ["name", "price-low", "price-high"] as const')
  })

  it("keeps paging stable when two products share a price", () => {
    // Without the name tie-breaker a price sort can repeat one product across
    // pages and never show another.
    expect(catalogLoader).toContain("if (sort === \"price-low\") return [asc(price) as SQL, asc(displayName) as SQL]")
    expect(catalogLoader).toContain("if (sort === \"price-high\") return [desc(price) as SQL, asc(displayName) as SQL]")
  })

  it("builds the category ribbon from the same branch coverage rule as the list", () => {
    // A chip for a category no ticked location can actually order from would
    // filter the grid down to nothing.
    expect(catalogLoader).toContain("loadCategoryFacets(and(...scopeConditions), branchCount)")
    expect(catalogLoader).toContain("sql`${covered.covered} = ${branchCount}`")
  })
})

describe("storefront role confinement", () => {
  it("leaves the single-branch shop untouched by the group surface", () => {
    const shop = source("app/shop/page.tsx")

    expect(shop).not.toContain("group-portal")
    expect(shop).not.toContain("GROUP_ORDER_PORTAL")
  })

  it("keeps the approver out of the storefront's endpoints", () => {
    // GROUP_USER shares the branch-assignment mechanism but must never gain a
    // way to raise the orders it decides.
    const gate = source("lib/server/group-order-access.ts")

    expect(gate).toContain("requireApiRole([GROUP_ORDER_PORTAL_ROLE])")
    expect(gate).toContain("requireApiRole([GROUP_USER_ROLE])")
  })

  it("submits through the group endpoint alone", () => {
    const storefront = source("components/group-portal/storefront/group-storefront.tsx")

    expect(storefront).toContain('"/api/v1/group-portal/orders"')
    expect(storefront).toContain('"Idempotency-Key": idempotencyKeyRef.current')
    expect(storefront).not.toContain('"/api/v1/orders"')
  })
})
