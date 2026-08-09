import { describe, expect, it } from "vitest"

import {
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
