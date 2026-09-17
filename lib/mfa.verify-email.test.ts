import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The parts of `lib/mfa.ts` the email-verification flow added: a code's
 * validity depends on its type (a login code is read on the same screen, a
 * verification code on another device, from corporate mail), and the
 * account context travels intact to the mail. The generate/verify machinery
 * itself needs Postgres and Redis and is exercised in
 * `tests/integration/password-rotation.test.ts` and
 * `tests/integration/email-verification-hardening.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => true),
}))

vi.mock("@/lib/email", () => ({ sendOTPEmail: mocks.sendEmail }))
vi.mock("@/lib/redis", () => ({ RedisMFA: {} }))
vi.mock("@/lib/db", () => ({ db: {} }))

import { otpExpiryMinutes, sendOTPEmail } from "./mfa"

beforeEach(() => {
  // mockClear, not mockReset: resetting an async vi.fn and then giving it a
  // rejecting implementation trips vitest 4's settled-result tracking into a
  // spurious unhandled rejection that fails the test.
  mocks.sendEmail.mockClear()
  mocks.sendEmail.mockImplementation(async () => true)
})

describe("otpExpiryMinutes", () => {
  it("gives a verification code ten minutes and leaves a login code at two", () => {
    expect(otpExpiryMinutes("VERIFY_EMAIL")).toBe(10)
    expect(otpExpiryMinutes("LOGIN")).toBe(2)
    expect(otpExpiryMinutes("RESET_PASSWORD")).toBe(10)
  })
})

describe("sendOTPEmail (mfa wrapper)", () => {
  it("hands the mail the validity that matches the code's type, and the account it is for", async () => {
    const account = { username: "imran-17655-op", accountLabel: "Order Portal User" }

    expect(await sendOTPEmail("imrank@ke.com.pk", "123456", "VERIFY_EMAIL", account)).toBe(true)

    expect(mocks.sendEmail).toHaveBeenCalledWith("imrank@ke.com.pk", "123456", "VERIFY_EMAIL", {
      validForMinutes: 10,
      account,
    })
  })

  it("sends a login code with two minutes and no account line", async () => {
    await sendOTPEmail("x@example.test", "123456", "LOGIN")

    expect(mocks.sendEmail).toHaveBeenCalledWith("x@example.test", "123456", "LOGIN", { validForMinutes: 2, account: null })
  })

  it.each([
    ["an address that is not one", "not-an-address", "123456", "VERIFY_EMAIL"],
    ["a five-digit code", "x@example.test", "12345", "VERIFY_EMAIL"],
    ["an unknown type", "x@example.test", "123456", "MAGIC_LINK"],
  ])("refuses %s before reaching the transport", async (_label, email, code, type) => {
    expect(await sendOTPEmail(email, code, type)).toBe(false)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it("reports false rather than throwing when the transport throws", async () => {
    mocks.sendEmail.mockImplementation(async () => { throw new Error("SES down") })

    expect(await sendOTPEmail("x@example.test", "123456", "VERIFY_EMAIL")).toBe(false)
  })
})
