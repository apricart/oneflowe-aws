import { describe, expect, it } from "vitest"

import {
  DRILLDOWN_DEFAULT_ROWS,
  DRILLDOWN_MAX_OFFSET,
  DRILLDOWN_MAX_ROWS,
  DRILLDOWN_SORT_KEYS,
  EXECUTIVE_DIMENSIONS,
  MAX_TIME_AXIS_POINTS,
  MEASURE_METRIC,
  SIDE_BY_SIDE_PANELS,
  chartTypesFor,
  clampDrillDownLimit,
  clampDrillDownOffset,
  isDrillDownSortKey,
  isMeasureId,
  isSupportedCombination,
  isSupportedMatrix,
  isTimeAxisDimension,
  measureOfMetric,
  panelsForFocus,
  resolveDrillDownSort,
  resolveSortDirection,
} from "./executive-analytics"
import {
  isDayKey,
  isMonthKey,
  narrowWindowToPeriod,
  parseDrillDownRequest,
} from "./executive-analytics-request"

/**
 * The comparison screens grew three things that a reader can now reach with a
 * single click, so all three are pinned here rather than left to review: the
 * day grain, the Amount ⇄ Quantity pair, and the drill-down that opens the
 * order lines behind a bar.
 *
 * The drill-down is the one surface in the Analytics Center that returns
 * individual records rather than aggregates. Its bounds, its sort allowlist and
 * its window narrowing are therefore treated as security properties, not as
 * conveniences.
 */

const WINDOW = {
  start: new Date("2025-01-01T00:00:00.000+05:00"),
  end: new Date("2025-06-30T23:59:59.999+05:00"),
}

function params(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams({
    startDate: "2025-01-01",
    endDate: "2025-06-30",
    ...entries,
  })
}

describe("the day grain", () => {
  it("is a time axis, alongside month", () => {
    expect(isTimeAxisDimension("day")).toBe(true)
    expect(isTimeAxisDimension("month")).toBe(true)
    for (const dimension of ["branch", "user", "product", "category", "group", "organization", "", null]) {
      expect(isTimeAxisDimension(dimension)).toBe(false)
    }
  })

  it("is not pickable, because a day is a bucket rather than a thing to tick", () => {
    expect(EXECUTIVE_DIMENSIONS.day.selectable).toBe(false)
    expect(EXECUTIVE_DIMENSIONS.month.selectable).toBe(false)
  })

  it("carries the activity metrics and no budget metric", () => {
    for (const metric of ["spend", "orders", "quantity", "avgUnitPrice", "avgOrderValue"] as const) {
      expect(isSupportedCombination("day", metric)).toBe(true)
    }
    // A budget is monthly and per branch; a day holds no ledger position.
    expect(isSupportedCombination("day", "utilization")).toBe(false)
    expect(isSupportedCombination("day", "budgetRemaining")).toBe(false)
  })

  it("is offered only the forms that respect a time axis", () => {
    const ids = chartTypesFor({ dimension: "day", metric: "quantity", entityCount: 30 }).map((entry) => entry.id)
    // Ranking days by size would destroy the one thing that makes them
    // meaningful, so bars, donuts and scatters are absent rather than disabled.
    expect(ids).toEqual(["line", "column", "table"])
    expect(ids).not.toContain("bar")
    expect(ids).not.toContain("donut")
  })

  it("is bounded more generously than months, but still bounded", () => {
    expect(MAX_TIME_AXIS_POINTS.day).toBeGreaterThan(MAX_TIME_AXIS_POINTS.month)
    expect(MAX_TIME_AXIS_POINTS.day).toBeLessThanOrEqual(400)
  })
})

