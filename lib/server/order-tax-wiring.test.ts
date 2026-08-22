import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it } from "vitest"

import { DEFAULT_TAX_RATE_BP, splitInclusiveCents, splitOrderInclusiveCents } from "@/lib/tax"

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8")

const ORDER_CREATE = "app/api/v1/orders/route.ts"
const ORDER_EDIT = "app/api/v1/orders/[id]/route.ts"
const GROUP_CREATE = "lib/server/group-order-creation.ts"

/**
 * Tax was introduced by splitting an already tax-inclusive price, so the figure
 * a branch is charged must be identical to what it would have been before the
 * feature existed. These pin the two things that guarantee it: the totals are
 * summed from gross line amounts, and no write path still hardcodes zero tax.
 */
describe("order totals are unchanged by the tax split", () => {
  it("keeps the order total equal to the sum of gross line amounts", () => {
    const grossLines = [11_800, 333, 45_007, 1, 999_999]
    const totals = splitOrderInclusiveCents(
      grossLines.map((grossCents) => ({ grossCents, taxRateBp: DEFAULT_TAX_RATE_BP })),
    )

    expect(totals.grossCents).toBe(grossLines.reduce((sum, line) => sum + line, 0))
    expect(totals.netCents + totals.taxCents).toBe(totals.grossCents)
  })

  it("never lets a rounded split drift from the amount charged", () => {
    for (let grossCents = 0; grossCents <= 2_000; grossCents += 1) {
      const split = splitInclusiveCents(grossCents, DEFAULT_TAX_RATE_BP)
      expect(split.netCents + split.taxCents).toBe(grossCents)
    }
  })
})

describe("every order write path records tax", () => {
  it("no longer hardcodes a zero tax figure", () => {
    expect(read(ORDER_CREATE)).not.toContain("tax: 0")
    expect(read(ORDER_EDIT)).not.toContain("taxCents: 0")
    expect(read(GROUP_CREATE)).not.toContain("taxCents: 0")
  })

  it("derives each line's tax from the resolved product rate", () => {
    for (const path of [ORDER_CREATE, ORDER_EDIT, GROUP_CREATE]) {
      const source = read(path)
      expect(source).toContain("resolveTaxRateBp(product.taxRateBp")
      expect(source).toContain("splitInclusiveCents(calculateLineCents(")
    }
  })

  it("accumulates the order total from gross line amounts, not the net subtotal", () => {
    expect(read(ORDER_CREATE)).toContain("total += line.grossCents")
    expect(read(ORDER_EDIT)).toContain("totalCents += line.grossCents")
    expect(read(GROUP_CREATE)).toContain("total += lineSplit.grossCents")
  })
})

/**
 * The tax split is only valid for tax-inclusive prices. Legacy imported
 * products are priced the other way round, and are kept out of reach by being
 * inactive rather than by anything in the tax code itself.
 */
describe("legacy products stay out of reach", () => {
  it("still requires an active product and active assignment to order", () => {
    const source = read(ORDER_CREATE)
    expect(source).toContain('eq(organizationInventory.isActive, true)')
    expect(source).toContain('eq(globalProducts.status, "active")')
  })

  it("blocks activating a historical-only product", () => {
    const source = read("app/api/v1/admin/global-inventory/route.ts")
    expect(source).toContain("getHistoricalProductActivationError")
    expect(source).toContain("isHistoricalOnlyProduct(existingProduct.metadata)")
  })
})

/**
 * Tenant scoping in the touched handlers has to be exactly what it was; the
 * change is confined to pricing arithmetic and must not have widened any read.
 */
describe("tenant scoping is unchanged", () => {
  it("keeps order creation pinned to the caller's organization and branch", () => {
    const source = read(ORDER_CREATE)
    expect(source).toContain("eq(organizationInventory.organizationId, context.organizationId)")
    expect(source).toContain("eq(branchInventory.branchId, context.branchId)")
    expect(source).toContain("eq(branchInventory.organizationId, context.organizationId)")
  })

  it("keeps order editing pinned to the creator's own pending order", () => {
    const source = read(ORDER_EDIT)
    expect(source).toContain("eq(orders.createdByUserId, user.id)")
    expect(source).toContain("eq(orders.organizationId, organizationId)")
    expect(source).toContain("eq(orders.branchId, branchId)")
  })
})
