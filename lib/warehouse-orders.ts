import { DELIVERY_DASHBOARD_CUTOFF_AT } from "@/lib/delivery-sla"
import {
  FULFILLMENT_STATUSES,
  FULFILLMENT_STATUS_LABELS,
  getNextFulfillmentStatus,
  normalizeFulfillmentStatus,
  type FulfillmentStatus,
} from "@/lib/fulfillment-status"
import { FULFILLED_ORDER_STATUSES } from "@/lib/order-delivery-status"
import { neutralizeSpreadsheetFormula } from "@/lib/spreadsheet"

/**
 * The warehouse's order queue and picking sheet: the query string, what the
 * warehouse may do next with an order, and the rows of its export. Pure — the
 * server reads, this decides. See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 *
 * Every filter only narrows: the server ANDs it with the warehouse user's
 * branch reach, so naming a branch outside it returns nothing rather than
 * someone else's orders.
 */

export const WAREHOUSE_ORDER_VIEWS = ["open", "delivered", "all"] as const
export type WarehouseOrderView = (typeof WAREHOUSE_ORDER_VIEWS)[number]

export const WAREHOUSE_ORDER_PAGE_SIZE_DEFAULT = 25
export const WAREHOUSE_ORDER_PAGE_SIZE_MAX = 100
export const WAREHOUSE_ORDER_PAGE_MAX = 10_000
export const WAREHOUSE_ORDER_SEARCH_MAX_LENGTH = 100
/** How many days back the "delivered" view reaches when none is chosen. */
export const WAREHOUSE_DELIVERED_DAYS_DEFAULT = 30
export const WAREHOUSE_DELIVERED_DAYS_MAX = 366

export type WarehouseOrderListQuery = {
  view: WarehouseOrderView
  stage: FulfillmentStatus | null
  organizationId: number | null
  branchId: number | null
  /** Matched against the order number, the invoice number and the branch name. Empty means none. */
  search: string
  deliveredWithinDays: number
  /** Include each order's lines — the export asks for this; the list does not. */
  includeLines: boolean
  page: number
  limit: number
}

export type WarehouseOrderListQueryResult =
  | { ok: true; value: WarehouseOrderListQuery }
  | { ok: false; error: string }

const ALLOWED_KEYS = new Set(["view", "stage", "organizationId", "branchId", "q", "days", "lines", "page", "limit"])

function optionalId(raw: string | null, name: string): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") return { ok: true, value: null }
  if (!/^\d+$/.test(raw.trim())) return { ok: false, error: `${name} must be a positive integer` }
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) && value > 0
    ? { ok: true, value }
    : { ok: false, error: `${name} must be a positive integer` }
}

function boundedInt(raw: string | null, fallback: number, max: number): number {
  const value = Math.trunc(Number(raw))
  if (raw === null || !Number.isFinite(value) || value < 1) return fallback
  return Math.min(value, max)
}

/**
 * Validate the query string. Unknown keys and bad values are refused, never
 * ignored, so a typo cannot quietly widen or narrow what is shown.
 */
export function parseWarehouseOrderListQuery(params: URLSearchParams): WarehouseOrderListQueryResult {
  const unknownKey = [...params.keys()].find((key) => !ALLOWED_KEYS.has(key))
  if (unknownKey) return { ok: false, error: `Unknown filter: ${unknownKey}` }

  const rawView = (params.get("view") ?? "open").trim().toLowerCase()
  if (!(WAREHOUSE_ORDER_VIEWS as readonly string[]).includes(rawView)) {
    return { ok: false, error: `view must be one of: ${WAREHOUSE_ORDER_VIEWS.join(", ")}` }
  }

  const rawStage = params.get("stage")
  let stage: FulfillmentStatus | null = null
  if (rawStage !== null && rawStage.trim() !== "") {
    const normalized = rawStage.trim().toUpperCase()
    if (!(FULFILLMENT_STATUSES as readonly string[]).includes(normalized)) {
      return { ok: false, error: `stage must be one of: ${FULFILLMENT_STATUSES.join(", ")}` }
    }
    stage = normalized as FulfillmentStatus
  }

  const organizationId = optionalId(params.get("organizationId"), "organizationId")
  if (!organizationId.ok) return organizationId
  const branchId = optionalId(params.get("branchId"), "branchId")
  if (!branchId.ok) return branchId

  const search = (params.get("q") ?? "").trim()
  if (search.length > WAREHOUSE_ORDER_SEARCH_MAX_LENGTH) {
    return { ok: false, error: `q must be at most ${WAREHOUSE_ORDER_SEARCH_MAX_LENGTH} characters` }
  }

  const rawLines = params.get("lines")
  if (rawLines !== null && rawLines !== "1" && rawLines !== "0") return { ok: false, error: "lines must be 0 or 1" }

  return {
    ok: true,
    value: {
      view: rawView as WarehouseOrderView,
      stage,
      organizationId: organizationId.value,
      branchId: branchId.value,
      search,
      deliveredWithinDays: boundedInt(params.get("days"), WAREHOUSE_DELIVERED_DAYS_DEFAULT, WAREHOUSE_DELIVERED_DAYS_MAX),
      includeLines: rawLines === "1",
      page: boundedInt(params.get("page"), 1, WAREHOUSE_ORDER_PAGE_MAX),
      limit: boundedInt(params.get("limit"), WAREHOUSE_ORDER_PAGE_SIZE_DEFAULT, WAREHOUSE_ORDER_PAGE_SIZE_MAX),
    },
  }
}

