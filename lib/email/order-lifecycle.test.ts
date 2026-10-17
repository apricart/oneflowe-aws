import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/server/env", () => ({ env: { NEXTAUTH_URL: "https://portal.example.test" } }))
vi.mock("@/lib/email/ses", () => ({ sendAppEmail: vi.fn() }))

import { buildOrderLifecycleEmail, type OrderLifecycleEmailPayload } from "@/lib/email/order-lifecycle"

const basePayload: OrderLifecycleEmailPayload = {
  orderId: 41,
  tid: "TID-0041",
  organizationName: "Example Org",
  branchName: "North",
}

describe("Super Admin approval email", () => {
  it("names the approving role for a manual approval", () => {
    const email = buildOrderLifecycleEmail("ORDER_APPROVED_ADMIN", {
      ...basePayload,
      approvedBy: "Jane Approver",
      approvedByRole: "HEAD_OFFICE",
    })

    expect(email.subject).toBe("Order TID-0041 was approved by Head Office")
    expect(email.text).toContain("Head Office approved an order.")
    expect(email.text).toContain("Approved by: Jane Approver")
  })

  it("says an auto-approved order was approved by policy, not by a Financial Approver", () => {
    const email = buildOrderLifecycleEmail("ORDER_APPROVED_ADMIN", {
      ...basePayload,
      approvedBy: null,
      approvedByRole: null,
      autoApproved: true,
    })

    expect(email.subject).toBe("Order TID-0041 was approved automatically")
    expect(email.text).toContain("approved automatically under its organization's order approval policy")
    expect(email.text).not.toContain("Financial Approver")
    expect(email.text).not.toContain("Approved by:")
    expect(email.text).toContain("Review order: https://portal.example.test/orders/41")
  })

  it("ignores the auto-approval flag on any other template", () => {
    const email = buildOrderLifecycleEmail("ORDER_APPROVED", { ...basePayload, autoApproved: true })

    expect(email.subject).toBe("Order TID-0041 was approved")
    expect(email.text).not.toContain("automatically")
  })
})
