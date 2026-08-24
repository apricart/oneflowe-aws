/**
 * Category/subcategory filtering for the Order Portal storefront.
 *
 * Every rule here reads the branch catalogue rows the shop already renders, so
 * the picker can never surface a category this branch was not assigned. The
 * module is deliberately DB-free and dependency-free so it is unit-testable on
 * its own.
 */

export const ALL_CATEGORIES = "All"

/** The category fields `/api/v1/branch/inventory` returns for each row. */
export interface CatalogueCategoryFields {
  categoryName?: string | null
  parentCategoryName?: string | null
}

export interface CategorySelection {
  category: string
  subCategory: string
}

export interface CategoryGroup {
  name: string
  subCategories: string[]
  productCount: number
}

export const ALL_CATEGORIES_SELECTION: CategorySelection = {
  category: ALL_CATEGORIES,
  subCategory: ALL_CATEGORIES,
}

const byName = (a: string, b: string) => a.localeCompare(b)

/**
 * A product normally hangs off a subcategory, so its top-level category is that
 * subcategory's parent. A product assigned straight to a top-level category has
 * no parent, and that category is its own group.
 */
export function getItemCategory(item: CatalogueCategoryFields): string | null {
  return item?.parentCategoryName || item?.categoryName || null
}

/** Only a product under a parent has a subcategory distinct from its category. */
function getItemSubCategory(item: CatalogueCategoryFields): string | null {
  return item?.parentCategoryName ? item?.categoryName || null : null
}

/** Categories present in this branch's catalogue, each with its subcategories. */
export function buildCategoryTree(items: readonly CatalogueCategoryFields[]): CategoryGroup[] {
  const groups = new Map<string, { subCategories: Set<string>; productCount: number }>()

  for (const item of items) {
    const category = getItemCategory(item)
    if (!category) continue

    const group = groups.get(category) ?? { subCategories: new Set<string>(), productCount: 0 }
    group.productCount += 1
    const subCategory = getItemSubCategory(item)
    if (subCategory) group.subCategories.add(subCategory)
    groups.set(category, group)
  }

  return Array.from(groups.entries())
    .map(([name, group]) => ({
      name,
      subCategories: Array.from(group.subCategories).sort(byName),
      productCount: group.productCount,
    }))
    .sort((a, b) => byName(a.name, b.name))
}

/**
 * Subcategory chips for the ribbon, scoped to the chosen category. A product
 * sitting directly on a top-level category still earns a chip, so the ribbon
 * keeps listing everything it listed before.
 */
export function listSubCategories(
  items: readonly CatalogueCategoryFields[],
  category: string,
): string[] {
  const subCategories = new Set<string>()

  for (const item of items) {
    if (!item?.categoryName) continue
    if (category !== ALL_CATEGORIES && getItemCategory(item) !== category) continue
    subCategories.add(item.categoryName)
  }

  return Array.from(subCategories).sort(byName)
}

/** The category a ribbon chip belongs to, so chip and picker stay in step. */
export function findCategoryForSubCategory(
  items: readonly CatalogueCategoryFields[],
  subCategory: string,
): string | null {
  for (const item of items) {
    if (item?.categoryName === subCategory) return getItemCategory(item)
  }
  return null
}

export function matchesCategorySelection(
  item: CatalogueCategoryFields,
  selection: CategorySelection,
): boolean {
  if (selection.category !== ALL_CATEGORIES && getItemCategory(item) !== selection.category) {
    return false
  }
  if (selection.subCategory !== ALL_CATEGORIES && item?.categoryName !== selection.subCategory) {
    return false
  }
  return true
}

export function isDefaultSelection(selection: CategorySelection): boolean {
  return selection.category === ALL_CATEGORIES && selection.subCategory === ALL_CATEGORIES
}

/**
 * Drops a subcategory the chosen category does not contain. Without this,
 * switching category while a chip is active would filter the grid to nothing.
 */
export function normalizeSelection(
  selection: CategorySelection,
  items: readonly CatalogueCategoryFields[],
): CategorySelection {
  if (selection.subCategory === ALL_CATEGORIES) return selection
  if (listSubCategories(items, selection.category).includes(selection.subCategory)) return selection
  return { category: selection.category, subCategory: ALL_CATEGORIES }
}

/** Short label for the picker trigger and the active-filter chip. */
export function formatSelectionLabel(selection: CategorySelection): string {
  if (selection.subCategory !== ALL_CATEGORIES) return selection.subCategory
  if (selection.category !== ALL_CATEGORIES) return selection.category
  return "All Categories"
}
