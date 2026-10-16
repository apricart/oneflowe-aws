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
  resolveExecutiveApprovalReach,
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

  it("creates no orders and writes no prices", () => {
    expect(mayCreateOrder(APRICART_EXECUTIVE_ROLE)).toBe(false)
    expect(canMutatePrices(APRICART_EXECUTIVE_ROLE)).toBe(false)
  })
})

describe("approval reach", () => {
  const executive = { role: "APRICART_EXECUTIVE", isActive: true, deleted: false }

  it("is the assigned organizations, unique and sorted", () => {
    expect(resolveExecutiveApprovalReach({ account: executive, assignedOrganizationIds: [11, 4, 11] })).toEqual([4, 11])
  })

  it("is empty with no assignment, never widened to every organization", () => {
    expect(resolveExecutiveApprovalReach({ account: executive, assignedOrganizationIds: [] })).toEqual([])
  })

  it.each([
    ["no account row", null],
    ["a deactivated account", { ...executive, isActive: false }],
    ["a deleted account", { ...executive, deleted: true }],
    ["an account moved to another role", { ...executive, role: "HEAD_OFFICE" }],
    ["an Order Desk account", { ...executive, role: "ORDER_DESK" }],
  ])("is empty for %s, whatever is assigned", (_label, account) => {
    expect(resolveExecutiveApprovalReach({ account, assignedOrganizationIds: [4, 11] })).toEqual([])
  })

  it("drops ids that are not positive integers", () => {
    expect(resolveExecutiveApprovalReach({ account: executive, assignedOrganizationIds: [0, -2, 1.5, 7] })).toEqual([7])
  })
})

describe("the API allowlist", () => {
  it.each([
    ["GET", "/api/v1/delivery-dashboard"],
    ["GET", "/api/v1/delivery-dashboard/"],
    ["GET", "/api/v1/delivery-dashboard/orders/42/timeline"],
    ["POST", "/api/v1/users/me/change-password"],
    ["GET", "/api/v1/executive/approvals"],
    ["GET", "/api/v1/executive/approvals/"],
    ["POST", "/api/v1/executive/approvals/42/approve"],
    ["POST", "/api/v1/executive/approvals/42/reject"],
    ["POST", "/api/v1/executive/approvals/42/return"],
    ["GET", "/api/v1/executive/approvals/42/attachment"],
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
    // Approval goes through the executive's own routes only.
    ["POST", "/api/v1/orders/42/approve"],
    ["POST", "/api/v1/orders/42/reject"],
    ["POST", "/api/v1/orders/42/return-for-correction"],
    ["PUT", "/api/v1/orders/42"],
    ["POST", "/api/v1/executive/approvals"],
    ["GET", "/api/v1/executive/approvals/42/approve"],
    ["POST", "/api/v1/executive/approvals/abc/approve"],
    ["POST", "/api/v1/executive/approvals/42/approve/extra"],
    ["POST", "/api/v1/executive/approvals/42/fulfil"],
    ["GET", "/api/v1/apricart-executives"],
    ["PUT", "/api/v1/apricart-executives/abc/organizations"],
    ["POST", "/api/v1/order-desk/orders/42/resubmit"],
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
      } else if (rule.route.startsWith("app/api/v1/executive/approvals/")) {
        // The executive's approvals, and nobody else's.
        expect(source, rule.route).toContain('requireApiRole(["APRICART_EXECUTIVE"])')
      } else {
        // The password-change endpoints every signed-in account must reach.
        expect(rule.route).toMatch(/^app\/api\/v1\/users\/me\//)
      }
    }
  })

  it.each(["app/api/v1/delivery-dashboard", "app/api/v1/executive"])("covers every handler under %s", (dir) => {
    const root = resolve(process.cwd(), dir)
    const found: string[] = []
    const walk = (current: string) => {
      for (const entry of readdirSync(current)) {
        const path = join(current, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (entry === "route.ts") found.push(relative(process.cwd(), path).split("\\").join("/"))
      }
    }
    walk(root)
    const listed = new Set(APRICART_EXECUTIVE_API_RULES.map((rule) => rule.route))
    expect(found.length).toBeGreaterThan(0)
    for (const route of found) expect(listed.has(route), route).toBe(true)
  })

  it("decides through the shared decision service, never its own transition", () => {
    const decisions = {
      approve: "approveOrder({",
      reject: "rejectOrder({",
      return: "returnOrderForCorrection({",
    }
    for (const [action, call] of Object.entries(decisions)) {
      const source = read(`app/api/v1/executive/approvals/[id]/${action}/route.ts`)
      expect(source, action).toContain(call)
      expect(source, action).toContain('withRateLimit("order", user.id)')
      expect(source, action).not.toContain("db.transaction")
      expect(source, action).not.toContain("approvalToken")
      // Who and which tenant come from the session, never the body.
      expect(source, action).not.toMatch(/body\.(organizationId|branchId|userId|role)/)
    }
  })

  it("is enforced by the proxy, before any handler", () => {
    const proxy = read("proxy.ts")
    expect(proxy).toContain("isApricartExecutiveRole((token as any)?.role)")
    expect(proxy).toContain("!isApricartExecutiveApiRequestAllowed(req.method, pathname)")
    expect(proxy).toContain("{ matches: isApricartExecutiveRole, allows: withinAreas(APRICART_EXECUTIVE_AREAS), home: APRICART_EXECUTIVE_HOME }")
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
