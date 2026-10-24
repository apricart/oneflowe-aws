import { describe, expect, it } from "vitest"

import {
  NO_UNPAID_INVOICE_ALERTS,
  UNPAID_INVOICE_ALERT_ROLES,
  alertsAcrossAssignedBranches,
  hasReachedUnpaidInvoiceLimit,
  isLastOrderBeforeBlock,
  parseUnpaidInvoiceAlertsView,
  receivesUnpaidInvoiceAlerts,
  unpaidInvoiceAlertsFor,
  unpaidInvoiceAlertsOf,
  type BranchUnpaidInvoices,
  type UnpaidInvoiceAlertsView,
} from "@/lib/unpaid-invoice-alerts"

const north: BranchUnpaidInvoices = { branchId: 7, branchName: "North", unpaidInvoiceCount: 3, threshold: 4 }
const south: BranchUnpaidInvoices = { branchId: 9, branchName: "South", unpaidInvoiceCount: 3, threshold: 4 }
const northBlocked: BranchUnpaidInvoices = { ...north, unpaidInvoiceCount: 4 }
const southBlocked: BranchUnpaidInvoices = { ...south, unpaidInvoiceCount: 5 }

const view = (overrides: Partial<UnpaidInvoiceAlertsView>): UnpaidInvoiceAlertsView => ({ ...NO_UNPAID_INVOICE_ALERTS, ...overrides })

describe("the two states", () => {
  it.each([
    [3, 4, true],
    [1, 2, true],
    [99, 100, true],
    [2, 4, false],
    [4, 4, false],
    [5, 4, false],
    [0, 1, false],
    [0, 2, false],
  ])("last order: %i unpaid against a limit of %i → %s", (count, threshold, expected) => {
    expect(isLastOrderBeforeBlock(count, threshold)).toBe(expected)
  })

  it.each([
    [4, 4, true],
    [5, 4, true],
    [1, 1, true],
    [3, 4, false],
    [0, 1, false],
    [0, 2, false],
  ])("limit reached: %i unpaid against a limit of %i → %s", (count, threshold, expected) => {
    expect(hasReachedUnpaidInvoiceLimit(count, threshold)).toBe(expected)
  })

  it("never warns of a last order on a limit of 1 — the first unpaid invoice blocks", () => {
    for (let count = 0; count <= 3; count += 1) expect(isLastOrderBeforeBlock(count, 1)).toBe(false)
  })

  it("refuses non-integers and a limit below 1", () => {
    expect(isLastOrderBeforeBlock(2.5, 3.5)).toBe(false)
    expect(hasReachedUnpaidInvoiceLimit(Number.NaN, 2)).toBe(false)
    expect(hasReachedUnpaidInvoiceLimit(3, 0)).toBe(false)
  })
})

describe("who is alerted", () => {
  it("the two initiator roles and the two approver roles, nobody else", () => {
    expect([...UNPAID_INVOICE_ALERT_ROLES].sort()).toEqual(["BRANCH_ADMIN", "GROUP_ORDER_PORTAL", "GROUP_USER", "ORDER_PORTAL"])
    for (const role of ["SUPER_ADMIN", "HEAD_OFFICE", "VIEWER", "WAREHOUSE", "ORDER_DESK", "APRICART_EXECUTIVE", "APRICART_SUPPORT", "", null, undefined]) {
      expect(receivesUnpaidInvoiceAlerts(role)).toBe(false)
    }
  })

  it("the group roles across their assignments, the others for their own branch", () => {
    expect(alertsAcrossAssignedBranches("GROUP_ORDER_PORTAL")).toBe(true)
    expect(alertsAcrossAssignedBranches("GROUP_USER")).toBe(true)
    expect(alertsAcrossAssignedBranches("ORDER_PORTAL")).toBe(false)
    expect(alertsAcrossAssignedBranches("BRANCH_ADMIN")).toBe(false)
  })
})

