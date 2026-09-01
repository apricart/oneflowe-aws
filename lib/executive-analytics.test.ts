import { describe, expect, it } from "vitest"

import {
  DONUT_MAX_SLICES,
  EXECUTIVE_DIMENSIONS,
  EXECUTIVE_METRICS,
  MAX_COMPARE_ENTITIES,
  chartMode,
  chartTypesFor,
  classifyBudgetHealth,
  dimensionsForRole,
  isBudgetRollupDimension,
  isChartType,
  isDimensionAllowedForRole,
  metricsUnderLineFocus,
  clampRowLimit,
  countToReachShare,
  growthPct,
  isExecutiveAnalyticsRole,
  isSupportedCombination,
  resolveGrain,
  resolveQuantityUnit,
  safeDivide,
  utilizationPct,
  varianceCents,
  weightedAverageUnitPrice,
  withCumulativeShare,
} from "./executive-analytics"
import {
  ENTITY_KEY_PARAM,
  applyEntityKeys,
  parseComparisonRequest,
  parseExecutiveRequest,
  parseUuidList,
  previousWindow,
  sanitizeUnit,
} from "./executive-analytics-request"

describe("role gate", () => {
  it("admits only the two executive roles", () => {
    expect(isExecutiveAnalyticsRole("SUPER_ADMIN")).toBe(true)
    expect(isExecutiveAnalyticsRole("HEAD_OFFICE")).toBe(true)
    for (const role of ["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "GROUP_ORDER_PORTAL", "", null, undefined, 7]) {
      expect(isExecutiveAnalyticsRole(role)).toBe(false)
    }
  })
})

describe("the dimension × metric whitelist", () => {
  it("accepts only pairings the registry lists", () => {
    expect(isSupportedCombination("branch", "utilization")).toBe(true)
    expect(isSupportedCombination("branch", "avgUnitPrice")).toBe(true)
    // Utilization exists per branch budget; a category has no budget of its own.
    expect(isSupportedCombination("category", "utilization")).toBe(false)
    expect(isSupportedCombination("product", "avgOrderValue")).toBe(false)
    expect(isSupportedCombination("month", "utilization")).toBe(false)
  })

  it("rejects anything not in the registry", () => {
    expect(isSupportedCombination("supplier", "spend")).toBe(false)
    expect(isSupportedCombination("branch", "profit")).toBe(false)
    expect(isSupportedCombination("branch; DROP TABLE orders", "spend")).toBe(false)
    expect(isSupportedCombination(null, undefined)).toBe(false)
  })

  it("lists no metric a dimension cannot answer", () => {
    for (const dimension of Object.values(EXECUTIVE_DIMENSIONS)) {
      for (const metric of dimension.metrics) {
        expect(EXECUTIVE_METRICS[metric]).toBeDefined()
        expect(isSupportedCombination(dimension.id, metric)).toBe(true)
      }
    }
  })
})

describe("grain resolution guards against join fan-out", () => {
  it("keeps branch and month spend at order grain", () => {
    expect(resolveGrain("branch", "spend")).toBe("order")
    expect(resolveGrain("month", "orders")).toBe("order")
    expect(resolveGrain("branch", "avgOrderValue")).toBe("order")
  })

  it("moves to line grain whenever products or categories are involved", () => {
    expect(resolveGrain("category", "spend")).toBe("line")
    expect(resolveGrain("product", "orders")).toBe("line")
    expect(resolveGrain("branch", "quantity")).toBe("line")
    expect(resolveGrain("month", "avgUnitPrice")).toBe("line")
  })

  it("keeps budget metrics away from the orders table entirely", () => {
    expect(resolveGrain("branch", "utilization")).toBe("budget")
    expect(resolveGrain("branch", "budgetRemaining")).toBe("budget")
  })
})

describe("arithmetic survives the empty cases", () => {
  it("returns zero utilization for a branch with no budget", () => {
    expect(utilizationPct(500, 0)).toBe(0)
    expect(utilizationPct(0, 0)).toBe(0)
    expect(utilizationPct(0, 1000)).toBe(0)
  })

  it("computes utilization as consumed over total budget", () => {
    expect(utilizationPct(9_000, 10_000)).toBe(90)
    expect(utilizationPct(12_000, 10_000)).toBe(120)
  })

  it("reports variance as budget minus consumed, negative when overspent", () => {
    expect(varianceCents(10_000, 4_000)).toBe(6_000)
    expect(varianceCents(10_000, 14_000)).toBe(-4_000)
  })

  it("distinguishes 'no baseline' from 'no change'", () => {
    expect(growthPct(100, 0)).toBeNull()
    expect(growthPct(0, 0)).toBeNull()
    expect(growthPct(120, 100)).toBe(20)
    expect(growthPct(80, 100)).toBe(-20)
  })

  it("never divides by zero", () => {
    expect(safeDivide(10, 0)).toBe(0)
    expect(weightedAverageUnitPrice(0, 0)).toBe(0)
  })

  it("weights unit price by quantity rather than averaging averages", () => {
    // 100 units at 10, then 1 unit at 1000: the weighted answer stays near 10.
    const weighted = weightedAverageUnitPrice(100 * 10 + 1 * 1000, 101)
    expect(Math.round(weighted)).toBe(20)
    expect(weighted).toBeLessThan((10 + 1000) / 2)
  })
})

describe("budget health classification", () => {
  it("separates unbudgeted from underused", () => {
    expect(classifyBudgetHealth(0, 0)).toBe("unbudgeted")
    expect(classifyBudgetHealth(10_000, 1_000)).toBe("underused")
  })

  it("flags the warning band and true overspend", () => {
    expect(classifyBudgetHealth(10_000, 9_000)).toBe("warning")
    expect(classifyBudgetHealth(10_000, 10_000)).toBe("warning")
    expect(classifyBudgetHealth(10_000, 10_001)).toBe("over")
    expect(classifyBudgetHealth(10_000, 6_000)).toBe("healthy")
  })
})

describe("unit-of-measure safety", () => {
  it("totals freely when only one unit is in scope", () => {
    expect(resolveQuantityUnit(["pack"], null)).toEqual({ unit: "pack", conflict: false, units: ["pack"] })
  })

  it("refuses to total litres alongside packs", () => {
    const resolution = resolveQuantityUnit(["ltr", "pack"], null)
    expect(resolution.conflict).toBe(true)
    expect(resolution.unit).toBeNull()
    expect(resolution.units).toEqual(["ltr", "pack"])
  })

  it("accepts a requested unit only when it is genuinely in scope", () => {
    expect(resolveQuantityUnit(["ltr", "pack"], "pack").unit).toBe("pack")
    expect(resolveQuantityUnit(["ltr", "pack"], "kg").conflict).toBe(true)
  })

  it("reports no conflict when there is nothing to measure", () => {
    expect(resolveQuantityUnit([], null)).toEqual({ unit: null, conflict: false, units: [] })
  })
})

describe("concentration", () => {
  const rows = [{ v: 60 }, { v: 20 }, { v: 15 }, { v: 5 }]

  it("accumulates share largest-first", () => {
    const pareto = withCumulativeShare(rows, (row) => row.v)
    expect(pareto.map((row) => Math.round(row.share))).toEqual([60, 20, 15, 5])
    expect(pareto.map((row) => Math.round(row.cumulativeShare))).toEqual([60, 80, 95, 100])
  })

  it("answers how few rows carry 80% of the total", () => {
    expect(countToReachShare(withCumulativeShare(rows, (row) => row.v), 80)).toBe(2)
  })

  it("does not divide by zero on an all-zero series", () => {
    const pareto = withCumulativeShare([{ v: 0 }, { v: 0 }], (row) => row.v)
    expect(pareto.every((row) => row.share === 0 && row.cumulativeShare === 0)).toBe(true)
    expect(countToReachShare(pareto, 80)).toBe(2)
  })
})

describe("row limits", () => {
  it("clamps anything a caller sends into a bounded range", () => {
    expect(clampRowLimit("5")).toBe(5)
    expect(clampRowLimit("100000")).toBe(50)
    expect(clampRowLimit("-1")).toBe(12)
    expect(clampRowLimit("abc")).toBe(12)
    expect(clampRowLimit(null)).toBe(12)
  })
})

describe("request parsing", () => {
  const now = new Date("2026-08-31T12:00:00.000Z")

  it("refuses an unknown dimension or metric outright", () => {
    expect(parseComparisonRequest(new URLSearchParams("dimension=supplier&metric=spend"), now))
      .toEqual({ ok: false, error: "Unsupported dimension" })
    expect(parseComparisonRequest(new URLSearchParams("dimension=branch&metric=margin"), now))
      .toEqual({ ok: false, error: "Unsupported metric" })
  })

  it("refuses a pairing the registry does not list rather than silently defaulting", () => {
    const result = parseComparisonRequest(new URLSearchParams("dimension=category&metric=utilization"), now)
    expect(result.ok).toBe(false)
  })

  it("accepts a listed pairing", () => {
    const result = parseComparisonRequest(new URLSearchParams("dimension=branch&metric=utilization"), now)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dimension).toBe("branch")
    expect(result.metric).toBe("utilization")
  })

  it("rejects an inverted date range", () => {
    const result = parseExecutiveRequest(
      new URLSearchParams("startDate=2026-08-01&endDate=2026-07-01"),
      now,
    )
    expect(result).toEqual({ ok: false, error: "startDate must be on or before endDate" })
  })

  it("drops non-numeric and negative ids instead of passing them through", () => {
    const result = parseExecutiveRequest(new URLSearchParams("categoryIds=1,-2,abc,3,3"), now)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.categoryIds).toEqual([1, 3])
  })

  it("caps how many ids one request may filter on", () => {
    const many = Array.from({ length: 500 }, (_, index) => index + 1).join(",")
    const result = parseExecutiveRequest(new URLSearchParams(`productIds=${many}`), now)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.productIds).toHaveLength(100)
  })

  it("strips anything but plain identifier characters from a unit", () => {
    expect(sanitizeUnit("pack")).toBe("pack")
    expect(sanitizeUnit("ltr' OR 1=1--")).toBe("ltr OR 11--")
    expect(sanitizeUnit("   ")).toBeNull()
    expect(sanitizeUnit("x".repeat(65))).toBeNull()
  })

  it("defaults to a six-month window when none is given", () => {
    const result = parseExecutiveRequest(new URLSearchParams(), now)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.startDate.getFullYear()).toBe(2026)
    expect(result.startDate.getMonth()).toBe(2) // March, six months inclusive
  })
})

