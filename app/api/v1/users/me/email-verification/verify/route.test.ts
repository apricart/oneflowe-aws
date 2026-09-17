import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The verify handler: the body carries a code and nothing else, the account
 * and the session come from the signed token, and each outcome of
 * `confirmEmailVerificationCode` has one status. The proof itself is written
 * and read against Postgres in `tests/integration/password-rotation.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  withRateLimit: vi.fn(),
  getCurrentSessionId: vi.fn(),
  confirmEmailVerificationCode: vi.fn(),
  logError: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: mocks.withRateLimit }))
vi.mock("@/lib/server/current-session", () => ({ getCurrentSessionId: mocks.getCurrentSessionId }))
vi.mock("@/lib/server/email-verification", () => ({
  confirmEmailVerificationCode: mocks.confirmEmailVerificationCode,
}))
vi.mock("@/lib/global-logger", () => ({ logError: mocks.logError }))

import { POST } from "./route"

const USER_ID = "3b1a6a3e-1111-4c7b-9a2e-000000000001"
const SESSION_ID = "9d2f0c4a-2222-4d8e-8b3f-000000000002"

function post(body: unknown, raw = false): NextRequest {
  return new NextRequest("http://localhost/api/v1/users/me/email-verification/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.getCurrentUser.mockReset().mockResolvedValue({ id: USER_ID, role: "ORDER_PORTAL" })
  mocks.withRateLimit.mockReset().mockResolvedValue(null)
  mocks.getCurrentSessionId.mockReset().mockResolvedValue(SESSION_ID)
  mocks.confirmEmailVerificationCode.mockReset().mockResolvedValue({ kind: "verified", validForSeconds: 600 })
  mocks.logError.mockReset()
})

describe("POST /api/v1/users/me/email-verification/verify — guards", () => {
  it("refuses without a session", async () => {
    mocks.getCurrentUser.mockResolvedValue(null)

    expect((await POST(post({ code: "123456" }))).status).toBe(401)
    expect(mocks.confirmEmailVerificationCode).not.toHaveBeenCalled()
  })

  it("is not for employee-store principals", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "emp_7" })

    expect((await POST(post({ code: "123456" }))).status).toBe(400)
    expect(mocks.confirmEmailVerificationCode).not.toHaveBeenCalled()
  })

  it("rate limits guesses per user on the otpVerify bucket before reading the body", async () => {
    mocks.withRateLimit.mockResolvedValue(NextResponse.json({ error: "Too many requests" }, { status: 429 }))

    const response = await POST(post({ code: "123456" }))

    expect(response.status).toBe(429)
    expect(mocks.withRateLimit).toHaveBeenCalledWith("otpVerify", USER_ID)
    expect(mocks.getCurrentSessionId).not.toHaveBeenCalled()
    expect(mocks.confirmEmailVerificationCode).not.toHaveBeenCalled()
  })

  it("refuses a session whose token carries no registry id — the proof would have nowhere to land", async () => {
    mocks.getCurrentSessionId.mockResolvedValue(null)

    expect((await POST(post({ code: "123456" }))).status).toBe(401)
    expect(mocks.confirmEmailVerificationCode).not.toHaveBeenCalled()
  })
})

describe("POST /api/v1/users/me/email-verification/verify — body", () => {
  it.each([
    ["five digits", { code: "12345" }],
    ["seven digits", { code: "1234567" }],
    ["letters", { code: "12345a" }],
    ["a number instead of a string", { code: 123456 }],
    ["no code", {}],
    ["an unexpected field", { code: "123456", userId: "someone-else" }],
    ["an unexpected session id", { code: "123456", sessionId: "other-session" }],
  ])("rejects %s with 400 before touching the verifier", async (_label, body) => {
    const response = await POST(post(body))

    expect(response.status).toBe(400)
    expect(mocks.confirmEmailVerificationCode).not.toHaveBeenCalled()
  })

  it("rejects a body that is not JSON", async () => {
    expect((await POST(post("not json", true))).status).toBe(400)
    expect(mocks.confirmEmailVerificationCode).not.toHaveBeenCalled()
  })

  it("tolerates whitespace a person pasted around the code", async () => {
    await POST(post({ code: "  123456 " }))

    expect(mocks.confirmEmailVerificationCode).toHaveBeenCalledWith(USER_ID, SESSION_ID, "123456")
  })

  it("verifies for the signed-in account and the token's session, never anything from the body", async () => {
    await POST(post({ code: "654321" }))

    expect(mocks.confirmEmailVerificationCode).toHaveBeenCalledTimes(1)
    expect(mocks.confirmEmailVerificationCode).toHaveBeenCalledWith(USER_ID, SESSION_ID, "654321")
  })
})

describe("POST /api/v1/users/me/email-verification/verify — outcomes", () => {
  it("answers an accepted code with how long the proof lasts", async () => {
    const response = await POST(post({ code: "123456" }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ verified: true, validForSeconds: 600 })
  })

  it("passes a rejection through with the remaining attempts", async () => {
    mocks.confirmEmailVerificationCode.mockResolvedValue({ kind: "rejected", message: "Invalid OTP code", remainingAttempts: 3 })

    const response = await POST(post({ code: "123456" }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid OTP code (3 attempts remaining)" })
  })

  it("passes a rejection through without a count when the module gives none", async () => {
    mocks.confirmEmailVerificationCode.mockResolvedValue({ kind: "rejected", message: "OTP has expired", remainingAttempts: null })

    const response = await POST(post({ code: "123456" }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: "OTP has expired" })
  })

  it("answers 401 when the session the code was entered on is no longer valid", async () => {
    mocks.confirmEmailVerificationCode.mockResolvedValue({ kind: "session_invalid" })

    expect((await POST(post({ code: "123456" }))).status).toBe(401)
  })

  it("hides an unexpected failure behind a generic 500 and logs it", async () => {
    mocks.confirmEmailVerificationCode.mockRejectedValue(new Error("relation \"auth_sessions\" does not exist"))

    const response = await POST(post({ code: "123456" }))

    expect(response.status).toBe(500)
    const body = await response.json()
    // `lib/api`'s error() replaces every 5xx message with this one.
    expect(body).toEqual({ error: "An unexpected error occurred. Please try again later." })
    expect(JSON.stringify(body)).not.toContain("auth_sessions")
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(Error), "API_EMAIL_VERIFICATION_VERIFY")
  })
})
