import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getClientIdentifier: vi.fn(),
  rateLimitResponse: vi.fn(),
  verifyJoinEmailCode: vi.fn(),
}))

vi.mock("@/lib/rate-limiter", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIdentifier: mocks.getClientIdentifier,
  rateLimitResponse: mocks.rateLimitResponse,
}))
vi.mock("@/lib/server/join-email-verification", () => ({
  verifyJoinEmailCode: mocks.verifyJoinEmailCode,
}))

import { JOIN_EMAIL_CODE_INVALID_MESSAGE } from "@/lib/organization-join"

import { POST } from "./route"

const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111"

function request(body: unknown) {
  return new Request("http://localhost/api/v1/join/email-verification/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 9, resetIn: 600 })
  mocks.getClientIdentifier.mockReset().mockResolvedValue("ip:test")
  mocks.rateLimitResponse.mockReset().mockReturnValue(new Response(null, { status: 429 }))
  mocks.verifyJoinEmailCode.mockReset()
})

describe("POST /api/v1/join/email-verification/verify", () => {
  it("answers the proof for a right code", async () => {
    mocks.verifyJoinEmailCode.mockResolvedValue({ kind: "verified", proof: "p".repeat(43), validForSeconds: 3600 })
    const response = await POST(request({ challengeId: CHALLENGE_ID, otp: "123456" }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ proof: "p".repeat(43), validForSeconds: 3600 })
    expect(mocks.verifyJoinEmailCode).toHaveBeenCalledWith(CHALLENGE_ID, "123456")
  })

  it("uses one message for every rejection and never reveals attempts left", async () => {
    mocks.verifyJoinEmailCode.mockResolvedValue({ kind: "rejected", remainingAttempts: 4 })
    const response = await POST(request({ challengeId: CHALLENGE_ID, otp: "654321" }))
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ error: JOIN_EMAIL_CODE_INVALID_MESSAGE })
    expect(text).not.toMatch(/attempt|remaining|\b4\b/i)
  })

  it("is limited on the caller and on the challenge", async () => {
    mocks.verifyJoinEmailCode.mockResolvedValue({ kind: "rejected" })
    await POST(request({ challengeId: CHALLENGE_ID, otp: "654321" }))
    const budgets = mocks.checkRateLimit.mock.calls.map(([key, type]) => [String(key).split(":")[0], type])
    expect(budgets).toEqual([["ip", "login"], ["join-email-verify", "otpVerify"]])
  })

  it("answers 429 without checking the code when a budget is spent", async () => {
    mocks.checkRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 1, resetIn: 600 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetIn: 120 })
    const response = await POST(request({ challengeId: CHALLENGE_ID, otp: "654321" }))
    expect(response.status).toBe(429)
    expect(mocks.verifyJoinEmailCode).not.toHaveBeenCalled()
  })

  it.each([
    ["a five-digit code", { challengeId: CHALLENGE_ID, otp: "12345" }],
    ["a challenge that is not a UUID", { challengeId: "abc", otp: "123456" }],
    ["an extra field", { challengeId: CHALLENGE_ID, otp: "123456", email: "ada@ke.com.pk" }],
  ])("refuses %s before touching the challenge", async (_label, body) => {
    const response = await POST(request(body))
    expect(response.status).toBe(400)
    expect(mocks.verifyJoinEmailCode).not.toHaveBeenCalled()
  })
})
