import { describe, expect, it } from "vitest"

import {
  USERNAME_BASE_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  organizationUsername,
  organizationUsernamePrefix,
  prefixedUsername,
  withoutUsernamePrefix,
} from "./username-prefix"

/** plans/OF-USERS-organization-username-prefix.md */

describe("organizationUsernamePrefix", () => {
  it.each([
    ["United Bank Limited", "ubl"],
    ["K-Electric", "ke"],
    ["K-E-Demo", "ked"],
    ["Meezan", "mee"],
    ["UBL", "ubl"],
    ["Apricart Pakistan (Pvt.) Ltd", "app"],
    ["  meezan   bank ", "mb"],
    ["1LINK", "1li"],
    ["AB", "ab"],
    ["Café Bistro", "cb"],
  ])("derives %j as %j", (name, prefix) => {
    expect(organizationUsernamePrefix(name)).toBe(prefix)
  })

  it("is never more than three characters", () => {
    expect(organizationUsernamePrefix("Alpha Beta Gamma Delta Epsilon")).toBe("abg")
    expect(organizationUsernamePrefix("Supercalifragilistic")).toBe("sup")
  })

  it("gives no prefix for a name with no letter or digit, or no name", () => {
    expect(organizationUsernamePrefix("— · —")).toBe("")
    expect(organizationUsernamePrefix("میزان")).toBe("")
    expect(organizationUsernamePrefix("")).toBe("")
    expect(organizationUsernamePrefix(null)).toBe("")
  })

  it("keeps the two tenants that share email addresses apart", () => {
    // K-Electric and K-E-Demo share addresses, so their sign-ups derive the same local part.
    expect(organizationUsername("K-Electric", "huzaifa.abid")).not.toBe(organizationUsername("K-E-Demo", "huzaifa.abid"))
  })
})

describe("prefixedUsername", () => {
  it("puts the prefix and a dash in front, lower-cased and trimmed", () => {
    expect(prefixedUsername("ubl", "  Huzaifa.Abid ")).toBe("ubl-huzaifa.abid")
  })

  it("adds the prefix once, so the page and the server can both compose it", () => {
    expect(prefixedUsername("ubl", "ubl-huzaifa.abid")).toBe("ubl-huzaifa.abid")
    expect(prefixedUsername("ubl", prefixedUsername("ubl", "ali"))).toBe("ubl-ali")
  })

  it("still prefixes a username that only looks similar", () => {
    expect(prefixedUsername("ubl", "ublali")).toBe("ubl-ublali")
    expect(prefixedUsername("ubl", "mee-ali")).toBe("ubl-mee-ali")
  })

  it("leaves a username alone when there is no prefix, and an empty one empty", () => {
    expect(prefixedUsername("", " Ali ")).toBe("ali")
    expect(prefixedUsername("ubl", "  ")).toBe("")
  })

  it("fits the column at the longest username that may be typed", () => {
    expect(prefixedUsername("ubl", "x".repeat(USERNAME_BASE_MAX_LENGTH))).toHaveLength(USERNAME_MAX_LENGTH)
  })
})

describe("withoutUsernamePrefix", () => {
  it("shows the part after the prefix, for a box that displays the prefix itself", () => {
    expect(withoutUsernamePrefix("ubl", "ubl-ali1")).toBe("ali1")
    expect(withoutUsernamePrefix("ubl", "ali1")).toBe("ali1")
    expect(withoutUsernamePrefix("", "ubl-ali1")).toBe("ubl-ali1")
  })
})
