import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * The order report is downloaded as the record of what happened to an order, so
 * it has to carry the delivery progress and whether the order was paid — the
 * same two badges the orders table shows. Both are structural: the column list
 * drives the table and the export from one place, and the labels must come from
 * the shared display helper rather than being spelled again here.
 */
describe("order-report delivery and payment status columns", () => {
  const page = read("app/(portal)/reports/order-report/page.tsx")

  it("declares a delivery and a payment column, both shown by default", () => {
    expect(page).toContain('{ key: "deliveryStatus", label: "Delivery Status", defaultVisible: true }')
    expect(page).toContain('{ key: "paymentStatus", label: "Payment", defaultVisible: true }')
  })

  it("exports both columns through the shared status display helper", () => {
    expect(page).toContain('import { getOrderStatusDisplay } from "@/lib/order-status-display"')
    expect(page).toContain('case "deliveryStatus": return getOrderStatusDisplay(order).fulfillmentStatus || "-"')
    expect(page).toContain('case "paymentStatus": return getOrderStatusDisplay(order).paymentStatus || "-"')
  })

  it("renders both columns in the table so the download matches the screen", () => {
    expect(page).toContain('isVisible("deliveryStatus")')
    expect(page).toContain('isVisible("paymentStatus")')
  })

  it("reads both statuses from the summary endpoint the report is built from", () => {
    const route = read("app/api/v1/analytics/summary/route.ts")

    expect(route).toContain("fulfillmentStatus: orderSelectColumns.fulfillmentStatus")
    expect(route).toContain("paymentStatus: orderSelectColumns.paymentStatus")
  })
})
