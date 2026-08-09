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

import {
  HIDE_BRANCH_ADMIN_PRICES_SETTING_KEY,
  HIDE_ORDER_PORTAL_PRICES_SETTING_KEY,
  LEGACY_HIDE_PRICES_SETTING_KEY,
  shouldHidePricesForRole,
} from "./price-visibility"

function mockSettings(rows: Array<{ key: string; value: unknown }>) {
  mocks.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  })
  mocks.coalesceInFlight.mockImplementation(async (_key, fetchFn) => fetchFn())
}

describe("price visibility caching", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettings([])
  })

  it("uses an organization-scoped settings key", async () => {
    await shouldHidePricesForRole("BRANCH_ADMIN", 17)
    await shouldHidePricesForRole("BRANCH_ADMIN", 18)

    expect(mocks.coalesceInFlight.mock.calls[0][0]).toBe("cache:inflight:settings:price-visibility:o:17")
    expect(mocks.coalesceInFlight.mock.calls[1][0]).toBe("cache:inflight:settings:price-visibility:o:18")
    expect(mocks.coalesceInFlight.mock.calls[0][0]).not.toBe(mocks.coalesceInFlight.mock.calls[1][0])
  })

  it("keeps role-specific visibility isolated after the shared tenant read", async () => {
    mockSettings([
      { key: HIDE_BRANCH_ADMIN_PRICES_SETTING_KEY, value: true },
      { key: HIDE_ORDER_PORTAL_PRICES_SETTING_KEY, value: false },
    ])

    await expect(shouldHidePricesForRole("BRANCH_ADMIN", 17)).resolves.toBe(true)
    await expect(shouldHidePricesForRole("ORDER_PORTAL", 17)).resolves.toBe(false)
  })

  it("preserves the legacy fallback and role-specific override", async () => {
    mockSettings([
      { key: LEGACY_HIDE_PRICES_SETTING_KEY, value: true },
      { key: HIDE_BRANCH_ADMIN_PRICES_SETTING_KEY, value: false },
    ])

    await expect(shouldHidePricesForRole("BRANCH_ADMIN", 17)).resolves.toBe(false)
    await expect(shouldHidePricesForRole("ORDER_PORTAL", 17)).resolves.toBe(true)
  })

  it("does not access tenant settings for an unrestricted role", async () => {
    await expect(shouldHidePricesForRole("SUPER_ADMIN", 17)).resolves.toBe(false)
    expect(mocks.coalesceInFlight).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled()
  })
})
