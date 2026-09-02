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

  it("scopes the token hand-off to assignments without widening the single-branch roles", () => {
    const tokenEmail = source("app/api/v1/orders/[id]/send-token-email/route.ts")

    // Both group roles reach the hand-off; the single-branch roles are exactly
    // the ones that were already there.
    expect(tokenEmail).toContain('"GROUP_USER",')
    expect(tokenEmail).toContain('"GROUP_ORDER_PORTAL",')
    expect(tokenEmail).toContain('"HEAD_OFFICE",')
    expect(tokenEmail).toContain('"BRANCH_ADMIN",')
    expect(tokenEmail).toContain('"ORDER_PORTAL",')
    // Every single-branch role keeps the original check untouched.
    expect(tokenEmail).toContain("if (!usesMultiBranchScope(role)) {")
    expect(tokenEmail).toContain("return verifyResourceAccess(order.organizationId, order.branchId)")
    // A group role is checked against its resolved assignments, tenant first.
    expect(tokenEmail).toContain("if (!actorOrganizationId || actorOrganizationId !== order.organizationId) return false")
    expect(tokenEmail).toContain("canUseScopedBranch(userId, order.branchId)")
    // Whether a token may be shared at all is still the one shared policy's
    // decision, so the requester cannot reach an order it did not raise.
    expect(tokenEmail).toContain("const canShareToken = canViewFulfillmentToken({")
    expect(tokenEmail).toContain("orderCreatedByUserId: order.createdByUserId,")
  })

  it("confines the approval workspace to the approver in the proxy and the server layout", () => {
    const proxySource = source("proxy.ts")
    const layout = source("app/(portal)/approvals/layout.tsx")

    // The approver works inside the shared shell, but only in the areas its
    // role has; everything else redirects back to its own dashboard. The queue
    // stays in the allowlist and stays exclusive to this role.
    expect(proxySource).toContain('const GROUP_USER_HOME = "/dashboard"')
    for (const area of ['"/approvals"', '"/dashboard"', '"/orders"', '"/reports"', '"/settings"']) {
      expect(
        proxySource.slice(
          proxySource.indexOf("const GROUP_USER_AREAS = ["),
          proxySource.indexOf("// The approval area belongs to the approver alone"),
        ),
      ).toContain(area)
    }
    expect(proxySource).toContain("GROUP_USER_AREAS.some((prefix) => pathMatchesPrefix(pathname, prefix))")
    // The queue is the approver's alone: an administrator is sent away from it.
    expect(proxySource).toContain("pathMatchesPrefix(pathname, APPROVALS_AREA)")
    expect(layout).toContain('!== GROUP_USER_ROLE) redirect("/dashboard")')
  })

  it("leaves the requester's ordering surface unable to decide orders", () => {
    const orderingGate = source("lib/server/group-order-access.ts")
    const storefrontLayout = source("app/group-portal/layout.tsx")

    // The ordering gate is unchanged in what it accepts.
    expect(orderingGate).toContain("requireApiRole([GROUP_ORDER_PORTAL_ROLE])")
    // The approver never lands on the requester's storefront, even by URL: the
    // gate admits the requester alone and sends every other role to the shell.
    expect(storefrontLayout).toContain(
      'if (role !== GROUP_ORDER_PORTAL_ROLE) redirect("/dashboard")',
    )
    expect(storefrontLayout).not.toContain("GROUP_USER_ROLE) redirect")
  })
})

describe("group user approval totals", () => {
  const approvals = source("lib/server/group-order-approvals.ts")
  const allOrders = source("components/group-portal/approval-all-orders.tsx")
  const table = source("components/group-portal/approval-order-table.tsx")

  it("counts the same orders the queue beneath the tiles lists", () => {
    // The tiles counted every order in the approver's branches while the queue
    // showed only the group-raised ones, so a tile reported a number the list
    // could not account for.
    const summary = approvals.slice(
      approvals.indexOf("export async function getApprovalQueueSummary"),
      approvals.indexOf("export async function listApprovalQueue"),
    )
    expect(summary).toContain("sql`${orders.groupOrderId} IS NOT NULL`")
    expect(summary).toContain("inArray(orders.branchId, scope.branchIds)")
    expect(summary).toContain("eq(orders.organizationId, scope.organizationId)")
  })

  it("still returns nothing at all for an approver with no assignments", () => {
    expect(approvals).toContain("if (!scope.usable)")
  })

  it("reports one quantity under the units column, in both views", () => {
    // The all-orders view read `orderItems.length` from a payload that carries
    // no such array, so every row showed nothing ordered at all.
    expect(approvals).toContain("SELECT COALESCE(SUM(${orderItems.quantity}), 0)")
    expect(allOrders).toContain("itemCount: Number(order.itemCount ?? 0)")
    expect(allOrders).not.toContain("Array.isArray(order.orderItems)")
    expect(table).toContain("formatQuantity(order.itemCount)")
  })

  it("lets the approver reach past the first page of its own branches' orders", () => {
    expect(allOrders).toContain('params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) })')
    expect(allOrders).toContain("data?.pagination?.totalPages")
    expect(allOrders).not.toContain('page: "1"')
  })

  it("reads the shared, already role-scoped orders endpoint rather than a parallel one", () => {
    expect(allOrders).toContain("`/api/v1/orders?${params.toString()}`")
    expect(allOrders).toContain('"/api/v1/group-portal/approvals/decide"')
  })
})
