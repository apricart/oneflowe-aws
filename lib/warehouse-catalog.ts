/**
 * The warehouse's read-only product catalogue: the query string, parsed and
 * bounded, and how a product's category is labelled. Pure.
 *
 * It is Apricart's global catalogue — what Super Admin sees under Global
 * Products — without a single price: the reads never select one, so there is
 * nothing in the payload to hide. See
 * plans/OF-WAREHOUSE-read-only-product-catalog.md.
 */

export const WAREHOUSE_CATALOG_STATUSES = ["active", "inactive", "all"] as const
export type WarehouseCatalogStatus = (typeof WAREHOUSE_CATALOG_STATUSES)[number]

export const WAREHOUSE_CATALOG_PAGE_SIZE_DEFAULT = 50
export const WAREHOUSE_CATALOG_PAGE_SIZE_MAX = 200
export const WAREHOUSE_CATALOG_PAGE_MAX = 10_000
export const WAREHOUSE_CATALOG_SEARCH_MAX_LENGTH = 100
/** At or below this, a product's stock is flagged as running low. */
export const WAREHOUSE_LOW_STOCK_THRESHOLD = 10
/** Most category rows the filter list reads; the taxonomy is far smaller. */
export const WAREHOUSE_CATALOG_CATEGORY_MAX = 1000

export type WarehouseCatalogQuery = {
  status: WarehouseCatalogStatus
  search: string
  categoryId: number | null
  subcategoryId: number | null
  page: number
  limit: number
}

export type WarehouseCatalogQueryResult = { ok: true; value: WarehouseCatalogQuery } | { ok: false; error: string }

const ALLOWED_KEYS = new Set(["status", "q", "categoryId", "subcategoryId", "page", "limit"])
const ID_PATTERN = /^[1-9]\d{0,8}$/

function boundedInt(raw: string | null, fallback: number, max: number): number {
  const value = Math.trunc(Number(raw))
  if (raw === null || !Number.isFinite(value) || value < 1) return fallback
  return Math.min(value, max)
}

/** An optional positive id: absent or empty is null, anything else malformed is an error. */
function optionalId(raw: string | null): number | null | "invalid" {
  if (raw === null || raw.trim() === "") return null
  const trimmed = raw.trim()
  return ID_PATTERN.test(trimmed) ? Number(trimmed) : "invalid"
}

export function parseWarehouseCatalogQuery(params: URLSearchParams): WarehouseCatalogQueryResult {
  const unknownKey = [...params.keys()].find((key) => !ALLOWED_KEYS.has(key))
  if (unknownKey) return { ok: false, error: `Unknown filter: ${unknownKey}` }

  const status = (params.get("status") ?? "active").trim().toLowerCase()
  if (!(WAREHOUSE_CATALOG_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `status must be one of: ${WAREHOUSE_CATALOG_STATUSES.join(", ")}` }
  }
  const search = (params.get("q") ?? "").trim()
  if (search.length > WAREHOUSE_CATALOG_SEARCH_MAX_LENGTH) {
    return { ok: false, error: `q must be at most ${WAREHOUSE_CATALOG_SEARCH_MAX_LENGTH} characters` }
  }
  const categoryId = optionalId(params.get("categoryId"))
  if (categoryId === "invalid") return { ok: false, error: "categoryId must be a positive integer" }
  const subcategoryId = optionalId(params.get("subcategoryId"))
  if (subcategoryId === "invalid") return { ok: false, error: "subcategoryId must be a positive integer" }

  return {
    ok: true,
    value: {
      status: status as WarehouseCatalogStatus,
      search,
      categoryId,
      subcategoryId,
      page: boundedInt(params.get("page"), 1, WAREHOUSE_CATALOG_PAGE_MAX),
      limit: boundedInt(params.get("limit"), WAREHOUSE_CATALOG_PAGE_SIZE_DEFAULT, WAREHOUSE_CATALOG_PAGE_SIZE_MAX),
    },
  }
}

/**
 * A product carries one `category_id`, normally a subcategory under a
 * top-level category. One filed directly under a top-level category has that
 * as its category and no subcategory; one whose parent row is gone keeps its
 * subcategory and an unknown category.
 */
export function warehouseCatalogCategoryLabels(direct: {
  name: string | null
  parentId: number | null
  parentName: string | null
}): { category: string | null; subcategory: string | null } {
  if (direct.name === null) return { category: null, subcategory: null }
  if (direct.parentId === null) return { category: direct.name, subcategory: null }
  return { category: direct.parentName, subcategory: direct.name }
}

export function isLowStock(stockQuantity: number): boolean {
  return Number(stockQuantity) <= WAREHOUSE_LOW_STOCK_THRESHOLD
}

export type WarehouseCatalogCategory = {
  id: number
  name: string
  subcategories: Array<{ id: number; name: string }>
}

/**
 * The filter list, built from the categories the catalogue actually uses: each
 * referenced row and its parent. A referenced top-level category appears with
 * no subcategories of its own unless other products sit beneath it. Sorted by
 * name so the list reads the same on every load.
 */
export function buildWarehouseCatalogCategories(
  rows: ReadonlyArray<{ id: number; name: string; parentId: number | null; parentName: string | null }>,
): WarehouseCatalogCategory[] {
  const byId = new Map<number, WarehouseCatalogCategory>()
  const ensure = (id: number, name: string) => {
    const existing = byId.get(id)
    if (existing) return existing
    const created: WarehouseCatalogCategory = { id, name, subcategories: [] }
    byId.set(id, created)
    return created
  }
  for (const row of rows) {
    if (row.parentId === null) {
      ensure(row.id, row.name)
    } else if (row.parentName !== null) {
      const parent = ensure(row.parentId, row.parentName)
      if (!parent.subcategories.some((sub) => sub.id === row.id)) parent.subcategories.push({ id: row.id, name: row.name })
    }
  }
  const byName = (a: { id: number; name: string }, b: { id: number; name: string }) =>
    a.name.localeCompare(b.name) || a.id - b.id
  return [...byId.values()]
    .map((category) => ({ ...category, subcategories: [...category.subcategories].sort(byName) }))
    .sort(byName)
}
