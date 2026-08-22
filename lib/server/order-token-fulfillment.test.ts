import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { isTokenHandoffEligible, tokenHandoffMessage } from "@/lib/order-token-handoff"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("token hand-off eligibility", () => {
  it("settles only an approved order, whatever case the status arrives in", () => {
    expect(isTokenHandoffEligible("APPROVED")).toBe(true)
    expect(isTokenHandoffEligible("approved")).toBe(true)
    expect(isTokenHandoffEligible(" Approved ")).toBe(true)
  })

  it("never settles an order that is not approved", () => {
    for (const status of ["PENDING", "REJECTED", "CANCELLED", "FULFILLED", "REFUNDED", "PARTIAL"]) {
      expect(isTokenHandoffEligible(status)).toBe(false)
    }
  })

  it("fails closed on a missing status rather than settling it", () => {
    expect(isTokenHandoffEligible(null)).toBe(false)
    expect(isTokenHandoffEligible(undefined)).toBe(false)
    expect(isTokenHandoffEligible("")).toBe(false)
  })
})

describe("token hand-off wording", () => {
  it("reports a single token and the order it settled", () => {
    expect(tokenHandoffMessage({ sentCount: 1, fulfilledCount: 1 }))
      .toBe("Sent 1 fulfilment token to the admin — the order is now marked fulfilled")
  })

  it("reports every order when a group hand-off settles all of them", () => {
    expect(tokenHandoffMessage({ sentCount: 4, fulfilledCount: 4 }))
      .toBe("Sent 4 fulfilment tokens to the admin — all 4 orders are now marked fulfilled")
  })

  it("never claims more than actually settled", () => {
    expect(tokenHandoffMessage({ sentCount: 4, fulfilledCount: 1 }))
      .toBe("Sent 4 fulfilment tokens to the admin — 1 of 4 orders are now marked fulfilled")
    expect(tokenHandoffMessage({ sentCount: 2, fulfilledCount: 0 }))
      .toBe("Sent 2 fulfilment tokens to the admin")
  })
})

describe("the shared fulfilment transition", () => {
  it("claims the order once, inside the tenant and branch the caller authorized", () => {
    const service = source("lib/server/order-fulfillment.ts")

    // A single-winner compare-and-set, so two simultaneous hand-offs cannot
    // both move the money and quantity ledgers.
    expect(service).toContain("UPPER(${orders.status}) = 'APPROVED'")
    expect(service).toContain('if (!fulfilledOrder) throw new Error("ORDER_TRANSITION_CONFLICT")')
    // The claim re-asserts the scope it was authorized for, so a wrong id can
    // never reach another tenant's or another branch's order.
    expect(service).toContain("eq(orders.organizationId, organizationId)")
    expect(service).toContain("eq(orders.branchId, branchId)")
    // Both ledgers still move exactly as the Super Admin route moved them.
    expect(service).toContain('throw new Error("BUDGET_LEDGER_INVARIANT")')
    expect(service).toContain("moveHeldQuantityBudgetToUsedForOrder(tx, fulfilledOrder)")
    expect(service).toContain('updateOrderFulfillmentStatusColumn(tx, orderId, "DELIVERED")')
  })

  it("decides nothing about who may act — that stays with each caller", () => {
    const service = source("lib/server/order-fulfillment.ts")

    expect(service).not.toContain("requireApiRole")
    expect(service).not.toContain("getCurrentUser")
    expect(service).not.toContain("verifyResourceAccess")
    expect(service).not.toContain("canViewFulfillmentToken")
  })

  it("settles each order in its own transaction and only when it is eligible", () => {
    const service = source("lib/server/order-fulfillment.ts")

    expect(service).toContain("if (!isTokenHandoffEligible(candidate.status)) continue")
    // One order that cannot move must not fail a hand-off whose email already
    // left, nor stop the orders behind it.
    expect(service).toContain("catch (fulfillmentError)")
  })
})

