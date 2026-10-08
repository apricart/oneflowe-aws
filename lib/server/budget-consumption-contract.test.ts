import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * The control for `plans/OF-BUDGET-ledger-orders-parity.md`.
 *
 * Consumption is answered from two places — the `budgets` ledger the order
 * lifecycle writes, and the `orders` table an analytics reader re-aggregates.
 * They agree only while every site derives the statuses, the refund netting and
 * the period from the shared modules. These tests fail the moment a new site
 * restates one of those rules inline, which is how the two drifted apart
 * before.
 */

/** Every file that turns orders into money for a budget figure. */
const ORDER_CONSUMPTION_READERS = [
  "app/api/v1/analytics/budgets/summary/route.ts",
  "lib/server/executive-analytics-queries.ts",
]

/** Every file that decides which `budgets.period` row a write lands on. */
const LEDGER_PERIOD_WRITERS = [
  "app/api/v1/orders/route.ts",
  "app/api/v1/orders/[id]/refunds/route.ts",
  // Super Admin approval credits the refund back. With no time limit on
  // approval, the order's period and today's can differ.
  "app/api/v1/admin/refunds/route.ts",
  "lib/server/order-fulfillment.ts",
  "lib/server/order-decision-service.ts",
  "lib/server/group-order-creation.ts",
  "lib/server/group-branch-budgets.ts",
  "lib/server/budget-period-opening.ts",
  "lib/server/order-desk-orders.ts",
  "lib/server/order-desk-edit.ts",
  // A group requester's cancel releases the hold from the order's own period.
  "lib/server/group-order-cancel.ts",
]

