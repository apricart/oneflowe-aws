import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("order-list pagination contract", () => {
  it("requests one bounded page of orders and renders navigation controls", () => {
    const page = source("app/(portal)/orders/page.tsx")

    expect(page).toContain("const ORDERS_PAGE_SIZE = 25")
    expect(page).toContain('params.set("page", currentPage.toString())')
    expect(page).toContain('params.set("limit", ORDERS_PAGE_SIZE.toString())')
    expect(page).toContain("Page {currentPage} of {totalPages}")
    expect(page).toContain('aria-label="Go to previous page"')
    expect(page).toContain('aria-label="Go to next page"')
  })

  it("searches through the API instead of filtering only the loaded page", () => {
    const page = source("app/(portal)/orders/page.tsx")
    const route = source("app/api/v1/orders/route.ts")

    expect(page).toContain('params.set("q", debouncedSearchQuery)')
    expect(route).toContain("FROM ${orderItems}")
    expect(route).toContain("searchConditions.push(eq(orders.id, numericOrderId))")
  })

  it("returns an exact total and total-page count for the filtered query", () => {
    const route = source("app/api/v1/orders/route.ts")

    expect(route).toContain("const paginationTotal = Number(")
    expect(route).toContain("totalPages: Math.ceil(paginationTotal / limit)")
    expect(route).toContain("hasMore: page * limit < paginationTotal")
    expect(route).toContain(".limit(limit).offset(offset)")
  })
})
