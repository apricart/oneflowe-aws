import { describe, expect, it } from "vitest"

import {
  PRODUCT_REQUEST_RAISER_ROLES,
  PRODUCT_REQUEST_REVIEWER_ROLES,
  canOpenProductRequests,
  canRaiseProductRequest,
  canReadProductRequest,
  canReviewProductRequest,
  productRequestVisibilityScope,
} from "@/lib/product-request-access"

const OTHER_ROLES = ["BRANCH_ADMIN", "GROUP_USER", "GROUP_ORDER_PORTAL", "ORDER_PORTAL", "VIEWER"]

const LOOKALIKES: Array<[string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["an empty string", ""],
  ["a number", 1],
  ["an object", {}],
  ["a padded role", "HEAD_OFFICE "],
  ["a lowercase role", "super_admin"],
]

describe("who may raise a product request", () => {
  it("is Head Office and nobody else", () => {
    expect(PRODUCT_REQUEST_RAISER_ROLES).toEqual(["HEAD_OFFICE"])
    expect(canRaiseProductRequest("HEAD_OFFICE")).toBe(true)
  })

  it("does not include Super Admin, which adds products directly", () => {
    expect(canRaiseProductRequest("SUPER_ADMIN")).toBe(false)
  })

  it.each(OTHER_ROLES)("refuses %s", (role) => {
    expect(canRaiseProductRequest(role)).toBe(false)
  })

  it.each(LOOKALIKES)("refuses %s rather than coercing it", (_label, role) => {
    expect(canRaiseProductRequest(role)).toBe(false)
  })
})

describe("who may decide a product request", () => {
  it("is Super Admin and nobody else", () => {
    expect(PRODUCT_REQUEST_REVIEWER_ROLES).toEqual(["SUPER_ADMIN"])
    expect(canReviewProductRequest("SUPER_ADMIN")).toBe(true)
  })

  it("does not let Head Office decide its own request", () => {
    expect(canReviewProductRequest("HEAD_OFFICE")).toBe(false)
  })

  it.each(OTHER_ROLES)("refuses %s", (role) => {
    expect(canReviewProductRequest(role)).toBe(false)
  })

  it.each(LOOKALIKES)("refuses %s rather than coercing it", (_label, role) => {
    expect(canReviewProductRequest(role)).toBe(false)
  })
})

describe("who may open the Product Requests page", () => {
  it.each(["SUPER_ADMIN", "HEAD_OFFICE"])("admits %s", (role) => {
    expect(canOpenProductRequests(role)).toBe(true)
  })

  it.each(OTHER_ROLES)("refuses %s", (role) => {
    expect(canOpenProductRequests(role)).toBe(false)
  })
})

describe("what a viewer's list is narrowed to", () => {
  it("gives Super Admin every tenant, whatever organization its session carries", () => {
    expect(productRequestVisibilityScope({ role: "SUPER_ADMIN", organizationId: null })).toEqual({ kind: "all" })
    expect(productRequestVisibilityScope({ role: "SUPER_ADMIN", organizationId: 7 })).toEqual({ kind: "all" })
  })

  it("pins Head Office to its own organization", () => {
    expect(productRequestVisibilityScope({ role: "HEAD_OFFICE", organizationId: 7 })).toEqual({
      kind: "organization",
      organizationId: 7,
    })
  })

  it.each([
    ["no organization", null],
    ["an undefined organization", undefined],
    ["organization zero", 0],
    ["a negative organization", -3],
    ["a fractional organization", 1.5],
  ])("fails Head Office closed with %s rather than widening it", (_label, organizationId) => {
    expect(productRequestVisibilityScope({ role: "HEAD_OFFICE", organizationId })).toEqual({ kind: "none" })
  })

  it.each(OTHER_ROLES)("gives %s nothing, even with an organization", (role) => {
    expect(productRequestVisibilityScope({ role, organizationId: 7 })).toEqual({ kind: "none" })
  })

  it("gives a missing viewer nothing", () => {
    expect(productRequestVisibilityScope(null)).toEqual({ kind: "none" })
    expect(productRequestVisibilityScope(undefined)).toEqual({ kind: "none" })
  })
})

describe("whether a viewer may read one request", () => {
  const request = { organizationId: 7 }

  it("lets Super Admin read any tenant's request", () => {
    expect(canReadProductRequest({ viewer: { role: "SUPER_ADMIN", organizationId: null }, request })).toBe(true)
  })

  it("lets Head Office read its own organization's request", () => {
    expect(canReadProductRequest({ viewer: { role: "HEAD_OFFICE", organizationId: 7 }, request })).toBe(true)
  })

  it("refuses Head Office another organization's request", () => {
    expect(canReadProductRequest({ viewer: { role: "HEAD_OFFICE", organizationId: 8 }, request })).toBe(false)
  })

  it("refuses a Branch Admin inside the same organization", () => {
    expect(canReadProductRequest({ viewer: { role: "BRANCH_ADMIN", organizationId: 7 }, request })).toBe(false)
  })

  it("refuses when there is no request", () => {
    expect(canReadProductRequest({ viewer: { role: "SUPER_ADMIN", organizationId: null }, request: null })).toBe(false)
  })
})
