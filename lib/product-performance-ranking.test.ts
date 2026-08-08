import { describe, expect, it } from "vitest"

import {
  parseProductPerformanceLimit,
  parseProductPerformanceRankBy,
  rankProductPerformanceRows,
} from "@/lib/product-performance-ranking"

const products = [
  {
    productName: "High value",
    revenueGeneratedCents: 50_000,
    qtyOrdered: 2,
    qtyFulfilled: 2,
    qtyRefunded: 0,
    totalOrders: 1,
  },
  {
    productName: "High volume",
    revenueGeneratedCents: 20_000,
    qtyOrdered: 20,
    qtyFulfilled: 18,
    qtyRefunded: 2,
    totalOrders: 4,
  },
  {
    productName: "Frequent",
    revenueGeneratedCents: 10_000,
    qtyOrdered: 8,
    qtyFulfilled: 8,
    qtyRefunded: 0,
    totalOrders: 7,
  },
  {
    productName: "No activity",
    revenueGeneratedCents: 0,
    qtyOrdered: 0,
    qtyFulfilled: 0,
    qtyRefunded: 0,
    totalOrders: 0,
  },
]

describe("product performance ranking", () => {
  it("ranks by net value and removes inactive catalog rows", () => {
    const result = rankProductPerformanceRows(products, {
      requestedRankBy: "netValue",
      pricesHidden: false,
      limit: 10,
    })

    expect(result.rankBy).toBe("netValue")
    expect(result.data.map((product) => product.productName)).toEqual([
      "High value",
      "High volume",
      "Frequent",
    ])
  })

  it("ranks by fulfilled quantity", () => {
    const result = rankProductPerformanceRows(products, {
      requestedRankBy: "fulfilledQty",
      pricesHidden: false,
      limit: 2,
    })

    expect(result.data.map((product) => product.productName)).toEqual([
      "High volume",
      "Frequent",
    ])
  })

  it("ranks by unique order count", () => {
    const result = rankProductPerformanceRows(products, {
      requestedRankBy: "orderCount",
      pricesHidden: false,
      limit: 2,
    })

    expect(result.data.map((product) => product.productName)).toEqual([
      "Frequent",
      "High volume",
    ])
  })

  it("does not leak value-based ordering when prices are hidden", () => {
    const result = rankProductPerformanceRows(products, {
      requestedRankBy: "netValue",
      pricesHidden: true,
      limit: 10,
    })

    expect(result.rankBy).toBe("fulfilledQty")
    expect(result.data[0].productName).toBe("High volume")
  })

  it("allowlists ranking modes and bounds limits", () => {
    expect(parseProductPerformanceRankBy("orderCount")).toBe("orderCount")
    expect(parseProductPerformanceRankBy("revenue desc; drop table")).toBe("netValue")
    expect(parseProductPerformanceLimit("10")).toBe(10)
    expect(parseProductPerformanceLimit("1000")).toBe(100)
    expect(parseProductPerformanceLimit("invalid")).toBeUndefined()
  })
})