describe("the Amount ⇄ Quantity pair", () => {
  it("maps each side to the metric that measures it", () => {
    expect(MEASURE_METRIC.amount).toBe("spend")
    expect(MEASURE_METRIC.quantity).toBe("quantity")
  })

  it("reads a metric back to the side of the toggle it belongs on", () => {
    expect(measureOfMetric("spend")).toBe("amount")
    expect(measureOfMetric("avgOrderValue")).toBe("amount")
    expect(measureOfMetric("utilization")).toBe("amount")
    expect(measureOfMetric("quantity")).toBe("quantity")
    // A unit price is money per unit; it belongs with the quantity side because
    // it is only meaningful inside one unit of measure.
    expect(measureOfMetric("avgUnitPrice")).toBe("quantity")
  })

  it("accepts only the two sides", () => {
    expect(isMeasureId("amount")).toBe(true)
    expect(isMeasureId("quantity")).toBe(true)
    for (const value of ["spend", "orders", "", null, undefined, 1]) {
      expect(isMeasureId(value)).toBe(false)
    }
  })
})

describe("the side-by-side panel registry", () => {
  it("asks only questions the registry will answer, under either measure", () => {
    for (const panel of SIDE_BY_SIDE_PANELS) {
      for (const measure of ["amount", "quantity"] as const) {
        expect(
          isSupportedCombination(panel.dimension, MEASURE_METRIC[measure]),
          `${panel.id} must support ${measure}`,
        ).toBe(true)
      }
    }
  })

  it("offers every panel a chart form its dimension actually allows", () => {
    for (const panel of SIDE_BY_SIDE_PANELS) {
      const allowed = chartTypesFor({
        dimension: panel.dimension,
        metric: MEASURE_METRIC.amount,
        entityCount: 6,
      })
      const option = allowed.find((entry) => entry.id === panel.chart)
      expect(option, `${panel.id} draws ${panel.chart}, which its dimension must offer`).toBeDefined()
      expect(option?.disabledReason, `${panel.id} must not draw a disabled form`).toBeUndefined()
    }
  })

  it("keeps a time axis one hue and gives entities their own", () => {
    for (const panel of SIDE_BY_SIDE_PANELS) {
      expect(panel.colorful, panel.id).toBe(!isTimeAxisDimension(panel.dimension))
    }
  })

  it("shows day-by-day consumption only for a single focused product", () => {
    // Daily consumption of "three products at once" is a number nobody asked
    // for; the panel is withheld rather than drawn against an ambiguous subject.
    expect(panelsForFocus(0).map((panel) => panel.id)).not.toContain("day-by-day")
    expect(panelsForFocus(2).map((panel) => panel.id)).not.toContain("day-by-day")
    expect(panelsForFocus(1).map((panel) => panel.id)).toContain("day-by-day")
  })

  it("withholds the product-vs-product and category panels only for a single focused product", () => {
    // One product against itself is a single bar restating the subject line,
    // and one product belongs to one category, so that panel would be too.
    // With nothing focused the panels rank the top products in scope; with
    // several focused they compare exactly those.
    const productPanels = SIDE_BY_SIDE_PANELS
      .filter((panel) => panel.dimension === "product" || panel.dimension === "category")
      .map((panel) => panel.id)
    expect(productPanels).toEqual(["by-product", "by-category", "requester-by-product", "products-over-months"])

    const idsFor = (count: number) => panelsForFocus(count).map((panel) => panel.id)
    expect(idsFor(0)).toEqual(expect.arrayContaining(productPanels))
    expect(idsFor(2)).toEqual(expect.arrayContaining(productPanels))
    expect(idsFor(25)).toEqual(expect.arrayContaining(productPanels))
    for (const id of productPanels) expect(idsFor(1)).not.toContain(id)
  })

  it("never hides every panel, whatever the focus", () => {
    for (const count of [0, 1, 2, 25]) {
      expect(panelsForFocus(count).length, `focus of ${count}`).toBeGreaterThan(0)
    }
  })

  it("covers product, category, requester, branch and month on the one screen", () => {
    // The requirement: "product / month / user / item / branch compare", with
    // category standing in for item until the client says otherwise.
    const dimensions = SIDE_BY_SIDE_PANELS.map((panel) => panel.dimension)
    expect(dimensions).toContain("product")
    expect(dimensions).toContain("category")
    expect(dimensions).toContain("user")
    expect(dimensions).toContain("branch")
    expect(dimensions).toContain("month")
  })

  it("lays requesters against products as a grid the server will answer, under either measure", () => {
    // The uncombined view: one figure per (person, product). It is the one
    // panel that is not a ranking, so it has its own contract to satisfy.
    const grid = SIDE_BY_SIDE_PANELS.find((panel) => panel.id === "requester-by-product")
    expect(grid?.matrix).toEqual({ rows: "user" })
    expect(grid?.dimension).toBe("product")
    for (const measure of ["amount", "quantity"] as const) {
      expect(isSupportedMatrix(grid?.matrix?.rows, grid?.dimension, MEASURE_METRIC[measure])).toBe(true)
    }
    // Every other panel is a plain ranking.
    expect(SIDE_BY_SIDE_PANELS.filter((panel) => panel.matrix).map((panel) => panel.id)).toEqual(["requester-by-product"])
  })

  it("withholds the grid for a single focused product, where 'By requester' already is that answer", () => {
    const idsFor = (count: number) => panelsForFocus(count).map((panel) => panel.id)
    expect(idsFor(0)).toContain("requester-by-product")
    expect(idsFor(3)).toContain("requester-by-product")
    expect(idsFor(1)).not.toContain("requester-by-product")
  })
})

