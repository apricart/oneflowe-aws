import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { APRICART_SUPPORT_API_RULES } from "@/lib/apricart-support-access"
import { mayCreateOrder } from "@/lib/order-creation-access"
import { canMutatePrices } from "@/lib/pricing-access"
import { isValidRole as isValidRbacRole } from "@/lib/rbac"
import {
  systemRoleSchema,
  warehouseBranchAssignmentsUpdateSchema,
  warehouseChallanAttachSchema,
  warehouseCityAssignmentBulkUpdateSchema,
  warehouseCityAssignmentUpdateSchema,
  warehouseCityOrganizationBulkUpdateSchema,
  warehouseCityOrganizationUpdateSchema,
  warehouseProgressSchema,
} from "@/lib/server/mutation-validation"
import { canAssignRole, canManageUser } from "@/lib/server/user-access-policy"
import {
  WAREHOUSE_API_RULES,
  WAREHOUSE_AREAS,
  WAREHOUSE_ASSIGNMENT_MAX_PER_ORGANIZATION,
  WAREHOUSE_CITY_BULK_MAX,
  WAREHOUSE_CITY_MAX_LENGTH,
  WAREHOUSE_CITY_ORGANIZATION_MAX_PER_USER,
  WAREHOUSE_HOME,
  WAREHOUSE_ROLE,
  canManageWarehouse,
  isWarehouseApiRequestAllowed,
  isWarehouseRole,
  resolveWarehouseReach,
  warehouseAccessChangeError,
  warehouseUserShapeError,
} from "@/lib/warehouse-access"

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/** Source with its comments removed, for assertions about what the code does rather than what it says. */
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

/** The read-only catalogue: Apricart's global products, so no branch reach applies. */
/** Apricart's own catalogue and taxonomy: no tenant data, so no branch fence. */
const WAREHOUSE_CATALOG_ROUTES = [
  "app/api/v1/warehouse/catalog/route.ts",
  "app/api/v1/warehouse/catalog/categories/route.ts",
  "app/api/v1/warehouse/catalog/taxonomy/categories/route.ts",
  "app/api/v1/warehouse/catalog/taxonomy/subcategories/route.ts",
]

/** The tenant-owned catalogue menus, each fenced to the organizations the warehouse serves. */
const WAREHOUSE_TENANT_CATALOG_ROUTES = [
  "app/api/v1/warehouse/catalog/organizations/route.ts",
  "app/api/v1/warehouse/catalog/organization-products/route.ts",
  "app/api/v1/warehouse/catalog/group-products/route.ts",
  "app/api/v1/warehouse/catalog/price-history/route.ts",
  "app/api/v1/warehouse/catalog/product-requests/route.ts",
]

