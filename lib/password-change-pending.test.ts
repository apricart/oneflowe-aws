import { describe, expect, it } from "vitest"

import {
  isPasswordChangePendingApiPathAllowed,
  PASSWORD_CHANGE_PENDING_API_ALLOWLIST,
} from "@/lib/password-change-pending"

/**
 * Contract: the list is the control. A session that still owes a password
 * change reaches exactly these three endpoints and nothing else, so adding a
 * path here is a security decision, not a convenience.
 */
describe("password-change pending API allowlist", () => {
  it("is exactly the three endpoints the change needs", () => {
    expect([...PASSWORD_CHANGE_PENDING_API_ALLOWLIST]).toEqual([
      "/api/v1/users/me/change-password",
      "/api/v1/users/me/email-verification/send",
      "/api/v1/users/me/email-verification/verify",
    ])
  })

  it.each([...PASSWORD_CHANGE_PENDING_API_ALLOWLIST])("allows %s", (path) => {
    expect(isPasswordChangePendingApiPathAllowed(path)).toBe(true)
    expect(isPasswordChangePendingApiPathAllowed(`${path}/`)).toBe(true)
  })

  it.each([
    "/api/v1/orders",
    "/api/v1/users/me",
    "/api/v1/users/me/change-password/anything",
    "/api/v1/users/me/email-verification",
    "/api/v1/users/me/email-verification/sendx",
    "/api/v1/users/me/change-passwor",
    "/api/v1/users/me/CHANGE-PASSWORD",
  ])("refuses %s — exact match, never a prefix", (path) => {
    expect(isPasswordChangePendingApiPathAllowed(path)).toBe(false)
  })
})
