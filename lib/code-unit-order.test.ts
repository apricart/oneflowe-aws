import { describe, expect, it } from "vitest"
import { compareCodeUnits } from "@/lib/code-unit-order"

describe("compareCodeUnits", () => {
  it("orders exactly as the default sort does, so recorded digests keep matching", () => {
    const values = [
      "UNHIDE 10 7 -> v", "HIDE 9 7 a", "hide 9 7 a", "10:2026-09", "9:2026-09",
      "2026-10", "2026-09", "ÉCLAIR", "Eclair", "eclair", "e-clair", "e clair",
      "😀", "\uFFFF", "Z", "_", "", "ROLE", "ROLE_A", "ROLE,A",
    ]

    // The comparator-less sort is the oracle: it is the order every past digest was taken in.
    expect([...values].sort(compareCodeUnits)).toEqual([...values].sort())
  })

  it("is not locale order: case and punctuation are not folded", () => {
    expect(["b", "B", "a", "A"].sort(compareCodeUnits)).toEqual(["A", "B", "a", "b"])
    expect(["10:x", "9:x"].sort(compareCodeUnits)).toEqual(["10:x", "9:x"])
  })

  it("returns 0 only for equal strings", () => {
    expect(compareCodeUnits("x", "x")).toBe(0)
    expect(compareCodeUnits("x", "y")).toBe(-1)
    expect(compareCodeUnits("y", "x")).toBe(1)
  })
})