describe("unpaidInvoiceAlertsOf", () => {
  const row = (branchId: number, branchName: string, unpaidInvoiceCount: number, exceptionActive = false) =>
    ({ branchId, branchName, unpaidInvoiceCount, exceptionActive })

  it("sorts each branch into blocked, last order, or neither, by name", () => {
    const result = unpaidInvoiceAlertsOf([
      row(1, "Zeta", 4),
      row(2, "Alpha", 6),
      row(3, "Gamma", 3),
      row(4, "Beta", 2),
      row(5, "Delta", 3),
    ], 4)
    expect(result.blocked.map((entry) => entry.branchName)).toEqual(["Alpha", "Zeta"])
    expect(result.lastOrder.map((entry) => entry.branchName)).toEqual(["Delta", "Gamma"])
    expect(result.blocked[0]).toEqual({ branchId: 2, branchName: "Alpha", unpaidInvoiceCount: 6, threshold: 4 })
    expect(result.otherBranchesCanOrder).toBe(true)
    expect(result.otherBranchesUnaffected).toBe(true)
  })

  it("a branch at its limit with a Head Office exception in force is not blocked — it may still order", () => {
    const result = unpaidInvoiceAlertsOf([row(1, "North", 5, true)], 4)
    expect(result.blocked).toEqual([])
    expect(result.lastOrder).toEqual([])
    expect(result.otherBranchesCanOrder).toBe(true)
  })

  it("says whether other branches can order, and whether any is untouched", () => {
    expect(unpaidInvoiceAlertsOf([row(1, "A", 4), row(2, "B", 4)], 4)).toMatchObject({ otherBranchesCanOrder: false, otherBranchesUnaffected: false })
    expect(unpaidInvoiceAlertsOf([row(1, "A", 4), row(2, "B", 3)], 4)).toMatchObject({ otherBranchesCanOrder: true, otherBranchesUnaffected: false })
    expect(unpaidInvoiceAlertsOf([row(1, "A", 3), row(2, "B", 0)], 4)).toMatchObject({ otherBranchesCanOrder: true, otherBranchesUnaffected: true })
  })

  it("answers nothing for an empty scope", () => {
    expect(unpaidInvoiceAlertsOf([], 4)).toEqual(NO_UNPAID_INVOICE_ALERTS)
  })
})

describe("parseUnpaidInvoiceAlertsView", () => {
  it("accepts the route's shape", () => {
    const payload = { blocked: [northBlocked], lastOrder: [south], otherBranchesCanOrder: true, otherBranchesUnaffected: false }
    expect(parseUnpaidInvoiceAlertsView(payload)).toEqual(payload)
  })

  it("treats anything malformed as nothing to say", () => {
    expect(parseUnpaidInvoiceAlertsView(null)).toEqual(NO_UNPAID_INVOICE_ALERTS)
    expect(parseUnpaidInvoiceAlertsView("x")).toEqual(NO_UNPAID_INVOICE_ALERTS)
    expect(parseUnpaidInvoiceAlertsView({ blocked: "x", lastOrder: 1 })).toEqual(NO_UNPAID_INVOICE_ALERTS)
    expect(parseUnpaidInvoiceAlertsView({
      blocked: [north, { ...northBlocked, branchName: "" }, southBlocked],
      lastOrder: [northBlocked, { ...north, branchId: 0 }, { ...north, unpaidInvoiceCount: "3" }, south],
      otherBranchesCanOrder: "yes",
    })).toEqual(view({ blocked: [southBlocked], lastOrder: [south] }))
  })
})

