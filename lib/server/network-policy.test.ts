import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getCached: vi.fn(),
  invalidateByPrefix: vi.fn(),
}))

vi.mock("server-only", () => ({}))

vi.mock("@/lib/db", () => ({ db: {} }))

vi.mock("@/lib/cache-utils", () => ({
  CACHE_TTL: { SETTINGS: 300 },
  getCached: mocks.getCached,
  invalidateByPrefix: mocks.invalidateByPrefix,
  scopedCacheKey: (prefix: string, scope: { orgId?: number }) => `cache:${prefix}:o:${scope.orgId}`,
}))

import {
  evaluateNetworkAccess,
  resolvePrivateNetworkLoginRows,
} from "@/lib/server/network-policy"

const { getCached, invalidateByPrefix } = mocks

function policy(enabled: boolean, values: string[]) {
  return {
    enabled,
    entries: values.map((value) => {
      const [ipAddress, prefix] = value.split("/")
      return { ipAddress, prefixLength: Number(prefix) }
    }),
  }
}

beforeEach(() => {
  getCached.mockReset()
  invalidateByPrefix.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("evaluateNetworkAccess", () => {
  it("exempts SUPER_ADMIN without reading any policy", async () => {
    await expect(
      evaluateNetworkAccess({ role: "SUPER_ADMIN", organizationId: 7, clientIp: "198.51.100.1" }),
    ).resolves.toBe("allowed")
    expect(getCached).not.toHaveBeenCalled()
  })

  it("allows a principal with no organization", async () => {
    for (const organizationId of [null, undefined, 0, -1, "", "abc"]) {
      await expect(
        evaluateNetworkAccess({ role: "HEAD_OFFICE", organizationId, clientIp: "198.51.100.1" }),
      ).resolves.toBe("allowed")
    }
    expect(getCached).not.toHaveBeenCalled()
  })

  it("allows every address when the tenant has not enabled the restriction", async () => {
    getCached.mockResolvedValue(policy(false, []))

    await expect(
      evaluateNetworkAccess({ role: "BRANCH_ADMIN", organizationId: 7, clientIp: "198.51.100.1" }),
    ).resolves.toBe("allowed")
  })

  it("allows an address inside the allowlist", async () => {
    getCached.mockResolvedValue(policy(true, ["203.0.113.0/24"]))

    await expect(
      evaluateNetworkAccess({ role: "ORDER_PORTAL", organizationId: 7, clientIp: "203.0.113.42" }),
    ).resolves.toBe("allowed")
  })

  it("denies an address outside the allowlist", async () => {
    getCached.mockResolvedValue(policy(true, ["203.0.113.0/24"]))

    await expect(
      evaluateNetworkAccess({ role: "BRANCH_ADMIN", organizationId: 7, clientIp: "198.51.100.9" }),
    ).resolves.toBe("denied")
  })

  it("denies when the client address could not be determined", async () => {
    getCached.mockResolvedValue(policy(true, ["203.0.113.0/24"]))

    await expect(
      evaluateNetworkAccess({ role: "EMPLOYEE", organizationId: 7, clientIp: null }),
    ).resolves.toBe("denied")
  })

  it("reports unavailable rather than guessing when the policy cannot be read", async () => {
    getCached.mockRejectedValue(new Error("connection refused"))

    await expect(
      evaluateNetworkAccess({ role: "BRANCH_ADMIN", organizationId: 7, clientIp: "203.0.113.1" }),
    ).resolves.toBe("unavailable")
  })

  it("stays out of the way when the code is deployed ahead of its migration", async () => {
    for (const code of ["42703", "42P01"]) {
      const missingSchema = Object.assign(new Error("column does not exist"), { code })
      getCached.mockRejectedValue(missingSchema)

      await expect(
        evaluateNetworkAccess({ role: "BRANCH_ADMIN", organizationId: 7, clientIp: "203.0.113.1" }),
      ).resolves.toBe("allowed")
    }
  })

  it("does not mistake an ordinary database failure for a missing migration", async () => {
    const outage = Object.assign(new Error("too many connections"), { code: "53300" })
    getCached.mockRejectedValue(outage)

    await expect(
      evaluateNetworkAccess({ role: "BRANCH_ADMIN", organizationId: 7, clientIp: "203.0.113.1" }),
    ).resolves.toBe("unavailable")
  })

  it("allows access if the allowlist is somehow empty while enabled", async () => {
    getCached.mockResolvedValue(policy(true, []))

    await expect(
      evaluateNetworkAccess({ role: "BRANCH_ADMIN", organizationId: 7, clientIp: "203.0.113.1" }),
    ).resolves.toBe("allowed")
  })

  it("applies the restriction to every non-platform role", async () => {
    getCached.mockResolvedValue(policy(true, ["203.0.113.7/32"]))

    for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "EMPLOYEE"]) {
      await expect(
        evaluateNetworkAccess({ role, organizationId: 7, clientIp: "198.51.100.1" }),
      ).resolves.toBe("denied")
    }
  })
})

describe("resolvePrivateNetworkLoginRows", () => {
  it("normalizes, labels, and deduplicates submitted entries", () => {
    const result = resolvePrivateNetworkLoginRows({
      enabled: true,
      entries: [
        { value: " 203.0.113.7 ", label: "  Head office " },
        { value: "203.0.113.7/32", label: "duplicate" },
        { value: "10.0.0.55/8", label: null },
      ],
    })

    expect(result).toEqual({
      ok: true,
      rows: [
        { ipAddress: "203.0.113.7", prefixLength: 32, label: "Head office" },
        { ipAddress: "10.0.0.0", prefixLength: 8, label: null },
      ],
    })
  })

  it("rejects the whole submission when any value is invalid", () => {
    const result = resolvePrivateNetworkLoginRows({
      enabled: true,
      entries: [{ value: "203.0.113.7" }, { value: "office-wifi" }],
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain("office-wifi")
  })

  it("refuses to enable the restriction with no addresses", () => {
    const result = resolvePrivateNetworkLoginRows({ enabled: true, entries: [] })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain("at least one IP address")
  })

  it("accepts an empty list while the restriction is off", () => {
    expect(resolvePrivateNetworkLoginRows({ enabled: false, entries: [] })).toEqual({
      ok: true,
      rows: [],
    })
  })
})
