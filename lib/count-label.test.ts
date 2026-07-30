import { describe, expect, it } from "vitest"

import { formatCountLabel } from "./count-label"

describe("formatCountLabel", () => {
  it("uses the singular label for exactly one item", () => {
    expect(formatCountLabel(1, "product")).toBe("1 product")
  })

  it("uses the plural label for zero and multiple items", () => {
    expect(formatCountLabel(0, "product")).toBe("0 products")
    expect(formatCountLabel(2, "product")).toBe("2 products")
  })

  it("supports irregular plurals", () => {
    expect(formatCountLabel(1, "branch", "branches")).toBe("1 branch")
    expect(formatCountLabel(2, "branch", "branches")).toBe("2 branches")
    expect(formatCountLabel(1, "subcategory", "subcategories")).toBe("1 subcategory")
    expect(formatCountLabel(2, "subcategory", "subcategories")).toBe("2 subcategories")
  })

  it("formats large counts for display", () => {
    expect(formatCountLabel(1_000, "company", "companies")).toBe(
      `${(1_000).toLocaleString()} companies`,
    )
  })
})
