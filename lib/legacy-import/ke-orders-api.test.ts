import { describe, expect, it } from "vitest"

import {
  budgetPeriod,
  computeOrderTax,
  identityKeyForListRow,
  orderIdentityKey,
  prepareApiOrders,
  reconcileAgainstSheet,
  stripTrailingRoleSeparator,
  type PreparedApiLine,
  monthWindows,
} from "./ke-orders-api"
import type { LegacyOrderDetail, LegacyOrderListRow } from "./ke-post-cutoff"

function listRow(overrides: Partial<LegacyOrderListRow> = {}): LegacyOrderListRow {
  return {
    ID: 1400,
    LocationID: 21,
    TransactionNo: 4,
    OrderNo: 1,
    OrderTakerID: 26,
    OrderCreatedDT: "2026-08-20T00:00:00",
    OrderType: "Counter Order",
    StatusID: 2,
    DeliveryStatus: 507,
    CreatedOn: "2026-08-20T11:15:00",
    LastUpdateDT: "2026-08-20T13:00:00",
    UserDetails: "Test User -",
    GrandTotal: 1500,
    LocationName: "IBC Malir",
    LocationGroup: "Distribution Group",
    ...overrides,
  }
}

function detail(overrides: Partial<LegacyOrderDetail> = {}): LegacyOrderDetail {
  return {
    ID: 1400,
    LocationID: 21,
    TransactionNo: 4,
    OrderTakerID: 26,
    DeliveryStatus: 507,
    OrderCreatedDT: "2026-08-20T00:00:00",
    StatusID: 2,
    OrderDetailsList: [
      { ID: 1, ItemId: 10, Name: "Sugar (01 KG)", Quantity: 2, Price: 1000 },
      { ID: 2, ItemId: 11, Name: "Tea (100 PCS)", Quantity: 1, Price: 500 },
    ],
    OrderCheckoutList: [
      { AmountTotal: 1500, GrandTotal: 1500, Tax: 0, AmountDiscount: 0, ServiceCharges: 0, DeliveryCharges: 0 },
    ],
    ...overrides,
  }
}

function detailMap(...details: LegacyOrderDetail[]) {
  return new Map(details.map((entry) => [Number(entry.ID), entry]))
}

describe("orderIdentityKey", () => {
  it("is stable across casing, padding and datetime suffixes", () => {
    const a = orderIdentityKey({ locationName: "IBC Malir", transactionNo: 4, orderNo: 1, date: "2026-08-20" })
    const b = orderIdentityKey({ locationName: "  ibc   MALIR ", transactionNo: "4", orderNo: "1", date: "2026-08-20T11:15:00" })
    expect(a).toBe(b)
  })

  it("separates orders that differ only by transaction number", () => {
    const a = orderIdentityKey({ locationName: "IBC Malir", transactionNo: 3, orderNo: 1, date: "2026-08-20" })
    const b = orderIdentityKey({ locationName: "IBC Malir", transactionNo: 4, orderNo: 1, date: "2026-08-20" })
    expect(a).not.toBe(b)
  })

  it("derives the same key from a list row", () => {
    expect(identityKeyForListRow(listRow())).toBe(
      orderIdentityKey({ locationName: "IBC Malir", transactionNo: 4, orderNo: 1, date: "2026-08-20" }),
    )
  })
})

describe("budgetPeriod", () => {
  it("buckets by Asia/Karachi rather than UTC", () => {
    // 2026-07-31 20:00 UTC is 2026-08-01 01:00 in Karachi.
    expect(budgetPeriod(new Date("2026-07-31T20:00:00Z"))).toBe("2026-08")
    // 2026-08-01 02:00 UTC is still 2026-08-01 07:00 in Karachi.
    expect(budgetPeriod(new Date("2026-08-01T02:00:00Z"))).toBe("2026-08")
    // An hour before the Karachi month rolls over is still July.
    expect(budgetPeriod(new Date("2026-07-31T18:00:00Z"))).toBe("2026-07")
  })
})

