/**
 * Budget allocation as a per-organization switch.
 *
 * `organizations.budgets_enabled` decides whether an organization's orders are
 * checked against, and held from, a branch budget. Whether a particular order
 * did so is fixed when it is created and stored as `orders.budget_tracked`;
 * every later ledger move (edit, reject, fulfil, refund, delete) asks
 * `orderTakesBudget` about the order, never the organization's current
 * setting. See `plans/OF-BUDGET-organization-budget-toggle.md`.
 *
 * Pure: no database, no session. The server side lives in
 * `lib/server/organization-budget-policy.ts`.
 */

/** Audit action recorded when a Super Admin switches budgets on or off. */
export const ORGANIZATION_BUDGETS_AUDIT_ACTION = "UPDATE_ORGANIZATION_BUDGETS_ENABLED"

/** The product default: an organization created in the application starts with budgets off. */
export const DEFAULT_ORGANIZATION_BUDGETS_ENABLED = false

/** Machine-readable code on a budget write refused because the tenant has budgets off. */
export const BUDGETS_DISABLED_CODE = "BUDGETS_DISABLED"

export const BUDGETS_DISABLED_MESSAGE = "Budget allocation is turned off for this organization."

/**
 * Raised inside an order-creation transaction that found budgets switched on
 * after the pre-flight had decided they were off, so no budget row was opened
 * to hold against. The order is refused rather than held against nothing.
 */
export const BUDGET_POLICY_CHANGED_MESSAGE =
  "Budget settings changed while this order was being placed. Please try again."

/**
 * Whether this order's money moves through the budget ledger.
 *
 * Throws when the column was not read, rather than guessing. Guessing "tracked"
 * for an untracked order would release another order's hold on rejection, or
 * fail fulfilment on a hold that is not there; guessing "untracked" for a
 * tracked one would strand its hold forever. A path that forgot to select
 * `budgetTracked` must fail in its tests, not in the ledger.
 */
export function orderTakesBudget(order: { budgetTracked?: boolean | null }): boolean {
  if (typeof order.budgetTracked !== "boolean") {
    throw new TypeError("ORDER_BUDGET_TRACKING_UNKNOWN")
  }
  return order.budgetTracked
}

/**
 * How many of the tenants on screen track budgets — so a report can say
 * "budget allocation is off" rather than "no budget" or a negative remaining.
 */
export type BudgetTrackingCoverage = "all" | "some" | "none"

export function budgetTrackingCoverage(flags: readonly boolean[]): BudgetTrackingCoverage {
  if (flags.length === 0) return "all"
  const tracked = flags.filter(Boolean).length
  if (tracked === flags.length) return "all"
  return tracked === 0 ? "none" : "some"
}
