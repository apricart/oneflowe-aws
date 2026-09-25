import { describe, expect, it } from "vitest"

import { retainAvailable } from "./executive-entity-selection"

describe("retainAvailable", () => {
  it("keeps the picked keys the option list still offers, in the order they were picked", () => {
    const selected = ["u3", "u1"]
    expect(retainAvailable(selected, [
      { key: "u1" }, { key: "u2" }, { key: "u3" },
    ])).toEqual(["u3", "u1"])
  })

  it("drops a key the list no longer offers", () => {
    expect(retainAvailable(["u1", "u2"], [{ key: "u2" }, { key: "u9" }])).toEqual(["u2"])
  })

  it("drops every key when the new list shares none of them", () => {
    expect(retainAvailable(["u1", "u2"], [{ key: "u7" }])).toEqual([])
  })

  it("drops every key when the list is empty — a branch nobody ordered at", () => {
    expect(retainAvailable(["u1"], [])).toEqual([])
  })

  it("returns the same array when nothing is dropped, so a memo keyed on it is stable", () => {
    const selected = ["u1", "u2"]
    expect(retainAvailable(selected, [{ key: "u1" }, { key: "u2" }])).toBe(selected)
  })

  it("returns the same empty array rather than building a new one", () => {
    const selected: string[] = []
    expect(retainAvailable(selected, [{ key: "u1" }])).toBe(selected)
  })

  it("does not mutate what it was given", () => {
    const selected = ["u1", "u2"]
    const options = [{ key: "u2" }]
    retainAvailable(selected, options)
    expect(selected).toEqual(["u1", "u2"])
    expect(options).toEqual([{ key: "u2" }])
  })
})
