import { describe, expect, it } from "vitest"

import { PAKISTAN_CITIES, PAKISTAN_PROVINCES, findPakistanCity } from "./pakistan-cities"

/** plans/OF-JOIN-new-branch-city-warehouse.md */

describe("PAKISTAN_CITIES", () => {
  it("spells each city once, case and spacing aside, so one city is never two", () => {
    const keys = PAKISTAN_CITIES.map((city) => city.name.trim().replaceAll(/\s+/g, " ").toLowerCase())
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("gives every city a known province, and every province at least one city", () => {
    for (const city of PAKISTAN_CITIES) expect(PAKISTAN_PROVINCES).toContain(city.province)
    for (const province of PAKISTAN_PROVINCES) {
      expect(PAKISTAN_CITIES.some((city) => city.province === province)).toBe(true)
    }
  })

  it("has no stray whitespace in a name", () => {
    for (const city of PAKISTAN_CITIES) expect(city.name).toBe(city.name.trim().replaceAll(/\s+/g, " "))
  })

  it("is sorted by name", () => {
    const names = PAKISTAN_CITIES.map((city) => city.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })

  it.each([
    ["Karachi", "Sindh"],
    ["Lahore", "Punjab"],
    ["Islamabad", "Islamabad Capital Territory"],
    ["Peshawar", "Khyber Pakhtunkhwa"],
    ["Quetta", "Balochistan"],
    ["Gilgit", "Gilgit-Baltistan"],
    ["Muzaffarabad", "Azad Jammu and Kashmir"],
  ])("lists %s in %s", (name, province) => {
    expect(findPakistanCity(name)).toEqual({ name, province })
  })
})

describe("findPakistanCity", () => {
  it("matches case and spacing aside, and answers the list's own spelling", () => {
    expect(findPakistanCity("  dera   ghazi KHAN ")).toEqual({ name: "Dera Ghazi Khan", province: "Punjab" })
  })

  it.each([["Atlantis"], [""], ["   "], [null], [42], [undefined]])("finds nothing for %j", (value) => {
    expect(findPakistanCity(value)).toBeNull()
  })
})
