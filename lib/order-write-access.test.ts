import { describe, expect, it } from "vitest"

import {
  canRequesterActOnOrder,
  canRequesterEditOrder,
  describeOrderWrite,
  isOrderWriteRole,
  type OrderWriteActor,
  type OrderWriteSubject,
} from "@/lib/order-write-access"

const RAISER = "11111111-1111-1111-1111-111111111111"
const COLLEAGUE = "22222222-2222-2222-2222-222222222222"

const branchUser = (over: Partial<OrderWriteActor> = {}): OrderWriteActor => ({
  role: "ORDER_PORTAL",
  userId: COLLEAGUE,
  organizationId: 10,
  branchIds: [7],
  ...over,
})

const groupUser = (over: Partial<OrderWriteActor> = {}): OrderWriteActor => ({
  role: "GROUP_ORDER_PORTAL",
  userId: COLLEAGUE,
  organizationId: 10,
  branchIds: [7, 8, 9],
  ...over,
})

const order = (over: Partial<OrderWriteSubject> = {}): OrderWriteSubject => ({
  status: "PENDING",
  createdByUserId: RAISER,
  organizationId: 10,
  branchId: 7,
  branchOrganizationId: 10,
  ...over,
})

describe("isOrderWriteRole", () => {
  it("accepts both requester roles and nothing else", () => {
    expect(isOrderWriteRole("ORDER_PORTAL")).toBe(true)
    expect(isOrderWriteRole("GROUP_ORDER_PORTAL")).toBe(true)
    for (const role of ["BRANCH_ADMIN", "HEAD_OFFICE", "SUPER_ADMIN", "GROUP_USER", "", null]) {
      expect(isOrderWriteRole(role)).toBe(false)
    }
  })
})

describe("the branch owns its orders", () => {
  it("lets a branch requester act on an order a colleague raised", () => {
    expect(canRequesterActOnOrder(branchUser(), order())).toBe(true)
  })

  it("lets a group requester act on an order raised by branch staff", () => {
    expect(canRequesterActOnOrder(groupUser(), order())).toBe(true)
  })

  it("still lets each act on what it raised itself", () => {
    expect(canRequesterActOnOrder(branchUser({ userId: RAISER }), order())).toBe(true)
    expect(canRequesterActOnOrder(groupUser({ userId: RAISER }), order())).toBe(true)
  })
})

describe("scope is still mandatory", () => {
  it("denies a branch outside the actor's set", () => {
    expect(canRequesterActOnOrder(branchUser(), order({ branchId: 8 }))).toBe(false)
    expect(canRequesterActOnOrder(groupUser(), order({ branchId: 42 }))).toBe(false)
  })

  it("denies another tenant's order", () => {
    expect(canRequesterActOnOrder(
      branchUser(),
      order({ organizationId: 2, branchOrganizationId: 2 }),
    )).toBe(false)
  })

  it("denies an order whose branch belongs to another tenant", () => {
    expect(canRequesterActOnOrder(branchUser(), order({ branchOrganizationId: 2 }))).toBe(false)
  })

  // The failure that would matter most: an unassigned group user must reach
  // nothing, never everything.
  it("denies an empty assignment set rather than widening to the tenant", () => {
    expect(canRequesterActOnOrder(groupUser({ branchIds: [] }), order())).toBe(false)
    expect(canRequesterActOnOrder(groupUser({ branchIds: null }), order())).toBe(false)
  })

  it("denies a role that does not raise orders", () => {
    for (const role of ["BRANCH_ADMIN", "HEAD_OFFICE", "SUPER_ADMIN", "GROUP_USER"]) {
      expect(canRequesterActOnOrder(branchUser({ role }), order())).toBe(false)
    }
  })

  it("denies an actor with no identity", () => {
    expect(canRequesterActOnOrder(branchUser({ userId: null }), order())).toBe(false)
    expect(canRequesterActOnOrder(branchUser({ organizationId: null }), order())).toBe(false)
  })
})

describe("canRequesterEditOrder", () => {
  it("allows a pending order", () => {
    expect(canRequesterEditOrder(branchUser(), order({ status: "pending" }))).toBe(true)
  })

  it("refuses once the order has been decided", () => {
    for (const status of ["APPROVED", "REJECTED", "FULFILLED", "CANCELLED", "REFUNDED", "", null]) {
      expect(canRequesterEditOrder(branchUser(), order({ status }))).toBe(false)
    }
  })

  it("refuses a pending order outside the actor's branches", () => {
    expect(canRequesterEditOrder(groupUser({ branchIds: [8] }), order())).toBe(false)
  })
})

describe("describeOrderWrite", () => {
  it("names the raiser when someone else is writing", () => {
    expect(describeOrderWrite(branchUser(), order())).toEqual({
      onBehalfOfUserId: RAISER,
      isCrossRequesterWrite: true,
    })
  })

  it("reports nothing to attribute when the raiser is the actor", () => {
    expect(describeOrderWrite(branchUser({ userId: RAISER }), order())).toEqual({
      onBehalfOfUserId: null,
      isCrossRequesterWrite: false,
    })
  })

  it("treats a missing creator as nobody to notify", () => {
    expect(describeOrderWrite(branchUser(), order({ createdByUserId: null })))
      .toEqual({ onBehalfOfUserId: null, isCrossRequesterWrite: false })
  })
})
