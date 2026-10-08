import { getOrderStatusesForFilter } from "@/lib/order-status"

/**
 * The rules that decide what a branch has consumed from its budget.
 *
 * Consumption is stated twice in this codebase and has to come out the same
 * both times: once as the running totals the order lifecycle writes onto
 * `budgets` (`amount_spent_cents`, `amount_held_cents`), and once as the
 * `orders` table re-aggregated for a date window. Analytics picks whichever
 * fits the question — the ledger cannot be narrowed to part of a month, and the
 * orders sum can. They only agree if all three rules below are stated once.
 *
 * See `plans/OF-BUDGET-ledger-orders-parity.md`.
 */

/** An order, as much of one as any consumption rule needs. */
export type ConsumptionOrder = {
  status?: string | null
  totalCents?: number | string | null
  refundAmountCents?: number | string | null
}

/**
 * Money already gone: the order was fulfilled, in whole or in part.
 *
 * Taken from `lib/order-status.ts` rather than restated, so a new fulfilment
 * status reaches the money the same day it reaches the rest of the app.
 */
export const CONSUMED_SPENT_STATUSES: readonly string[] = getOrderStatusesForFilter("fulfilled")

/**
 * Money committed but not yet gone: the order is awaiting a decision or has
 * been approved and not yet fulfilled. This is the hold the ledger carries in
 * `amount_held_cents` from creation until fulfilment or release.
 */
export const CONSUMED_HELD_STATUSES: readonly string[] = [
  ...getOrderStatusesForFilter("pending"),
  ...getOrderStatusesForFilter("approved"),
]

export type ConsumptionBucket = "spent" | "held" | "none"

function normalizeStatus(status?: string | null): string {
  return (status || "").trim().toUpperCase()
}

function toCents(value?: number | string | null): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Which side of the ledger this order sits on, or neither.
 *
 * `REJECTED`, `CANCELLED` and `REFUNDED` are "none": the first two had their
 * hold released, and a fully refunded order had its spend withdrawn, so the
 * ledger carries nothing for any of them.
 */
export function classifyOrderConsumption(order: ConsumptionOrder): ConsumptionBucket {
  const status = normalizeStatus(order.status)
  if (CONSUMED_SPENT_STATUSES.includes(status)) return "spent"
  if (CONSUMED_HELD_STATUSES.includes(status)) return "held"
  return "none"
}

/**
 * What this one order consumes, net of anything refunded against it.
 *
 * Clamped at zero: a refund can never exceed its order, but a repaired or
 * imported row can say otherwise, and a negative here would silently credit
 * the branch. The SQL counterpart clamps identically.
 */
export function orderConsumptionCents(order: ConsumptionOrder): number {
  return Math.max(0, toCents(order.totalCents) - toCents(order.refundAmountCents))
}

/** This order's contribution to a branch/period's spent total. */
export function orderSpentCents(order: ConsumptionOrder): number {
  return classifyOrderConsumption(order) === "spent" ? orderConsumptionCents(order) : 0
}

/** This order's contribution to a branch/period's held total. */
export function orderHeldCents(order: ConsumptionOrder): number {
  return classifyOrderConsumption(order) === "held" ? orderConsumptionCents(order) : 0
}

/**
 * The budget period an order's money belongs to: **UTC** `YYYY-MM`.
 *
 * This is the rule the write path has always applied — the creation hold, the
 * fulfilment move and the rejection release all target the UTC-month row — so
 * it is the rule every read has to apply to find the same money. It is
 * deliberately not the Asia/Karachi month `buildAppMonthPeriods` uses to choose
 * *which* periods a report covers: that selects rows, this names one.
 */
/** Anything `budgetPeriodOf` accepts; nullish means "now". */
type BudgetPeriodInput = Date | string | number | null | undefined

export function budgetPeriodOf(date: BudgetPeriodInput): string {
  const resolved = date == null ? new Date() : new Date(date)
  const usable = Number.isNaN(resolved.getTime()) ? new Date() : resolved
  return usable.toISOString().slice(0, 7)
}

/** Whether two instants fall in the same budget period. */
export function isSameBudgetPeriod(
  left: Date | string | number | null | undefined,
  right: Date | string | number | null | undefined,
): boolean {
  return budgetPeriodOf(left) === budgetPeriodOf(right)
}

/** How an approved refund moves its order's period row on the money ledger. */
export type RefundLedgerMove = {
  /** Withdrawn from `amount_spent_cents`. */
  spentDebitCents: number
  /** Added to `amount_credited_cents`. */
  creditCents: number
}

/**
 * The single rule both refund routes apply to the budget row of the order's
 * own period (`plans/OF-BUDGET-refund-ledger-debit.md`).
 *
 * A refund of an order whose money is already spent is withdrawn from
 * `spent`, because every order-side reader nets refunds out of consumption
 * (`orderConsumptionCents`); crediting it instead left the ledger saying the
 * branch consumed the refunded money, and a reader combining the two counted
 * the refund twice. The debit never exceeds what the row has spent — a
 * repaired or imported row can hold less — and whatever it cannot take is
 * credited, so the branch always gets exactly the refund back.
 *
 * A refund of an order still holding its budget is credited and the hold left
 * whole: fulfilment, rejection and cancellation each move the order's full
 * total out of `held`, and a smaller hold would make them fail or eat another
 * order's hold.
 */
export function planRefundLedgerMove(input: {
  orderStatus?: string | null
  refundCents: number
  rowSpentCents: number
}): RefundLedgerMove {
  const refund = Math.max(0, Math.trunc(toCents(input.refundCents)))
  if (classifyOrderConsumption({ status: input.orderStatus }) !== "spent") {
    return { spentDebitCents: 0, creditCents: refund }
  }
  const spentDebitCents = Math.min(refund, Math.max(0, Math.trunc(toCents(input.rowSpentCents))))
  return { spentDebitCents, creditCents: refund - spentDebitCents }
}

/**
 * Sum a set of orders the way the SQL does — the oracle a parity test checks
 * the database against.
 */
export function summarizeOrderConsumption(orders: readonly ConsumptionOrder[]): {
  spentCents: number
  heldCents: number
  consumedCents: number
} {
  const spentCents = orders.reduce((sum, order) => sum + orderSpentCents(order), 0)
  const heldCents = orders.reduce((sum, order) => sum + orderHeldCents(order), 0)
  return { spentCents, heldCents, consumedCents: spentCents + heldCents }
}
