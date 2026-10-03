import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Contract tests for the aggregation layer's two structural invariants.
 *
 * Both of these shipped broken once and were caught only in the browser, so
 * they are pinned here rather than left to review:
 *
 *  1. The category filter must not name a table the query has not joined.
 *     `loadUnitsInScope`, `loadPriceVariance` and `loadProductPriceByBranch`
 *     read `order_items` alone, so a predicate on `global_products` raised
 *     "missing FROM-clause entry for table global_products" — a 500, not a
 *     narrower result.
 *
 *  2. The category filter must match through the hierarchy. Products are
 *     attached to subcategories while the filter offers top-level categories,
 *     so matching the selected ids literally emptied every chart silently.
 *
 * Read as source because the invariant is about the *shape* of the query the
 * builders construct, which is what regressed. Line endings are normalized so
 * the assertions hold on a CRLF checkout.
 */
const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")

const queries = source("lib/server/executive-analytics-queries.ts")

/** The bodies of the builders that read `order_items` without the product join. */
function builderBody(name: string) {
  const start = queries.indexOf(`export async function ${name}(`)
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const next = queries.indexOf("\nexport ", start + 1)
  return queries.slice(start, next === -1 ? undefined : next)
}

describe("category filtering is join-free", () => {
  it("filters products through a subquery, never a predicate on a joined table", () => {
    // The broken form. If this ever comes back, the three product-join-free
    // builders start returning 500 the moment a category is selected.
    expect(queries).not.toContain("inArray(globalProducts.categoryId, filters.categoryIds)")
    expect(queries).toContain("function categoryProductFilter(categoryIds: number[])")
    expect(queries).toContain("categoryProductFilter(filters.categoryIds)")
  })

  it("keeps the filter anchored on order_items, which every builder has", () => {
    const helper = queries.slice(
      queries.indexOf("function categoryProductFilter"),
      queries.indexOf("function lineFilterConditions"),
    )
    expect(helper).toContain("orderItems.globalProductId")
  })

  it.each([
    ["loadUnitsInScope"],
    ["loadPriceVariance"],
    ["loadProductPriceByBranch"],
  ])("%s still reads order_items without joining the product tables", (name) => {
    const body = builderBody(name)
    // These deliberately do not join global_products — which is exactly why the
    // filter must not depend on it.
    expect(body).not.toContain(".leftJoin(globalProducts")
    expect(body).not.toContain(".innerJoin(globalProducts")
    expect(body).toContain("lineConditions(scope")
  })
})

describe("category grouping rolls subcategories up", () => {
  it("matches a selected category and its children", () => {
    const helper = queries.slice(
      queries.indexOf("function categoryProductFilter"),
      queries.indexOf("function lineFilterConditions"),
    )
    expect(helper).toContain("inArray(categories.id, categoryIds)")
    expect(helper).toContain("inArray(categories.parentId, categoryIds)")
  })

  it("reports category figures against the top-level parent", () => {
    expect(queries).toContain('const parentCategories = alias(categories, "parent_categories")')
    // Both category-grouped builders join the parent and coalesce onto it, so a
    // chart's groups use the same vocabulary as the filter that narrows them.
    expect(queries).toContain("COALESCE(${parentCategories.id}, ${categories.id})")
    expect(queries).toContain("COALESCE(${parentCategories.name}, ${categories.name})")
    // Every builder that can group or list by category must join the parent,
    // or that one would report subcategories while the rest report parents.
    for (const name of [
      "loadLineGrainSeries",
      "loadBranchCategoryMatrix",
      "loadEntityOptions",
      "loadEntitySeries",
    ]) {
      expect(
        builderBody(name),
        `${name} groups or lists by category and must roll up to the parent`,
      ).toContain(".leftJoin(parentCategories, eq(categories.parentId, parentCategories.id))")
    }
  })
})

describe("grain separation", () => {
  it("never sums order totals in a line-grain builder", () => {
    for (const name of ["loadLineGrainSeries", "loadBranchCategoryMatrix", "loadPriceVariance"]) {
      expect(builderBody(name)).not.toContain("orders.totalCents")
    }
  })

  it("never joins order_items in an order-grain builder", () => {
    for (const name of ["loadOrderGrainSeries", "loadStatusComposition", "loadAgingPendingOrders"]) {
      const body = builderBody(name)
      expect(body).not.toContain(".innerJoin(orderItems")
      expect(body).not.toContain(".leftJoin(orderItems")
    }
  })
})

/**
 * The drill-down is the one builder in this file that returns individual order
 * lines rather than an aggregate, so the properties that keep it safe are
 * structural and are pinned here rather than left to review.
 */
const drillDownRoute = source("app/api/v1/analytics/executive/drill-down/route.ts")

