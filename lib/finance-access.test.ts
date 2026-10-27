import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { ACTIVITY_ACTOR_ROLES, ACTIVITY_TENANT_ACTOR_ROLES } from "@/lib/activity-log"
import { isPaymentStatusUpdateEligible } from "@/lib/business-rules"
import { canReadConsolidatedInvoiceReport } from "@/lib/consolidated-invoice-access"
import {
  FINANCE_API_RULES,
  FINANCE_HOME,
  FINANCE_NO_ORGANIZATIONS,
  FINANCE_ORGANIZATION_OUTSIDE_REACH,
  FINANCE_READ_RULES,
  FINANCE_ROLE,
  FINANCE_WRITE_RULES,
  canReadFinanceKpis,
  canUpdatePaymentStatus,
  fenceFinanceOrganizationIds,
  financeAccessChangeError,
  financeOrganizationsError,
  financeUserShapeError,
  isFinanceApiRequestAllowed,
  isFinanceAreaAllowed,
  resolveFinanceReach,
} from "@/lib/finance-access"
import { mayCreateOrder } from "@/lib/order-creation-access"
import { ROLE_TEMPLATES, Permission } from "@/lib/permissions"
import { canMutatePrices } from "@/lib/pricing-access"
import { isValidRole } from "@/lib/rbac"
import { canAssignRole, canManageUser } from "@/lib/server/user-access-policy"
import { systemRoleSchema, userCreateSchema } from "@/lib/server/mutation-validation"
import { USER_MANAGEMENT_ROLES } from "@/lib/user-management-access"
import { isReadOnlyRole, viewerAccessFor } from "@/lib/viewer-access"

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("the Finance role", () => {
  it("is a known role everywhere roles are listed", () => {
    expect(isValidRole(FINANCE_ROLE)).toBe(true)
    expect(systemRoleSchema.safeParse(FINANCE_ROLE).success).toBe(true)
    // lib/auth.ts falls back to BRANCH_ADMIN for an unknown role, so a role
    // missing from its list would quietly become a branch administrator.
    expect(read("lib/auth.ts")).toContain("'FINANCE'")
    expect(read("drizzle/20261102120000_finance_role.sql")).toContain("SELECT 'FINANCE'")
    expect(read("drizzle/20261102120000_finance_role.sql")).toContain("\"finance_organization_assignments\"")
    expect(read("drizzle/meta/_journal.json")).toContain('"20261102120000_finance_role"')
    expect(ROLE_TEMPLATES.FINANCE).toBeDefined()
  })

  it("holds read permissions only — no pricing, no scheduling, no management", () => {
    const permissions = ROLE_TEMPLATES.FINANCE.permissions as readonly string[]
    expect(permissions).not.toContain(Permission.PRICING_MANAGE)
    expect(permissions).not.toContain(Permission.REPORTS_SCHEDULE)
    for (const key of permissions) expect(key).not.toMatch(/:(create|edit|delete|approve|manage|reject|cancel)/)
  })

  it("creates no orders and writes no prices", () => {
    expect(mayCreateOrder(FINANCE_ROLE)).toBe(false)
    expect(canMutatePrices(FINANCE_ROLE)).toBe(false)
  })

  it("is created and managed by Super Admin alone, never by Head Office", () => {
    expect(USER_MANAGEMENT_ROLES).toContain("HEAD_OFFICE")
    expect(canAssignRole("SUPER_ADMIN", FINANCE_ROLE)).toBe(true)
    expect(canManageUser("SUPER_ADMIN", FINANCE_ROLE)).toBe(true)
    expect(canAssignRole("HEAD_OFFICE", FINANCE_ROLE)).toBe(false)
    expect(canManageUser("HEAD_OFFICE", FINANCE_ROLE)).toBe(false)
  })

  it("is Apricart's own staff in the activity log, never a tenant role", () => {
    expect(ACTIVITY_ACTOR_ROLES).toContain(FINANCE_ROLE)
    expect(ACTIVITY_TENANT_ACTOR_ROLES as readonly string[]).not.toContain(FINANCE_ROLE)
  })

  it("reads pages as Super Admin, with every write control hidden", () => {
    expect(viewerAccessFor({ role: FINANCE_ROLE })).toEqual({ role: FINANCE_ROLE, viewRole: "SUPER_ADMIN", readOnly: true })
    expect(isReadOnlyRole(FINANCE_ROLE)).toBe(true)
    expect(canReadConsolidatedInvoiceReport(FINANCE_ROLE)).toBe(true)
  })

  it("alone with Super Admin marks orders paid and reads the payment KPIs", () => {
    expect(canUpdatePaymentStatus(FINANCE_ROLE)).toBe(true)
    expect(canUpdatePaymentStatus("SUPER_ADMIN")).toBe(true)
    expect(canReadFinanceKpis(FINANCE_ROLE)).toBe(true)
    for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "VIEWER", "WAREHOUSE", "APRICART_SUPPORT", undefined]) {
      expect(canUpdatePaymentStatus(role)).toBe(false)
      expect(canReadFinanceKpis(role)).toBe(false)
    }
  })
})

