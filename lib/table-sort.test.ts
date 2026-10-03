import { describe, expect, it } from "vitest"

import {
  appendSortParams,
  compareSortValues,
  nextSortState,
  parseSortParams,
  sortRows,
} from "./table-sort"

describe("nextSortState", () => {
  it("starts a new column at its first direction", () => {
    expect(nextSortState(null, "branch")).toEqual({ key: "branch", direction: "asc" })
    expect(nextSortState(null, "amount", "desc")).toEqual({ key: "amount", direction: "desc" })
  })

  it("flips the column already sorted", () => {
    expect(nextSortState({ key: "branch", direction: "asc" }, "branch")).toEqual({ key: "branch", direction: "desc" })
    expect(nextSortState({ key: "branch", direction: "desc" }, "branch")).toEqual({ key: "branch", direction: "asc" })
  })

  it("moving to another column ignores the previous direction", () => {
    expect(nextSortState({ key: "branch", direction: "desc" }, "tid")).toEqual({ key: "tid", direction: "asc" })
  })
})

describe("compareSortValues", () => {
  it("orders text naturally and case-insensitively", () => {
    const names = ["Branch 10", "branch 2", "Branch 1"]
    expect(names.sort((a, b) => compareSortValues(a, b, "asc"))).toEqual(["Branch 1", "branch 2", "Branch 10"])
  })

  it("orders numbers and dates by value in both directions", () => {
    expect(compareSortValues(2, 10, "asc")).toBeLessThan(0)
    expect(compareSortValues(2, 10, "desc")).toBeGreaterThan(0)
    expect(compareSortValues(new Date("2026-01-02"), new Date("2026-01-01"), "asc")).toBeGreaterThan(0)
  })

  it("puts blanks last whichever way the column runs", () => {
    for (const direction of ["asc", "desc"] as const) {
      const sorted = [null, 5, "", undefined, 1, Number.NaN].sort((a, b) => compareSortValues(a, b, direction))
      expect(sorted.slice(0, 2)).toEqual(direction === "asc" ? [1, 5] : [5, 1])
    }
  })
})

describe("sortRows", () => {
  const rows = [
    { id: 1, branch: "North", amount: 300 },
    { id: 2, branch: "east", amount: 100 },
    { id: 3, branch: "North", amount: 200 },
  ]
  const accessors = { branch: (row: (typeof rows)[number]) => row.branch, amount: (row: (typeof rows)[number]) => row.amount }

  it("returns a copy in the original order without a sort", () => {
    const result = sortRows(rows, null, accessors)
    expect(result).toEqual(rows)
    expect(result).not.toBe(rows)
  })

  it("sorts by the chosen column without touching the input", () => {
    expect(sortRows(rows, { key: "amount", direction: "desc" }, accessors).map((row) => row.id)).toEqual([1, 3, 2])
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3])
  })

  it("is stable: equal values keep their incoming order", () => {
    expect(sortRows(rows, { key: "branch", direction: "asc" }, accessors).map((row) => row.id)).toEqual([2, 1, 3])
    expect(sortRows(rows, { key: "branch", direction: "desc" }, accessors).map((row) => row.id)).toEqual([1, 3, 2])
  })
})

describe("parseSortParams", () => {
  const keys = ["orderDate", "amount"] as const
  const parse = (query: string) => parseSortParams(new URLSearchParams(query), keys)

  it("means the default order when no sort is asked for", () => {
    expect(parse("")).toEqual({ ok: true, sort: null })
    expect(parse("sort=")).toEqual({ ok: true, sort: null })
  })

  it("accepts an allowlisted key and direction, descending by default", () => {
    expect(parse("sort=amount&dir=asc")).toEqual({ ok: true, sort: { key: "amount", direction: "asc" } })
    expect(parse("sort=amount")).toEqual({ ok: true, sort: { key: "amount", direction: "desc" } })
  })

  it("refuses any key outside the allowlist, including SQL", () => {
    expect(parse("sort=total_cents")).toEqual({ ok: false, error: "Invalid sort column" })
    expect(parse("sort=amount;DROP TABLE orders")).toEqual({ ok: false, error: "Invalid sort column" })
    expect(parse("sort=constructor")).toEqual({ ok: false, error: "Invalid sort column" })
  })

  it("refuses a direction other than asc or desc", () => {
    expect(parse("sort=amount&dir=sideways")).toEqual({ ok: false, error: "Invalid sort direction" })
  })
})

describe("appendSortParams", () => {
  it("adds sort and dir, or nothing for no sort", () => {
    const params = new URLSearchParams("page=2")
    appendSortParams(params, null)
    expect(params.toString()).toBe("page=2")
    appendSortParams(params, { key: "amount", direction: "asc" })
    expect(params.toString()).toBe("page=2&sort=amount&dir=asc")
  })
})
