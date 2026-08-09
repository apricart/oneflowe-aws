import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("order-report pagination contract", () => {
  it("requests one bounded page and renders navigation controls", () => {
    const page = source("app/(portal)/reports/order-report/page.tsx")

    expect(page).toContain("const ORDER_REPORT_PAGE_SIZE = 25")
    expect(page).toContain('reportParams.set("page", currentPage.toString())')
    expect(page).toContain('reportParams.set("limit", ORDER_REPORT_PAGE_SIZE.toString())')
    expect(page).toContain('reportParams.set("ordersOnly", "true")')
    expect(page).toContain("Page {currentPage} of {totalReportPages}")
    expect(page).toContain('aria-label="Go to previous order-report page"')
    expect(page).toContain('aria-label="Go to next order-report page"')
  })

  it("applies search and status filters on the server", () => {
    const page = source("app/(portal)/reports/order-report/page.tsx")
    const route = source("app/api/v1/analytics/summary/route.ts")

    expect(page).toContain('reportParams.set("q", debouncedReportSearch)')
    expect(page).toContain('reportParams.set("status", statusFilter)')
    expect(route).toContain("FROM ${users} AS report_users")
    expect(route).toContain("report_users.employee_id ILIKE")
  })

  it("bounds page sizes and returns exact pagination metadata", () => {
    const route = source("app/api/v1/analytics/summary/route.ts")

    expect(route).toContain("const limit = Math.min(Math.max(requestedLimit, 1), 100)")
    expect(route).toContain("totalPages: Math.ceil(paginationTotal / limit)")
    expect(route).toContain("hasMore: page * limit < paginationTotal")
    expect(route).toContain(".limit(limit)")
    expect(route).toContain(".offset(offset)")
  })

  it("exports every filtered page instead of only the visible rows", () => {
    const page = source("app/(portal)/reports/order-report/page.tsx")
    const route = source("app/api/v1/analytics/summary/route.ts")

    expect(page).toContain('exportParams.set("limit", "100")')
    expect(page).toContain("for (let page = 2; page <= totalPages; page += exportConcurrency)")
    expect(page).toContain("const rows = exportOrders.map")
    expect(page).not.toContain("const rows = filteredOrders.map")
    expect(route).toContain(".orderBy(desc(orders.createdAt), desc(orders.id))")
    expect(route).toContain('url.searchParams.get("ordersOnly") === "true"')
  })
})
