import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  canManageOrderDesk,
  deskOrderActions,
  isOrderDeskApiRequestAllowed,
  isOrderDeskRole,
  isOrderIntakeAttachmentKey,
  ORDER_DESK_API_RULES,
  orderDeskAccessChangeError,
  orderDeskRequiresExecutiveApproval,
  orderDeskUserShapeError,
  hasDeskIntakeScreenshot,
  orderIntakeError,
  resolveDeskReach,
  type DeskReachInput,
} from "./order-desk-access"

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

const ACTIVE_DESK = { role: "ORDER_DESK", isActive: true, deleted: false }

/**
 *   org 1 managed, active      branches 11 (active), 12 (active), 13 (inactive)
 *   org 2 managed, active      branch 21
 *   org 3 NOT managed          branch 31
 *   org 4 managed, SUSPENDED   branch 41
 */
function input(overrides: Partial<DeskReachInput> = {}): DeskReachInput {
  return {
    account: ACTIVE_DESK,
    assignments: [],
    organizations: [
      { id: 1, managedOrdering: true, status: "active" },
      { id: 2, managedOrdering: true, status: "active" },
      { id: 3, managedOrdering: false, status: "active" },
      { id: 4, managedOrdering: true, status: "suspended" },
    ],
    branches: [
      { id: 11, organizationId: 1, status: "active" },
      { id: 12, organizationId: 1, status: "active" },
      { id: 13, organizationId: 1, status: "inactive" },
      { id: 21, organizationId: 2, status: "active" },
      { id: 31, organizationId: 3, status: "active" },
      { id: 41, organizationId: 4, status: "active" },
    ],
    ...overrides,
  }
}

describe("the desk's reach", () => {
  it("grants every active branch of an organization assigned whole", () => {
    const reach = resolveDeskReach(input({ assignments: [{ organizationId: 1, branchId: null }] }), "order")
    expect(reach).toEqual({ organizationIds: [1], branchIds: [11, 12] })
  })

  it("keeps an inactive branch for managing existing orders, not for new ones", () => {
    const reach = resolveDeskReach(input({ assignments: [{ organizationId: 1, branchId: null }] }), "manage")
    expect(reach.branchIds).toEqual([11, 12, 13])
  })

  it("narrows a single-branch grant to that branch", () => {
    const reach = resolveDeskReach(input({ assignments: [{ organizationId: 2, branchId: 21 }] }), "order")
    expect(reach).toEqual({ organizationIds: [2], branchIds: [21] })
  })

  it("reaches nothing in an organization that is not managed, whatever was granted", () => {
    for (const purpose of ["order", "manage"] as const) {
      const reach = resolveDeskReach(input({
        assignments: [{ organizationId: 3, branchId: null }, { organizationId: 3, branchId: 31 }],
      }), purpose)
      expect(reach).toEqual({ organizationIds: [], branchIds: [] })
    }
  })

  it("does not order for a suspended organization, but can still finish its orders", () => {
    const assignments = [{ organizationId: 4, branchId: null }]
    expect(resolveDeskReach(input({ assignments }), "order").branchIds).toEqual([])
    expect(resolveDeskReach(input({ assignments }), "manage").branchIds).toEqual([41])
  })

  it("ignores a branch grant written under the wrong organization", () => {
    // Branch 31 belongs to org 3; a row claiming it for managed org 1 reaches nothing.
    const reach = resolveDeskReach(input({ assignments: [{ organizationId: 1, branchId: 31 }] }), "manage")
    expect(reach).toEqual({ organizationIds: [], branchIds: [] })
  })

  it.each([
    ["no account", null],
    ["another role", { role: "HEAD_OFFICE", isActive: true, deleted: false }],
    ["an inactive account", { ...ACTIVE_DESK, isActive: false }],
    ["a deleted account", { ...ACTIVE_DESK, deleted: true }],
  ])("gives %s nothing", (_label, account) => {
    const reach = resolveDeskReach(input({ account, assignments: [{ organizationId: 1, branchId: null }] }), "order")
    expect(reach).toEqual({ organizationIds: [], branchIds: [] })
  })

  it("is empty — never everything — without assignments", () => {
    expect(resolveDeskReach(input(), "manage")).toEqual({ organizationIds: [], branchIds: [] })
  })

  it("unions whole and single grants across organizations", () => {
    const reach = resolveDeskReach(input({
      assignments: [{ organizationId: 1, branchId: null }, { organizationId: 2, branchId: 21 }],
    }), "order")
    expect(reach).toEqual({ organizationIds: [1, 2], branchIds: [11, 12, 21] })
  })
})

