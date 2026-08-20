import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ db: {} }))

import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"
import { canMakeOrderDecision } from "@/lib/order-approver-role"
import { MAX_BULK_DECISION_ORDERS, groupOrderDecisionSchema } from "./mutation-validation"
import { approverScope } from "./group-order-approvals"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

const baseDecision = {
  actorRole: "GROUP_USER" as const,
  actorOrganizationId: 1,
  actorBranchId: null,
  configuredApproverRole: "BRANCH_ADMIN",
  orderOrganizationId: 1,
  orderBranchId: 10,
  branchOrganizationId: 1,
}

describe("group user decision authority", () => {
  it("permits a decision only for a branch the approver is actually assigned", () => {
    expect(canMakeOrderDecision({ ...baseDecision, actorScopedBranchIds: [10, 11] })).toBe(true)
    expect(canMakeOrderDecision({ ...baseDecision, actorScopedBranchIds: [11] })).toBe(false)
  })

  it("fails closed when no scope was resolved", () => {
    expect(canMakeOrderDecision({ ...baseDecision, actorScopedBranchIds: [] })).toBe(false)
    expect(canMakeOrderDecision({ ...baseDecision, actorScopedBranchIds: null })).toBe(false)
    expect(canMakeOrderDecision({ ...baseDecision })).toBe(false)
  })

  it("never crosses a tenant boundary, even with the branch in scope", () => {
    expect(canMakeOrderDecision({
      ...baseDecision,
      orderOrganizationId: 2,
      actorScopedBranchIds: [10],
    })).toBe(false)
    // A branch whose organization disagrees with the order's is refused before
    // scope is consulted at all.
    expect(canMakeOrderDecision({
      ...baseDecision,
      branchOrganizationId: 2,
      actorScopedBranchIds: [10],
    })).toBe(false)
  })

  it("decides independently of the tenant's configured approver role", () => {
    for (const configuredApproverRole of ["BRANCH_ADMIN", "HEAD_OFFICE"]) {
      expect(canMakeOrderDecision({
        ...baseDecision,
        configuredApproverRole,
        actorScopedBranchIds: [10],
      })).toBe(true)
    }
  })

  it("leaves every other role's outcome untouched by the scope field", () => {
    // A stray scope list must not let a Branch Admin decide another branch.
    expect(canMakeOrderDecision({
      ...baseDecision,
      actorRole: "BRANCH_ADMIN",
      actorBranchId: 99,
      actorScopedBranchIds: [10],
    })).toBe(false)
    expect(canMakeOrderDecision({
      ...baseDecision,
      actorRole: "GROUP_ORDER_PORTAL",
      actorScopedBranchIds: [10],
    })).toBe(false)
    expect(canMakeOrderDecision({
      ...baseDecision,
      actorRole: "ORDER_PORTAL",
      actorScopedBranchIds: [10],
    })).toBe(false)
  })
})

describe("group user fulfilment token access", () => {
  it("exposes the token only once the order is approved", () => {
    expect(canViewFulfillmentToken({ role: "GROUP_USER", orderStatus: "APPROVED" })).toBe(true)
    expect(canViewFulfillmentToken({ role: "GROUP_USER", orderStatus: "PENDING" })).toBe(false)
    expect(canViewFulfillmentToken({ role: "GROUP_USER", orderStatus: "REJECTED" })).toBe(false)
    expect(canViewFulfillmentToken({ role: "GROUP_USER" })).toBe(false)
  })

  it("does not change any other role's token visibility", () => {
    expect(canViewFulfillmentToken({ role: "SUPER_ADMIN" })).toBe(true)
    expect(canViewFulfillmentToken({
      role: "BRANCH_ADMIN",
      configuredApproverRole: "HEAD_OFFICE",
    })).toBe(false)
    expect(canViewFulfillmentToken({
      role: "ORDER_PORTAL",
      orderStatus: "APPROVED",
      userId: "u1",
      orderCreatedByUserId: "u2",
    })).toBe(false)
    expect(canViewFulfillmentToken({ role: "GROUP_ORDER_PORTAL", orderStatus: "APPROVED" })).toBe(false)
  })
})

describe("approver scope resolution", () => {
  it("is unusable without a tenant or without assignments", () => {
    expect(approverScope(null, [1, 2])).toEqual({ usable: false })
    expect(approverScope(1, [])).toEqual({ usable: false })
  })

  it("carries the tenant and the explicit branch list when both are present", () => {
    expect(approverScope(1, [4, 5])).toEqual({ usable: true, organizationId: 1, branchIds: [4, 5] })
  })
})

describe("bulk decision validation", () => {
  it("accepts a bounded, unique list of order ids", () => {
    const parsed = groupOrderDecisionSchema.safeParse({ decision: "approve", orderIds: [1, 2, 3] })
    expect(parsed.success).toBe(true)
  })

  it("rejects duplicates, empty selections, and oversized batches", () => {
    expect(groupOrderDecisionSchema.safeParse({ decision: "approve", orderIds: [1, 1] }).success).toBe(false)
    expect(groupOrderDecisionSchema.safeParse({ decision: "approve", orderIds: [] }).success).toBe(false)
    expect(groupOrderDecisionSchema.safeParse({
      decision: "approve",
      orderIds: Array.from({ length: MAX_BULK_DECISION_ORDERS + 1 }, (_, index) => index + 1),
    }).success).toBe(false)
  })

  it("refuses unknown fields and unknown decisions", () => {
    expect(groupOrderDecisionSchema.safeParse({
      decision: "fulfill",
      orderIds: [1],
    }).success).toBe(false)
    expect(groupOrderDecisionSchema.safeParse({
      decision: "approve",
      orderIds: [1],
      branchId: 3,
    }).success).toBe(false)
  })
})

