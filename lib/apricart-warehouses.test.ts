import { describe, expect, it } from "vitest"

import {
  APRICART_WAREHOUSE_CODE_PATTERN,
  BRANCH_ROUTE_MAX_PER_ORGANIZATION,
  citiesOfOrganizations,
  classifyBranchCoverage,
  executiveCoverageGaps,
  inactiveAccountsHoldingReach,
  normalizeWarehouseCode,
  parseWarehouseId,
  plannedRuleAdditions,
  responsibilityForRole,
  routedBranchIdsInOrganization,
  suggestedBranchIdsFor,
  summarizeCoverage,
} from "@/lib/apricart-warehouses"
import {
  apricartWarehouseCreateSchema,
  apricartWarehouseMemberUpdateSchema,
  apricartWarehouseUpdateSchema,
  branchFulfillmentRoutesUpdateSchema,
} from "@/lib/server/mutation-validation"

describe("responsibilityForRole", () => {
  it("makes a warehouse account an operator and an executive account an executive", () => {
    expect(responsibilityForRole("WAREHOUSE")).toBe("WAREHOUSE_OPERATOR")
    expect(responsibilityForRole("APRICART_EXECUTIVE")).toBe("EXECUTIVE")
  })

  it.each(["SUPER_ADMIN", "HEAD_OFFICE", "ORDER_DESK", "APRICART_SUPPORT", "BRANCH_ADMIN", "", null, undefined])(
    "lets no %s account be a member",
    (role) => {
      expect(responsibilityForRole(role)).toBeNull()
    },
  )
})

describe("warehouse codes", () => {
  it("upper-cases and trims, so one code has one spelling", () => {
    expect(normalizeWarehouseCode("  khi-01 ")).toBe("KHI-01")
  })

  it("accepts letters and digits with single hyphens between them", () => {
    for (const code of ["KHI", "KHI-01", "LHR-NORTH-2", "A1"]) expect(APRICART_WAREHOUSE_CODE_PATTERN.test(code), code).toBe(true)
    for (const code of ["-KHI", "KHI-", "KHI--01", "KHI 01", "KHI_01", "KHÍ"]) expect(APRICART_WAREHOUSE_CODE_PATTERN.test(code), code).toBe(false)
  })
})

describe("parseWarehouseId", () => {
  it("accepts a positive Postgres integer and nothing else", () => {
    expect(parseWarehouseId("1")).toBe(1)
    expect(parseWarehouseId("2147483647")).toBe(2_147_483_647)
    for (const raw of ["0", "-1", "1.5", "abc", "", "2147483648", "99999999999", " 1"]) expect(parseWarehouseId(raw), raw).toBeNull()
  })
})

describe("classifyBranchCoverage", () => {
  const operatorWarehouses = new Map<string, number[]>([
    ["alice", [1]],
    ["bob", [1]],
    ["carol", [2]],
    ["dave", [1, 2]],
  ])

  it("lets a route win, and says whether today's staff work at the routed warehouse", () => {
    expect(classifyBranchCoverage({ routeWarehouseId: 1, servingAccountIds: ["alice"], operatorWarehouses })).toMatchObject({
      kind: "ROUTED", routeWarehouseId: 1, routeMatchesReach: true,
    })
    expect(classifyBranchCoverage({ routeWarehouseId: 2, servingAccountIds: ["alice"], operatorWarehouses })).toMatchObject({
      kind: "ROUTED", routeWarehouseId: 2, routeMatchesReach: false,
    })
    expect(classifyBranchCoverage({ routeWarehouseId: 2, servingAccountIds: [], operatorWarehouses })).toMatchObject({
      kind: "ROUTED", routeMatchesReach: null,
    })
  })

  it("suggests a warehouse only when everyone serving the branch agrees on exactly one", () => {
    expect(classifyBranchCoverage({ routeWarehouseId: null, servingAccountIds: ["alice", "bob"], operatorWarehouses })).toMatchObject({
      kind: "SUGGESTED", suggestedWarehouseId: 1, candidateWarehouseIds: [1],
    })
  })

  it("never chooses among several warehouses", () => {
    expect(classifyBranchCoverage({ routeWarehouseId: null, servingAccountIds: ["alice", "carol"], operatorWarehouses })).toMatchObject({
      kind: "AMBIGUOUS", suggestedWarehouseId: null, candidateWarehouseIds: [1, 2],
    })
    // One person at two warehouses is ambiguous too.
    expect(classifyBranchCoverage({ routeWarehouseId: null, servingAccountIds: ["dave"], operatorWarehouses }).kind).toBe("AMBIGUOUS")
  })

  it("tells a branch served by nobody in a warehouse from one served by nobody at all", () => {
    expect(classifyBranchCoverage({ routeWarehouseId: null, servingAccountIds: ["erin"], operatorWarehouses }).kind).toBe("UNMAPPED")
    expect(classifyBranchCoverage({ routeWarehouseId: null, servingAccountIds: [], operatorWarehouses }).kind).toBe("UNSERVED")
  })

  it("counts a member of no warehouse as no vote, not as a veto", () => {
    expect(classifyBranchCoverage({ routeWarehouseId: null, servingAccountIds: ["alice", "erin"], operatorWarehouses })).toMatchObject({
      kind: "SUGGESTED", suggestedWarehouseId: 1,
    })
  })
})