describe("the drill-down listing", () => {
  it("applies the same tenant fence every aggregate builder does", () => {
    const body = builderBody("loadDrillDownLines")
    // Not a hand-written where clause: the fence has one implementation and
    // this listing must not become a second one that can drift from it.
    expect(body).toContain("lineConditions(scope, filters)")
    expect(body).not.toContain("inArray(orders.branchId")
  })

  it("includes pending only through the allowlisted consumed status set", () => {
    // The status predicate is chosen from two pre-written filters by a typed
    // flag; neither the flag nor a status name is ever interpolated.
    expect(queries).toContain('return filters.statusSet === "consumed" ? CONSUMED_ELIGIBLE_FILTER : REVENUE_ELIGIBLE_FILTER')
    expect(queries).not.toContain("REVENUE_ELIGIBLE_FILTER,\n")
    // Product Performance's aggregates, pickers, grid, and detail all pass the
    // same parsed selection. Overview remains on its established mixed metrics.
    for (const route of ["compare", "matrix", "options", "drill-down"]) {
      expect(source(`app/api/v1/analytics/executive/${route}/route.ts`), route)
        .toContain("statusSet: parsed.statusSet")
    }
    expect(source("app/api/v1/analytics/executive/overview/route.ts")).not.toContain("statusSet: parsed.statusSet")
  })

  it("aggregates the status-filtered order rows without a second revenue-only CASE", () => {
    expect(queries).toContain("const filteredOrderNetValue")
    expect(queries).toContain("const filteredOrderCount")
    expect(queries).not.toContain("metricExpressions.revenue")
    expect(queries).not.toContain("metricExpressions.orderVolume")
  })

  it("sorts only through the allowlisted expression map", () => {
    const body = builderBody("loadDrillDownLines")
    expect(body).toContain("DRILLDOWN_SORT_EXPRESSIONS[sortKey]")
    // A sort key is the classic path from a request string into an ORDER BY.
    expect(body).not.toContain("sql.raw")
    expect(body).not.toMatch(/orderBy\([^)]*options\.sort/)
  })

  it("pages deterministically, so a retry cannot repeat or skip a line", () => {
    // Every line of one order shares a timestamp, so the sort needs a tiebreak.
    expect(builderBody("loadDrillDownLines")).toContain("desc(orderItems.id)")
  })

  it("bounds the page it reads", () => {
    const body = builderBody("loadDrillDownLines")
    expect(body).toContain(".limit(options.limit + 1)")
    expect(body).toContain(".offset(options.offset)")
  })
})

describe("the drill-down route", () => {
  it("resolves the caller's scope rather than reading a branch from the request", () => {
    expect(drillDownRoute).toContain("resolveExecutiveScope(session, scopeParams)")
    expect(drillDownRoute).toContain("if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })")
  })

  it("folds a branch or organization key into the scope before the fence is resolved", () => {
    // Ordering matters: a key merged after scope resolution would be trusted
    // instead of intersected with what the caller may already see.
    const scopeFold = drillDownRoute.indexOf("applyEntityKeys")
    const scopeResolve = drillDownRoute.indexOf("await resolveExecutiveScope")
    expect(scopeFold).toBeGreaterThan(-1)
    expect(scopeResolve).toBeGreaterThan(scopeFold)
  })

  it("re-validates every parameter through the shared parser", () => {
    expect(drillDownRoute).toContain("parseDrillDownRequest(url.searchParams, new Date(), scope.role)")
  })

  it("is rate limited, being a listing endpoint", () => {
    expect(drillDownRoute).toContain('withRateLimit("search"')
  })

  it("never returns an internal error message to the caller", () => {
    expect(drillDownRoute).toContain('{ error: "Internal Server Error" }')
    expect(drillDownRoute).not.toMatch(/error:\s*(caught)?[eE]rror\b/)
  })
})

describe("entity picker keys are unique per entity", () => {
  /**
   * The picker keys its rows by entity id and the focus filter narrows by that
   * same id, so a list with one id on two rows both duplicates a React key and
   * makes ticking one row tick both. Both happened: a product sold per Piece and
   * per Box was grouped on its unit, and a group requester was grouped on the
   * branch of each order. Neither attribute may be a grouping column here; both
   * belong in the hint.
   */
  const options = builderBody("loadEntityOptions")

  function groupByClauses(body: string) {
    return Array.from(body.matchAll(/\.groupBy\(([^)]*)\)/g)).map((match) => match[1])
  }

  it("lists a product once, whatever units it was sold in", () => {
    const productGroup = groupByClauses(options).find((clause) => clause.includes("orderItems.globalProductId"))
    expect(productGroup).toBeDefined()
    expect(productGroup).not.toContain("orderItems.unit")
    expect(options).toContain("STRING_AGG(DISTINCT ${orderItems.unit}")
  })

  it("lists a person once, whichever branches they ordered for", () => {
    const userGroup = groupByClauses(options).find((clause) => clause.includes("orders.createdByUserId"))
    expect(userGroup).toBeDefined()
    expect(userGroup).not.toContain("branches.name")
    expect(options).toContain("STRING_AGG(DISTINCT ${branches.name}")
  })

  it("gives every drill-down row the order line's own id as its identity", () => {
    // An order can carry the same product twice at the same price and
    // quantity, so nothing short of the line id is unique per row.
    const drill = builderBody("loadDrillDownLines")
    expect(drill).toContain("lineId: orderItems.id")
    expect(source("components/reports/executive/drill-down-panel.tsx")).toContain("key={row.lineId}")
  })
})

