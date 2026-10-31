import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { ACTIVITY_ACTOR_ROLES, ACTIVITY_TENANT_ACTOR_ROLES } from "@/lib/activity-log"
import { APRICART_EXECUTIVE_API_RULES } from "@/lib/apricart-executive-access"
import { isFinanceApiRequestAllowed } from "@/lib/finance-access"
import { ROLE_TEMPLATES, Permission } from "@/lib/permissions"
import { canMutatePrices } from "@/lib/pricing-access"
import {
  EXECUTIVE_RETURN_API_RULES,
  FINANCE_PROCUREMENT_API_RULES,
  PROCUREMENT_API_RULES,
  PROCUREMENT_ROLE,
  WAREHOUSE_PROCUREMENT_API_RULES,
  canAdministerCustomerReturns,
  canApproveInvoiceExceptions,
  canApprovePurchaseOrders,
  canChangeProcurementSettings,
  canDecideSupplierInvoices,
  canManageProcurement,
  canReadProcurement,
  canRecordGoodsReceiptAsAdmin,
  canRecordSupplierInvoices,
  isProcurementApiRequestAllowed,
  procurementAccessChangeError,
  procurementUserShapeError,
} from "@/lib/procurement-access"
import { isValidRole } from "@/lib/rbac"
import { canAssignRole, canManageUser } from "@/lib/server/user-access-policy"
import { systemRoleSchema } from "@/lib/server/mutation-validation"
import { WAREHOUSE_API_RULES } from "@/lib/warehouse-access"

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("the Procurement role", () => {
  it("is a known role everywhere roles are listed", () => {
    expect(isValidRole(PROCUREMENT_ROLE)).toBe(true)
    expect(systemRoleSchema.safeParse(PROCUREMENT_ROLE).success).toBe(true)
    // lib/auth.ts falls back to BRANCH_ADMIN for an unknown role.
    expect(read("lib/auth.ts")).toContain("'PROCUREMENT'")
    expect(read("drizzle/20261106120000_procurement.sql")).toContain("SELECT 'PROCUREMENT'")
    expect(read("drizzle/meta/_journal.json")).toContain('"20261106120000_procurement"')
    expect(ROLE_TEMPLATES.PROCUREMENT).toBeDefined()
    expect(ACTIVITY_ACTOR_ROLES).toContain(PROCUREMENT_ROLE)
    expect(ACTIVITY_TENANT_ACTOR_ROLES as readonly string[]).not.toContain(PROCUREMENT_ROLE)
  })

  it("writes no customer price and manages no tenant", () => {
    expect(canMutatePrices(PROCUREMENT_ROLE)).toBe(false)
    const permissions = ROLE_TEMPLATES.PROCUREMENT.permissions as readonly string[]
    expect(permissions).not.toContain(Permission.PRICING_MANAGE)
    for (const key of permissions) expect(key).not.toMatch(/^(user|org|order|pricing):/)
  })

  it("is created and managed by Super Admin alone", () => {
    expect(canAssignRole("SUPER_ADMIN", PROCUREMENT_ROLE)).toBe(true)
    expect(canManageUser("SUPER_ADMIN", PROCUREMENT_ROLE)).toBe(true)
    expect(canAssignRole("HEAD_OFFICE", PROCUREMENT_ROLE)).toBe(false)
    expect(canManageUser("HEAD_OFFICE", PROCUREMENT_ROLE)).toBe(false)
  })

  it("carries no organization or branch, and is never switched into or out of", () => {
    expect(procurementUserShapeError(null, null)).toBeNull()
    expect(procurementUserShapeError(3, null)).not.toBeNull()
    expect(procurementUserShapeError(null, 4)).not.toBeNull()
    expect(procurementAccessChangeError(PROCUREMENT_ROLE, {})).toBeNull()
    expect(procurementAccessChangeError(PROCUREMENT_ROLE, { role: "SUPER_ADMIN" })).not.toBeNull()
    expect(procurementAccessChangeError("HEAD_OFFICE", { role: PROCUREMENT_ROLE })).not.toBeNull()
    expect(procurementAccessChangeError(PROCUREMENT_ROLE, { organizationId: 2 })).not.toBeNull()
    expect(procurementAccessChangeError("HEAD_OFFICE", {})).toBeNull()
  })

  it("lands on its workspace after sign-in and is confined there by the proxy", () => {
    expect(read("app/(auth)/login/page.tsx")).toContain("if (isProcurementRole(role)) return PROCUREMENT_HOME")
    const proxy = read("proxy.ts")
    expect(proxy).toContain("isProcurementRole((token as any)?.role) && !isProcurementApiRequestAllowed(req.method, pathname)")
    expect(proxy).toContain("{ matches: isProcurementRole, allows: withinAreas(PROCUREMENT_AREAS), home: PROCUREMENT_HOME }")
    expect(proxy).toContain("{ prefix: PROCUREMENT_HOME, roles: PROCUREMENT_READ_ROLES, home: \"/dashboard\" }")
  })
})