describe("executiveCoverageGaps", () => {
  it("names each routed organization no executive member may approve for, once, ascending", () => {
    expect(executiveCoverageGaps({
      routedOrganizationIds: [7, 3, 3, 9],
      executiveOrganizationIds: [[3], [11]],
    })).toEqual([7, 9])
  })

  it("names every routed organization when the warehouse has no executive", () => {
    expect(executiveCoverageGaps({ routedOrganizationIds: [2, 1], executiveOrganizationIds: [] })).toEqual([1, 2])
  })

  it("names nothing when nothing is routed", () => {
    expect(executiveCoverageGaps({ routedOrganizationIds: [], executiveOrganizationIds: [[1]] })).toEqual([])
  })
})

describe("summarizeCoverage", () => {
  it("counts every kind, zero included", () => {
    expect(summarizeCoverage([{ kind: "ROUTED" }, { kind: "ROUTED" }, { kind: "UNSERVED" }])).toEqual({
      ROUTED: 2, SUGGESTED: 0, AMBIGUOUS: 0, UNMAPPED: 0, UNSERVED: 1,
    })
  })
})

describe("request bodies", () => {
  it("normalises a new warehouse's code and clears empty optional text", () => {
    const parsed = apricartWarehouseCreateSchema.parse({ code: " khi-01 ", name: " Karachi Central ", city: "", address: "  " })
    expect(parsed).toEqual({ code: "KHI-01", name: "Karachi Central", city: null, address: null })
  })

  it("refuses a malformed code, a short name and any extra field", () => {
    expect(apricartWarehouseCreateSchema.safeParse({ code: "K", name: "Karachi" }).success).toBe(false)
    expect(apricartWarehouseCreateSchema.safeParse({ code: "KHI 01", name: "Karachi" }).success).toBe(false)
    expect(apricartWarehouseCreateSchema.safeParse({ code: "KHI", name: "K" }).success).toBe(false)
    expect(apricartWarehouseCreateSchema.safeParse({ code: "KHI", name: "Karachi", status: "ACTIVE" }).success).toBe(false)
    expect(apricartWarehouseCreateSchema.safeParse({ code: "KHI", name: "Karachi", id: 5 }).success).toBe(false)
  })

  it("keeps the code permanent and needs at least one change", () => {
    expect(apricartWarehouseUpdateSchema.safeParse({ code: "NEW" }).success).toBe(false)
    expect(apricartWarehouseUpdateSchema.safeParse({}).success).toBe(false)
    expect(apricartWarehouseUpdateSchema.safeParse({ status: "INACTIVE" }).success).toBe(true)
    expect(apricartWarehouseUpdateSchema.safeParse({ status: "DELETED" }).success).toBe(false)
    expect(apricartWarehouseUpdateSchema.safeParse({ city: "" }).success).toBe(true)
  })

  it("takes a member's responsibility from the server, never the body", () => {
    const userId = "6f1c2b9e-3c1d-4a8e-9f0a-1b2c3d4e5f60"
    expect(apricartWarehouseMemberUpdateSchema.safeParse({ userId, assigned: true }).success).toBe(true)
    expect(apricartWarehouseMemberUpdateSchema.safeParse({ userId, assigned: true, responsibility: "EXECUTIVE" }).success).toBe(false)
    expect(apricartWarehouseMemberUpdateSchema.safeParse({ userId: "not-a-uuid", assigned: true }).success).toBe(false)
  })

  it("routes one organization's branches, as JSON integers, bounded and without duplicates", () => {
    expect(branchFulfillmentRoutesUpdateSchema.safeParse({ organizationId: 1, branchIds: [] }).success).toBe(true)
    expect(branchFulfillmentRoutesUpdateSchema.safeParse({ organizationId: "1", branchIds: [] }).success).toBe(false)
    expect(branchFulfillmentRoutesUpdateSchema.safeParse({ organizationId: 1, branchIds: [2, 2] }).success).toBe(false)
    expect(branchFulfillmentRoutesUpdateSchema.safeParse({ organizationId: 1, branchIds: [2_147_483_648] }).success).toBe(false)
    const tooMany = Array.from({ length: BRANCH_ROUTE_MAX_PER_ORGANIZATION + 1 }, (_, index) => index + 1)
    expect(branchFulfillmentRoutesUpdateSchema.safeParse({ organizationId: 1, branchIds: tooMany }).success).toBe(false)
  })
})