describe("the Warehouse role", () => {
  it("is a known role everywhere roles are listed", () => {
    expect(isValidRbacRole(WAREHOUSE_ROLE)).toBe(true)
    expect(systemRoleSchema.safeParse(WAREHOUSE_ROLE).success).toBe(true)
    // lib/auth.ts falls back to BRANCH_ADMIN for an unknown role, so a role
    // missing from its list would quietly become a branch administrator.
    expect(read("lib/auth.ts")).toContain("'WAREHOUSE'")
    expect(read("drizzle/20261011120000_add_warehouse_role.sql")).toContain("SELECT 'WAREHOUSE'")
    expect(read("lib/permissions.ts")).toMatch(/WAREHOUSE: \{\s*name: "Warehouse \(Apricart\)"/)
  })

  it("creates no orders and writes no prices", () => {
    expect(mayCreateOrder(WAREHOUSE_ROLE)).toBe(false)
    expect(canMutatePrices(WAREHOUSE_ROLE)).toBe(false)
  })

  it("is created and managed by Super Admin only", () => {
    expect(canAssignRole("SUPER_ADMIN", "WAREHOUSE")).toBe(true)
    expect(canManageUser("SUPER_ADMIN", "WAREHOUSE")).toBe(true)
    for (const actor of ["HEAD_OFFICE", "GROUP_USER", "BRANCH_ADMIN", "ORDER_DESK", "APRICART_EXECUTIVE"] as const) {
      expect(canAssignRole(actor, "WAREHOUSE"), actor).toBe(false)
      expect(canManageUser(actor, "WAREHOUSE"), actor).toBe(false)
    }
    expect(canManageWarehouse("SUPER_ADMIN")).toBe(true)
    expect(canManageWarehouse("HEAD_OFFICE")).toBe(false)
    expect(canManageWarehouse(undefined)).toBe(false)
  })

  it("is recognised only by its exact name", () => {
    expect(isWarehouseRole("WAREHOUSE")).toBe(true)
    for (const role of ["warehouse", "WAREHOUSE ", "ORDER_DESK", null, undefined, 1]) {
      expect(isWarehouseRole(role)).toBe(false)
    }
  })
})

describe("accounts", () => {
  it("carry no organization and no branch", () => {
    expect(warehouseUserShapeError(null, null)).toBeNull()
    expect(warehouseUserShapeError(3, null)).toMatch(/not given an organization or branch/)
    expect(warehouseUserShapeError(null, 9)).toMatch(/not given an organization or branch/)
  })

  it("are never switched into or out of the role", () => {
    expect(warehouseAccessChangeError("WAREHOUSE", { role: "HEAD_OFFICE" })).toMatch(/cannot be switched/)
    expect(warehouseAccessChangeError("BRANCH_ADMIN", { role: "WAREHOUSE" })).toMatch(/cannot be switched/)
  })

  it.each([
    { organizationId: 3 },
    { branchId: 9 },
    { branchIds: [9] },
    { groupIds: [1] },
    { budgetAllocationEnabled: true },
  ])("take no reach through the access route: %o", (input) => {
    expect(warehouseAccessChangeError("WAREHOUSE", input)).toMatch(/assigned from Warehouse Team/)
  })

  it("leave activation alone, and every other role untouched", () => {
    expect(warehouseAccessChangeError("WAREHOUSE", {})).toBeNull()
    expect(warehouseAccessChangeError("WAREHOUSE", { role: "WAREHOUSE" })).toBeNull()
    expect(warehouseAccessChangeError("HEAD_OFFICE", { organizationId: 3 })).toBeNull()
  })
})

describe("branch reach", () => {
  const warehouse = { role: "WAREHOUSE", isActive: true, deleted: false }

  it("is the assigned branches, unique and sorted", () => {
    expect(resolveWarehouseReach({ account: warehouse, assignedBranchIds: [21, 4, 21] })).toEqual([4, 21])
  })

  it("is empty with no assignment, never widened", () => {
    expect(resolveWarehouseReach({ account: warehouse, assignedBranchIds: [] })).toEqual([])
  })

  it.each([
    ["no account row", null],
    ["a deactivated account", { ...warehouse, isActive: false }],
    ["a deleted account", { ...warehouse, deleted: true }],
    ["an account moved to another role", { ...warehouse, role: "BRANCH_ADMIN" }],
    ["an Order Desk account", { ...warehouse, role: "ORDER_DESK" }],
  ])("is empty for %s, whatever is assigned", (_label, account) => {
    expect(resolveWarehouseReach({ account, assignedBranchIds: [4, 21] })).toEqual([])
  })

  it("drops ids that are not positive integers", () => {
    expect(resolveWarehouseReach({ account: warehouse, assignedBranchIds: [0, -2, 1.5, 7] })).toEqual([7])
  })

  it("is stored per branch, with no organization-wide row", () => {
    const migration = read("drizzle/20261011120000_add_warehouse_role.sql")
    expect(migration).toContain('"branch_id" integer NOT NULL')
    expect(migration).not.toMatch(/"warehouse_assignments"[\s\S]*"organization_id"/)
    expect(migration).toContain('"warehouse_assignments_user_branch_uq" ON "warehouse_assignments" USING btree ("user_id","branch_id")')
  })

  /**
   * Who may give a warehouse a branch. Super Admin on Warehouse Team, and a
   * department sign-up's approval for the branch it has just created, to the
   * warehouses already serving that city (plans/OF-JOIN-new-branch-city-warehouse.md).
   * A new writer goes on this list deliberately, or not at all.
   */
  it("is written only by Warehouse Team and the join approval's city attachment", () => {
    const writers: string[] = []
    const walk = (current: string) => {
      for (const entry of readdirSync(current)) {
        if (entry === "node_modules" || entry === ".next") continue
        const path = join(current, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)
          && /\.insert\(\s*warehouseAssignments\s*\)/.test(readFileSync(path, "utf8"))) {
          writers.push(relative(process.cwd(), path).split("\\").join("/"))
        }
      }
    }
    for (const root of ["app", "lib", "scripts"]) walk(resolve(process.cwd(), root))
    expect(writers.sort((a, b) => a.localeCompare(b))).toEqual([
      "lib/server/warehouse-city-coverage.ts",
      "lib/server/warehouse-team.ts",
    ])

    const attach = code("lib/server/warehouse-city-coverage.ts")
    // Additive only, matched by the one city key, serialized against Super
    // Admin's replacement, and audited as Super Admin's assignment is.
    expect(attach).not.toMatch(/\.delete\(\s*warehouseAssignments\s*\)/)
    expect(attach).toContain("branchCityKeySql(")
    expect(attach).toContain('.for("share")')
    expect(attach).toContain("action: WAREHOUSE_ASSIGNMENT_AUDIT_ACTION")
  })
})

