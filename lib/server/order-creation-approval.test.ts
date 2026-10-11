import { beforeEach, describe, expect, it, vi } from "vitest"

const tokenMocks = vi.hoisted(() => ({
  generateApprovalToken: vi.fn(() => "ABCDEFGHJK"),
  hashApprovalToken: vi.fn(async () => "hashed-approval-token"),
}))

vi.mock("@/lib/approval-token", () => tokenMocks)

import { resolveInitialOrderApproval } from "@/lib/server/order-creation-approval"

function transactionReturning(orderApprovalRequired: unknown) {
  const limit = vi.fn().mockResolvedValue(
    orderApprovalRequired === undefined ? [] : [{ orderApprovalRequired }],
  )
  const forLock = vi.fn(() => ({ limit }))
  const where = vi.fn(() => ({ for: forLock }))
  const from = vi.fn(() => ({ where }))
  const select = vi.fn(() => ({ from }))

  return { tx: { select }, forLock }
}

describe("initial order approval", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("keeps the legacy pending workflow unless the tenant explicitly opts out", async () => {
    const { tx, forLock } = transactionReturning(true)

    const result = await resolveInitialOrderApproval(tx, 12)

    expect(forLock).toHaveBeenCalledWith("share")
    expect(result).toEqual({
      approvalRequired: true,
      values: {
        status: "PENDING",
        approvedAt: null,
        approvalToken: null,
        approvalTokenHash: null,
        approvalTokenCreatedAt: null,
      },
    })
    expect(tokenMocks.generateApprovalToken).not.toHaveBeenCalled()
    expect(tokenMocks.hashApprovalToken).not.toHaveBeenCalled()
  })

  it("creates a fulfillment-ready approval when approval is disabled", async () => {
    const approvedAt = new Date("2026-09-30T12:00:00.000Z")
    const { tx } = transactionReturning(false)

    const result = await resolveInitialOrderApproval(tx, 12, approvedAt)

    expect(tokenMocks.generateApprovalToken).toHaveBeenCalledWith(10)
    expect(tokenMocks.hashApprovalToken).toHaveBeenCalledWith("ABCDEFGHJK")
    expect(result).toEqual({
      approvalRequired: false,
      values: {
        status: "APPROVED",
        approvedAt,
        approvalToken: "ABCDEFGHJK",
        approvalTokenHash: "hashed-approval-token",
        approvalTokenCreatedAt: approvedAt,
      },
    })
  })

  it("fails instead of creating an unscoped order when the organization is missing", async () => {
    const { tx } = transactionReturning(undefined)

    await expect(resolveInitialOrderApproval(tx, 999)).rejects.toThrow("ORGANIZATION_NOT_FOUND")
  })

  // Reversed 2026-10-07 (plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md):
  // a desk entry used to be Active at once; it now always waits for an
  // Apricart Executive, whatever the tenant's own switch says.
  it.each([true, false])(
    "creates an Order Desk entry pending for an executive when the tenant's approval switch is %s",
    async (orderApprovalRequired) => {
      const { tx, forLock } = transactionReturning(orderApprovalRequired)

      const result = await resolveInitialOrderApproval(tx, 12, new Date("2026-10-05T09:00:00.000Z"), {
        role: "ORDER_DESK",
        userId: "desk-user",
      })

      // The organization row is still read under the same shared lock.
      expect(forLock).toHaveBeenCalledWith("share")
      expect(result).toEqual({
        approvalRequired: true,
        values: {
          status: "PENDING",
          approvedAt: null,
          approvalToken: null,
          approvalTokenHash: null,
          approvalTokenCreatedAt: null,
        },
        approvalBasis: "APRICART_EXECUTIVE_APPROVAL",
      })
      // No fulfilment token exists until an executive approves it.
      expect(tokenMocks.generateApprovalToken).not.toHaveBeenCalled()
    },
  )

  it("leaves every other creator on the tenant's policy", async () => {
    for (const role of ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "EMPLOYEE"]) {
      const { tx } = transactionReturning(true)
      const result = await resolveInitialOrderApproval(tx, 12, new Date(), { role, userId: "someone" })
      expect(result.approvalRequired).toBe(true)
      expect(result.values.status).toBe("PENDING")
      expect(result.approvalBasis).toBeUndefined()
    }
  })

  it("still refuses a desk entry for an organization that does not exist", async () => {
    const { tx } = transactionReturning(undefined)

    await expect(resolveInitialOrderApproval(tx, 999, new Date(), { role: "ORDER_DESK", userId: "desk-user" }))
      .rejects.toThrow("ORGANIZATION_NOT_FOUND")
  })
})
