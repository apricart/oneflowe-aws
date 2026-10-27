import { describe, expect, it } from "vitest"

import {
  DESK_ORDER_APPROVAL_BASIS,
  canExecutiveDecideOrder,
  canSuperAdminDecideDeskOrder,
  decisionCapabilitiesForOrder,
  decisionQueuesNotifications,
  deskApprovalReachIsEmpty,
  isDeskEnteredOrder,
  orderDecisionAuthority,
} from "@/lib/order-desk-approval"

describe("who decides an order", () => {
  it("is an Apricart Executive for an order the Order Desk entered", () => {
    expect(isDeskEnteredOrder({ createdByRole: "ORDER_DESK" })).toBe(true)
    expect(orderDecisionAuthority({ createdByRole: "ORDER_DESK" })).toBe("APRICART_EXECUTIVE")
  })

  it.each(["ORDER_PORTAL", "GROUP_ORDER_PORTAL", "HEAD_OFFICE", "SUPER_ADMIN", "order_desk", "", null, undefined])(
    "is the tenant for an order created by %s",
    (createdByRole) => {
      expect(isDeskEnteredOrder({ createdByRole })).toBe(false)
      expect(orderDecisionAuthority({ createdByRole })).toBe("TENANT")
    },
  )

  it("names the basis the creation log records", () => {
    expect(DESK_ORDER_APPROVAL_BASIS).toBe("APRICART_EXECUTIVE_APPROVAL")
  })
})

describe("an executive deciding an order", () => {
  const deskOrder = { createdByRole: "ORDER_DESK", organizationId: 11, branchOrganizationId: 11 }

  it("may decide a desk order in an assigned organization", () => {
    expect(canExecutiveDecideOrder({ reachOrganizationIds: [4, 11], order: deskOrder })).toBe(true)
  })

  it("may not decide one in an organization not assigned to them", () => {
    expect(canExecutiveDecideOrder({ reachOrganizationIds: [4], order: deskOrder })).toBe(false)
  })

  it("decides nothing with an empty reach", () => {
    expect(canExecutiveDecideOrder({ reachOrganizationIds: [], order: deskOrder })).toBe(false)
  })

  it("may not decide an order the customer's own staff raised, even in an assigned organization", () => {
    expect(canExecutiveDecideOrder({
      reachOrganizationIds: [11],
      order: { ...deskOrder, createdByRole: "ORDER_PORTAL" },
    })).toBe(false)
    expect(canExecutiveDecideOrder({
      reachOrganizationIds: [11],
      order: { ...deskOrder, createdByRole: null },
    })).toBe(false)
  })

  it("refuses an order whose branch belongs to another organization", () => {
    expect(canExecutiveDecideOrder({ reachOrganizationIds: [11], order: { ...deskOrder, branchOrganizationId: 4 } })).toBe(false)
    expect(canExecutiveDecideOrder({ reachOrganizationIds: [11], order: { ...deskOrder, branchOrganizationId: null } })).toBe(false)
  })

  it("refuses an order with no organization", () => {
    expect(canExecutiveDecideOrder({
      reachOrganizationIds: [11],
      order: { ...deskOrder, organizationId: null, branchOrganizationId: null },
    })).toBe(false)
  })
})

describe("Super Admin deciding an order", () => {
  const deskOrder = { createdByRole: "ORDER_DESK", organizationId: 11, branchOrganizationId: 11 }

  it("may decide any desk order, with no assignment", () => {
    expect(canSuperAdminDecideDeskOrder(deskOrder)).toBe(true)
    expect(canSuperAdminDecideDeskOrder({ ...deskOrder, organizationId: 4, branchOrganizationId: 4 })).toBe(true)
  })

  it.each(["ORDER_PORTAL", "GROUP_ORDER_PORTAL", "HEAD_OFFICE", "SUPER_ADMIN", null, undefined])(
    "may not decide an order created by %s — the tenant's approvers keep those",
    (createdByRole) => {
      expect(canSuperAdminDecideDeskOrder({ ...deskOrder, createdByRole })).toBe(false)
    },
  )

  it("refuses an order whose branch belongs to another organization, or with no organization", () => {
    expect(canSuperAdminDecideDeskOrder({ ...deskOrder, branchOrganizationId: 4 })).toBe(false)
    expect(canSuperAdminDecideDeskOrder({ ...deskOrder, branchOrganizationId: null })).toBe(false)
    expect(canSuperAdminDecideDeskOrder({ ...deskOrder, organizationId: null, branchOrganizationId: null })).toBe(false)
  })
})

describe("a desk approval reach", () => {
  it("is empty only as an organization list with nothing in it", () => {
    expect(deskApprovalReachIsEmpty({ kind: "organizations", organizationIds: [] })).toBe(true)
    expect(deskApprovalReachIsEmpty({ kind: "organizations", organizationIds: [3] })).toBe(false)
    expect(deskApprovalReachIsEmpty({ kind: "all" })).toBe(false)
  })
})

describe("decision notices", () => {
  it("are queued for every tenant decision, and not for a desk order's decider", () => {
    for (const role of ["BRANCH_ADMIN", "HEAD_OFFICE", "GROUP_USER"]) {
      expect(decisionQueuesNotifications(role)).toBe(true)
    }
    expect(decisionQueuesNotifications("APRICART_EXECUTIVE")).toBe(false)
    expect(decisionQueuesNotifications("SUPER_ADMIN")).toBe(false)
  })
})

describe("the decision buttons a tenant reader is offered", () => {
  const all = { canApproveOrders: true, canRejectOrders: true, canReturnOrders: true, orderApproverRole: "HEAD_OFFICE" as const }

  it("are none on a desk order, whatever the role allows", () => {
    expect(decisionCapabilitiesForOrder(all, { createdByRole: "ORDER_DESK" }))
      .toEqual({ canApproveOrders: false, canRejectOrders: false, canReturnOrders: false, orderApproverRole: "HEAD_OFFICE" })
  })

  it("are exactly the role's on every other order", () => {
    expect(decisionCapabilitiesForOrder(all, { createdByRole: "ORDER_PORTAL" })).toBe(all)
    expect(decisionCapabilitiesForOrder(all, { createdByRole: null })).toBe(all)
  })
})
