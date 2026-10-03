import { describe, expect, it } from "vitest"

import {
  JOIN_REQUEST_MANAGEMENT_ROLES,
  canManageJoinRequests,
} from "@/lib/organization-join-access"
import { USER_MANAGEMENT_ROLES } from "@/lib/user-management-access"

describe("who may issue a join code and decide a join request", () => {
  it("is Head Office and nobody else", () => {
    expect(JOIN_REQUEST_MANAGEMENT_ROLES).toEqual(["HEAD_OFFICE"])
    expect(canManageJoinRequests("HEAD_OFFICE")).toBe(true)
  })

  it("refuses Super Admin, deliberately", () => {
    // Not an oversight. Letting somebody into a tenant through that tenant's own
    // join queue belongs to the tenant's gatekeeper; Super Admin creates a user
    // directly through POST /api/v1/users instead, which is separately audited.
    expect(canManageJoinRequests("SUPER_ADMIN")).toBe(false)
    expect(JOIN_REQUEST_MANAGEMENT_ROLES).not.toContain("SUPER_ADMIN")
  })

  it("is strictly narrower than user management", () => {
    // If these ever became equal, this feature would have quietly acquired the
    // wider authority the user-management surface holds.
    expect(USER_MANAGEMENT_ROLES).toContain("SUPER_ADMIN")
    for (const role of JOIN_REQUEST_MANAGEMENT_ROLES) {
      expect(USER_MANAGEMENT_ROLES).toContain(role)
    }
    expect(JOIN_REQUEST_MANAGEMENT_ROLES.length).toBeLessThan(USER_MANAGEMENT_ROLES.length)
  })

  it("refuses every role that can hold a session but is not Head Office", () => {
    for (const role of ["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "GROUP_ORDER_PORTAL"]) {
      expect(canManageJoinRequests(role)).toBe(false)
    }
  })

  it("refuses anything that is not a role string, including a near miss", () => {
    for (const value of [null, undefined, 0, {}, [], "", "head_office", " HEAD_OFFICE"]) {
      expect(canManageJoinRequests(value)).toBe(false)
    }
  })
})
