import { describe, expect, it } from "vitest"

import {
  isEmailVerificationRequiredForPasswordChange,
  PASSWORD_CHANGE_EMAIL_VERIFICATION,
} from "./password-change-policy"

/**
 * The switch itself. The last case pins the current setting so that turning
 * the emailed proof back on (or off) is a visible diff in a test, not only
 * in a constant a reviewer might scroll past.
 */

describe("isEmailVerificationRequiredForPasswordChange", () => {
  it("requires the proof in required mode", () => {
    expect(isEmailVerificationRequiredForPasswordChange("required")).toBe(true)
  })

  it("waives the proof in disabled mode", () => {
    expect(isEmailVerificationRequiredForPasswordChange("disabled")).toBe(false)
  })

  it("reads the module setting when no mode is given", () => {
    expect(isEmailVerificationRequiredForPasswordChange()).toBe(
      isEmailVerificationRequiredForPasswordChange(PASSWORD_CHANGE_EMAIL_VERIFICATION),
    )
  })

  it("is currently switched off — the client's temporary decision of 2026-09-18", () => {
    // Re-enabling the emailed proof is a one-word change in
    // lib/password-change-policy.ts; update this expectation with it.
    expect(PASSWORD_CHANGE_EMAIL_VERIFICATION).toBe("disabled")
    expect(isEmailVerificationRequiredForPasswordChange()).toBe(false)
  })
})
