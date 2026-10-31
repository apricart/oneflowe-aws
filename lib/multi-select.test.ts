import { describe, expect, it } from "vitest"

import { clearVisible, everyVisibleSelected, filterOptions, selectVisible, selectionLabel, toggleValue } from "@/lib/multi-select"

const cities = [
  { id: "karachi", label: "Karachi" },
  { id: "lahore", label: "Lahore" },
  { id: "rawalpindi", label: "Rawalpindi", keywords: "pindi" },
]
const nouns = { one: "city", many: "cities" }

describe("multi-select with string ids", () => {
  it("filters on every word of the label and keywords", () => {
    expect(filterOptions(cities, "PINDI").map((city) => city.id)).toEqual(["rawalpindi"])
    expect(filterOptions(cities, "a").map((city) => city.id)).toEqual(["karachi", "lahore", "rawalpindi"])
    expect(filterOptions(cities, "  ")).toHaveLength(3)
  })

  it("selects and clears only what is visible, keeping the rest", () => {
    const visible = filterOptions(cities, "lahore")
    expect(selectVisible(["karachi"], visible)).toEqual(["karachi", "lahore"])
    expect(clearVisible(["karachi", "lahore"], visible)).toEqual(["karachi"])
    expect(everyVisibleSelected(["lahore"], visible)).toBe(true)
    expect(everyVisibleSelected(["lahore"], [])).toBe(false)
    expect(toggleValue(["karachi"], "karachi")).toEqual([])
  })

  it("labels the trigger with the nouns it is given", () => {
    expect(selectionLabel([], cities, "All cities of these organizations", nouns)).toBe("All cities of these organizations")
    expect(selectionLabel(["lahore"], cities, "", nouns)).toBe("Lahore")
    expect(selectionLabel(["lahore", "karachi"], cities, "", nouns)).toBe("2 cities")
    expect(selectionLabel(["lahore", "karachi", "rawalpindi"], cities, "", nouns)).toBe("All cities (3)")
    expect(selectionLabel(["quetta"], cities, "", nouns)).toBe("1 city")
  })
})
