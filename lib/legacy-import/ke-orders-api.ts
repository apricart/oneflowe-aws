/**
 * Repeatable K-Electric order import, sourced from the legacy logistics API.
 *
 * The one-off migrations in `ke-electric.ts` and `ke-post-cutoff.ts` were each
 * pinned to a single cutover: they hard-code expected row counts, a fixed
 * cutoff date, and per-order exceptions that were correct exactly once. This
 * module is the repeatable form of the same job — give it a date range and it
 * prepares whatever orders that range holds, with no baked-in expectations.
 *
 * The spreadsheet K-Electric exports ("Orders (N).xls") is deliberately *not* a
 * source here. It carries only an order-level GrandTotal, with no products,
 * quantities or unit prices, so orders built from it alone could not have line
 * items and would not survive a look at any invoice. The same rows are
 * available from the list endpoint together with the detail endpoint that does
 * carry items, so the API is the source and the sheet is only ever a
 * cross-check (see `reconcileAgainstSheet`).
 *
 * Money: legacy prices are gross, i.e. tax-inclusive, and the legacy checkout
 * always reports `Tax: 0`. OneFlowe stores the same gross in `total_cents` and
 * derives net and tax from it, so importing never restates what was charged.
 */

import { DEFAULT_TAX_RATE_BP, resolveTaxRateBp, splitInclusiveCents } from "../tax"
import {
  canonicalJson,
  legacyStatusText,
  normalizeLegacyProduct,
  normalizeLegacyText,
  sha256,
  type LegacyOrderDetail,
  type LegacyOrderListRow,
  type TargetFulfillmentStatus,
  type TargetOrderStatus,
} from "./ke-post-cutoff"

export const KE_ORDERS_ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
export const KE_ORDERS_SOURCE = "KE_LOGISTICS"

export const KE_LOGISTICS_BASE_URL = "https://logistics.oneflowe.com"
export const KE_ORDERS_LIST_PATH = "/api/OrderController/GetFilterOrdersMultiLocations"

/**
 * Legacy `StatusID` values this importer will act on.
 *
 * `2` is a live order. `5` is cancelled and has no counterpart in OneFlowe — an
 * order that never happened should not appear in spend or reporting. `1` is an
 * unsubmitted draft: those rows carry a null GrandTotal and, in every observed
 * case, sit beside a completed sibling transaction from the same user on the
 * same day, i.e. an abandoned basket rather than a second purchase.
 */
export const LEGACY_STATUS_LIVE = 2
export const LEGACY_STATUS_CANCELLED = 5
export const LEGACY_STATUS_DRAFT = 1

/**
 * `4` is a legacy test order. Order 173 is TransactionNo "G-12", LastUpdatedBy
 * "test", carrying an item named "TEST 2"; all nine sit at one branch. They are
 * skipped like a cancelled order rather than rejected, so they stop appearing
 * as failures needing attention.
 */
export const LEGACY_STATUS_TEST = 4

export type SkipReason = "CANCELLED" | "DRAFT" | "ALREADY_IMPORTED" | "TEST_ORDER"

export interface StatusMapping {
  status: TargetOrderStatus
  fulfillmentStatus: TargetFulfillmentStatus
}

/**
 * Legacy delivery status to the OneFlowe status pair.
 *
 * This deliberately does not reuse `mapLegacyStatus` from `ke-post-cutoff.ts`:
 * that function carries a per-order exception from the one-time cutover and
 * throws on `502`, a state no order happened to be in on the day it ran. A
 * repeatable importer meets every state the legacy system can produce, so the
 * mapping lives here where it can be completed without disturbing a migration
 * that has already been executed and validated.
 *
 * `502` (Confirmed) and `505` (Partial) have no distinct OneFlowe counterpart.
 * Confirmed sits between placed and in-process, so it lands on the same pair as
 * placed; partial means some of the order reached the branch, which OneFlowe
 * records as delivered, matching how `compare-ke-orders-sheet-to-live.ts`
 * already treats a partial row as compatible with a delivered order.
 */
