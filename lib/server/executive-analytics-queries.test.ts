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