describe("the desk's API allowlist", () => {
  it.each([
    ["POST", "/api/v1/orders"],
    ["post", "/api/v1/orders/"],
    ["GET", "/api/v1/order-desk/targets"],
    ["GET", "/api/v1/order-desk/catalogue"],
    ["GET", "/api/v1/order-desk/orders"],
    ["PUT", "/api/v1/order-desk/orders/7"],
    ["POST", "/api/v1/order-desk/orders/7/fulfil"],
    ["POST", "/api/v1/order-desk/orders/7/cancel"],
    ["GET", "/api/v1/order-desk/orders/7/attachment"],
    ["POST", "/api/v1/upload/image"],
    ["GET", "/api/v1/orders/7/refunds"],
    ["POST", "/api/v1/orders/7/refunds"],
    ["POST", "/api/v1/users/me/change-password"],
    // The profile menu's "Forgot password" link, used while signed in.
    ["POST", "/api/v1/auth/password-reset/request"],
    ["POST", "/api/v1/auth/password-reset/verify"],
    ["POST", "/api/v1/auth/password-reset/complete"],
  ])("admits %s %s", (method, path) => {
    expect(isOrderDeskApiRequestAllowed(method, path)).toBe(true)
  })

  it.each([
    ["GET", "/api/v1/orders"],
    ["PATCH", "/api/v1/orders/7"],
    ["POST", "/api/v1/orders/7/fulfill"],
    ["POST", "/api/v1/order-desk/orders/7/fulfil/x"],
    ["POST", "/api/v1/order-desk/orders/-7/fulfil"],
    ["GET", "/api/v1/order-desk/team"],
    ["PUT", "/api/v1/order-desk/team/x/assignments"],
    ["GET", "/api/v1/users/me"],
    ["GET", "/api/v1/branch/inventory"],
    ["GET", "/api/v1/order-desk/targetsx"],
    ["GET", "/api/v1/order-desk/targets/../team"],
    // Delivery is Super Admin's to record.
    ["POST", "/api/v1/order-desk/orders/7/delivery"],
    ["POST", "/api/v1/orders/7/fulfillment-status"],
    ["DELETE", "/api/v1/order-desk/orders/7"],
    ["PATCH", "/api/v1/orders/7/refunds"],
    ["POST", "/api/v1/admin/refunds"],
    ["GET", "/api/v1/images/products/abc.png"],
    ["GET", "/api/v1/upload/image"],
    ["GET", "/api/v1/auth/password-reset/request"],
    ["POST", "/api/v1/auth/password-reset/requestx"],
    ["POST", "/api/v1/auth/password-reset"],
  ])("refuses %s %s", (method, path) => {
    expect(isOrderDeskApiRequestAllowed(method, path)).toBe(false)
  })

  it("names only handlers that exist and admit the desk themselves", () => {
    for (const rule of ORDER_DESK_API_RULES) {
      expect(existsSync(resolve(process.cwd(), rule.route)), rule.route).toBe(true)
      const source = read(rule.route)
      if (rule.route.startsWith("app/api/v1/order-desk/")) {
        expect(source, rule.route).toContain('requireApiRole(["ORDER_DESK"])')
      } else if (rule.route === "app/api/v1/orders/route.ts") {
        expect(source).toContain("if (!mayCreateOrder(role))")
        expect(read("lib/order-creation-access.ts")).toContain('"ORDER_DESK"')
      } else if (rule.route === "app/api/v1/upload/image/route.ts") {
        // Admitted, and diverted to the private store before any catalogue path.
        expect(source).toContain("!isOrderDeskRole(userRole)")
        expect(source).toContain("return storeOrderIntakeAttachment(")
      } else if (rule.route === "app/api/v1/orders/[id]/refunds/route.ts") {
        // Admitted for its own orders only, through its live reach.
        expect(source).toMatch(/if \(isOrderDeskRole\(userRole\)\) \{\s*return deskOrderInReach/)
        expect(source).toContain("isOrderDeskRole(userRole) && Boolean(await loadDeskOrder(db, userId, orderId))")
      } else if (rule.route.startsWith("app/api/v1/auth/password-reset/")) {
        // Public: they read no session at all, so admitting the desk grants nothing.
        expect(source, rule.route).not.toMatch(/getServerSession|getCurrentUser|getRequestScope|requireApiRole/)
      } else {
        // The change-password endpoints every signed-in account may reach.
        expect(rule.route).toMatch(/^app\/api\/v1\/users\/me\//)
      }
    }
  })

  it("never names a route that writes a price, a user, a tenant or a budget", () => {
    for (const rule of ORDER_DESK_API_RULES) {
      expect(rule.route).not.toMatch(/price|organizations|budget|groups|users\/route|users\/\[id\]|team|admin/)
    }
  })

  it("covers every desk handler, and keeps Super Admin's team routes off it", () => {
    const root = resolve(process.cwd(), "app/api/v1/order-desk")
    const found: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (entry === "route.ts") found.push(relative(process.cwd(), path).split("\\").join("/"))
      }
    }
    walk(root)
    const listed = new Set(ORDER_DESK_API_RULES.map((rule) => rule.route))
    for (const route of found) {
      if (route.includes("/team/") || route.endsWith("/team/route.ts")) {
        expect(listed.has(route), route).toBe(false)
        expect(read(route), route).toContain('requireApiRole(["SUPER_ADMIN"])')
      } else {
        expect(listed.has(route), `${route} is a desk handler missing from ORDER_DESK_API_RULES`).toBe(true)
      }
    }
  })
})

