import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getCached: vi.fn(),
  select: vi.fn(),
}))

vi.mock("@/lib/cache-utils", () => ({
  getCached: mocks.getCached,
  CACHE_TTL: { SETTINGS: 300 },
  scopedCacheKey: (prefix: string, scope: { orgId?: number }) =>
    `cache:${prefix}${scope.orgId ? `:o:${scope.orgId}` : ""}`,
}))

vi.mock("@/lib/db", () => ({
  db: { select: mocks.select },
}))

import { getBudgetAllocationModeForOrganization } from "./budget-allocation-mode"

function mockSetting(value: unknown) {
  mocks.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(value === undefined ? [] : [{ value }]),
      }),
    }),
  })
  mocks.getCached.mockImplementation(async (_key, fetchFn) => fetchFn())
}

describe("budget allocation mode caching", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSetting(undefined)
  })

  it("uses a distinct organization-scoped cache key", async () => {
    await getBudgetAllocationModeForOrganization(31)
    await getBudgetAllocationModeForOrganization(32)

    expect(mocks.getCached.mock.calls[0][0]).toBe("cache:settings:budget-allocation-mode:o:31")
    expect(mocks.getCached.mock.calls[1][0]).toBe("cache:settings:budget-allocation-mode:o:32")
  })

  it("caches under the settings prefix that organization-settings writes invalidate", async () => {
    await getBudgetAllocationModeForOrganization(31)

    // invalidateByPrefix("settings") deletes "cache:settings*", so a key outside
    // that prefix would survive an allocation-mode change for its whole TTL.
    expect(mocks.getCached.mock.calls[0][0].startsWith("cache:settings")).toBe(true)
    expect(mocks.getCached.mock.calls[0][2]).toBe(300)
  })

  it("never writes a cache key without a tenant segment", async () => {
    // scopedCacheKey omits "o:<id>" for a falsy id, so an unguarded call would
    // share one tenant-less key across organizations. The default mode is still
    // returned, matching what a query that found no row would have produced.
    for (const invalidId of [0, -1, Number.NaN]) {
      await expect(getBudgetAllocationModeForOrganization(invalidId)).resolves.toBe("money")
    }

    expect(mocks.getCached).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled()
  })

  it("preserves quantity mode and the default money mode", async () => {
    mockSetting("quantity")
    await expect(getBudgetAllocationModeForOrganization(31)).resolves.toBe("quantity")

    vi.clearAllMocks()
    mockSetting(undefined)
    await expect(getBudgetAllocationModeForOrganization(31)).resolves.toBe("money")
  })
})
