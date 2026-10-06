import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  APRICART_EXECUTIVE_API_RULES,
  APRICART_EXECUTIVE_AREAS,
  APRICART_EXECUTIVE_HOME,
  APRICART_EXECUTIVE_ROLE,
  apricartExecutiveAccessChangeError,
  apricartExecutiveUserShapeError,
  canReadDeliveryDashboard,
  isApricartExecutiveApiRequestAllowed,
} from "@/lib/apricart-executive-access"
import { mayCreateOrder } from "@/lib/order-creation-access"
import { canMutatePrices } from "@/lib/pricing-access"
import { isValidRole as isValidRbacRole } from "@/lib/rbac"
import { canAssignRole, canManageUser } from "@/lib/server/user-access-policy"
import { systemRoleSchema } from "@/lib/server/mutation-validation"
import { USER_MANAGEMENT_ROLES } from "@/lib/user-management-access"

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("the Apricart Executive role", () => {
  it("is a known role everywhere roles are listed", () => {
    expect(isValidRbacRole(APRICART_EXECUTIVE_ROLE)).toBe(true)
    expect(systemRoleSchema.safeParse(APRICART_EXECUTIVE_ROLE).success).toBe(true)
    // lib/auth.ts falls back to BRANCH_ADMIN for an unknown role, so a role
    // missing from its list would quietly become a branch administrator.
    expect(read("lib/auth.ts")).toContain("'APRICART_EXECUTIVE'")
    expect(read("drizzle/20261007120000_add_branch_region_and_apricart_executive.sql"))
      .toContain("SELECT 'APRICART_EXECUTIVE'")
  })

  it("reads the delivery dashboard alongside Super Admin, and no one else does", () => {
    expect(canReadDeliveryDashboard("APRICART_EXECUTIVE")).toBe(true)
    expect(canReadDeliveryDashboard("SUPER_ADMIN")).toBe(true)
    for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL", "GROUP_ORDER_PORTAL", "VIEWER", "ORDER_DESK", undefined]) {
      expect(canReadDeliveryDashboard(role)).toBe(false)
    }
  })

  it("acts on nothing: no orders, no prices", () => {
    expect(mayCreateOrder(APRICART_EXECUTIVE_ROLE)).toBe(false)
    expect(canMutatePrices(APRICART_EXECUTIVE_ROLE)).toBe(false)
  })
})

describe("the API allowlist", () => {
  it.each([
    ["GET", "/api/v1/delivery-dashboard"],
    ["GET", "/api/v1/delivery-dashboard/"],
    ["GET", "/api/v1/delivery-dashboard/orders/42/timeline"],
    ["POST", "/api/v1/users/me/change-password"],
  ])("admits %s %s", (method, path) => {
    expect(isApricartExecutiveApiRequestAllowed(method, path)).toBe(true)
  })

  it.each([
    ["POST", "/api/v1/delivery-dashboard"],
    ["GET", "/api/v1/orders"],
    ["POST", "/api/v1/orders"],
    ["GET", "/api/v1/orders/42"],
    ["GET", "/api/v1/delivery-dashboard/orders/abc/timeline"],
    ["GET", "/api/v1/delivery-dashboard-export"],
    ["GET", "/api/v1/organizations"],
    ["GET", "/api/v1/users"],
    ["GET", "/api/v1/analytics/summary"],
    ["GET", "/api/v1/notifications"],
  ])("refuses %s %s", (method, path) => {
    expect(isApricartExecutiveApiRequestAllowed(method, path)).toBe(false)
  })

  it("names only handlers that exist and admit the role themselves", () => {
    for (const rule of APRICART_EXECUTIVE_API_RULES) {
      expect(existsSync(resolve(process.cwd(), rule.route)), rule.route).toBe(true)
      const source = read(rule.route)
      if (rule.route.startsWith("app/api/v1/delivery-dashboard/")) {
        expect(source, rule.route).toContain('requireApiRole(["SUPER_ADMIN", "APRICART_EXECUTIVE"])')
        expect(source, rule.route).toContain("isActiveDeliveryDashboardReader(")
        // Reads only.
        expect(source, rule.route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/)
        expect(rule.methods).toEqual(["GET"])
      } else {
        // The password-change endpoints every signed-in account must reach.
        expect(rule.route).toMatch(/^app\/api\/v1\/users\/me\//)
      }
    }
  })

  it("covers every delivery dashboard handler", () => {
    const root = resolve(process.cwd(), "app/api/v1/delivery-dashboard")
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (entry === "route.ts") found.push(relative(process.cwd(), path).split("\\").join("/"))
      }
    }
    walk(root)
    const listed = new Set(APRICART_EXECUTIVE_API_RULES.map((rule) => rule.route))
    expect(found.length).toBeGreaterThan(0)
    for (const route of found) expect(listed.has(route), route).toBe(true)
  })

  it("is enforced by the proxy, before any handler", () => {
    const proxy = read("proxy.ts")
    expect(proxy).toContain("isApricartExecutiveRole((token as any)?.role)")
    expect(proxy).toContain("!isApricartExecutiveApiRequestAllowed(req.method, pathname)")
    expect(proxy).toContain("{ matches: isApricartExecutiveRole, areas: APRICART_EXECUTIVE_AREAS, home: APRICART_EXECUTIVE_HOME }")
    expect(proxy).toContain('{ prefix: DELIVERY_DASHBOARD_AREA, roles: ["SUPER_ADMIN"], home: "/dashboard" }')
  })

  it("confines the role's pages to its workspace", () => {
    expect(APRICART_EXECUTIVE_AREAS).toEqual([APRICART_EXECUTIVE_HOME])
    expect(read("app/executive/layout.tsx")).toContain("if (!isApricartExecutiveRole(role)) redirect(\"/dashboard\")")
    expect(read("app/(portal)/delivery-dashboard/page.tsx")).toContain('if (role !== "SUPER_ADMIN") redirect("/dashboard")')
  })
})

