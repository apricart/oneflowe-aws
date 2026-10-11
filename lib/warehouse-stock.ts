/**
 * The warehouse's read-only stock list: the query string, parsed and bounded.
 * Stock is one global number per product (`global_products.stock_quantity`),
 * the same figure every order decrements. Pure.
 * See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 */

export const WAREHOUSE_STOCK_STATUSES = ["active", "inactive", "all"] as const
export type WarehouseStockStatus = (typeof WAREHOUSE_STOCK_STATUSES)[number]

export const WAREHOUSE_STOCK_PAGE_SIZE_DEFAULT = 50
export const WAREHOUSE_STOCK_PAGE_SIZE_MAX = 200
export const WAREHOUSE_STOCK_PAGE_MAX = 10_000
export const WAREHOUSE_STOCK_SEARCH_MAX_LENGTH = 100
/** At or below this, a product is flagged as running low. */
export const WAREHOUSE_LOW_STOCK_THRESHOLD = 10

export type WarehouseStockQuery = {
  status: WarehouseStockStatus
  search: string
  lowOnly: boolean
  page: number
  limit: number
}

export type WarehouseStockQueryResult = { ok: true; value: WarehouseStockQuery } | { ok: false; error: string }

const ALLOWED_KEYS = new Set(["status", "q", "low", "page", "limit"])

function boundedInt(raw: string | null, fallback: number, max: number): number {
  const value = Math.trunc(Number(raw))
  if (raw === null || !Number.isFinite(value) || value < 1) return fallback
  return Math.min(value, max)
}

export function parseWarehouseStockQuery(params: URLSearchParams): WarehouseStockQueryResult {
  const unknownKey = [...params.keys()].find((key) => !ALLOWED_KEYS.has(key))
  if (unknownKey) return { ok: false, error: `Unknown filter: ${unknownKey}` }

  const status = (params.get("status") ?? "active").trim().toLowerCase()
  if (!(WAREHOUSE_STOCK_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `status must be one of: ${WAREHOUSE_STOCK_STATUSES.join(", ")}` }
  }
  const search = (params.get("q") ?? "").trim()
  if (search.length > WAREHOUSE_STOCK_SEARCH_MAX_LENGTH) {
    return { ok: false, error: `q must be at most ${WAREHOUSE_STOCK_SEARCH_MAX_LENGTH} characters` }
  }
  const low = params.get("low")
  if (low !== null && low !== "0" && low !== "1") return { ok: false, error: "low must be 0 or 1" }

  return {
    ok: true,
    value: {
      status: status as WarehouseStockStatus,
      search,
      lowOnly: low === "1",
      page: boundedInt(params.get("page"), 1, WAREHOUSE_STOCK_PAGE_MAX),
      limit: boundedInt(params.get("limit"), WAREHOUSE_STOCK_PAGE_SIZE_DEFAULT, WAREHOUSE_STOCK_PAGE_SIZE_MAX),
    },
  }
}

export function isLowStock(stockQuantity: number): boolean {
  return Number(stockQuantity) <= WAREHOUSE_LOW_STOCK_THRESHOLD
}