describe("stripTrailingRoleSeparator", () => {
  it("removes the trailing separator legacy exports append", () => {
    expect(stripTrailingRoleSeparator("Shaikh Zeesan -")).toBe("Shaikh Zeesan")
  })

  it("leaves a designation in parentheses alone", () => {
    expect(stripTrailingRoleSeparator("KASHIF (DGM GSMP)")).toBe("KASHIF (DGM GSMP)")
  })
})

describe("prepareApiOrders", () => {
  it("prepares a reconciling delivered order", () => {
    const result = prepareApiOrders([listRow()], detailMap(detail()))
    expect(result.rejected).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.prepared).toHaveLength(1)

    const order = result.prepared[0]
    expect(order.status).toBe("FULFILLED")
    expect(order.fulfillmentStatus).toBe("DELIVERED")
    expect(order.totalCents).toBe(150_000)
    expect(order.userName).toBe("Test User")
    expect(order.lines.map((line) => [line.quantity, line.priceCents, line.lineTotalCents]))
      .toEqual([[2, 50_000, 100_000], [1, 50_000, 50_000]])
  })

  it("maps every live delivery status the legacy system can produce", () => {
    const cases: Array<[number, string, string]> = [
      [501, "APPROVED", "NOT_STARTED"],   // Order Placed
      [502, "APPROVED", "NOT_STARTED"],   // Confirmed
      [503, "APPROVED", "IN_PROCESS"],    // InProcess
      [505, "FULFILLED", "DELIVERED"],    // Partial
      [506, "APPROVED", "OUT_FOR_DELIVERY"],
      [507, "FULFILLED", "DELIVERED"],    // Delivered
    ]
    for (const [deliveryStatus, status, fulfillmentStatus] of cases) {
      const result = prepareApiOrders(
        [listRow({ DeliveryStatus: deliveryStatus })],
        detailMap(detail({ DeliveryStatus: deliveryStatus })),
      )
      expect(result.prepared[0]?.status, `delivery ${deliveryStatus}`).toBe(status)
      expect(result.prepared[0]?.fulfillmentStatus, `delivery ${deliveryStatus}`).toBe(fulfillmentStatus)
    }
  })

  it("skips cancelled and draft orders without rejecting them", () => {
    const result = prepareApiOrders(
      [
        listRow({ ID: 1, StatusID: 5, DeliveryStatus: 508 }),
        listRow({ ID: 2, StatusID: 1, DeliveryStatus: 501, GrandTotal: null }),
      ],
      detailMap(),
    )
    expect(result.prepared).toEqual([])
    expect(result.rejected).toEqual([])
    expect(result.skipped.map((row) => row.reason)).toEqual(["CANCELLED", "DRAFT"])
  })

  it("reports an already-imported order as imported even when legacy still calls it a draft", () => {
    const result = prepareApiOrders(
      [listRow({ ID: 1327, StatusID: 1, DeliveryStatus: 501 })],
      detailMap(),
      { legacyOrderIds: new Set([1327]), identityKeys: new Set() },
    )
    expect(result.skipped.map((row) => row.reason)).toEqual(["ALREADY_IMPORTED"])
  })

  it("skips orders already recorded under either dedupe key", () => {
    const byId = prepareApiOrders([listRow()], detailMap(detail()), {
      legacyOrderIds: new Set([1400]),
      identityKeys: new Set(),
    })
    expect(byId.skipped.map((row) => row.reason)).toEqual(["ALREADY_IMPORTED"])
    expect(byId.prepared).toEqual([])

    const byIdentity = prepareApiOrders([listRow()], detailMap(detail()), {
      legacyOrderIds: new Set(),
      identityKeys: new Set([identityKeyForListRow(listRow())]),
    })
    expect(byIdentity.skipped.map((row) => row.reason)).toEqual(["ALREADY_IMPORTED"])
    expect(byIdentity.prepared).toEqual([])
  })

  it("rejects an order whose items do not reconcile to its checkout", () => {
    const result = prepareApiOrders(
      [listRow()],
      detailMap(detail({
        OrderCheckoutList: [
          { AmountTotal: 9999, GrandTotal: 9999, Tax: 0, AmountDiscount: 0, ServiceCharges: 0, DeliveryCharges: 0 },
        ],
      })),
    )
    expect(result.prepared).toEqual([])
    expect(result.rejected[0]?.reason).toBe("ITEM_SUBTOTAL_MISMATCH")
  })

  it("rejects an order whose list total disagrees with its detail", () => {
    const result = prepareApiOrders([listRow({ GrandTotal: 1234 })], detailMap(detail()))
    expect(result.rejected[0]?.reason).toBe("CHECKOUT_MISMATCH")
  })

  it("rejects a line whose total does not divide into a whole-cent unit price", () => {
    const result = prepareApiOrders(
      [listRow({ GrandTotal: 10.01 })],
      detailMap(detail({
        OrderDetailsList: [{ ID: 1, ItemId: 10, Name: "Odd", Quantity: 3, Price: 10.01 }],
        OrderCheckoutList: [
          { AmountTotal: 10.01, GrandTotal: 10.01, Tax: 0, AmountDiscount: 0, ServiceCharges: 0, DeliveryCharges: 0 },
        ],
      })),
    )
    expect(result.rejected[0]?.reason).toBe("INEXACT_UNIT_PRICE")
  })

  it("drops zero-value basket rows but keeps the order", () => {
    const result = prepareApiOrders(
      [listRow()],
      detailMap(detail({
        OrderDetailsList: [
          { ID: 1, ItemId: 10, Name: "Sugar (01 KG)", Quantity: 2, Price: 1000 },
          { ID: 2, ItemId: 11, Name: "Tea (100 PCS)", Quantity: 1, Price: 500 },
          { ID: 3, ItemId: 12, Name: "Leftover", Quantity: 0, Price: 0 },
        ],
      })),
    )
    expect(result.rejected).toEqual([])
    expect(result.prepared[0]?.lines).toHaveLength(2)
  })

  it("rejects an order that has no positive lines at all", () => {
    const result = prepareApiOrders(
      [listRow({ GrandTotal: 0 })],
      detailMap(detail({
        OrderDetailsList: [{ ID: 1, ItemId: 10, Name: "Leftover", Quantity: 0, Price: 0 }],
        OrderCheckoutList: [
          { AmountTotal: 0, GrandTotal: 0, Tax: 0, AmountDiscount: 0, ServiceCharges: 0, DeliveryCharges: 0 },
        ],
      })),
    )
    expect(result.rejected[0]?.reason).toBe("NO_ITEM_LINES")
  })

  it("rejects an unknown delivery status instead of throwing", () => {
    const result = prepareApiOrders(
      [listRow({ DeliveryStatus: 599 })],
      detailMap(detail({ DeliveryStatus: 599 })),
    )
    expect(result.prepared).toEqual([])
    expect(result.rejected[0]?.reason).toBe("UNSUPPORTED_STATUS")
  })

  it("rejects rather than throws when a detail response is missing", () => {
    const result = prepareApiOrders([listRow()], detailMap())
    expect(result.rejected[0]?.reason).toBe("LIST_DETAIL_MISMATCH")
  })

  it("keeps good orders when a neighbouring order is bad", () => {
    const result = prepareApiOrders(
      [listRow({ ID: 1400 }), listRow({ ID: 1401, TransactionNo: 5 })],
      detailMap(detail({ ID: 1400 }), detail({ ID: 1401, OrderCheckoutList: [] })),
    )
    expect(result.prepared.map((order) => order.legacyOrderId)).toEqual([1400])
    expect(result.rejected.map((order) => order.legacyOrderId)).toEqual([1401])
  })
})

