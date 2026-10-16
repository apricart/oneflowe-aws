import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/server/env", () => ({ env: { NEXTAUTH_URL: "https://portal.example.test" } }))
vi.mock("@/lib/email/ses", () => ({ sendAppEmail: vi.fn() }))

import { buildWarehouseOrderEmail } from "@/lib/email/warehouse-order"
import type { WarehouseOrderPayload } from "@/lib/warehouse-order-notifications"

/** plans/OF-WAREHOUSE-order-stage-notifications.md */

const payload: WarehouseOrderPayload = { orderId: 41, tid: "TID-0041", organizationName: "Example Org", branchName: "North" }

describe("the warehouse order-stage email", () => {
  it("says what happened to which order, and opens the queue for an approved one", () => {
    const email = buildWarehouseOrderEmail("WAREHOUSE_ORDER_APPROVED", payload)
    expect(email.subject).toBe("Order TID-0041 was approved and is ready to pick")
    expect(email.text).toContain("Order TID: TID-0041")
    expect(email.text).toContain("Organization: Example Org")
    expect(email.text).toContain("Branch: North")
    expect(email.text).toContain("Open my order queue: https://portal.example.test/warehouse#orders")
  })

  it("opens the warehouse home, not the queue, for an order that is not its work", () => {
    const email = buildWarehouseOrderEmail("WAREHOUSE_ORDER_REJECTED", payload)
    expect(email.subject).toBe("Order TID-0041 was rejected")
    expect(email.text).toContain("Open the warehouse: https://portal.example.test/warehouse")
    expect(email.text).not.toContain("#orders")
  })

  it("escapes every value it prints into the HTML", () => {
    const email = buildWarehouseOrderEmail("WAREHOUSE_ORDER_CANCELLED", {
      ...payload,
      organizationName: "<script>alert(1)</script>",
      branchName: "A & \"B\"",
    })
    expect(email.html).not.toContain("<script>")
    expect(email.html).toContain("&lt;script&gt;")
    expect(email.html).toContain("A &amp; &quot;B&quot;")
  })

  it("carries no amount, person or token", () => {
    const email = buildWarehouseOrderEmail("WAREHOUSE_ORDER_CREATED", { ...payload, approvedAtCreation: true })
    expect(email.text).not.toMatch(/\bPKR\b|\bRs\.?\s?\d|requested by|approved by|token/i)
  })
})
