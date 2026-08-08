import { createHash } from "crypto"

export const KE_POST_CUTOFF_SOURCE = "KE_LOGISTICS"
export const KE_POST_CUTOFF_DATE = "2026-07-10"
export const KE_POST_CUTOFF_EXPECTED = {
  sheetRows: 126,
  afterCutoffRows: 124,
  cancelled: 13,
  importable: 111,
  approved: 48,
  fulfilled: 63,
  approvedTotalCents: 338_457_700,
  fulfilledTotalCents: 278_406_600,
  totalCents: 616_864_300,
} as const

export interface LegacyOrderListRow {
  ID: number
  LocationID: number
  TransactionNo: number
  OrderNo: number
  OrderTakerID: number
  OrderCreatedDT: string
  OrderType: string
  StatusID: number
  DeliveryStatus: number
  LastUpdateDT?: string | null
  CreatedOn?: string | null
  UserDetails: string
  GrandTotal?: number | null
  LocationName: string
  LocationGroup: string
  [key: string]: unknown
}

export interface LegacyOrderDetailLine {
  ID: number
  ItemId: number
  Name: string
  Quantity: number
  Price: number
  UnitPrice?: number | null
  ItemCode?: string | null
  [key: string]: unknown
}

export interface LegacyOrderCheckout {
  AmountDiscount?: number | null
  AmountTotal?: number | null
  GrandTotal?: number | null
  Tax?: number | null
  ServiceCharges?: number | null
  DeliveryCharges?: number | null
  [key: string]: unknown
}

export interface LegacyOrderDetail {
  ID: number
  LocationID: number
  TransactionNo: string | number
  OrderTakerID: number
  DeliveryStatus: number
  OrderCreatedDT: string
  LastUpdateDT?: string | null
  LastUpdatedBy?: string | null
  StatusID: number
  OrderDetailsList: LegacyOrderDetailLine[]
  OrderCheckoutList: LegacyOrderCheckout[]
  [key: string]: unknown
}

export interface LegacyBudgetRow {
  Location: string
  TenureFrom: string
  TenureTo: string
  MonthlyBudget: number
  RemainingBudget: number
  UsedBudget: number
  AdditionalBudget: number
}

export type TargetOrderStatus = "APPROVED" | "FULFILLED"
export type TargetFulfillmentStatus = "NOT_STARTED" | "IN_PROCESS" | "OUT_FOR_DELIVERY" | "DELIVERED"

export interface PreparedPostCutoffLine {
  sourceLineId: number
  legacyItemId: number
  sourceName: string
  normalizedName: string
  quantity: number
  priceCents: number
  lineTotalCents: number
  sourceCodes: string[]
}

export interface PreparedPostCutoffOrder {
  legacyOrderId: number
  legacyLocationId: number
  branchName: string
  groupName: string
  legacyOrderTakerId: number
  userName: string
  sourceStatus: string
  status: TargetOrderStatus
  fulfillmentStatus: TargetFulfillmentStatus
  createdAt: Date
  sourceUpdatedAt: Date
  period: string
  subtotalCents: number
  taxCents: number
  totalCents: number
  checkoutPolicy: "SOURCE_CHECKOUT" | "ORDER_1327_ITEM_SUBTOTAL_ZERO_CHARGES"
  omittedZeroValueLines: number
  lines: PreparedPostCutoffLine[]
  sourceChecksum: string
  sourceHeader: LegacyOrderListRow
  sourceDetail: LegacyOrderDetail
}

export function normalizeLegacyText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function normalizeLegacyProduct(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)\s*/g, ")")
    .replace(/\s*-\s*/g, "-")
}