describe("fulfilment on token hand-off, per role", () => {
  it("keeps the direct fulfilment endpoint Super Admin-only and token-verified", () => {
    const fulfilRoute = source("app/api/v1/orders/[id]/fulfill/route.ts")

    expect(fulfilRoute).toContain('requireApiRole(["SUPER_ADMIN"])')
    expect(fulfilRoute).toContain("verifyApprovalToken(input.approvalToken, ord.approvalTokenHash)")
    expect(fulfilRoute).toContain("verifyResourceAccess(ord.organizationId, ord.branchId)")
    // No other role is added to it by this change.
    expect(fulfilRoute).not.toContain("GROUP_USER")
    expect(fulfilRoute).not.toContain('"HEAD_OFFICE"')
    expect(fulfilRoute).not.toContain('"ORDER_PORTAL"')
  })

  it("settles the order for every role that can hand a single token over", () => {
    const tokenEmail = source("app/api/v1/orders/[id]/send-token-email/route.ts")

    // The role list is untouched: the same five roles that could already share
    // a token are the ones whose hand-off now settles the order.
    for (const role of ['"HEAD_OFFICE"', '"BRANCH_ADMIN"', '"GROUP_USER"', '"GROUP_ORDER_PORTAL"', '"ORDER_PORTAL"']) {
      expect(tokenEmail).toContain(role)
    }
    // Authorization still runs first and is unchanged.
    expect(tokenEmail).toContain("const canShareToken = canViewFulfillmentToken({")
    expect(tokenEmail).toContain("if (!hasAccess) return error(")
    // The order is settled only after the email actually went out, and only on
    // the order, tenant, and branch this request already authorized.
    expect(tokenEmail).toContain("await fulfillOrdersAfterTokenHandoff([{")
    expect(tokenEmail).toContain("orderId: order.id,")
    expect(tokenEmail).toContain("organizationId: order.organizationId,")
    expect(tokenEmail).toContain("branchId: order.branchId,")
    expect(tokenEmail).toContain("fulfilledByUserId: user.id,")
    // What happened is recorded and reported rather than assumed.
    expect(tokenEmail).toContain("fulfilled,")
    expect(tokenEmail.indexOf("await sendOrderTokenEmail({")).toBeLessThan(
      tokenEmail.indexOf("await fulfillOrdersAfterTokenHandoff([{"),
    )
  })

  it("settles every branch order behind a group hand-off, in the requester's own tenant", () => {
    const groupTokens = source("app/api/v1/group-portal/orders/[groupOrderId]/tokens/route.ts")
    const tokenLoader = source("lib/server/group-order-tokens.ts")

    expect(groupTokens).toContain("requireGroupOrderPortal()")
    expect(groupTokens).toContain("await fulfillOrdersAfterTokenHandoff(bundle.entries.map((entry) => ({")
    // Only the entries the loader already released, and only inside the tenant
    // the bundle was resolved in.
    expect(groupTokens).toContain("organizationId: bundle.organizationId,")
    expect(groupTokens).toContain("branchId: entry.branchId,")
    expect(groupTokens).toContain("fulfilledByUserId: actor.scope.userId,")
    // The bundle itself is still restricted to this requester's own approved
    // orders, at branches still in their live assignments.
    expect(tokenLoader).toContain("eq(orders.createdByUserId, userId)")
    expect(tokenLoader).toContain("eq(orders.organizationId, organizationId)")
    expect(tokenLoader).toContain("if (!scopedBranchIds.has(child.branchId)) return false")
    expect(tokenLoader).toContain("canViewFulfillmentToken({")
    // Every hand-off records whether it settled the order.
    expect(tokenLoader).toContain("fulfilled: Boolean(fulfilledOrderIds?.has(entry.orderId))")
  })

  it("leaves the unattended auto-fulfilment sweep exactly as it was", () => {
    const autoFulfil = source("app/api/v1/orders/cron/auto-fulfill/route.ts")

    expect(autoFulfil).toContain("isCronAuthorized(req)")
    expect(autoFulfil).toContain("lte(orders.deliveredAt, cutoff)")
    expect(autoFulfil).toContain("NOT EXISTS (SELECT 1 FROM \"refunds\"")
    expect(autoFulfil).not.toContain("fulfillOrdersAfterTokenHandoff")
  })

  it("does not widen who may see a token in the first place", () => {
    const policy = source("lib/fulfillment-token-access.ts")

    expect(policy).toContain('const REQUESTER_ROLES = new Set(["ORDER_PORTAL", "GROUP_ORDER_PORTAL"])')
    expect(policy).toContain("orderCreatedByUserId === userId")
    expect(policy).toContain('String(orderStatus || "").toUpperCase() === "APPROVED"')
  })
})
