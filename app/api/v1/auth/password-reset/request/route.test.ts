import { NextResponse } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getClientIdentifier: vi.fn(),
  requestPasswordReset: vi.fn(),
  passwordResetIdentifierDigest: vi.fn(),
  afterResponse: vi.fn(),
  after: vi.fn(),
  logError: vi.fn(),
}))

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: mocks.after,
}))
vi.mock("@/lib/rate-limiter", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIdentifier: mocks.getClientIdentifier,
  rateLimitResponse: (seconds: number) => NextResponse.json(
    { error: "Too many requests" },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  ),
}))
vi.mock("@/lib/server/password-reset", () => ({
  PASSWORD_RESET_CODE_VALIDITY_MINUTES: 10,
  PASSWORD_RESET_REQUEST_MESSAGE: "If an active account matches, a code was sent.",
  PASSWORD_RESET_REQUEST_MIN_RESPONSE_MS: 700,
  passwordResetIdentifierDigest: mocks.passwordResetIdentifierDigest,
  requestPasswordReset: mocks.requestPasswordReset,
}))
vi.mock("@/lib/global-logger", () => ({ logError: mocks.logError }))

import { POST } from "./route"

function request(body: unknown) {
  return new Request("http://localhost/api/v1/auth/password-reset/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 4, resetIn: 900 })
  mocks.getClientIdentifier.mockReset().mockResolvedValue("ip:203.0.113.8")
  mocks.passwordResetIdentifierDigest.mockReset().mockReturnValue("a".repeat(64))
  mocks.afterResponse.mockReset().mockResolvedValue(undefined)
  mocks.after.mockReset()
  mocks.requestPasswordReset.mockReset().mockResolvedValue({
    challengeId: "11111111-1111-4111-8111-111111111111",
    afterResponse: mocks.afterResponse,
  })
  mocks.logError.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("POST /api/v1/auth/password-reset/request", () => {
  it("returns the same generic accepted response without account details", async () => {
    const pending = POST(request({ identifier: "person-op" }))
    await vi.advanceTimersByTimeAsync(700)
    const response = await pending

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({
      challengeId: "11111111-1111-4111-8111-111111111111",
      message: "If an active account matches, a code was sent.",
      validForMinutes: 10,
    })
    expect(mocks.requestPasswordReset).toHaveBeenCalledWith("person-op")
  })

  it("sends the email after the response rather than before it", async () => {
    const pending = POST(request({ identifier: "person-op" }))
    await vi.advanceTimersByTimeAsync(700)
    await pending

    expect(mocks.after).toHaveBeenCalledWith(mocks.afterResponse)
    // Scheduling is the route's job; running it is the framework's.
    expect(mocks.afterResponse).not.toHaveBeenCalled()
  })

  it("holds every accepted response to the same minimum duration", async () => {
    let settled = false
    const pending = POST(request({ identifier: "person-op" })).then((response) => {
      settled = true
      return response
    })

    await vi.advanceTimersByTimeAsync(699)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect((await pending).status).toBe(202)
  })

  it("rate limits both the client and a secret-keyed account identifier", async () => {
    mocks.checkRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 4, resetIn: 100 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetIn: 720 })

    const response = await POST(request({ identifier: "person-op" }))

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("720")
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("ip:203.0.113.8", "otpSend")
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      `password-reset-request:${"a".repeat(40)}`,
      "otpSend",
    )
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled()
    expect(mocks.after).not.toHaveBeenCalled()
  })

  it("rejects extra fields before looking up an account", async () => {
    const response = await POST(request({ identifier: "person-op", userId: "target" }))

    expect(response.status).toBe(400)
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
    expect(mocks.requestPasswordReset).not.toHaveBeenCalled()
  })

  it("returns a generic error when the lookup itself fails", async () => {
    mocks.requestPasswordReset.mockRejectedValue(new Error("connection terminated"))

    const response = await POST(request({ identifier: "person-op" }))

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error).not.toContain("connection")
    expect(mocks.logError).toHaveBeenCalled()
  })
})