const DELIVERY_STATUS_MAP: Record<number, StatusMapping> = {
  501: { status: "APPROVED", fulfillmentStatus: "NOT_STARTED" },       // Order Placed
  502: { status: "APPROVED", fulfillmentStatus: "NOT_STARTED" },       // Confirmed
  503: { status: "APPROVED", fulfillmentStatus: "IN_PROCESS" },        // InProcess
  505: { status: "FULFILLED", fulfillmentStatus: "DELIVERED" },        // Partial
  506: { status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" },  // Out For Delivery
  507: { status: "FULFILLED", fulfillmentStatus: "DELIVERED" },        // Delivered
}

export function mapDeliveryStatus(deliveryStatus: number): StatusMapping | null {
  return DELIVERY_STATUS_MAP[deliveryStatus] ?? null
}

export type RejectReason =
  | "NO_ITEM_LINES"
  | "ITEM_SUBTOTAL_MISMATCH"
  | "CHECKOUT_MISMATCH"
  | "LIST_DETAIL_MISMATCH"
  | "INVALID_QUANTITY"
  | "INEXACT_UNIT_PRICE"
  | "BLANK_PRODUCT_NAME"
  | "MISSING_CHECKOUT"
  | "INVALID_TIMESTAMP"
  | "UNSUPPORTED_STATUS"
  /**
   * The tax split does not reproduce the order's own total.
   *
   * Legacy is not consistent about whether a line price includes VAT. Most
   * orders price inclusively, which is what OneFlowe stores; a few add VAT on
   * top, so the checkout GrandTotal exceeds the sum of the lines (order 50:
   * one line at 355 against a GrandTotal of 418.90, i.e. 355 x 1.18).
   *
   * Importing one of those under the inclusive model would understate the
   * money, so it is refused. It is refused per order rather than fatally,
   * because a single such order must not block the rest of the history.
   */
  | "TAX_SPLIT_MISMATCH"

export interface PreparedApiLine {
  sourceLineId: number
  legacyItemId: number
  sourceName: string
  normalizedName: string
  quantity: number
  /** Gross (tax-inclusive) unit price, in cents. */
  priceCents: number
  /** Gross line total, in cents. Always `priceCents * quantity`. */
  lineTotalCents: number
  sourceCodes: string[]
}

/**
 * One line of legacy `GET /api/RefundModal/{locationId}/{transactionNo}`.
 *
 * The refund detail an order's own lines do not carry: `OrderDetailController`
 * zeroes a refunded line's `Price`, so the order looks cheaper than legacy says
 * it was. Here the same line keeps `RefundPrice`, and the original value is
 * `Price + RefundPrice`.
 */
export interface LegacyRefundLine {
  ID?: number | null
  Name?: string | null
  Quantity?: number | string | null
  RefundQuantity?: number | string | null
  UnitPrice?: number | string | null
  Price?: number | string | null
  RefundPrice?: number | string | null
}

export interface LegacyRefund {
  OrderDetailsList?: LegacyRefundLine[] | null
}

export interface PreparedApiOrder {
  legacyOrderId: number
  legacyLocationId: number
  legacyOrderTakerId: number
  branchName: string
  groupName: string
  userName: string
  sourceStatus: string
  status: TargetOrderStatus
  fulfillmentStatus: TargetFulfillmentStatus
  createdAt: Date
  sourceUpdatedAt: Date
  /** `YYYY-MM` in Asia/Karachi, matching how budget spend is bucketed. */
  period: string
  /** Gross order total, in cents. Equals the legacy GrandTotal. */
  totalCents: number
  lines: PreparedApiLine[]
  sourceChecksum: string
  sourceHeader: LegacyOrderListRow
  sourceDetail: LegacyOrderDetail
}

export interface SkippedOrder {
  legacyOrderId: number
  reason: SkipReason
  sourceStatus: string
  branchName: string
  totalCents: number | null
}

export interface RejectedOrder {
  legacyOrderId: number
  reason: RejectReason
  detail: string
  branchName: string
}

export interface PreparationResult {
  prepared: PreparedApiOrder[]
  skipped: SkippedOrder[]
  rejected: RejectedOrder[]
}

/** K-Electric operates in Pakistan; budget periods are bucketed in local time. */
export const KE_TIME_ZONE = "Asia/Karachi"

const KARACHI_PERIOD = new Intl.DateTimeFormat("en-CA", {
  timeZone: KE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
})

/**
 * Budget period for an order, as `YYYY-MM` in Asia/Karachi.
 *
 * `backfill-ke-budget-spend.ts` buckets spend with
 * `to_char(created_at at time zone 'Asia/Karachi', 'YYYY-MM')`, so an order
 * placed late on the last evening of a month belongs to that month and not to
 * the next one in UTC. Deriving the period any other way here would put the
 * import and the backfill into disagreement on exactly those boundary orders.
 */
export function budgetPeriod(createdAt: Date): string {
  const parts = KARACHI_PERIOD.formatToParts(createdAt)
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  if (!year || !month) throw new Error("Unable to derive budget period")
  return `${year}-${month}`
}

export function centsFrom(value: unknown, context: string): number {
  if (value === null || value === undefined || value === "") return 0
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${context}: not a number`)
  const result = Math.round((parsed + Number.EPSILON) * 100)
  if (!Number.isSafeInteger(result)) throw new Error(`${context}: out of range`)
  return result
}

function optionalDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function stripTrailingRoleSeparator(value: string): string {
  const normalized = value.trim()
  return normalized.endsWith(" -") ? normalized.slice(0, -2).trim() : normalized
}

/**
 * Stable identity for one legacy order, independent of its legacy row ID.
 *
 * The legacy ID is the reliable key and is what the unique index on
 * `legacy_order_imports` enforces. This composite exists only as a second
 * defence for rows imported by the earlier one-off scripts, a handful of which
 * recorded their header under a different payload shape and so cannot be found
 * by ID alone. Matching on either key means a re-run cannot duplicate them.
 */
export function orderIdentityKey(parts: {
  locationName: unknown
  transactionNo: unknown
  orderNo: unknown
  date: unknown
}): string {
  const location = normalizeLegacyText(parts.locationName)
  const transaction = Number(parts.transactionNo)
  const order = Number(parts.orderNo)
  const day = String(parts.date ?? "").slice(0, 10)
  return [
    location,
    Number.isFinite(transaction) ? String(Math.trunc(transaction)) : "",
    Number.isFinite(order) ? String(Math.trunc(order)) : "",
    day,
  ].join("|")
}

export function identityKeyForListRow(row: LegacyOrderListRow): string {
  return orderIdentityKey({
    locationName: row.LocationName,
    transactionNo: row.TransactionNo,
    orderNo: row.OrderNo,
    date: row.OrderCreatedDT,
  })
}

export interface AlreadyImported {
  legacyOrderIds: ReadonlySet<number>
  identityKeys: ReadonlySet<string>
}

/**
 * Turn raw list and detail responses into orders ready to write.
 *
 * Nothing here throws on a single bad order. A repeatable importer that aborts
 * the whole run because one order out of two hundred fails to reconcile is an
 * importer nobody can use unattended, so per-order problems are collected as
 * rejections and the caller decides whether the remainder is worth committing.
 */
/**
 * Rebuild an order's lines at their pre-refund values.
 *
 * The refunded *amount* is deliberately NOT returned, and is not stored
 * anywhere. `RefundPrice` reconstructs the billed line reliably — `Price +
 * RefundPrice` reconciles to the checkout subtotal on every order tested — but
 * it is not a trustworthy per-order refund figure: at one branch the same
 * product carries the same `RefundPrice` on four different orders, and summing
 * it there exceeds the order's own total, which no real refund can. At another
 * branch it is genuinely per-order. The two cases are indistinguishable, so the
 * order is stored at its gross total with no refund claimed.
 *
 * A refunded line survives on the order with `Price` zeroed, so the original
 * value of every line is `Price + RefundPrice` and the refunded value is
 * `sum(RefundPrice)`. Both come from the refund record, matched to the order's
 * own lines by line id.
 *
 * Returns null when there is no refund record, or when a line cannot be matched
 * or would not divide into a whole unit price — in which case the caller
 * refuses the order rather than storing a total it cannot substantiate.
 */
function restoreRefundedLines(
  lines: readonly PreparedApiLine[],
  refund: LegacyRefund | undefined,
): { lines: PreparedApiLine[]; subtotalCents: number } | null {
  const refundLines = refund?.OrderDetailsList
  if (!refundLines || refundLines.length === 0) return null

  const byId = new Map<number, LegacyRefundLine>()
  for (const line of refundLines) {
    const id = Number(line.ID)
    if (Number.isFinite(id)) byId.set(id, line)
  }

  const restored: PreparedApiLine[] = []
  for (const line of lines) {
    const source = byId.get(line.sourceLineId)
    if (!source) return null
    // Signed, deliberately. On a heavily refunded line the surviving `Price` is
    // a negative remainder and the two only reconstruct the billed line when it
    // is added, not its magnitude: order 1059's Tapal line is
    // -1,850 + 13,875 = 12,025, which is 13 units at 925. Taking the magnitude
    // would give 15,725 and reconcile against nothing.
    const kept = Math.round((Number(source.Price ?? 0) + Number.EPSILON) * 100)
    const refunded = Math.round((Number(source.RefundPrice ?? 0) + Number.EPSILON) * 100)
    if (!Number.isFinite(kept) || !Number.isFinite(refunded)) return null
    const original = kept + refunded
    if (original < 0) return null
    const priceCents = original / line.quantity
    if (!Number.isSafeInteger(priceCents)) return null
    restored.push({ ...line, lineTotalCents: original, priceCents })
  }

  return {
    lines: restored,
    subtotalCents: restored.reduce((sum, line) => sum + line.lineTotalCents, 0),
  }
}

export function prepareApiOrders(
  listRows: readonly LegacyOrderListRow[],
  detailsById: ReadonlyMap<number, LegacyOrderDetail>,
  alreadyImported: AlreadyImported = { legacyOrderIds: new Set(), identityKeys: new Set() },
  refundsByOrderId: ReadonlyMap<number, LegacyRefund> = new Map(),
): PreparationResult {
  const prepared: PreparedApiOrder[] = []
  const skipped: SkippedOrder[] = []
  const rejected: RejectedOrder[] = []

  for (const header of [...listRows].sort((a, b) => Number(a.ID) - Number(b.ID))) {
    const legacyOrderId = Number(header.ID)
    const branchName = String(header.LocationName ?? "").trim()
    const sourceStatus = legacyStatusText(header)
    const statusId = Number(header.StatusID)

    const skip = (reason: SkipReason) => skipped.push({
      legacyOrderId,
      reason,
      sourceStatus,
      branchName,
      totalCents: header.GrandTotal == null ? null : centsFrom(header.GrandTotal, `Order ${legacyOrderId} total`),
    })
    const reject = (reason: RejectReason, detail: string) =>
      rejected.push({ legacyOrderId, reason, detail, branchName })

    // "Already imported" is tested first so the reason reported is the true
    // one. An earlier one-off migration imported at least one order the legacy
    // system still marks as a draft (see the ID 1327 exception in
    // `ke-post-cutoff.ts`); checking status first would report that order as a
    // draft and disagree with every other tool that reads the import ledger.
    if (alreadyImported.legacyOrderIds.has(legacyOrderId)
      || alreadyImported.identityKeys.has(identityKeyForListRow(header))) {
      skip("ALREADY_IMPORTED")
      continue
    }
    if (statusId === LEGACY_STATUS_CANCELLED) { skip("CANCELLED"); continue }
    if (statusId === LEGACY_STATUS_DRAFT) { skip("DRAFT"); continue }
    if (statusId === LEGACY_STATUS_TEST) { skip("TEST_ORDER"); continue }
    if (statusId !== LEGACY_STATUS_LIVE) {
      reject("UNSUPPORTED_STATUS", `legacy StatusID ${statusId}`)
      continue
    }

    const mapping = mapDeliveryStatus(Number(header.DeliveryStatus))
    if (!mapping) {
      reject("UNSUPPORTED_STATUS", `legacy DeliveryStatus ${String(header.DeliveryStatus)}`)
      continue
    }

    const detail = detailsById.get(legacyOrderId)
    if (!detail) { reject("LIST_DETAIL_MISMATCH", "detail response is missing"); continue }
    if (Number(detail.ID) !== legacyOrderId || Number(detail.LocationID) !== Number(header.LocationID)) {
      reject("LIST_DETAIL_MISMATCH", "list and detail identify different orders")
      continue
    }
    if (Number(detail.StatusID) !== statusId || Number(detail.DeliveryStatus) !== Number(header.DeliveryStatus)) {
      reject("LIST_DETAIL_MISMATCH", "list and detail disagree on status")
      continue
    }

    let failed = false
    const lines: PreparedApiLine[] = []
    for (const line of detail.OrderDetailsList ?? []) {
      const quantity = Number(line.Quantity ?? 0)
      // Legacy occasionally stores a line total with the sign flipped — order 57
      // carries a single "tea" line at -1. A purchased line cannot cost less
      // than nothing and there is no credit-note concept on this endpoint
      // (refunds live in RefundModal, handled separately), so the magnitude is
      // the price and the sign is noise.
      const lineTotalCents = Math.abs(centsFrom(line.Price, `Order ${legacyOrderId}, item ${line.ID}`))
      // A zero/zero line is a leftover basket row, not a purchase; drop it
      // rather than rejecting an order that is otherwise sound.
      if (quantity === 0 && lineTotalCents === 0) continue
      if (!Number.isFinite(quantity) || quantity <= 0) {
        reject("INVALID_QUANTITY", `item ${line.ID} has quantity ${String(line.Quantity)}`)
        failed = true
        break
      }
      // Deliberately NOT checked here. On a heavily refunded order the line's
      // surviving `Price` is a remainder — negative or zero — and dividing it
      // gives a meaningless unit price: order 1059's Tapal line reads -1850
      // over 13, while the line legacy actually billed is 1,202,500 over 13,
      // a clean 92,500. Rejecting now would kill the order before the refund
      // record has been consulted. The check runs once below, after the lines
      // have been restored to what legacy billed.
      const priceCents = lineTotalCents / quantity
      const sourceName = String(line.Name ?? "").trim()
      if (!sourceName) {
        reject("BLANK_PRODUCT_NAME", `item ${line.ID} has no name`)
        failed = true
        break
      }
      lines.push({
        sourceLineId: Number(line.ID),
        legacyItemId: Number(line.ItemId),
        sourceName,
        normalizedName: normalizeLegacyProduct(sourceName),
        quantity,
        priceCents,
        lineTotalCents,
        sourceCodes: line.ItemCode ? [String(line.ItemCode).trim()].filter(Boolean) : [],
      })
    }
    if (failed) continue
    if (lines.length === 0) { reject("NO_ITEM_LINES", "no positive item lines"); continue }

    const checkouts = detail.OrderCheckoutList ?? []
    if (checkouts.length !== 1) {
      reject("MISSING_CHECKOUT", `expected one checkout row, found ${checkouts.length}`)
      continue
    }
    const checkout = checkouts[0]
    let itemSubtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0)

    let totalCents: number
    try {
      const subtotalCents = centsFrom(checkout.AmountTotal, `Order ${legacyOrderId} subtotal`)
      const discountCents = centsFrom(checkout.AmountDiscount, `Order ${legacyOrderId} discount`)
      const serviceCents = centsFrom(checkout.ServiceCharges, `Order ${legacyOrderId} service charges`)
      const deliveryCents = centsFrom(checkout.DeliveryCharges, `Order ${legacyOrderId} delivery charges`)
      const legacyTaxCents = centsFrom(checkout.Tax, `Order ${legacyOrderId} tax`)
      totalCents = centsFrom(checkout.GrandTotal, `Order ${legacyOrderId} grand total`)

      // A refunded line is not removed from the order, it is zeroed: its `Price`
      // becomes 0 while `RefundPrice` on the refund record keeps what came off.
      // So the lines legitimately sum short of the checkout subtotal, by exactly
      // the refunded value. Restore the original line values from the refund
      // record; the order is then stored gross, the way legacy counts it, with
      // the refund recorded separately.
      //
      // `sum(RefundPrice)` is the refund figure, not `checkout.RefundAmount` —
      // the latter is null on at least one order (573) whose lines are
      // nonetheless short by the refunded amount.
      if (itemSubtotalCents !== subtotalCents) {
        const restored = restoreRefundedLines(lines, refundsByOrderId.get(legacyOrderId))
        if (!restored) {
          reject("ITEM_SUBTOTAL_MISMATCH",
            `items total ${itemSubtotalCents}, checkout says ${subtotalCents}, `
              + "and no refund record explains the difference")
          continue
        }
        if (restored.subtotalCents !== subtotalCents) {
          reject("ITEM_SUBTOTAL_MISMATCH",
            `items total ${itemSubtotalCents}, checkout says ${subtotalCents}; restoring the refunded `
              + `lines gives ${restored.subtotalCents}, which still does not reconcile`)
          continue
        }
        lines.length = 0
        lines.push(...restored.lines)
        itemSubtotalCents = restored.subtotalCents
      }
      if (subtotalCents - discountCents + legacyTaxCents + serviceCents + deliveryCents !== totalCents) {
        reject("CHECKOUT_MISMATCH", "checkout components do not reconcile to the grand total")
        continue
      }
      if (header.GrandTotal != null
        && centsFrom(header.GrandTotal, `Order ${legacyOrderId} list total`) !== totalCents) {
        reject("CHECKOUT_MISMATCH", "list and detail totals differ")
        continue
      }
      // Legacy is not consistent about VAT. Most orders price inclusive of it,
      // so the grand total equals the line total. A minority add it on top —
      // order 50 is one line at 355 against a grand total of 418.90 — and for
      // those the lines are net while OneFlowe stores gross. Scale them up so
      // they are stored the way every other imported order is.
      //
      // Refuses rather than rounds: if the scale-up does not land exactly on the
      // order's own total, or leaves a unit price that is not a whole number of
      // cents, the money would be misstated. Across the eleven affected orders
      // every line divides cleanly and the residual is zero.
      if (legacyTaxCents > 0 && totalCents !== itemSubtotalCents) {
        const scaled = lines.map((line) => {
          const lineTotal = Math.round((line.lineTotalCents * totalCents) / itemSubtotalCents)
          return { ...line, lineTotalCents: lineTotal, priceCents: lineTotal / line.quantity }
        })
        const scaledTotal = scaled.reduce((sum, line) => sum + line.lineTotalCents, 0)
        const indivisible = scaled.find((line) => !Number.isSafeInteger(line.priceCents))
        if (scaledTotal !== totalCents) {
          reject("TAX_SPLIT_MISMATCH",
            `scaling the lines to the gross total gives ${scaledTotal}, not ${totalCents}`)
          continue
        }
        if (indivisible) {
          reject("TAX_SPLIT_MISMATCH",
            `line ${indivisible.sourceLineId} grosses up to ${indivisible.lineTotalCents} over `
              + `${indivisible.quantity}, which is not a whole cent price`)
          continue
        }
        lines.length = 0
        lines.push(...scaled)
      }
    } catch (error) {
      reject("CHECKOUT_MISMATCH", error instanceof Error ? error.message : String(error))
      continue
    }

    // Now that the lines hold what legacy billed — restored from the refund
    // record where one applied, and grossed up where VAT was added on top — a
    // unit price that is still not a whole number of cents cannot be
    // represented, and no rounding is applied to make one fit.
    const indivisibleLine = lines.find(
      (line) => !Number.isSafeInteger(line.priceCents) || line.priceCents < 0)
    if (indivisibleLine) {
      reject("INEXACT_UNIT_PRICE",
        `item ${indivisibleLine.sourceLineId}: ${indivisibleLine.lineTotalCents} over `
          + `${indivisibleLine.quantity} is not a whole cent price`)
      continue
    }

    const createdAt = optionalDate(header.CreatedOn) ?? optionalDate(detail.OrderCreatedDT) ?? optionalDate(header.OrderCreatedDT)
    if (!createdAt) { reject("INVALID_TIMESTAMP", "no usable creation timestamp"); continue }
    const sourceUpdatedAt = optionalDate(header.LastUpdateDT) ?? optionalDate(detail.LastUpdateDT) ?? createdAt

    prepared.push({
      legacyOrderId,
      legacyLocationId: Number(header.LocationID),
      legacyOrderTakerId: Number(header.OrderTakerID),
      branchName,
      groupName: String(header.LocationGroup ?? "").trim(),
      userName: stripTrailingRoleSeparator(String(header.UserDetails ?? "")),
      sourceStatus,
      status: mapping.status,
      fulfillmentStatus: mapping.fulfillmentStatus,
      createdAt,
      sourceUpdatedAt,
      period: budgetPeriod(createdAt),
      totalCents,
      lines,
      sourceChecksum: sha256(canonicalJson({ header, detail })),
      sourceHeader: header,
      sourceDetail: detail,
    })
  }

  return { prepared, skipped, rejected }
}

export interface LineTaxResult {
  taxRateBp: number
  netCents: number
  taxCents: number
  grossCents: number
}

export interface OrderTaxResult {
  subtotalCents: number
  taxCents: number
  totalCents: number
  lines: LineTaxResult[]
}

/**
 * Split one order's gross lines into the net/tax pair OneFlowe stores.
 *
 * Splitting per line and summing — rather than splitting the order total once —
 * is what keeps `subtotal + tax === total` true even when two products on the
 * same order carry different rates, and matches how the live order API and
 * `apply-ke-legacy-order-tax.ts` both compute it.
 */
export function computeOrderTax(
  lines: readonly PreparedApiLine[],
  rateForLine: (line: PreparedApiLine) => number | null | undefined,
  organizationTaxRateBp: number | null = null,
): OrderTaxResult {
  const results = lines.map((line) => {
    const taxRateBp = resolveTaxRateBp(rateForLine(line), organizationTaxRateBp)
    const split = splitInclusiveCents(line.lineTotalCents, taxRateBp)
    return { taxRateBp, ...split }
  })
  const totalCents = results.reduce((sum, line) => sum + line.grossCents, 0)
  const taxCents = results.reduce((sum, line) => sum + line.taxCents, 0)
  return { subtotalCents: totalCents - taxCents, taxCents, totalCents, lines: results }
}

export { DEFAULT_TAX_RATE_BP }

export interface SheetRow {
  Location?: unknown
  TransactionNo?: unknown
  OrderNo?: unknown
  Date?: unknown
  GrandTotal?: unknown
  "Order Status"?: unknown
  [key: string]: unknown
}

export interface SheetReconciliation {
  sheetRowCount: number
  apiRowCount: number
  matched: number
  onlyInSheet: string[]
  onlyInApi: string[]
}

/**
 * Optional cross-check that the API returned the same orders a sheet shows.
 *
 * The importer does not need the spreadsheet, but when one is supplied this
 * proves the range pulled from the API is the range the operator was looking
 * at — catching a mistyped date or a partially-populated response before any
 * of it reaches the database.
 */
export function reconcileAgainstSheet(
  sheetRows: readonly SheetRow[],
  listRows: readonly LegacyOrderListRow[],
): SheetReconciliation {
  const sheetKeys = new Map<string, number>()
  for (const row of sheetRows) {
    const key = orderIdentityKey({
      locationName: row.Location,
      transactionNo: row.TransactionNo,
      orderNo: row.OrderNo,
      date: row.Date,
    })
    sheetKeys.set(key, (sheetKeys.get(key) ?? 0) + 1)
  }
  const apiKeys = new Map<string, number>()
  for (const row of listRows) {
    const key = identityKeyForListRow(row)
    apiKeys.set(key, (apiKeys.get(key) ?? 0) + 1)
  }

  const onlyInSheet: string[] = []
  const onlyInApi: string[] = []
  let matched = 0
  for (const [key, count] of sheetKeys) {
    const apiCount = apiKeys.get(key) ?? 0
    matched += Math.min(count, apiCount)
    for (let index = apiCount; index < count; index += 1) onlyInSheet.push(key)
  }
  for (const [key, count] of apiKeys) {
    const sheetCount = sheetKeys.get(key) ?? 0
    for (let index = sheetCount; index < count; index += 1) onlyInApi.push(key)
  }

  return {
    sheetRowCount: sheetRows.length,
    apiRowCount: listRows.length,
    matched,
    onlyInSheet: onlyInSheet.sort((a, b) => a.localeCompare(b)),
    onlyInApi: onlyInApi.sort((a, b) => a.localeCompare(b)),
  }
}

/** Inclusive calendar-month windows covering [start, end], as YYYY-MM-DD pairs. */
export function monthWindows(startDate: string, endDate: string): Array<{ start: string; end: string }> {
  const windows: Array<{ start: string; end: string }> = []
  let [year, month] = startDate.split("-").map(Number)
  for (;;) {
    const first = `${year}-${String(month).padStart(2, "0")}-01`
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const last = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
    windows.push({
      start: first < startDate ? startDate : first,
      end: last > endDate ? endDate : last,
    })
    if (last >= endDate) break
    month += 1
    if (month > 12) { month = 1; year += 1 }
  }
  return windows
}
