import { NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The send handler's contract with the page: which outcome becomes which
 * status and code, and the order of the guards in front of the work. The
 * rules themselves (routable address, cooldown, daily cap) live in
 * `lib/server/email-verification.ts` and are exercised against Postgres in
 * `tests/integration/password-rotation.test.ts`; here the outcome is faked and
 * only the mapping is on trial.
 */

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  withRateLimit: vi.fn(),
  sendEmailVerificationCode: vi.fn(),
  logError: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: mocks.withRateLimit }))
vi.mock("@/lib/server/email-verification", () => ({
  sendEmailVerificationCode: mocks.sendEmailVerificationCode,
}))
vi.mock("@/lib/global-logger", () => ({ logError: mocks.logError }))

import { EMAIL_UNROUTABLE_CODE, POST } from "./route"

const USER_ID = "3b1a6a3e-1111-4c7b-9a2e-000000000001"

beforeEach(() => {
  mocks.getCurrentUser.mockReset().mockResolvedValue({ id: USER_ID, role: "BRANCH_ADMIN" })
  mocks.withRateLimit.mockReset().mockResolvedValue(null)
  mocks.sendEmailVerificationCode.mockReset()
  mocks.logError.mockReset()
})

describe("POST /api/v1/users/me/email-verification/send — guards", () => {
  it("refuses without a session and sends nothing", async () => {
    mocks.getCurrentUser.mockResolvedValue(null)

    const response = await POST()

    expect(response.status).toBe(401)
    expect(mocks.sendEmailVerificationCode).not.toHaveBeenCalled()
    expect(mocks.withRateLimit).not.toHaveBeenCalled()
  })

  it("is not for employee-store principals", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "emp_42", role: "EMPLOYEE" })

    const response = await POST()

    expect(response.status).toBe(400)
    expect(mocks.sendEmailVerificationCode).not.toHaveBeenCalled()
  })

  it("rate limits per user on the otpSend bucket before any code is generated", async () => {
    const limited = NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": "600" } })
    mocks.withRateLimit.mockResolvedValue(limited)

    const response = await POST()

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("600")
    expect(mocks.withRateLimit).toHaveBeenCalledWith("otpSend", USER_ID)
    expect(mocks.sendEmailVerificationCode).not.toHaveBeenCalled()
  })

  it("identifies the account by the session alone", async () => {
    mocks.sendEmailVerificationCode.mockResolvedValue({ kind: "sent", emailHint: "i***@ke.com.pk", validForMinutes: 10 })

    await POST()

    expect(mocks.sendEmailVerificationCode).toHaveBeenCalledTimes(1)
    expect(mocks.sendEmailVerificationCode).toHaveBeenCalledWith(USER_ID)
  })
})

describe("POST /api/v1/users/me/email-verification/send — outcomes", () => {
  it("answers a sent code with the masked address and the validity, nothing more", async () => {
    mocks.sendEmailVerificationCode.mockResolvedValue({ kind: "sent", emailHint: "i***@ke.com.pk", validForMinutes: 10 })

    const response = await POST()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ sent: true, emailHint: "i***@ke.com.pk", validForMinutes: 10 })
  })

  it("tells an unroutable account to see an administrator, with a stable code", async () => {
    mocks.sendEmailVerificationCode.mockResolvedValue({ kind: "unroutable", emailHint: "n***@ke-legacy.invalid" })

    const response = await POST()

    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.code).toBe(EMAIL_UNROUTABLE_CODE)
    expect(body.emailHint).toBe("n***@ke-legacy.invalid")
    expect(body.error).toContain("administrator")
  })

  it("turns a cooldown into 429 with a Retry-After the page can count down from", async () => {
    mocks.sendEmailVerificationCode.mockResolvedValue({
      kind: "throttled",
      message: "Please wait 1 minute before requesting another OTP",
      cooldownUntil: new Date(Date.now() + 45_000),
    })

    const response = await POST()

    expect(response.status).toBe(429)
    const retryAfter = Number(response.headers.get("Retry-After"))
    expect(retryAfter).toBeGreaterThanOrEqual(44)
    expect(retryAfter).toBeLessThanOrEqual(46)
    await expect(response.json()).resolves.toMatchObject({
      error: "Please wait 1 minute before requesting another OTP",
      retryAfterSeconds: retryAfter,
    })
  })

  it("never answers a cooldown with a zero or negative Retry-After", async () => {
    mocks.sendEmailVerificationCode.mockResolvedValue({
      kind: "throttled",
      message: "wait",
      cooldownUntil: new Date(Date.now() - 5_000),
    })

    const response = await POST()

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("1")
  })

  it("falls back to a minute when the cooldown has no end", async () => {
    mocks.sendEmailVerificationCode.mockResolvedValue({ kind: "throttled", message: "wait", cooldownUntil: null })

    const response = await POST()

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("60")
    await expect(response.json()).resolves.toMatchObject({ retryAfterSeconds: 60 })
  })

  it("reports a send failure (daily cap, transport) as 400 with the module's message", async () => {
    mocks.sendEmailVerificationCode.mockResolvedValue({ kind: "failed", message: "Daily OTP request limit exceeded. Please try again tomorrow." })

    const response = await POST()

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("Daily OTP request limit") })
  })

  it("answers 404 for a session whose account is gone or inactive", async () => {
    mocks.sendEmailVerificationCode.mockResolvedValue({ kind: "not_found" })

    expect((await POST()).status).toBe(404)
  })

  it("hides an unexpected failure behind a generic 500 and logs it", async () => {
    mocks.sendEmailVerificationCode.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.7:5432"))

    const response = await POST()

    expect(response.status).toBe(500)
    const body = await response.json()
    // `lib/api`'s error() replaces every 5xx message with this one.
    expect(body).toEqual({ error: "An unexpected error occurred. Please try again later." })
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED")
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(Error), "API_EMAIL_VERIFICATION_SEND")
  })
})
