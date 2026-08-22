import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * The order list endpoint authenticates but does not use a role allowlist; it
 * narrows rows per role instead. A role with no branch of its own must never
 * fall through that ladder into the whole tenant, so these contracts pin the
 * fail-closed shape in place.
 */
describe("order list tenant scoping", () => {
  const orders = source("app/api/v1/orders/route.ts")

  it("restricts multi-branch roles to their resolved branches", () => {
    expect(orders).toContain("usesMultiBranchScope(role)")
    expect(orders).toContain("addMultiBranchOrderScope(conditions, context.scopedBranchIds)")
    expect(orders).toContain("inArray(orders.branchId, branchIds)")
  })

  it("resolves that scope on the server, never from the request", () => {
    expect(orders).toContain("resolveScopedBranchIds(db, currentUserId)")
    expect(orders).not.toContain("searchParams.get(\"scopedBranchIds\")")
  })

  it("denies every branch of the ladder that lacks an explicit scope", () => {
    // An empty multi-branch scope, a missing organization, and a role with no
    // branch all have to end in an impossible condition rather than no filter.
    expect(orders).toContain("const DENY_ALL_ORDERS = sql`false`")
    expect(orders).toContain("branchIds.length === 0 ? DENY_ALL_ORDERS")

    const roleConditions = orders.slice(
      orders.indexOf("function addOrderRoleConditions"),
      orders.indexOf("function addOrderDimensionConditions"),
    )
    // The organization guard and the single-branch tail each deny by default.
    expect(roleConditions.match(/DENY_ALL_ORDERS/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it("leaves the Super Admin, Head Office, and Order Portal paths intact", () => {
    const roleConditions = orders.slice(
      orders.indexOf("function addOrderRoleConditions"),
      orders.indexOf("function addOrderDimensionConditions"),
    )
    expect(roleConditions).toContain('if (role === "SUPER_ADMIN")')
    expect(orders).toContain("addSuperAdminOrderScope(conditions, context.organizationIdParam)")
    expect(roleConditions).toContain('if (role === "HEAD_OFFICE") return')
    expect(roleConditions).toContain('role === "ORDER_PORTAL" && currentUserId')
    expect(roleConditions).toContain("eq(orders.createdByUserId, currentUserId)")
  })
})

describe("group user decision surface", () => {
  it("keeps approve and reject the only decision endpoints it can reach", () => {
    const approve = source("app/api/v1/orders/[id]/approve/route.ts")
    const reject = source("app/api/v1/orders/[id]/reject/route.ts")
    const fulfill = source("app/api/v1/orders/[id]/fulfill/route.ts")
    const detail = source("app/api/v1/orders/[id]/route.ts")

    expect(approve).toContain('"GROUP_USER"')
    expect(reject).toContain('"GROUP_USER"')
    // Fulfillment stays Super Admin-only; it never gains the new role.
    expect(fulfill).not.toContain("GROUP_USER")
  })

  it("lets the approver read one order but never write to it", () => {
    const detail = source("app/api/v1/orders/[id]/route.ts")

    // Reading a single order is how the approver opens the detail drawer, so
    // the role is on the GET allowlist only.
    expect(detail).toContain('requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL"])')
    // Editing stays with the requester and deletion with the Super Admin.
    expect(detail).toContain('requireApiRole(["ORDER_PORTAL"])')
    expect(detail).toContain('requireApiRole(["SUPER_ADMIN"])')
  })

  it("checks that read against the approver's assignments, not a single branch", () => {
    const detail = source("app/api/v1/orders/[id]/route.ts")

    // Every other role keeps the original single-branch check untouched.
    expect(detail).toContain("if (role !== GROUP_USER_ROLE) {")
    expect(detail).toContain("return verifyResourceAccess(order.organizationId, order.branchId)")
    // The approver is checked against its resolved assignments, tenant first.
    expect(detail).toContain("if (!scope.organizationId || scope.organizationId !== order.organizationId) return false")
    expect(detail).toContain("canUseScopedBranch(userId, order.branchId)")
  })

  it("never lets the ordering-only group role decide", () => {
    const scope = source("lib/server/multi-branch-scope.ts")
    expect(scope).toContain("export function isGroupApproverRole")
    expect(scope).toContain('return role === GROUP_USER_ROLE')
  })
})