describe("orders the desk enters", () => {
  it("waits for an Apricart Executive only for the desk's own entries", () => {
    // Reversed 2026-10-07 (plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md):
    // a desk order no longer skips approval; it always waits for an executive.
    expect(orderDeskRequiresExecutiveApproval("ORDER_DESK")).toBe(true)
    for (const role of ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "EMPLOYEE", "APRICART_EXECUTIVE", undefined]) {
      expect(orderDeskRequiresExecutiveApproval(role)).toBe(false)
    }
  })

  it("requires the desk to say where an order came from, with the customer's screenshot", () => {
    const key = "order-intake/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.png"
    expect(orderIntakeError("ORDER_DESK", { intakeChannel: "EMAIL", intakeReference: "subject", intakeAttachmentKey: key })).toBeNull()
    expect(orderIntakeError("ORDER_DESK", { intakeReference: "subject", intakeAttachmentKey: key })).toMatch(/intakeChannel/)
    expect(orderIntakeError("ORDER_DESK", { intakeChannel: "EMAIL", intakeReference: "   ", intakeAttachmentKey: key })).toMatch(/intakeReference/)
    expect(orderIntakeError("ORDER_DESK", { intakeChannel: "EMAIL", intakeReference: "subject" })).toMatch(/screenshot/)
    expect(orderIntakeError("ORDER_DESK", { intakeChannel: "EMAIL", intakeReference: "subject", intakeAttachmentKey: null })).toMatch(/screenshot/)
  })

  it("shows the screenshot to an order's readers only on a desk order holding a well-formed key", () => {
    const key = "order-intake/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.png"
    expect(hasDeskIntakeScreenshot({ createdByRole: "ORDER_DESK", intakeAttachmentKey: key })).toBe(true)
    expect(hasDeskIntakeScreenshot({ createdByRole: "ORDER_DESK", intakeAttachmentKey: null })).toBe(false)
    expect(hasDeskIntakeScreenshot({ createdByRole: "ORDER_DESK" })).toBe(false)
    expect(hasDeskIntakeScreenshot({ createdByRole: "ORDER_DESK", intakeAttachmentKey: "products/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.png" })).toBe(false)
    for (const createdByRole of ["ORDER_PORTAL", "HEAD_OFFICE", "SUPER_ADMIN", null, undefined]) {
      expect(hasDeskIntakeScreenshot({ createdByRole, intakeAttachmentKey: key }), String(createdByRole)).toBe(false)
    }
  })

  it("accepts a screenshot key only in the shape the upload route generates", () => {
    const key = "order-intake/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.png"
    expect(isOrderIntakeAttachmentKey(key)).toBe(true)
    expect(orderIntakeError("ORDER_DESK", { intakeChannel: "EMAIL", intakeReference: "x", intakeAttachmentKey: key })).toBeNull()
    for (const bad of [
      "products/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.png",
      "support/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.png",
      "order-intake/../products/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.png",
      "order-intake/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.svg",
      "/api/v1/images/order-intake/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.png",
      "data:image/png;base64,AAAA",
      "",
    ]) {
      expect(isOrderIntakeAttachmentKey(bad), bad).toBe(false)
      expect(orderIntakeError("ORDER_DESK", { intakeChannel: "EMAIL", intakeReference: "x", intakeAttachmentKey: bad })).toMatch(/screenshot/)
    }
    expect(orderIntakeError("ORDER_PORTAL", { intakeAttachmentKey: key })).toMatch(/only to Order Desk/)
  })

  it("refuses intake details on anyone else's order", () => {
    expect(orderIntakeError("ORDER_PORTAL", {})).toBeNull()
    expect(orderIntakeError("ORDER_PORTAL", { intakeChannel: "EMAIL" })).toMatch(/only to Order Desk/)
    expect(orderIntakeError("SUPER_ADMIN", { intakeReference: "x" })).toMatch(/only to Order Desk/)
  })

  const none = { canEdit: false, canCancel: false, canResubmit: false, canFulfil: false, canRequestRefund: false }
  const NOW = new Date("2026-10-06T12:00:00.000Z")
  const DAY = 24 * 60 * 60 * 1000
  const recently = new Date(NOW.getTime() - DAY)

  it("lets a pending order be edited or cancelled while it waits for an executive", () => {
    expect(deskOrderActions({ status: "PENDING", fulfillmentStatus: null, fulfilledAt: null }, NOW))
      .toEqual({ ...none, canEdit: true, canCancel: true })
    expect(deskOrderActions({ status: "pending", fulfillmentStatus: "NOT_STARTED", fulfilledAt: null, returnedForCorrectionAt: null }, NOW))
      .toEqual({ ...none, canEdit: true, canCancel: true })
  })

  it("adds Resubmit once an executive returns it for correction", () => {
    expect(deskOrderActions({
      status: "PENDING",
      fulfillmentStatus: null,
      fulfilledAt: null,
      returnedForCorrectionAt: "2026-10-06T09:00:00.000Z",
    }, NOW)).toEqual({ ...none, canEdit: true, canCancel: true, canResubmit: true })
  })

  it("lets an Active order be cancelled, never edited, until processing starts", () => {
    // An edit after approval would change what the executive approved.
    for (const fulfillmentStatus of [null, "NOT_STARTED"]) {
      expect(deskOrderActions({ status: "APPROVED", fulfillmentStatus, fulfilledAt: null }, NOW))
        .toEqual({ ...none, canCancel: true })
    }
  })

  it("offers nothing on an Active order in process or out for delivery: its tax invoice is issued", () => {
    // plans/OF-INVOICE-issue-at-processing.md — reversed by a refund's credit note, not a cancel.
    for (const fulfillmentStatus of ["IN_PROCESS", "OUT_FOR_DELIVERY"]) {
      expect(deskOrderActions({ status: "APPROVED", fulfillmentStatus, fulfilledAt: null }, NOW)).toEqual(none)
    }
  })

  it("fulfils only once delivered, and then nothing but fulfilment", () => {
    expect(deskOrderActions({ status: "approved", fulfillmentStatus: "DELIVERED", fulfilledAt: null }, NOW))
      .toEqual({ ...none, canFulfil: true })
  })

  it("offers a refund request only on a fulfilled, delivered order", () => {
    expect(deskOrderActions({ status: "FULFILLED", fulfillmentStatus: "DELIVERED", fulfilledAt: recently }, NOW))
      .toEqual({ ...none, canRequestRefund: true })
    expect(deskOrderActions({ status: "FULFILLED", fulfillmentStatus: "IN_PROCESS", fulfilledAt: recently }, NOW)).toEqual(none)
  })

  it("stops offering a refund request seven days after fulfilment", () => {
    const fulfilled = { status: "FULFILLED", fulfillmentStatus: "DELIVERED" }
    expect(deskOrderActions({ ...fulfilled, fulfilledAt: new Date(NOW.getTime() - 7 * DAY) }, NOW).canRequestRefund).toBe(true)
    expect(deskOrderActions({ ...fulfilled, fulfilledAt: new Date(NOW.getTime() - 7 * DAY - 1) }, NOW).canRequestRefund).toBe(false)
    expect(deskOrderActions({ ...fulfilled, fulfilledAt: null }, NOW).canRequestRefund).toBe(false)
  })

  it.each(["CANCELLED", "REJECTED", "REFUNDED"])("offers nothing on a %s order", (status) => {
    expect(deskOrderActions({ status, fulfillmentStatus: "DELIVERED", fulfilledAt: recently }, NOW)).toEqual(none)
    expect(deskOrderActions({ status, fulfillmentStatus: null, fulfilledAt: null }, NOW)).toEqual(none)
  })
})