describe("request bodies", () => {
  it("make the challan optional when delivering, and refuse it at any other stage", () => {
    expect(warehouseProgressSchema.safeParse({ fulfillmentStatus: "DELIVERED" }).success).toBe(true)
    expect(warehouseProgressSchema.safeParse({ fulfillmentStatus: "DELIVERED", deliveryChallanId: 5 }).success).toBe(true)
    expect(warehouseProgressSchema.safeParse({ fulfillmentStatus: "IN_PROCESS" }).success).toBe(true)
    expect(warehouseProgressSchema.safeParse({ fulfillmentStatus: "IN_PROCESS", deliveryChallanId: 5 }).success).toBe(false)
    expect(warehouseProgressSchema.safeParse({ fulfillmentStatus: "OUT_FOR_DELIVERY", deliveryChallanId: 5 }).success).toBe(false)
  })

  it("refuse a step back, an unknown stage and any extra field", () => {
    expect(warehouseProgressSchema.safeParse({ fulfillmentStatus: "NOT_STARTED" }).success).toBe(false)
    expect(warehouseProgressSchema.safeParse({ fulfillmentStatus: "FULFILLED" }).success).toBe(false)
    expect(warehouseProgressSchema.safeParse({ fulfillmentStatus: "DELIVERED", status: "FULFILLED" }).success).toBe(false)
    expect(warehouseProgressSchema.safeParse({ fulfillmentStatus: "DELIVERED", deliveryChallanId: 0 }).success).toBe(false)
    expect(warehouseChallanAttachSchema.safeParse({ deliveryChallanId: 3 }).success).toBe(true)
    expect(warehouseChallanAttachSchema.safeParse({}).success).toBe(false)
    expect(warehouseChallanAttachSchema.safeParse({ deliveryChallanId: 3, orderId: 4 }).success).toBe(false)
  })

  it("replace one organization's branches at a time, bounded and without duplicates", () => {
    expect(warehouseBranchAssignmentsUpdateSchema.safeParse({ organizationId: 1, branchIds: [] }).success).toBe(true)
    expect(warehouseBranchAssignmentsUpdateSchema.safeParse({ organizationId: 1, branchIds: [4, 5] }).success).toBe(true)
    expect(warehouseBranchAssignmentsUpdateSchema.safeParse({ branchIds: [4] }).success).toBe(false)
    expect(warehouseBranchAssignmentsUpdateSchema.safeParse({ organizationId: 1, branchIds: [4, 4] }).success).toBe(false)
    expect(warehouseBranchAssignmentsUpdateSchema.safeParse({ organizationId: 1, branchIds: [4], userId: "x" }).success).toBe(false)
    const tooMany = Array.from({ length: WAREHOUSE_ASSIGNMENT_MAX_PER_ORGANIZATION + 1 }, (_, index) => index + 1)
    expect(warehouseBranchAssignmentsUpdateSchema.safeParse({ organizationId: 1, branchIds: tooMany }).success).toBe(false)
  })

  it("change one whole city at a time, named by any spelling, and nothing else", () => {
    expect(warehouseCityAssignmentUpdateSchema.parse({ city: "  Karachi ", assigned: true })).toEqual({ city: "Karachi", assigned: true })
    expect(warehouseCityAssignmentUpdateSchema.safeParse({ city: "karachi", assigned: false }).success).toBe(true)
    expect(warehouseCityAssignmentUpdateSchema.safeParse({ city: "   ", assigned: true }).success).toBe(false)
    expect(warehouseCityAssignmentUpdateSchema.safeParse({ city: "Karachi" }).success).toBe(false)
    expect(warehouseCityAssignmentUpdateSchema.safeParse({ city: "Karachi", assigned: "true" }).success).toBe(false)
    expect(warehouseCityAssignmentUpdateSchema.safeParse({ city: ["Karachi"], assigned: true }).success).toBe(false)
    expect(warehouseCityAssignmentUpdateSchema.safeParse({ city: "Karachi", assigned: true, branchIds: [4] }).success).toBe(false)
    expect(warehouseCityAssignmentUpdateSchema.safeParse({ city: "x".repeat(WAREHOUSE_CITY_MAX_LENGTH + 1), assigned: true }).success).toBe(false)
  })

  it("choose one organization for the cities at a time, as a JSON integer, and nothing else", () => {
    expect(warehouseCityOrganizationUpdateSchema.parse({ organizationId: 7, assigned: true })).toEqual({ organizationId: 7, assigned: true })
    expect(warehouseCityOrganizationUpdateSchema.safeParse({ organizationId: 7, assigned: false }).success).toBe(true)
    expect(warehouseCityOrganizationUpdateSchema.safeParse({ organizationId: "7", assigned: true }).success).toBe(false)
    expect(warehouseCityOrganizationUpdateSchema.safeParse({ organizationId: 0, assigned: true }).success).toBe(false)
    expect(warehouseCityOrganizationUpdateSchema.safeParse({ organizationId: 1.5, assigned: true }).success).toBe(false)
    expect(warehouseCityOrganizationUpdateSchema.safeParse({ organizationId: 7 }).success).toBe(false)
    expect(warehouseCityOrganizationUpdateSchema.safeParse({ organizationIds: [7], assigned: true }).success).toBe(false)
    expect(warehouseCityOrganizationUpdateSchema.safeParse({ organizationId: 7, assigned: true, city: "Karachi" }).success).toBe(false)
  })

  it("change several cities or organizations at once, bounded, and nothing else", () => {
    expect(warehouseCityAssignmentBulkUpdateSchema.parse({ cities: [" Karachi ", "lahore"], assigned: true }))
      .toEqual({ cities: ["Karachi", "lahore"], assigned: true })
    expect(warehouseCityAssignmentBulkUpdateSchema.safeParse({ cities: [], assigned: true }).success).toBe(false)
    expect(warehouseCityAssignmentBulkUpdateSchema.safeParse({ cities: ["  "], assigned: true }).success).toBe(false)
    expect(warehouseCityAssignmentBulkUpdateSchema.safeParse({ cities: ["Karachi"] }).success).toBe(false)
    expect(warehouseCityAssignmentBulkUpdateSchema.safeParse({ cities: ["Karachi"], assigned: true, city: "Lahore" }).success).toBe(false)
    expect(warehouseCityAssignmentBulkUpdateSchema.safeParse({
      cities: Array.from({ length: WAREHOUSE_CITY_BULK_MAX + 1 }, (_, index) => `City ${index}`),
      assigned: true,
    }).success).toBe(false)
    // The largest body the schema admits still fits under the WAF's 8 KB.
    const largest = { cities: Array.from({ length: WAREHOUSE_CITY_BULK_MAX }, () => "x".repeat(WAREHOUSE_CITY_MAX_LENGTH)), assigned: false }
    expect(warehouseCityAssignmentBulkUpdateSchema.safeParse(largest).success).toBe(true)
    expect(JSON.stringify(largest).length).toBeLessThan(8 * 1024)

    expect(warehouseCityOrganizationBulkUpdateSchema.parse({ organizationIds: [7, 3], assigned: false }))
      .toEqual({ organizationIds: [7, 3], assigned: false })
    expect(warehouseCityOrganizationBulkUpdateSchema.safeParse({ organizationIds: [], assigned: true }).success).toBe(false)
    expect(warehouseCityOrganizationBulkUpdateSchema.safeParse({ organizationIds: [7, 7], assigned: true }).success).toBe(false)
    expect(warehouseCityOrganizationBulkUpdateSchema.safeParse({ organizationIds: ["7"], assigned: true }).success).toBe(false)
    expect(warehouseCityOrganizationBulkUpdateSchema.safeParse({ organizationIds: [0], assigned: true }).success).toBe(false)
    expect(warehouseCityOrganizationBulkUpdateSchema.safeParse({ organizationIds: [7], assigned: true, organizationId: 7 }).success).toBe(false)
    const tooMany = Array.from({ length: WAREHOUSE_CITY_ORGANIZATION_MAX_PER_USER + 1 }, (_, index) => index + 1)
    expect(warehouseCityOrganizationBulkUpdateSchema.safeParse({ organizationIds: tooMany, assigned: true }).success).toBe(false)
  })
})

