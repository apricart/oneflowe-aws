import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  BRANCH_ROUTE_MAX_PER_ORGANIZATION,
  compareWarehouseReach,
  planCityRuleMigration,
  resolveBranchWarehouse,
  type CityRuleMigrationInput,
} from "@/lib/apricart-warehouses"
import {
  WAREHOUSE_ORDER_OWNERSHIP,
  WAREHOUSE_ORDER_OWNERSHIP_MODES,
  readsAccountAssignments,
  readsWarehouseMembership,
} from "@/lib/warehouse-ownership-policy"
import {
  apricartWarehouseMemberScopeSchema,
  warehouseRouteRuleUpdateSchema,
} from "@/lib/server/mutation-validation"

/** Phase 2 of plans/OF-WAREHOUSE-order-ownership-and-transfer.md: the pure rules. */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("the ownership mode", () => {
  // Production runs on each account's own assignments until
  // `npm run check:warehouse-ownership` reports no change for any account.
  // Moving this is a reviewed deploy, never a side effect of another change.
  it("ships as 'branch'", () => {
    expect(WAREHOUSE_ORDER_OWNERSHIP).toBe("branch")
  })

  it("is a code constant, not read from the environment", () => {
    const source = read("lib/warehouse-ownership-policy.ts")
    expect(source).not.toMatch(/process\.env/)
    expect(source).toContain('export const WAREHOUSE_ORDER_OWNERSHIP: WarehouseOrderOwnershipMode = "branch"')
  })

  it("reads assignments, membership or both, per mode", () => {
    expect(WAREHOUSE_ORDER_OWNERSHIP_MODES.map((mode) => [mode, readsAccountAssignments(mode), readsWarehouseMembership(mode)])).toEqual([
      ["branch", true, false],
      ["membership-fallback", true, true],
      ["membership", false, true],
    ])
  })
})

describe("resolveBranchWarehouse", () => {
  it("prefers a manual route, then the city rule, then the organization rule", () => {
    expect(resolveBranchWarehouse({ manualWarehouseId: 1, cityRuleWarehouseId: 2, organizationRuleWarehouseId: 3 })).toBe(1)
    expect(resolveBranchWarehouse({ manualWarehouseId: null, cityRuleWarehouseId: 2, organizationRuleWarehouseId: 3 })).toBe(2)
    expect(resolveBranchWarehouse({ manualWarehouseId: null, cityRuleWarehouseId: null, organizationRuleWarehouseId: 3 })).toBe(3)
    expect(resolveBranchWarehouse({ manualWarehouseId: null, cityRuleWarehouseId: null, organizationRuleWarehouseId: null })).toBeNull()
  })

  it("is stated in SQL by one expression with the same precedence", () => {
    const source = read("lib/server/branch-warehouse.ts")
    const expression = source.slice(source.indexOf("COALESCE("), source.indexOf(")`", source.indexOf("COALESCE(")))
    const manual = expression.indexOf("branch_fulfillment_routes")
    const city = expression.indexOf('wrr."city_key" = ')
    const organization = expression.indexOf('wrr."city_key" IS NULL')
    expect(manual).toBeGreaterThan(-1)
    expect(manual).toBeLessThan(city)
    expect(city).toBeLessThan(organization)
    // The city side is the shared key, never a second normalisation.
    expect(expression).toContain('branchCityKeySql(sql`"branches"."city"`)')
  })
})

describe("compareWarehouseReach", () => {
  it("lists only accounts whose branches differ, with what they lose and gain", () => {
    const current = new Map([["a", [1, 2, 3]], ["b", [4]], ["c", []]])
    const proposed = new Map([["a", [3, 2, 1]], ["b", [5, 4]], ["d", [9]]])
    expect(compareWarehouseReach(current, proposed)).toEqual([
      { accountId: "b", lost: [], gained: [5] },
      { accountId: "d", lost: [], gained: [9] },
    ])
  })

  it("treats an account missing from one side as reaching nothing there", () => {
    expect(compareWarehouseReach(new Map([["a", [1]]]), new Map())).toEqual([{ accountId: "a", lost: [1], gained: [] }])
    expect(compareWarehouseReach(new Map(), new Map())).toEqual([])
  })
})

