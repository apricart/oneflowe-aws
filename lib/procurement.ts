/**
 * Purchasing into Apricart warehouses — the pure rules.
 * See plans/OF-PROCUREMENT-purchasing.md.
 *
 * Everything here is arithmetic and state: no database, no request. Quantities
 * carry three decimals and are compared in thousandths, money is integer cents.
 */

import { isWholeQuantity, roundQuantity } from "@/lib/quantity"

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export const PURCHASE_ORDER_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CLOSED",
  "REJECTED",
  "CANCELLED",
] as const
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number]

export const PURCHASE_ORDER_STATUS_LABELS: Readonly<Record<PurchaseOrderStatus, string>> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Awaiting approval",
  APPROVED: "Approved",
  PARTIALLY_RECEIVED: "Partly received",
  RECEIVED: "Received",
  CLOSED: "Closed short",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
}

export const REQUISITION_STATUSES = ["SUBMITTED", "CONVERTED", "REJECTED", "CANCELLED"] as const
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number]

export const SUPPLIER_INVOICE_STATUSES = ["RECORDED", "APPROVED", "REJECTED", "PAID"] as const
export type SupplierInvoiceStatus = (typeof SUPPLIER_INVOICE_STATUSES)[number]
export type InvoiceMatchStatus = "MATCHED" | "EXCEPTION"

export const CUSTOMER_RETURN_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const
export type CustomerReturnStatus = (typeof CUSTOMER_RETURN_STATUSES)[number]
export const RETURN_CONDITIONS = ["RESALEABLE", "DAMAGED"] as const
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number]

/** What a PO action needs the order to be in, and what it leaves it as. */
export const PURCHASE_ORDER_ACTIONS = ["update", "submit", "withdraw", "approve", "reject", "cancel", "close"] as const
export type PurchaseOrderAction = (typeof PURCHASE_ORDER_ACTIONS)[number]

const ACTION_FROM: Readonly<Record<PurchaseOrderAction, readonly PurchaseOrderStatus[]>> = {
  update: ["DRAFT"],
  submit: ["DRAFT"],
  withdraw: ["PENDING_APPROVAL"],
  approve: ["PENDING_APPROVAL"],
  reject: ["PENDING_APPROVAL"],
  cancel: ["DRAFT", "PENDING_APPROVAL", "APPROVED"],
  close: ["PARTIALLY_RECEIVED"],
}

const ACTION_TO: Readonly<Record<PurchaseOrderAction, PurchaseOrderStatus>> = {
  update: "DRAFT",
  submit: "PENDING_APPROVAL",
  withdraw: "DRAFT",
  approve: "APPROVED",
  reject: "REJECTED",
  cancel: "CANCELLED",
  close: "CLOSED",
}

/** Null when the action is allowed from this status; otherwise why not. */
export function purchaseOrderActionRefusal(action: PurchaseOrderAction, status: string): string | null {
  if ((ACTION_FROM[action] as readonly string[]).includes(status)) return null
  const label = PURCHASE_ORDER_STATUS_LABELS[status as PurchaseOrderStatus] ?? status
  return `This purchase order is ${label.toLowerCase()} and cannot be ${ACTION_PAST[action]} now.`
}

const ACTION_PAST: Readonly<Record<PurchaseOrderAction, string>> = {
  update: "edited",
  submit: "submitted",
  withdraw: "withdrawn",
  approve: "approved",
  reject: "rejected",
  cancel: "cancelled",
  close: "closed",
}

export function purchaseOrderStatusAfter(action: PurchaseOrderAction): PurchaseOrderStatus {
  return ACTION_TO[action]
}

/** A PO that goods may still be received against. */
export function isReceivableStatus(status: string): boolean {
  return status === "APPROVED" || status === "PARTIALLY_RECEIVED"
}

