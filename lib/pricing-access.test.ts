import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { Permission, ROLE_TEMPLATES } from "@/lib/permissions"
import {
  PRICE_MUTATION_ROLES,
  canMutatePrices,
  payloadTouchesPrice,
  priceMutationFailure,
  rejectPriceFieldsForRole,
} from "@/lib/pricing-access"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

const EVERY_OTHER_ROLE = [
  "HEAD_OFFICE",
  "BRANCH_ADMIN",
  "GROUP_USER",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
]

describe("who may change a price", () => {
  it("admits Super Admin and nobody else", () => {
    expect(canMutatePrices("SUPER_ADMIN")).toBe(true)
    expect(PRICE_MUTATION_ROLES).toEqual(["SUPER_ADMIN"])
  })

  it.each(EVERY_OTHER_ROLE)("refuses %s", (role) => {
    expect(canMutatePrices(role)).toBe(false)
    expect(priceMutationFailure(role)).toEqual({
      message: "Forbidden: only a Super Admin may change prices",
      status: 403,
    })
  })

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a number", 1],
    ["an object", {}],
    ["a lookalike string", "SUPER_ADMIN "],
    ["a lowercase role", "super_admin"],
  ])("refuses %s rather than coercing it", (_label, role) => {
    expect(canMutatePrices(role)).toBe(false)
  })

  it("lets a Super Admin through with no failure", () => {
    expect(priceMutationFailure("SUPER_ADMIN")).toBeNull()
  })
})

describe("detecting a price in a request body", () => {
  it("sees every field name a price travels under", () => {
    for (const field of ["basePrice", "customPrice", "customPriceCents", "priceCents"]) {
      expect(payloadTouchesPrice({ [field]: 100 })).toBe(true)
    }
  })

  it("treats an explicit null as an attempt, because it clears the price", () => {
    expect(payloadTouchesPrice({ customPrice: null })).toBe(true)
  })

  it("treats an absent or undefined field as no attempt", () => {
    // `undefined` is how these routes spell "leave this field alone".
    expect(payloadTouchesPrice({ customName: "x" })).toBe(false)
    expect(payloadTouchesPrice({ customPrice: undefined })).toBe(false)
    expect(payloadTouchesPrice({})).toBe(false)
  })

  it("survives a body that is not an object", () => {
    expect(payloadTouchesPrice(null)).toBe(false)
    expect(payloadTouchesPrice("customPrice")).toBe(false)
    expect(payloadTouchesPrice([{ customPrice: 1 }])).toBe(false)
  })

  it("can be narrowed to the fields one endpoint accepts", () => {
    expect(payloadTouchesPrice({ basePrice: 1 }, ["customPrice"])).toBe(false)
    expect(payloadTouchesPrice({ customPrice: 1 }, ["customPrice"])).toBe(true)
  })
})

describe("mixed edits that also carry a price", () => {
  it("lets Head Office edit everything except the price", () => {
    expect(rejectPriceFieldsForRole("HEAD_OFFICE", {
      customName: "Renamed",
      customImageUrl: "/img.png",
      isEnabled: false,
    })).toBeNull()
  })

  it("refuses the whole request when Head Office also sends a price", () => {
    // Refused rather than stripped: a caller that believes it repriced
    // something must be told that it did not.
    expect(rejectPriceFieldsForRole("HEAD_OFFICE", {
      customName: "Renamed",
      customPrice: 900,
    })).toEqual({
      message: "Forbidden: only a Super Admin may change prices",
      status: 403,
    })
  })

  it("refuses Head Office clearing a price with null", () => {
    expect(rejectPriceFieldsForRole("HEAD_OFFICE", { customPrice: null })).not.toBeNull()
  })

  it("lets a Super Admin send a price", () => {
    expect(rejectPriceFieldsForRole("SUPER_ADMIN", { customPrice: 900 })).toBeNull()
  })
})

