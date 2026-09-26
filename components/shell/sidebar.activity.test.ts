import { describe, expect, it } from "vitest"

import { getNavigationByRole } from "@/components/shell/sidebar"
import { ACTIVITY_LOG_ROLES, canViewActivityLog } from "@/lib/activity-log-access"

/**
 * The Activity Log entry appears for exactly the roles allowed to read it.
 *
 * The menu is presentation, not authorization — the route re-checks — but a
 * link that leads to a redirect is a broken menu, and a link offered to a role
 * that may not read the trail invites a support ticket about a screen they are
 * not meant to have.
 */

const EVERY_ROLE = [
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "GROUP_USER",
  "BRANCH_ADMIN",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
] as const

const hasActivityEntry = (role: string) =>
  getNavigationByRole(role).some((item) => item.href === "/activity")

describe("the Activity Log menu entry", () => {
  it("is offered to Super Admin", () => {
    expect(hasActivityEntry("SUPER_ADMIN")).toBe(true)
  })

  it.each(EVERY_ROLE.filter((role) => role !== "SUPER_ADMIN"))("is not offered to %s", (role) => {
    expect(hasActivityEntry(role)).toBe(false)
  })

  it("matches the access rule exactly, in both directions", () => {
    // If one side is changed without the other, this fails rather than leaving a
    // dead link or a hidden screen.
    for (const role of EVERY_ROLE) {
      expect(hasActivityEntry(role)).toBe(canViewActivityLog(role))
    }
    for (const role of ACTIVITY_LOG_ROLES) {
      expect(hasActivityEntry(role)).toBe(true)
    }
  })

  it("carries a label and an icon like every other entry", () => {
    const entry = getNavigationByRole("SUPER_ADMIN").find((item) => item.href === "/activity")
    expect(entry?.label).toBe("Activity Log")
    expect(entry?.icon).toBeTruthy()
  })
})
