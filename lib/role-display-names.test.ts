import { describe, expect, it } from "vitest"

import { ROLE_TEMPLATES } from "@/lib/permissions"
import { isValidRole } from "@/lib/rbac"
import { GROUP_ORDER_PORTAL_NAME, ORDER_PORTAL_NAME, ROLE_DISPLAY_NAMES, renamedRoleName } from "@/lib/role-display-names"

describe("role display names", () => {
  it("renames exactly the four tenant roles, keyed by their unchanged codes", () => {
    expect(ROLE_DISPLAY_NAMES).toEqual({
      BRANCH_ADMIN: "Financial Approver",
      GROUP_USER: "Group Financial Approver",
      ORDER_PORTAL: "Order Initiator",
      GROUP_ORDER_PORTAL: "Group Order Initiator",
    })
    for (const code of Object.keys(ROLE_DISPLAY_NAMES)) {
      expect(isValidRole(code)).toBe(true)
    }
  })

  it("names the two storefronts after the roles that use them", () => {
    expect(ORDER_PORTAL_NAME).toBe("Order Initiator Portal")
    expect(GROUP_ORDER_PORTAL_NAME).toBe("Group Order Initiator Portal")
  })

  it("is what the role templates call those roles", () => {
    for (const [code, name] of Object.entries(ROLE_DISPLAY_NAMES)) {
      expect(ROLE_TEMPLATES[code as keyof typeof ROLE_TEMPLATES].name).toBe(name)
    }
  })

  it("answers null for every other role, an unknown string, and nothing", () => {
    expect(renamedRoleName("BRANCH_ADMIN")).toBe("Financial Approver")
    expect(renamedRoleName("GROUP_ORDER_PORTAL")).toBe("Group Order Initiator")
    expect(renamedRoleName("HEAD_OFFICE")).toBeNull()
    expect(renamedRoleName("SUPER_ADMIN")).toBeNull()
    expect(renamedRoleName("toString")).toBeNull()
    expect(renamedRoleName("")).toBeNull()
    expect(renamedRoleName(null)).toBeNull()
    expect(renamedRoleName(undefined)).toBeNull()
  })
})
