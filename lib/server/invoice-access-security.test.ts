import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it } from "vitest"
import { resolveInvoiceAccess } from "@/lib/invoice-access-policy"

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const INVOICE_ROUTES = [
  "app/api/v1/receipts/[orderId]/route.ts",
  "app/api/v1/receipts/[orderId]/download/route.ts",
]

const OWNER = "user-owner"
const OTHER_USER = "user-other"

type ScopeOverrides = Partial<{
  userId: string
  organizationId: number | null
  branchId: number | null
  scopedBranchIds: number[] | null
}>

function scope(overrides: ScopeOverrides = {}) {
  return { userId: OWNER, organizationId: 10, branchId: 100, ...overrides }
}

/** A group role reaches branches through its assignments, not a pinned branch. */
function assignedScope(branchIds: number[], overrides: ScopeOverrides = {}) {
  return scope({ branchId: null, scopedBranchIds: branchIds, ...overrides })
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 10,
    branchId: 100,
    createdByUserId: OWNER,
    status: "FULFILLED",
    statusAtRefund: null,
    receiptData: { invoiceNumber: "INV-1" },
    ...overrides,
  } as any
}

describe("invoice access policy", () => {
  it("lets an employee open the invoice of an order they placed", () => {
    expect(resolveInvoiceAccess({ role: "ORDER_PORTAL", scope: scope(), order: order() })).toBeNull()
  })

  it.each([
    ["SUPER_ADMIN", scope({ organizationId: null, branchId: null }), order()],
    ["SUPER_ADMIN", scope({ organizationId: null, branchId: null }), order({ organizationId: 99, branchId: 999 })],
    ["HEAD_OFFICE", scope({ branchId: null }), order({ branchId: 777, createdByUserId: OTHER_USER })],
    ["BRANCH_ADMIN", scope(), order({ createdByUserId: OTHER_USER })],
  ])("keeps invoice access for %s", (role, requester, subject) => {
    expect(resolveInvoiceAccess({ role, scope: requester, order: subject })).toBeNull()
  })

  it("hides another employee's invoice from the employee store role", () => {
    const denial = resolveInvoiceAccess({
      role: "ORDER_PORTAL",
      scope: scope(),
      order: order({ createdByUserId: OTHER_USER }),
    })

    expect(denial?.status).toBe(403)
  })

  it.each([
    ["ORDER_PORTAL", order({ organizationId: 99, branchId: 100 })],
    ["BRANCH_ADMIN", order({ organizationId: 99, branchId: 100 })],
    ["HEAD_OFFICE", order({ organizationId: 99, branchId: 100 })],
  ])("blocks %s from an order belonging to another organization", (role, subject) => {
    const denial = resolveInvoiceAccess({ role, scope: scope(), order: subject })

    expect(denial?.status).toBe(403)
  })

  it.each([
    ["a requester without an organization", scope({ organizationId: null }), order()],
    ["an order without an organization", scope(), order({ organizationId: null })],
    ["a requester without a branch", scope({ branchId: null }), order()],
  ])("fails closed for %s", (_case, requester, subject) => {
    const denial = resolveInvoiceAccess({ role: "BRANCH_ADMIN", scope: requester, order: subject })

    expect(denial?.status).toBe(403)
  })

  it.each([["ORDER_PORTAL"], ["BRANCH_ADMIN"]])(
    "keeps %s out of another branch in the same organization",
    (role) => {
      const denial = resolveInvoiceAccess({
        role,
        scope: scope(),
        order: order({ branchId: 200 }),
      })

      expect(denial?.status).toBe(403)
    },
  )

  it("lets the approver open an invoice from any branch it is assigned", () => {
    expect(
      resolveInvoiceAccess({
        role: "GROUP_USER",
        scope: assignedScope([100, 200]),
        order: order({ branchId: 200, createdByUserId: OTHER_USER }),
      }),
    ).toBeNull()
  })

  it.each([
    ["a branch outside its assignments", assignedScope([100, 200]), order({ branchId: 300 })],
    ["no assignments at all", assignedScope([]), order()],
    ["a missing assignment set", scope({ scopedBranchIds: null }), order()],
  ])("keeps the approver out of %s", (_case, requester, subject) => {
    const denial = resolveInvoiceAccess({ role: "GROUP_USER", scope: requester, order: subject })

    expect(denial?.status).toBe(403)
  })

  it("lets the group requester open the invoice of an order it raised in any branch", () => {
    expect(
      resolveInvoiceAccess({
        role: "GROUP_ORDER_PORTAL",
        scope: scope({ branchId: null }),
        order: order({ branchId: 900 }),
      }),
    ).toBeNull()
  })

  it("hides another requester's group order from the group requester", () => {
    const denial = resolveInvoiceAccess({
      role: "GROUP_ORDER_PORTAL",
      scope: scope({ branchId: null }),
      order: order({ branchId: 900, createdByUserId: OTHER_USER }),
    })

    expect(denial?.status).toBe(403)
  })

  it.each([
    ["GROUP_USER", assignedScope([100])],
    ["GROUP_ORDER_PORTAL", scope({ branchId: null })],
  ])("blocks %s from another organization", (role, requester) => {
    const denial = resolveInvoiceAccess({
      role,
      scope: requester,
      order: order({ organizationId: 99 }),
    })

    expect(denial?.status).toBe(403)
  })

  it.each([
    ["GROUP_USER", assignedScope([100])],
    ["GROUP_ORDER_PORTAL", scope({ branchId: null })],
  ])("applies the same approval gate to %s", (role, requester) => {
    const denial = resolveInvoiceAccess({
      role,
      scope: requester,
      order: order({ status: "PENDING" }),
    })

    expect(denial?.status).toBe(409)
  })

  it.each([
    ["no session", null, "BRANCH_ADMIN"],
    ["an unknown role", scope(), "ANYTHING_ELSE"],
    ["a missing role", scope(), undefined],
  ])("rejects %s", (_case, requester, role) => {
    const denial = resolveInvoiceAccess({ role, scope: requester, order: order() })

    expect(denial?.status).toBe(401)
  })

  it("reports a missing order as not found", () => {
    const denial = resolveInvoiceAccess({ role: "BRANCH_ADMIN", scope: scope(), order: null })

    expect(denial?.status).toBe(404)
  })

  it("does not leak an order's existence to another organization", () => {
    const denial = resolveInvoiceAccess({
      role: "BRANCH_ADMIN",
      scope: scope(),
      order: order({ organizationId: 99, status: "PENDING" }),
    })

    expect(denial?.status).toBe(403)
  })

  it("withholds the invoice until the order is approved", () => {
    const denial = resolveInvoiceAccess({
      role: "BRANCH_ADMIN",
      scope: scope(),
      order: order({ status: "PENDING" }),
    })

    expect(denial?.status).toBe(409)
    expect(denial?.error).toContain("after the order is approved")
  })

  it("keeps the invoice available after a refund of an approved order", () => {
    expect(
      resolveInvoiceAccess({
        role: "BRANCH_ADMIN",
        scope: scope(),
        order: order({ status: "REFUNDED", statusAtRefund: "APPROVED" }),
      }),
    ).toBeNull()
  })

  it("reports a missing invoice snapshot as not found", () => {
    const denial = resolveInvoiceAccess({
      role: "BRANCH_ADMIN",
      scope: scope(),
      order: order({ receiptData: null }),
    })

    expect(denial?.status).toBe(404)
  })
})

describe("invoice endpoint wiring", () => {
  it("authorizes both invoice endpoints through the shared policy alone", () => {
    for (const route of INVOICE_ROUTES) {
      const routeSource = source(route)
      expect(routeSource).toContain("authorizeInvoiceRequest")
      expect(routeSource).not.toContain("verifyResourceAccess")
    }
  })

  it("includes initiator and approver in both invoice formats", () => {
    const preview = source("components/receipts/receipt-content.tsx")
    const download = source("app/api/v1/receipts/[orderId]/download/route.ts")

    for (const invoiceFormat of [preview, download]) {
      expect(invoiceFormat).toContain("Initiator:")
      expect(invoiceFormat).toContain("Approver:")
      expect(invoiceFormat).toContain("approvedByName")
    }
  })
})