describe("whole-city assignments", () => {
  // The key is computed in SQL in three places that must agree exactly: the
  // fragment every query uses, the expression index in the schema, and the
  // index the migration creates. If they drift the index silently stops being
  // used. See plans/OF-WAREHOUSE-city-assignments.md.
  const expression = "lower(btrim(regexp_replace(${value}, '\\\\s+', ' ', 'g')))"

  it("computes the city key in one SQL fragment, mirrored by the expression index", () => {
    expect(read("lib/server/branch-city-key.ts")).toContain(expression)
    expect(read("db/schema.ts")).toContain(
      "index(\"branches_city_key_idx\").on(sql`lower(btrim(regexp_replace(${t.city}, '\\\\s+', ' ', 'g')))`)",
    )
    expect(read("drizzle/20261013120000_add_warehouse_city_assignments.sql")).toContain(
      `"branches_city_key_idx" ON "branches" USING btree (lower(btrim(regexp_replace("city", '\\s+', ' ', 'g'))))`,
    )
  })

  it("stores a city key per user, never branch ids or an organization", () => {
    const migration = read("drizzle/20261013120000_add_warehouse_city_assignments.sql")
    const table = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS "warehouse_city_assignments"'))
    expect(table).toContain('"city_key" varchar(100) NOT NULL')
    expect(table.slice(0, table.indexOf(");"))).not.toMatch(/"branch_id"|"organization_id"/)
    expect(migration).toContain('"warehouse_city_assignments_user_city_uq" ON "warehouse_city_assignments" USING btree ("user_id","city_key")')
  })

  it("scopes cities to organizations in a table of their own, backfilled by the same city key", () => {
    const migration = read("drizzle/20261027120000_warehouse_city_organizations.sql")
    const table = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS "warehouse_city_organizations"'))
    expect(table.slice(0, table.indexOf(");"))).toContain('"organization_id" integer NOT NULL')
    expect(table.slice(0, table.indexOf(");"))).not.toMatch(/"branch_id"|"city_key"/)
    expect(migration).toContain('"warehouse_city_organizations_user_org_uq" ON "warehouse_city_organizations" USING btree ("user_id","organization_id")')
    // The backfill keeps every branch reached today: each city's current organizations.
    expect(migration).toContain(`ON lower(btrim(regexp_replace(b."city", '\\s+', ' ', 'g'))) = wca."city_key"`)
    expect(read("drizzle/meta/_journal.json")).toContain('"20261027120000_warehouse_city_organizations"')
  })

  it("is read with the branch assignments by the one reach loader, locked inside a write", () => {
    const scope = read("lib/server/warehouse-scope.ts")
    expect(scope).toContain("innerJoin(branches, warehouseCityBranchOn())")
    expect(scope).toContain("innerJoin(warehouseCityOrganizations, warehouseCityOrganizationOn())")
    expect(scope).toContain('cityQuery.for("share", { of: [warehouseCityAssignments, warehouseCityOrganizations] })')
    expect(scope).toContain("assignedBranchIds: [...assignments, ...cityBranches].map((row) => row.branchId)")
  })

  // A city rule reaches only the branches of the organizations chosen for the
  // same user (plans/OF-WAREHOUSE-city-assignments-by-organization.md). Every
  // module that reads warehouse_city_assignments applies that intersection; a
  // new reader goes on this list, or it would reach every organization again.
  it("is intersected with the chosen organizations by every reader", () => {
    const rule = code("lib/server/warehouse-city-rule.ts")
    expect(rule).toContain("eq(branchCityKeySql(branches.city), warehouseCityAssignments.cityKey)")
    expect(rule).toContain("eq(warehouseCityOrganizations.userId, warehouseCityAssignments.userId)")
    expect(rule).toContain("eq(warehouseCityOrganizations.organizationId, branches.organizationId)")

    const readers: string[] = []
    const walk = (current: string) => {
      for (const entry of readdirSync(current)) {
        if (entry === "node_modules" || entry === ".next") continue
        const path = join(current, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)
          && /\.from\(\s*warehouseCityAssignments\s*\)|FROM \$\{warehouseCityAssignments\}/.test(code(path))) {
          readers.push(relative(process.cwd(), path).split("\\").join("/"))
        }
      }
    }
    for (const root of ["app", "lib", "scripts"]) walk(resolve(process.cwd(), root))
    expect(readers.sort((a, b) => a.localeCompare(b))).toEqual([
      "lib/server/support-notifications.ts",
      "lib/server/warehouse-city-coverage.ts",
      "lib/server/warehouse-order-notifications.ts",
      "lib/server/warehouse-scope.ts",
      "lib/server/warehouse-team.ts",
    ])

    // The reach and both recipient lists match a branch through the shared rule.
    for (const path of [
      "lib/server/warehouse-scope.ts",
      "lib/server/warehouse-order-notifications.ts",
      "lib/server/support-notifications.ts",
    ]) {
      const source = code(path)
      expect(source, path).toContain("innerJoin(branches, warehouseCityBranchOn())")
      expect(source, path).toContain("innerJoin(warehouseCityOrganizations, warehouseCityOrganizationOn())")
      expect(source, path).not.toContain("branchCityKeySql(branches.city), warehouseCityAssignments.cityKey")
    }
    // The join coverage matches by key for one organization; both its queries are fenced to it.
    const coverage = code("lib/server/warehouse-city-coverage.ts")
    expect(coverage).toContain("AND ${warehouseCityOrganizations.organizationId} = ${organizationId}")
    expect(coverage).toContain("eq(warehouseCityOrganizations.organizationId, input.organizationId)")
    // The team page checks a new city against the chosen organizations.
    expect(code("lib/server/warehouse-team.ts")).toContain("eq(warehouseCityOrganizations.organizationId, branches.organizationId)")
  })
})

