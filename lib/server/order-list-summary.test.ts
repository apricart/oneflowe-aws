import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("order-list summary contract", () => {
  it("aggregates status counts across the complete filtered scope", () => {
    const route = source("app/api/v1/orders/route.ts")

    expect(route).toContain("all: metricExpressions.totalOrderCount")
    expect(route).toContain("fulfilled: metricExpressions.fulfilledCount")
    expect(route).toContain("refunded: metricExpressions.refundedCount")
    expect(route).toContain("summary: {")
    expect(route).toContain('statusFilter === "all"')
    expect(route).toContain("summaryRow?.[statusFilter]")
  })

  it("does not derive dashboard cards from the paginated row slice", () => {
    const page = source("app/(portal)/orders/page.tsx")

    expect(page).toContain("const statusCounts = ordersData?.summary || {")
  })

  it("requests the selected status from the API instead of filtering only the current page", () => {
    const page = source("app/(portal)/orders/page.tsx")

    expect(page).toContain('params.set("status", statusFilter)')
    expect(page).toContain("selectedYears, statusFilter, isInitialized")
  })

  it("keeps summary conditions independent from the selected list status", () => {
    const route = source("app/api/v1/orders/route.ts")

    expect(route).toContain("const summaryConditions = [...conditions]")
    expect(route).toContain("conditions.push(inArray(orders.status, requestedStatuses))")
    expect(route).toContain("const summaryCondition = summaryConditions.length ? and(...summaryConditions) : undefined")
    expect(route).toContain(".where(summaryCondition)")
  })
})