describe("drill-down bounds", () => {
  it("clamps the page size and never returns an unbounded one", () => {
    expect(clampDrillDownLimit(undefined)).toBe(DRILLDOWN_DEFAULT_ROWS)
    expect(clampDrillDownLimit("0")).toBe(DRILLDOWN_DEFAULT_ROWS)
    expect(clampDrillDownLimit("-5")).toBe(DRILLDOWN_DEFAULT_ROWS)
    expect(clampDrillDownLimit("not a number")).toBe(DRILLDOWN_DEFAULT_ROWS)
    expect(clampDrillDownLimit("25")).toBe(25)
    // The listing is the one surface returning individual records, so no
    // caller may widen it into a bulk export.
    expect(clampDrillDownLimit("100000")).toBe(DRILLDOWN_MAX_ROWS)
    expect(clampDrillDownLimit(Number.POSITIVE_INFINITY)).toBe(DRILLDOWN_DEFAULT_ROWS)
  })

  it("clamps the offset, so the order book cannot be walked through it", () => {
    expect(clampDrillDownOffset(undefined)).toBe(0)
    expect(clampDrillDownOffset("-10")).toBe(0)
    expect(clampDrillDownOffset("120")).toBe(120)
    expect(clampDrillDownOffset("999999")).toBe(DRILLDOWN_MAX_OFFSET)
  })

  it("accepts only allowlisted sort keys and falls back rather than failing open", () => {
    for (const key of DRILLDOWN_SORT_KEYS) expect(isDrillDownSortKey(key)).toBe(true)
    for (const attempt of [
      "value; DROP TABLE orders",
      "orders.total_cents",
      "(SELECT 1)",
      "",
      null,
      undefined,
      7,
    ]) {
      expect(isDrillDownSortKey(attempt)).toBe(false)
      expect(resolveDrillDownSort(attempt)).toBe("date")
    }
  })

  it("accepts only the two sort directions", () => {
    expect(resolveSortDirection("asc")).toBe("asc")
    expect(resolveSortDirection("desc")).toBe("desc")
    expect(resolveSortDirection("ASC")).toBe("desc")
    expect(resolveSortDirection("; --")).toBe("desc")
  })
})

describe("period keys", () => {
  it("recognises a month and rejects anything else shaped like one", () => {
    expect(isMonthKey("2025-03")).toBe(true)
    expect(isMonthKey("2025-13")).toBe(false)
    expect(isMonthKey("2025-00")).toBe(false)
    expect(isMonthKey("2025-3")).toBe(false)
    expect(isMonthKey("2025-03-01")).toBe(false)
  })

  it("recognises a day and rejects an impossible one", () => {
    expect(isDayKey("2025-03-17")).toBe(true)
    expect(isDayKey("2025-03-32")).toBe(false)
    expect(isDayKey("2025-03-00")).toBe(false)
    expect(isDayKey("2025-03")).toBe(false)
  })
})

