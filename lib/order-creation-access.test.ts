import { describe, expect, it } from "vitest"

import { mayCreateOrder, ORDER_CREATION_ROLES } from "./order-creation-access"

describe("who may create a single-branch order", () => {
  it.each(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "EMPLOYEE", "ORDER_DESK"])(
    "admits %s, which orders through this route today or by design",
    (role) => {
      expect(mayCreateOrder(role)).toBe(true)
    },
  )

  it.each(["VIEWER", "GROUP_USER", "GROUP_ORDER_PORTAL", "BRANCH_MANAGER", "", "super_admin"])(
    "refuses %s",
    (role) => {
      expect(mayCreateOrder(role)).toBe(false)
    },
  )

  it.each([undefined, null, 1, {}, ["ORDER_PORTAL"]])("refuses a non-string role (%s)", (role) => {
    expect(mayCreateOrder(role)).toBe(false)
  })

  it("never admits the read-only role", () => {
    expect(ORDER_CREATION_ROLES).not.toContain("VIEWER")
  })
})
