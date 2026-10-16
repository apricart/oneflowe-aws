import { describe, expect, it } from "vitest"

import type { ActivityRequestFilters } from "@/lib/activity-log"
import {
  ACTIVITY_LOG_ORGANIZATION_PERMISSION,
  ACTIVITY_LOG_ORGANIZATION_ROLES,
  ACTIVITY_LOG_PLATFORM_PERMISSION,
  ACTIVITY_LOG_PLATFORM_ROLES,
  ACTIVITY_LOG_ROLES,
  activityLogAccessFailure,
  applyActivityReach,
  canViewActivityLog,
  readsWholePlatform,
  resolveActivityLogReach,
} from "@/lib/activity-log-access"
import { Permission, ROLE_TEMPLATES } from "@/lib/permissions"

/**
 * The whole role matrix, stated once.
 *
 * The first version of this file existed to stop Head Office being admitted
 * by accident. It is now admitted on purpose — to its own organization only —
 * by `plans/OF-AUDIT-head-office-activity-log.md`, and this file pins the new
 * line just as hard: exactly one role reads the whole platform, exactly one
 * reads one tenant, and that tenant comes from the server-resolved scope.
 */

const EVERY_ROLE = [
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "GROUP_USER",
  "BRANCH_ADMIN",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
  "VIEWER",
] as const

const REFUSED_ROLES = EVERY_ROLE.filter((role) => role !== "SUPER_ADMIN" && role !== "HEAD_OFFICE")

function requested(overrides: Partial<ActivityRequestFilters> = {}): ActivityRequestFilters {
  return {
    from: new Date("2026-09-01T00:00:00.000Z"),
    to: new Date("2026-09-08T00:00:00.000Z"),
    limit: 50,
    cursor: null,
    sources: null,
    operation: null,
    category: null,
    action: null,
    organizationId: null,
    branchId: null,
    actorId: null,
    success: null,
    search: null,
    ...overrides,
  }
}

describe("canViewActivityLog", () => {
  it.each(["SUPER_ADMIN", "HEAD_OFFICE"])("admits %s", (role) => {
    expect(canViewActivityLog(role)).toBe(true)
  })

  it.each(REFUSED_ROLES)("refuses %s", (role) => {
    expect(canViewActivityLog(role)).toBe(false)
  })

  it("refuses an absent or unknown role", () => {
    expect(canViewActivityLog(null)).toBe(false)
    expect(canViewActivityLog(undefined)).toBe(false)
    expect(canViewActivityLog("")).toBe(false)
    expect(canViewActivityLog("super_admin")).toBe(false)
    expect(canViewActivityLog("HEAD_OFFICE ")).toBe(false)
  })

  it("names exactly one whole-platform reader", () => {
    expect([...ACTIVITY_LOG_PLATFORM_ROLES]).toEqual(["SUPER_ADMIN"])
    expect(readsWholePlatform("SUPER_ADMIN")).toBe(true)
    expect(readsWholePlatform("HEAD_OFFICE")).toBe(false)
  })
})

describe("activityLogAccessFailure", () => {
  it("returns nothing for a permitted role", () => {
    expect(activityLogAccessFailure("SUPER_ADMIN")).toBeNull()
    expect(activityLogAccessFailure("HEAD_OFFICE")).toBeNull()
  })

  it("separates not signed in from not permitted", () => {
    expect(activityLogAccessFailure(null)).toEqual({ message: "Unauthorized", status: 401 })
    expect(activityLogAccessFailure("BRANCH_ADMIN")?.status).toBe(403)
  })

  it("says nothing about the trail in the refusal", () => {
    const failure = activityLogAccessFailure("ORDER_PORTAL")
    expect(failure?.message).not.toMatch(/\d/)
  })
})

