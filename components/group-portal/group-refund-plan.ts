import { calculateLineCents, roundQuantity } from "@/lib/quantity"

import type { RefundableLine, RefundableOrder } from "./types"

/**
 * The client-side model behind the group refund screen.
 *
 * A group order fans one basket out across many branches, so a refund on it is
 * usually the same complaint repeated: the same product, short or damaged, at
 * every branch that received it. The selection below is therefore keyed by
 * branch order and line, but is built through two views over that one shape —
 * "by product across branches" and "by branch" — so neither way of thinking
 * about the problem forces the user to work line by line.
 *
 * None of this is authoritative. Every quantity is re-validated, re-priced, and
 * re-checked against what is actually still refundable when the request reaches
 * the server, so anything computed here can only ever be a preview.
 */

/** orderId -> orderItemId -> quantity. Absent or zero means "not selected". */
export type RefundSelection = Record<number, Record<number, number>>

/** One product as it appears across the branch orders that can still refund it. */
export type ProductGroup = {
  globalProductId: number
  productName: string
  productCode: string | null
  unit: string | null
  priceCents: number
  /** Every branch order that still has some of this product to refund. */
  occurrences: Array<{
    orderId: number
    tid: string
    branchName: string
    line: RefundableLine
  }>
  /** The largest per-branch quantity that every listed branch could satisfy. */
  smallestRemaining: number
  largestRemaining: number
}

export type SelectionTotals = {
  branchCount: number
  lineCount: number
  totalQuantity: number
  totalCents: number
}

const EMPTY_LINES: Record<number, number> = {}

export function linesFor(selection: RefundSelection, orderId: number): Record<number, number> {
  return selection[orderId] ?? EMPTY_LINES
}

export function quantityFor(selection: RefundSelection, orderId: number, orderItemId: number): number {
  return linesFor(selection, orderId)[orderItemId] ?? 0
}

/**
 * Set one line's quantity, dropping the entry entirely when it reaches zero so
 * an emptied branch never lingers in the payload as an empty order.
 */
export function setLineQuantity(
  selection: RefundSelection,
  orderId: number,
  orderItemId: number,
  quantity: number,
): RefundSelection {
  const next: RefundSelection = { ...selection }
  const lines = { ...linesFor(selection, orderId) }

  if (quantity > 0) {
    lines[orderItemId] = roundQuantity(quantity)
  } else {
    delete lines[orderItemId]
  }

  if (Object.keys(lines).length === 0) {
    delete next[orderId]
  } else {
    next[orderId] = lines
  }
  return next
}

/** Roll the refundable orders up into the distinct products they share. */
export function buildProductGroups(orders: RefundableOrder[]): ProductGroup[] {
  const byProduct = new Map<number, ProductGroup>()

  for (const order of orders) {
    for (const line of order.lines) {
      const group = byProduct.get(line.globalProductId) ?? {
        globalProductId: line.globalProductId,
        productName: line.productName,
        productCode: line.productCode,
        unit: line.unit,
        priceCents: line.priceCents,
        occurrences: [],
        smallestRemaining: Number.POSITIVE_INFINITY,
        largestRemaining: 0,
      }
      group.occurrences.push({
        orderId: order.orderId,
        tid: order.tid,
        branchName: order.branchName,
        line,
      })
      group.smallestRemaining = Math.min(group.smallestRemaining, line.quantityRemaining)
      group.largestRemaining = Math.max(group.largestRemaining, line.quantityRemaining)
      byProduct.set(line.globalProductId, group)
    }
  }

  return [...byProduct.values()]
    .map((group) => ({
      ...group,
      smallestRemaining: Number.isFinite(group.smallestRemaining) ? group.smallestRemaining : 0,
    }))
    .sort((left, right) => left.productName.localeCompare(right.productName))
}

export type ApplyToAllResult = {
  selection: RefundSelection
  /** Branches that could not take the full quantity and were capped instead. */
  cappedBranchNames: string[]
}

