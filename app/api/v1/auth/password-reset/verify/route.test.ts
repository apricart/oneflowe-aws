import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getClientIdentifier: vi.fn(),
  verifyPasswordResetCode: vi.fn(),
  passwordResetIdentifierDigest: vi.fn(),
  logError: vi.fn(),
}))

vi.mock("@/lib/rate-limiter", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIdentifier: mocks.getClientIdentifier,
  rateLimitResponse: vi.fn(),
}))
vi.mock("@/lib/server/password-reset", () => ({
  PASSWORD_RESET_INVALID_CODE_MESSAGE: "The code is invalid or expired.",
  passwordResetIdentifierDigest: mocks.passwordResetIdentifierDigest,
  verifyPasswordResetCode: mocks.verifyPasswordResetCode,
}))
vi.mock("@/lib/global-logger", () => ({ logError: mocks.logError }))

import { POST } from "./route"

const challengeId = "11111111-1111-4111-8111-111111111111"
function request(body: unknown) {
  return new Request("http://localhost/api/v1/auth/password-reset/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 9, resetIn: 600 })
  mocks.getClientIdentifier.mockReset().mockResolvedValue("ip:test")
  mocks.passwordResetIdentifierDigest.mockReset().mockReturnValue("b".repeat(64))
  mocks.verifyPasswordResetCode.mockReset()
  mocks.logError.mockReset()
})

describe("POST /api/v1/auth/password-reset/verify", () => {
  it("returns a short-lived bearer only after a valid OTP", async () => {
    mocks.verifyPasswordResetCode.mockResolvedValue({
      kind: "verified",
      resetToken: "x".repeat(43),
      validForSeconds: 600,
    })

    const response = await POST(request({ challengeId, code: "123456" }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      verified: true,
      resetToken: "x".repeat(43),
      validForSeconds: 600,
    })
  })

  it("uses one generic error for a wrong, expired, or decoy challenge", async () => {
    mocks.verifyPasswordResetCode.mockResolvedValue({ kind: "rejected" })

    const response = await POST(request({ challengeId, code: "654321" }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: "The code is invalid or expired." })
  })

  it("never reveals how many guesses a challenge has left", async () => {
    // A count exists only for a real challenge, so printing one would tell an
    // unauthenticated caller that the username they typed is an account. The
    // extra field stands in for any future outcome shape that carries one.
    mocks.verifyPasswordResetCode.mockResolvedValue({ kind: "rejected", remainingAttempts: 4 })

    const response = await POST(request({ challengeId, code: "654321" }))

    expect(await response.text()).not.toMatch(/attempt|remaining|\b4\b/i)
  })

  it("rejects a malformed code before touching the challenge", async () => {
    const response = await POST(request({ challengeId, code: "12ab56" }))

    expect(response.status).toBe(400)
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
    expect(mocks.verifyPasswordResetCode).not.toHaveBeenCalled()
  })
})
