import { describe, expect, it, vi } from "vitest"

import {
  buildConsumptionTrend,
  CONSUMPTION_TREND_DEFAULT_SERIES,
  CONSUMPTION_TREND_MAX_MONTHS,
  CONSUMPTION_TREND_MAX_SERIES,
  formatTrendMonthLabel,
  OTHER_SERIES_ID,
  parseConsumptionTrendSeriesLimit,
  productTrendMonthKey,
  resolveTrendMonths,
  type ConsumptionTrendRow,
} from "./product-consumption-trend"

const row = (over: Partial<ConsumptionTrendRow> = {}): ConsumptionTrendRow => ({
  productId: 1,
  productName: "Cable Tie",
  productCode: "CT-1",
  monthKey: "2026-01",
  qtyOrdered: 10,
  qtyConsumed: 10,
  ...over,
})

describe("productTrendMonthKey", () => {
  it("names the month of the order, zero padded", () => {
    expect(productTrendMonthKey(new Date(2026, 0, 31, 23, 30))).toBe("2026-01")
    expect(productTrendMonthKey(new Date(2026, 8, 1))).toBe("2026-09")
  })

  it("accepts the string and number forms a driver may hand back", () => {
    const reference = new Date(2026, 5, 15, 12).getTime()
    expect(productTrendMonthKey(reference)).toBe("2026-06")
    expect(productTrendMonthKey(new Date(reference).toISOString())).toBe(
      productTrendMonthKey(new Date(reference)),
    )
  })

  it("is the derivation the product performance route uses", async () => {
    // Structural, not behavioural: the bar chart and this line chart sit on the
    // same screen under the same filters, so they must bucket an order the same
    // way. The route importing this function is what guarantees that; a route
    // that reverts to deriving its own key would silently disagree.
    const { readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const route = readFileSync(
      resolve(process.cwd(), "app/api/v1/analytics/products/performance/route.ts"),
      "utf8",
    )
    expect(route).toContain('from "@/lib/product-consumption-trend"')
    expect(route).toContain("productTrendMonthKey(row.createdAt)")
    expect(route).not.toContain("date.getMonth() + 1")
  })

  it("keeps both product reports on the shared revenue-status population", async () => {
    const { readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    for (const path of [
      "app/api/v1/analytics/products/performance/route.ts",
      "app/api/v1/analytics/products/consumption-trend/route.ts",
    ]) {
      const route = readFileSync(resolve(process.cwd(), path), "utf8")
      expect(route, path).toContain('REVENUE_ELIGIBLE_FILTER } from "@/lib/metric-utils"')
      expect(route, path).not.toContain("'REFUNDED'")
    }
  })

  it("returns an empty key rather than throwing on an unusable date", () => {
    expect(productTrendMonthKey("not a date")).toBe("")
  })
})

describe("formatTrendMonthLabel", () => {
  it("shortens to month and two-digit year", () => {
    expect(formatTrendMonthLabel("2026-01")).toBe("Jan 26")
    expect(formatTrendMonthLabel("2025-12")).toBe("Dec 25")
  })

  it("passes an unrecognised key through untouched", () => {
    expect(formatTrendMonthLabel("nonsense")).toBe("nonsense")
    expect(formatTrendMonthLabel("2026-13")).toBe("2026-13")
  })
})

describe("parseConsumptionTrendSeriesLimit", () => {
  it("defaults when nothing usable is supplied", () => {
    for (const value of [null, undefined, "", "abc", "0", "-3"]) {
      expect(parseConsumptionTrendSeriesLimit(value)).toBe(CONSUMPTION_TREND_DEFAULT_SERIES)
    }
  })

  it("caps at the palette's slot count", () => {
    expect(parseConsumptionTrendSeriesLimit("3")).toBe(3)
    expect(parseConsumptionTrendSeriesLimit("500")).toBe(CONSUMPTION_TREND_MAX_SERIES)
  })
})

describe("resolveTrendMonths", () => {
  it("expands a year and month selection to the months asked for", () => {
    expect(resolveTrendMonths({ months: [1, 2, 3], years: [2026] })).toEqual([
      "2026-01", "2026-02", "2026-03",
    ])
  })

  it("draws a whole year when months are left open", () => {
    expect(resolveTrendMonths({ years: [2026] })).toHaveLength(12)
  })

  it("draws a requested month that holds nothing, at zero rather than skipping it", () => {
    const months = resolveTrendMonths({
      months: [1, 2, 3],
      years: [2026],
      observedMonths: ["2026-01", "2026-03"],
    })
    expect(months).toContain("2026-02")
  })

  it("reads months without years as those months of the years the data covers", () => {
    expect(resolveTrendMonths({
      months: [1],
      observedMonths: ["2025-01", "2025-06", "2026-01"],
    })).toEqual(["2025-01", "2026-01"])
  })

  it("walks a date range month by month, inclusive of both ends", () => {
    expect(resolveTrendMonths({
      startDate: new Date(2025, 10, 20),
      endDate: new Date(2026, 1, 3),
    })).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"])
  })

  it("expands date-only bounds in the application timezone on a UTC server", () => {
    vi.stubEnv("TZ", "UTC")
    try {
      expect(resolveTrendMonths({
        startDate: new Date("2026-07-01T00:00:00.000+05:00"),
        endDate: new Date("2026-08-31T23:59:59.999+05:00"),
      })).toEqual(["2026-07", "2026-08"])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("falls back to whatever months the rows landed in", () => {
    expect(resolveTrendMonths({ observedMonths: ["2026-03", "2026-01", "2026-03"] }))
      .toEqual(["2026-01", "2026-03"])
  })

  it("keeps the most recent months when the window is longer than the cap", () => {
    const months = resolveTrendMonths({ years: [2023, 2024, 2025, 2026] })
    expect(months).toHaveLength(CONSUMPTION_TREND_MAX_MONTHS)
    expect(months.at(-1)).toBe("2026-12")
    expect(months[0]).toBe("2025-01")
  })

  it("returns nothing for an inverted range rather than looping", () => {
    expect(resolveTrendMonths({
      startDate: new Date(2026, 5, 1),
      endDate: new Date(2026, 1, 1),
    })).toEqual([])
  })
})

describe("buildConsumptionTrend", () => {
  const months = ["2026-01", "2026-02", "2026-03"]

  it("works a two-product, three-month oracle", () => {
    const trend = buildConsumptionTrend([
      row({ productId: 1, productName: "Cable Tie", monthKey: "2026-01", qtyOrdered: 10, qtyConsumed: 10 }),
      row({ productId: 1, productName: "Cable Tie", monthKey: "2026-01", qtyOrdered: 5, qtyConsumed: 4 }),
      row({ productId: 1, productName: "Cable Tie", monthKey: "2026-03", qtyOrdered: 7, qtyConsumed: 7 }),
      row({ productId: 2, productName: "Safety Glove", monthKey: "2026-02", qtyOrdered: 3, qtyConsumed: 3 }),
    ], { months })

    const [cableTie, glove] = trend.series
    expect(cableTie.productName).toBe("Cable Tie")
    expect(cableTie.totalConsumed).toBe(21)
    expect(cableTie.totalOrdered).toBe(22)
    expect(cableTie.points.map((point) => point.consumed)).toEqual([14, 0, 7])

    expect(glove.productName).toBe("Safety Glove")
    expect(glove.points.map((point) => point.consumed)).toEqual([0, 3, 0])

    expect(trend.months.map((month) => month.label)).toEqual(["Jan 26", "Feb 26", "Mar 26"])
  })

  it("gives every series the full month axis, in the same order", () => {
    const trend = buildConsumptionTrend([row({ monthKey: "2026-02" })], { months })
    for (const entry of trend.series) {
      expect(entry.points.map((point) => point.month)).toEqual(months)
    }
  })

  it("ranks on the window total, not on the last month", () => {
    const trend = buildConsumptionTrend([
      row({ productId: 1, productName: "Steady", monthKey: "2026-01", qtyOrdered: 40, qtyConsumed: 40 }),
      row({ productId: 2, productName: "Late spike", monthKey: "2026-03", qtyOrdered: 30, qtyConsumed: 30 }),
    ], { months })
    expect(trend.series.map((entry) => entry.productName)).toEqual(["Steady", "Late spike"])
  })

  it("folds everything past the limit into one Other row rather than dropping it", () => {
    const rows = [1, 2, 3, 4].map((productId) => row({
      productId,
      productName: `Product ${productId}`,
      monthKey: "2026-01",
      qtyOrdered: productId * 10,
      qtyConsumed: productId * 10,
    }))

    const trend = buildConsumptionTrend(rows, { months, limit: 2 })
    expect(trend.series).toHaveLength(3)
    expect(trend.productsInWindow).toBe(4)
    expect(trend.hasOther).toBe(true)

    const other = trend.series.at(-1)!
    expect(other.productId).toBe(OTHER_SERIES_ID)
    // Products 2 and 1 are what is left after the top two (4 and 3).
    expect(other.totalConsumed).toBe(30)

    const shown = trend.series.reduce((sum, entry) => sum + entry.totalConsumed, 0)
    expect(shown).toBe(100)
  })

  it("adds no Other row when nothing is left over", () => {
    const trend = buildConsumptionTrend([row()], { months, limit: 5 })
    expect(trend.hasOther).toBe(false)
    expect(trend.series.map((entry) => entry.productId)).not.toContain(OTHER_SERIES_ID)
  })

  it("can be asked to drop the remainder instead of folding it", () => {
    const rows = [1, 2].map((productId) => row({ productId, productName: `P${productId}` }))
    const trend = buildConsumptionTrend(rows, { months, limit: 1, includeOther: false })
    expect(trend.series).toHaveLength(1)
    expect(trend.hasOther).toBe(false)
  })

  it("ignores rows outside the month axis", () => {
    const trend = buildConsumptionTrend([
      row({ monthKey: "2026-02", qtyOrdered: 4, qtyConsumed: 4 }),
      row({ monthKey: "2025-12", qtyOrdered: 900, qtyConsumed: 900 }),
    ], { months })
    expect(trend.series[0].totalConsumed).toBe(4)
  })

  it("keeps an eligible product whose approved line refund reduces consumption to zero", () => {
    const trend = buildConsumptionTrend([
      row({ productId: 7, productName: "Returned lot", qtyOrdered: 12, qtyConsumed: 0 }),
    ], { months })
    expect(trend.series).toHaveLength(1)
    expect(trend.series[0].totalOrdered).toBe(12)
    expect(trend.series[0].totalConsumed).toBe(0)
  })

  it("never lets a negative or unusable quantity subtract from a month", () => {
    const trend = buildConsumptionTrend([
      row({ qtyOrdered: 5, qtyConsumed: 5 }),
      row({ qtyOrdered: -100 as number, qtyConsumed: Number.NaN as unknown as number }),
    ], { months })
    expect(trend.series[0].totalConsumed).toBe(5)
    expect(trend.series[0].totalOrdered).toBe(5)
  })

  it("drops a row with no product rather than inventing one", () => {
    const trend = buildConsumptionTrend([row({ productId: 0 })], { months })
    expect(trend.series).toEqual([])
    expect(trend.productsInWindow).toBe(0)
  })

  it("breaks a tie by name so the same data always draws the same chart", () => {
    const first = buildConsumptionTrend([
      row({ productId: 1, productName: "Beta" }),
      row({ productId: 2, productName: "Alpha" }),
    ], { months })
    const second = buildConsumptionTrend([
      row({ productId: 2, productName: "Alpha" }),
      row({ productId: 1, productName: "Beta" }),
    ], { months })
    expect(first.series.map((entry) => entry.productName)).toEqual(["Alpha", "Beta"])
    expect(second.series.map((entry) => entry.productName)).toEqual(["Alpha", "Beta"])
  })

  it("caps the axis at the month limit even when handed more", () => {
    const longAxis = Array.from({ length: 40 }, (_, index) => {
      const year = 2023 + Math.floor(index / 12)
      return `${year}-${String((index % 12) + 1).padStart(2, "0")}`
    })
    const trend = buildConsumptionTrend([], { months: longAxis })
    expect(trend.months).toHaveLength(CONSUMPTION_TREND_MAX_MONTHS)
  })

  it("never draws more lines than the palette has slots", () => {
    const rows = Array.from({ length: 20 }, (_, index) => row({
      productId: index + 1,
      productName: `Product ${index + 1}`,
      qtyOrdered: index + 1,
      qtyConsumed: index + 1,
    }))
    const trend = buildConsumptionTrend(rows, { months, limit: 99 })
    // The cap, plus the one Other row.
    expect(trend.series).toHaveLength(CONSUMPTION_TREND_MAX_SERIES + 1)
  })
})
