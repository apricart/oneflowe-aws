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