/**
 * The grid is the one builder that pins its own key lists back into SQL, so
 * the properties that keep it fenced and bounded are structural and are pinned
 * here; the figures themselves are checked by the integration suite.
 */
describe("the requester × product grid", () => {
  const grid = builderBody("loadMatrix")

  it("ranks both axes with the same builder the single-dimension panels use", () => {
    // The margins must *be* the bars of "By requester" and "By product", not a
    // second aggregation that could drift from them.
    expect(grid.match(/loadComparison\(scope, filters, (rows|columns), metric, limit\)/g)).toHaveLength(2)
  })

  it("fences the cells through the shared conditions at either grain, never a hand-written where", () => {
    expect(grid).toContain("lineConditions(scope, filters)")
    expect(grid).toContain("orderConditions(scope, filters)")
    expect(grid).not.toContain("inArray(orders.organizationId")
    expect(grid).not.toContain("sql.raw")
  })

  it("pins the cells to the ranked members on both sides, so the read is bounded by limit × limit", () => {
    expect(grid).toContain("matrixAxisCondition(rows, rowAxis)")
    expect(grid).toContain("matrixAxisCondition(columns, columnAxis)")
    // And only through the helper, which binds ids as parameters.
    const helper = queries.slice(
      queries.indexOf("function matrixAxisCondition"),
      queries.indexOf("export async function loadMatrix"),
    )
    expect(helper).toContain("inArray(orders.createdByUserId, axis.uuids)")
    expect(helper).toContain("inArray(orderItems.globalProductId, axis.ids)")
    expect(helper).toContain("categoryProductFilter(axis.ids)")
    expect(helper).toContain("inArray(orders.branchId, axis.ids)")
  })

  it("keeps the grain rule: order grain never joins order_items, line grain never sums order totals", () => {
    const orderHalf = grid.slice(grid.indexOf(": await db"), grid.indexOf("const valueOf"))
    expect(orderHalf).not.toContain("orderItems")
    const lineHalf = grid.slice(grid.indexOf("? await db"), grid.indexOf(": await db"))
    expect(lineHalf).not.toContain("orders.totalCents")
    expect(lineHalf).toContain("lineNetValue")
    expect(lineHalf).toContain(".leftJoin(parentCategories, eq(categories.parentId, parentCategories.id))")
  })

  it("keys the cells with the same expressions the axes were ranked by", () => {
    expect(grid).toContain("row: lineDimensionColumns[rows].key")
    expect(grid).toContain("column: lineDimensionColumns[columns].key")
    expect(grid).toContain("row: orderDimensionColumns[rows as OrderGrainDimension].key")
  })
})

/**
 * Order-grain rows report no quantity of their own, so the quantity printed
 * over a requester, branch or month column is read from the lines. The read is
 * the one place that pins a ranked key list back into a line query, so its
 * fence and its bound are pinned here; the figures are checked against the
 * Quantity measure in the integration suite.
 */
describe("the quantity behind an order-grain column", () => {
  const read = builderBody("loadLineQuantities")
  const compareRoute = source("app/api/v1/analytics/executive/compare/route.ts")

  it("is fenced through the shared line conditions, never a hand-written where", () => {
    expect(read).toContain("lineConditions(scope, filters)")
    expect(read).not.toContain("inArray(orders.branchId")
    expect(read).not.toContain("inArray(orders.organizationId")
    expect(read).not.toContain("sql.raw")
  })

  it("is bounded by the keys the ranking returned, bound as parameters", () => {
    expect(read).toContain("inArray(column.key, keys)")
    expect(read).toContain("if (keys.length === 0) return new Map()")
    expect(read).not.toContain(".limit(")
  })

  it("nets refunds exactly as a line-grain row of the same dimension does", () => {
    expect(read).toContain("quantity: lineNetQuantity")
  })

  it("is asked for only for the window that is drawn, not for the prior one", () => {
    expect(compareRoute.match(/\{ withQuantity: true \}/g)).toHaveLength(1)
    expect(compareRoute).toContain("loadComparison(scope, filters, parsed.dimension, parsed.metric, parsed.limit, { withQuantity: true })")
    // The grid ranks its axes for their order and totals alone.
    expect(builderBody("loadMatrix")).not.toContain("withQuantity")
  })

  it("fills every point of an order-grain trend, per entity and month", () => {
    const series = builderBody("loadEntitySeries")
    expect(series).toContain("loadLineQuantities(scope, filters, dimension as OrderGrainDimension, Array.from(wanted.keys()), { byMonth: true })")
  })
})
