import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Structural guarantees of "return for correction"
 * (plans/OF-ORDER-RETURN-for-correction.md). The behaviour is exercised end to
 * end in tests/integration/order-correction-api.test.ts; this holds the parts
 * a later edit could quietly undo without a database noticing.
 */
const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("return for correction", () => {
  it("cannot approve a returned order, even when a return races the approval", () => {
    const service = source("lib/server/order-decision-service.ts")
    expect(service).toContain("if (isAwaitingCorrection(ord)) return { kind: \"awaiting-correction\" } as const")
    // The claim itself names the flag, so the losing side of a race fails.
    expect(service).toContain("isNull(orders.returnedForCorrectionAt),")
  })

  it("clears the request and closes the round when a returned order is rejected", () => {
    const service = source("lib/server/order-decision-service.ts")
    expect(service).toContain("returnedForCorrectionAt: null,")
    expect(service).toContain('resolution: "REJECTED"')
  })

  it("holds a return to the approve/reject policy, inside the transaction", () => {
    const correction = source("lib/server/order-correction.ts")
    expect(correction).toContain("authorizeOrderDecision(tx, { orderId: input.orderId, scope: input.scope })")
    expect(correction).toContain("isNull(orders.returnedForCorrectionAt),")
  })

  it("holds a resubmission to the requester edit rule, re-read inside the transaction", () => {
    const correction = source("lib/server/order-correction.ts")
    expect(correction).toContain("resolveScopedBranchIds(tx, actor.id)")
    expect(correction).toContain("canRequesterActOnOrder(writeActor, subject)")
    expect(correction).toContain('.for("update")')
    expect(correction).toContain("eq(orders.organizationId, input.organizationId)")
    // Out of scope is "not found", as on the edit path.
    expect(correction).toContain('if (!canRequesterActOnOrder(writeActor, subject)) return { kind: "not-found" } as const')
  })

  it("never moves money or stock", () => {
    const correction = source("lib/server/order-correction.ts")
    for (const table of ["budgets", "productQuantityBudgets", "globalProducts", "orderItems"]) {
      expect(correction).not.toMatch(new RegExp(`update\\(${table}\\)`))
    }
  })

  it("takes the session, never the request, for who and which tenant", () => {
    const resubmit = source("app/api/v1/orders/[id]/resubmit/route.ts")
    expect(resubmit).toContain('requireApiRole(["ORDER_PORTAL", "GROUP_ORDER_PORTAL"])')
    expect(resubmit).toContain("organizationId: scope.organizationId")
    expect(resubmit).toContain("orderResubmissionSchema.safeParse")
    const giveBack = source("app/api/v1/orders/[id]/return-for-correction/route.ts")
    expect(giveBack).toContain("orderCorrectionRequestSchema.safeParse")
    for (const route of [resubmit, giveBack]) {
      expect(route).toContain('withRateLimit("order", user.id)')
      expect(route).not.toMatch(/body\.(organizationId|branchId|userId|role)/)
    }
  })

  it("keys correction notices per round, and hides approval prompts from non-approvers", () => {
    const notifications = source("lib/server/order-notifications.ts")
    expect(notifications).toContain("correctionNotificationEventKey(")
    const route = source("app/api/v1/notifications/route.ts")
    expect(route).toContain('notInArray(notifications.type, ["ORDER_CREATED", "ORDER_RESUBMITTED"])')
  })

  it("re-checks a group recipient's branch reach when the email is sent", () => {
    const notifications = source("lib/server/order-notifications.ts")
    expect(notifications).toContain("GROUP_ORDER_PORTAL")
    expect(notifications).toMatch(/resolveScopedBranchIds\(db, row\.recipientUserId\)/)
  })
})
