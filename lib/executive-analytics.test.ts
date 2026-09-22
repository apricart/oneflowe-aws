import { describe, expect, it } from "vitest"

import {
  BUDGET_BESIDE_DIMENSIONS,
  DONUT_MAX_SLICES,
  EXECUTIVE_DIMENSIONS,
  EXECUTIVE_METRICS,
  MATRIX_DEFAULT_ENTITIES,
  MATRIX_DIMENSIONS,
  MATRIX_MAX_ENTITIES,
  MATRIX_METRICS,
  MAX_COMPARE_ENTITIES,
  budgetBesideWithheldReason,
  canShowBudgetBeside,
  chartMode,
  chartTypesFor,
  classifyBudgetHealth,
  clampMatrixLimit,
  dimensionsForRole,
  isBudgetBesideDimension,
  isBudgetRollupDimension,
  isChartType,
  isDimensionAllowedForRole,
  isMatrixDimension,
  isMatrixMetric,
  isSupportedMatrix,
  metricsUnderLineFocus,
  clampRowLimit,
  countToReachShare,
  growthPct,
  isExecutiveAnalyticsRole,
  isSupportedCombination,
  orderComparisonRows,
  resolveGrain,
  resolveMatrixGrain,
  resolveQuantityUnit,
  safeDivide,
  utilizationPct,
  varianceCents,
  weightedAverageUnitPrice,
  withCumulativeShare,
} from "./executive-analytics"
import {
  ENTITY_KEY_PARAM,
  SCOPE_KEYED_DIMENSIONS,
  applyEntityKeys,
  isScopeKeyedDimension,
  parseComparisonRequest,
  parseExecutiveRequest,
  parseMatrixRequest,
  parseUuidList,
  previousWindow,
  sanitizeUnit,
} from "./executive-analytics-request"

