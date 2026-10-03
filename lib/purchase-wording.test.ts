import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { ROLE_TEMPLATES } from "@/lib/permissions"
import { usesPurchaseWording } from "@/lib/purchase-wording"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("usesPurchaseWording", () => {
  it("gives revenue wording to the Super Admin alone", () => {
    expect(usesPurchaseWording("SUPER_ADMIN")).toBe(false)
  })

  it.each([
    "HEAD_OFFICE",
    "BRANCH_ADMIN",
    "GROUP_USER",
    "GROUP_ORDER_PORTAL",
    "ORDER_PORTAL",
    "VIEWER",
  ])("gives purchase wording to %s", (role) => {
    expect(usesPurchaseWording(role)).toBe(true)
  })

  it("covers every role template, so a new role is never left on revenue wording by omission", () => {
    const sellers = Object.keys(ROLE_TEMPLATES).filter((role) => !usesPurchaseWording(role))
    expect(sellers).toEqual(["SUPER_ADMIN"])
  })

  it("falls back to purchase wording while the role is unknown", () => {
    for (const role of [undefined, null, "", "super_admin"]) {
      expect(usesPurchaseWording(role)).toBe(true)
    }
  })
})

describe("purchase wording contract", () => {
  // Every screen that switches between "Revenue" and "Purchased" by role. Each
  // used to carry its own buyer list, and the lists disagreed — Group User read
  // "Net Revenue" on the Order Report while its dashboard drawer said
  // "Purchased". A screen added to this set goes on this list.
  const WORDING_SCREENS = [
    "app/(portal)/reports/page.tsx",
    "app/(portal)/reports/branch-reports/page.tsx",
    "app/(portal)/reports/groups/page.tsx",
    "app/(portal)/reports/order-report/page.tsx",
    "app/(portal)/reports/organization-report/page.tsx",
    "app/(portal)/reports/product-performance/page.tsx",
    "app/(portal)/reports/user-report/page.tsx",
    "components/dashboard/charts.tsx",
    "components/dashboard/drill-down-sheet.tsx",
  ]

  it.each(WORDING_SCREENS)("%s takes the rule from lib/purchase-wording", (path) => {
    const text = source(path)
    expect(text).toContain('from "@/lib/purchase-wording"')
    expect(text).toContain("usesPurchaseWording(")
  })

  it.each(WORDING_SCREENS)("%s restates no buyer role list of its own", (path) => {
    const text = source(path)
    expect(text).not.toMatch(/isBuyer[^\n]*HEAD_OFFICE/)
    expect(text).not.toMatch(/function isBuyerRole/)
  })
})
