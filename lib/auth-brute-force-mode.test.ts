import { describe, expect, it } from "vitest"
import { isBruteForceProtectionEnforced } from "./auth-brute-force-mode"

describe("isBruteForceProtectionEnforced", () => {
  it("enforces both controls in production", () => {
    expect(isBruteForceProtectionEnforced("production")).toBe(true)
  })

  it("exempts the local development server", () => {
    expect(isBruteForceProtectionEnforced("development")).toBe(false)
  })

  // The failure direction here is an unprotected login form, so anything the
  // predicate does not recognise must still enforce. Only the literal value
  // `next dev` sets is exempt.
  it("enforces for an unset or unrecognised environment", () => {
    expect(isBruteForceProtectionEnforced(undefined)).toBe(true)
    expect(isBruteForceProtectionEnforced("")).toBe(true)
    expect(isBruteForceProtectionEnforced("staging")).toBe(true)
    expect(isBruteForceProtectionEnforced("test")).toBe(true)
  })

  it("enforces when the exempt value is miscased", () => {
    expect(isBruteForceProtectionEnforced("Development")).toBe(true)
    expect(isBruteForceProtectionEnforced("DEVELOPMENT")).toBe(true)
  })
})