describe("narrowing a window to a clicked bucket", () => {
  it("leaves an entity dimension's window alone", () => {
    const result = narrowWindowToPeriod(WINDOW.start, WINDOW.end, "branch", "12")
    expect(result).toEqual({ startDate: WINDOW.start, endDate: WINDOW.end })
  })

  it("narrows to the clicked month, whole month inside the window", () => {
    const result = narrowWindowToPeriod(WINDOW.start, WINDOW.end, "month", "2025-03")
    if ("ok" in result) throw new Error(result.error)
    expect(result.startDate.toISOString()).toBe("2025-02-28T19:00:00.000Z")
    // 31 March, end of day, in the application timezone.
    expect(result.endDate.toISOString()).toBe("2025-03-31T18:59:59.999Z")
  })

  it("gets the last day of a short month right", () => {
    const feb = narrowWindowToPeriod(WINDOW.start, WINDOW.end, "month", "2025-02")
    if ("ok" in feb) throw new Error(feb.error)
    expect(feb.endDate.toISOString()).toBe("2025-02-28T18:59:59.999Z")

    const leap = narrowWindowToPeriod(
      new Date("2024-01-01T00:00:00.000+05:00"),
      new Date("2024-12-31T23:59:59.999+05:00"),
      "month",
      "2024-02",
    )
    if ("ok" in leap) throw new Error(leap.error)
    expect(leap.endDate.toISOString()).toBe("2024-02-29T18:59:59.999Z")
  })

  it("intersects rather than replaces, so the rows match the bar that was clicked", () => {
    // A chart drawn for 1 Feb – 15 Mar has a March bar worth 1–15 March only.
    // Opening the whole of March would show money that bar never counted.
    const result = narrowWindowToPeriod(
      new Date("2025-02-01T00:00:00.000+05:00"),
      new Date("2025-03-15T23:59:59.999+05:00"),
      "month",
      "2025-03",
    )
    if ("ok" in result) throw new Error(result.error)
    expect(result.startDate.toISOString()).toBe("2025-02-28T19:00:00.000Z")
    expect(result.endDate.toISOString()).toBe("2025-03-15T18:59:59.999Z")
  })

  it("narrows to a single day", () => {
    const result = narrowWindowToPeriod(WINDOW.start, WINDOW.end, "day", "2025-03-17")
    if ("ok" in result) throw new Error(result.error)
    expect(result.startDate.toISOString()).toBe("2025-03-16T19:00:00.000Z")
    expect(result.endDate.toISOString()).toBe("2025-03-17T18:59:59.999Z")
  })

  it("refuses a bucket outside the window instead of returning an inverted one", () => {
    const result = narrowWindowToPeriod(WINDOW.start, WINDOW.end, "month", "2024-01")
    expect(result).toMatchObject({ ok: false })
  })

  it("refuses a malformed key", () => {
    expect(narrowWindowToPeriod(WINDOW.start, WINDOW.end, "month", "2025-99")).toMatchObject({ ok: false })
    expect(narrowWindowToPeriod(WINDOW.start, WINDOW.end, "day", "not-a-day")).toMatchObject({ ok: false })
  })
})

