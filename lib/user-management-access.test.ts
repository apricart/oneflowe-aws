import { describe, expect, it } from "vitest"

import { canAccessUserManagement } from "@/lib/user-management-access"

describe("user management access", () => {
  it.each(["SUPER_ADMIN", "HEAD_OFFICE"])("allows %s", (role) => {
    expect(canAccessUserManagement(role)).toBe(true)
  })

  it.each(["BRANCH_ADMIN", "ORDER_PORTAL", undefined, null, ""])(
    "denies %s",
    (role) => {
      expect(canAccessUserManagement(role)).toBe(false)
    },
  )
})