describe("separation of duties", () => {
  const roles = ["SUPER_ADMIN", "PROCUREMENT", "FINANCE", "WAREHOUSE", "APRICART_EXECUTIVE", "HEAD_OFFICE", "BRANCH_ADMIN", "VIEWER", undefined]
  const holders = (check: (role: unknown) => boolean) => roles.filter((role) => check(role))

  it("lets Super Admin alone approve a purchase order", () => {
    expect(holders(canApprovePurchaseOrders)).toEqual(["SUPER_ADMIN"])
  })

  it("lets Procurement and Super Admin buy, and Finance read the costs", () => {
    expect(holders(canManageProcurement)).toEqual(["SUPER_ADMIN", "PROCUREMENT"])
    expect(holders(canReadProcurement)).toEqual(["SUPER_ADMIN", "PROCUREMENT", "FINANCE"])
  })

  it("never shows the warehouse a cost", () => {
    expect(canReadProcurement("WAREHOUSE")).toBe(false)
    for (const rule of WAREHOUSE_PROCUREMENT_API_RULES) {
      const source = read(rule.route)
      expect(source, rule.route).not.toMatch(/loadPurchaseOrder\(|listPurchaseOrders\(|listSupplierInvoices\(/)
    }
    const server = read("lib/server/procurement.ts")
    const warehouseReads = server.slice(server.indexOf("// Warehouse-facing reads"), server.indexOf("// Supplier invoices and the three-way match"))
    expect(warehouseReads).not.toMatch(/unitCostCents|lineTotalCents|totalCents|subtotalCents|taxRateBps/)
  })

  it("lets Finance and Super Admin decide invoices, and Super Admin alone approve a mismatch", () => {
    expect(holders(canRecordSupplierInvoices)).toEqual(["SUPER_ADMIN", "PROCUREMENT", "FINANCE"])
    expect(holders(canDecideSupplierInvoices)).toEqual(["SUPER_ADMIN", "FINANCE"])
    expect(holders(canApproveInvoiceExceptions)).toEqual(["SUPER_ADMIN"])
  })

  it("keeps receipts, returns and the tolerance to their owners", () => {
    expect(holders(canRecordGoodsReceiptAsAdmin)).toEqual(["SUPER_ADMIN"])
    expect(holders(canAdministerCustomerReturns)).toEqual(["SUPER_ADMIN"])
    expect(holders(canChangeProcurementSettings)).toEqual(["SUPER_ADMIN"])
  })
})

describe("the API allowlists", () => {
  it.each([
    ["GET", "/api/v1/procurement/purchase-orders"],
    ["PATCH", "/api/v1/procurement/purchase-orders/12"],
    ["POST", "/api/v1/procurement/supplier-invoices"],
    ["POST", "/api/v1/users/me/change-password"],
  ])("admits Procurement to %s %s", (method, path) => {
    expect(isProcurementApiRequestAllowed(method, path)).toBe(true)
  })

  it.each([
    ["PATCH", "/api/v1/procurement/supplier-invoices/3"],
    ["PUT", "/api/v1/procurement/settings"],
    ["POST", "/api/v1/procurement/purchase-orders/3/receipts"],
    ["GET", "/api/v1/procurement/returns"],
    ["GET", "/api/v1/orders"],
    ["GET", "/api/v1/procurement/purchase-orders/3/extra"],
    ["GET", "/api/v1/warehouse/procurement/purchase-orders"],
  ])("refuses Procurement %s %s", (method, path) => {
    expect(isProcurementApiRequestAllowed(method, path)).toBe(false)
  })

  it("admits Finance to the reads and invoice decisions, not to buying", () => {
    expect(isFinanceApiRequestAllowed("GET", "/api/v1/procurement/purchase-orders/4")).toBe(true)
    expect(isFinanceApiRequestAllowed("PATCH", "/api/v1/procurement/supplier-invoices/4")).toBe(true)
    expect(isFinanceApiRequestAllowed("POST", "/api/v1/procurement/purchase-orders")).toBe(false)
    expect(isFinanceApiRequestAllowed("PATCH", "/api/v1/procurement/purchase-orders/4")).toBe(false)
    expect(isFinanceApiRequestAllowed("PUT", "/api/v1/procurement/settings")).toBe(false)
  })

  it("folds the warehouse's and the executive's routes into their own allowlists", () => {
    for (const rule of WAREHOUSE_PROCUREMENT_API_RULES) expect(WAREHOUSE_API_RULES).toContainEqual(rule)
    for (const rule of EXECUTIVE_RETURN_API_RULES) expect(APRICART_EXECUTIVE_API_RULES).toContainEqual(rule)
  })

  const ALL_RULES = [...PROCUREMENT_API_RULES, ...FINANCE_PROCUREMENT_API_RULES, ...WAREHOUSE_PROCUREMENT_API_RULES, ...EXECUTIVE_RETURN_API_RULES]

  it("names only handlers that exist and check the role themselves", () => {
    for (const rule of ALL_RULES) {
      expect(existsSync(resolve(process.cwd(), rule.route)), rule.route).toBe(true)
      const source = read(rule.route)
      if (rule.route.startsWith("app/api/v1/users/me/")) continue
      expect(source, rule.route).toMatch(/requireApiRole\(/)
      for (const method of rule.methods) expect(source, `${rule.route} ${method}`).toMatch(new RegExp(`export async function ${method}\\b`))
    }
  })

  it("fences the warehouse to its memberships and the executive to its executive memberships", () => {
    for (const rule of WAREHOUSE_PROCUREMENT_API_RULES) {
      const source = read(rule.route)
      expect(source, rule.route).toContain('requireApiRole(["WAREHOUSE"])')
      expect(source, rule.route).toContain("loadWarehouseMemberships(")
    }
    for (const rule of EXECUTIVE_RETURN_API_RULES) {
      const source = read(rule.route)
      expect(source, rule.route).toContain('requireApiRole(["APRICART_EXECUTIVE"])')
      expect(source, rule.route).toContain("loadExecutiveWarehouseIds(")
    }
  })

  it("rate limits and validates every write", () => {
    const root = resolve(process.cwd(), "app/api/v1/procurement")
    const routes: string[] = []
    const walk = (current: string) => {
      for (const entry of readdirSync(current)) {
        const path = join(current, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (entry === "route.ts") routes.push(relative(process.cwd(), path).split("\\").join("/"))
      }
    }
    walk(root)
    for (const dir of ["app/api/v1/warehouse/procurement", "app/api/v1/executive/returns"]) walk(resolve(process.cwd(), dir))
    expect(routes.length).toBeGreaterThan(20)
    for (const route of routes) {
      const source = read(route)
      if (!/export async function (POST|PUT|PATCH|DELETE)\b/.test(source)) continue
      expect(source, route).toContain('withRateLimit("write", user.id)')
      expect(source, route).toMatch(/Schema\.safeParse\(await readJson/)
    }
  })

  it("leaves only lib/server/warehouse-stock.ts writing a shelf figure", () => {
    const server = read("lib/server/procurement.ts")
    expect(server).not.toMatch(/\.(insert|update)\(warehouseStock\)|\.insert\(stockMovements\)/)
    expect(server).toContain("addToWarehouseStock(tx,")
  })
})
