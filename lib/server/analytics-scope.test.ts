import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import {
  lacksAnalyticsTenant,
  narrowRequestedBranchIdsToGroups,
  normalizePositiveIds,
  parseRequestedOrganizationIds,
  resolveAnalyticsBranchIds,
  resolveAnalyticsOrganizationIds,
} from "@/lib/server/analytics-scope"

describe("analytics tenant scope", () => {
  it("keeps non-super-admin organization scope fixed to the session tenant", () => {
    expect(resolveAnalyticsOrganizationIds({
      role: "HEAD_OFFICE",
      userOrganizationId: 12,
      requestedOrganizationIds: [99],
    })).toEqual([12])
  })

  it("allows super admins to select valid organization scopes", () => {
    expect(resolveAnalyticsOrganizationIds({
      role: "SUPER_ADMIN",
      userOrganizationId: null,
      requestedOrganizationIds: ["4", 7, -1, "invalid", 4],
    })).toEqual([4, 7])
  })

  it("intersects requested branches with the allowed tenant branches", () => {
    expect(resolveAnalyticsBranchIds({
      role: "HEAD_OFFICE",
      userBranchId: null,
      requestedBranchIds: [2, 99],
      allowedBranchIds: [1, 2, 3],
    })).toEqual([2])
  })

  it("forces branch-scoped roles to their assigned branch", () => {
    expect(resolveAnalyticsBranchIds({
      role: "BRANCH_ADMIN",
      userBranchId: 3,
      requestedBranchIds: [1, 2],
      allowedBranchIds: [1, 2, 3],
    })).toEqual([3])
  })

  it("rejects a branch assignment outside the resolved organization scope", () => {
    expect(resolveAnalyticsBranchIds({
      role: "BRANCH_ADMIN",
      userBranchId: 9,
      requestedBranchIds: [],
      allowedBranchIds: [1, 2, 3],
    })).toEqual([])
  })

  it("normalizes positive integer identifiers", () => {
    expect(normalizePositiveIds(["2", 2, 3.5, 0, -1, "nope", 5])).toEqual([2, 5])
  })

  it("parses the report multi-select organization scope", () => {
    expect(parseRequestedOrganizationIds({
      organizationIds: "10,12,10,invalid,-1",
      organizationId: "99",
    })).toEqual([10, 12])
  })

  it("falls back to the global singular organization scope", () => {
    expect(parseRequestedOrganizationIds({
      organizationIds: null,
      organizationId: "10",
    })).toEqual([10])
  })
})

describe("group selection as a branch narrowing", () => {
  it("stands in for the branch request when none was named", () => {
    expect(narrowRequestedBranchIdsToGroups({
      requestedBranchIds: [],
      groupBranchIds: ["4", 5, 5],
    })).toEqual([4, 5])
  })

  it("keeps only the named branches that are inside the groups", () => {
    expect(narrowRequestedBranchIdsToGroups({
      requestedBranchIds: [4, 9],
      groupBranchIds: [4, 5],
    })).toEqual([4])
  })

  it("returns empty, never everything, when nothing survives", () => {
    // The resolver downstream reads an empty *request* as "every branch
    // allowed"; the caller must turn this into a refusal, so it has to be
    // empty here and not silently widened.
    expect(narrowRequestedBranchIdsToGroups({ requestedBranchIds: [9], groupBranchIds: [4, 5] })).toEqual([])
    expect(narrowRequestedBranchIdsToGroups({ requestedBranchIds: [], groupBranchIds: [] })).toEqual([])
    expect(narrowRequestedBranchIdsToGroups({ requestedBranchIds: [9], groupBranchIds: [] })).toEqual([])
  })
})

describe("a caller with no tenant", () => {
  it("is refused unless it is Super Admin", () => {
    for (const role of ["WAREHOUSE", "ORDER_DESK", "APRICART_EXECUTIVE", "HEAD_OFFICE", "VIEWER", "GROUP_USER", ""]) {
      expect(lacksAnalyticsTenant(role, null), role).toBe(true)
      expect(lacksAnalyticsTenant(role, undefined), role).toBe(true)
    }
    expect(lacksAnalyticsTenant("SUPER_ADMIN", null)).toBe(false)
  })

  it("is not refused when the session carries an organization", () => {
    for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "VIEWER"]) {
      expect(lacksAnalyticsTenant(role, 10), role).toBe(false)
      expect(lacksAnalyticsTenant(role, "10"), role).toBe(false)
    }
  })

  it("treats a malformed organization as none", () => {
    for (const organizationId of [0, -1, 1.5, "abc", "", Number.NaN]) {
      expect(lacksAnalyticsTenant("HEAD_OFFICE", organizationId), String(organizationId)).toBe(true)
    }
  })

  it("is applied by every analytics handler that filters by organization only when it has one", () => {
    for (const route of [
      "app/api/v1/analytics/branches/performance/route.ts",
      "app/api/v1/analytics/budgets/summary/route.ts",
      "app/api/v1/analytics/organization-stats/route.ts",
    ]) {
      expect(readFileSync(route, "utf8"), route).toMatch(/if \(lacksAnalyticsTenant\([\s\S]*?\)\) \{\s*return NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\)/)
    }
  })
})
