import { resolveEffectivePriceCents } from "@/lib/price-ladder"

/**
 * What happens to group prices when the organization price changes.
 *
 * The non-obvious part, and the reason this is a planner rather than a flag: a
 * group with **no** override of its own already follows the organization price,
 * so it moves whether anyone asked for it or not. "Apply this only to group A"
 * therefore cannot be done by writing to group A — it is done by *pinning*
 * every other unpriced group at what it pays today, so only A drifts to the new
 * price.
 *
 * That gives three outcomes an administrator can actually reason about:
 *
 *  * `all`      — every group pays the new organization price. Group overrides
 *                 for this product are removed, so nothing is left behind
 *                 insulating a group from the next change either.
 *  * `selected` — the chosen groups pay the new price; every other group keeps
 *                 paying exactly what it pays now. Unpriced groups outside the
 *                 selection are pinned at their current price to hold them
 *                 still; priced ones are already insulated and are left alone.
 *  * `none`     — nothing is written at group level. Groups with their own
 *                 price keep it; groups without one follow the new organization
 *                 price. This is what the application did before this feature
 *                 existed, and it stays the default.
 *
 * Pure and dependency-free apart from the price ladder itself, so the same plan
 * drives the confirmation screen's preview and the server's write. The client
 * never sends a plan — it sends the mode, and the server rebuilds the plan from
 * its own rows.
 */

export const PROPAGATION_MODES = ["none", "all", "selected"] as const
export type PropagationMode = (typeof PROPAGATION_MODES)[number]

export function isPropagationMode(value: unknown): value is PropagationMode {
  return typeof value === "string"
    && (PROPAGATION_MODES as readonly string[]).includes(value)
}

/** A group as it stands before the change. */
export type GroupPriceState = {
  groupId: number
  name: string
  /** The group's own override, or null when it inherits. */
  groupPriceCents: number | null
}

export type GroupPriceAction =
  /** Nothing is written for this group. */
  | { groupId: number; name: string; action: "unchanged"; beforeCents: number; afterCents: number }
  /** Its override is deleted so it follows the new organization price. */
  | { groupId: number; name: string; action: "clear"; beforeCents: number; afterCents: number }
  /** An override is written to hold it at the price it pays today. */
  | {
    groupId: number
    name: string
    action: "pin"
    beforeCents: number
    afterCents: number
    pinnedCents: number
  }

export type PropagationPlan = {
  mode: PropagationMode
  /** Every group in the organization, including the ones nothing happens to. */
  actions: GroupPriceAction[]
  /** Groups whose override is removed. */
  clearGroupIds: number[]
  /** Groups that gain an override purely to stop them moving. */
  pins: Array<{ groupId: number; customPriceCents: number }>
  /** True when no group's price changes, so the write can skip the group tier. */
  isNoOp: boolean
}

export type PropagationInput = {
  mode: PropagationMode
  /** Only meaningful for `selected`; ignored otherwise. */
  selectedGroupIds?: number[]
  /** `global_products.base_price_cents` — the tier below the organization. */
  basePriceCents: number
  /** The organization override before the change, or null when it inherits. */
  currentOrganizationPriceCents: number | null
  /** The organization override after the change, or null to clear it. */
  nextOrganizationPriceCents: number | null
  groups: GroupPriceState[]
}

function effectiveFor(
  groupPriceCents: number | null,
  organizationPriceCents: number | null,
  basePriceCents: number,
): number {
  return resolveEffectivePriceCents({
    groupPriceCents,
    organizationPriceCents,
    basePriceCents,
  }) ?? basePriceCents
}

/**
 * Build the plan. Never writes, never reads — the caller supplies the rows and
 * applies the result.
 */
export function planGroupPricePropagation(input: PropagationInput): PropagationPlan {
  const { basePriceCents, currentOrganizationPriceCents, nextOrganizationPriceCents } = input
  const selected = new Set(input.selectedGroupIds ?? [])

  const priceBefore = (group: GroupPriceState) =>
    effectiveFor(group.groupPriceCents, currentOrganizationPriceCents, basePriceCents)
  const organizationPriceAfter = effectiveFor(null, nextOrganizationPriceCents, basePriceCents)

  const actions = input.groups.map<GroupPriceAction>((group) => {
    const beforeCents = priceBefore(group)
    const hasOwnPrice = group.groupPriceCents !== null
    const base = { groupId: group.groupId, name: group.name }

    // Nothing at group level is touched; a group without its own price simply
    // follows the organization to wherever it went.
    if (input.mode === "none") {
      return {
        ...base,
        action: "unchanged",
        beforeCents,
        afterCents: hasOwnPrice ? group.groupPriceCents as number : organizationPriceAfter,
      }
    }

    const followsNewPrice = input.mode === "all" || selected.has(group.groupId)

    if (followsNewPrice) {
      // Clearing is only a write when there is an override to remove; an
      // unpriced group already follows and needs nothing.
      return {
        ...base,
        action: hasOwnPrice ? "clear" : "unchanged",
        beforeCents,
        afterCents: organizationPriceAfter,
      }
    }

    // Outside the selection. A group with its own price is already insulated.
    if (hasOwnPrice) {
      return { ...base, action: "unchanged", beforeCents, afterCents: group.groupPriceCents as number }
    }

    // The case the whole planner exists for: an unpriced group would drift to
    // the new organization price, so it is pinned at what it pays today. If the
    // price is not actually moving, pinning would only leave a redundant row.
    if (beforeCents === organizationPriceAfter) {
      return { ...base, action: "unchanged", beforeCents, afterCents: organizationPriceAfter }
    }

    return {
      ...base,
      action: "pin",
      beforeCents,
      afterCents: beforeCents,
      pinnedCents: beforeCents,
    }
  })

  const clearGroupIds = actions
    .filter((action) => action.action === "clear")
    .map((action) => action.groupId)

  const pins = actions
    .filter((action): action is Extract<GroupPriceAction, { action: "pin" }> => action.action === "pin")
    .map((action) => ({ groupId: action.groupId, customPriceCents: action.pinnedCents }))

  return {
    mode: input.mode,
    actions,
    clearGroupIds,
    pins,
    isNoOp: clearGroupIds.length === 0 && pins.length === 0,
  }
}

/** Groups whose price actually moves. Drives the "N groups affected" summary. */
export function groupsWithChangedPrice(plan: PropagationPlan): GroupPriceAction[] {
  return plan.actions.filter((action) => action.beforeCents !== action.afterCents)
}
