import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { resolveMultiBranchAnalyticsIds } from "@/lib/server/analytics-scope"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")

/**
 * The approver now lands on the Branch Admin dashboard and gets the order
 * directory, both reporting on the branches assigned to it.
 *
 * Those two pages are shared with the administrators, so the contracts below
 * pin the part that actually matters: reaching a shared page never widens what
 * it returns. Each analytics endpoint re-derives the caller's branch set on the
 * server, refuses a caller with no assignments instead of falling through to a
 * tenant-wide query, and leaves every other role's ladder untouched.
 */
describe("group user dashboard and order directory", () => {
  it("sends the approver home to the dashboard while keeping its queue exclusive", () => {
    const proxySource = source("proxy.ts")
    const areas = proxySource.slice(
      proxySource.indexOf("const GROUP_USER_AREAS = ["),
      proxySource.indexOf("// The approval area belongs to the approver alone"),
    )

    expect(proxySource).toContain('const GROUP_USER_HOME = "/dashboard"')
    // Money budgets joined the list when the approver gained allocation over
    // its assigned branches (`lib/money-budget-access.ts`).
    for (const area of ['"/approvals"', '"/budgets"', '"/dashboard"', '"/orders"', '"/reports"', '"/settings"']) {
      expect(areas).toContain(area)
    }
    // The administrator areas are still absent from the allowlist, so the
    // proxy keeps bouncing the approver home from them. The quantity ledger
    // stays with Head Office.
    for (const closedArea of ['"/organizations"', '"/users"', '"/branches"', '"/inventory"', '"/budget-by-quantity"', '"/groups"']) {
      expect(areas).not.toContain(closedArea)
    }
    // The queue remains closed to the administrators.
    expect(proxySource).toContain("pathMatchesPrefix(pathname, APPROVALS_AREA)")
  })

  it("lands the approver on the dashboard at sign-in", () => {
    const login = source("app/(auth)/login/page.tsx")

    expect(login).toContain('if (role === "GROUP_USER") return "/dashboard"')
    // The other roles keep the destinations they had.
    expect(login).toContain('if (role === "ORDER_PORTAL" || role === "EMPLOYEE") return "/shop"')
    expect(login).toContain('if (role === "GROUP_ORDER_PORTAL") return "/group-portal"')
  })

  it("routes only the approver to the group dashboard wrapper", () => {
    const dashboard = source("app/(portal)/dashboard/page.tsx")

    expect(dashboard).toContain('if (role === "BRANCH_ADMIN") return <BranchAdminDashboard />')
    expect(dashboard).toContain('if (role === "GROUP_USER") return <GroupUserDashboard />')
  })

  it("builds the approver's dashboard scope from its own assignments", () => {
    const wrapper = source("components/dashboard/group-user-dashboard.tsx")

    // The branch set comes from the endpoint that resolves the signed-in
    // user's assignments, never from a branch the client picked.
    expect(wrapper).toContain('"/api/v1/group-portal/scope"')
    expect(wrapper).toContain("branchId: null")
    // No assignments renders an explanation rather than an unscoped dashboard.
    expect(wrapper).toContain("if (assignedBranchIds.length === 0)")
  })

  it("keeps the shared dashboard unscoped-by-default for every other role", () => {
    const dashboard = source("components/dashboard/branch-admin-dashboard.tsx")

    // Without an explicit scope the component still reads the shell context,
    // so the Branch Admin's own view is unchanged.
    expect(dashboard).toContain("const organizationId = scope ? scope.organizationId : contextOrganizationId")
    expect(dashboard).toContain("const branchId = scope ? scope.branchId : contextBranchId")
    expect(dashboard).toContain("const isScopeReady = scope ? scope.isReady : isInitialized")
  })

  it("resolves the sales endpoint's branch filter on the server and denies an empty set", () => {
    const route = source("app/api/v1/analytics/sales-performance/route.ts")

    expect(route).toContain('const allowedRoles = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER"] as const')
    expect(route).toContain("await loadAnalyticsAssignedBranchIds(role, scope?.userId)")
    expect(route).toContain("resolveMultiBranchAnalyticsIds({")
    // An approver with no assignments is refused rather than served the tenant.
    expect(route).toContain("if (scopedBranchIds !== null && scopedBranchIds.length === 0) {")
    // The tenant filter is re-asserted from the session, not the query string.
    expect(route).toContain("const organizationIds = scopedBranchIds === null ? parseNumberList(organizationIdsParam) : []")
    // The branch breakdown selects from `branches`, so it is narrowed too.
    expect(route).toContain("branchListConditions.push(inArray(branches.id, scopedBranchIds))")
    // The Branch Admin path is untouched.
    expect(route).toContain('if (role === "BRANCH_ADMIN") {\n        return { organizationId: scope?.organizationId ?? null, branchId: scope?.branchId ?? null }')
  })

  it("resolves the drill-down endpoint's branch filter the same way", () => {
    const route = source("app/api/v1/analytics/drill-down/route.ts")

    expect(route).toContain('const allowedRoles = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER"] as const')
    expect(route).toContain("await loadAnalyticsAssignedBranchIds(role, scope?.userId)")
    // Returning an empty branch list here would leave the query filtered by
    // tenant alone, so the empty case is an explicit refusal.
    expect(route).toContain('error: "Access denied: no branches are assigned to your account"')
    // The Head Office and Branch Admin branches of the ladder are unchanged.
    expect(route).toContain('if (requested.length === 0 || role === "BRANCH_ADMIN") return { branchIds: [] }')
    expect(route).toContain('if (role !== "HEAD_OFFICE" || !organizationId) return { branchIds: [] }')
  })

  it("lets the order directory scope the approver on the server, not in the browser", () => {
    const orders = source("app/(portal)/orders/page.tsx")
    const ordersApi = source("app/api/v1/orders/route.ts")

    // The page sends no branch filter of its own for this role.
    expect(orders).toContain('const isGroupUser = userRole === "GROUP_USER"')
    // The endpoint resolves the branch set itself and denies an empty one.
    expect(ordersApi).toContain("usesMultiBranchScope(role) && typeof currentUserId === \"string\"")
    expect(ordersApi).toContain("branchIds.length === 0 ? DENY_ALL_ORDERS : inArray(orders.branchId, branchIds)")
  })

  it("pins the approver to its tenant in the shell context and never to a branch", () => {
    const context = source("components/context/app-context.tsx")

    expect(context).toContain('userRole === "GROUP_USER" && userOrgId')
    // A branch selection would be the client deciding its own scope.
    expect(context).toContain("setBranchId(null)")
    expect(context).toContain("setBranchIds([])")
  })

  it("still refuses a request that names branches outside the assignments", () => {
    expect(resolveMultiBranchAnalyticsIds({
      role: "GROUP_USER",
      assignedBranchIds: [7, 8],
      requestedBranchIds: [9],
    })).toEqual([])

    expect(resolveMultiBranchAnalyticsIds({
      role: "GROUP_USER",
      assignedBranchIds: [7, 8],
      requestedBranchIds: [],
    })).toEqual([7, 8])
  })
})