describe("the organization fence", () => {
  it("is every assigned organization when none is asked for", () => {
    expect(fenceFinanceOrganizationIds([3, 1, 3, 2])).toEqual({ ok: true, organizationIds: [1, 2, 3] })
  })

  it("narrows to what was asked for inside the reach", () => {
    expect(fenceFinanceOrganizationIds([1, 2, 3], ["2", 3])).toEqual({ ok: true, organizationIds: [2, 3] })
  })

  it("refuses a request naming any organization outside the reach, rather than narrowing it", () => {
    expect(fenceFinanceOrganizationIds([1, 2], [2, 9])).toEqual({ ok: false, status: 403, error: FINANCE_ORGANIZATION_OUTSIDE_REACH })
  })

  it("never answers an empty reach with success — empty would read as every organization", () => {
    expect(fenceFinanceOrganizationIds([])).toEqual({ ok: false, status: 403, error: FINANCE_NO_ORGANIZATIONS })
    expect(fenceFinanceOrganizationIds([], [1])).toEqual({ ok: false, status: 403, error: FINANCE_NO_ORGANIZATIONS })
    expect(fenceFinanceOrganizationIds([0, -1, "x", null])).toMatchObject({ ok: false })
  })

  it("ignores malformed requested ids instead of treating them as a selection", () => {
    expect(fenceFinanceOrganizationIds([4], ["abc", 0, -2])).toEqual({ ok: true, organizationIds: [4] })
  })

  it("is empty for an account that is not a live Finance account", () => {
    const live = { role: FINANCE_ROLE, isActive: true, deleted: false }
    expect(resolveFinanceReach({ account: live, assignedOrganizationIds: [5, 2, 5] })).toEqual([2, 5])
    expect(resolveFinanceReach({ account: { ...live, isActive: false }, assignedOrganizationIds: [5] })).toEqual([])
    expect(resolveFinanceReach({ account: { ...live, deleted: true }, assignedOrganizationIds: [5] })).toEqual([])
    expect(resolveFinanceReach({ account: { ...live, role: "HEAD_OFFICE" }, assignedOrganizationIds: [5] })).toEqual([])
    expect(resolveFinanceReach({ account: null, assignedOrganizationIds: [5] })).toEqual([])
  })
})

