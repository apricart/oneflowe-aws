import { describe, expect, it } from "vitest"

import {
  DESK_ORDER_PAGE_MAX,
  DESK_ORDER_PAGE_SIZE_DEFAULT,
  DESK_ORDER_PAGE_SIZE_MAX,
  DESK_ORDER_SEARCH_MAX_LENGTH,
  deskOrderStage,
  deskOrderStatusSelection,
  parseDeskOrderListQuery,
} from "./order-desk-query"

const parse = (query: string) => parseDeskOrderListQuery(new URLSearchParams(query))

describe("the desk's order list query", () => {
  it("opens on the orders waiting for an executive's approval, first page", () => {
    expect(parse("")).toEqual({
      ok: true,
      value: {
        organizationId: null,
        branchId: null,
        status: "awaiting_approval",
        paymentStatus: null,
        search: "",
        page: 1,
        limit: DESK_ORDER_PAGE_SIZE_DEFAULT,
      },
    })
  })

  it("reads the filters it allows", () => {
    expect(parse("organizationId=4&branchId=9&status=READY_TO_FULFIL&paymentStatus=paid&q=%20Ali%20&page=3&limit=10")).toEqual({
      ok: true,
      value: { organizationId: 4, branchId: 9, status: "ready_to_fulfil", paymentStatus: "PAID", search: "Ali", page: 3, limit: 10 },
    })
  })

  it("bounds the page and its size", () => {
    const result = parse(`page=${DESK_ORDER_PAGE_MAX + 5}&limit=100000`)
    expect(result.ok && result.value.page).toBe(DESK_ORDER_PAGE_MAX)
    expect(result.ok && result.value.limit).toBe(DESK_ORDER_PAGE_SIZE_MAX)
    const low = parse("page=-1&limit=0")
    expect(low.ok && [low.value.page, low.value.limit]).toEqual([1, DESK_ORDER_PAGE_SIZE_DEFAULT])
  })

  it.each([
    "organizationId=abc",
    "organizationId=0",
    "branchId=1.5",
    "branchId=-2",
    "status=pending",
    "status=active",
    "status=all;DROP",
    "paymentStatus=settled",
    `q=${"x".repeat(DESK_ORDER_SEARCH_MAX_LENGTH + 1)}`,
  ])("refuses %s", (query) => {
    expect(parse(query).ok).toBe(false)
  })

  it("maps each tab to the statuses and delivery state it selects", () => {
    // A returned order is still PENDING: it stays on Awaiting approval, flagged.
    expect(deskOrderStatusSelection("awaiting_approval")).toEqual({ statuses: ["PENDING"], delivered: null })
    expect(deskOrderStatusSelection("awaiting_delivery")).toEqual({ statuses: ["APPROVED"], delivered: false })
    expect(deskOrderStatusSelection("ready_to_fulfil")).toEqual({ statuses: ["APPROVED"], delivered: true })
    expect(deskOrderStatusSelection("fulfilled")).toEqual({ statuses: ["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED", "REFUNDED"], delivered: null })
    expect(deskOrderStatusSelection("rejected")).toEqual({ statuses: ["REJECTED"], delivered: null })
    expect(deskOrderStatusSelection("cancelled")).toEqual({ statuses: ["CANCELLED"], delivered: null })
    expect(deskOrderStatusSelection("all")).toEqual({ statuses: null, delivered: null })
  })
})

describe("where an order stands", () => {
  it.each([
    ["APPROVED", null, "awaiting_delivery"],
    ["approved", "OUT_FOR_DELIVERY", "awaiting_delivery"],
    ["APPROVED", "DELIVERED", "ready_to_fulfil"],
    ["FULFILLED", "DELIVERED", "fulfilled"],
    ["PARTIALLY_FULFILLED", "DELIVERED", "fulfilled"],
    ["CANCELLED", null, "cancelled"],
    // Every desk order starts PENDING, waiting for an Apricart Executive.
    ["PENDING", null, "awaiting_approval"],
    ["pending", "NOT_STARTED", "awaiting_approval"],
    // Fully refunded after fulfilment: still on the Fulfilled tab, never lost to "All".
    ["REFUNDED", "DELIVERED", "fulfilled"],
    ["refunded", "DELIVERED", "fulfilled"],
    ["REJECTED", null, "rejected"],
    ["ON_HOLD", null, "other"],
  ])("%s / %s is %s", (status, fulfillmentStatus, stage) => {
    expect(deskOrderStage({ status, fulfillmentStatus })).toBe(stage)
  })

  it("puts every order on exactly the tab whose selection it matches", () => {
    for (const [status, fulfillmentStatus] of [["APPROVED", null], ["APPROVED", "DELIVERED"], ["FULFILLED", "DELIVERED"], ["REFUNDED", "DELIVERED"], ["CANCELLED", null]] as const) {
      const stage = deskOrderStage({ status, fulfillmentStatus })
      if (stage === "other") continue
      const selection = deskOrderStatusSelection(stage)
      expect(selection.statuses).toContain(status)
      if (selection.delivered !== null) expect(selection.delivered).toBe(fulfillmentStatus === "DELIVERED")
    }
  })
})