describe("the page's views", () => {
  it("lists the routed branches of one organization at one warehouse", () => {
    expect(routedBranchIdsInOrganization({
      routes: [{ branchId: 4, warehouseId: 1 }, { branchId: 2, warehouseId: 1 }, { branchId: 3, warehouseId: 2 }, { branchId: 9, warehouseId: 1 }],
      branchOrganization: new Map([[2, 10], [3, 10], [4, 10], [9, 20]]),
      warehouseId: 1,
      organizationId: 10,
    })).toEqual([2, 4])
  })

  it("suggests only unrouted branches whose staff agree on this warehouse, in this organization", () => {
    expect(suggestedBranchIdsFor({
      coverage: [
        { branchId: 5, organizationId: 10, kind: "SUGGESTED", suggestedWarehouseId: 1 },
        { branchId: 6, organizationId: 10, kind: "SUGGESTED", suggestedWarehouseId: 2 },
        { branchId: 7, organizationId: 20, kind: "SUGGESTED", suggestedWarehouseId: 1 },
        { branchId: 8, organizationId: 10, kind: "ROUTED", suggestedWarehouseId: null },
        { branchId: 1, organizationId: 10, kind: "SUGGESTED", suggestedWarehouseId: 1 },
      ],
      warehouseId: 1,
      organizationId: 10,
    })).toEqual([1, 5])
  })

  it("names inactive accounts that still hold assignments, and no others", () => {
    const members = [
      { id: "a", isActive: false, branchIds: [1], cityKeys: [] },
      { id: "b", isActive: false, branchIds: [], cityKeys: ["lahore"] },
      { id: "c", isActive: false, branchIds: [], cityKeys: [] },
      { id: "d", isActive: true, branchIds: [1], cityKeys: [] },
    ]
    expect(inactiveAccountsHoldingReach(members).map((member) => member.id)).toEqual(["a", "b"])
  })
})

describe("adding rules for several organizations and cities", () => {
  const cityOptions = [
    { organizationId: 1, cityKey: "karachi", label: "Karachi", branchCount: 3 },
    { organizationId: 1, cityKey: "lahore", label: "Lahore", branchCount: 1 },
    { organizationId: 2, cityKey: "karachi", label: "Karachi", branchCount: 2 },
    { organizationId: 3, cityKey: "quetta", label: "Quetta", branchCount: 1 },
  ]
  const rules = [
    { warehouseId: 1, organizationId: 1, cityKey: "karachi" },
    { warehouseId: 2, organizationId: 2, cityKey: "karachi" },
    { warehouseId: 2, organizationId: 2, cityKey: null },
  ]

  it("offers the chosen organizations' cities, counted across them", () => {
    expect(citiesOfOrganizations(cityOptions, [1, 2])).toEqual([
      { cityKey: "karachi", label: "Karachi", branchCount: 5, organizationCount: 2 },
      { cityKey: "lahore", label: "Lahore", branchCount: 1, organizationCount: 1 },
    ])
    expect(citiesOfOrganizations(cityOptions, [])).toEqual([])
  })

  it("plans one whole-organization rule per organization when no city is chosen", () => {
    expect(plannedRuleAdditions({ rules, cityOptions, warehouseId: 1, organizationIds: [3, 2, 1, 2], cityKeys: [] })).toEqual([
      { organizationId: 1, cityKey: null, fromWarehouseId: null },
      { organizationId: 2, cityKey: null, fromWarehouseId: 2 },
      { organizationId: 3, cityKey: null, fromWarehouseId: null },
    ])
  })

  it("plans only cities an organization has branches in, skipping rules this warehouse holds", () => {
    expect(plannedRuleAdditions({ rules, cityOptions, warehouseId: 1, organizationIds: [1, 2, 3], cityKeys: ["lahore", "karachi"] })).toEqual([
      { organizationId: 1, cityKey: "lahore", fromWarehouseId: null },
      { organizationId: 2, cityKey: "karachi", fromWarehouseId: 2 },
    ])
    expect(plannedRuleAdditions({ rules, cityOptions, warehouseId: 1, organizationIds: [1], cityKeys: ["karachi"] })).toEqual([])
    expect(plannedRuleAdditions({ rules, cityOptions, warehouseId: 1, organizationIds: [], cityKeys: ["karachi"] })).toEqual([])
  })
})
