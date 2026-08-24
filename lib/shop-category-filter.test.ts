import { describe, expect, it } from "vitest"

import {
  ALL_CATEGORIES,
  ALL_CATEGORIES_SELECTION,
  buildCategoryTree,
  findCategoryForSubCategory,
  formatSelectionLabel,
  getItemCategory,
  isDefaultSelection,
  listSubCategories,
  matchesCategorySelection,
  normalizeSelection,
  type CatalogueCategoryFields,
} from "./shop-category-filter"

const milk = { categoryName: "Milk", parentCategoryName: "Grocery" }
const greenTea = { categoryName: "Green Tea", parentCategoryName: "Grocery" }
const batteries = { categoryName: "Batteries", parentCategoryName: "Electronics" }
/** Assigned straight to a top-level category, so it has no parent. */
const stationery = { categoryName: "Stationery", parentCategoryName: null }
const unfiled = { categoryName: null, parentCategoryName: null }

const CATALOGUE: CatalogueCategoryFields[] = [milk, greenTea, batteries, stationery, unfiled]

describe("getItemCategory", () => {
  it("uses the subcategory's parent as the top-level category", () => {
    expect(getItemCategory(milk)).toBe("Grocery")
  })

  it("treats a product with no parent as its own category", () => {
    expect(getItemCategory(stationery)).toBe("Stationery")
  })

  it("reports no category for an unfiled product", () => {
    expect(getItemCategory(unfiled)).toBeNull()
  })
})

describe("buildCategoryTree", () => {
  it("groups subcategories under their parent, sorted by name", () => {
    expect(buildCategoryTree(CATALOGUE)).toEqual([
      { name: "Electronics", subCategories: ["Batteries"], productCount: 1 },
      { name: "Grocery", subCategories: ["Green Tea", "Milk"], productCount: 2 },
      { name: "Stationery", subCategories: [], productCount: 1 },
    ])
  })

  it("leaves unfiled products out of every group", () => {
    const names = buildCategoryTree([unfiled]).map((group) => group.name)
    expect(names).toEqual([])
  })

  it("returns nothing for an empty catalogue", () => {
    expect(buildCategoryTree([])).toEqual([])
  })
})

describe("listSubCategories", () => {
  it("lists every subcategory when no category is chosen", () => {
    expect(listSubCategories(CATALOGUE, ALL_CATEGORIES)).toEqual([
      "Batteries",
      "Green Tea",
      "Milk",
      "Stationery",
    ])
  })

  it("narrows to the chosen category", () => {
    expect(listSubCategories(CATALOGUE, "Grocery")).toEqual(["Green Tea", "Milk"])
  })

  it("still lists a product hung straight off a top-level category", () => {
    expect(listSubCategories(CATALOGUE, "Stationery")).toEqual(["Stationery"])
  })
})

describe("findCategoryForSubCategory", () => {
  it("finds the category that owns a chip", () => {
    expect(findCategoryForSubCategory(CATALOGUE, "Batteries")).toBe("Electronics")
  })

  it("returns null for a subcategory this branch does not stock", () => {
    expect(findCategoryForSubCategory(CATALOGUE, "Nowhere")).toBeNull()
  })
})

describe("matchesCategorySelection", () => {
  it("keeps everything under the default selection", () => {
    expect(CATALOGUE.every((item) => matchesCategorySelection(item, ALL_CATEGORIES_SELECTION))).toBe(true)
  })

  it("keeps only the chosen category", () => {
    const selection = { category: "Grocery", subCategory: ALL_CATEGORIES }
    expect(CATALOGUE.filter((item) => matchesCategorySelection(item, selection))).toEqual([milk, greenTea])
  })

  it("keeps only the chosen subcategory", () => {
    const selection = { category: "Grocery", subCategory: "Milk" }
    expect(CATALOGUE.filter((item) => matchesCategorySelection(item, selection))).toEqual([milk])
  })

  it("matches a product assigned straight to a top-level category", () => {
    const selection = { category: "Stationery", subCategory: ALL_CATEGORIES }
    expect(CATALOGUE.filter((item) => matchesCategorySelection(item, selection))).toEqual([stationery])
  })

  it("excludes unfiled products from every named category", () => {
    const selection = { category: "Grocery", subCategory: ALL_CATEGORIES }
    expect(matchesCategorySelection(unfiled, selection)).toBe(false)
  })
})

describe("normalizeSelection", () => {
  it("drops a subcategory the chosen category does not contain", () => {
    expect(normalizeSelection({ category: "Electronics", subCategory: "Milk" }, CATALOGUE)).toEqual({
      category: "Electronics",
      subCategory: ALL_CATEGORIES,
    })
  })

  it("keeps a subcategory that belongs to the chosen category", () => {
    const selection = { category: "Grocery", subCategory: "Milk" }
    expect(normalizeSelection(selection, CATALOGUE)).toBe(selection)
  })

  it("drops a subcategory that has left the catalogue entirely", () => {
    expect(normalizeSelection({ category: ALL_CATEGORIES, subCategory: "Milk" }, [batteries])).toEqual(
      ALL_CATEGORIES_SELECTION,
    )
  })
})

describe("isDefaultSelection and formatSelectionLabel", () => {
  it("recognises the unfiltered selection", () => {
    expect(isDefaultSelection(ALL_CATEGORIES_SELECTION)).toBe(true)
    expect(isDefaultSelection({ category: "Grocery", subCategory: ALL_CATEGORIES })).toBe(false)
  })

  it("labels the most specific part of the selection", () => {
    expect(formatSelectionLabel(ALL_CATEGORIES_SELECTION)).toBe("All Categories")
    expect(formatSelectionLabel({ category: "Grocery", subCategory: ALL_CATEGORIES })).toBe("Grocery")
    expect(formatSelectionLabel({ category: "Grocery", subCategory: "Milk" })).toBe("Milk")
  })
})