/** The production shape on 2026-10-28: one Karachi account, one Lahore account, and a demo account with nothing. */
function productionLike(overrides: Partial<CityRuleMigrationInput> = {}): CityRuleMigrationInput {
  return {
    accounts: [
      { userId: "u-murtaza", username: "sheikh.murtaza", isActive: true, cityKeys: ["karachi"], organizationIds: [2, 6, 10, 11], branchIds: [] },
      { userId: "u-sohail", username: "sohail", isActive: true, cityKeys: ["lahore"], organizationIds: [7, 14, 45], branchIds: [] },
      { userId: "u-demo", username: "demo_warehouse", isActive: true, cityKeys: [], organizationIds: [], branchIds: [] },
    ],
    mapping: [{ username: "sheikh.murtaza", warehouseId: 1 }, { username: "sohail", warehouseId: 2 }],
    warehouses: [{ id: 1, code: "KARACHI-001", status: "ACTIVE" }, { id: 2, code: "LAHORE-001", status: "ACTIVE" }],
    existingRules: [],
    existingRoutes: [],
    existingMemberships: [],
    ...overrides,
  }
}

describe("planCityRuleMigration", () => {
  it("turns each account's cities × organizations into rules on its warehouse, and makes it an operator of all of it", () => {
    const plan = planCityRuleMigration(productionLike())
    expect(plan.refusals).toEqual([])
    expect(plan.rules).toEqual([
      { warehouseId: 1, organizationId: 2, cityKey: "karachi" },
      { warehouseId: 1, organizationId: 6, cityKey: "karachi" },
      { warehouseId: 2, organizationId: 7, cityKey: "lahore" },
      { warehouseId: 1, organizationId: 10, cityKey: "karachi" },
      { warehouseId: 1, organizationId: 11, cityKey: "karachi" },
      { warehouseId: 2, organizationId: 14, cityKey: "lahore" },
      { warehouseId: 2, organizationId: 45, cityKey: "lahore" },
    ])
    expect(plan.routes).toEqual([])
    expect(plan.memberships).toEqual([{ warehouseId: 1, userId: "u-murtaza" }, { warehouseId: 2, userId: "u-sohail" }])
  })

  it("keeps an organization chosen for a city even where it has no branch there yet, so its future branches stay covered", () => {
    const plan = planCityRuleMigration(productionLike())
    expect(plan.rules.filter((rule) => rule.warehouseId === 2)).toHaveLength(3)
  })

  it("turns single-branch assignments into manual routes", () => {
    const plan = planCityRuleMigration(productionLike({
      accounts: [{ userId: "u-x", username: "x", isActive: true, cityKeys: [], organizationIds: [], branchIds: [30, 12] }],
      mapping: [{ username: "x", warehouseId: 2 }],
    }))
    expect(plan.refusals).toEqual([])
    expect(plan.routes).toEqual([{ branchId: 12, warehouseId: 2 }, { branchId: 30, warehouseId: 2 }])
  })

  it("is idempotent: what exists is not planned again", () => {
    const first = planCityRuleMigration(productionLike())
    const second = planCityRuleMigration(productionLike({
      existingRules: first.rules,
      existingMemberships: first.memberships.map((membership) => ({ ...membership, responsibility: "WAREHOUSE_OPERATOR", branchScope: "ALL" })),
    }))
    expect(second).toEqual({ rules: [], routes: [], memberships: [], refusals: [] })
  })

  it("refuses an active account that serves branches but is not mapped", () => {
    const plan = planCityRuleMigration(productionLike({ mapping: [{ username: "sheikh.murtaza", warehouseId: 1 }] }))
    expect(plan.refusals).toEqual(["sohail serves branches and is not mapped to a warehouse"])
  })

  it("does not ask for an account that serves nothing (the demo account) to be mapped", () => {
    expect(planCityRuleMigration(productionLike()).refusals).toEqual([])
  })

  it("refuses an unknown username, an inactive account, an unknown or inactive warehouse, and two warehouses for one account", () => {
    const plan = planCityRuleMigration(productionLike({
      accounts: [
        ...productionLike().accounts,
        { userId: "u-old", username: "old", isActive: false, cityKeys: [], organizationIds: [], branchIds: [] },
      ],
      mapping: [
        { username: "sheikh.murtaza", warehouseId: 1 },
        { username: "sheikh.murtaza", warehouseId: 2 },
        { username: "sohail", warehouseId: 3 },
        { username: "ghost", warehouseId: 1 },
        { username: "old", warehouseId: 4 },
      ],
      warehouses: [...productionLike().warehouses, { id: 4, code: "OLD", status: "INACTIVE" }],
    }))
    expect(plan.refusals).toEqual(expect.arrayContaining([
      "sheikh.murtaza is mapped to two warehouses",
      "Warehouse 3 does not exist",
      "No warehouse account has the username ghost",
      "old is inactive",
      "Warehouse OLD is not active",
    ]))
  })

  it("refuses two accounts putting one organization and city into different warehouses", () => {
    const plan = planCityRuleMigration(productionLike({
      accounts: [
        ...productionLike().accounts,
        { userId: "u-twin", username: "twin", isActive: true, cityKeys: ["karachi"], organizationIds: [10], branchIds: [] },
      ],
      mapping: [...productionLike().mapping, { username: "twin", warehouseId: 2 }],
    }))
    expect(plan.refusals).toContain("sheikh.murtaza and twin put organization 10 in karachi into different warehouses")
  })

  it("accepts two accounts with the same reach on the same warehouse, writing each rule once", () => {
    const plan = planCityRuleMigration(productionLike({
      accounts: [
        ...productionLike().accounts,
        { userId: "u-twin", username: "twin", isActive: true, cityKeys: ["karachi"], organizationIds: [11, 10, 6, 2], branchIds: [] },
      ],
      mapping: [...productionLike().mapping, { username: "twin", warehouseId: 1 }],
    }))
    expect(plan.refusals).toEqual([])
    expect(plan.rules.filter((rule) => rule.organizationId === 10)).toEqual([{ warehouseId: 1, organizationId: 10, cityKey: "karachi" }])
  })

  it("refuses two accounts on one warehouse that serve different branches, since each would gain the other's", () => {
    // The shape the test-database rehearsal found: one serves 4038 and 4039, the other 4038 alone.
    const plan = planCityRuleMigration(productionLike({
      accounts: [
        { userId: "u-a", username: "a", isActive: true, cityKeys: [], organizationIds: [], branchIds: [4038, 4039] },
        { userId: "u-b", username: "b", isActive: true, cityKeys: [], organizationIds: [], branchIds: [4038] },
      ],
      mapping: [{ username: "a", warehouseId: 2 }, { username: "b", warehouseId: 2 }],
    }))
    expect(plan.refusals).toEqual([
      "a and b are mapped to warehouse 2 but serve different branches — each would gain the other's; map them to different warehouses",
    ])
  })

  it("refuses a rule or route already pointing at another warehouse", () => {
    const plan = planCityRuleMigration(productionLike({
      accounts: [
        { userId: "u-murtaza", username: "sheikh.murtaza", isActive: true, cityKeys: ["karachi"], organizationIds: [10], branchIds: [99] },
      ],
      mapping: [{ username: "sheikh.murtaza", warehouseId: 1 }],
      existingRules: [{ warehouseId: 2, organizationId: 10, cityKey: "karachi" }],
      existingRoutes: [{ branchId: 99, warehouseId: 2 }],
    }))
    expect(plan.refusals).toEqual([
      "Organization 10 in karachi already belongs to warehouse 2, not 1",
      "Branch 99 is already routed to warehouse 2, not 1",
    ])
  })

  it("refuses an existing selected-branches membership, which would narrow what the account sees", () => {
    const plan = planCityRuleMigration(productionLike({
      existingMemberships: [{ warehouseId: 1, userId: "u-murtaza", responsibility: "WAREHOUSE_OPERATOR", branchScope: "SELECTED" }],
    }))
    expect(plan.refusals).toEqual(["sheikh.murtaza works selected branches of warehouse 1; set it to all branches first"])
  })
})

