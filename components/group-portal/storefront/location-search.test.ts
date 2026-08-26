import { describe, expect, it } from "vitest"

import type { ScopedGroup } from "@/components/group-portal/types"
import {
  MAX_LOCATION_MATCHES,
  searchLocations,
} from "@/components/group-portal/storefront/location-search"

const branch = (id: number, name: string, city: string | null, costCenterId: string | null = null) =>
  ({ id, name, city, costCenterId, groupId: null })

const groups: ScopedGroup[] = [
  {
    id: 1,
    name: "Zoomato Products-1",
    branches: [
      branch(7, "Airport Branch", "karachi", "CC-101"),
      branch(8, "DHA", "KARACHI"),
    ],
  },
  {
    id: 2,
    name: "Cafe Supplies",
    branches: [branch(21, "Gulberg Outlet", "Lahore", "CC-900")],
  },
  {
    id: null,
    name: "Ungrouped",
    branches: [branch(30, "Head Office Store", null)],
  },
]

describe("searchLocations", () => {
  it("finds locations in every assigned group, not only the open one", () => {
    const result = searchLocations(groups, "out")

    expect(result.groups.map((match) => match.groupName)).toEqual(["Cafe Supplies"])
    expect(result.groups[0].branches.map((item) => item.id)).toEqual([21])
    expect(result.matchCount).toBe(1)
  })

  it("keeps every hit under the group that owns it", () => {
    // Flattening would suggest a single pool of locations, which is exactly the
    // selection the server refuses.
    const result = searchLocations(groups, "a")

    expect(result.groups.map((match) => match.groupId)).toEqual([1, 2, null])
    expect(result.groups[0].branches.map((item) => item.name)).toEqual(["Airport Branch", "DHA"])
  })

  it("matches on name, city, or cost centre, ignoring case and surrounding space", () => {
    expect(searchLocations(groups, "  dha ").matchCount).toBe(1)
    expect(searchLocations(groups, "KARACHI").groups[0].branches.map((item) => item.id))
      .toEqual([7, 8])
    expect(searchLocations(groups, "cc-900").groups[0].branches.map((item) => item.id))
      .toEqual([21])
  })

  it("treats a group name as a match for all of its locations", () => {
    const result = searchLocations(groups, "zoomato")

    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].branches.map((item) => item.id)).toEqual([7, 8])
  })

  it("tolerates a location with no city or cost centre", () => {
    expect(searchLocations(groups, "head office").groups[0].branches.map((item) => item.id))
      .toEqual([30])
  })

  it("returns nothing for a blank query, so the caller keeps showing its tree", () => {
    expect(searchLocations(groups, "   ")).toEqual({ groups: [], matchCount: 0, truncated: false })
  })

  it("reports no match rather than inventing one", () => {
    expect(searchLocations(groups, "islamabad")).toEqual({
      groups: [],
      matchCount: 0,
      truncated: false,
    })
  })

  it("caps a very broad search and says that it did", () => {
    const many: ScopedGroup[] = [
      {
        id: 5,
        name: "Nationwide",
        branches: Array.from({ length: MAX_LOCATION_MATCHES + 10 }, (_, index) =>
          branch(1000 + index, `Store ${index}`, "Karachi")),
      },
    ]

    const result = searchLocations(many, "store")

    expect(result.matchCount).toBe(MAX_LOCATION_MATCHES)
    expect(result.groups[0].branches).toHaveLength(MAX_LOCATION_MATCHES)
    expect(result.truncated).toBe(true)
  })

  it("does not claim truncation when everything fits", () => {
    const exact: ScopedGroup[] = [
      {
        id: 5,
        name: "Nationwide",
        branches: Array.from({ length: MAX_LOCATION_MATCHES }, (_, index) =>
          branch(2000 + index, `Store ${index}`, "Karachi")),
      },
    ]

    expect(searchLocations(exact, "store").truncated).toBe(false)
  })
})
