import { describe, expect, it } from "vitest"

import {
  PROPAGATION_MODES,
  groupsWithChangedPrice,
  isPropagationMode,
  planGroupPricePropagation,
  type GroupPriceState,
  type PropagationMode,
} from "@/lib/group-price-propagation"

const BASE = 10_000

/** North has its own price; South and East inherit the organization's. */
const groups: GroupPriceState[] = [
  { groupId: 1, name: "North", groupPriceCents: 6_000 },
  { groupId: 2, name: "South", groupPriceCents: null },
  { groupId: 3, name: "East", groupPriceCents: null },
]

const plan = (
  mode: PropagationMode,
  overrides: Partial<Parameters<typeof planGroupPricePropagation>[0]> = {},
) => planGroupPricePropagation({
  mode,
  basePriceCents: BASE,
  currentOrganizationPriceCents: 8_000,
  nextOrganizationPriceCents: 9_000,
  groups,
  ...overrides,
})

const actionFor = (result: ReturnType<typeof plan>, groupId: number) =>
  result.actions.find((action) => action.groupId === groupId)!

describe("propagation mode", () => {
  it("recognises exactly the three supported modes", () => {
    expect(PROPAGATION_MODES).toEqual(["none", "all", "selected"])
    for (const mode of PROPAGATION_MODES) expect(isPropagationMode(mode)).toBe(true)
  })

  it.each([["", ""], ["unknown", "everything"], ["null", null], ["a number", 1]])(
    "rejects %s",
    (_label, value) => {
      expect(isPropagationMode(value)).toBe(false)
    },
  )
})

describe("mode: none — nothing is written at group level", () => {
  const result = plan("none")

  it("writes nothing", () => {
    expect(result.isNoOp).toBe(true)
    expect(result.clearGroupIds).toEqual([])
    expect(result.pins).toEqual([])
  })

  it("leaves a group with its own price on that price", () => {
    expect(actionFor(result, 1)).toMatchObject({ action: "unchanged", afterCents: 6_000 })
  })

  it("lets an unpriced group follow the organization to the new price", () => {
    // This is the pre-existing behaviour, and the reason the other two modes
    // are needed at all.
    expect(actionFor(result, 2)).toMatchObject({
      action: "unchanged",
      beforeCents: 8_000,
      afterCents: 9_000,
    })
  })
})

describe("mode: all — every group pays the new organization price", () => {
  const result = plan("all")

  it("removes the override that was insulating a group", () => {
    expect(actionFor(result, 1)).toMatchObject({
      action: "clear",
      beforeCents: 6_000,
      afterCents: 9_000,
    })
    expect(result.clearGroupIds).toEqual([1])
  })

  it("writes nothing for a group that already follows", () => {
    expect(actionFor(result, 2)).toMatchObject({ action: "unchanged", afterCents: 9_000 })
  })

  it("never pins anything", () => {
    expect(result.pins).toEqual([])
  })

  it("leaves every group on the same price", () => {
    for (const action of result.actions) expect(action.afterCents).toBe(9_000)
  })
})

describe("mode: selected — only the chosen groups move", () => {
  const result = plan("selected", { selectedGroupIds: [2] })

  it("lets the selected unpriced group take the new price without a write", () => {
    expect(actionFor(result, 2)).toMatchObject({
      action: "unchanged",
      beforeCents: 8_000,
      afterCents: 9_000,
    })
  })

  it("pins an unselected unpriced group so it does NOT drift", () => {
    // The heart of the feature: East has no override, so without this it would
    // silently move to 9000 along with the organization price.
    expect(actionFor(result, 3)).toMatchObject({
      action: "pin",
      beforeCents: 8_000,
      afterCents: 8_000,
      pinnedCents: 8_000,
    })
    expect(result.pins).toEqual([{ groupId: 3, customPriceCents: 8_000 }])
  })

  it("leaves an unselected group that already has its own price alone", () => {
    // It is already insulated; writing to it would be noise.
    expect(actionFor(result, 1)).toMatchObject({ action: "unchanged", afterCents: 6_000 })
  })

  it("clears the override of a selected group that had one", () => {
    const withPricedSelection = plan("selected", { selectedGroupIds: [1] })
    expect(actionFor(withPricedSelection, 1)).toMatchObject({
      action: "clear",
      afterCents: 9_000,
    })
    // ...and the two unpriced groups are both held still.
    expect(withPricedSelection.pins).toEqual([
      { groupId: 2, customPriceCents: 8_000 },
      { groupId: 3, customPriceCents: 8_000 },
    ])
  })

  it("selecting every group is equivalent to `all`", () => {
    const everyGroup = plan("selected", { selectedGroupIds: [1, 2, 3] })
    expect(everyGroup.pins).toEqual([])
    expect(everyGroup.clearGroupIds).toEqual([1])
    for (const action of everyGroup.actions) expect(action.afterCents).toBe(9_000)
  })

  it("selecting nothing holds every unpriced group where it is", () => {
    const noSelection = plan("selected", { selectedGroupIds: [] })
    expect(noSelection.clearGroupIds).toEqual([])
    expect(noSelection.pins).toEqual([
      { groupId: 2, customPriceCents: 8_000 },
      { groupId: 3, customPriceCents: 8_000 },
    ])
    for (const action of noSelection.actions) {
      expect(action.afterCents).toBe(action.beforeCents)
    }
  })

  it("ignores a group id that is not in the organization", () => {
    const strayId = plan("selected", { selectedGroupIds: [2, 9_999] })
    expect(strayId.actions).toHaveLength(3)
    expect(strayId.pins).toEqual([{ groupId: 3, customPriceCents: 8_000 }])
  })
})