describe("request bodies", () => {
  it("name one rule: an organization, a city or null for all of it, and whether it is assigned", () => {
    expect(warehouseRouteRuleUpdateSchema.parse({ organizationId: 10, city: " Karachi ", assigned: true }))
      .toEqual({ organizationId: 10, city: "Karachi", assigned: true })
    expect(warehouseRouteRuleUpdateSchema.safeParse({ organizationId: 10, city: null, assigned: false }).success).toBe(true)
    expect(warehouseRouteRuleUpdateSchema.safeParse({ organizationId: 10, city: "  ", assigned: true }).success).toBe(false)
    expect(warehouseRouteRuleUpdateSchema.safeParse({ organizationId: "10", city: null, assigned: true }).success).toBe(false)
    expect(warehouseRouteRuleUpdateSchema.safeParse({ organizationId: 10, assigned: true }).success).toBe(false)
    expect(warehouseRouteRuleUpdateSchema.safeParse({ organizationId: 10, city: null, assigned: true, warehouseId: 2 }).success).toBe(false)
  })

  it("set an operator to all branches, or one organization's selection, and nothing else", () => {
    const userId = "11111111-1111-4111-8111-111111111111"
    expect(apricartWarehouseMemberScopeSchema.safeParse({ userId, scope: "ALL" }).success).toBe(true)
    expect(apricartWarehouseMemberScopeSchema.safeParse({ userId, scope: "SELECTED", organizationId: 4, branchIds: [] }).success).toBe(true)
    expect(apricartWarehouseMemberScopeSchema.safeParse({ userId, scope: "SELECTED", organizationId: 4, branchIds: [7, 8] }).success).toBe(true)
    expect(apricartWarehouseMemberScopeSchema.safeParse({ userId, scope: "ALL", branchIds: [7] }).success).toBe(false)
    expect(apricartWarehouseMemberScopeSchema.safeParse({ userId, scope: "SELECTED", branchIds: [7] }).success).toBe(false)
    expect(apricartWarehouseMemberScopeSchema.safeParse({ userId, scope: "SELECTED", organizationId: 4, branchIds: [7, 7] }).success).toBe(false)
    expect(apricartWarehouseMemberScopeSchema.safeParse({ userId, scope: "SOME" }).success).toBe(false)
    expect(apricartWarehouseMemberScopeSchema.safeParse({ userId: "x", scope: "ALL" }).success).toBe(false)
    const tooMany = Array.from({ length: BRANCH_ROUTE_MAX_PER_ORGANIZATION + 1 }, (_, index) => index + 1)
    expect(apricartWarehouseMemberScopeSchema.safeParse({ userId, scope: "SELECTED", organizationId: 4, branchIds: tooMany }).success).toBe(false)
  })
})