export function legacyStatusText(row: Pick<LegacyOrderListRow, "ID" | "StatusID" | "DeliveryStatus">): string {
  if (row.StatusID === 5) return "Cancelled"
  if (row.StatusID === 4) return "Refunded"
  if (row.DeliveryStatus === 501) return "Order Placed"
  if (row.DeliveryStatus === 502) return "Confirmed"
  if (row.DeliveryStatus === 503) return "InProcess"
  if (row.DeliveryStatus === 505) return "Partial"
  if (row.DeliveryStatus === 506) return "Out For Delivery"
  if (row.DeliveryStatus === 507) return "Delivered"
  return "Unknown"
}

export function mapLegacyStatus(row: Pick<LegacyOrderListRow, "ID" | "StatusID" | "DeliveryStatus">):
  | { skip: true; sourceStatus: "Cancelled" }
  | { skip: false; sourceStatus: string; status: TargetOrderStatus; fulfillmentStatus: TargetFulfillmentStatus } {
  const sourceStatus = legacyStatusText(row)
  if (sourceStatus === "Cancelled") return { skip: true, sourceStatus }
  if (row.ID === 1327 && row.StatusID === 1 && row.DeliveryStatus === 501) {
    return { skip: false, sourceStatus: "Order Placed", status: "FULFILLED", fulfillmentStatus: "DELIVERED" }
  }
  if (row.StatusID !== 2) throw new Error(`Order ${row.ID}: unsupported legacy StatusID ${row.StatusID}`)
  if (row.DeliveryStatus === 501) return { skip: false, sourceStatus, status: "APPROVED", fulfillmentStatus: "NOT_STARTED" }
  if (row.DeliveryStatus === 503) return { skip: false, sourceStatus, status: "APPROVED", fulfillmentStatus: "IN_PROCESS" }
  if (row.DeliveryStatus === 506) return { skip: false, sourceStatus, status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" }
  if (row.DeliveryStatus === 505 || row.DeliveryStatus === 507) {
    return { skip: false, sourceStatus, status: "FULFILLED", fulfillmentStatus: "DELIVERED" }
  }
  throw new Error(`Order ${row.ID}: unsupported legacy status pair ${row.StatusID}/${row.DeliveryStatus}`)
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function cents(value: unknown, context: string): number {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) throw new Error(`${context}: expected a finite monetary value`)
  const result = Math.round(number * 100)
  if (Math.abs(number * 100 - result) > 0.000001 || !Number.isSafeInteger(result)) {
    throw new Error(`${context}: monetary value is not representable in cents`)
  }
  return result
}

function requiredDate(value: unknown, context: string): Date {
  const result = new Date(String(value ?? ""))
  if (Number.isNaN(result.getTime())) throw new Error(`${context}: invalid date ${String(value)}`)
  return result
}

export function preparePostCutoffOrders(
  listRows: LegacyOrderListRow[],
  detailRows: LegacyOrderDetail[],
): { prepared: PreparedPostCutoffOrder[]; cancelledIds: number[]; zeroValueLineIds: number[] } {
  const afterCutoff = listRows.filter((row) => String(row.OrderCreatedDT).slice(0, 10) > KE_POST_CUTOFF_DATE)
  const detailById = new Map(detailRows.map((detail) => [Number(detail.ID), detail]))
  if (detailById.size !== detailRows.length) throw new Error("Duplicate order IDs in legacy detail snapshot")
  const prepared: PreparedPostCutoffOrder[] = []
  const cancelledIds: number[] = []
  const zeroValueLineIds: number[] = []

  for (const header of afterCutoff.sort((a, b) => Number(a.ID) - Number(b.ID))) {
    const mapping = mapLegacyStatus(header)
    if (mapping.skip) {
      cancelledIds.push(Number(header.ID))
      continue
    }
    const detail = detailById.get(Number(header.ID))
    if (!detail) throw new Error(`Order ${header.ID}: detail snapshot is missing`)
    if (Number(detail.ID) !== Number(header.ID) || Number(detail.LocationID) !== Number(header.LocationID)) {
      throw new Error(`Order ${header.ID}: list/detail identity mismatch`)
    }
    if (Number(detail.StatusID) !== Number(header.StatusID) || Number(detail.DeliveryStatus) !== Number(header.DeliveryStatus)) {
      throw new Error(`Order ${header.ID}: list/detail status mismatch`)
    }
    if (Number(detail.OrderTakerID) !== Number(header.OrderTakerID)) {
      throw new Error(`Order ${header.ID}: list/detail order-taker mismatch`)
    }

    const lines: PreparedPostCutoffLine[] = []
    for (const line of detail.OrderDetailsList ?? []) {
      const quantity = Number(line.Quantity ?? 0)
      const lineTotalCents = cents(line.Price, `Order ${header.ID}, item ${line.ID}`)
      if (quantity === 0 && lineTotalCents === 0) {
        zeroValueLineIds.push(Number(line.ID))
        continue
      }
      if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Order ${header.ID}, item ${line.ID}: invalid quantity`)
      const priceCents = lineTotalCents / quantity
      if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
        throw new Error(`Order ${header.ID}, item ${line.ID}: line total does not derive an exact unit price`)
      }
      const sourceName = String(line.Name ?? "").trim()
      if (!sourceName) throw new Error(`Order ${header.ID}, item ${line.ID}: product name is blank`)
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
    if (lines.length === 0) throw new Error(`Order ${header.ID}: no positive item lines`)
    const itemSubtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0)
    let subtotalCents: number
    let taxCents: number
    let totalCents: number
    let checkoutPolicy: PreparedPostCutoffOrder["checkoutPolicy"]
    const checkouts = detail.OrderCheckoutList ?? []
    if (Number(header.ID) === 1327) {
      if (checkouts.length !== 0) throw new Error("Order 1327: expected no checkout rows")
      subtotalCents = itemSubtotalCents
      taxCents = 0
      totalCents = itemSubtotalCents
      checkoutPolicy = "ORDER_1327_ITEM_SUBTOTAL_ZERO_CHARGES"
    } else {
      if (checkouts.length !== 1) throw new Error(`Order ${header.ID}: expected exactly one checkout row`)
      const checkout = checkouts[0]
      subtotalCents = cents(checkout.AmountTotal, `Order ${header.ID} checkout subtotal`)
      taxCents = cents(checkout.Tax, `Order ${header.ID} checkout tax`)
      const discountCents = cents(checkout.AmountDiscount, `Order ${header.ID} checkout discount`)
      const serviceCents = cents(checkout.ServiceCharges, `Order ${header.ID} checkout service charges`)
      const deliveryCents = cents(checkout.DeliveryCharges, `Order ${header.ID} checkout delivery charges`)
      totalCents = cents(checkout.GrandTotal, `Order ${header.ID} checkout total`)
      if (itemSubtotalCents !== subtotalCents) throw new Error(`Order ${header.ID}: items do not reconcile to checkout subtotal`)
      if (subtotalCents - discountCents + taxCents + serviceCents + deliveryCents !== totalCents) {
        throw new Error(`Order ${header.ID}: checkout components do not reconcile to grand total`)
      }
      checkoutPolicy = "SOURCE_CHECKOUT"
    }
    if (header.GrandTotal != null && cents(header.GrandTotal, `Order ${header.ID} list total`) !== totalCents) {
      throw new Error(`Order ${header.ID}: list and detail totals differ`)
    }
    const createdAt = requiredDate(header.CreatedOn || detail.OrderCreatedDT || header.OrderCreatedDT, `Order ${header.ID} created`)
    const sourceUpdatedAt = requiredDate(header.LastUpdateDT || detail.LastUpdateDT || createdAt.toISOString(), `Order ${header.ID} updated`)
    prepared.push({
      legacyOrderId: Number(header.ID),
      legacyLocationId: Number(header.LocationID),
      branchName: String(header.LocationName ?? "").trim(),
      groupName: String(header.LocationGroup ?? "").trim(),
      legacyOrderTakerId: Number(header.OrderTakerID),
      userName: String(header.UserDetails ?? detail.LastUpdatedBy ?? "").trim().replace(/\s+-\s*$/, ""),
      sourceStatus: mapping.sourceStatus,
      status: mapping.status,
      fulfillmentStatus: mapping.fulfillmentStatus,
      createdAt,
      sourceUpdatedAt,
      period: createdAt.toISOString().slice(0, 7),
      subtotalCents,
      taxCents,
      totalCents,
      checkoutPolicy,
      omittedZeroValueLines: (detail.OrderDetailsList?.length ?? 0) - lines.length,
      lines,
      sourceChecksum: sha256(canonicalJson({ header, detail, policy: checkoutPolicy })),
      sourceHeader: header,
      sourceDetail: detail,
    })
  }

  const unusedDetails = detailRows.filter((detail) => !prepared.some((order) => order.legacyOrderId === Number(detail.ID)))
  if (unusedDetails.length > 0) throw new Error(`Detail snapshot contains ${unusedDetails.length} non-importable rows`)
  return { prepared, cancelledIds, zeroValueLineIds }
}

export function validateExpectedPostCutoffTotals(prepared: PreparedPostCutoffOrder[], cancelledIds: number[]): void {
  const approved = prepared.filter((order) => order.status === "APPROVED")
  const fulfilled = prepared.filter((order) => order.status === "FULFILLED")
  const approvedTotal = approved.reduce((sum, order) => sum + order.totalCents, 0)
  const fulfilledTotal = fulfilled.reduce((sum, order) => sum + order.totalCents, 0)
  const total = prepared.reduce((sum, order) => sum + order.totalCents, 0)
  const actual = {
    cancelled: cancelledIds.length,
    importable: prepared.length,
    approved: approved.length,
    fulfilled: fulfilled.length,
    approvedTotalCents: approvedTotal,
    fulfilledTotalCents: fulfilledTotal,
    totalCents: total,
  }
  for (const [key, expected] of Object.entries(KE_POST_CUTOFF_EXPECTED)) {
    if (key === "sheetRows" || key === "afterCutoffRows") continue
    if (actual[key as keyof typeof actual] !== expected) {
      throw new Error(`Post-cutoff source gate failed for ${key}: expected ${expected}, got ${actual[key as keyof typeof actual]}`)
    }
  }
}

export function validateBudgetRows(rows: LegacyBudgetRow[]): void {
  if (rows.length !== 36) throw new Error(`Expected 36 budget rows, got ${rows.length}`)
  const keys = new Set<string>()
  for (const row of rows) {
    const period = String(row.TenureFrom).slice(0, 7)
    const key = `${normalizeLegacyText(row.Location)}|${period}`
    if (keys.has(key)) throw new Error(`Duplicate budget source row ${key}`)
    keys.add(key)
    const allocated = cents(row.MonthlyBudget, `${key} monthly budget`)
    const remaining = cents(row.RemainingBudget, `${key} remaining budget`)
    const used = cents(row.UsedBudget, `${key} used budget`)
    const credited = cents(row.AdditionalBudget, `${key} additional budget`)
    if ([allocated, remaining, used, credited].some((value) => value < 0)) throw new Error(`${key}: negative budget value`)
    if (allocated + credited - used !== remaining) throw new Error(`${key}: budget equation does not reconcile`)
  }
}

export function budgetRowCents(row: LegacyBudgetRow) {
  return {
    period: String(row.TenureFrom).slice(0, 7),
    allocatedCents: cents(row.MonthlyBudget, `${row.Location} monthly budget`),
    remainingCents: cents(row.RemainingBudget, `${row.Location} remaining budget`),
    sourceUsedCents: cents(row.UsedBudget, `${row.Location} used budget`),
    creditedCents: cents(row.AdditionalBudget, `${row.Location} additional budget`),
  }
}
