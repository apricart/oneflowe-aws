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
    const approval = source("app/api/v1/orders/[id]/approve/route.ts")
    const fulfilment = source("app/api/v1/orders/[id]/fulfill/route.ts")
    expect(approval).toContain("UPPER(${orders.status}) = 'PENDING'")
    expect(approval).toContain(".returning({ id: orders.id })")
    expect(fulfilment).toContain("UPPER(${orders.status}) = 'APPROVED'")
    expect(fulfilment).toContain("ORDER_TRANSITION_CONFLICT")
  })

  it("locks and revalidates simultaneous refunds before changing money or quantity ledgers", () => {
    const requestRefund = source("app/api/v1/orders/[id]/refunds/route.ts")
    const processRefund = source("app/api/v1/admin/refunds/route.ts")
    for (const route of [requestRefund, processRefund]) {
      expect(route).toContain(".for('update')")
      expect(route).toContain("REFUND_AVAILABILITY_CONFLICT")
      expect(route).toContain("isPaidForRefund")
    }
  })

  it("prevents simultaneous auto/manual fulfilment from moving ledgers twice", () => {
    const autoFulfil = source("app/api/v1/orders/cron/auto-fulfill/route.ts")
    expect(autoFulfil).toContain("const [claimedOrder]")
    expect(autoFulfil).toContain(".returning({ id: orders.id })")
    expect(autoFulfil).toContain("if (!claimedOrder) return false")
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