describe("order-derived consumption goes through the shared SQL", () => {
  it.each(ORDER_CONSUMPTION_READERS)("%s imports the shared fragments", (path) => {
    expect(source(path)).toMatch(/from "@\/lib\/server\/budget-consumption-sql"/)
  })

  it.each(ORDER_CONSUMPTION_READERS)("%s does not restate the status buckets inline", (path) => {
    const text = source(path)
    // The shape that was duplicated in both readers before this rule existed.
    expect(text).not.toMatch(/IN \(\s*'FULFILLED'/)
    expect(text).not.toMatch(/IN \(\s*'PENDING',\s*'APPROVED'\s*\)/)
  })

  it.each(ORDER_CONSUMPTION_READERS)("%s does not restate the refund netting inline", (path) => {
    expect(source(path)).not.toMatch(/GREATEST\(0,\s*\$\{orders\.totalCents\}/)
  })

  it("buckets orders by an explicit UTC month, not the session time zone", () => {
    const text = source("lib/server/budget-consumption-sql.ts")
    expect(text).toMatch(/AT TIME ZONE 'UTC'/)
    ORDER_CONSUMPTION_READERS.forEach((path) => {
      expect(source(path)).not.toMatch(/TO_CHAR\(\$\{orders\.createdAt\},\s*'YYYY-MM'\)/)
    })
  })
})

describe("the ledger's period is defined once", () => {
  it.each(LEDGER_PERIOD_WRITERS)("%s imports budgetPeriodOf", (path) => {
    expect(source(path)).toMatch(/budgetPeriodOf[^\n]*from "@\/lib\/budget-consumption"|from "@\/lib\/budget-consumption"/)
  })

  it.each(LEDGER_PERIOD_WRITERS)("%s does not slice its own period out of an ISO string", (path) => {
    expect(source(path)).not.toMatch(/toISOString\(\)\.slice\(0,\s*7\)/)
  })

  it("keeps the current-period helper delegating rather than restating", () => {
    expect(source("lib/server/group-branch-budgets.ts")).toMatch(/return budgetPeriodOf\(now\)/)
  })
})

describe("refunds are withdrawn from the period they were taken from", () => {
  const refundRoute = "app/api/v1/orders/[id]/refunds/route.ts"

  it("selects the budget row by the order's period, not today's", () => {
    const text = source(refundRoute)
    expect(text).toMatch(/eq\(budgets\.period, budgetPeriodOf\(/)
    expect(text).not.toMatch(/eq\(budgets\.period, new Date\(\)/)
  })

  it("gives a Super Admin approval back on the order's period, not today's", () => {
    const text = source("app/api/v1/admin/refunds/route.ts")
    expect(text).toMatch(/budgetPeriodOf\(orderData\.createdAt/)
    expect(text).toMatch(/eq\(budgets\.period, orderPeriod\)/)
  })
})

/**
 * Both refund routes move the money ledger by one rule
 * (`plans/OF-BUDGET-refund-ledger-debit.md`). The admin route used to credit
 * every refund while the order side nets it out of consumption, so a reader
 * combining the two counted it twice; the order route debited held, which a
 * later fulfilment of the full total could not survive.
 */
describe("a refund moves the ledger by the shared rule", () => {
  const REFUND_LEDGER_WRITERS = [
    "app/api/v1/orders/[id]/refunds/route.ts",
    "app/api/v1/admin/refunds/route.ts",
  ]

  it.each(REFUND_LEDGER_WRITERS)("%s plans the move with planRefundLedgerMove", (path) => {
    const text = source(path)
    expect(text).toMatch(/planRefundLedgerMove\(\{/)
    expect(text).toMatch(/amountSpentCents: sql`\$\{budgets\.amountSpentCents\} - \$\{move\.spentDebitCents\}`/)
    expect(text).toMatch(/amountCreditedCents: sql`\$\{budgets\.amountCreditedCents\} \+ \$\{move\.creditCents\}`/)
  })

  it.each(REFUND_LEDGER_WRITERS)("%s locks the period row before planning against it", (path) => {
    const text = source(path)
    const plan = text.indexOf("planRefundLedgerMove({")
    const periodRow = text.lastIndexOf("eq(budgets.period,", plan)
    const lock = text.indexOf('.for("update")', periodRow)
    expect(periodRow).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(periodRow)
    expect(lock).toBeLessThan(plan)
  })

  it.each(REFUND_LEDGER_WRITERS)("%s neither releases a hold nor floors spent on its own", (path) => {
    const text = source(path)
    expect(text).not.toMatch(/amountHeldCents: sql`GREATEST/)
    expect(text).not.toMatch(/amountSpentCents: sql`GREATEST/)
    expect(text).not.toMatch(/amountCreditedCents: sql`\$\{budgets\.amountCreditedCents\} \+ \$\{totalRefundAmount\}`/)
  })
})

/**
 * The refund window is no longer the order's budget month
 * (`plans/OF-REFUND-seven-day-requester-window.md`): a requester has seven days
 * from fulfilment, and Super Admin has no limit. Every place that decides it
 * reads `lib/refund-window.ts`, so none can drift back to a month comparison.
 */
describe("the refund window is defined once", () => {
  it.each([
    "app/api/v1/orders/[id]/refunds/route.ts",
    "lib/server/group-refund-rules.ts",
    "lib/order-desk-access.ts",
    "components/refund-management.tsx",
  ])("%s takes the requester window from lib/refund-window", (path) => {
    const text = source(path)
    expect(text).toMatch(/from "@\/lib\/refund-window"/)
    expect(text).not.toMatch(/isSameBudgetPeriod\(/)
    expect(text).not.toMatch(/\.getMonth\(\)\s*[!=]==/)
  })

  it("the requester route re-checks the window against the locked row", () => {
    const text = source("app/api/v1/orders/[id]/refunds/route.ts")
    expect(text).toContain("refundTimingReasonForRole(context.userRole, lockedOrder, context.now)")
    expect(text).toContain("refundTimingReasonForRole(role, orderData, now)")
  })

  it("the group requester re-checks the fulfilment time it read under the lock", () => {
    const text = source("lib/server/group-order-refunds.ts")
    expect(text).toContain("fulfilledAt: locked.fulfilledAt")
    expect(text).toContain("fulfilledAt: child.fulfilledAt")
  })

  it("the Super Admin decision routes apply no time limit at all", () => {
    for (const path of ["app/api/v1/admin/refunds/route.ts", "app/api/v1/admin/refunds/[id]/route.ts"]) {
      const text = source(path)
      expect(text, path).not.toMatch(/isSameBudgetPeriod\(/)
      expect(text, path).not.toMatch(/from "@\/lib\/refund-window"/)
      expect(text, path).not.toMatch(/only allowed for orders in the current month/)
    }
  })
})

describe("the shared modules stay free of request and session concerns", () => {
  it("the pure rules touch neither the database nor a session", () => {
    const text = source("lib/budget-consumption.ts")
    expect(text).not.toMatch(/from "@\/lib\/db"/)
    expect(text).not.toMatch(/getServerSession|getRequestScope|NextRequest/)
  })

  it("the SQL module is server-only and resolves no scope of its own", () => {
    const text = source("lib/server/budget-consumption-sql.ts")
    expect(text).toMatch(/^import "server-only"/m)
    expect(text).not.toMatch(/getServerSession|getRequestScope|resolveScopedBranchIds/)
  })
})
