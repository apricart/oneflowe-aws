/**
 * Where a warehouse account's branches come from.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2).
 *
 *   - "branch" — the branches and cities assigned to the account itself on
 *     Warehouse Team. What production ran before phase 2, and still runs.
 *   - "membership-fallback" — the branches of the warehouses the account is an
 *     operator of (by rule or manual route, narrowed by its scope), plus its
 *     own assignments for any branch that is in no warehouse yet.
 *   - "membership" — the warehouses' branches only.
 *
 * A code constant, deliberately not an environment variable (like
 * `PASSWORD_CHANGE_EMAIL_VERIFICATION`): moving it is a reviewed deploy, taken
 * only after `npm run check:warehouse-ownership` reports that no account would
 * lose a branch, and undone by redeploying the previous value.
 */

export const WAREHOUSE_ORDER_OWNERSHIP_MODES = ["branch", "membership-fallback", "membership"] as const
export type WarehouseOrderOwnershipMode = (typeof WAREHOUSE_ORDER_OWNERSHIP_MODES)[number]

export const WAREHOUSE_ORDER_OWNERSHIP: WarehouseOrderOwnershipMode = "branch"

/** Whether a mode reads warehouse membership for an account's branches. */
export function readsWarehouseMembership(mode: WarehouseOrderOwnershipMode): boolean {
  return mode !== "branch"
}

/** Whether a mode still reads an account's own branch and city assignments. */
export function readsAccountAssignments(mode: WarehouseOrderOwnershipMode): boolean {
  return mode !== "membership"
}
