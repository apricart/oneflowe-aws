import { describe, expect, it } from "vitest"

import {
  DELIVERY_ADDRESS_DECISION_ROLES,
  DELIVERY_ADDRESS_READ_ROLES,
  DELIVERY_ADDRESS_REQUEST_ROLES,
  canDecideDeliveryAddress,
  canReadDeliveryAddresses,
  canRequestDeliveryAddress,
} from "@/lib/delivery-address-access"
import type { Role } from "@/lib/rbac"

/**
 * Every role in the system, listed here rather than derived, so that adding a
 * role to `Role` without deciding what it may do with delivery addresses fails
 * this file instead of silently defaulting to "no".
 */
const EVERY_ROLE: Role[] = [
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "GROUP_USER",
  "BRANCH_ADMIN",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
  "VIEWER",
]

describe("who may request a delivery address", () => {
  it.each(["ORDER_PORTAL", "BRANCH_ADMIN", "GROUP_ORDER_PORTAL", "GROUP_USER"] as const)(
    "admits %s, which acts for a branch",
    (role) => {
      expect(canRequestDeliveryAddress(role)).toBe(true)
    },
  )

  it.each(["HEAD_OFFICE", "SUPER_ADMIN", "VIEWER"] as const)("refuses %s", (role) => {
    expect(canRequestDeliveryAddress(role)).toBe(false)
  })

  it("covers every role exactly once", () => {
    const admitted = EVERY_ROLE.filter(canRequestDeliveryAddress)
    expect(new Set(admitted)).toEqual(new Set(DELIVERY_ADDRESS_REQUEST_ROLES))
    expect(DELIVERY_ADDRESS_REQUEST_ROLES).toHaveLength(new Set(DELIVERY_ADDRESS_REQUEST_ROLES).size)
  })
})

describe("who may decide one", () => {
  it("is Head Office and nobody else", () => {
    expect(DELIVERY_ADDRESS_DECISION_ROLES).toEqual(["HEAD_OFFICE"])
    expect(EVERY_ROLE.filter(canDecideDeliveryAddress)).toEqual(["HEAD_OFFICE"])
  })

  /**
   * The shape of the whole feature: a branch may say where it needs goods and
   * cannot decide it. If these two lists ever overlapped, a requester could
   * approve its own address and the approval would be ceremonial.
   */
  it("shares no role with the requesters", () => {
    const overlap = DELIVERY_ADDRESS_REQUEST_ROLES.filter((role) =>
      DELIVERY_ADDRESS_DECISION_ROLES.includes(role))
    expect(overlap).toEqual([])
  })

  it("refuses Super Admin, which administers the platform rather than a tenant's deliveries", () => {
    expect(canDecideDeliveryAddress("SUPER_ADMIN")).toBe(false)
  })
})

describe("who may read the list", () => {
  it("is exactly the requesters plus the decider", () => {
    expect(new Set(DELIVERY_ADDRESS_READ_ROLES)).toEqual(
      new Set([...DELIVERY_ADDRESS_REQUEST_ROLES, ...DELIVERY_ADDRESS_DECISION_ROLES]),
    )
  })

  /**
   * Derived rather than listed, so a role added to either authority cannot end
   * up able to act on a list it is not allowed to see.
   */
  it.each(EVERY_ROLE)("lets %s read if and only if it may request or decide", (role) => {
    const acts = canRequestDeliveryAddress(role) || canDecideDeliveryAddress(role)
    expect(canReadDeliveryAddresses(role)).toBe(acts)
  })
})

describe("non-roles", () => {
  it.each([
    ["an unknown role", "AUDITOR"],
    ["a lower-cased role", "head_office"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 1],
    ["an object", {}],
  ])("refuses %s everywhere", (_label, value) => {
    expect(canRequestDeliveryAddress(value)).toBe(false)
    expect(canDecideDeliveryAddress(value)).toBe(false)
    expect(canReadDeliveryAddresses(value)).toBe(false)
  })
})
