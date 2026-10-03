import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import {
  isTokenHandoffEligible,
  tokenHandoffMessage,
  tokenHandoffSettlesNow,
} from "@/lib/order-token-handoff"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("token hand-off eligibility", () => {
  it("records a hand-off only for an approved order, whatever case the status arrives in", () => {
    expect(isTokenHandoffEligible("APPROVED")).toBe(true)
    expect(isTokenHandoffEligible("approved")).toBe(true)
    expect(isTokenHandoffEligible(" Approved ")).toBe(true)
  })

  it("never records a hand-off against an order that is not approved", () => {
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

describe("when a hand-off settles its order", () => {
  it("settles an approved order whose goods have already been delivered", () => {
    expect(tokenHandoffSettlesNow("APPROVED", "DELIVERED")).toBe(true)
    expect(tokenHandoffSettlesNow(" approved ", " delivered ")).toBe(true)
  })

  it("never settles an approved order that has not been delivered", () => {
    for (const delivery of ["NOT_STARTED", "IN_PROCESS", "OUT_FOR_DELIVERY"]) {
      expect(tokenHandoffSettlesNow("APPROVED", delivery)).toBe(false)
    }
  })

  it("fails closed on a missing or unrecognised delivery status", () => {
    expect(tokenHandoffSettlesNow("APPROVED", null)).toBe(false)
    expect(tokenHandoffSettlesNow("APPROVED", undefined)).toBe(false)
    expect(tokenHandoffSettlesNow("APPROVED", "")).toBe(false)
    expect(tokenHandoffSettlesNow("APPROVED", "SHIPPED")).toBe(false)
  })

  it("never settles an order that is not approved, however it was delivered", () => {
    for (const status of ["PENDING", "REJECTED", "FULFILLED", "REFUNDED"]) {
      expect(tokenHandoffSettlesNow(status, "DELIVERED")).toBe(false)
    }
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

  it("says an undelivered order settles at delivery rather than now", () => {
    expect(tokenHandoffMessage({ sentCount: 1, fulfilledCount: 0, awaitingDeliveryCount: 1 }))
      .toBe("Sent 1 fulfilment token to the admin — the order will be marked fulfilled once it is delivered")
    expect(tokenHandoffMessage({ sentCount: 3, fulfilledCount: 0, awaitingDeliveryCount: 3 }))
      .toBe("Sent 3 fulfilment tokens to the admin — all 3 orders will be marked fulfilled once they are delivered")
  })

  it("reports a group hand-off that settled some orders and left others waiting", () => {
    expect(tokenHandoffMessage({ sentCount: 4, fulfilledCount: 1, awaitingDeliveryCount: 3 }))
      .toBe("Sent 4 fulfilment tokens to the admin — 1 of 4 orders are now marked fulfilled; 3 will be marked fulfilled once delivered")
    expect(tokenHandoffMessage({ sentCount: 4, fulfilledCount: 0, awaitingDeliveryCount: 2 }))
      .toBe("Sent 4 fulfilment tokens to the admin — 2 of 4 orders will be marked fulfilled once they are delivered")
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
  })

  it("never settles an undelivered order, for any caller", () => {
    const service = source("lib/server/order-fulfillment.ts")
    const fulfilRoute = source("app/api/v1/orders/[id]/fulfill/route.ts")

    // The delivery requirement is unconditional and part of the same
    // single-winner claim, so no caller can settle goods that have not arrived.
    expect(service).toMatch(/^\s+DELIVERED_ORDER_CONDITION,\r?$/m)
    expect(service).toContain("= 'DELIVERED'")
    // There is no longer a mode that records the delivery while fulfilling.
    expect(service).not.toContain("record-delivery")
    expect(service).not.toContain("requiresDelivery")
    expect(service).not.toContain("deliveredAt: fulfilledAt")
    // The Super Admin route refuses an undelivered order before the token.
    const deliveredAt = fulfilRoute.indexOf("if (!isOrderDelivered(ord.fulfillmentStatus)) {")
    const tokenAt = fulfilRoute.indexOf("verifyApprovalToken(input.approvalToken")
    expect(deliveredAt).toBeGreaterThan(-1)
    expect(tokenAt).toBeGreaterThan(deliveredAt)
    expect(fulfilRoute).toContain('error("Order cannot be fulfilled until it has been delivered", 409)')
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

  it("records every hand-off, and settles only the orders already delivered", () => {
    const service = source("lib/server/order-fulfillment.ts")

    // The hand-off is remembered first and committed on its own, so a
    // settlement that fails still leaves the delivery able to settle the order.
    expect(service).toContain("const record = await recordOrderTokenHandoff(candidate)")
    expect(service).toContain('if (record.outcome !== "recorded")')
    expect(service).toContain("if (!tokenHandoffSettlesNow(candidate.status, record.fulfillmentStatus))")
    expect(service).toContain("settlement.awaitingDeliveryOrderIds.add(candidate.orderId)")
  })

  it("settles a delivered order for whoever handed its token over, inside the caller's scope", () => {
    const service = source("lib/server/order-fulfillment.ts")

    expect(service).toContain("export async function settleDeliveredOrderAfterTokenHandoff(")
    expect(service).toContain("const handoff = await findPendingTokenHandoff(target)")
    expect(service).toContain('if (!handoff) return "no-handoff"')
    // Credited to the sender, not to the administrator who recorded delivery.
    expect(service).toContain("fulfilledByUserId: handoff.handedOffByUserId,")
  })
})

describe("where a hand-off is remembered", () => {
  it("writes the hand-off only on an approved order in the authorized scope", () => {
    const store = source("lib/server/order-token-handoff-store.ts")

    expect(store).toContain("eq(orders.id, orderId)")
    expect(store).toContain("organizationId === null ? undefined : eq(orders.organizationId, organizationId)")
    expect(store).toContain("eq(orders.branchId, branchId)")
    expect(store).toContain("UPPER(TRIM(${orders.status})) = 'APPROVED'")
  })

  it("keeps the first hand-off when a token is re-sent", () => {
    const store = source("lib/server/order-token-handoff-store.ts")

    expect(store).toContain("COALESCE(${orders.tokenHandoffAt}, NOW())")
    expect(store).toContain("COALESCE(${orders.tokenHandoffByUserId}, ${target.handedOffByUserId}::uuid)")
  })

  it("decides nothing about who may act — that stays with each caller", () => {
    const store = source("lib/server/order-token-handoff-store.ts")

    expect(store).not.toContain("requireApiRole")
    expect(store).not.toContain("getCurrentUser")
    expect(store).not.toContain("verifyResourceAccess")
    expect(store).not.toContain("canViewFulfillmentToken")
  })

  it("reports no hand-off rather than failing where the migration has not been applied", () => {
    const store = source("lib/server/order-token-handoff-store.ts")

    expect(store).toContain(`to_jsonb("orders") ->> 'token_handoff_at'`)
    expect(store).toContain(`to_jsonb("orders") ->> 'token_handoff_by_user_id'`)
    expect(store).toContain('if (isMissingFulfillmentStatusColumn(writeError)) return { outcome: "migration-missing" }')
    expect(store).toContain("if (!row?.handedOffAt) return null")
  })

  it("adds the columns as nullable so no existing order changes", () => {
    const schema = source("db/schema.ts")
    const migration = source("drizzle/20260903120000_add_order_token_handoff.sql")

    expect(schema).toContain('tokenHandoffAt: timestamp("token_handoff_at", { withTimezone: true })')
    expect(schema).toContain('tokenHandoffByUserId: uuid("token_handoff_by_user_id").references(() => users.id)')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "token_handoff_at" timestamp with time zone')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "token_handoff_by_user_id" uuid')
    expect(migration).toContain('REFERENCES "public"."users"("id")')
    expect(migration).not.toContain("NOT NULL")
  })
})

describe("delivery settles an order whose token already went out", () => {
  it("settles it from the delivery transition, after that transition commits", () => {
    const progressRoute = source("app/api/v1/orders/[id]/fulfillment-status/route.ts")

    // Still Super Admin only, and still scoped to the order it authorized.
    expect(progressRoute).toContain('requireApiRole(["SUPER_ADMIN"])')
    expect(progressRoute).toContain("verifyResourceAccess(order.organizationId, order.branchId)")
    expect(progressRoute).toContain("settleDeliveredOrderAfterTokenHandoff({")
    expect(progressRoute).toContain("organizationId: order.organizationId,")
    expect(progressRoute).toContain("branchId: order.branchId,")
    // Only delivery settles an order, never an earlier progress step.
    expect(progressRoute).toContain('nextStatus === "DELIVERED"')
    // The settlement runs outside the progress transaction, which has already
    // committed by the time the route reaches it.
    expect(progressRoute.indexOf("await db.transaction")).toBeLessThan(
      progressRoute.indexOf("await settleOnDeliveryIfTokenHandedOff("),
    )
    // What happened is recorded and reported rather than assumed.
    expect(progressRoute).toContain('action: "ORDER_FULFILLED_ON_DELIVERY"')
    expect(progressRoute).toContain("fulfilled,")
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
    // The hand-off is recorded only after the email actually went out, and only
    // on the order, tenant, and branch this request already authorized.
    expect(tokenEmail).toContain("await settleOrdersAfterTokenHandoff([{")
    expect(tokenEmail).toContain("orderId: order.id,")
    expect(tokenEmail).toContain("organizationId: order.organizationId,")
    expect(tokenEmail).toContain("branchId: order.branchId,")
    expect(tokenEmail).toContain("handedOffByUserId: user.id,")
    // What happened is recorded and reported rather than assumed — including an
    // order that is waiting on its delivery.
    expect(tokenEmail).toContain("fulfilled,")
    expect(tokenEmail).toContain("awaitingDelivery,")
    expect(tokenEmail.indexOf("await sendOrderTokenEmail({")).toBeLessThan(
      tokenEmail.indexOf("await settleOrdersAfterTokenHandoff([{"),
    )
  })

  it("settles every branch order behind a group hand-off, in the requester's own tenant", () => {
    const groupTokens = source("app/api/v1/group-portal/orders/[groupOrderId]/tokens/route.ts")
    const tokenLoader = source("lib/server/group-order-tokens.ts")

    expect(groupTokens).toContain("requireGroupOrderPortal()")
    expect(groupTokens).toContain("await settleOrdersAfterTokenHandoff(bundle.entries.map((entry) => ({")
    // Only the entries the loader already released, and only inside the tenant
    // the bundle was resolved in.
    expect(groupTokens).toContain("organizationId: bundle.organizationId,")
    expect(groupTokens).toContain("branchId: entry.branchId,")
    expect(groupTokens).toContain("handedOffByUserId: actor.scope.userId,")
    // The bundle itself is still restricted to this requester's own approved
    // orders, at branches still in their live assignments.
    expect(tokenLoader).toContain("eq(orders.createdByUserId, userId)")
    expect(tokenLoader).toContain("eq(orders.organizationId, organizationId)")
    expect(tokenLoader).toContain("if (!scopedBranchIds.has(child.branchId)) return false")
    expect(tokenLoader).toContain("canViewFulfillmentToken({")
    // Every hand-off records whether it settled the order, or is waiting on the
    // delivery that will.
    expect(tokenLoader).toContain("fulfilled: Boolean(fulfilledOrderIds?.has(entry.orderId))")
    expect(tokenLoader).toContain("awaitingDelivery: Boolean(awaitingDeliveryOrderIds?.has(entry.orderId))")
  })

  it("leaves the unattended auto-fulfilment sweep exactly as it was", () => {
    const autoFulfil = source("app/api/v1/orders/cron/auto-fulfill/route.ts")

    expect(autoFulfil).toContain("isCronAuthorized(req)")
    expect(autoFulfil).toContain("lte(orders.deliveredAt, cutoff)")
    expect(autoFulfil).toContain("NOT EXISTS (SELECT 1 FROM \"refunds\"")
    expect(autoFulfil).not.toContain("settleOrdersAfterTokenHandoff")
    expect(autoFulfil).not.toContain("token_handoff")
  })

  it("does not widen who may see a token in the first place", () => {
    const policy = source("lib/fulfillment-token-access.ts")

    expect(policy).toContain('const REQUESTER_ROLES = new Set(["ORDER_PORTAL", "GROUP_ORDER_PORTAL"])')
    expect(policy).toContain("orderCreatedByUserId === userId")
    expect(policy).toContain('String(orderStatus || "").toUpperCase() === "APPROVED"')
  })
})