describe("computeOrderTax", () => {
  const lines = (...totals: number[]): PreparedApiLine[] =>
    totals.map((lineTotalCents, index) => ({
      sourceLineId: index,
      legacyItemId: index,
      sourceName: `Item ${index}`,
      normalizedName: `item ${index}`,
      quantity: 1,
      priceCents: lineTotalCents,
      lineTotalCents,
      sourceCodes: [],
    }))

  it("treats the legacy price as gross and never restates the total", () => {
    const result = computeOrderTax(lines(118_000), () => null)
    expect(result.totalCents).toBe(118_000)
    expect(result.taxCents).toBe(18_000)
    expect(result.subtotalCents).toBe(100_000)
    expect(result.subtotalCents + result.taxCents).toBe(result.totalCents)
  })

  it("reconciles across lines that round awkwardly", () => {
    const result = computeOrderTax(lines(333, 333, 333), () => null)
    expect(result.totalCents).toBe(999)
    expect(result.subtotalCents + result.taxCents).toBe(result.totalCents)
  })

  it("honours a product override ahead of the organization rate", () => {
    const result = computeOrderTax(lines(100_000), () => 0, 1800)
    expect(result.taxCents).toBe(0)
    expect(result.subtotalCents).toBe(100_000)
  })

  it("falls back to the organization rate, then the default", () => {
    expect(computeOrderTax(lines(110_000), () => null, 1000).taxCents).toBe(10_000)
    expect(computeOrderTax(lines(118_000), () => null, null).taxCents).toBe(18_000)
  })
})