describe("parseDrillDownRequest", () => {
  it("accepts a branch drill and folds the key into the branch filter", () => {
    const parsed = parseDrillDownRequest(params({ dimension: "branch", metric: "spend", key: "42" }))
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.dimension).toBe("branch")
    expect(parsed.entityKey).toBe("42")
    expect(parsed.sort).toBe("date")
    expect(parsed.direction).toBe("desc")
    expect(parsed.limit).toBe(DRILLDOWN_DEFAULT_ROWS)
    expect(parsed.offset).toBe(0)
  })

  it("routes each dimension's key into that dimension's own filter", () => {
    const user = parseDrillDownRequest(params({
      dimension: "user",
      metric: "quantity",
      key: "3f7b5d2e-1a4c-4d5e-9f80-2b6c7d8e9f01",
    }))
    if (!user.ok) throw new Error(user.error)
    expect(user.userIds).toEqual(["3f7b5d2e-1a4c-4d5e-9f80-2b6c7d8e9f01"])

    const product = parseDrillDownRequest(params({ dimension: "product", metric: "quantity", key: "9" }))
    if (!product.ok) throw new Error(product.error)
    expect(product.productIds).toEqual([9])
  })

  it("keeps a focus that is not the clicked dimension", () => {
    // Clicking a requester on a chart focused to one product must show that
    // person's lines *for that product*, not everything they ever ordered.
    const parsed = parseDrillDownRequest(params({
      dimension: "user",
      metric: "spend",
      key: "3f7b5d2e-1a4c-4d5e-9f80-2b6c7d8e9f01",
      productIds: "9",
    }))
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.productIds).toEqual([9])
    expect(parsed.userIds).toEqual(["3f7b5d2e-1a4c-4d5e-9f80-2b6c7d8e9f01"])
  })

  it("narrows the window when a month bar was clicked", () => {
    const parsed = parseDrillDownRequest(params({ dimension: "month", metric: "spend", key: "2025-03" }))
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.startDate.toISOString()).toBe("2025-02-28T19:00:00.000Z")
    expect(parsed.endDate.toISOString()).toBe("2025-03-31T18:59:59.999Z")
  })

  it("narrows to one entity in one month when a trend point named both", () => {
    const parsed = parseDrillDownRequest(params({
      dimension: "user",
      metric: "quantity",
      key: "3f7b5d2e-1a4c-4d5e-9f80-2b6c7d8e9f01",
      period: "2025-04",
    }))
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.userIds).toEqual(["3f7b5d2e-1a4c-4d5e-9f80-2b6c7d8e9f01"])
    expect(parsed.startDate.toISOString()).toBe("2025-03-31T19:00:00.000Z")
    expect(parsed.endDate.toISOString()).toBe("2025-04-30T18:59:59.999Z")
    expect(parsed.period).toBe("2025-04")
  })

  it("refuses a malformed period rather than ignoring it", () => {
    // Ignoring it would silently widen the table past the point that was
    // clicked, which is the failure this endpoint exists to avoid.
    const parsed = parseDrillDownRequest(params({
      dimension: "branch",
      metric: "spend",
      key: "42",
      period: "whenever",
    }))
    expect(parsed).toMatchObject({ ok: false, error: "Invalid period" })
  })

  it("refuses an unknown dimension, metric, or unsupported pairing", () => {
    expect(parseDrillDownRequest(params({ dimension: "supplier", key: "1" }))).toMatchObject({ ok: false })
    expect(parseDrillDownRequest(params({ dimension: "branch", metric: "margin" }))).toMatchObject({ ok: false })
    expect(parseDrillDownRequest(params({ dimension: "day", metric: "utilization" }))).toMatchObject({ ok: false })
  })

  it("refuses a key that is not shaped like an id", () => {
    for (const key of ["1 OR 1=1", "../../etc", "'; DROP TABLE orders; --", "a".repeat(65)]) {
      expect(parseDrillDownRequest(params({ dimension: "branch", metric: "spend", key })))
        .toMatchObject({ ok: false, error: "Invalid entity key" })
    }
  })

  it("refuses a dimension reserved to another role, on the server", () => {
    const forbidden = parseDrillDownRequest(
      params({ dimension: "organization", metric: "spend", key: "2" }),
      new Date(),
      "HEAD_OFFICE",
    )
    expect(forbidden).toMatchObject({ ok: false, error: "Forbidden: Insufficient permissions" })

    const allowed = parseDrillDownRequest(
      params({ dimension: "organization", metric: "spend", key: "2" }),
      new Date(),
      "SUPER_ADMIN",
    )
    expect(allowed.ok).toBe(true)
  })

  it("clamps a caller-supplied page size and offset", () => {
    const parsed = parseDrillDownRequest(params({
      dimension: "branch",
      metric: "spend",
      key: "42",
      limit: "10000",
      offset: "9999999",
    }))
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.limit).toBe(DRILLDOWN_MAX_ROWS)
    expect(parsed.offset).toBe(DRILLDOWN_MAX_OFFSET)
  })

  it("defaults the metric so a chart that omits it still drills", () => {
    const parsed = parseDrillDownRequest(params({ dimension: "branch", key: "42" }))
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.metric).toBe("spend")
  })
})