describe("accounts", () => {
  it("carry no organization or branch of their own", () => {
    expect(financeUserShapeError(null, null)).toBeNull()
    expect(financeUserShapeError(1, null)).not.toBeNull()
    expect(financeUserShapeError(null, 4)).not.toBeNull()
  })

  it("must be given at least one organization, and only Finance is given any this way", () => {
    expect(financeOrganizationsError(FINANCE_ROLE, [])).not.toBeNull()
    expect(financeOrganizationsError(FINANCE_ROLE, [1, 2])).toBeNull()
    expect(financeOrganizationsError("HEAD_OFFICE", [1])).not.toBeNull()
    expect(financeOrganizationsError("HEAD_OFFICE", [])).toBeNull()
  })

  it("parse the organizations on creation, bounded and without duplicates", () => {
    const base = {
      firstName: "Fin", lastName: "Ance", email: "finance@example.test", username: "finance.one",
      password: "Correct-Horse-9!", role: FINANCE_ROLE, organizationId: null, branchId: null,
    }
    expect(userCreateSchema.safeParse({ ...base, financeOrganizationIds: [1, 2] }).success).toBe(true)
    expect(userCreateSchema.safeParse({ ...base, financeOrganizationIds: [1, 1] }).success).toBe(false)
    expect(userCreateSchema.safeParse({ ...base, financeOrganizationIds: [0] }).success).toBe(false)
    expect(userCreateSchema.safeParse({ ...base, financeOrganizationIds: Array.from({ length: 501 }, (_, i) => i + 1) }).success).toBe(false)
  })

  it("are never switched into or out of the role, and have no reach to edit on the access route", () => {
    expect(financeAccessChangeError(FINANCE_ROLE, { role: "HEAD_OFFICE" })).not.toBeNull()
    expect(financeAccessChangeError("HEAD_OFFICE", { role: FINANCE_ROLE })).not.toBeNull()
    expect(financeAccessChangeError(FINANCE_ROLE, { organizationId: 3 })).not.toBeNull()
    expect(financeAccessChangeError(FINANCE_ROLE, {})).toBeNull()
    expect(financeAccessChangeError("HEAD_OFFICE", { organizationId: 3 })).toBeNull()
  })
})

describe("Paid / Unpaid", () => {
  it.each([
    ["APPROVED", "NOT_STARTED", true],
    ["APPROVED", "IN_PROCESS", true],
    ["APPROVED", "DELIVERED", true],
    ["FULFILLED", "DELIVERED", true],
    [" fulfilled ", "delivered", true],
    ["PENDING", "NOT_STARTED", false],
    ["REJECTED", "NOT_STARTED", false],
    ["CANCELLED", "NOT_STARTED", false],
    ["REFUNDED", "DELIVERED", false],
  ])("an order %s / %s may be marked: %s", (status, fulfilment, expected) => {
    expect(isPaymentStatusUpdateEligible(status, fulfilment)).toBe(expected)
  })

  it("is claimed in SQL on the same statuses the rule admits", () => {
    const source = read("lib/order-select.ts")
    const claim = source.slice(source.indexOf("export async function transitionOrderPaymentStatusColumn"))
    expect(claim.match(/IN \('APPROVED', 'FULFILLED'\)/g)?.length).toBe(2)
  })
})

describe("the page areas", () => {
  it.each([FINANCE_HOME, "/orders", "/orders/42", "/invoices/42", "/reports", "/reports/order-report", "/reports/consolidated-invoices"])(
    "admits %s", (path) => expect(isFinanceAreaAllowed(path)).toBe(true),
  )

  it.each(["/dashboard", "/users", "/settings", "/organizations", "/support", "/activity", "/reports/group-orders", "/financex", "/ordersx"])(
    "refuses %s", (path) => expect(isFinanceAreaAllowed(path)).toBe(false),
  )
})

