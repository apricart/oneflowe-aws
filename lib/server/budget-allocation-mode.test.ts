import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  coalesceInFlight: vi.fn(),
  select: vi.fn(),
}))

vi.mock("@/lib/cache-utils", () => ({
  coalesceInFlight: mocks.coalesceInFlight,
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
  mocks.coalesceInFlight.mockImplementation(async (_key, fetchFn) => fetchFn())
}

describe("budget allocation mode caching", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSetting(undefined)
  })

  it("uses a distinct organization-scoped cache key", async () => {
    await getBudgetAllocationModeForOrganization(31)
    await getBudgetAllocationModeForOrganization(32)

    expect(mocks.coalesceInFlight.mock.calls[0][0]).toBe("cache:inflight:settings:budget-allocation-mode:o:31")
    expect(mocks.coalesceInFlight.mock.calls[1][0]).toBe("cache:inflight:settings:budget-allocation-mode:o:32")
  })

  it("preserves quantity mode and the default money mode", async () => {
    mockSetting("quantity")
    await expect(getBudgetAllocationModeForOrganization(31)).resolves.toBe("quantity")

    vi.clearAllMocks()
    mockSetting(undefined)
    await expect(getBudgetAllocationModeForOrganization(31)).resolves.toBe("money")
  })
})
