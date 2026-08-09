import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  redis: {
    get: vi.fn(),
    setex: vi.fn(),
    keys: vi.fn(),
    del: vi.fn(),
  },
}))

vi.mock("./redis", () => ({ redis: mocks.redis }))

import { coalesceInFlight, getCached, scopedCacheKey } from "./cache-utils"

describe("cache utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.redis.get.mockResolvedValue(null)
    mocks.redis.setex.mockResolvedValue("OK")
    mocks.redis.keys.mockResolvedValue([])
    mocks.redis.del.mockResolvedValue(0)
  })

  it("returns an existing Redis value without executing the database fetch", async () => {
    mocks.redis.get.mockResolvedValue(JSON.stringify({ tenant: 7, items: [1, 2] }))
    const fetchFn = vi.fn()

    await expect(getCached("cache:test:existing", fetchFn, 30)).resolves.toEqual({
      tenant: 7,
      items: [1, 2],
    })

    expect(mocks.redis.get).toHaveBeenCalledTimes(1)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(mocks.redis.setex).not.toHaveBeenCalled()
  })

  it("coalesces simultaneous cache misses for the same scoped key", async () => {
    let releaseFetch!: (value: { tenant: number }) => void
    const pendingFetch = new Promise<{ tenant: number }>((resolve) => {
      releaseFetch = resolve
    })
    const fetchFn = vi.fn(() => pendingFetch)

    const requests = Array.from({ length: 25 }, () =>
      getCached("cache:inventory:o:11:b:22", fetchFn, 5),
    )
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1))
    releaseFetch({ tenant: 11 })

    await expect(Promise.all(requests)).resolves.toEqual(
      Array.from({ length: 25 }, () => ({ tenant: 11 })),
    )
    expect(mocks.redis.get).toHaveBeenCalledTimes(1)
    expect(mocks.redis.setex).toHaveBeenCalledTimes(1)
  })

  it("never coalesces reads across different tenant keys", async () => {
    const tenantOneKey = scopedCacheKey("branch-inv", { orgId: 1, branchId: 9 })
    const tenantTwoKey = scopedCacheKey("branch-inv", { orgId: 2, branchId: 9 })
    const tenantOneFetch = vi.fn().mockResolvedValue({ tenant: 1 })
    const tenantTwoFetch = vi.fn().mockResolvedValue({ tenant: 2 })

    const [tenantOne, tenantTwo] = await Promise.all([
      getCached(tenantOneKey, tenantOneFetch, 5),
      getCached(tenantTwoKey, tenantTwoFetch, 5),
    ])

    expect(tenantOneKey).not.toBe(tenantTwoKey)
    expect(tenantOne).toEqual({ tenant: 1 })
    expect(tenantTwo).toEqual({ tenant: 2 })
    expect(tenantOneFetch).toHaveBeenCalledTimes(1)
    expect(tenantTwoFetch).toHaveBeenCalledTimes(1)
  })

  it("clears a failed in-flight read so a later request can retry", async () => {
    const key = "cache:test:retry-after-error"
    const firstFetch = vi.fn().mockRejectedValue(new Error("temporary database error"))
    const retryFetch = vi.fn().mockResolvedValue({ ok: true })

    await expect(getCached(key, firstFetch, 30)).rejects.toThrow("temporary database error")
    await expect(getCached(key, retryFetch, 30)).resolves.toEqual({ ok: true })

    expect(firstFetch).toHaveBeenCalledTimes(1)
    expect(retryFetch).toHaveBeenCalledTimes(1)
  })

  it("keeps cache write failures non-fatal", async () => {
    mocks.redis.setex.mockRejectedValue(new Error("redis unavailable"))

    await expect(
      getCached("cache:test:set-failure", async () => ({ source: "database" }), 30),
    ).resolves.toEqual({ source: "database" })
  })

  it("coalesces only the lifetime of an identical in-flight operation", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)

    const firstPair = await Promise.all([
      coalesceInFlight("scope:user-1", fetchFn),
      coalesceInFlight("scope:user-1", fetchFn),
    ])
    const later = await coalesceInFlight("scope:user-1", fetchFn)

    expect(firstPair).toEqual([1, 1])
    expect(later).toBe(2)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})
