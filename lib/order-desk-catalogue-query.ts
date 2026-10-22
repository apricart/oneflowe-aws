/**
 * The query string of the Order Desk's product picker, parsed and bounded.
 *
 * The picker searches Apricart's whole active catalogue for one branch the desk
 * reaches, so it is paged rather than capped: every product can be found, and
 * no request can ask for all of them at once. Unknown parameters are refused.
 */

export const DESK_CATALOGUE_PAGE_SIZE_DEFAULT = 25
export const DESK_CATALOGUE_PAGE_SIZE_MAX = 100
export const DESK_CATALOGUE_PAGE_MAX = 10_000
export const DESK_CATALOGUE_SEARCH_MAX_LENGTH = 100

export type DeskCatalogueQuery = {
  organizationId: number
  branchId: number
  /** Matched against the product name and code; null means no search. */
  search: string | null
  page: number
  limit: number
}

const ALLOWED_KEYS = new Set(["organizationId", "branchId", "q", "page", "limit"])

function positiveId(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw.trim())) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function boundedInt(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null || raw.trim() === "") return fallback
  if (!/^\d+$/.test(raw.trim())) return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) return null
  return Math.min(value, max)
}

export function parseDeskCatalogueQuery(
  params: URLSearchParams,
): { ok: true; value: DeskCatalogueQuery } | { ok: false; error: string } {
  const unknown = [...new Set(params.keys())].filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) return { ok: false, error: `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}` }

  const organizationId = positiveId(params.get("organizationId"))
  if (organizationId === null) return { ok: false, error: "organizationId must be a positive integer" }
  const branchId = positiveId(params.get("branchId"))
  if (branchId === null) return { ok: false, error: "branchId must be a positive integer" }

  const search = (params.get("q") ?? "").trim()
  if (search.length > DESK_CATALOGUE_SEARCH_MAX_LENGTH) {
    return { ok: false, error: `Search must be at most ${DESK_CATALOGUE_SEARCH_MAX_LENGTH} characters` }
  }
  const page = boundedInt(params.get("page"), 1, DESK_CATALOGUE_PAGE_MAX)
  if (page === null) return { ok: false, error: "page must be a positive integer" }
  const limit = boundedInt(params.get("limit"), DESK_CATALOGUE_PAGE_SIZE_DEFAULT, DESK_CATALOGUE_PAGE_SIZE_MAX)
  if (limit === null) return { ok: false, error: "limit must be a positive integer" }

  return { ok: true, value: { organizationId, branchId, search: search || null, page, limit } }
}

/** The picker's request URL, so the browser and the tests build it one way. */
export function deskCatalogueUrl(input: { organizationId: number; branchId: number; search?: string; page?: number; limit?: number }): string {
  const params = new URLSearchParams({ organizationId: String(input.organizationId), branchId: String(input.branchId) })
  const search = input.search?.trim()
  if (search) params.set("q", search.slice(0, DESK_CATALOGUE_SEARCH_MAX_LENGTH))
  if (input.page && input.page > 1) params.set("page", String(input.page))
  if (input.limit) params.set("limit", String(input.limit))
  return `/api/v1/order-desk/catalogue?${params.toString()}`
}