/** A PO a supplier invoice may be recorded against: approved, whatever has arrived. */
export function isInvoiceableStatus(status: string): boolean {
  return status === "APPROVED" || status === "PARTIALLY_RECEIVED" || status === "RECEIVED" || status === "CLOSED"
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** 20% — decided 2026-10-28. Changeable by Super Admin; 0..100%. */
export const DEFAULT_OVER_DELIVERY_TOLERANCE_BPS = 2000
export const MAX_OVER_DELIVERY_TOLERANCE_BPS = 10000

export function toleranceBpsFromPercent(percent: number): number {
  return Math.round(percent * 100)
}

export function tolerancePercent(bps: number): number {
  return bps / 100
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

function reference(prefix: string, id: number): string {
  return `${prefix}-${String(id).padStart(6, "0")}`
}

export const purchaseOrderReference = (id: number): string => reference("PO", id)
export const requisitionReference = (id: number): string => reference("PR", id)
export const goodsReceiptReference = (id: number): string => reference("GRN", id)
export const customerReturnReference = (id: number): string => reference("CR", id)

// ---------------------------------------------------------------------------
// Quantities and money
// ---------------------------------------------------------------------------

/** Thousandths, so three-decimal quantities compare exactly. */
export function toMilli(quantity: number): number {
  return Math.round(roundQuantity(quantity) * 1000)
}

export function fromMilli(milli: number): number {
  return milli / 1000
}

/** Null when the quantity is acceptable for the product; otherwise why not. */
export function quantityRefusal(quantity: number, allowDecimalQuantity: boolean, productName: string): string | null {
  if (!Number.isFinite(quantity) || quantity <= 0) return `Enter a quantity above zero for ${productName}.`
  if (!allowDecimalQuantity && !isWholeQuantity(quantity)) return `${productName} is counted in whole units.`
  return null
}

export type CostedLine = { quantity: number; unitCostCents: number; taxRateBps: number }
export type LineMoney = { netCents: number; taxCents: number; totalCents: number }

/** A line's money: net = quantity × unit cost, tax = net × rate, each rounded to the paisa. */
export function lineMoney(line: CostedLine): LineMoney {
  const netCents = Math.round((toMilli(line.quantity) * line.unitCostCents) / 1000)
  const taxCents = Math.round((netCents * line.taxRateBps) / 10000)
  return { netCents, taxCents, totalCents: netCents + taxCents }
}

export function sumMoney(lines: readonly LineMoney[]): { subtotalCents: number; taxCents: number; totalCents: number } {
  const subtotalCents = lines.reduce((sum, line) => sum + line.netCents, 0)
  const taxCents = lines.reduce((sum, line) => sum + line.taxCents, 0)
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents }
}

/** Every product named at most once on one document. */
export function duplicateProductIds(lines: ReadonlyArray<{ globalProductId: number }>): number[] {
  const seen = new Set<number>()
  const duplicates = new Set<number>()
  for (const line of lines) {
    if (seen.has(line.globalProductId)) duplicates.add(line.globalProductId)
    seen.add(line.globalProductId)
  }
  return [...duplicates]
}

// ---------------------------------------------------------------------------
// Goods receipts
// ---------------------------------------------------------------------------

/** The most that may ever be received on a line: ordered plus the tolerance, in thousandths. */
export function maxReceivableMilli(orderedQuantity: number, toleranceBps: number): number {
  return Math.floor((toMilli(orderedQuantity) * (10000 + toleranceBps)) / 10000)
}

export type ReceivablePoLine = {
  id: number
  globalProductId: number
  productName: string
  quantity: number
  receivedQuantity: number
  allowDecimalQuantity: boolean
}

export type ReceiptPlan =
  | {
      ok: true
      lines: Array<{ purchaseOrderLineId: number; globalProductId: number; quantity: number; receivedAfter: number }>
      fullyReceived: boolean
    }
  | { ok: false; error: string }

/**
 * Check a receipt against the PO's lines and tolerance. Each line may be
 * received in parts; the running total may not exceed ordered × (1 + tolerance).
 * The PO is fully received once every line has at least its ordered quantity.
 */
export function planGoodsReceipt(input: {
  poLines: readonly ReceivablePoLine[]
  toleranceBps: number
  receipt: ReadonlyArray<{ purchaseOrderLineId: number; quantity: number }>
}): ReceiptPlan {
  if (input.receipt.length === 0) return { ok: false, error: "Enter at least one received quantity." }
  const byId = new Map(input.poLines.map((line) => [line.id, line]))
  const seen = new Set<number>()
  const received = new Map(input.poLines.map((line) => [line.id, toMilli(line.receivedQuantity)]))
  const lines: Array<{ purchaseOrderLineId: number; globalProductId: number; quantity: number; receivedAfter: number }> = []

  for (const entry of input.receipt) {
    const poLine = byId.get(entry.purchaseOrderLineId)
    if (!poLine) return { ok: false, error: "A received line is not on this purchase order." }
    if (seen.has(poLine.id)) return { ok: false, error: `${poLine.productName} is entered twice.` }
    seen.add(poLine.id)
    const refusal = quantityRefusal(entry.quantity, poLine.allowDecimalQuantity, poLine.productName)
    if (refusal) return { ok: false, error: refusal }
    const after = (received.get(poLine.id) ?? 0) + toMilli(entry.quantity)
    const max = maxReceivableMilli(poLine.quantity, input.toleranceBps)
    if (after > max) {
      const remaining = Math.max(0, max - (received.get(poLine.id) ?? 0))
      return {
        ok: false,
        error: `${poLine.productName}: at most ${fromMilli(remaining)} more can be received (ordered ${poLine.quantity}, over-delivery allowed ${tolerancePercent(input.toleranceBps)}%).`,
      }
    }
    received.set(poLine.id, after)
    lines.push({
      purchaseOrderLineId: poLine.id,
      globalProductId: poLine.globalProductId,
      quantity: roundQuantity(entry.quantity),
      receivedAfter: fromMilli(after),
    })
  }

  const fullyReceived = input.poLines.every((line) => (received.get(line.id) ?? 0) >= toMilli(line.quantity))
  return { ok: true, lines, fullyReceived }
}

/** Ordered quantity not yet received, never below zero — "on order". */
export function outstandingQuantity(line: { quantity: number; receivedQuantity: number }): number {
  return fromMilli(Math.max(0, toMilli(line.quantity) - toMilli(line.receivedQuantity)))
}

// ---------------------------------------------------------------------------
// Three-way match
// ---------------------------------------------------------------------------

export type MatchPoLine = {
  id: number
  productName: string
  unitCostCents: number
  taxRateBps: number
  receivedQuantity: number
  allowDecimalQuantity: boolean
}

export type InvoiceLineInput = { purchaseOrderLineId: number; quantity: number; unitCostCents: number }

export type InvoiceLineResult = InvoiceLineInput &
  LineMoney & { quantityMatches: boolean; priceMatches: boolean; productName: string }

export type InvoicePlan =
  | {
      ok: true
      lines: InvoiceLineResult[]
      matchStatus: InvoiceMatchStatus
      exceptions: string[]
      totals: { subtotalCents: number; taxCents: number; totalCents: number }
    }
  | { ok: false; error: string }

/**
 * Match an invoice against the PO and what was received. A line matches when
 * everything invoiced on it so far — earlier invoices not rejected, plus this
 * one — is within what was received, and its unit cost is the PO's. Tax is the
 * PO line's rate on the invoiced net.
 */
export function planSupplierInvoice(input: {
  poLines: readonly MatchPoLine[]
  alreadyInvoicedByLine: ReadonlyMap<number, number>
  lines: readonly InvoiceLineInput[]
}): InvoicePlan {
  if (input.lines.length === 0) return { ok: false, error: "An invoice needs at least one line." }
  const byId = new Map(input.poLines.map((line) => [line.id, line]))
  const seen = new Set<number>()
  const results: InvoiceLineResult[] = []
  const exceptions: string[] = []

  for (const line of input.lines) {
    const poLine = byId.get(line.purchaseOrderLineId)
    if (!poLine) return { ok: false, error: "An invoice line is not on this purchase order." }
    if (seen.has(poLine.id)) return { ok: false, error: `${poLine.productName} is entered twice.` }
    seen.add(poLine.id)
    const refusal = quantityRefusal(line.quantity, poLine.allowDecimalQuantity, poLine.productName)
    if (refusal) return { ok: false, error: refusal }
    if (!Number.isInteger(line.unitCostCents) || line.unitCostCents < 0) {
      return { ok: false, error: `Enter a valid unit cost for ${poLine.productName}.` }
    }

    const invoicedAfter = toMilli(input.alreadyInvoicedByLine.get(poLine.id) ?? 0) + toMilli(line.quantity)
    const quantityMatches = invoicedAfter <= toMilli(poLine.receivedQuantity)
    const priceMatches = line.unitCostCents === poLine.unitCostCents
    if (!quantityMatches) {
      exceptions.push(`${poLine.productName}: invoiced ${fromMilli(invoicedAfter)}, received ${poLine.receivedQuantity}.`)
    }
    if (!priceMatches) {
      exceptions.push(`${poLine.productName}: unit cost differs from the purchase order.`)
    }
    const money = lineMoney({ quantity: line.quantity, unitCostCents: line.unitCostCents, taxRateBps: poLine.taxRateBps })
    results.push({ ...line, quantity: roundQuantity(line.quantity), ...money, quantityMatches, priceMatches, productName: poLine.productName })
  }

  return {
    ok: true,
    lines: results,
    matchStatus: exceptions.length === 0 ? "MATCHED" : "EXCEPTION",
    exceptions,
    totals: sumMoney(results),
  }
}

export type InvoiceDecision = "approve" | "reject" | "pay"

/** Null when the decision is allowed on an invoice in this state; otherwise why not. */
export function supplierInvoiceDecisionRefusal(decision: InvoiceDecision, status: string): string | null {
  if (decision === "pay") return status === "APPROVED" ? null : "Only an approved invoice can be marked paid."
  return status === "RECORDED" ? null : "This invoice has already been decided."
}

// ---------------------------------------------------------------------------
// Customer returns
// ---------------------------------------------------------------------------

/** What an approved return puts back on the shelf: resaleable quantities, per product. */
export function returnRestockLines(
  lines: ReadonlyArray<{ globalProductId: number; quantity: number; condition: string }>,
): Array<{ globalProductId: number; quantity: number }> {
  const totals = new Map<number, number>()
  for (const line of lines) {
    if (line.condition !== "RESALEABLE") continue
    totals.set(line.globalProductId, (totals.get(line.globalProductId) ?? 0) + toMilli(line.quantity))
  }
  return [...totals].map(([globalProductId, milli]) => ({ globalProductId, quantity: fromMilli(milli) }))
}
