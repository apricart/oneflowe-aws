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
  mocks.getCached.mockImplementation(async (_key, fetchFn) => fetchFn())
}

describe("price visibility caching", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSettings([])
  })

  it("uses an organization-scoped settings key", async () => {
    await shouldHidePricesForRole("BRANCH_ADMIN", 17)
    await shouldHidePricesForRole("BRANCH_ADMIN", 18)

    expect(mocks.getCached.mock.calls[0][0]).toBe("cache:settings:price-visibility:o:17")
    expect(mocks.getCached.mock.calls[1][0]).toBe("cache:settings:price-visibility:o:18")
    expect(mocks.getCached.mock.calls[0][0]).not.toBe(mocks.getCached.mock.calls[1][0])
  })

  it("caches under the settings prefix that organization-settings writes invalidate", async () => {
    await shouldHidePricesForRole("BRANCH_ADMIN", 17)

    // invalidateByPrefix("settings") deletes "cache:settings*", so a key outside
    // that prefix would survive a price-visibility change for its whole TTL.
    expect(mocks.getCached.mock.calls[0][0].startsWith("cache:settings")).toBe(true)
    expect(mocks.getCached.mock.calls[0][2]).toBe(300)
  })

  it("keeps the role out of the cache key so one tenant read serves every role", async () => {
    await shouldHidePricesForRole("BRANCH_ADMIN", 17)
    await shouldHidePricesForRole("ORDER_PORTAL", 17)

    expect(mocks.getCached.mock.calls[0][0]).toBe(mocks.getCached.mock.calls[1][0])
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
    expect(mocks.getCached).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled()
  })
})