describe("the reach switch", () => {
  // In the "branch" mode the loader must run exactly what production ran
  // before phase 2: the account's own assignments, nothing from warehouses.
  it("reads membership only outside the 'branch' mode, in the loader and both recipient lists", () => {
    const scope = read("lib/server/warehouse-scope.ts")
    expect(scope).toContain("readsAccountAssignments(mode) ? await loadAssignedBranchIds(client, userId, options) : []")
    expect(scope).toContain("if (readsWarehouseMembership(mode)) {")
    expect(read("lib/server/warehouse-order-notifications.ts")).toContain("readsWarehouseMembership(mode) ? await loadMembershipAccountIdsServingBranches(client, [branchId]) : []")
    expect(read("lib/server/support-notifications.ts")).toContain("readsWarehouseMembership(mode)")
  })

  it("never lets an empty OR match every warehouse user", () => {
    expect(read("lib/server/warehouse-order-notifications.ts")).toContain("if (!viaAssignments && viaWarehouses.length === 0) return []")
  })

  it("does not open the app's pool from the reach modules, so the ownership check can run from a script", () => {
    for (const path of ["lib/server/warehouse-scope.ts", "lib/server/branch-warehouse.ts", "lib/server/warehouse-ownership-check.ts"]) {
      expect(read(path), path).not.toMatch(/^import \{[^}]*\bdb\b[^}]*\} from "@\/lib\/db"/m)
    }
  })
})

describe("the migration", () => {
  const migration = read("drizzle/20261104120000_warehouse_route_rules.sql")
  // The header's rollback statements are comments; only the statements run.
  const statements = migration.split(/\r?\n/).filter((line) => !line.trim().startsWith("--")).join("\n")

  it("is additive, and every existing membership keeps meaning all branches", () => {
    expect(statements).toContain(`ADD COLUMN IF NOT EXISTS "branch_scope" varchar(16) DEFAULT 'ALL' NOT NULL`)
    // No statement removes or rewrites data ("ON UPDATE no action" in a key is not one).
    expect(statements).not.toMatch(/^\s*(DROP|UPDATE|DELETE|TRUNCATE)\b|ALTER TABLE [^;]* DROP /m)
    expect(read("drizzle/meta/_journal.json")).toContain('"20261104120000_warehouse_route_rules"')
  })

  it("allows one warehouse per organization, and per organization and city", () => {
    expect(migration).toContain(`"warehouse_route_rules_org_uq" ON "warehouse_route_rules" USING btree ("organization_id") WHERE "warehouse_route_rules"."city_key" IS NULL`)
    expect(migration).toContain(`"warehouse_route_rules_org_city_uq" ON "warehouse_route_rules" USING btree ("organization_id","city_key") WHERE "warehouse_route_rules"."city_key" IS NOT NULL`)
  })
})