describe("reconcileAgainstSheet", () => {
  const sheet = [
    { Location: "IBC Malir", TransactionNo: "4", OrderNo: "1", Date: "2026-08-20" },
    { Location: "Saddar IBC", TransactionNo: "11", OrderNo: "1", Date: "2026-08-24" },
  ]

  it("matches a sheet against the same orders from the API", () => {
    const result = reconcileAgainstSheet(sheet, [
      listRow(),
      listRow({ ID: 1401, LocationName: "Saddar IBC", TransactionNo: 11, OrderCreatedDT: "2026-08-24T00:00:00" }),
    ])
    expect(result.matched).toBe(2)
    expect(result.onlyInSheet).toEqual([])
    expect(result.onlyInApi).toEqual([])
  })

  it("reports rows the API did not return", () => {
    const result = reconcileAgainstSheet(sheet, [listRow()])
    expect(result.matched).toBe(1)
    expect(result.onlyInSheet).toHaveLength(1)
    expect(result.onlyInApi).toEqual([])
  })

  it("reports orders the sheet did not show", () => {
    const result = reconcileAgainstSheet([sheet[0]], [
      listRow(),
      listRow({ ID: 1401, LocationName: "Saddar IBC", TransactionNo: 11, OrderCreatedDT: "2026-08-24T00:00:00" }),
    ])
    expect(result.matched).toBe(1)
    expect(result.onlyInApi).toHaveLength(1)
  })
})

describe("monthWindows", () => {
  it("splits a multi-year range into calendar months", () => {
    const windows = monthWindows("2025-11-15", "2026-02-03")
    expect(windows).toEqual([
      { start: "2025-11-15", end: "2025-11-30" },
      { start: "2025-12-01", end: "2025-12-31" },
      { start: "2026-01-01", end: "2026-01-31" },
      { start: "2026-02-01", end: "2026-02-03" },
    ])
  })

  it("returns a single clipped window when both bounds share a month", () => {
    expect(monthWindows("2026-08-05", "2026-08-20"))
      .toEqual([{ start: "2026-08-05", end: "2026-08-20" }])
  })

  it("handles a leap February", () => {
    const windows = monthWindows("2028-02-01", "2028-03-01")
    expect(windows[0]).toEqual({ start: "2028-02-01", end: "2028-02-29" })
  })

  it("covers the range with no gap and no overlap", () => {
    const windows = monthWindows("2025-01-01", "2026-09-06")
    expect(windows[0].start).toBe("2025-01-01")
    expect(windows[windows.length - 1].end).toBe("2026-09-06")
    for (let i = 1; i < windows.length; i += 1) {
      const previousEnd = new Date(`${windows[i - 1].end}T00:00:00Z`).getTime()
      const thisStart = new Date(`${windows[i].start}T00:00:00Z`).getTime()
      expect(thisStart - previousEnd).toBe(86_400_000)
    }
  })

  it("does not loop forever on a single-day range", () => {
    expect(monthWindows("2026-09-06", "2026-09-06"))
      .toEqual([{ start: "2026-09-06", end: "2026-09-06" }])
  })
})

