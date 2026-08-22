import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getSharedServerSession: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
  getSharedServerSession: mocks.getSharedServerSession,
}))

import { requireApiRole } from "@/lib/api"

describe("requireApiRole session availability", () => {
  beforeEach(() => {
    mocks.getCurrentUser.mockReset()
    mocks.getSharedServerSession.mockReset()
  })

  it("returns retryable no-store 503 instead of misclassifying a registry outage", async () => {
    mocks.getSharedServerSession.mockResolvedValue({
      sessionValidationUnavailable: true,
    })

    const response = await requireApiRole(["SUPER_ADMIN"])

    expect(response?.status).toBe(503)
    expect(response?.headers.get("cache-control")).toContain("no-store")
    expect(response?.headers.get("retry-after")).toBe("5")
    await expect(response?.json()).resolves.toEqual({
      error: "Session validation temporarily unavailable",
    })
    expect(mocks.getCurrentUser).not.toHaveBeenCalled()
  })
})