describe("executive accounts", () => {
  it("are Super Admin's alone to create and manage", () => {
    expect(canAssignRole("SUPER_ADMIN", "APRICART_EXECUTIVE")).toBe(true)
    expect(canManageUser("SUPER_ADMIN", "APRICART_EXECUTIVE")).toBe(true)
    for (const actor of ["HEAD_OFFICE", "GROUP_USER", "BRANCH_ADMIN", "ORDER_DESK"] as const) {
      expect(canAssignRole(actor, "APRICART_EXECUTIVE"), actor).toBe(false)
      expect(canManageUser(actor, "APRICART_EXECUTIVE"), actor).toBe(false)
    }
    // And an executive manages no one: the user routes admit only the
    // user-management roles, and the proxy refuses it the user API besides.
    expect(USER_MANAGEMENT_ROLES).not.toContain("APRICART_EXECUTIVE")
    expect(isApricartExecutiveApiRequestAllowed("POST", "/api/v1/users")).toBe(false)
    expect(isApricartExecutiveApiRequestAllowed("PATCH", "/api/v1/users/abc/access")).toBe(false)
  })

  it("belong to no organization and no branch", () => {
    expect(apricartExecutiveUserShapeError(null, null)).toBeNull()
    expect(apricartExecutiveUserShapeError(4, null)).not.toBeNull()
    expect(apricartExecutiveUserShapeError(null, 9)).not.toBeNull()
    expect(read("app/api/v1/users/route.ts")).toContain("apricartExecutiveUserShapeError(organizationId, branchId)")
  })

  it("accept activation and MFA changes only, and are never switched into or out of", () => {
    expect(apricartExecutiveAccessChangeError("APRICART_EXECUTIVE", {})).toBeNull()
    expect(apricartExecutiveAccessChangeError("APRICART_EXECUTIVE", { role: "APRICART_EXECUTIVE" })).toBeNull()
    expect(apricartExecutiveAccessChangeError("APRICART_EXECUTIVE", { role: "HEAD_OFFICE" })).not.toBeNull()
    expect(apricartExecutiveAccessChangeError("HEAD_OFFICE", { role: "APRICART_EXECUTIVE" })).not.toBeNull()
    expect(apricartExecutiveAccessChangeError("APRICART_EXECUTIVE", { organizationId: 4 })).not.toBeNull()
    expect(apricartExecutiveAccessChangeError("APRICART_EXECUTIVE", { groupIds: [1] })).not.toBeNull()
    expect(apricartExecutiveAccessChangeError("HEAD_OFFICE", { role: "BRANCH_ADMIN" })).toBeNull()
    expect(read("app/api/v1/users/[id]/access/route.ts")).toContain("apricartExecutiveAccessChangeError(targetRole, input)")
  })
})

describe("branch regions", () => {
  it("are set by Super Admin only, on create and on edit", () => {
    expect(read("app/api/v1/branches/route.ts")).toContain('scope.role !== "SUPER_ADMIN"')
    expect(read("app/api/v1/branches/[id]/route.ts")).toContain('body.region !== undefined && scope?.role !== "SUPER_ADMIN"')
  })
})
