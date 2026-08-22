import { roundQuantity } from "@/lib/quantity"

import { mergeEntriesIntoBranchPlans } from "../group-order-plan"
import type { BranchPlan, CatalogItem, ScopedBranch, SelectedLine } from "../types"

/** The single entry key the storefront builds; it never keeps saved sets. */
const CART_ENTRY_KEY = "storefront-cart"

/**
 * Change one product's quantity in the cart.
 *
 * A quantity of zero removes the line, because that is what every quantity
 * control in this portal means by zero. An existing line keeps its position in
 * the list rather than jumping to the end, so a correction does not reshuffle
 * the cart the user is reading.
 */
export function setCartQuantity(
  lines: SelectedLine[],
  item: CatalogItem,
  quantity: number,
): SelectedLine[] {
  const next = roundQuantity(quantity)
  if (next <= 0) {
    return lines.filter((line) => line.organizationInventoryId !== item.organizationInventoryId)
  }

  const line: SelectedLine = {
    organizationInventoryId: item.organizationInventoryId,
    quantity: next,
    name: item.name,
    unit: item.unit,
    priceCents: item.priceCents,
    // Carried so the cart and the review step can keep stepping this line by
    // its own rules once the catalogue that produced it is off screen.
    allowDecimalQuantity: item.allowDecimalQuantity,
    quantityStep: item.quantityStep,
  }

  const existing = lines.findIndex(
    (candidate) => candidate.organizationInventoryId === item.organizationInventoryId,
  )
  if (existing === -1) return [...lines, line]

  return lines.map((candidate, index) => index === existing ? line : candidate)
}

/**
 * Change one cart line's quantity without a catalogue row in hand.
 *
 * The cart carries every display field it needs, so a quantity can still be
 * corrected after the product has been paged out of the storefront.
 */
export function setCartLineQuantity(
  lines: SelectedLine[],
  organizationInventoryId: number,
  quantity: number,
): SelectedLine[] {
  const next = roundQuantity(quantity)
  if (next <= 0) {
    return lines.filter((line) => line.organizationInventoryId !== organizationInventoryId)
  }
  return lines.map((line) => line.organizationInventoryId === organizationInventoryId
    ? { ...line, quantity: next }
    : line)
}

/**
 * The per-location preview the review screen is built from.
 *
 * One cart applied to every ticked location: each location receives the same
 * lines at the same quantities, which the review screen may then diverge per
 * location. Empty on either side means there is nothing to order, which is a
 * valid state rather than an error — the caller keeps the user shopping.
 */
export function cartToBranchPlans(
  lines: SelectedLine[],
  branches: ScopedBranch[],
): BranchPlan[] {
  if (lines.length === 0 || branches.length === 0) return []

  return mergeEntriesIntoBranchPlans(
    [{ key: CART_ENTRY_KEY, branchIds: branches.map((branch) => branch.id), lines }],
    new Map(branches.map((branch) => [branch.id, branch])),
  )
}

/** Which group is being ordered for, and which of its locations are ticked. */
export type LocationSelection = {
  groupId: number | null
  branchIds: number[]
  /** True when this move dropped a different group's locations. */
  switchedGroup: boolean
}

/**
 * Whether this move takes a group's locations away from the user.
 *
 * An unset current group means nothing has been selected yet, so nothing is
 * being taken away — reporting a switch there would have the caller ask the
 * user to confirm discarding a cart that cannot exist.
 */
function isGroupChange(
  currentGroupId: number | null | undefined,
  targetGroupId: number | null,
): boolean {
  if (currentGroupId === undefined) return false
  return currentGroupId !== targetGroupId
}

/**
 * The selection after ticking or unticking one location.
 *
 * Locations are confined to a single group because the server accepts exactly
 * one group per submission — `resolveSubmissionScope` refuses a branch that
 * belongs to any group other than the one named. Ticking a location in another
 * group therefore *moves* the selection rather than adding to it: the previous
 * group's locations are dropped automatically, because a selection spanning two
 * groups is one the user could never submit.
 *
 * The location that was clicked is the only one carried over. Ticking one
 * location is a request for that location, not for its whole group.
 */
export function applyLocationToggle(
  current: { groupId: number | null | undefined; branchIds: number[] },
  target: { groupId: number | null; branchId: number },
): LocationSelection {
  if (current.groupId !== target.groupId) {
    return {
      groupId: target.groupId,
      branchIds: [target.branchId],
      switchedGroup: isGroupChange(current.groupId, target.groupId),
    }
  }

  const alreadyTicked = current.branchIds.includes(target.branchId)
  return {
    groupId: target.groupId,
    branchIds: alreadyTicked
      ? current.branchIds.filter((id) => id !== target.branchId)
      : [...current.branchIds, target.branchId],
    switchedGroup: false,
  }
}

/**
 * The selection after choosing an explicit set of locations within one group —
 * the "select all" and "clear all" shortcuts.
 *
 * Same rule as above: naming a group's locations replaces whatever any other
 * group had ticked, so the two can never be selected at once.
 */
export function applyGroupLocations(
  current: { groupId: number | null | undefined; branchIds: number[] },
  target: { groupId: number | null; branchIds: number[] },
): LocationSelection {
  return {
    groupId: target.groupId,
    branchIds: [...new Set(target.branchIds)],
    switchedGroup: isGroupChange(current.groupId, target.groupId),
  }
}

/**
 * Cheap identity for what the review screen was built from.
 *
 * Leaving review to add more products must not throw away per-location
 * corrections, but those corrections stop describing the order the moment the
 * cart or the ticked locations change. Comparing this signature is how the
 * caller tells "the user came straight back" from "the user changed something",
 * and rebuilds only in the second case.
 */
export function cartSignature(lines: SelectedLine[], branches: ScopedBranch[]): string {
  const items = [...lines]
    .map((line) => `${line.organizationInventoryId}@${roundQuantity(line.quantity)}`)
    .sort((left, right) => left.localeCompare(right))
    .join(",")
  const locations = branches
    .map((branch) => branch.id)
    .sort((left, right) => left - right)
    .join(",")

  return `${locations}|${items}`
}

/**
 * The ticked locations, in the order the group lists them.
 *
 * Filtering the group's own branch list rather than mapping the selection keeps
 * a stale id — a location deactivated since it was ticked — out of the order
 * instead of carrying it through to a submission the server would refuse.
 */
export function selectedBranches(
  groupBranches: ScopedBranch[],
  selectedBranchIds: number[],
): ScopedBranch[] {
  const selected = new Set(selectedBranchIds)
  return groupBranches.filter((branch) => selected.has(branch.id))
}
