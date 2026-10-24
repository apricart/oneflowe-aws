import { describe, expect, it } from "vitest"

import {
  orderingBlockBranchOf,
  orderingBlockBranchesPage,
  orderingBlockBranchesQuerySchema,
  orderingBlockStandingOf,
  type OrderingBlockBranchFacts,
  type OrderingBlockBranchesQuery,
} from "@/lib/ordering-block-branches"
import { canUseOrderingBlocksPage } from "@/lib/ordering-blocks-access"
import { resolvePaymentControl } from "@/lib/payment-control-policy"

const NOW = new Date("2026-10-23T09:00:00.000Z")
const HOUR = 60 * 60 * 1000

const liveException = (id = 1) => ({
  id,
  startAt: new Date(NOW.getTime() - HOUR),
  expiresAt: new Date(NOW.getTime() + 24 * HOUR),
  revokedAt: null,
  reason: "Cheque in transit",
  grantedByName: "Head Office",
})

const expiredException = (id = 2) => ({
  ...liveException(id),
  startAt: new Date(NOW.getTime() - 40 * 24 * HOUR),
  expiresAt: new Date(NOW.getTime() - HOUR),
})

const branch = (branchId: number, unpaidInvoiceCount: number, overrides: Partial<OrderingBlockBranchFacts> = {}): OrderingBlockBranchFacts => ({
  branchId,
  branchName: `Branch ${branchId}`,
  branchCode: `B-${branchId}`,
  unpaidInvoiceCount,
  exception: null,
  ...overrides,
})

const query = (overrides: Partial<OrderingBlockBranchesQuery> = {}): OrderingBlockBranchesQuery =>
  orderingBlockBranchesQuerySchema.parse(overrides)

describe("who may open the page", () => {
  it("is Head Office alone", () => {
    expect(canUseOrderingBlocksPage("HEAD_OFFICE")).toBe(true)
    for (const role of ["SUPER_ADMIN", "VIEWER", "BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL", "GROUP_ORDER_PORTAL", "WAREHOUSE", undefined, null, 1]) {
      expect(canUseOrderingBlocksPage(role)).toBe(false)
    }
  })
})

describe("a branch's standing", () => {
  it.each([
    [0, 3, false, "CLEAR"],
    [1, 3, false, "UNPAID"],
    [2, 3, false, "LAST_ORDER"],
    [3, 3, false, "BLOCKED"],
    [7, 3, false, "BLOCKED"],
    [3, 3, true, "EXCEPTION_ACTIVE"],
    [2, 3, true, "LAST_ORDER"],
    [0, 3, true, "CLEAR"],
    [1, 1, false, "BLOCKED"],
    [0, 1, false, "CLEAR"],
  ] as const)("%i unpaid against a limit of %i, exception %s → %s", (unpaidInvoiceCount, threshold, exceptionActive, standing) => {
    expect(orderingBlockStandingOf({ unpaidInvoiceCount, threshold, exceptionActive })).toBe(standing)
  })

  // The page must never say blocked while the gate lets an order through, or the reverse.
  it.each([0, 1, 2, 3, 4, 9])("agrees with the order gate at %i unpaid invoices, with and without an exception", (count) => {
    for (const exception of [null, liveException(), expiredException(), { ...liveException(), revokedAt: new Date(NOW.getTime() - 1) }]) {
      const row = orderingBlockBranchOf(branch(1, count, { exception }), 3, NOW)
      const gate = resolvePaymentControl({
        overdue: { configured: true, overdueCount: count, items: [] },
        exception: exception ? { ...exception, grantedByUserId: "u" } : null,
        now: NOW,
        threshold: 3,
      })
      expect(row.orderingAllowed).toBe(gate.orderingAllowed)
      expect(row.exception?.active ?? false).toBe(gate.exceptionActive)
    }
  })

  it("an exception stops at its expiry instant", () => {
    const exception = { ...liveException(), expiresAt: NOW }
    expect(orderingBlockBranchOf(branch(1, 3, { exception }), 3, NOW)).toMatchObject({ standing: "BLOCKED", orderingAllowed: false, exception: { active: false } })
  })

  it("shows the latest exception with ISO dates, the granter and the reason", () => {
    expect(orderingBlockBranchOf(branch(1, 3, { exception: liveException(7) }), 3, NOW).exception).toEqual({
      id: 7,
      startAt: new Date(NOW.getTime() - HOUR).toISOString(),
      expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
      revokedAt: null,
      active: true,
      grantedByName: "Head Office",
      reason: "Cheque in transit",
    })
  })
})

