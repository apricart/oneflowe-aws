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
  "lib/server/order-fulfillment.ts",
  "lib/server/order-decision-service.ts",
  "lib/server/group-order-creation.ts",
  "lib/server/group-branch-budgets.ts",
  "lib/server/budget-period-opening.ts",
  "lib/server/order-desk-orders.ts",
  "lib/server/order-desk-edit.ts",
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

  // Every place that decides "is this order still in its refund window" —
  // the requester route, the Super Admin route, the group requester rules, and
  // the browser that decides whether to show the form at all. A local-month
  // comparison in any of them disagrees with the others near a month boundary.
  it.each([
    "app/api/v1/admin/refunds/route.ts",
    "lib/server/group-refund-rules.ts",
    "components/refund-management.tsx",
  ])("%s judges the refund window with isSameBudgetPeriod, not local months", (path) => {
    const text = source(path)
    expect(text).toMatch(/isSameBudgetPeriod\(/)
    expect(text).not.toMatch(/\.getMonth\(\)\s*[!=]==/)
  })

  it("judges the refund window on the same period, not on local calendar months", () => {
    const text = source(refundRoute)
    expect(text).toMatch(/isSameBudgetPeriod\(/)
    expect(text).not.toMatch(/orderDate\.getMonth\(\) !== now\.getMonth\(\)/)
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