/**
 * Ask for the same quantity of one product at every branch that still has it.
 *
 * A branch with less left than was asked for is capped at what it has rather
 * than dropped, and is named in the result so the screen can say so plainly —
 * a silently reduced quantity would be the one thing worse than an error here.
 */
export function applyProductToAllBranches(
  selection: RefundSelection,
  group: ProductGroup,
  quantityPerBranch: number,
): ApplyToAllResult {
  let next = selection
  const cappedBranchNames: string[] = []

  for (const occurrence of group.occurrences) {
    const requested = roundQuantity(quantityPerBranch)
    const granted = Math.min(requested, occurrence.line.quantityRemaining)
    if (granted > 0 && granted < requested) cappedBranchNames.push(occurrence.branchName)
    next = setLineQuantity(next, occurrence.orderId, occurrence.line.orderItemId, granted)
  }

  return { selection: next, cappedBranchNames }
}

/** Remove one product from every branch it was selected on. */
export function clearProductEverywhere(
  selection: RefundSelection,
  group: ProductGroup,
): RefundSelection {
  let next = selection
  for (const occurrence of group.occurrences) {
    next = setLineQuantity(next, occurrence.orderId, occurrence.line.orderItemId, 0)
  }
  return next
}

/** Drop every line of one branch order from the selection. */
export function clearOrder(selection: RefundSelection, orderId: number): RefundSelection {
  const next = { ...selection }
  delete next[orderId]
  return next
}

/** What one branch order's selected lines come to. */
export function orderSubtotalCents(selection: RefundSelection, order: RefundableOrder): number {
  const lines = linesFor(selection, order.orderId)
  return order.lines.reduce((sum, line) => {
    const quantity = lines[line.orderItemId] ?? 0
    return quantity > 0 ? sum + calculateLineCents(line.priceCents, quantity) : sum
  }, 0)
}

/** The running summary shown while the request is being built. */
export function summarizeSelection(
  selection: RefundSelection,
  orders: RefundableOrder[],
): SelectionTotals {
  return orders.reduce<SelectionTotals>((totals, order) => {
    const lines = linesFor(selection, order.orderId)
    const selectedLines = order.lines.filter((line) => (lines[line.orderItemId] ?? 0) > 0)
    if (selectedLines.length === 0) return totals

    return {
      branchCount: totals.branchCount + 1,
      lineCount: totals.lineCount + selectedLines.length,
      totalQuantity: roundQuantity(
        totals.totalQuantity + selectedLines.reduce((sum, line) => sum + (lines[line.orderItemId] ?? 0), 0),
      ),
      totalCents: totals.totalCents + orderSubtotalCents(selection, order),
    }
  }, { branchCount: 0, lineCount: 0, totalQuantity: 0, totalCents: 0 })
}

/** The selection as the API expects it: one entry per branch order with lines. */
export function toRequestPayload(
  selection: RefundSelection,
): Array<{ orderId: number; items: Array<{ id: number; quantity: number }> }> {
  return Object.entries(selection)
    .map(([orderId, lines]) => ({
      orderId: Number(orderId),
      items: Object.entries(lines)
        .filter(([, quantity]) => quantity > 0)
        .map(([orderItemId, quantity]) => ({ id: Number(orderItemId), quantity })),
    }))
    .filter((entry) => entry.items.length > 0)
}

/**
 * Clamp a typed quantity to what the line actually has left. Refund quantities
 * follow the same decimal and step rules the product was ordered under, which
 * the server enforces; this keeps the field from offering an impossible value
 * in the first place.
 */
export function clampToRemaining(line: RefundableLine, quantity: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0
  return roundQuantity(Math.min(quantity, line.quantityRemaining))
}

/** The step a quantity field should move in for this line. */
export function stepForLine(line: RefundableLine): number {
  if (!line.allowDecimalQuantity) return 1
  const step = Number(line.quantityStep)
  return Number.isFinite(step) && step > 0 ? step : 0.1
}