describe("previous period", () => {
  it("returns an equal-length window that does not overlap the current one", () => {
    const start = new Date("2026-08-01T00:00:00.000Z")
    const end = new Date("2026-08-31T23:59:59.999Z")
    const { previousStart, previousEnd } = previousWindow(start, end)

    expect(previousEnd.getTime()).toBe(start.getTime() - 1)
    expect(previousEnd.getTime() - previousStart.getTime()).toBe(end.getTime() - start.getTime())
    expect(previousEnd.getTime()).toBeLessThan(start.getTime())
  })
})

describe("role-gated dimensions", () => {
  it("offers the tenant comparison to the platform role only", () => {
    const superAdmin = dimensionsForRole("SUPER_ADMIN").map((entry) => entry.id)
    const headOffice = dimensionsForRole("HEAD_OFFICE").map((entry) => entry.id)

    expect(superAdmin).toContain("organization")
    expect(headOffice).not.toContain("organization")
    // Everything else stays available to both, so the gate is narrow.
    expect(headOffice).toEqual(superAdmin.filter((id) => id !== "organization"))
  })

  it("refuses the reserved dimension for every other role", () => {
    expect(isDimensionAllowedForRole("organization", "SUPER_ADMIN")).toBe(true)
    for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", null, undefined]) {
      expect(isDimensionAllowedForRole("organization", role)).toBe(false)
    }
    expect(isDimensionAllowedForRole("branch", "HEAD_OFFICE")).toBe(true)
  })

  it("rejects a reserved dimension at the request boundary, not just in the menu", () => {
    const params = new URLSearchParams("dimension=organization&metric=spend")
    expect(parseComparisonRequest(params, new Date(), "HEAD_OFFICE"))
      .toEqual({ ok: false, error: "Forbidden: Insufficient permissions" })
    expect(parseComparisonRequest(params, new Date(), "SUPER_ADMIN").ok).toBe(true)
  })
})