describe("group user approval surface contracts", () => {
  const queueRoute = "app/api/v1/group-portal/approvals/route.ts"
  const decideRoute = "app/api/v1/group-portal/approvals/decide/route.ts"

  it("gates both approval endpoints on the one approver role", () => {
    const gate = source("lib/server/group-order-access.ts")
    const approverGate = gate.slice(gate.indexOf("export type GroupApproverActor"))

    expect(approverGate).toContain("requireApiRole([GROUP_USER_ROLE])")
    // The requesting role must not be able to decide the orders it raises.
    expect(approverGate).not.toContain("GROUP_ORDER_PORTAL_ROLE")
    // Without a tenant there is no scope, and that must never read as "all".
    expect(approverGate).toContain("if (!scope.organizationId)")
    expect(approverGate).toContain("resolveScopedBranchIds(db, scope.userId)")

    for (const path of [queueRoute, decideRoute]) {
      const route = source(path)
      expect(route).toContain("requireGroupApprover()")
      expect(route).toContain("if (response) return response")
      // No endpoint may build its own weaker allowlist.
      expect(route).not.toContain("requireApiRole(")
    }
  })

  it("re-authorizes every order in a bulk decision through the shared service", () => {
    const decide = source(decideRoute)

    // The ids are a request, not an authorization: each is decided through the
    // same service the single-order routes use, which re-runs the policy inside
    // the transaction that performs the write.
    expect(decide).toContain("approveOrder({ orderId, scope, user })")
    expect(decide).toContain("rejectOrder({ orderId, scope, user, reason: reason as string })")
    // The scope handed to those calls is the server-resolved one, never a
    // value taken from the request body.
    expect(decide).toContain("actor.scope,")
    expect(decide).toContain("groupOrderDecisionSchema.safeParse")
    expect(decide).toContain('withRateLimit("order", actor.scope.userId)')
    // A rejection always carries a reason, matching the single-order route.
    expect(decide).toContain('return error("A reason is required to reject orders", 400)')
    // The decision must never trust a branch or tenant supplied by the caller.
    expect(decide).not.toContain("body.branchId")
    expect(decide).not.toContain("searchParams.get(\"organizationId\")")
  })

  it("reads the approval queue only within the approver's tenant and branch scope", () => {
    const approvals = source("lib/server/group-order-approvals.ts")

    expect(approvals).toContain("if (!scope.usable) return emptyPage(page, limit)")
    expect(approvals).toContain("eq(orders.organizationId, scope.organizationId)")
    expect(approvals).toContain("inArray(orders.branchId, scope.branchIds)")
    expect(approvals).toContain("eq(groupOrders.organizationId, scope.organizationId)")
    // An empty assignment set is no access, never organization-wide access.
    expect(approvals).toContain("if (!organizationId || scopedBranchIds.length === 0) return { usable: false }")
    // Token visibility defers to the one shared policy rather than a local rule.
    expect(approvals).toContain("canViewFulfillmentToken({")
    expect(approvals).toContain("role: GROUP_USER_ROLE,")
  })

  it("scopes the token hand-off to the approver's assignments without widening other roles", () => {
    const tokenEmail = source("app/api/v1/orders/[id]/send-token-email/route.ts")

    expect(tokenEmail).toContain('requireApiRole(["HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL"])')
    // Every other role keeps the original single-branch check untouched.
    expect(tokenEmail).toContain("if (role !== GROUP_USER_ROLE) {")
    expect(tokenEmail).toContain("return verifyResourceAccess(order.organizationId, order.branchId)")
    // The approver is checked against its resolved assignments, tenant first.
    expect(tokenEmail).toContain("if (!actorOrganizationId || actorOrganizationId !== order.organizationId) return false")
    expect(tokenEmail).toContain("canUseScopedBranch(userId, order.branchId)")
  })

  it("confines the approval workspace to the approver in the proxy and the server layout", () => {
    const proxySource = source("proxy.ts")
    const layout = source("app/(portal)/approvals/layout.tsx")

    // The approver works inside the shared shell, but only in the areas its
    // role has; everything else redirects back to its own queue.
    expect(proxySource).toContain('const GROUP_USER_HOME = "/approvals"')
    expect(proxySource).toContain('const GROUP_USER_AREAS = ["/approvals", "/reports", "/settings"]')
    expect(proxySource).toContain("GROUP_USER_AREAS.some((prefix) => pathMatchesPrefix(pathname, prefix))")
    // The queue is the approver's alone: an administrator is sent away from it.
    expect(proxySource).toContain("pathMatchesPrefix(pathname, APPROVALS_AREA)")
    expect(layout).toContain('!== GROUP_USER_ROLE) redirect("/dashboard")')
  })

  it("leaves the requester's ordering surface unable to decide orders", () => {
    const orderingGate = source("lib/server/group-order-access.ts")
    const bulkOrderLayout = source("app/group-portal/bulk-order/layout.tsx")

    // The ordering gate is unchanged in what it accepts.
    expect(orderingGate).toContain("requireApiRole([GROUP_ORDER_PORTAL_ROLE])")
    expect(bulkOrderLayout).toContain("!== GROUP_ORDER_PORTAL_ROLE")
  })
})
