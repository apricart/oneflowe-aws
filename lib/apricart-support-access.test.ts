import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { ACTIVITY_ACTOR_ROLES, ACTIVITY_TENANT_ACTOR_ROLES } from "@/lib/activity-log"
import {
  APRICART_SUPPORT_API_RULES,
  APRICART_SUPPORT_AREAS,
  APRICART_SUPPORT_HOME,
  APRICART_SUPPORT_ROLE,
  apricartSupportAccessChangeError,
  apricartSupportUserShapeError,
  isApricartSupportApiRequestAllowed,
} from "@/lib/apricart-support-access"
import { mayCreateOrder } from "@/lib/order-creation-access"
import { ROLE_TEMPLATES } from "@/lib/permissions"
import { canMutatePrices } from "@/lib/pricing-access"
import { isValidRole as isValidRbacRole } from "@/lib/rbac"
import { canAssignRole, canManageUser } from "@/lib/server/user-access-policy"
import { systemRoleSchema } from "@/lib/server/mutation-validation"
import { canManageSupportThread, supportThreadVisibilityScope } from "@/lib/support-access"
import { usesPortalChrome } from "@/lib/portal-chrome"
import { SUPPORT_APRICART_ROLES, supportSideForRole } from "@/lib/support-thread"
import { USER_MANAGEMENT_ROLES } from "@/lib/user-management-access"

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

function routesUnder(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (entry === "route.ts") found.push(relative(process.cwd(), path).split("\\").join("/"))
    }
  }
  walk(resolve(process.cwd(), dir))
  return found
}

describe("the Apricart Support role", () => {
  it("is a known role everywhere roles are listed", () => {
    expect(isValidRbacRole(APRICART_SUPPORT_ROLE)).toBe(true)
    expect(systemRoleSchema.safeParse(APRICART_SUPPORT_ROLE).success).toBe(true)
    // lib/auth.ts falls back to BRANCH_ADMIN for an unknown role, so a role
    // missing from its list would quietly become a branch administrator.
    expect(read("lib/auth.ts")).toContain("'APRICART_SUPPORT'")
    expect(read("drizzle/20261023120000_add_apricart_support_role.sql")).toContain("SELECT 'APRICART_SUPPORT'")
    expect(read("drizzle/meta/_journal.json")).toContain('"20261023120000_add_apricart_support_role"')
    expect(ROLE_TEMPLATES.APRICART_SUPPORT).toBeDefined()
  })

  it("is Apricart's side of every support conversation, with Super Admin and no one else", () => {
    expect([...SUPPORT_APRICART_ROLES]).toEqual(["SUPER_ADMIN", APRICART_SUPPORT_ROLE])
    expect(supportSideForRole(APRICART_SUPPORT_ROLE)).toBe("APRICART")
    expect(canManageSupportThread(APRICART_SUPPORT_ROLE)).toBe(true)
    expect(
      supportThreadVisibilityScope({ userId: "agent-1", role: APRICART_SUPPORT_ROLE, organizationId: null, branchId: null }),
    ).toEqual({ kind: "all" })
  })

  it("creates no orders, writes no prices, and wears no portal chrome", () => {
    expect(mayCreateOrder(APRICART_SUPPORT_ROLE)).toBe(false)
    expect(canMutatePrices(APRICART_SUPPORT_ROLE)).toBe(false)
    // The admin shell's sidebar, bell and context call endpoints outside its
    // allowlist, so the support layout gives it a bar of its own instead.
    expect(usesPortalChrome(APRICART_SUPPORT_ROLE)).toBe(false)
  })

  it("is Apricart's own staff in the activity log, never a tenant role", () => {
    expect(ACTIVITY_ACTOR_ROLES).toContain(APRICART_SUPPORT_ROLE)
    expect(ACTIVITY_TENANT_ACTOR_ROLES as readonly string[]).not.toContain(APRICART_SUPPORT_ROLE)
  })
})

