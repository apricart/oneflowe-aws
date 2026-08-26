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
