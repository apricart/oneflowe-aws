import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import {
  isMultiBranchAnalyticsRole,
  resolveAnalyticsBranchIds,
  resolveMultiBranchAnalyticsIds,
} from "@/lib/server/analytics-scope"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * The approver reads the same reports a Branch Admin does, but its reach is a
 * set of assigned branches rather than one. These contracts pin the resolution
 * closed: an empty assignment set is no access, a request cannot widen the set,
 * and no other role's path changes shape.
 */
describe("multi-branch analytics scope", () => {
  it("treats only the approver as a multi-branch analytics role", () => {
    expect(isMultiBranchAnalyticsRole("GROUP_USER")).toBe(true)
    // The requester raises orders and has no reporting surface.
    expect(isMultiBranchAnalyticsRole("GROUP_ORDER_PORTAL")).toBe(false)
    for (const role of ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", ""]) {
      expect(isMultiBranchAnalyticsRole(role)).toBe(false)
    }
  })

  it("returns null for every role that is not multi-branch, leaving them untouched", () => {
    expect(resolveMultiBranchAnalyticsIds({
      role: "BRANCH_ADMIN",
      assignedBranchIds: [1, 2, 3],
    })).toBeNull()
  })

  it("denies rather than widens when the approver has no assignments", () => {
    expect(resolveMultiBranchAnalyticsIds({
      role: "GROUP_USER",
      assignedBranchIds: [],
      allowedBranchIds: [1, 2, 3],
    })).toEqual([])

    expect(resolveMultiBranchAnalyticsIds({
      role: "GROUP_USER",
      assignedBranchIds: null,
      allowedBranchIds: [1, 2, 3],
    })).toEqual([])
  })

  it("never lets a requested branch reach outside the assignments", () => {
    expect(resolveMultiBranchAnalyticsIds({
      role: "GROUP_USER",
      assignedBranchIds: [4, 5],
      allowedBranchIds: [1, 2, 3, 4, 5],
      requestedBranchIds: [1, 2, 4],
    })).toEqual([4])

    // A request naming only unassigned branches resolves to nothing at all,
    // rather than falling back to the full assignment set.
    expect(resolveMultiBranchAnalyticsIds({
      role: "GROUP_USER",
      assignedBranchIds: [4, 5],
      allowedBranchIds: [1, 2, 3, 4, 5],
      requestedBranchIds: [1, 2],
    })).toEqual([])
  })

  it("narrows the assignments by the tenant's own branch list", () => {
    // Branch 9 is assigned but sits outside the resolved organization scope.
    expect(resolveMultiBranchAnalyticsIds({
      role: "GROUP_USER",
      assignedBranchIds: [4, 9],
      allowedBranchIds: [1, 4],
    })).toEqual([4])
  })

  it("routes the approver through the multi-branch path in the shared resolver", () => {
    expect(resolveAnalyticsBranchIds({
      role: "GROUP_USER",
      userBranchId: 7,
      requestedBranchIds: [],
      allowedBranchIds: [1, 2, 3],
      assignedBranchIds: [2, 3],
    })).toEqual([2, 3])

    // The single-branch roles keep their existing behaviour exactly.
    expect(resolveAnalyticsBranchIds({
      role: "BRANCH_ADMIN",
      userBranchId: 3,
      requestedBranchIds: [1, 2],
      allowedBranchIds: [1, 2, 3],
    })).toEqual([3])
  })
})

describe("group user reporting endpoints", () => {
  it("resolves the assignment set on the server, never from the request", () => {
    const resolver = source("lib/server/analytics-branch-scope.ts")

    expect(resolver).toContain("resolveScopedBranchIds(db, userId)")
    expect(resolver).toContain("if (!isMultiBranchAnalyticsRole(role)) return null")
    // A missing user id is a deny, not an unfiltered read.
    expect(resolver).toContain('if (typeof userId !== "string" || userId.length === 0) return []')
  })

  it("pins every report endpoint the role can reach to its assignments", () => {
    for (const route of [
      "app/api/v1/analytics/summary/route.ts",
      "app/api/v1/analytics/refunds/route.ts",
      "app/api/v1/analytics/products/performance/route.ts",
      "app/api/v1/analytics/orders/itemized/route.ts",
      "app/api/v1/analytics/users/performance/route.ts",
      "app/api/v1/analytics/users/products/route.ts",
      "app/api/v1/analytics/branches/performance/route.ts",
    ]) {
      expect(source(route)).toContain("loadAnalyticsAssignedBranchIds")
    }
  })

  it("refuses the order and refund reports when the approver has no branches", () => {
    const summary = source("app/api/v1/analytics/summary/route.ts")
    const refunds = source("app/api/v1/analytics/refunds/route.ts")

    expect(summary).toContain("if (!context.assignedBranchIds?.length) return \"Branch context missing\"")
    expect(summary).toContain("conditions.push(inArray(orders.branchId, context.assignedBranchIds))")
    expect(refunds).toContain("if (multiBranchIds.length === 0) return { conditions, error: \"Branch context missing\" }")
  })

  it("lists only the assigned branches and groups behind the report filters", () => {
    const branchesRoute = source("app/api/v1/branches/route.ts")
    const groupsRoute = source("app/api/v1/groups/route.ts")

    expect(branchesRoute).toContain("usesMultiBranchScope(scope.role)")
    expect(branchesRoute).toContain("resolveScopedBranchIds(db, scope.userId)")
    // An empty assignment set is refused rather than listing the whole tenant.
    expect(branchesRoute).toContain("if (assignedBranchIds && assignedBranchIds.length === 0) {")
    expect(groupsRoute).toContain("usesMultiBranchScope(role)")
    expect(groupsRoute).toContain("resolveScopedGroupIds(db, (session.user as any).id)")
  })

  it("keeps the group order filter inside the tenant already resolved", () => {
    const summary = source("app/api/v1/analytics/summary/route.ts")

    expect(summary).toContain('url.searchParams.get("groupOrderRef")')
    expect(summary).toContain("inArray(groupOrders.organizationId, scopedOrganizationIds)")
    // The filter narrows an existing scope; it is applied after it, never
    // instead of it.
    expect(summary.indexOf("const groupOrderError = addSummaryGroupOrderCondition(")).toBeGreaterThan(
      summary.indexOf("const scopeError = addSummaryScopeConditions(conditions, {"),
    )
  })

  it("offers the group order filter and column to the approver alone", () => {
    const orderReport = source("app/(portal)/reports/order-report/page.tsx")

    expect(orderReport).toContain('const showsGroupOrders = role === "GROUP_USER"')
    expect(orderReport).toContain('reportParams.set("groupOrderRef", debouncedGroupOrderFilter)')
    expect(orderReport).toContain('if (!showsGroupOrders && c.key === "groupOrderReference") return false;')
  })

  it("gives the approver a sidebar without any administrator area", () => {
    const sidebar = source("components/shell/sidebar.tsx")
    const groupUserNav = sidebar.slice(
      sidebar.indexOf('if (role === "GROUP_USER")'),
      sidebar.indexOf("return baseNav"),
    )

    expect(groupUserNav).toContain('href: "/approvals"')
    expect(groupUserNav).toContain('href: "/reports/order-report"')
    expect(groupUserNav).toContain('href: "/settings"')
    for (const adminArea of [
      '"/organizations"',
      '"/users"',
      '"/branches"',
      '"/inventory"',
      '"/budgets"',
      '"/groups"',
      '"/dashboard"',
      '"/orders"',
    ]) {
      expect(groupUserNav).not.toContain(`href: ${adminArea}`)
    }
  })
})