describe("the API allowlist", () => {
  it.each([
    ["GET", "/api/v1/finance/payment-kpis"],
    ["GET", "/api/v1/orders"],
    ["GET", "/api/v1/orders/42"],
    ["HEAD", "/api/v1/orders/42"],
    ["GET", "/api/v1/orders/42/refunds"],
    ["GET", "/api/v1/receipts/42"],
    ["GET", "/api/v1/receipts/42/credit-notes/3/download"],
    ["POST", "/api/v1/orders/42/payment-status"],
    ["GET", "/api/v1/analytics/summary"],
    ["GET", "/api/v1/analytics/executive/budget-burn/item-comparison"],
    ["GET", "/api/v1/reports/consolidated-invoice/pdf"],
    ["POST", "/api/v1/users/me/change-password"],
  ])("admits %s %s", (method, path) => {
    expect(isFinanceApiRequestAllowed(method, path)).toBe(true)
  })

  it.each([
    ["POST", "/api/v1/orders"],
    ["PUT", "/api/v1/orders/42"],
    ["POST", "/api/v1/orders/42/approve"],
    ["POST", "/api/v1/orders/42/reject"],
    ["POST", "/api/v1/orders/42/fulfill"],
    ["POST", "/api/v1/orders/42/fulfillment-status"],
    ["POST", "/api/v1/orders/42/refunds"],
    ["POST", "/api/v1/orders/42/send-token-email"],
    ["GET", "/api/v1/orders/42/payment-status"],
    ["POST", "/api/v1/orders/abc/payment-status"],
    ["POST", "/api/v1/categories"],
    ["POST", "/api/v1/reports/schedule"],
    ["GET", "/api/v1/reports/schedule"],
    ["GET", "/api/v1/users"],
    ["GET", "/api/v1/notifications"],
    ["GET", "/api/v1/analytics/sales-performance"],
    ["GET", "/api/v1/analytics/drill-down"],
    ["GET", "/api/v1/activity-logs"],
    ["GET", "/api/v1/budgets"],
    ["PUT", "/api/v1/users/x/finance-organizations"],
    ["GET", "/api/v1/orders-export"],
    ["GET", "/api/v1/analytics/summary/extra"],
  ])("refuses %s %s", (method, path) => {
    expect(isFinanceApiRequestAllowed(method, path)).toBe(false)
  })

  /**
   * The control. Every read handler on the list must fence Finance itself —
   * through `resolveFinanceReadScope`, `financeReachesOrganization`, or a
   * reviewed shared helper that calls one of them — because the proxy is not
   * the boundary.
   */
  const FENCING_HELPERS: Record<string, string> = {
    "lib/server/order-read-access.ts": "ORDER_DETAIL_READ_ROLES",
    "lib/server/invoice-access.ts": "authorizeInvoiceRequest",
    "lib/server/executive-analytics-scope.ts": "resolveExecutiveScope",
    "lib/server/consolidated-invoice-report.ts": "loadConsolidatedInvoiceReport",
  }

  it("the shared helpers it relies on fence Finance", () => {
    expect(read("lib/server/order-read-access.ts")).toContain("financeReachesOrganization(")
    expect(read("lib/server/invoice-access.ts")).toContain("loadFinanceOrganizationIds(")
    expect(read("lib/invoice-access-policy.ts")).toContain("assigned-organizations")
    expect(read("lib/server/executive-analytics-scope.ts")).toContain("fenceFinanceOrganizationIds(")
    expect(read("lib/server/consolidated-invoice-report.ts")).toContain("resolveFinanceReadScope(")
  })

  it("names only handlers that exist, export every listed verb, and fence Finance themselves", () => {
    for (const rule of FINANCE_API_RULES) {
      expect(existsSync(resolve(process.cwd(), rule.route)), rule.route).toBe(true)
      const source = read(rule.route)
      for (const method of rule.methods) {
        expect(source, `${rule.route} ${method}`).toMatch(new RegExp(`export async function ${method}\\b`))
      }
    }
    for (const rule of FINANCE_READ_RULES) {
      const source = read(rule.route)
      const fenced = /resolveFinanceReadScope\(|financeReachesOrganization\(/.test(source)
        || Object.values(FENCING_HELPERS).some((entry) => source.includes(entry))
      expect(fenced, `${rule.route} does not fence Finance`).toBe(true)
    }
  })

  it("has exactly one write, and that write checks the reach under a lock", () => {
    expect(FINANCE_WRITE_RULES.map((rule) => rule.route)).toEqual(["app/api/v1/orders/[id]/payment-status/route.ts"])
    const source = read("app/api/v1/orders/[id]/payment-status/route.ts")
    expect(source).toContain("requireApiRole([...PAYMENT_STATUS_UPDATE_ROLES])")
    expect(source).toContain("financeReachesOrganization(tx, user.id, order.organizationId, { lock: true })")
  })

  it("is enforced by the proxy, before any handler, with its own page areas", () => {
    const proxy = read("proxy.ts")
    expect(proxy).toContain("isFinanceRole((token as any)?.role) && !isFinanceApiRequestAllowed(req.method, pathname)")
    expect(proxy).toContain("{ matches: isFinanceRole, allows: isFinanceAreaAllowed, home: FINANCE_HOME }")
  })

  it("lands on its payment KPIs after sign-in", () => {
    expect(read("app/(auth)/login/page.tsx")).toContain("if (isFinanceRole(role)) return FINANCE_HOME")
  })
})