describe("unpaidInvoiceAlertsFor — blocked", () => {
  it("tells an Order Initiator their ordering is blocked and how many invoices are unpaid", () => {
    const [alert, ...rest] = unpaidInvoiceAlertsFor(view({ blocked: [northBlocked] }), "ORDER_PORTAL")
    expect(rest).toEqual([])
    expect(alert).toMatchObject({
      kind: "blocked",
      title: "Your ordering is blocked.",
      body: "You have 4 unpaid invoices. Clear your dues before creating a new order.",
      branches: [],
    })
  })

  it("uses the singular for one unpaid invoice", () => {
    const [alert] = unpaidInvoiceAlertsFor(view({ blocked: [{ ...northBlocked, unpaidInvoiceCount: 1, threshold: 1 }] }), "ORDER_PORTAL")
    expect(alert.body).toBe("You have 1 unpaid invoice. Clear your dues before creating a new order.")
  })

  it("tells a Financial Approver ordering is blocked for their branch", () => {
    const [alert] = unpaidInvoiceAlertsFor(view({ blocked: [northBlocked] }), "BRANCH_ADMIN")
    expect(alert).toMatchObject({
      kind: "blocked",
      title: "Ordering is blocked for your branch.",
      body: "Your branch has 4 unpaid invoices. The dues must be cleared before a new order can be created.",
    })
  })

  it("names the branch for a Group Order Initiator and says the others can still order", () => {
    const [alert] = unpaidInvoiceAlertsFor(view({ blocked: [northBlocked], otherBranchesCanOrder: true }), "GROUP_ORDER_PORTAL")
    expect(alert).toMatchObject({
      title: "Your ordering is blocked for North.",
      body: "North has 4 unpaid invoices. Clear its dues before creating a new order for this branch. You can continue ordering for your other branches.",
      branches: [],
    })
  })

  it("names the branch for a Group Financial Approver", () => {
    const [alert] = unpaidInvoiceAlertsFor(view({ blocked: [northBlocked], otherBranchesCanOrder: true }), "GROUP_USER")
    expect(alert.title).toBe("Ordering is blocked for North.")
    expect(alert.body).toBe("North has 4 unpaid invoices. Its dues must be cleared before a new order can be created for this branch. Your other branches can still order.")
  })

  it("does not mention other branches when none can order", () => {
    const [alert] = unpaidInvoiceAlertsFor(view({ blocked: [northBlocked] }), "GROUP_ORDER_PORTAL")
    expect(alert.body).not.toContain("other branches")
  })

  it("lists every blocked branch with its count", () => {
    const [alert] = unpaidInvoiceAlertsFor(view({ blocked: [northBlocked, southBlocked], otherBranchesCanOrder: true }), "GROUP_ORDER_PORTAL")
    expect(alert).toMatchObject({
      title: "Your ordering is blocked for these branches:",
      body: "Clear each branch's dues before creating a new order for it. You can continue ordering for your other branches.",
      branches: [
        { branchId: 7, name: "North", detail: "4 unpaid invoices" },
        { branchId: 9, name: "South", detail: "5 unpaid invoices" },
      ],
    })
    expect(unpaidInvoiceAlertsFor(view({ blocked: [northBlocked, southBlocked] }), "GROUP_USER")[0].title).toBe("Ordering is blocked for these branches:")
  })
})

