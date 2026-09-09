import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { SUPPORT_PARTICIPANT_ROLES } from "./support-access"
import { SUPPORT_PORTAL_SHELL_ROLES, supportUsesPortalShell } from "./support-shell"

describe("supportUsesPortalShell", () => {
  it("keeps the sidebar for the roles that live behind it", () => {
    expect(supportUsesPortalShell("SUPER_ADMIN")).toBe(true)
    expect(supportUsesPortalShell("HEAD_OFFICE")).toBe(true)
    expect(supportUsesPortalShell("BRANCH_ADMIN")).toBe(true)
    expect(supportUsesPortalShell("GROUP_USER")).toBe(true)
  })

  it("leaves the store roles in their own minimal shell", () => {
    // These two reach support from `/shop` and `/group-portal`. Handing them
    // the administrator's navigation is the thing the minimal shell exists to
    // prevent, and it stays prevented.
    expect(supportUsesPortalShell("ORDER_PORTAL")).toBe(false)
    expect(supportUsesPortalShell("GROUP_ORDER_PORTAL")).toBe(false)
  })

  it("refuses an absent, empty or unrecognised role", () => {
    expect(supportUsesPortalShell(undefined)).toBe(false)
    expect(supportUsesPortalShell(null)).toBe(false)
    expect(supportUsesPortalShell("")).toBe(false)
    expect(supportUsesPortalShell("ADMIN")).toBe(false)
    expect(supportUsesPortalShell("super_admin")).toBe(false)
  })

  it("only ever names roles that are party to a support conversation", () => {
    for (const role of SUPPORT_PORTAL_SHELL_ROLES) {
      expect(SUPPORT_PARTICIPANT_ROLES).toContain(role)
    }
  })
})

/**
 * Contract test: the shell rule and the sidebar are one decision.
 *
 * A role that gets a `/support` entry in the sidebar and then loses the sidebar
 * on arrival is exactly the defect this module was written for, and a role that
 * keeps the chrome without having a menu to put in it would render an empty
 * one. Both are caught here by reading the sidebar itself.
 */
describe("the shell rule agrees with the sidebar", () => {
  const sidebar = readFileSync(
    resolve(process.cwd(), "components/shell/sidebar.tsx"),
    "utf8",
  )

  /** The branch of `getNavigationByRole` that this role falls into. */
  function navigationFor(role: string): string {
    const start = sidebar.indexOf(`if (role === "${role}")`)
    // No branch of its own means the role falls through to `baseNav`, which is
    // the dashboard alone and carries no support entry.
    if (start === -1) return ""

    const rest = sidebar.slice(start + 1)
    const next = rest.indexOf("if (role === ")
    return next === -1 ? rest : rest.slice(0, next)
  }

  it("gives the portal chrome to exactly the roles the sidebar offers support to", () => {
    for (const role of SUPPORT_PARTICIPANT_ROLES) {
      const hasSupportEntry = navigationFor(role).includes('href: "/support"')
      expect(
        supportUsesPortalShell(role),
        `${role}: sidebar ${hasSupportEntry ? "offers" : "does not offer"} a /support entry`,
      ).toBe(hasSupportEntry)
    }
  })

  it("reads a sidebar that still states its navigation per role", () => {
    // If this fails the parser above has stopped measuring anything, and the
    // agreement it asserts would pass vacuously.
    expect(sidebar).toContain("const getNavigationByRole")
    expect(sidebar).toContain('href: "/support"')
    expect(navigationFor("SUPER_ADMIN")).toContain('href: "/support"')
    expect(navigationFor("ORDER_PORTAL")).toBe("")
  })
})
