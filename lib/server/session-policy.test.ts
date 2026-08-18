import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getCached: vi.fn(),
  scopedCacheKey: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/server/env", () => ({
  env: { INACTIVITY_TIMEOUT_MINUTES: 12 },
}))
vi.mock("@/lib/cache-utils", () => ({
  CACHE_TTL: { SETTINGS: 300 },
  getCached: mocks.getCached,
  scopedCacheKey: mocks.scopedCacheKey,
}))
vi.mock("@/lib/db", () => ({ db: {} }))

import { resolveSessionIdleTimeoutMinutes } from "@/lib/server/session-policy"

describe("tenant session policy resolution", () => {
  beforeEach(() => {
    mocks.getCached.mockReset()
    mocks.scopedCacheKey
      .mockReset()
      .mockImplementation(
        (prefix: string, scope: { orgId: number }) =>
          `cache:${prefix}:o:${scope.orgId}`,
      )
  })

  it("uses a cache key scoped to the signed organization", async () => {
    mocks.getCached.mockImplementation(async (key: string) => ({
      value: key.endsWith("o:17") ? 5 : 9,
    }))

    await expect(resolveSessionIdleTimeoutMinutes(17)).resolves.toBe(5)
    await expect(resolveSessionIdleTimeoutMinutes(18)).resolves.toBe(9)
    expect(mocks.scopedCacheKey).toHaveBeenNthCalledWith(1, "settings-session-policy", {
      orgId: 17,
    })
    expect(mocks.scopedCacheKey).toHaveBeenNthCalledWith(2, "settings-session-policy", {
      orgId: 18,
    })
    expect(mocks.getCached.mock.calls[0]?.[2]).toBe(30)
  })

  it("uses the secure global fallback for an organization-less principal", async () => {
    await expect(resolveSessionIdleTimeoutMinutes(null)).resolves.toBe(12)
    expect(mocks.getCached).not.toHaveBeenCalled()
  })

  it("preserves stricter values and caps legacy permissive values", async () => {
    mocks.getCached
      .mockResolvedValueOnce({ value: 1 })
      .mockResolvedValueOnce({ value: 1_440 })
      .mockResolvedValueOnce({ value: true })

    await expect(resolveSessionIdleTimeoutMinutes(1)).resolves.toBe(1)
    await expect(resolveSessionIdleTimeoutMinutes(2)).resolves.toBe(15)
    await expect(resolveSessionIdleTimeoutMinutes(3)).resolves.toBe(12)
  })

  it("keeps the prior bounded policy when the settings store is unavailable", async () => {
    mocks.getCached.mockRejectedValue(new Error("settings unavailable"))
    vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(resolveSessionIdleTimeoutMinutes(17, 5)).resolves.toBe(5)
  })

  it("fails a tenant login closed when no prior signed policy can be preserved", async () => {
    const error = new Error("settings unavailable")
    mocks.getCached.mockRejectedValue(error)
    vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(resolveSessionIdleTimeoutMinutes(17)).rejects.toBe(error)
  })
})