describe("partially refunded orders", () => {
  // Legacy zeroes a refunded line's Price but keeps RefundPrice on the refund
  // record, so the order's own lines sum short of its checkout subtotal by
  // exactly the refunded value. The order must still be stored GROSS, because
  // that is what legacy counts in its sales figures, with the refund recorded
  // beside it — otherwise our revenue understates legacy's by the refund.
  const header = (over = {}) => ({
    ID: 1, LocationID: 5, LocationName: "KE HOUSE", TransactionNo: 8, OrderNo: 1,
    OrderTakerID: 3, UserDetails: "Someone", LocationGroup: "G", StatusID: 2,
    DeliveryStatus: 507, GrandTotal: 107.9, CreatedOn: "2025-05-01T10:00:00",
    LastUpdateDT: "2025-05-02T10:00:00", ...over,
  })
  const detail = {
    ID: 1, LocationID: 5, StatusID: 2, DeliveryStatus: 507,
    OrderCreatedDT: "2025-05-01T10:00:00",
    OrderDetailsList: [
      { ID: 11, ItemId: 1, Name: "Kept", Quantity: 6, Price: 95.1, IsVATApplied: false },
      { ID: 12, ItemId: 2, Name: "Refunded", Quantity: 4, Price: 0, IsVATApplied: false },
    ],
    OrderCheckoutList: [{ AmountTotal: 107.9, AmountDiscount: 0, ServiceCharges: 0,
      DeliveryCharges: 0, Tax: 0, GrandTotal: 107.9 }],
  }
  const refund = {
    OrderDetailsList: [
      { ID: 11, Name: "Kept", Quantity: 6, RefundQuantity: 6, UnitPrice: 15.85, Price: 95.1, RefundPrice: 0 },
      { ID: 12, Name: "Refunded", Quantity: 4, RefundQuantity: 0, UnitPrice: 3.2, Price: 0, RefundPrice: 12.8 },
    ],
  }

  it("restores the refunded line and keeps the order gross", () => {
    const result = prepareApiOrders([header()] as any, new Map([[1, detail]]) as any,
      undefined, new Map([[1, refund]]))

    expect(result.rejected).toHaveLength(0)
    expect(result.prepared).toHaveLength(1)
    const order = result.prepared[0]
    expect(order.totalCents).toBe(10_790)
    expect(order.lines.reduce((s, l) => s + l.lineTotalCents, 0)).toBe(10_790)
    const refunded = order.lines.find((l) => l.sourceLineId === 12)!
    expect(refunded.lineTotalCents).toBe(1_280)
    expect(refunded.priceCents).toBe(320)
  })

  it("leaves an order with no refund untouched", () => {
    const clean = {
      ...detail,
      OrderDetailsList: [{ ID: 11, ItemId: 1, Name: "Kept", Quantity: 5, Price: 107.9, IsVATApplied: false }],
    }
    const result = prepareApiOrders([header()] as any, new Map([[1, clean]]) as any)
    expect(result.rejected).toHaveLength(0)
    expect(result.prepared[0].lines).toHaveLength(1)
    expect(result.prepared[0].totalCents).toBe(10_790)
  })

  // The refunded amount is never claimed: RefundPrice reconstructs the billed
  // line but is not a trustworthy per-order refund figure, so no refund value
  // is carried anywhere on the prepared order.
  it("claims no refund amount, even on an order it restored", () => {
    const result = prepareApiOrders([header()] as any, new Map([[1, detail]]) as any,
      undefined, new Map([[1, refund]]))
    expect(Object.keys(result.prepared[0])).not.toContain("refundCents")
  })

  it("refuses when no refund record explains the shortfall", () => {
    const result = prepareApiOrders([header()] as any, new Map([[1, detail]]) as any)
    expect(result.prepared).toHaveLength(0)
    expect(result.rejected[0].reason).toBe("ITEM_SUBTOTAL_MISMATCH")
  })

  it("refuses when the restored lines still do not reconcile", () => {
    const wrong = { OrderDetailsList: [
      { ID: 11, Quantity: 6, UnitPrice: 15.85, Price: 95.1, RefundPrice: 0 },
      { ID: 12, Quantity: 4, UnitPrice: 3.2, Price: 0, RefundPrice: 1 },
    ] }
    const result = prepareApiOrders([header()] as any, new Map([[1, detail]]) as any,
      undefined, new Map([[1, wrong]]))
    expect(result.prepared).toHaveLength(0)
    expect(result.rejected[0].detail).toContain("still does not reconcile")
  })
})

