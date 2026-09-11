import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * The order report has to carry the delivery progress and whether the order was
 * paid — the same two badges the orders table shows.
 *
 * On screen both are their own toggleable column. In the download they are not:
 * the download follows a fixed tenant-facing layout in
 * `lib/order-report-export-layout.ts`, which reports payment as its own column
 * and delivery as the date the order was delivered. Both facts still reach the
 * reader, and both still come from the shared display helper rather than being
 * spelled again by hand.
 */
describe("order-report delivery and payment status columns", () => {
  const page = read("app/(portal)/reports/order-report/page.tsx")
  const layout = read("lib/order-report-export-layout.ts")

  it("declares a delivery and a payment column, both shown by default", () => {
    expect(page).toContain('{ key: "deliveryStatus", label: "Delivery Status", defaultVisible: true }')
    expect(page).toContain('{ key: "paymentStatus", label: "Payment", defaultVisible: true }')
  })

  it("renders both columns in the table", () => {
    expect(page).toContain('isVisible("deliveryStatus")')
    expect(page).toContain('isVisible("paymentStatus")')
  })

  it("takes the exported payment status from the shared display helper", () => {
    expect(layout).toContain('import { getOrderStatusDisplay } from "@/lib/order-status-display"')
    expect(layout).toContain("getOrderStatusDisplay(order as never).paymentStatus")
    // Spelling a label by hand is what this guards against.
    expect(layout).not.toContain('"Un-Paid"')
    expect(layout).not.toContain('"Paid"')
  })

  it("carries delivery progress into the download as the delivered date", () => {
    expect(layout).toContain('{ key: "deliveredDate", label: "Delivered Date" }')
    expect(layout).toContain("return toDate(order.deliveredAt)")
  })

  it("reads both statuses from the summary endpoint the report is built from", () => {
    const route = read("app/api/v1/analytics/summary/route.ts")

    expect(route).toContain("fulfillmentStatus: orderSelectColumns.fulfillmentStatus")
    expect(route).toContain("paymentStatus: orderSelectColumns.paymentStatus")
    expect(route).toContain("deliveredAt: orders.deliveredAt")
  })
})