describe("desk accounts", () => {
  it("are Super Admin's alone to manage", () => {
    expect(canManageOrderDesk("SUPER_ADMIN")).toBe(true)
    for (const role of ["HEAD_OFFICE", "ORDER_DESK", "BRANCH_ADMIN", null]) {
      expect(canManageOrderDesk(role)).toBe(false)
    }
  })

  it("belong to no organization and no branch", () => {
    expect(orderDeskUserShapeError(null, null)).toBeNull()
    expect(orderDeskUserShapeError(5, null)).not.toBeNull()
    expect(orderDeskUserShapeError(null, 9)).not.toBeNull()
  })

  it("accept activation and MFA changes only", () => {
    expect(orderDeskAccessChangeError("ORDER_DESK", { role: "ORDER_DESK" })).toBeNull()
    expect(orderDeskAccessChangeError("ORDER_DESK", {})).toBeNull()
    expect(orderDeskAccessChangeError("ORDER_DESK", { role: "HEAD_OFFICE" })).toMatch(/switched/)
    expect(orderDeskAccessChangeError("BRANCH_ADMIN", { role: "ORDER_DESK" })).toMatch(/switched/)
    expect(orderDeskAccessChangeError("ORDER_DESK", { organizationId: 3 })).toMatch(/Desk team/)
    expect(orderDeskAccessChangeError("ORDER_DESK", { organizationId: null })).toMatch(/Desk team/)
    expect(orderDeskAccessChangeError("ORDER_DESK", { branchIds: [] })).toMatch(/Desk team/)
  })

  it("leave every other role's access changes to the existing rules", () => {
    expect(orderDeskAccessChangeError("BRANCH_ADMIN", { role: "ORDER_PORTAL", organizationId: 3 })).toBeNull()
    expect(isOrderDeskRole("BRANCH_ADMIN")).toBe(false)
  })
})
