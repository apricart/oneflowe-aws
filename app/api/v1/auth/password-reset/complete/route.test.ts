import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getClientIdentifier: vi.fn(),
  completePasswordReset: vi.fn(),
  passwordResetIdentifierDigest: vi.fn(),
  logError: vi.fn(),
}))

vi.mock("@/lib/rate-limiter", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIdentifier: mocks.getClientIdentifier,
  rateLimitResponse: vi.fn(),
}))
vi.mock("@/lib/server/password-reset", () => ({
  PASSWORD_RESET_INVALID_TOKEN_MESSAGE: "This password reset has expired.",
  completePasswordReset: mocks.completePasswordReset,
  passwordResetIdentifierDigest: mocks.passwordResetIdentifierDigest,
}))
vi.mock("@/lib/global-logger", () => ({ logError: mocks.logError }))

import { POST } from "./route"

const challengeId = "11111111-1111-4111-8111-111111111111"
const resetToken = "x".repeat(43)
function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/v1/auth/password-reset/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 9, resetIn: 300 })
  mocks.getClientIdentifier.mockReset().mockResolvedValue("ip:test")
  mocks.passwordResetIdentifierDigest.mockReset().mockReturnValue("c".repeat(64))
  mocks.completePasswordReset.mockReset()
  mocks.logError.mockReset()
})

describe("POST /api/v1/auth/password-reset/complete", () => {
  it("completes only with a matching confirmation and verified bearer", async () => {
    mocks.completePasswordReset.mockResolvedValue({ kind: "completed" })
    const response = await POST(request({
      challengeId,
      resetToken,
      password: "New-Secure-Password-123!",
      confirmPassword: "New-Secure-Password-123!",
    }))

    expect(response.status).toBe(200)
    expect(mocks.completePasswordReset).toHaveBeenCalledWith({
      challengeId,
      resetToken,
      newPassword: "New-Secure-Password-123!",
    })
  })

  it("rejects a mismatched confirmation before hashing or database work", async () => {
    const response = await POST(request({
      challengeId,
      resetToken,
      password: "New-Secure-Password-123!",
      confirmPassword: "Different-Secure-Password-123!",
    }))

    expect(response.status).toBe(400)
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
    expect(mocks.completePasswordReset).not.toHaveBeenCalled()
  })

  it("does not allow the current password to be reused", async () => {
    mocks.completePasswordReset.mockResolvedValue({ kind: "password_unchanged" })
    const response = await POST(request({
      challengeId,
      resetToken,
      password: "Current-Secure-Password-123!",
      confirmPassword: "Current-Secure-Password-123!",
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("different") })
  })
})