describe("budget metrics belong to budget-bearing entities", () => {
  it("offers them where a budget is held or rolls up, and nowhere else", () => {
    for (const dimension of ["branch", "group", "organization"] as const) {
      expect(isSupportedCombination(dimension, "utilization")).toBe(true)
      expect(isBudgetRollupDimension(dimension)).toBe(true)
    }
    for (const dimension of ["user", "product", "category", "month"] as const) {
      expect(isSupportedCombination(dimension, "utilization")).toBe(false)
      expect(isSupportedCombination(dimension, "budgetRemaining")).toBe(false)
      expect(isBudgetRollupDimension(dimension)).toBe(false)
    }
  })
})

describe("chart menu", () => {
  const menu = (over: Partial<Parameters<typeof chartTypesFor>[0]> = {}) =>
    chartTypesFor({ dimension: "product", metric: "spend", entityCount: 3, ...over })

  const usable = (options: ReturnType<typeof chartTypesFor>) =>
    options.filter((entry) => !entry.disabledReason).map((entry) => entry.id)

  it("always offers a table, so every chart has a readable alternative", () => {
    for (const dimension of Object.keys(EXECUTIVE_DIMENSIONS) as Array<keyof typeof EXECUTIVE_DIMENSIONS>) {
      for (const metric of EXECUTIVE_DIMENSIONS[dimension].metrics) {
        expect(usable(chartTypesFor({ dimension, metric, entityCount: 5 }))).toContain("table")
      }
    }
  })

  it("withholds a share chart from an average, with a reason", () => {
    const donut = menu({ metric: "avgUnitPrice" }).find((entry) => entry.id === "donut")
    expect(donut?.disabledReason).toMatch(/average, not a part of a whole/i)
  })

  it("withholds a share chart once there are too many slices to read", () => {
    expect(usable(menu({ entityCount: DONUT_MAX_SLICES }))).toContain("donut")
    const tooMany = menu({ entityCount: DONUT_MAX_SLICES + 1 }).find((entry) => entry.id === "donut")
    expect(tooMany?.disabledReason).toMatch(/Too many products/)
  })

  it("never ranks months, because that would destroy their order", () => {
    const options = usable(chartTypesFor({ dimension: "month", metric: "spend", entityCount: 6 }))
    expect(options).toEqual(["line", "column", "table"])
    expect(options).not.toContain("bar")
    expect(options).not.toContain("donut")
  })

  it("withholds trend and prior-period forms from a budget snapshot", () => {
    const options = chartTypesFor({ dimension: "branch", metric: "utilization", entityCount: 4 })
    expect(options.find((entry) => entry.id === "line")?.disabledReason).toBeTruthy()
    expect(options.find((entry) => entry.id === "grouped")?.disabledReason).toBeTruthy()
    expect(options.find((entry) => entry.id === "scatter")?.disabledReason).toBeTruthy()
    expect(usable(options)).toEqual(["bar", "column", "table"])
  })

  it("routes only the trend form through the series response shape", () => {
    expect(chartMode("line")).toBe("series")
    for (const chart of ["bar", "column", "grouped", "donut", "scatter", "table"] as const) {
      expect(chartMode(chart)).toBe("rank")
    }
  })

  it("rejects a chart type that is not in the registry", () => {
    expect(isChartType("treemap")).toBe(false)
    expect(isChartType("sankey")).toBe(false)
    expect(isChartType("bar")).toBe(true)
    expect(parseComparisonRequest(
      new URLSearchParams("dimension=branch&metric=spend&chart=treemap"),
    )).toEqual({ ok: false, error: "Unsupported chart type" })
  })
})

