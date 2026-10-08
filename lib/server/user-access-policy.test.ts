import { describe, expect, it } from "vitest"
import { canAssignRole, canManageUser } from "@/lib/server/user-access-policy"
import { USER_MANAGEMENT_ROLES } from "@/lib/user-management-access"
import type { SystemRole } from "@/lib/server/mutation-validation"

const EVERY_ROLE: SystemRole[] = [
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "GROUP_USER",
  "BRANCH_ADMIN",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
  "VIEWER",
  "ORDER_DESK",
]

describe("who may create a Viewer", () => {
  it.each(USER_MANAGEMENT_ROLES)("admits %s, the roles that manage users at all", (actor) => {
    expect(canAssignRole(actor as SystemRole, "VIEWER")).toBe(true)
  })

  it.each(["GROUP_USER", "BRANCH_ADMIN", "GROUP_ORDER_PORTAL", "ORDER_PORTAL"] as SystemRole[])(
    "clears %s on the ladder, which is not what keeps it out",
    (actor) => {
      // VIEWER sits at the floor, so every acting role outranks it and the
      // ladder says yes. None of these four can create a user at all: they
      // never reach `POST /api/v1/users`, because `USER_MANAGEMENT_ROLES` is
      // checked first. That list is the control, and the next test pins it.
      expect(canAssignRole(actor, "VIEWER")).toBe(true)
    },
  )

  it("keeps user management to Super Admin and Head Office, which is what limits this", () => {
    expect([...USER_MANAGEMENT_ROLES].sort()).toEqual(["HEAD_OFFICE", "SUPER_ADMIN"])
  })

  it("keeps a Viewer from assigning anything, including its own role", () => {
    for (const role of EVERY_ROLE) {
      expect(canAssignRole("VIEWER", role)).toBe(false)
    }
  })
})

describe("the authority ladder", () => {
  it("never lets anyone assign SUPER_ADMIN", () => {
    for (const actor of EVERY_ROLE) {
      expect(canAssignRole(actor, "SUPER_ADMIN")).toBe(false)
    }
  })

  it("preserves the pairs that existed before VIEWER was added", () => {
    // Renumbering ROLE_LEVEL must not change any pre-existing relationship.
    expect(canAssignRole("HEAD_OFFICE", "GROUP_USER")).toBe(true)
    expect(canAssignRole("HEAD_OFFICE", "BRANCH_ADMIN")).toBe(true)
    expect(canAssignRole("HEAD_OFFICE", "ORDER_PORTAL")).toBe(true)
    expect(canAssignRole("GROUP_USER", "BRANCH_ADMIN")).toBe(true)
    expect(canAssignRole("BRANCH_ADMIN", "GROUP_USER")).toBe(false)
    expect(canAssignRole("BRANCH_ADMIN", "BRANCH_ADMIN")).toBe(false)
    expect(canAssignRole("ORDER_PORTAL", "GROUP_ORDER_PORTAL")).toBe(false)
  })

  it("puts VIEWER below every acting role", () => {
    for (const actor of EVERY_ROLE.filter((role) => role !== "VIEWER")) {
      expect(canManageUser(actor, "VIEWER")).toBe(true)
    }
  })

  it("lets a Viewer manage nobody", () => {
    for (const target of EVERY_ROLE) {
      expect(canManageUser("VIEWER", target)).toBe(false)
    }
  })

  it("refuses to manage a Super Admin whoever asks", () => {
    for (const actor of EVERY_ROLE) {
      expect(canManageUser(actor, "SUPER_ADMIN")).toBe(false)
    }
  })
})

describe("who may create or manage an Order Desk account", () => {
  it("is Super Admin alone", () => {
    expect(canAssignRole("SUPER_ADMIN", "ORDER_DESK")).toBe(true)
    expect(canManageUser("SUPER_ADMIN", "ORDER_DESK")).toBe(true)
  })

  it("is never a tenant's administrator, whose reach is one organization", () => {
    for (const actor of EVERY_ROLE.filter((role) => role !== "SUPER_ADMIN")) {
      expect(canAssignRole(actor, "ORDER_DESK")).toBe(false)
      expect(canManageUser(actor, "ORDER_DESK")).toBe(false)
    }
  })

  it("does not let a desk account manage or create anyone with a tenant above the floor", () => {
    // ORDER_DESK sits above HEAD_OFFICE on the ladder only to keep Head Office
    // out; it never reaches user management (USER_MANAGEMENT_ROLES), and the
    // proxy refuses it every user route before a handler runs.
    expect(USER_MANAGEMENT_ROLES).not.toContain("ORDER_DESK")
  })

  it("leaves every pre-existing pair where it was", () => {
    expect(canAssignRole("HEAD_OFFICE", "GROUP_USER")).toBe(true)
    expect(canAssignRole("HEAD_OFFICE", "VIEWER")).toBe(true)
    expect(canAssignRole("SUPER_ADMIN", "HEAD_OFFICE")).toBe(true)
    expect(canManageUser("HEAD_OFFICE", "HEAD_OFFICE")).toBe(false)
    expect(canManageUser("SUPER_ADMIN", "HEAD_OFFICE")).toBe(true)
  })
})