describe("role gate", () => {
  it("admits only the roles whose reach spans more than one branch", () => {
    expect(isExecutiveAnalyticsRole("SUPER_ADMIN")).toBe(true)
    expect(isExecutiveAnalyticsRole("HEAD_OFFICE")).toBe(true)
    // The multi-branch approver reads over its assigned branch set.
    expect(isExecutiveAnalyticsRole("GROUP_USER")).toBe(true)
    // The ordering group role raises orders and has no reporting surface, and
    // a single-branch role has nothing to compare side by side.
    for (const role of ["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_ORDER_PORTAL", "group_user", "", null, undefined, 7]) {
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

describe("row order", () => {
  // Months whose figures rise, so size order and time order disagree.
  const months = [
    { key: "2026-03", value: 2350 },
    { key: "2026-01", value: 6810 },
    { key: "2026-02", value: 4370 },
  ]

  it("keeps a time axis in its own order, whatever the figures", () => {
    expect(orderComparisonRows(months, "month").map((row) => row.key)).toEqual(["2026-01", "2026-02", "2026-03"])
    const days = months.map((row) => ({ ...row, key: `${row.key}-15` }))
    expect(orderComparisonRows(days, "day").map((row) => row.key)).toEqual(["2026-01-15", "2026-02-15", "2026-03-15"])
  })

  it("ranks every other dimension largest first", () => {
    const entities = [{ key: "b", value: 5 }, { key: "a", value: 20 }, { key: "c", value: 15 }]
    for (const dimension of ["branch", "user", "product", "category", "group", "organization"] as const) {
      expect(orderComparisonRows(entities, dimension).map((row) => row.key), dimension).toEqual(["a", "c", "b"])
    }
  })

  it("returns a new array and leaves the input alone", () => {
    const input = [...months]
    const output = orderComparisonRows(input, "month")
    expect(output).not.toBe(input)
    expect(input).toEqual(months)
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
    expect(result.withBudget).toBe(false)
  })

  it("reads the budget flag as an exact match and nothing looser", () => {
    // `budget` is a request for the budget beside the bars, not a grant: the
    // route still applies the withholding rule. Only the literal "1" counts.
    const parse = (query: string) => parseComparisonRequest(new URLSearchParams(query), now)
    expect(parse("dimension=branch&metric=spend&budget=1")).toMatchObject({ ok: true, withBudget: true })
    for (const value of ["true", "yes", "0", "", "2"]) {
      expect(parse(`dimension=branch&metric=spend&budget=${value}`), value).toMatchObject({ ok: true, withBudget: false })
    }
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

describe("grid request parsing", () => {
  const now = new Date("2026-08-31T12:00:00.000Z")
  const parse = (query: string, role?: unknown) => parseMatrixRequest(new URLSearchParams(query), now, role)

  it("accepts requesters against products and carries every shared filter through", () => {
    const result = parse(
      "rows=user&columns=product&metric=spend&productIds=186,187&userIds=8b1a0d3e-5a2f-4c1d-9e7b-1f2a3b4c5d6e"
      + "&categoryIds=4&groupIds=2&startDate=2026-06-01&endDate=2026-08-31&limit=5",
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toBe("user")
    expect(result.columns).toBe("product")
    expect(result.metric).toBe("spend")
    expect(result.limit).toBe(5)
    expect(result.productIds).toEqual([186, 187])
    expect(result.userIds).toEqual(["8b1a0d3e-5a2f-4c1d-9e7b-1f2a3b4c5d6e"])
    expect(result.categoryIds).toEqual([4])
    expect(result.groupIds).toEqual([2])
    expect(result.startDate.toISOString().slice(0, 10)).toBe("2026-05-31")
  })

  it("refuses each half of an unlisted grid with its own message, never a default", () => {
    expect(parse("rows=month&columns=product&metric=spend")).toEqual({ ok: false, error: "Unsupported row dimension" })
    expect(parse("rows=user&columns=group&metric=spend")).toEqual({ ok: false, error: "Unsupported column dimension" })
    expect(parse("rows=user&columns=user&metric=spend")).toEqual({ ok: false, error: "Rows and columns must be different dimensions" })
    expect(parse("rows=user&columns=product&metric=utilization")).toEqual({ ok: false, error: "Unsupported metric" })
    expect(parse("rows=user&columns=product&metric=avgOrderValue")).toEqual({ ok: false, error: "Unsupported metric" })
    expect(parse("columns=product&metric=spend")).toEqual({ ok: false, error: "Unsupported row dimension" })
    expect(parse("rows=user&columns=product")).toEqual({ ok: false, error: "Unsupported metric" })
  })

  it("clamps the per-axis limit so the grid is bounded whatever is asked", () => {
    const wide = parse("rows=user&columns=product&metric=quantity&limit=9999")
    expect(wide.ok && wide.limit).toBe(MATRIX_MAX_ENTITIES)
    const unset = parse("rows=user&columns=product&metric=quantity")
    expect(unset.ok && unset.limit).toBe(MATRIX_DEFAULT_ENTITIES)
  })

  it("still refuses an inverted window like every other request", () => {
    expect(parse("rows=user&columns=product&metric=spend&startDate=2026-08-01&endDate=2026-07-01"))
      .toEqual({ ok: false, error: "startDate must be on or before endDate" })
  })

  it("admits every executive role, since no grid dimension is reserved", () => {
    for (const role of ["SUPER_ADMIN", "HEAD_OFFICE", "GROUP_USER"]) {
      expect(parse("rows=user&columns=product&metric=spend", role).ok, role).toBe(true)
    }
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
    const groupUser = dimensionsForRole("GROUP_USER").map((entry) => entry.id)

    expect(superAdmin).toContain("organization")
    expect(headOffice).not.toContain("organization")
    expect(groupUser).not.toContain("organization")
    // Everything else stays available to every admitted role, so the gate is
    // narrow — the approver's menu is Head Office's menu.
    expect(headOffice).toEqual(superAdmin.filter((id) => id !== "organization"))
    expect(groupUser).toEqual(headOffice)
  })

  it("refuses the reserved dimension for every other role", () => {
    expect(isDimensionAllowedForRole("organization", "SUPER_ADMIN")).toBe(true)
    for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", null, undefined]) {
      expect(isDimensionAllowedForRole("organization", role)).toBe(false)
    }
    expect(isDimensionAllowedForRole("branch", "HEAD_OFFICE")).toBe(true)
    expect(isDimensionAllowedForRole("branch", "GROUP_USER")).toBe(true)
    expect(isDimensionAllowedForRole("group", "GROUP_USER")).toBe(true)
  })

  it("rejects a reserved dimension at the request boundary, not just in the menu", () => {
    const params = new URLSearchParams("dimension=organization&metric=spend")
    expect(parseComparisonRequest(params, new Date(), "HEAD_OFFICE"))
      .toEqual({ ok: false, error: "Forbidden: Insufficient permissions" })
    expect(parseComparisonRequest(params, new Date(), "GROUP_USER"))
      .toEqual({ ok: false, error: "Forbidden: Insufficient permissions" })
    expect(parseComparisonRequest(params, new Date(), "SUPER_ADMIN").ok).toBe(true)
  })
})

describe("a budget beside the bars", () => {
  const clear = { lineScoped: false, userScoped: false }

  it("stands only beside the entities a budget is held against, and the month the ledger is kept by", () => {
    expect(BUDGET_BESIDE_DIMENSIONS).toEqual(["branch", "group", "organization", "month"])
    for (const dimension of BUDGET_BESIDE_DIMENSIONS) {
      expect(isBudgetBesideDimension(dimension)).toBe(true)
      expect(canShowBudgetBeside(dimension, "spend", clear), dimension).toBe(true)
    }
    for (const dimension of ["user", "product", "category", "day"] as const) {
      expect(isBudgetBesideDimension(dimension)).toBe(false)
      expect(canShowBudgetBeside(dimension, "spend", clear), dimension).toBe(false)
      expect(budgetBesideWithheldReason(dimension, "spend", clear)).toMatch(/held per branch and per month/)
    }
    expect(isBudgetBesideDimension("supplier")).toBe(false)
  })

  it("is withheld for anything but money, and says so", () => {
    // Budget is money. Quantity, order counts and averages have nothing to
    // stand beside it — and the budget metrics themselves *are* the budget.
    for (const metric of ["quantity", "orders", "avgOrderValue", "avgUnitPrice", "utilization", "budgetRemaining"] as const) {
      expect(canShowBudgetBeside("branch", metric, clear), metric).toBe(false)
      expect(budgetBesideWithheldReason("branch", metric, clear)).toMatch(/only when measuring by amount/)
    }
  })

  it("is withheld under a product, category or requester narrowing it cannot follow, naming the narrowing", () => {
    // A branch's whole budget beside its spend on one product, or beside two
    // people's share of it, would be apples against oranges. Withheld, never
    // approximated — and the reason names what to clear.
    expect(budgetBesideWithheldReason("branch", "spend", { lineScoped: true, userScoped: false }))
      .toMatch(/not per product.*Clear the product focus/)
    expect(budgetBesideWithheldReason("month", "spend", { lineScoped: false, userScoped: true }))
      .toMatch(/not per requester.*Clear the requesters/)
    // The product reason wins when both apply: clearing it is the first step.
    expect(budgetBesideWithheldReason("branch", "spend", { lineScoped: true, userScoped: true })).toMatch(/not per product/)
    expect(canShowBudgetBeside("branch", "spend", { lineScoped: true, userScoped: false })).toBe(false)
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

describe("the two-way grid whitelist", () => {
  it("lays out only entity dimensions whose keys fold back into a filter", () => {
    expect([...MATRIX_DIMENSIONS].sort()).toEqual(["branch", "category", "product", "user"])
    for (const dimension of MATRIX_DIMENSIONS) expect(isMatrixDimension(dimension)).toBe(true)
    // A period is not a thing to cross with another; a group or a tenant is
    // resolved into the branch fence upstream, never filtered downstream.
    for (const dimension of ["month", "day", "group", "organization", "", null, 3]) {
      expect(isMatrixDimension(dimension)).toBe(false)
    }
  })

  it("answers requester against product under both measures, and against branch and category", () => {
    expect(isSupportedMatrix("user", "product", "spend")).toBe(true)
    expect(isSupportedMatrix("user", "product", "quantity")).toBe(true)
    expect(isSupportedMatrix("product", "user", "spend")).toBe(true)
    expect(isSupportedMatrix("user", "branch", "spend")).toBe(true)
    expect(isSupportedMatrix("category", "branch", "orders")).toBe(true)
    expect(isSupportedMatrix("product", "branch", "avgUnitPrice")).toBe(true)
  })

  it("refuses the same axis twice, a budget figure, and the average order value", () => {
    expect(isSupportedMatrix("user", "user", "spend")).toBe(false)
    // A budget is held per branch; "Ahmed's budget for toner" does not exist.
    expect(isSupportedMatrix("user", "branch", "utilization")).toBe(false)
    expect(isSupportedMatrix("user", "branch", "budgetRemaining")).toBe(false)
    // The average of whole orders that happened to contain the product is not
    // the product's own average — withdrawn for the reason `metricsUnderLineFocus` gives.
    expect(isSupportedMatrix("user", "product", "avgOrderValue")).toBe(false)
    expect(isSupportedMatrix("user", "branch", "avgOrderValue")).toBe(false)
    expect(isMatrixMetric("avgOrderValue")).toBe(false)
    expect(isMatrixMetric("utilization")).toBe(false)
    for (const metric of MATRIX_METRICS) expect(isMatrixMetric(metric)).toBe(true)
  })

  it("refuses a dimension the grid does not lay out, whatever the metric", () => {
    expect(isSupportedMatrix("group", "product", "spend")).toBe(false)
    expect(isSupportedMatrix("organization", "user", "spend")).toBe(false)
    expect(isSupportedMatrix("month", "product", "spend")).toBe(false)
    expect(isSupportedMatrix(undefined, "product", "spend")).toBe(false)
    expect(isSupportedMatrix("user", "product", "nope")).toBe(false)
  })

  it("bounds each axis so a grid can never be wider than the screen can read", () => {
    expect(clampMatrixLimit(undefined)).toBe(MATRIX_DEFAULT_ENTITIES)
    expect(clampMatrixLimit("0")).toBe(MATRIX_DEFAULT_ENTITIES)
    expect(clampMatrixLimit("abc")).toBe(MATRIX_DEFAULT_ENTITIES)
    expect(clampMatrixLimit("5")).toBe(5)
    expect(clampMatrixLimit("500")).toBe(MATRIX_MAX_ENTITIES)
    expect(MATRIX_MAX_ENTITIES).toBeLessThanOrEqual(MAX_COMPARE_ENTITIES)
  })

  it("runs at line grain the moment a product or category is on either axis", () => {
    expect(resolveMatrixGrain("user", "product", "spend")).toBe("line")
    expect(resolveMatrixGrain("product", "user", "spend")).toBe("line")
    expect(resolveMatrixGrain("category", "branch", "orders")).toBe("line")
    // Two whole-order entities in money stay at order grain — until a focus
    // narrows the question to particular products.
    expect(resolveMatrixGrain("user", "branch", "spend")).toBe("order")
    expect(resolveMatrixGrain("user", "branch", "orders")).toBe("order")
    expect(resolveMatrixGrain("user", "branch", "spend", { lineScoped: true })).toBe("line")
    expect(resolveMatrixGrain("user", "branch", "quantity")).toBe("line")
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
    expect(ENTITY_KEY_PARAM.group).toBe("groupIds")
    expect(ENTITY_KEY_PARAM.user).toBe("userIds")
    expect(ENTITY_KEY_PARAM.month).toBeNull()
  })

  it("folds exactly the dimensions the scope resolver reads into the scope, before the fence", () => {
    // The resolver reads branchIds, organizationIds and groupIds; a picked
    // entity of any of those kinds must be intersected with the caller's own
    // reach rather than applied as a filter afterwards. The two lists are one
    // decision, so they are asserted together.
    expect([...SCOPE_KEYED_DIMENSIONS]).toEqual(["branch", "organization", "group"])
    for (const dimension of SCOPE_KEYED_DIMENSIONS) {
      expect(isScopeKeyedDimension(dimension)).toBe(true)
      expect(ENTITY_KEY_PARAM[dimension]).toMatch(/Ids$/)
    }
    for (const other of ["user", "category", "product", "month", "day", "nonsense", null, undefined]) {
      expect(isScopeKeyedDimension(other), String(other)).toBe(false)
    }
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