describe("entity selection", () => {
  it("routes each dimension's keys to the parameter that dimension uses", () => {
    expect(ENTITY_KEY_PARAM.branch).toBe("branchIds")
    expect(ENTITY_KEY_PARAM.organization).toBe("organizationIds")
    expect(ENTITY_KEY_PARAM.user).toBe("userIds")
    expect(ENTITY_KEY_PARAM.month).toBeNull()
  })

  it("folds branch keys into the scope parameter, so they get intersected", () => {
    const merged = applyEntityKeys(new URLSearchParams("keys=4,9"), "branch")
    expect(merged.get("branchIds")).toBe("4,9")
  })

  it("replaces rather than merges, so a stale filter cannot narrow a new pick", () => {
    const merged = applyEntityKeys(new URLSearchParams("keys=4&branchIds=99"), "branch")
    expect(merged.get("branchIds")).toBe("4")
  })

  it("leaves months alone, since they are an axis rather than a set", () => {
    const merged = applyEntityKeys(new URLSearchParams("keys=2026-01"), "month")
    expect(merged.get("keys")).toBe("2026-01")
    expect(merged.get("branchIds")).toBeNull()
  })

  it("caps how many entities one request may compare", () => {
    const many = Array.from({ length: 80 }, (_, index) => index + 1).join(",")
    const merged = applyEntityKeys(new URLSearchParams(`keys=${many}`), "branch")
    expect(merged.get("branchIds")!.split(",")).toHaveLength(MAX_COMPARE_ENTITIES)
  })

  it("drops anything not shaped like a user id rather than passing it to Postgres", () => {
    expect(parseUuidList("not-a-uuid,123")).toEqual([])
    expect(parseUuidList("3f2504e0-4f89-11d3-9a0c-0305e82c3301"))
      .toEqual(["3f2504e0-4f89-11d3-9a0c-0305e82c3301"])
    expect(parseUuidList("3f2504e0-4f89-11d3-9a0c-0305e82c3301'; DROP TABLE orders--")).toEqual([])
  })
})

