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

  it("asks the API for delivered-but-unfulfilled orders and reads their count from the summary", () => {
    const page = source("app/(portal)/orders/page.tsx")
    const route = source("app/api/v1/orders/route.ts")

    expect(page).toContain('params.set("delivery", deliveryFilter)')
    expect(page).toContain("statusCounts.deliveredUnacknowledged")
    expect(route).toContain('deliveredUnacknowledged: viewerStatusBucketCount("DELIVERED_UNACKNOWLEDGED")')
    expect(route).toContain('conditions.push(viewerStatusBucketCondition("DELIVERED_UNACKNOWLEDGED"))')
    // The row filter goes after the summary snapshot, so the count is the whole scope.
    const summarySnapshot = route.indexOf("const summaryConditions = [...conditions]")
    expect(summarySnapshot)
      .toBeLessThan(route.indexOf("addOrderStatusConditions(", summarySnapshot))
  })

  it("filters the complete server-side list by delivery status", () => {
    const page = source("app/(portal)/orders/page.tsx")
    const route = source("app/api/v1/orders/route.ts")

    expect(page).toContain('params.set("fulfillmentStatus", fulfillmentStatusFilter)')
    expect(page).toContain('aria-label="Filter by delivery status"')
    expect(route).toContain("const fulfillmentStatusFilter = parseFulfillmentStatusFilter(params.fulfillmentStatus)")
    // Refused through `parseOrderListQuery`, whose first refusal is a 400.
    expect(route).toContain("if (!fulfillmentStatusFilter.ok) return { ok: false, error: fulfillmentStatusFilter.message }")
    expect(route).toContain("if (!listQuery.ok) return NextResponse.json({ error: listQuery.error }, { status: 400 })")
    expect(route).toContain("UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED'))")
    expect(route).toContain("const [filteredTotal] = await db")
  })

  it("keeps summary conditions independent from the selected list status", () => {
    const route = source("app/api/v1/orders/route.ts")

    expect(route).toContain("const summaryConditions = [...conditions]")
    // Matched like the cards (`UPPER(status)`), so a tab never lists fewer rows than its card counts.
    expect(route).toContain("conditions.push(inArray(sql`UPPER(${orders.status})`, requestedStatuses))")
    expect(route).toContain("const summaryCondition = summaryConditions.length ? and(...summaryConditions) : undefined")
    expect(route).toContain(".where(summaryCondition)")
  })
})
