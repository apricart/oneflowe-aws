import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("concurrency protection contracts", () => {
  it("serializes simultaneous attempts to spend the same budget and buy the last unit", () => {
    const ordersRoute = source("app/api/v1/orders/route.ts")
    expect(ordersRoute).toContain(".for('update')")
    expect(ordersRoute).toContain("lockedMoneyRemaining")
    expect(ordersRoute).toContain("lockedGps")
    expect(ordersRoute).toContain("Insufficient stock")
    expect(ordersRoute).toContain("idempotencyKey")
    expect(ordersRoute).toContain("replayed: true")
  })

  it("uses a single-winner compare-and-set for simultaneous approval and fulfilment", () => {
    // The approve transition lives in the shared decision service, so the same
    // single-winner guard covers single-order and bulk multi-branch decisions.
    // The fulfil transition now lives in its own service for the same reason:
    // the Super Admin route and the token hand-off share one claim.
    const approval = source("lib/server/order-decision-service.ts")
    const fulfilment = source("lib/server/order-fulfillment.ts")
    const fulfilRoute = source("app/api/v1/orders/[id]/fulfill/route.ts")
    expect(approval).toContain("UPPER(${orders.status}) = 'PENDING'")
    expect(approval).toContain(".returning({ id: orders.id })")
    expect(fulfilment).toContain("UPPER(${orders.status}) = 'APPROVED'")
    expect(fulfilment).toContain("ORDER_TRANSITION_CONFLICT")
    // The claim also re-asserts the tenant and branch the caller authorized.
    expect(fulfilment).toContain("eq(orders.organizationId, organizationId)")
    expect(fulfilment).toContain("eq(orders.branchId, branchId)")
    // No caller reimplements the transition; every one delegates to the service.
    expect(fulfilRoute).toContain("fulfillApprovedOrder({")
    expect(fulfilRoute).not.toContain('status: "FULFILLED"')
  })

  it("locks and revalidates simultaneous refunds before changing money or quantity ledgers", () => {
    const requestRefund = source("app/api/v1/orders/[id]/refunds/route.ts")
    const processRefund = source("app/api/v1/admin/refunds/route.ts")
    for (const route of [requestRefund, processRefund]) {
      expect(route).toContain(".for('update')")
      expect(route).toContain("REFUND_AVAILABILITY_CONFLICT")
      expect(route).toContain("isRefundEligibleOrderStatus")
      expect(route).not.toContain("isPaidForRefund")
      expect(route).not.toContain("Only paid orders are eligible for a refund")
    }
    // Every requester faces the delivered gate and the seven-day window, and
    // both are re-checked against the locked row rather than the one read
    // before the lock.
    expect(requestRefund).toContain("refundTimingReasonForRole(context.userRole, lockedOrder, context.now)")
  })

  it("prevents simultaneous auto/manual fulfilment from moving ledgers twice", () => {
    const autoFulfil = source("app/api/v1/orders/cron/auto-fulfill/route.ts")
    expect(autoFulfil).toContain("const [claimedOrder]")
    expect(autoFulfil).toContain(".returning({ id: orders.id })")
    expect(autoFulfil).toContain("if (!claimedOrder) return false")
  })

  // Any approved order since plans/OF-FINANCE-finance-role.md; the claim in
  // SQL must still restate the rule, so a status change in between loses.
  it("keeps payment status updates atomically restricted to approved orders", () => {
    const paymentRoute = source("app/api/v1/orders/[id]/payment-status/route.ts")
    const orderTransitions = source("lib/order-select.ts")

    expect(paymentRoute).toContain("isPaymentStatusUpdateEligible(order.status, order.fulfillmentStatus)")
    expect(orderTransitions).toContain(`UPPER(TRIM("status")) IN ('APPROVED', 'FULFILLED')`)
    expect(orderTransitions).toContain(`COALESCE("payment_status", 'UNPAID') = ${"${currentStatus}"}`)
  })

  it("serializes budget allocation and preserves committed quantity usage", () => {
    const moneyBudget = source("app/api/v1/budgets/route.ts")
    const quantityBudget = source("app/api/v1/budget-quantity/route.ts")
    expect(moneyBudget).toContain("lockedBudget")
    expect(moneyBudget).toContain(".for('update')")
    expect(quantityBudget).toContain("QUANTITY_BUDGET_RESET_HAS_COMMITMENTS")
    expect(quantityBudget).toContain(".for('update')")
  })

  it("uses unique database keys for order replay, organization settings, and invoice counters", () => {
    const migration = source("drizzle/20260715000000_business_logic_integrity.sql")
    const invoice = source("lib/invoice-number.ts")
    expect(migration).toContain("orders_creator_idempotency_uq")
    expect(migration).toContain("organization_settings_org_key_uq")
    expect(invoice).toContain("lastValue} + 1")
    expect(invoice).toContain("returning({ nextValue")
  })
})
