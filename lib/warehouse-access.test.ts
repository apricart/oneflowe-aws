import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { mayCreateOrder } from "@/lib/order-creation-access"
import { canMutatePrices } from "@/lib/pricing-access"
import { isValidRole as isValidRbacRole } from "@/lib/rbac"
import {
  systemRoleSchema,
  warehouseBranchAssignmentsUpdateSchema,
  warehouseChallanAttachSchema,
  warehouseCityAssignmentUpdateSchema,
  warehouseProgressSchema,
} from "@/lib/server/mutation-validation"
import { canAssignRole, canManageUser } from "@/lib/server/user-access-policy"
import {
  WAREHOUSE_API_RULES,
  WAREHOUSE_ASSIGNMENT_MAX_PER_ORGANIZATION,
  WAREHOUSE_CITY_MAX_LENGTH,
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
const WAREHOUSE_CATALOG_ROUTES = [
  "app/api/v1/warehouse/catalog/route.ts",
  "app/api/v1/warehouse/catalog/categories/route.ts",
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

  it("is read with the branch assignments by the one reach loader, locked inside a write", () => {
    const scope = read("lib/server/warehouse-scope.ts")
    expect(scope).toContain("innerJoin(branches, eq(branchCityKeySql(branches.city), warehouseCityAssignments.cityKey))")
    expect(scope).toContain('cityQuery.for("share", { of: warehouseCityAssignments })')
    expect(scope).toContain("assignedBranchIds: [...assignments, ...cityBranches].map((row) => row.branchId)")
  })
})

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
    ["GET", "/api/v1/warehouse/workload"],
    ["GET", "/api/v1/warehouse/notifications"],
    ["PATCH", "/api/v1/warehouse/notifications"],
    ["GET", "/api/v1/warehouse/catalog"],
    ["GET", "/api/v1/warehouse/catalog/categories"],
    ["GET", "/api/v1/images/products/0f8fad5b-d9cb-469f-a165-70867728950e.webp"],
    ["POST", "/api/v1/upload/image"],
    ["POST", "/api/v1/users/me/change-password"],
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
    ["GET", "/api/v1/delivery-dashboard"],
    ["GET", "/api/v1/warehouse-team"],
    ["PUT", "/api/v1/warehouse-team/abc/branches"],
    ["PUT", "/api/v1/warehouse-team/abc/cities"],
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
          expect(source, rule.route).toMatch(/loadWarehouseReach\(|loadWarehouseOrderInReach\(|isOrderBranchInWarehouseReach\(|listWarehouseOrders\(|loadWarehouseOrder\(/)
        }
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
          const exported = new RegExp(`export async function ${method}\\b`).test(source)
          expect(exported, `${rule.route} ${method}`).toBe(rule.methods.includes(method))
        }
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

  it("never selects a price, a tax rate or a discount, so none can reach the payload", () => {
    const reads = code("lib/server/warehouse-catalog.ts")
    expect(reads).not.toMatch(/basePrice|base_price|taxRateBp|tax_rate|discount|customPrice|price/i)
    // Nor a tenant's catalogue rows, whose overrides carry prices and names.
    expect(reads).not.toMatch(/organizationInventory|branchInventory|groupInventory|effective-price/)
  })

  it("replaces the Stock tab in the workspace, without a write control", () => {
    const workspace = read("components/warehouse/warehouse-workspace.tsx")
    expect(workspace).toContain("<WarehouseCatalog />")
    expect(workspace).not.toMatch(/WarehouseStock|value="stock"/)
    const tab = code("components/warehouse/warehouse-catalog.tsx")
    expect(tab).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"|formatPKR|basePrice|price/i)
  })
})

describe("wiring", () => {
  it("confines the role in proxy.ts to its area and its allowlist", () => {
    const proxy = read("proxy.ts")
    expect(proxy).toContain("{ matches: isWarehouseRole, areas: WAREHOUSE_AREAS, home: WAREHOUSE_HOME }")
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