describe("unpaidInvoiceAlertsFor — last order", () => {
  it("says nothing without a branch to report, or to a role that is not alerted", () => {
    expect(unpaidInvoiceAlertsFor(view({}), "ORDER_PORTAL")).toEqual([])
    expect(unpaidInvoiceAlertsFor(null, "ORDER_PORTAL")).toEqual([])
    expect(unpaidInvoiceAlertsFor(view({ lastOrder: [north], blocked: [southBlocked] }), "HEAD_OFFICE")).toEqual([])
  })

  it("tells an Order Initiator they can place one more order", () => {
    const [alert] = unpaidInvoiceAlertsFor(view({ lastOrder: [north] }), "ORDER_PORTAL")
    expect(alert).toMatchObject({
      kind: "lastOrder",
      title: "You can place only one more order.",
      body: "Your branch has 3 unpaid invoices and ordering stops at 4. After your next order, if your invoices are still unpaid, ordering will be blocked until you clear your dues.",
    })
  })

  it("tells a Financial Approver their branch can place one more order", () => {
    const [alert] = unpaidInvoiceAlertsFor(view({ lastOrder: [north] }), "BRANCH_ADMIN")
    expect(alert.title).toBe("Your branch can place only one more order.")
    expect(alert.body).toContain("ordering will be blocked for your branch until the dues are cleared.")
  })

  it("names the branch for the group roles, mentioning untouched branches only when there are some", () => {
    const [requesterAlert] = unpaidInvoiceAlertsFor(view({ lastOrder: [north], otherBranchesUnaffected: true }), "GROUP_ORDER_PORTAL")
    expect(requesterAlert.title).toBe("You can place only one more order for North.")
    expect(requesterAlert.body).toBe("North has 3 unpaid invoices and ordering stops at 4. After the next order, if its invoices are still unpaid, ordering will be blocked for this branch until its dues are cleared. You can continue ordering for your other branches.")
    const [approverAlert] = unpaidInvoiceAlertsFor(view({ lastOrder: [north], otherBranchesUnaffected: true }), "GROUP_USER")
    expect(approverAlert.title).toBe("North can place only one more order.")
    expect(approverAlert.body.endsWith(" Your other branches are not affected.")).toBe(true)
    expect(unpaidInvoiceAlertsFor(view({ lastOrder: [north] }), "GROUP_USER")[0].body).not.toContain("other branches")
  })

  it("lists every branch at its last order", () => {
    const [alert] = unpaidInvoiceAlertsFor(view({ lastOrder: [north, south] }), "GROUP_ORDER_PORTAL")
    expect(alert.title).toBe("You can place only one more order for each of these branches:")
    expect(alert.branches).toEqual([
      { branchId: 7, name: "North", detail: "3 unpaid invoices and ordering stops at 4" },
      { branchId: 9, name: "South", detail: "3 unpaid invoices and ordering stops at 4" },
    ])
  })
})

describe("unpaidInvoiceAlertsFor — both", () => {
  it("a group role sees the blocked alert first, then the last-order alert", () => {
    const alerts = unpaidInvoiceAlertsFor(view({ blocked: [northBlocked], lastOrder: [south], otherBranchesCanOrder: true }), "GROUP_ORDER_PORTAL")
    expect(alerts.map((alert) => alert.kind)).toEqual(["blocked", "lastOrder"])
  })

  it("a single-branch role is told only that it is blocked", () => {
    const alerts = unpaidInvoiceAlertsFor(view({ blocked: [northBlocked], lastOrder: [south] }), "ORDER_PORTAL")
    expect(alerts.map((alert) => alert.kind)).toEqual(["blocked"])
  })
})

describe("dismissal keys", () => {
  const keyOf = (overrides: Partial<UnpaidInvoiceAlertsView>, kind: "blocked" | "lastOrder") =>
    unpaidInvoiceAlertsFor(view(overrides), "GROUP_USER").find((alert) => alert.kind === kind)?.dismissalKey

  it("is stable whatever order the branches arrive in", () => {
    expect(keyOf({ lastOrder: [north, south] }, "lastOrder")).toBe(keyOf({ lastOrder: [south, north] }, "lastOrder"))
  })

  it("differs between the two kinds for the same branch", () => {
    expect(keyOf({ blocked: [{ ...north, unpaidInvoiceCount: 3, threshold: 3 }] }, "blocked"))
      .not.toBe(keyOf({ lastOrder: [{ ...north, unpaidInvoiceCount: 3, threshold: 4 }] }, "lastOrder"))
  })

  it("changes when a branch, a count or a limit changes, so a closed alert comes back", () => {
    const base = keyOf({ blocked: [northBlocked] }, "blocked")
    expect(keyOf({ blocked: [northBlocked, southBlocked] }, "blocked")).not.toBe(base)
    expect(keyOf({ blocked: [{ ...northBlocked, unpaidInvoiceCount: 5 }] }, "blocked")).not.toBe(base)
    expect(keyOf({ blocked: [{ ...northBlocked, threshold: 3 }] }, "blocked")).not.toBe(base)
  })
})