describe("pricing authority in the role model", () => {
  it("is a permission of its own, not folded into inventory or group management", () => {
    expect(Permission.PRICING_MANAGE).toBe("pricing:manage")
  })

  it("is granted to Super Admin only", () => {
    expect(ROLE_TEMPLATES.SUPER_ADMIN.permissions).toContain(Permission.PRICING_MANAGE)

    for (const role of EVERY_OTHER_ROLE) {
      const template = ROLE_TEMPLATES[role as keyof typeof ROLE_TEMPLATES]
      expect(template.permissions as readonly Permission[])
        .not.toContain(Permission.PRICING_MANAGE)
    }
  })

  it("does not travel with the authority to administer a group", () => {
    // Head Office creates groups, assigns branches, and manages the tenant —
    // none of which may carry the right to change what anyone is charged.
    const headOffice = ROLE_TEMPLATES.HEAD_OFFICE.permissions as readonly Permission[]
    expect(headOffice).toContain(Permission.GROUP_VIEW)
    expect(headOffice).not.toContain(Permission.PRICING_MANAGE)
  })
})

describe("every endpoint that writes a price enforces the rule", () => {
  /**
   * The routes that can write to a price column, and how each is gated.
   *
   * A new price-writing endpoint that does not appear here is exactly the kind
   * of hole this list exists to catch: adding one without a gate should make a
   * reviewer add a line here and notice what they left out.
   */
  const priceWritingRoutes = [
    "app/api/v1/admin/global-inventory/route.ts",
    "app/api/v1/admin/global-inventory/import/route.ts",
    "app/api/v1/admin/organization-assignments/route.ts",
    "app/api/v1/admin/organization-assignments/import/route.ts",
    "app/api/v1/admin/cleanup-inventory/route.ts",
    "app/api/v1/inventory/global-products/[id]/route.ts",
    "app/api/v1/inventory/import/route.ts",
    "app/api/v1/head-office/organization-inventory/route.ts",
    "app/api/v1/admin/organization-assignments/price-impact/route.ts",
  ]

  it.each(priceWritingRoutes)("%s refuses any role but Super Admin", (path) => {
    const route = source(path)
    // Each of these is gated for the whole endpoint: either a bare inequality
    // check, or the shared pricing rule.
    expect(
      /!==\s*"SUPER_ADMIN"/.test(route) || route.includes("priceMutationFailure("),
    ).toBe(true)
  })

  it("shows the consequences of a price change only to those who may make one", () => {
    // The preview lists every group of a tenant and what each pays. It is part
    // of a repricing flow, so it is gated by the same rule as the write.
    const preview = source("app/api/v1/admin/organization-assignments/price-impact/route.ts")
    expect(preview).toContain("priceMutationFailure((session.user as any).role)")
    expect(preview).not.toContain("HEAD_OFFICE")
  })

  it("the group pricing endpoint separates reading from repricing", () => {
    const route = source("app/api/v1/groups/[id]/prices/route.ts")
    // Head Office may look at what its branches pay...
    expect(route).toContain('const PRICING_READ_ROLES = ["SUPER_ADMIN", "HEAD_OFFICE"] as const')
    // ...and may not change any of it.
    expect(route).toContain("const priceAccess = priceMutationFailure(authorized.role)")
    expect(route).not.toContain("PRICING_ROLES.includes")
  })

  it("the mixed organization-products endpoint rejects only the price field", () => {
    const route = source("app/api/v1/inventory/organization-products/route.ts")
    // Head Office keeps editing names, images, and availability here.
    expect(route).toContain('rejectPriceFieldsForRole(userRole, input, ["customPrice"])')
  })

  it("keeps the rule in one importable module rather than copied per route", () => {
    const rule = source("lib/pricing-access.ts")
    expect(rule.split("\n").filter((line) => line.startsWith("import "))).toEqual([])
    expect(rule).toContain('export const PRICE_MUTATION_ROLES = ["SUPER_ADMIN"] as const')
  })
})