describe("resolveActivityLogReach", () => {
  it("gives Super Admin the whole platform, whatever organization the scope carries", () => {
    expect(resolveActivityLogReach({ role: "SUPER_ADMIN", organizationId: null })).toEqual({
      ok: true,
      reach: { kind: "platform" },
    })
    expect(resolveActivityLogReach({ role: "SUPER_ADMIN", organizationId: 7 })).toEqual({
      ok: true,
      reach: { kind: "platform" },
    })
  })

  it("gives Head Office its own organization and nothing wider", () => {
    expect(resolveActivityLogReach({ role: "HEAD_OFFICE", organizationId: 10 })).toEqual({
      ok: true,
      reach: { kind: "organization", organizationId: 10 },
    })
  })

  it.each([null, undefined, 0, -1, 1.5, Number.NaN])(
    "refuses Head Office with organization %s rather than widening it",
    (organizationId) => {
      const result = resolveActivityLogReach({ role: "HEAD_OFFICE", organizationId })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failure.status).toBe(403)
    },
  )

  it("refuses a string organization id rather than coercing it", () => {
    const result = resolveActivityLogReach({
      role: "HEAD_OFFICE",
      organizationId: "10" as unknown as number,
    })
    expect(result.ok).toBe(false)
  })

  it.each(REFUSED_ROLES)("refuses %s even with an organization", (role) => {
    const result = resolveActivityLogReach({ role, organizationId: 10 })
    expect(result).toEqual({ ok: false, failure: expect.objectContaining({ status: 403 }) })
  })

  it("answers 401 with no scope at all", () => {
    expect(resolveActivityLogReach(null)).toEqual({
      ok: false,
      failure: { message: "Unauthorized", status: 401 },
    })
  })
})

describe("applyActivityReach", () => {
  const own = { kind: "organization", organizationId: 10 } as const

  it("attaches the reach to what was asked", () => {
    const result = applyActivityReach(requested({ search: "x" }), own)
    expect(result).toEqual({ ok: true, filters: expect.objectContaining({ reach: own, search: "x" }) })
  })

  it("accepts an organization reader naming their own organization", () => {
    expect(applyActivityReach(requested({ organizationId: 10 }), own).ok).toBe(true)
  })

  it("refuses an organization reader naming another organization", () => {
    const result = applyActivityReach(requested({ organizationId: 2 }), own)
    expect(result).toEqual({ ok: false, failure: expect.objectContaining({ status: 403 }) })
  })

  it("gives the same refusal for every other organization, so it cannot test for existence", () => {
    const messages = [2, 11, 999_999].map((organizationId) => {
      const result = applyActivityReach(requested({ organizationId }), own)
      return result.ok ? null : result.failure.message
    })
    expect(new Set(messages).size).toBe(1)
    expect(messages[0]).not.toMatch(/\d/)
  })

  it("lets the whole-platform reader name any organization", () => {
    expect(applyActivityReach(requested({ organizationId: 2 }), { kind: "platform" }).ok).toBe(true)
  })
})

describe("the permissions behind it", () => {
  function holdersOf(permission: Permission): string[] {
    return Object.entries(ROLE_TEMPLATES)
      .filter(([, template]) => (template.permissions as readonly Permission[]).includes(permission))
      .map(([role]) => role)
      .sort()
  }

  it("are the RBAC keys for the two reaches", () => {
    expect(ACTIVITY_LOG_PLATFORM_PERMISSION).toBe(Permission.SYSTEM_VIEW_AUDIT_LOGS)
    expect(ACTIVITY_LOG_ORGANIZATION_PERMISSION).toBe(Permission.ORG_VIEW_AUDIT_LOGS)
  })

  it("keep the whole-platform key with the whole-platform readers alone", () => {
    // Head Office must never hold this one: it means every tenant.
    expect(holdersOf(Permission.SYSTEM_VIEW_AUDIT_LOGS)).toEqual([...ACTIVITY_LOG_PLATFORM_ROLES].sort())
  })

  it("give the organization key to exactly the roles this module admits", () => {
    // Super Admin holds every key by construction (`Object.values(Permission)`).
    // The Viewer holds it too: an organization-wide Viewer reads its own
    // organization's trail as Head Office does (`viewerReadScope` in the
    // handler), so it is not a reach of its own in this module.
    expect(holdersOf(Permission.ORG_VIEW_AUDIT_LOGS)).toEqual([...ACTIVITY_LOG_ROLES, "VIEWER"].sort())
    expect([...ACTIVITY_LOG_ORGANIZATION_ROLES]).toEqual(["HEAD_OFFICE"])
  })
})