describe("focusing on products changes what spend may mean", () => {
  it("moves order-grain spend to line grain once a product focus is active", () => {
    // Without a focus, "spend by branch" is the branch's whole order value.
    expect(resolveGrain("branch", "spend")).toBe("order")
    // With one, it must be only the focused product's lines. Order grain here
    // sums every order that merely contained the product — measured 5.7x too
    // high against real data before this rule existed.
    expect(resolveGrain("branch", "spend", { lineScoped: true })).toBe("line")
    expect(resolveGrain("user", "spend", { lineScoped: true })).toBe("line")
    expect(resolveGrain("organization", "spend", { lineScoped: true })).toBe("line")
    expect(resolveGrain("group", "spend", { lineScoped: true })).toBe("line")
  })

  it("leaves counts and budgets alone, which a focus does not distort", () => {
    // COUNT(DISTINCT order) is the same number at either grain.
    expect(resolveGrain("branch", "orders", { lineScoped: true })).toBe("order")
    // A budget is held against the branch, not against a product.
    expect(resolveGrain("branch", "utilization", { lineScoped: true })).toBe("budget")
    expect(resolveGrain("branch", "budgetRemaining", { lineScoped: true })).toBe("budget")
  })

  it("keeps already-line-grain metrics unchanged", () => {
    for (const metric of ["quantity", "avgUnitPrice"] as const) {
      expect(resolveGrain("branch", metric)).toBe("line")
      expect(resolveGrain("branch", metric, { lineScoped: true })).toBe("line")
    }
  })

  it("withdraws average order value while a focus is on", () => {
    const withFocus = metricsUnderLineFocus(EXECUTIVE_DIMENSIONS.branch.metrics)
    // It would be the average of whole orders containing the product, which
    // reads as the product's own average and is not.
    expect(withFocus).not.toContain("avgOrderValue")
    expect(withFocus).toContain("spend")
    expect(withFocus).toContain("quantity")
    expect(withFocus).toContain("utilization")
  })
})
