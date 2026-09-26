import { describe, expect, it } from "vitest"

import {
  ACTIVITY_LOG_PERMISSION,
  ACTIVITY_LOG_ROLES,
  activityLogAccessFailure,
  canViewActivityLog,
} from "@/lib/activity-log-access"
import { Permission, ROLE_TEMPLATES } from "@/lib/permissions"

/**
 * The whole role matrix, stated once.
 *
 * The screen reads every tenant's trail, so this is the control that keeps a
 * future "Head Office should see their own organization's activity" change from
 * being made by accident — it would have to delete a test that says why not.
 */

const EVERY_ROLE = [
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "GROUP_USER",
  "BRANCH_ADMIN",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
] as const

describe("canViewActivityLog", () => {
  it("admits Super Admin", () => {
    expect(canViewActivityLog("SUPER_ADMIN")).toBe(true)
  })

  it.each(EVERY_ROLE.filter((role) => role !== "SUPER_ADMIN"))("refuses %s", (role) => {
    expect(canViewActivityLog(role)).toBe(false)
  })

  it("refuses an absent or unknown role", () => {
    expect(canViewActivityLog(null)).toBe(false)
    expect(canViewActivityLog(undefined)).toBe(false)
    expect(canViewActivityLog("")).toBe(false)
    expect(canViewActivityLog("super_admin")).toBe(false)
    expect(canViewActivityLog("SUPER_ADMIN ")).toBe(false)
  })
})

describe("activityLogAccessFailure", () => {
  it("returns nothing for a permitted role", () => {
    expect(activityLogAccessFailure("SUPER_ADMIN")).toBeNull()
  })

  it("separates not signed in from not permitted", () => {
    expect(activityLogAccessFailure(null)).toEqual({ message: "Unauthorized", status: 401 })
    expect(activityLogAccessFailure("HEAD_OFFICE")).toEqual({
      message: expect.stringContaining("Super Admin"),
      status: 403,
    })
  })

  it("says nothing about the trail in the refusal", () => {
    const failure = activityLogAccessFailure("ORDER_PORTAL")
    expect(failure?.message).not.toMatch(/\d/)
  })
})

describe("the permission behind it", () => {
  it("is the one RBAC already defines for reading an audit trail", () => {
    expect(ACTIVITY_LOG_PERMISSION).toBe(Permission.SYSTEM_VIEW_AUDIT_LOGS)
  })

  it("is held by exactly the roles this module admits", () => {
    // If a template is ever granted SYSTEM_VIEW_AUDIT_LOGS, this fails and the
    // decision has to be made deliberately in both places.
    const holders = Object.entries(ROLE_TEMPLATES)
      .filter(([, template]) =>
        (template.permissions as readonly Permission[]).includes(Permission.SYSTEM_VIEW_AUDIT_LOGS),
      )
      .map(([role]) => role)
      .sort()

    expect(holders).toEqual([...ACTIVITY_LOG_ROLES].sort())
  })
})
