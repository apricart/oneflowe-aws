import { describe, expect, it } from "vitest"

import {
  DESK_CATALOGUE_PAGE_MAX,
  DESK_CATALOGUE_PAGE_SIZE_DEFAULT,
  DESK_CATALOGUE_PAGE_SIZE_MAX,
  deskCatalogueUrl,
  parseDeskCatalogueQuery,
} from "./order-desk-catalogue-query"

const parse = (query: string) => parseDeskCatalogueQuery(new URLSearchParams(query))

describe("the desk product picker's query", () => {
  it("needs the branch and its organization, and pages from 1 by default", () => {
    expect(parse("organizationId=7&branchId=70")).toEqual({
      ok: true,
      value: { organizationId: 7, branchId: 70, search: null, page: 1, limit: DESK_CATALOGUE_PAGE_SIZE_DEFAULT },
    })
  })

  it("trims the search and keeps paging within bounds", () => {
    expect(parse("organizationId=7&branchId=70&q=%20rice%20&page=3&limit=10")).toEqual({
      ok: true,
      value: { organizationId: 7, branchId: 70, search: "rice", page: 3, limit: 10 },
    })
    expect(parse(`organizationId=7&branchId=70&page=${DESK_CATALOGUE_PAGE_MAX + 5}&limit=100000`)).toMatchObject({
      ok: true,
      value: { page: DESK_CATALOGUE_PAGE_MAX, limit: DESK_CATALOGUE_PAGE_SIZE_MAX },
    })
    expect(parse("organizationId=7&branchId=70&q=%20%20")).toMatchObject({ ok: true, value: { search: null } })
  })

  it.each([
    ["no branch", "organizationId=7", /branchId/],
    ["no organization", "branchId=70", /organizationId/],
    ["a non-numeric id", "organizationId=abc&branchId=70", /organizationId/],
    ["a zero id", "organizationId=7&branchId=0", /branchId/],
    ["a negative page", "organizationId=7&branchId=70&page=-1", /page/],
    ["a fractional limit", "organizationId=7&branchId=70&limit=2.5", /limit/],
    ["an overlong search", `organizationId=7&branchId=70&q=${"x".repeat(101)}`, /at most 100/],
    ["an unknown parameter", "organizationId=7&branchId=70&extra=1", /Unknown field: extra/],
  ])("refuses %s", (_label, query, message) => {
    const result = parse(query)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(message)
  })

  it("builds the URL the route parses back to the same query", () => {
    const url = deskCatalogueUrl({ organizationId: 7, branchId: 70, search: " tea & milk ", page: 2, limit: 25 })
    expect(url).toBe("/api/v1/order-desk/catalogue?organizationId=7&branchId=70&q=tea+%26+milk&page=2&limit=25")
    const parsed = parseDeskCatalogueQuery(new URL(url, "http://localhost").searchParams)
    expect(parsed).toEqual({ ok: true, value: { organizationId: 7, branchId: 70, search: "tea & milk", page: 2, limit: 25 } })
    expect(deskCatalogueUrl({ organizationId: 7, branchId: 70 })).toBe("/api/v1/order-desk/catalogue?organizationId=7&branchId=70")
  })
})