describe("the query", () => {
  it("defaults to the branches that need attention, first page of 25", () => {
    expect(query()).toEqual({ filter: "attention", page: 1, pageSize: 25 })
  })

  it.each([
    ["an unknown filter", { filter: "everything" }],
    ["page 0", { page: "0" }],
    ["a page size over 100", { pageSize: "101" }],
    ["a fractional page", { page: "1.5" }],
    ["a search over 100 characters", { search: "x".repeat(101) }],
    ["an organization", { organizationId: "2" }],
    ["a branch", { branchId: "5" }],
  ])("refuses %s", (_label, input) => {
    expect(orderingBlockBranchesQuerySchema.safeParse(input).success).toBe(false)
  })

  it("reads numbers from the query string", () => {
    expect(query({ page: "3", pageSize: "10", search: "  north " } as any)).toEqual({ filter: "attention", page: 3, pageSize: 10, search: "north" })
  })
})

describe("a page of branches", () => {
  const facts = [
    branch(1, 0),
    branch(2, 1),
    branch(3, 2),
    branch(4, 3),
    branch(5, 5),
    branch(6, 4, { exception: liveException(1) }),
    branch(7, 0, { exception: liveException(2) }),
    branch(8, 3, { exception: expiredException(3) }),
  ]
  const pageOf = (overrides: Partial<OrderingBlockBranchesQuery> = {}) =>
    orderingBlockBranchesPage(facts, { threshold: 3, now: NOW, query: query(overrides) })
  const ids = (view: ReturnType<typeof pageOf>) => (view.enabled ? view.items.map((row) => row.branchId) : [])

  it("summarises every branch whatever the filter", () => {
    for (const filter of ["attention", "blocked", "exception", "all"] as const) {
      expect(pageOf({ filter, search: "nothing matches" })).toMatchObject({
        enabled: true,
        threshold: 3,
        summary: { branches: 8, blocked: 3, exceptionActive: 2, lastOrder: 1 },
      })
    }
  })

  it("needs attention: blocked, one order left, or on an exception — most urgent first", () => {
    expect(ids(pageOf())).toEqual([5, 4, 8, 6, 3, 7])
  })

  it("blocked: only the branches the gate refuses", () => {
    expect(ids(pageOf({ filter: "blocked" }))).toEqual([5, 4, 8])
  })

  it("on exception: every live exception, including one granted before the limit", () => {
    expect(ids(pageOf({ filter: "exception" }))).toEqual([6, 7])
  })

  it("all: every branch", () => {
    // 1 and 7 are both clear; a tie falls to the name.
    expect(ids(pageOf({ filter: "all" }))).toEqual([5, 4, 8, 6, 3, 2, 1, 7])
  })

  it("searches the name and the code, case-insensitively", () => {
    expect(ids(pageOf({ filter: "all", search: "branch 4" }))).toEqual([4])
    expect(ids(pageOf({ filter: "all", search: "b-6" }))).toEqual([6])
  })

  it("pages the matching rows and reports their total", () => {
    const second = pageOf({ filter: "all", page: 2, pageSize: 3 })
    expect(second).toMatchObject({ total: 8, page: 2, pageSize: 3 })
    expect(ids(second)).toEqual([6, 3, 2])
    expect(ids(pageOf({ filter: "all", page: 3, pageSize: 3 }))).toEqual([1, 7])
    expect(ids(pageOf({ filter: "all", page: 4, pageSize: 3 }))).toEqual([])
  })
})
