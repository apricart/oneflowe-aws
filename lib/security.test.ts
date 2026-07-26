import { describe, expect, it } from "vitest"

import {
  normalizeSafeImageUrl,
  safeFilenamePart,
  safeInternalRedirectPath,
} from "@/lib/security"
import {
  createCsv,
  neutralizeSpreadsheetFormula,
} from "@/lib/spreadsheet"
import {
  isCookieAuthenticatedMutationAllowed,
  isKnownBodyTooLarge,
} from "@/lib/edge/request-security"

describe("browser security helpers", () => {
  it("allows only internal callback paths", () => {
    expect(safeInternalRedirectPath("/orders?status=pending")).toBe("/orders?status=pending")
    expect(safeInternalRedirectPath("javascript:alert(1)")).toBe("/dashboard")
    expect(safeInternalRedirectPath("//attacker.example/path")).toBe("/dashboard")
    expect(safeInternalRedirectPath("https://attacker.example")).toBe("/dashboard")
    expect(safeInternalRedirectPath("/\\attacker.example")).toBe("/dashboard")
  })

  it("rejects active or insecure image sources", () => {
    expect(normalizeSafeImageUrl("/uploads/products/example.png")).toBe("/uploads/products/example.png")
    expect(normalizeSafeImageUrl("https://cdn.example/image.png")).toBe("https://cdn.example/image.png")
    expect(normalizeSafeImageUrl("http://cdn.example/image.png")).toBeNull()
    expect(normalizeSafeImageUrl("javascript:alert(1)")).toBeNull()
    expect(normalizeSafeImageUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull()
    expect(normalizeSafeImageUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull()
  })

  it("generates traversal-safe download filename parts", () => {
    expect(safeFilenamePart("../../invoice\r\nX-Test: injected")).toBe("invoice_X-Test_injected")
    expect(safeFilenamePart("")).toBe("file")
  })

  it("neutralizes spreadsheet formulas without changing numeric cells", () => {
    expect(neutralizeSpreadsheetFormula('=HYPERLINK("https://attacker.example","Click")'))
      .toBe('\'=HYPERLINK("https://attacker.example","Click")')
    expect(neutralizeSpreadsheetFormula("+SUM(1,2)")).toBe("'+SUM(1,2)")
    expect(neutralizeSpreadsheetFormula("-1+2")).toBe("'-1+2")
    expect(neutralizeSpreadsheetFormula("@SUM(1,2)")).toBe("'@SUM(1,2)")
    expect(neutralizeSpreadsheetFormula(-12)).toBe(-12)
    expect(createCsv(["Value"], [["=1+1"]])).toContain("\"'=1+1\"")
  })

  it("requires same-origin evidence for cookie-authenticated mutations", () => {
    const base = {
      method: "POST",
      requestUrl: "https://app.example/api/v1/orders",
      cookieHeader: "next-auth.session-token=abc",
    }

    expect(isCookieAuthenticatedMutationAllowed({
      ...base,
      origin: "https://app.example",
      secFetchSite: "same-origin",
    })).toBe(true)
    expect(isCookieAuthenticatedMutationAllowed({
      ...base,
      origin: "https://attacker.example",
      secFetchSite: "cross-site",
    })).toBe(false)
    expect(isCookieAuthenticatedMutationAllowed({
      ...base,
      origin: "https://app.example",
      secFetchSite: "same-site",
    })).toBe(false)
    expect(isCookieAuthenticatedMutationAllowed({
      ...base,
      origin: null,
      secFetchSite: null,
    })).toBe(false)
  })

  it("accepts browser-confirmed same-origin mutations behind a reverse proxy", () => {
    expect(isCookieAuthenticatedMutationAllowed({
      method: "POST",
      requestUrl: "http://internal-next-server:3000/api/v1/users",
      origin: "https://app.example",
      secFetchSite: "same-origin",
      cookieHeader: "__Secure-next-auth.session-token=abc",
    })).toBe(true)
  })

  it("falls back to a strict Origin comparison without Fetch Metadata", () => {
    const base = {
      method: "POST",
      requestUrl: "https://app.example/api/v1/users",
      cookieHeader: "next-auth.session-token=abc",
      secFetchSite: null,
    }

    expect(isCookieAuthenticatedMutationAllowed({
      ...base,
      origin: "https://app.example",
    })).toBe(true)
    expect(isCookieAuthenticatedMutationAllowed({
      ...base,
      origin: "https://attacker.example",
    })).toBe(false)
  })

  it("rejects known oversized request bodies", () => {
    expect(isKnownBodyTooLarge("1048577", 1048576)).toBe(true)
    expect(isKnownBodyTooLarge("1048576", 1048576)).toBe(false)
    expect(isKnownBodyTooLarge(null, 1048576)).toBe(false)
  })
})