/**
 * Whether an order is the warehouse's to see at all: approved work, or a
 * fulfilled order as delivered history (AC1 of
 * plans/OF-WAREHOUSE-warehouse-fulfilment-role.md). A pending, returned,
 * rejected, cancelled or refunded order at an assigned branch reads as 404,
 * exactly like one at another branch. The queue's SQL (`workStatus` in
 * `lib/server/warehouse-orders.ts`) states the same rule.
 */
export function isWarehouseWorkStatus(status: string | null | undefined): boolean {
  const normalized = String(status ?? "").trim().toUpperCase()
  return normalized === "APPROVED" || (FULFILLED_ORDER_STATUSES as readonly string[]).includes(normalized)
}

/** A route's numeric id segment, or null when it is not a positive safe integer. */
export function parseRouteId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * The one stage the warehouse may move this order to now, or null. Only an
 * `APPROVED` order moves, one stage at a time; the server enforces the same
 * rule again under its compare-and-set.
 */
export function warehouseNextStage(order: {
  status: string | null | undefined
  fulfillmentStatus: string | null | undefined
}): FulfillmentStatus | null {
  if (String(order.status ?? "").trim().toUpperCase() !== "APPROVED") return null
  return getNextFulfillmentStatus(order.fulfillmentStatus)
}

/**
 * Why an order has no delivery timeline, in words a warehouse user can act on.
 * The timeline is the delivery dashboard's, which needs an approval time to
 * start the 72-hour clock and counts only orders approved since the cutoff.
 * Orders inserted outside the app (legacy imports, demo data) carry no approval
 * time at all, which is a different reason from being approved too early.
 */
export function timelineUnavailableReason(approvedAt: string | null | undefined): string {
  const approved = approvedAt ? new Date(approvedAt) : null
  if (!approved || Number.isNaN(approved.getTime())) {
    return "No timeline for this order — it has no recorded approval time (it was imported or added directly to the database, not approved in the app), so the 72-hour delivery clock cannot start."
  }
  if (approved.getTime() < DELIVERY_DASHBOARD_CUTOFF_AT.getTime()) {
    return "No timeline for this order — timelines are kept for orders approved since 1 September 2026."
  }
  return "No timeline for this order — it is not part of the delivery dashboard (an imported order, for example)."
}

/** The button label for moving to a stage. */
export const WAREHOUSE_STAGE_ACTION_LABELS: Record<Exclude<FulfillmentStatus, "NOT_STARTED">, string> = {
  IN_PROCESS: "Start processing",
  OUT_FOR_DELIVERY: "Dispatch",
  DELIVERED: "Mark delivered",
}

/**
 * A line's gross amount: its tax-inclusive unit price times its quantity,
 * rounded to whole cents. Quantities can be fractional (kilograms).
 */
export function lineAmountCents(line: { priceCents: number; quantity: number }): number {
  return Math.round(Number(line.priceCents) * Number(line.quantity))
}

export type PickingListOrder = {
  tid: string
  invoiceNumber: string | null
  organizationName: string
  branchName: string
  destination: string
  fulfillmentStatus: string | null
  approvedAt: string | null
  notes: string | null
  lines: Array<{
    productCode: string | null
    productName: string
    unit: string | null
    quantity: number
    priceCents: number
  }>
}

export const PICKING_LIST_HEADERS = [
  "Order",
  "Invoice",
  "Organization",
  "Branch",
  "Destination",
  "Stage",
  "Approved at",
  "Product code",
  "Item",
  "Quantity",
  "Unit",
  "Unit price",
  "Line amount",
  "Notes",
] as const

const centsToAmount = (cents: number): number => Math.round(cents) / 100

/**
 * One row per order line, for the picking / dispatch export. An order with no
 * lines still gets a row, so it is not silently missing from a dispatch list.
 *
 * Every text cell is passed through `neutralizeSpreadsheetFormula`: notes,
 * branch and address names are typed by tenant staff and the file is opened by
 * Apricart's warehouse, so a cell starting with = + - @ must never be
 * evaluated as a formula (CSV injection).
 */
export function buildPickingListRows(orders: readonly PickingListOrder[]): Array<Array<string | number>> {
  return buildRawPickingListRows(orders).map((row) => row.map((cell) => neutralizeSpreadsheetFormula(cell)))
}

function buildRawPickingListRows(orders: readonly PickingListOrder[]): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = []
  for (const order of orders) {
    const head = [
      order.tid,
      order.invoiceNumber ?? "",
      order.organizationName,
      order.branchName,
      order.destination,
      FULFILLMENT_STATUS_LABELS[normalizeFulfillmentStatus(order.fulfillmentStatus)],
      order.approvedAt ?? "",
    ]
    if (order.lines.length === 0) {
      rows.push([...head, "", "", "", "", "", "", order.notes ?? ""])
      continue
    }
    for (const line of order.lines) {
      rows.push([
        ...head,
        line.productCode ?? "",
        line.productName,
        Number(line.quantity),
        line.unit ?? "",
        centsToAmount(line.priceCents),
        centsToAmount(lineAmountCents(line)),
        order.notes ?? "",
      ])
    }
  }
  return rows
}
