import { describe, expect, it } from "vitest"

import { describeExecutiveOrganizations, toggleExecutiveOrganization } from "@/lib/apricart-executive-team-view"

const organizations = [
  { id: 4, name: "Meezan" },
  { id: 11, name: "UBL" },
  { id: 12, name: "HBL" },
]

describe("the approvers list", () => {
  it("says plainly when an executive approves nothing", () => {
    expect(describeExecutiveOrganizations([], organizations)).toBe("None — approves nothing")
  })

  it("names the assigned organizations in list order", () => {
    expect(describeExecutiveOrganizations([12, 4], organizations)).toBe("Meezan, HBL")
  })

  it("counts an assignment it cannot name rather than hiding it", () => {
    expect(describeExecutiveOrganizations([4, 99], organizations)).toBe("Meezan, 1 other")
    expect(describeExecutiveOrganizations([98, 99], organizations)).toBe("2 others")
  })
})

describe("ticking an organization", () => {
  it("adds and removes, keeping the list sorted and unique", () => {
    expect(toggleExecutiveOrganization([11], 4)).toEqual([4, 11])
    expect(toggleExecutiveOrganization([4, 11], 4)).toEqual([11])
    expect(toggleExecutiveOrganization([], 7)).toEqual([7])
  })
})
