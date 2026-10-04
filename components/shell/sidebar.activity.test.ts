import { describe, expect, it } from "vitest"

import { getNavigationByRole } from "@/components/shell/sidebar"
import { ACTIVITY_LOG_ROLES, canViewActivityLog } from "@/lib/activity-log-access"

/**
 * The Activity Log entry appears for exactly the roles allowed to read it —
 * Super Admin for every tenant, Head Office for its own
 * (`plans/OF-AUDIT-head-office-activity-log.md`).
 *
 * The menu is presentation, not authorization — the route re-checks and fences
 * — but a link that leads to a redirect is a broken menu, and a link offered to
 * a role that may not read the trail invites a support ticket about a screen
 * they are not meant to have.
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

const OFFERED = ["SUPER_ADMIN", "HEAD_OFFICE"] as const

const hasActivityEntry = (role: string) =>
  getNavigationByRole(role).some((item) => item.href === "/activity")

describe("the Activity Log menu entry", () => {
  it.each(OFFERED)("is offered to %s", (role) => {
    expect(hasActivityEntry(role)).toBe(true)
  })

  it.each(EVERY_ROLE.filter((role) => !(OFFERED as readonly string[]).includes(role)))(
    "is not offered to %s",
    (role) => {
      expect(hasActivityEntry(role)).toBe(false)
    },
  )

  it("survives a tenant with budgets switched off", () => {
    expect(getNavigationByRole("HEAD_OFFICE", false, false).some((item) => item.href === "/activity")).toBe(true)
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
    for (const role of OFFERED) {
      const entry = getNavigationByRole(role).find((item) => item.href === "/activity")
      expect(entry?.label).toBe("Activity Log")
      expect(entry?.icon).toBeTruthy()
    }
  })
})
