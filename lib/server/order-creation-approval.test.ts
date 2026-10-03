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
})
