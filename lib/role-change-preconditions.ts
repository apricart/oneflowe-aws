import { CONSUMED_HELD_STATUSES } from "@/lib/budget-consumption"

/**
 * When a user's role may be changed, and when their orders still say no.
 *
 * A role change moves a person between portals: an `ORDER_PORTAL` user raises
 * orders against one branch, a `BRANCH_ADMIN` decides them. Doing that while an
 * order they raised is still in flight strands it — the raiser can no longer
 * reach `/shop`, the fulfilment token and its email still point at them, and the
 * branch's held budget is attributed to somebody who is no longer a requester.
 * So the change waits until every order they raised has settled.
 *
 * "In flight" is not defined here. It is `CONSUMED_HELD_STATUSES` from
 * `lib/budget-consumption.ts` — the orders whose money the ledger is still
 * holding, which is the same question asked about the budget. That set derives
 * in turn from `getOrderStatusesForFilter`, so a new pending-like status reaches
 * this rule the same day it reaches the money. Restating the statuses here would
 * let the two drift, which is exactly what `CLAUDE.md` forbids for every other
 * reader of those buckets.
 *
 * Settled statuses are deliberately *not* blocking: `FULFILLED`, `PARTIAL` and
 * `PARTIALLY_FULFILLED` have moved the money and released the hold, and
 * `REJECTED`, `CANCELLED` and `REFUNDED` carry nothing. A partially fulfilled
 * order is finished as far as the ledger is concerned.
 */

/**
 * The order statuses that block a role change.
 *
 * Imported, never re-typed. See the note above.
 */
export const ROLE_CHANGE_BLOCKING_STATUSES: readonly string[] = CONSUMED_HELD_STATUSES

/** Counts of the blocking work, as the database reports them. */
export type RoleChangeBlockers = {
  /** Orders this user raised that are still `PENDING`. */
  pendingOrderCount: number
  /** Orders this user raised that are `APPROVED` but not yet fulfilled. */
  approvedOrderCount: number
}

/**
 * `ordersAwaitingApproval` is advisory and never blocks. It is set only when a
 * `GROUP_USER` is leaving the approver role and orders are still awaiting a
 * decision across the branches it covered — they remain approvable by
 * `BRANCH_ADMIN` and `HEAD_OFFICE`, so this is a consequence to state, not a
 * reason to refuse.
 */
export type RoleChangeReadiness =
  | { ready: true; ordersAwaitingApproval?: number }
  | { ready: false; reason: string; blockers: RoleChangeBlockers; ordersAwaitingApproval?: number }

function toCount(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
}

/**
 * Normalise whatever the count query returned into the two numbers this rule
 * works with. Defensive because a `COUNT` arrives as a string from some drivers.
 */
export function toRoleChangeBlockers(input: {
  pendingOrderCount?: unknown
  approvedOrderCount?: unknown
}): RoleChangeBlockers {
  return {
    pendingOrderCount: toCount(input.pendingOrderCount),
    approvedOrderCount: toCount(input.approvedOrderCount),
  }
}

export function totalBlockingOrders(blockers: RoleChangeBlockers): number {
  return blockers.pendingOrderCount + blockers.approvedOrderCount
}

function describeBlockers(blockers: RoleChangeBlockers): string {
  const parts: string[] = []
  if (blockers.pendingOrderCount > 0) {
    parts.push(`${blockers.pendingOrderCount} awaiting approval`)
  }
  if (blockers.approvedOrderCount > 0) {
    parts.push(`${blockers.approvedOrderCount} approved but not yet fulfilled`)
  }
  return parts.join(" and ")
}

/**
 * The verdict. Pure, so the dialog can preview exactly what the route enforces.
 *
 * The message names the counts because the administrator's next action is to go
 * and settle those orders, and a bare refusal would not tell them how many or
 * where to look.
 */
export function evaluateRoleChangeReadiness(
  blockers: RoleChangeBlockers,
): RoleChangeReadiness {
  if (totalBlockingOrders(blockers) === 0) return { ready: true }
  return {
    ready: false,
    reason:
      `This user has ${totalBlockingOrders(blockers)} order(s) still in progress `
      + `(${describeBlockers(blockers)}). Every order they raised must be fulfilled, `
      + `rejected, cancelled or refunded before their role can be changed.`,
    blockers,
  }
}

/**
 * Does this access change need the readiness check at all?
 *
 * Only an actual role change does. An administrator toggling MFA or moving a
 * user to another branch is not moving them between portals, and making those
 * edits wait on an unrelated pending order would be an obstruction with no
 * safety behind it.
 */
export function roleChangeRequiresSettledOrders(
  currentRole: string,
  nextRole: string,
): boolean {
  return currentRole !== nextRole
}