describe("the unit-price check runs after refund restoration, not before", () => {
  // Order 1059's shape: heavily refunded, so the surviving Price on a line is a
  // negative remainder that divides into nothing sensible. Checking divisibility
  // in the line loop killed the order before the refund record was consulted;
  // the line legacy actually billed is 1,202,500 over 13 = a clean 92,500.
  const header = {
    ID: 9, LocationID: 97, LocationName: "Business Finance Capex", TransactionNo: 6,
    OrderNo: 1, OrderTakerID: 3, UserDetails: "Someone", LocationGroup: "G",
    StatusID: 2, DeliveryStatus: 507, GrandTotal: 45550,
    CreatedOn: "2025-07-01T10:00:00", LastUpdateDT: "2025-07-02T10:00:00",
  }
  const detail = {
    ID: 9, LocationID: 97, StatusID: 2, DeliveryStatus: 507,
    OrderCreatedDT: "2025-07-01T10:00:00",
    OrderDetailsList: [
      { ID: 71, ItemId: 1, Name: "Sugar", Quantity: 15, Price: 975, IsVATApplied: false },
      { ID: 72, ItemId: 2, Name: "Tapal Danedar", Quantity: 13, Price: -1850, IsVATApplied: false },
      { ID: 73, ItemId: 3, Name: "Nestle Everyday", Quantity: 15, Price: 0, IsVATApplied: false },
    ],
    OrderCheckoutList: [{ AmountTotal: 45550, AmountDiscount: 0, ServiceCharges: 0,
      DeliveryCharges: 0, Tax: 0, GrandTotal: 45550 }],
  }
  const refund = {
    OrderDetailsList: [
      { ID: 71, Quantity: 15, RefundQuantity: 5, UnitPrice: 195, Price: 975, RefundPrice: 1950 },
      { ID: 72, Quantity: 13, RefundQuantity: -2, UnitPrice: 925, Price: -1850, RefundPrice: 13875 },
      { ID: 73, Quantity: 15, RefundQuantity: 0, UnitPrice: 2040, Price: 0, RefundPrice: 30600 },
    ],
  }

  it("imports the order, with every unit price whole after restoration", () => {
    const result = prepareApiOrders([header] as any, new Map([[9, detail]]) as any,
      undefined, new Map([[9, refund]]))

    expect(result.rejected).toHaveLength(0)
    expect(result.prepared).toHaveLength(1)
    const order = result.prepared[0]
    expect(order.totalCents).toBe(4_555_000)
    expect(order.lines.map((l) => l.priceCents)).toEqual([19_500, 92_500, 204_000])
    expect(order.lines.reduce((s, l) => s + l.lineTotalCents, 0)).toBe(4_555_000)
  })

  // The check still bites — it is deferred, not removed, and nothing rounds.
  it("still refuses a line that does not divide even after restoration", () => {
    const odd = {
      ...detail,
      OrderDetailsList: [{ ID: 71, ItemId: 1, Name: "Odd", Quantity: 16, Price: 925, IsVATApplied: false }],
      OrderCheckoutList: [{ AmountTotal: 925, AmountDiscount: 0, ServiceCharges: 0,
        DeliveryCharges: 0, Tax: 0, GrandTotal: 925 }],
    }
    const result = prepareApiOrders(
      [{ ...header, GrandTotal: 925 }] as any, new Map([[9, odd]]) as any)

    expect(result.prepared).toHaveLength(0)
    expect(result.rejected[0].reason).toBe("INEXACT_UNIT_PRICE")
    expect(result.rejected[0].detail).toContain("92500 over 16")
  })

  it("refuses an indivisible line on an order with no refund at all", () => {
    const odd = {
      ...detail,
      OrderDetailsList: [{ ID: 71, ItemId: 1, Name: "Odd", Quantity: 3, Price: 3350, IsVATApplied: false }],
      OrderCheckoutList: [{ AmountTotal: 3350, AmountDiscount: 0, ServiceCharges: 0,
        DeliveryCharges: 0, Tax: 0, GrandTotal: 3350 }],
    }
    const result = prepareApiOrders(
      [{ ...header, GrandTotal: 3350 }] as any, new Map([[9, odd]]) as any)
    expect(result.rejected[0].reason).toBe("INEXACT_UNIT_PRICE")
  })
})
