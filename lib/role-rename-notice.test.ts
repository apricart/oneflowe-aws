import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  clearRoleRenameNoticeDue,
  isRoleRenameNoticeDue,
  markRoleRenameNoticeDue,
  PREVIOUS_ROLE_NAMES,
  ROLE_RENAME_NOTICE_STORAGE_KEY,
  roleRenamesToAnnounce,
} from "@/lib/role-rename-notice"

const pairs = (role: string | null | undefined) =>
  roleRenamesToAnnounce(role).map(({ previousName, newName }) => `${previousName} -> ${newName}`)

const BRANCH_PAIRS = ["Branch Admin -> Financial Approver", "Order Portal -> Order Initiator"]
const GROUP_PAIRS = ["Group User -> Group Financial Approver", "Group Order Portal -> Group Order Initiator"]

describe("which renames a person is told about", () => {
  it.each(["GROUP_USER", "GROUP_ORDER_PORTAL"])("tells %s about the two group roles only", (role) => {
    expect(pairs(role)).toEqual(GROUP_PAIRS)
  })

  it.each(["BRANCH_ADMIN", "ORDER_PORTAL"])("tells %s about the two branch roles only", (role) => {
    expect(pairs(role)).toEqual(BRANCH_PAIRS)
  })

  it.each([
    "HEAD_OFFICE", "SUPER_ADMIN", "VIEWER", "ORDER_DESK", "APRICART_EXECUTIVE", "WAREHOUSE", "EMPLOYEE", "", null, undefined,
  ])("tells %s about all four", (role) => {
    expect(pairs(role)).toEqual([...BRANCH_PAIRS, ...GROUP_PAIRS])
  })

  it("names exactly the four renamed roles as they were before", () => {
    expect(PREVIOUS_ROLE_NAMES).toEqual({
      BRANCH_ADMIN: "Branch Admin",
      ORDER_PORTAL: "Order Portal",
      GROUP_USER: "Group User",
      GROUP_ORDER_PORTAL: "Group Order Portal",
    })
  })
})

describe("the once-per-sign-in mark", () => {
  beforeEach(() => sessionStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it("is not due until a sign-in marks it, and clearing it ends it", () => {
    expect(isRoleRenameNoticeDue()).toBe(false)
    markRoleRenameNoticeDue()
    expect(sessionStorage.getItem(ROLE_RENAME_NOTICE_STORAGE_KEY)).toBe("due")
    expect(isRoleRenameNoticeDue()).toBe(true)
    clearRoleRenameNoticeDue()
    expect(isRoleRenameNoticeDue()).toBe(false)
  })

  it("never throws when storage is blocked, and the notice is then simply not due", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked") })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked") })
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked") })
    expect(() => markRoleRenameNoticeDue()).not.toThrow()
    expect(isRoleRenameNoticeDue()).toBe(false)
    expect(() => clearRoleRenameNoticeDue()).not.toThrow()
  })
})
