import { describe, expect, it } from "vitest"
import {
  SHOP_ORDER_TABS,
  countShopOrdersByTab,
  isShopOrderTab,
  shopOrderTabOf,
} from "./shop-order-tabs"

describe("shopOrderTabOf", () => {
  it.each([
    ["PENDING", "pending"],
    ["APPROVED", "active"],
    ["FULFILLED", "fulfilled"],
    ["PARTIAL", "fulfilled"],
    ["PARTIALLY_FULFILLED", "fulfilled"],
    ["REJECTED", "rejected"],
    ["CANCELLED", "rejected"],
    ["REFUNDED", "refunded"],
  ] as const)("files %s on the %s tab", (status, tab) => {
    expect(shopOrderTabOf({ status, totalCents: 1000 })).toBe(tab)
  })

  it("reads the status case-insensitively", () => {
    expect(shopOrderTabOf({ status: "approved" })).toBe("active")
    expect(shopOrderTabOf({ status: " fulfilled " })).toBe("fulfilled")
  })

  it("never lists a pending order beside a fulfilled one", () => {
    expect(shopOrderTabOf({ status: "PENDING" })).not.toBe(shopOrderTabOf({ status: "FULFILLED" }))
    expect(shopOrderTabOf({ status: "PENDING" })).not.toBe(shopOrderTabOf({ status: "APPROVED" }))
  })

  it("files a partly refunded fulfilled order under refunded, judged by its items", () => {
    expect(shopOrderTabOf({
      status: "FULFILLED",
      orderItems: [{ quantity: 3, quantityRefunded: 1 }, { quantity: 2, quantityRefunded: 0 }],
    })).toBe("refunded")
  })

  it("does not treat an order-level refund amount as a refund when its items say none", () => {
    expect(shopOrderTabOf({
      status: "FULFILLED",
      refundAmountCents: 500,
      orderItems: [{ quantity: 3, quantityRefunded: 0 }],
    })).toBe("fulfilled")
  })

  it("falls back to the refund amount when items are not loaded", () => {
    expect(shopOrderTabOf({ status: "FULFILLED", refundAmountCents: 1 })).toBe("refunded")
    expect(shopOrderTabOf({ status: "FULFILLED", refundAmountCents: 0 })).toBe("fulfilled")
    expect(shopOrderTabOf({ status: "FULFILLED", refundAmountCents: null })).toBe("fulfilled")
  })

  it("lists a missing or unrecognised status as pending rather than hiding it", () => {
    expect(shopOrderTabOf({ status: null })).toBe("pending")
    expect(shopOrderTabOf({ status: "SOMETHING_NEW" })).toBe("pending")
  })
})

describe("countShopOrdersByTab", () => {
  it("counts every order exactly once, with every tab present", () => {
    const counts = countShopOrdersByTab([
      { status: "PENDING" },
      { status: "PENDING" },
      { status: "APPROVED" },
      { status: "FULFILLED" },
      { status: "FULFILLED", refundAmountCents: 100 },
      { status: "REJECTED" },
    ])
    expect(counts).toEqual({ pending: 2, active: 1, fulfilled: 1, rejected: 1, refunded: 1 })
  })

  it("answers zeros for no orders", () => {
    expect(countShopOrdersByTab(undefined)).toEqual({ pending: 0, active: 0, fulfilled: 0, rejected: 0, refunded: 0 })
    expect(countShopOrdersByTab([])).toEqual({ pending: 0, active: 0, fulfilled: 0, rejected: 0, refunded: 0 })
  })
})

describe("isShopOrderTab", () => {
  it("accepts every order tab and nothing else", () => {
    for (const tab of SHOP_ORDER_TABS) expect(isShopOrderTab(tab)).toBe(true)
    expect(isShopOrderTab("shop")).toBe(false)
    expect(isShopOrderTab("unacknowledged")).toBe(false)
    expect(isShopOrderTab("orders")).toBe(false)
    expect(isShopOrderTab(undefined)).toBe(false)
  })
})