/**
 * A support handler on the warehouse's list: the support rule is
 * lib/support-access.ts's, and the warehouse's branches are loaded into the
 * viewer, or its queue reads nothing (plans/OF-WAREHOUSE-support-queue.md).
 */
function expectSupportHandler(rule: { route: string; methods: readonly string[] }, source: string) {
  expect(source, rule.route).toContain("isSupportParticipantRole(")
  expect(source, rule.route).toContain("await withSupportReach(")
  for (const method of rule.methods) {
    expect(source, `${rule.route} ${method}`).toMatch(new RegExp(`export async function ${method}\\b`))
  }
}

describe("the API allowlist", () => {
  it.each([
    ["GET", "/api/v1/warehouse/orders"],
    ["GET", "/api/v1/warehouse/orders/"],
    ["GET", "/api/v1/warehouse/orders/42"],
    ["POST", "/api/v1/warehouse/orders/42/progress"],
    ["GET", "/api/v1/warehouse/orders/42/timeline"],
    ["GET", "/api/v1/warehouse/orders/42/invoice"],
    ["GET", "/api/v1/warehouse/orders/42/delivery-challan"],
    ["POST", "/api/v1/warehouse/orders/42/delivery-challan"],
    ["GET", "/api/v1/warehouse/orders/42/delivery-challan/7/file"],
    ["GET", "/api/v1/warehouse/orders/42/intake-screenshot"],
    ["GET", "/api/v1/warehouse/workload"],
    ["GET", "/api/v1/warehouse/notifications"],
    ["PATCH", "/api/v1/warehouse/notifications"],
    ["GET", "/api/v1/warehouse/catalog"],
    ["GET", "/api/v1/warehouse/catalog/categories"],
    ["GET", "/api/v1/warehouse/catalog/taxonomy/categories"],
    ["GET", "/api/v1/warehouse/catalog/taxonomy/subcategories"],
    ["GET", "/api/v1/warehouse/catalog/organizations"],
    ["GET", "/api/v1/warehouse/catalog/organization-products"],
    ["GET", "/api/v1/warehouse/catalog/group-products"],
    ["GET", "/api/v1/warehouse/catalog/price-history"],
    ["GET", "/api/v1/warehouse/catalog/product-requests"],
    ["GET", "/api/v1/images/products/0f8fad5b-d9cb-469f-a165-70867728950e.webp"],
    ["POST", "/api/v1/upload/image"],
    ["POST", "/api/v1/users/me/change-password"],
    // The support queue of its branches (plans/OF-WAREHOUSE-support-queue.md).
    ["GET", "/api/v1/support/threads"],
    ["GET", "/api/v1/support/threads/42"],
    ["PATCH", "/api/v1/support/threads/42"],
    ["POST", "/api/v1/support/threads/42/messages"],
    ["GET", "/api/v1/support/stats"],
    ["POST", "/api/v1/support/attachments"],
    ["GET", "/api/v1/support/attachments/7"],
  ])("admits %s %s", (method, path) => {
    expect(isWarehouseApiRequestAllowed(method, path)).toBe(true)
  })

  it.each([
    ["GET", "/api/v1/orders"],
    ["GET", "/api/v1/orders/42"],
    ["POST", "/api/v1/orders"],
    ["POST", "/api/v1/orders/42/fulfillment-status"],
    ["POST", "/api/v1/orders/42/fulfill"],
    ["POST", "/api/v1/orders/42/approve"],
    ["POST", "/api/v1/orders/42/payment-status"],
    ["POST", "/api/v1/orders/42/refunds"],
    ["POST", "/api/v1/orders/42/delivery-challan"],
    ["GET", "/api/v1/orders/42/delivery-challan/7/file"],
    // The order readers' screenshot route; the warehouse has its own.
    ["GET", "/api/v1/orders/42/intake-screenshot"],
    ["POST", "/api/v1/warehouse/orders/42/intake-screenshot"],
    ["GET", "/api/v1/warehouse/orders/abc/intake-screenshot"],
    ["GET", "/api/v1/order-desk/orders/42/attachment"],
    ["GET", "/api/v1/delivery-dashboard"],
    ["GET", "/api/v1/warehouse-team"],
    ["PUT", "/api/v1/warehouse-team/abc/branches"],
    ["PUT", "/api/v1/warehouse-team/abc/cities"],
    ["PUT", "/api/v1/warehouse-team/abc/city-organizations"],
    ["POST", "/api/v1/warehouse/orders/42"],
    ["PUT", "/api/v1/warehouse/orders/42/progress"],
    ["POST", "/api/v1/warehouse/orders/abc/progress"],
    ["POST", "/api/v1/warehouse/orders/42/progress/extra"],
    ["POST", "/api/v1/warehouse/orders/42/fulfil"],
    // The Stock tab is gone; the catalogue replaced it and writes nothing.
    ["GET", "/api/v1/warehouse/stock"],
    ["POST", "/api/v1/warehouse/catalog"],
    ["PATCH", "/api/v1/warehouse/catalog"],
    ["DELETE", "/api/v1/warehouse/catalog"],
    ["POST", "/api/v1/warehouse/catalog/categories"],
    ["GET", "/api/v1/warehouse/catalog/categories/3"],
    // Every catalogue menu is read-only: no write verb reaches any of them.
    ["POST", "/api/v1/warehouse/catalog/organization-products"],
    ["PUT", "/api/v1/warehouse/catalog/group-products"],
    ["PATCH", "/api/v1/warehouse/catalog/product-requests"],
    ["DELETE", "/api/v1/warehouse/catalog/taxonomy/categories"],
    ["POST", "/api/v1/warehouse/catalog/price-history"],
    ["GET", "/api/v1/warehouse/catalog/organization-products/3"],
    // Super Admin's own catalogue endpoints stay closed: they write.
    ["GET", "/api/v1/admin/organization-assignments"],
    ["GET", "/api/v1/admin/product-price-history"],
    ["GET", "/api/v1/head-office/branch-assignments"],
    ["GET", "/api/v1/product-requests"],
    ["GET", "/api/v1/groups"],
    // Super Admin's catalogue, taxonomy and price screens stay closed.
    ["GET", "/api/v1/admin/global-inventory"],
    ["PUT", "/api/v1/admin/global-inventory"],
    ["GET", "/api/v1/categories"],
    ["GET", "/api/v1/subcategories"],
    ["GET", "/api/v1/inventory/price-history"],
    // Only a product picture, in exactly the shape the image route serves.
    ["POST", "/api/v1/images/products/0f8fad5b-d9cb-469f-a165-70867728950e.webp"],
    ["GET", "/api/v1/images/support/0f8fad5b-d9cb-469f-a165-70867728950e.png"],
    ["GET", "/api/v1/images/order-intake/0f8fad5b-d9cb-469f-a165-70867728950e.png"],
    ["GET", "/api/v1/images/delivery-challan/0f8fad5b-d9cb-469f-a165-70867728950e.pdf"],
    ["GET", "/api/v1/images/products/0f8fad5b-d9cb-469f-a165-70867728950e.svg"],
    ["GET", "/api/v1/images/products/../support/0f8fad5b-d9cb-469f-a165-70867728950e.png"],
    ["GET", "/api/v1/images/products/not-a-uuid.png"],
    // The tenant invoice routes stay closed; the warehouse has its own.
    ["GET", "/api/v1/receipts/42"],
    ["GET", "/api/v1/receipts/42/download"],
    ["POST", "/api/v1/warehouse/orders/42/invoice"],
    ["GET", "/api/v1/warehouse/orders/abc/invoice"],
    ["GET", "/api/v1/inventory/global-products"],
    ["GET", "/api/v1/users"],
    ["GET", "/api/v1/notifications"],
    ["PATCH", "/api/v1/notifications"],
    ["POST", "/api/v1/warehouse/notifications"],
    ["DELETE", "/api/v1/warehouse/notifications"],
    ["PATCH", "/api/v1/warehouse/notifications/3"],
    ["GET", "/api/v1/upload/image"],
    // It answers its branches' threads; it raises none, and the product picker
    // belongs to raising one. Only the verbs the support pages use.
    ["POST", "/api/v1/support/threads"],
    ["GET", "/api/v1/support/products"],
    ["DELETE", "/api/v1/support/threads/42"],
    ["GET", "/api/v1/support/threads/42/messages"],
    ["GET", "/api/v1/support/threads/abc"],
    ["GET", "/api/v1/support/attachments/7/raw"],
    ["GET", "/api/v1/images/support/0f8fad5b-d9cb-469f-a165-70867728950e.png"],
  ])("refuses %s %s", (method, path) => {
    expect(isWarehouseApiRequestAllowed(method, path)).toBe(false)
  })

  it("names only handlers that exist and check the role and the reach themselves", () => {
    for (const rule of WAREHOUSE_API_RULES) {
      expect(existsSync(resolve(process.cwd(), rule.route)), rule.route).toBe(true)
      const source = read(rule.route)
      if (rule.route.startsWith("app/api/v1/warehouse/")) {
        expect(source, rule.route).toContain('requireApiRole(["WAREHOUSE"])')
        if (!WAREHOUSE_CATALOG_ROUTES.includes(rule.route)) {
          // Every order read or write is fenced to the user's branches.
          expect(source, rule.route).toMatch(/loadWarehouseReach\(|loadWarehouseOrderInReach\(|isOrderInWarehouseReach\(|loadWarehouseOrderReach\(|listWarehouseOrders\(|loadWarehouseOrder\(|loadWarehouseCatalogFence\(/)
        }
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
          const exported = new RegExp(`export async function ${method}\\b`).test(source)
          expect(exported, `${rule.route} ${method}`).toBe(rule.methods.includes(method))
        }
      } else if (rule.route.startsWith("app/api/v1/support/")) {
        expectSupportHandler(rule, source)
      } else if (rule.route === "app/api/v1/upload/image/route.ts") {
        // The challan, and only for an order at a branch it serves.
        expect(source).toContain("warehouseChallanUploadRefusal(actor.id, orderId)")
      } else if (rule.route === "app/api/v1/images/[...key]/route.ts") {
        // A product picture only: the handler serves the `products/` key shape
        // and nothing else, whatever the allowlist pattern admits.
        expect(source).toContain("isValidImageKey(key)")
        expect(rule.methods).toEqual(["GET"])
        expect(source).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)\b/)
      } else {
        expect(rule.route).toMatch(/^app\/api\/v1\/users\/me\//)
      }
    }
  })

  it("covers every handler under app/api/v1/warehouse", () => {
    const root = resolve(process.cwd(), "app/api/v1/warehouse")
    const found: string[] = []
    const walk = (current: string) => {
      for (const entry of readdirSync(current)) {
        const path = join(current, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (entry === "route.ts") found.push(relative(process.cwd(), path).split("\\").join("/"))
      }
    }
    walk(root)
    const listed = new Set(WAREHOUSE_API_RULES.map((rule) => rule.route))
    expect(found.filter((route) => !listed.has(route))).toEqual([])
  })

  it("never reaches fulfilment, a decision, payment or a refund", () => {
    const root = resolve(process.cwd(), "app/api/v1/warehouse")
    const sources: string[] = []
    const walk = (current: string) => {
      for (const entry of readdirSync(current)) {
        const path = join(current, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (entry === "route.ts") sources.push(readFileSync(path, "utf8"))
      }
    }
    walk(root)
    for (const source of sources) {
      expect(source).not.toMatch(/fulfillApprovedOrder|approveOrder|rejectOrder|returnOrderForCorrection|paymentStatus:|refunds\b|replaceDeliveryChallan/)
    }
  })
})

describe("the product catalogue", () => {
  it("is read-only: each handler exports GET alone and the proxy admits GET alone", () => {
    for (const route of WAREHOUSE_CATALOG_ROUTES) {
      const source = read(route)
      expect(source, route).toMatch(/export async function GET\b/)
      expect(source, route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)\b/)
      expect(WAREHOUSE_API_RULES.find((rule) => rule.route === route)?.methods, route).toEqual(["GET"])
    }
  })

  // Reversed deliberately by plans/OF-WAREHOUSE-full-read-only-catalog.md: the
  // product owner chose to show prices exactly as Super Admin's catalogue does.
  // The global reads still carry no tax rate or discount (Super Admin's list
  // shows neither), and still join no tenant's catalogue — that is the fenced
  // tenant module's job alone.
  it("shows the global base price, but no tax rate, discount or tenant row", () => {
    const reads = code("lib/server/warehouse-catalog.ts")
    expect(reads).toMatch(/basePriceCents: globalProducts\.basePrice/)
    expect(reads).not.toMatch(/taxRateBp|tax_rate|discount/i)
    expect(reads).not.toMatch(/organizationInventory|branchInventory|groupInventory|effective-price/)
  })

  // Prices are shown since plans/OF-WAREHOUSE-full-read-only-catalog.md; what
  // stays pinned is that no catalogue view can write anything.
  it("replaces the Stock tab in the workspace, and no catalogue view has a write control", () => {
    const workspace = read("components/warehouse/warehouse-workspace.tsx")
    expect(workspace).toContain("<WarehouseCatalog />")
    expect(workspace).not.toMatch(/WarehouseStock|value="stock"/)
    const views = [
      "components/warehouse/warehouse-catalog.tsx",
      ...readdirSync(resolve(process.cwd(), "components/warehouse/catalog"))
        .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
        .map((name) => `components/warehouse/catalog/${name}`),
    ]
    expect(views.length).toBeGreaterThanOrEqual(6)
    for (const view of views) {
      const source = code(view)
      expect(source, view).not.toMatch(/method:\s*["'`](POST|PUT|PATCH|DELETE)["'`]|useSWRMutation|<form\b|onSubmit=/i)
      // Every request a catalogue view makes is one of the warehouse's own GET routes.
      for (const [, path] of source.matchAll(/["'`](\/api\/v1\/[^"'`?$]*)/g)) {
        expect(path, view).toMatch(/^\/api\/v1\/warehouse\/catalog(\/|$)/)
      }
    }
    // Price history reuses Super Admin's chart, pointed at the warehouse's route.
    expect(workspace).toContain('endpoint="/api/v1/warehouse/catalog/price-history"')
  })
})

describe("wiring", () => {
  it("confines the role in proxy.ts to its area and its allowlist", () => {
    const proxy = read("proxy.ts")
    expect(proxy).toContain("{ matches: isWarehouseRole, allows: withinAreas(WAREHOUSE_AREAS), home: WAREHOUSE_HOME }")
    expect(proxy).toContain("isWarehouseRole((token as any)?.role) && !isWarehouseApiRequestAllowed(req.method, pathname)")
    expect(proxy).toContain('{ prefix: WAREHOUSE_HOME, roles: ["WAREHOUSE"], home: "/dashboard" }')
    expect(WAREHOUSE_HOME).toBe("/warehouse")
  })

  it("gives Super Admin a page of its own for the branches, not a card on the Order Desk page", () => {
    expect(read("proxy.ts")).toContain("{ prefix: WAREHOUSE_TEAM_AREA, roles: WAREHOUSE_MANAGER_ROLES, home: \"/dashboard\" }")
    expect(read("app/(portal)/warehouse-team/layout.tsx")).toContain('if (!canManageWarehouse((session.user as { role?: string }).role)) redirect("/dashboard")')
    expect(read("app/(portal)/warehouse-team/page.tsx")).toContain("<WarehouseTeamCard />")
    expect(read("components/shell/sidebar.tsx")).toContain('{ href: "/warehouse-team", label: "Warehouse Team", icon: Warehouse }')
    expect(read("components/order-desk/desk-team-manager.tsx")).not.toContain("Warehouse")
  })

  it("reaches the shared support pages, with the same support calls Apricart Support makes", () => {
    // plans/OF-WAREHOUSE-support-queue.md
    expect(WAREHOUSE_AREAS).toEqual(["/warehouse", "/support"])
    const supportRules = (rules: readonly { route: string; methods: readonly string[] }[]) =>
      rules.filter((rule) => rule.route.startsWith("app/api/v1/support/")).map((rule) => `${rule.route} ${rule.methods.join(",")}`)
    expect(supportRules(WAREHOUSE_API_RULES)).toEqual(supportRules(APRICART_SUPPORT_API_RULES))
    expect(read("app/support/layout.tsx")).toContain("if (isWarehouseRole(role)) {")
    expect(read("components/warehouse/warehouse-workspace.tsx")).toContain("<WarehouseSupportLink")
    expect(read("components/support/support-chrome.tsx")).toContain(
      'if (isWarehouseRole(role)) return { href: WAREHOUSE_HOME, label: "Back to warehouse" }',
    )
  })

  it("gates the workspace on the server too", () => {
    expect(read("app/warehouse/layout.tsx")).toContain('if (!isWarehouseRole(role)) redirect("/dashboard")')
  })

  it("fences the workload and the timeline to the user's branches, never management's unfenced read", () => {
    expect(read("app/api/v1/warehouse/workload/route.ts")).toContain(`loadDeliveryDashboard(parsed.filters, now, reach, "newest")`)
    expect(read("app/api/v1/warehouse/orders/[id]/timeline/route.ts")).toContain("loadDeliveryTimeline(orderId, new Date(), reach)")
  })

  it("prints the same invoice the customer downloads, behind the branch reach", () => {
    const route = read("app/api/v1/warehouse/orders/[id]/invoice/route.ts")
    expect(route).toContain("loadWarehouseOrderInReach(db, user.id, orderId)")
    expect(route).toContain("buildInvoiceDocument(order)")
    expect(route).toContain("isInvoiceAvailableForOrder(order)")
    expect(route.indexOf("loadWarehouseOrderInReach(")).toBeLessThan(route.indexOf("buildInvoiceDocument("))
    expect(read("app/api/v1/receipts/[orderId]/download/route.ts")).toContain("buildInvoiceDocument(order)")
  })

  it("keeps Super Admin's challan requirement while making it optional for the warehouse", () => {
    expect(read("app/api/v1/orders/[id]/fulfillment-status/route.ts")).toContain("challanRequired: true")
    expect(read("app/api/v1/warehouse/orders/[id]/progress/route.ts")).toContain("challanRequired: false")
  })
})

describe("the full read-only catalogue (plans/OF-WAREHOUSE-full-read-only-catalog.md)", () => {
  const catalogRules = WAREHOUSE_API_RULES.filter((rule) => rule.route.startsWith("app/api/v1/warehouse/catalog/"))

  it("admits GET alone on every catalogue route, and each handler exports GET alone", () => {
    expect(catalogRules.map((rule) => rule.route).sort()).toEqual([...WAREHOUSE_CATALOG_ROUTES, ...WAREHOUSE_TENANT_CATALOG_ROUTES].sort())
    for (const rule of catalogRules) {
      expect(rule.methods, rule.route).toEqual(["GET"])
      const source = read(rule.route)
      expect(source, rule.route).toMatch(/export async function GET\b/)
      expect(source, rule.route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)\b/)
    }
  })

  it("fences every tenant-owned menu to the organizations the warehouse serves", () => {
    for (const route of WAREHOUSE_TENANT_CATALOG_ROUTES) {
      expect(read(route), route).toContain("loadWarehouseCatalogFence(user.id)")
    }
    for (const route of WAREHOUSE_TENANT_CATALOG_ROUTES.filter((path) => /organization-products|group-products|product-requests/.test(path))) {
      expect(read(route), route).toContain("fenceAdmitsOrganization(fence, parsed.value.organizationId)")
    }
    expect(read("app/api/v1/warehouse/catalog/price-history/route.ts")).toContain('role: "WAREHOUSE"')
  })

  it("never writes from any catalogue read", () => {
    for (const path of ["lib/server/warehouse-catalog.ts", "lib/server/warehouse-catalog-tenant.ts", "lib/server/product-price-history.ts"]) {
      const source = read(path)
      expect(source, path).not.toMatch(/\.(insert|update|delete)\(/)
      expect(source, path).not.toMatch(/\btransaction\(/)
    }
  })

  it("names no person on a tenant catalogue read", () => {
    const source = read("lib/server/warehouse-catalog-tenant.ts")
    expect(source).not.toMatch(/fullName|requestedByUserId\)|requesterName|reviewedByName|\busers\b/)
  })
})