describe("no pointless writes", () => {
  it("pins nothing when the organization price is not actually moving", () => {
    // Re-saving the same price must not scatter override rows across every
    // group, which would insulate them all from the *next* change.
    const unchanged = plan("selected", {
      selectedGroupIds: [2],
      nextOrganizationPriceCents: 8_000,
    })
    expect(unchanged.isNoOp).toBe(true)
    expect(unchanged.pins).toEqual([])
  })

  it("still clears overrides when the organization price is unchanged", () => {
    // "All groups" means "everyone on the organization price"; a group sitting
    // on its own price is still moved onto it.
    const result = plan("all", { nextOrganizationPriceCents: 8_000 })
    expect(result.clearGroupIds).toEqual([1])
    expect(actionFor(result, 1)).toMatchObject({ beforeCents: 6_000, afterCents: 8_000 })
  })

  it("reports an empty organization as a no-op in every mode", () => {
    for (const mode of PROPAGATION_MODES) {
      expect(plan(mode, { groups: [] })).toMatchObject({ isNoOp: true, actions: [] })
    }
  })
})

describe("falling through to the global base price", () => {
  it("uses the base price when the organization has no override", () => {
    const result = planGroupPricePropagation({
      mode: "selected",
      selectedGroupIds: [2],
      basePriceCents: BASE,
      currentOrganizationPriceCents: null,
      nextOrganizationPriceCents: 7_000,
      groups,
    })

    // East was paying the global base price, so that is what it is pinned at.
    expect(actionFor(result, 3)).toMatchObject({ action: "pin", pinnedCents: BASE })
    expect(actionFor(result, 2)).toMatchObject({ beforeCents: BASE, afterCents: 7_000 })
  })

  it("handles clearing the organization override back to the base price", () => {
    const result = planGroupPricePropagation({
      mode: "all",
      basePriceCents: BASE,
      currentOrganizationPriceCents: 8_000,
      nextOrganizationPriceCents: null,
      groups,
    })

    for (const action of result.actions) expect(action.afterCents).toBe(BASE)
    expect(result.clearGroupIds).toEqual([1])
  })

  it("treats a zero price as a real price, not an absent one", () => {
    const result = planGroupPricePropagation({
      mode: "selected",
      selectedGroupIds: [1],
      basePriceCents: BASE,
      currentOrganizationPriceCents: 0,
      nextOrganizationPriceCents: 5_000,
      groups,
    })

    // South and East were paying 0 and must be held there, not sent to the base
    // price by a falsy check.
    expect(result.pins).toEqual([
      { groupId: 2, customPriceCents: 0 },
      { groupId: 3, customPriceCents: 0 },
    ])
  })
})

describe("summarising the change for the confirmation screen", () => {
  it("lists only the groups whose price actually moves", () => {
    const changed = groupsWithChangedPrice(plan("selected", { selectedGroupIds: [2] }))
    expect(changed.map((action) => action.groupId)).toEqual([2])
  })

  it("lists every group that moves under `all`", () => {
    const changed = groupsWithChangedPrice(plan("all"))
    // North 6000 -> 9000, South and East 8000 -> 9000.
    expect(changed.map((action) => action.groupId)).toEqual([1, 2, 3])
  })

  it("lists nothing when the price is unchanged", () => {
    expect(groupsWithChangedPrice(plan("none", { nextOrganizationPriceCents: 8_000 })))
      .toEqual([])
  })
})
