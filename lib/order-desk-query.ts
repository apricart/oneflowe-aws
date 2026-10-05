/**
 * The query string of the Order Desk's own order list, parsed and bounded.
 *
 * The filters only ever narrow: the server ANDs them with the desk's reach
 * (`orderDeskOrderCondition`), so naming an organization or branch the desk
 * does not reach returns nothing rather than someone else's orders.
 */

/**
 * The tabs of the desk's order list, in the order the work happens: an order
 * waits for Super Admin to record delivery, is then ready for the desk to
 * fulfil, and ends fulfilled (or cancelled before delivery).
 */
export const DESK_ORDER_STATUS_FILTERS = [
  "awaiting_delivery",
  "ready_to_fulfil",
  "fulfilled",
  "cancelled",
  "all",
] as const
export type DeskOrderStatusFilter = (typeof DESK_ORDER_STATUS_FILTERS)[number]

export const DESK_ORDER_PAGE_SIZE_DEFAULT = 20
export const DESK_ORDER_PAGE_SIZE_MAX = 50
export const DESK_ORDER_PAGE_MAX = 10_000
export const DESK_ORDER_SEARCH_MAX_LENGTH = 100

export type DeskOrderListQuery = {
  organizationId: number | null
  branchId: number | null
  status: DeskOrderStatusFilter
  /** Matched against the order number and the customer reference. Empty means none. */
  search: string
  page: number
  limit: number
}

export type DeskOrderListQueryResult =
  | { ok: true; value: DeskOrderListQuery }
  | { ok: false; error: string }

function optionalId(raw: string | null, name: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") return { ok: true, value: null }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0
    ? { ok: true, value }
    : { ok: false, error: `${name} must be a positive integer` }
}

function boundedInt(raw: string | null, fallback: number, max: number): number {
  const value = Math.trunc(Number(raw))
  if (!Number.isFinite(value) || value < 1) return fallback
  return Math.min(value, max)
}

export function parseDeskOrderListQuery(params: URLSearchParams): DeskOrderListQueryResult {
  const organizationId = optionalId(params.get("organizationId"), "organizationId")
  if (!organizationId.ok) return organizationId
  const branchId = optionalId(params.get("branchId"), "branchId")
  if (!branchId.ok) return branchId

  const rawStatus = (params.get("status") ?? "awaiting_delivery").trim().toLowerCase()
  if (!(DESK_ORDER_STATUS_FILTERS as readonly string[]).includes(rawStatus)) {
    return { ok: false, error: `status must be one of: ${DESK_ORDER_STATUS_FILTERS.join(", ")}` }
  }

  const search = (params.get("q") ?? "").trim()
  if (search.length > DESK_ORDER_SEARCH_MAX_LENGTH) {
    return { ok: false, error: `q must be at most ${DESK_ORDER_SEARCH_MAX_LENGTH} characters` }
  }

  return {
    ok: true,
    value: {
      organizationId: organizationId.value,
      branchId: branchId.value,
      status: rawStatus as DeskOrderStatusFilter,
      search,
      page: boundedInt(params.get("page"), 1, DESK_ORDER_PAGE_MAX),
      limit: boundedInt(params.get("limit"), DESK_ORDER_PAGE_SIZE_DEFAULT, DESK_ORDER_PAGE_SIZE_MAX),
    },
  }
}

/**
 * What each tab selects: the order statuses, and — for an Active order —
 * whether Super Admin has recorded delivery. `null` statuses means every order.
 */
export function deskOrderStatusSelection(filter: DeskOrderStatusFilter): {
  statuses: string[] | null
  delivered: boolean | null
} {
  if (filter === "awaiting_delivery") return { statuses: ["APPROVED"], delivered: false }
  if (filter === "ready_to_fulfil") return { statuses: ["APPROVED"], delivered: true }
  if (filter === "fulfilled") return { statuses: ["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"], delivered: null }
  if (filter === "cancelled") return { statuses: ["CANCELLED"], delivered: null }
  return { statuses: null, delivered: null }
}

/** How many orders each tab holds, shown on the tab. */
export type DeskOrderCounts = Record<DeskOrderStatusFilter, number>

/** Where one order stands in the desk's workflow — the tab it sits on. */
export type DeskOrderStage = Exclude<DeskOrderStatusFilter, "all"> | "other"

export function deskOrderStage(order: { status: string | null; fulfillmentStatus: string | null }): DeskOrderStage {
  const status = String(order.status ?? "").toUpperCase()
  const delivered = String(order.fulfillmentStatus ?? "").toUpperCase() === "DELIVERED"
  if (status === "APPROVED") return delivered ? "ready_to_fulfil" : "awaiting_delivery"
  if (["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"].includes(status)) return "fulfilled"
  if (status === "CANCELLED") return "cancelled"
  return "other"
}