describe("the API allowlist", () => {
  it.each([
    ["GET", "/api/v1/support/threads"],
    ["GET", "/api/v1/support/threads/"],
    ["GET", "/api/v1/support/threads/42"],
    ["PATCH", "/api/v1/support/threads/42"],
    ["POST", "/api/v1/support/threads/42/messages"],
    ["GET", "/api/v1/support/stats"],
    ["POST", "/api/v1/support/attachments"],
    ["GET", "/api/v1/support/attachments/7"],
    ["POST", "/api/v1/users/me/change-password"],
    ["POST", "/api/v1/users/me/email-verification/send"],
    ["POST", "/api/v1/users/me/email-verification/verify"],
  ])("admits %s %s", (method, path) => {
    expect(isApricartSupportApiRequestAllowed(method, path)).toBe(true)
  })

  it.each([
    // Apricart raises no thread, and the product picker belongs to raising one.
    ["POST", "/api/v1/support/threads"],
    ["GET", "/api/v1/support/products"],
    // Only the verbs the page uses.
    ["DELETE", "/api/v1/support/threads/42"],
    ["PUT", "/api/v1/support/threads/42"],
    ["GET", "/api/v1/support/threads/42/messages"],
    ["DELETE", "/api/v1/support/attachments/7"],
    // Never a prefix, never a non-numeric id.
    ["GET", "/api/v1/support/threads/abc"],
    ["GET", "/api/v1/support/threads/42/extra"],
    ["GET", "/api/v1/support/attachments/7/raw"],
    ["GET", "/api/v1/support-export"],
    // Nothing of the rest of the platform.
    ["GET", "/api/v1/orders"],
    ["GET", "/api/v1/orders/42"],
    ["POST", "/api/v1/orders/42/refunds"],
    ["GET", "/api/v1/receipts/42/download"],
    ["GET", "/api/v1/organizations"],
    ["GET", "/api/v1/users"],
    ["POST", "/api/v1/users"],
    ["GET", "/api/v1/notifications"],
    ["GET", "/api/v1/analytics/summary"],
    ["GET", "/api/v1/activity-logs"],
    ["GET", "/api/v1/images/products/0b1c2d3e-0000-4000-8000-000000000000.png"],
    ["POST", "/api/v1/upload/image"],
    ["PATCH", "/api/v1/inventory/1"],
  ])("refuses %s %s", (method, path) => {
    expect(isApricartSupportApiRequestAllowed(method, path)).toBe(false)
  })

  it("names only handlers that exist, export every listed verb, and check the support rule themselves", () => {
    for (const rule of APRICART_SUPPORT_API_RULES) {
      expect(existsSync(resolve(process.cwd(), rule.route)), rule.route).toBe(true)
      const source = read(rule.route)
      for (const method of rule.methods) {
        expect(source, `${rule.route} ${method}`).toMatch(new RegExp(`export async function ${method}\\b`))
      }
      if (rule.route.startsWith("app/api/v1/support/")) {
        // The visibility and triage rules are lib/support-access.ts's; every
        // support handler refuses a non-participant before reading anything.
        expect(source, rule.route).toContain("isSupportParticipantRole(")
      } else {
        // The password-change endpoints every signed-in account must reach.
        expect(rule.route).toMatch(/^app\/api\/v1\/users\/me\//)
      }
    }
  })

  it("covers every support handler except the two Apricart never uses", () => {
    const listed = new Set(APRICART_SUPPORT_API_RULES.map((rule) => rule.route))
    const deliberatelyAbsent = new Set(["app/api/v1/support/products/route.ts"])
    const found = routesUnder("app/api/v1/support")
    expect(found.length).toBeGreaterThan(0)
    for (const route of found) {
      expect(listed.has(route) || deliberatelyAbsent.has(route), route).toBe(true)
    }
    // The list route is listed for GET only: raising a thread stays refused.
    const list = APRICART_SUPPORT_API_RULES.find((rule) => rule.route === "app/api/v1/support/threads/route.ts")
    expect(list?.methods).toEqual(["GET"])
  })

  it("is enforced by the proxy, before any handler", () => {
    const proxy = read("proxy.ts")
    expect(proxy).toContain("isApricartSupportRole((token as any)?.role) && !isApricartSupportApiRequestAllowed(req.method, pathname)")
    expect(proxy).toContain(
      "{ matches: isApricartSupportRole, allows: withinAreas(APRICART_SUPPORT_AREAS), home: APRICART_SUPPORT_HOME }",
    )
  })

  it("confines the role's pages to the support area", () => {
    expect(APRICART_SUPPORT_AREAS).toEqual(["/support"])
    expect(APRICART_SUPPORT_HOME).toBe("/support")
    expect(read("app/(auth)/login/page.tsx")).toContain("if (isApricartSupportRole(role)) return APRICART_SUPPORT_HOME")
    expect(read("app/support/layout.tsx")).toContain("if (isApricartSupportRole(role)) {")
  })
})

describe("no support module decides Apricart's side by naming Super Admin", () => {
  const sources = [
    "lib/support-access.ts",
    "lib/support-stats.ts",
    "lib/server/support-threads.ts",
    "lib/server/support-notifications.ts",
    "lib/server/support-session.ts",
    ...routesUnder("app/api/v1/support"),
  ]

  it.each(sources)("%s", (path) => {
    const source = read(path)
    // A comparison against the literal would leave the agent on the customer
    // side of that one decision; SUPPORT_APRICART_ROLES is the only list.
    expect(source).not.toMatch(/===\s*["']SUPER_ADMIN["']|["']SUPER_ADMIN["']\s*===/)
    expect(source).not.toMatch(/eq\(roles\.name,\s*["']SUPER_ADMIN["']\)/)
  })

  it("mails the agent but gives it no bell row it could never read", () => {
    const notifications = read("lib/server/support-notifications.ts")
    expect(notifications).toContain("inArray(roles.name, [...SUPPORT_APRICART_ROLES])")
    expect(notifications).toContain("rows.filter(({ recipient }) => !isApricartSupportRole(recipient.role))")
  })

  it("lets a thread be assigned to the agent", () => {
    const service = read("lib/server/support-threads.ts")
    const assignee = service.slice(service.indexOf("async function resolveAssignee"))
    expect(assignee.slice(0, assignee.indexOf("\n}\n"))).toContain("inArray(roles.name, [...SUPPORT_APRICART_ROLES])")
  })
})

describe("support accounts", () => {
  it("are Super Admin's alone to create and manage", () => {
    expect(canAssignRole("SUPER_ADMIN", "APRICART_SUPPORT")).toBe(true)
    expect(canManageUser("SUPER_ADMIN", "APRICART_SUPPORT")).toBe(true)
    for (const actor of ["HEAD_OFFICE", "GROUP_USER", "BRANCH_ADMIN", "ORDER_DESK", "APRICART_EXECUTIVE", "WAREHOUSE"] as const) {
      expect(canAssignRole(actor, "APRICART_SUPPORT"), actor).toBe(false)
      expect(canManageUser(actor, "APRICART_SUPPORT"), actor).toBe(false)
    }
    // And an agent manages no one.
    expect(USER_MANAGEMENT_ROLES).not.toContain("APRICART_SUPPORT")
    expect(isApricartSupportApiRequestAllowed("POST", "/api/v1/users")).toBe(false)
  })

  it("carry no organization and no branch", () => {
    expect(apricartSupportUserShapeError(null, null)).toBeNull()
    expect(apricartSupportUserShapeError(10, null)).toMatch(/not assigned an organization or branch/)
    expect(apricartSupportUserShapeError(null, 5)).toMatch(/not assigned an organization or branch/)
    expect(read("app/api/v1/users/route.ts")).toContain(
      "else if (isApricartSupportRole(role)) shapeError = apricartSupportUserShapeError(organizationId, branchId)",
    )
  })

  it("are never switched into or out of the role, and have no reach to edit", () => {
    expect(apricartSupportAccessChangeError("APRICART_SUPPORT", {})).toBeNull()
    expect(apricartSupportAccessChangeError("APRICART_SUPPORT", { role: "APRICART_SUPPORT" })).toBeNull()
    expect(apricartSupportAccessChangeError("APRICART_SUPPORT", { role: "SUPER_ADMIN" })).toMatch(/cannot be switched/)
    expect(apricartSupportAccessChangeError("HEAD_OFFICE", { role: "APRICART_SUPPORT" })).toMatch(/cannot be switched/)
    expect(apricartSupportAccessChangeError("APRICART_SUPPORT", { organizationId: 10 })).toMatch(/no organization or branch/)
    expect(apricartSupportAccessChangeError("APRICART_SUPPORT", { branchIds: [1] })).toMatch(/no organization or branch/)
    // Not the agent's concern either way.
    expect(apricartSupportAccessChangeError("HEAD_OFFICE", { role: "BRANCH_ADMIN" })).toBeNull()
    expect(read("app/api/v1/users/[id]/access/route.ts")).toContain("apricartSupportAccessChangeError(targetRole, input)")
  })
})
