import { describe, expect, it } from "vitest"

import {
  allVisibleSelected,
  clearVisibleOrganizations,
  filterOrganizationOptions,
  organizationSelectionLabel,
  selectVisibleOrganizations,
  toggleOrganization,
} from "@/lib/organization-multi-select"

const options = [
  { id: 1, label: "K-Electric", keywords: "KE" },
  { id: 2, label: "United Bank Limited", keywords: "UBL" },
  { id: 3, label: "Meezan (Demo)", keywords: "MEZ" },
]

describe("filterOrganizationOptions", () => {
  it("matches every word, case-insensitively, against the name and the code", () => {
    expect(filterOrganizationOptions(options, "ubl").map((option) => option.id)).toEqual([2])
    expect(filterOrganizationOptions(options, "bank united").map((option) => option.id)).toEqual([2])
    expect(filterOrganizationOptions(options, "e").map((option) => option.id)).toEqual([1, 2, 3])
    expect(filterOrganizationOptions(options, "nothing")).toEqual([])
  })

  it("returns everything for a blank query", () => {
    expect(filterOrganizationOptions(options, "   ")).toHaveLength(3)
  })
})

describe("selection", () => {
  it("toggles one organization", () => {
    expect(toggleOrganization([1], 2)).toEqual([1, 2])
    expect(toggleOrganization([1, 2], 1)).toEqual([2])
  })

  it("selects all of what the search shows, keeping earlier choices", () => {
    const visible = filterOrganizationOptions(options, "ubl")
    expect(selectVisibleOrganizations([3], visible).sort()).toEqual([2, 3])
    expect(selectVisibleOrganizations([], options).sort()).toEqual([1, 2, 3])
  })

  it("clears only what the search shows", () => {
    expect(clearVisibleOrganizations([1, 2, 3], filterOrganizationOptions(options, "ubl"))).toEqual([1, 3])
  })

  it("knows when everything shown is selected", () => {
    expect(allVisibleSelected([1, 2, 3], options)).toBe(true)
    expect(allVisibleSelected([1, 2], options)).toBe(false)
    expect(allVisibleSelected([1], [])).toBe(false)
  })
})

describe("organizationSelectionLabel", () => {
  it("names nothing, one, some or all", () => {
    expect(organizationSelectionLabel([], options, "All organizations")).toBe("All organizations")
    expect(organizationSelectionLabel([2], options, "x")).toBe("United Bank Limited")
    expect(organizationSelectionLabel([1, 2], options, "x")).toBe("2 organizations")
    expect(organizationSelectionLabel([1, 2, 3], options, "x")).toBe("All organizations (3)")
  })
})
