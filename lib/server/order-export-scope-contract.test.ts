import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * An export describes the filters the person set, not the page they happened to
 * be looking at. Both order exports are fed from paginated endpoints, so each
 * has to walk every page of its own query before it writes a file. The failure
 * is silent — a download of 25 rows looks like a complete report — so the walk
 * is pinned here.
 */
describe("order export covers the whole filtered scope", () => {
  it("hands the orders export a fetcher rather than the rows on screen", () => {
    const component = read("components/orders/order-export.tsx")

    expect(component).toContain("fetchOrders: () => Promise<any[]>")
    expect(component).toContain("const orders = await fetchOrders()")
    // The visible page must not be what gets written out.
    expect(component).not.toContain("orders: any[]")
  })

  it("walks every page of the orders query before exporting", () => {
    const page = read("app/(portal)/orders/page.tsx")

    expect(page).toContain("const fetchAllFilteredOrders = useCallback")
    expect(page).toContain("firstPage?.pagination?.totalPages")
    expect(page).toContain("fetchOrders={fetchAllFilteredOrders}")
    expect(page).not.toContain("orders={filteredOrders}\n                  role={userRole}")
  })

  it("narrows the export with the same selector the orders table uses", () => {
    const page = read("app/(portal)/orders/page.tsx")

    expect(page).toContain('import { selectOrdersForListView } from "@/lib/order-list-view"')
    // Once for the visible page, once for the exported set — and nowhere else,
    // so the two can never disagree about what the filters mean.
    expect(page.match(/selectOrdersForListView<OrderItem>/g)).toHaveLength(2)
  })

  it("walks every page of the order report query before exporting", () => {
    const page = read("app/(portal)/reports/order-report/page.tsx")

    expect(page).toContain("const fetchAllReportOrders = async ()")
    expect(page).toContain("firstPage?.pagination?.totalPages")
    expect(page).toContain("const exportOrders = await fetchAllReportOrders()")
  })
})
