import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getClientIdentifier: vi.fn(),
  rateLimitResponse: vi.fn(),
  resolveOrganizationByJoinCode: vi.fn(),
  issueJoinEmailCode: vi.fn(),
}))

vi.mock("@/lib/rate-limiter", () => ({
  checkRateLimit: mocks.checkRateLimit,
  getClientIdentifier: mocks.getClientIdentifier,
  rateLimitResponse: mocks.rateLimitResponse,
}))
vi.mock("@/lib/server/organization-join", () => ({
  resolveOrganizationByJoinCode: mocks.resolveOrganizationByJoinCode,
}))
vi.mock("@/lib/server/join-email-verification", () => ({
  issueJoinEmailCode: mocks.issueJoinEmailCode,
  joinEmailDigest: () => "d".repeat(64),
}))

import {
  JOIN_EMAIL_CODE_SEND_FAILED_MESSAGE,
  JOIN_EMAIL_DAILY_LIMIT_MESSAGE,
  JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE,
  UNKNOWN_JOIN_CODE_MESSAGE,
} from "@/lib/organization-join"

import { POST } from "./route"

const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111"

function request(body: unknown) {
  return new Request("http://localhost/api/v1/join/email-verification/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.checkRateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 4, resetIn: 900 })
  mocks.getClientIdentifier.mockReset().mockResolvedValue("ip:test")
  mocks.rateLimitResponse.mockReset().mockReturnValue(new Response(null, { status: 429 }))
  mocks.resolveOrganizationByJoinCode.mockReset().mockResolvedValue({
    organizationId: 7,
    organizationName: "K-Electric",
    emailDomain: "ke.com.pk",
  })
  mocks.issueJoinEmailCode.mockReset().mockResolvedValue({
    kind: "sent",
    challengeId: CHALLENGE_ID,
    validForMinutes: 10,
  })
})

describe("POST /api/v1/join/email-verification/request", () => {
  it("sends a code for the organization the join code names, to the normalised address", async () => {
    const response = await POST(request({ code: "acde-4fgh-7jkl", email: " Ada@KE.com.pk " }))

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ challengeId: CHALLENGE_ID, validForMinutes: 10 })
    expect(mocks.resolveOrganizationByJoinCode).toHaveBeenCalledWith("ACDE-4FGH-7JKL")
    expect(mocks.issueJoinEmailCode).toHaveBeenCalledWith({ organizationId: 7, email: "ada@ke.com.pk" })
  })

  it("is limited on the caller, the code and the address", async () => {
    await POST(request({ code: "ACDE-4FGH-7JKL", email: "ada@ke.com.pk" }))
    const budgets = mocks.checkRateLimit.mock.calls.map(([key, type]) => [String(key).split(":")[0], type])
    expect(budgets).toEqual([
      ["ip", "login"],
      ["join-email-code", "login"],
      ["join-email-address", "otpSend"],
    ])
    // Neither the code nor the address is written into a limiter key in the clear.
    const keys = mocks.checkRateLimit.mock.calls.map(([key]) => String(key)).join(" ")
    expect(keys).not.toContain("ACDE-4FGH-7JKL")
    expect(keys).not.toContain("ada@ke.com.pk")
  })

  it("answers 429 and sends nothing when any budget is spent", async () => {
    mocks.checkRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 1, resetIn: 900 })
      .mockResolvedValueOnce({ allowed: true, remaining: 1, resetIn: 900 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetIn: 300 })
    const response = await POST(request({ code: "ACDE-4FGH-7JKL", email: "ada@ke.com.pk" }))
    expect(response.status).toBe(429)
    expect(mocks.rateLimitResponse).toHaveBeenCalledWith(900)
    expect(mocks.issueJoinEmailCode).not.toHaveBeenCalled()
  })

  it("answers an unknown code with the one generic message", async () => {
    mocks.resolveOrganizationByJoinCode.mockResolvedValue(null)
    const response = await POST(request({ code: "ACDE-4FGH-7JKL", email: "ada@ke.com.pk" }))
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: UNKNOWN_JOIN_CODE_MESSAGE })
    expect(mocks.issueJoinEmailCode).not.toHaveBeenCalled()
  })

  it.each(["ada@evil.test", "ada@mail.ke.com.pk", "ada@ke.com.pk.evil.test"])(
    "refuses %s, outside the organization's domain",
    async (email) => {
      const response = await POST(request({ code: "ACDE-4FGH-7JKL", email }))
      expect(response.status).toBe(400)
      expect(mocks.issueJoinEmailCode).not.toHaveBeenCalled()
    },
  )

  it("refuses an organization with no domain", async () => {
    mocks.resolveOrganizationByJoinCode.mockResolvedValue({ organizationId: 7, organizationName: "Demo", emailDomain: null })
    const response = await POST(request({ code: "ACDE-4FGH-7JKL", email: "ada@ke.com.pk" }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE })
  })

  it("refuses an organization id in the body before anything else runs", async () => {
    const response = await POST(request({ code: "ACDE-4FGH-7JKL", email: "ada@ke.com.pk", organizationId: 9 }))
    expect(response.status).toBe(400)
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
    expect(mocks.resolveOrganizationByJoinCode).not.toHaveBeenCalled()
  })

  it("tells the applicant the daily limit, with a day's Retry-After", async () => {
    mocks.issueJoinEmailCode.mockResolvedValue({ kind: "daily_limit" })
    const response = await POST(request({ code: "ACDE-4FGH-7JKL", email: "ada@ke.com.pk" }))
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("86400")
    await expect(response.json()).resolves.toEqual({ error: JOIN_EMAIL_DAILY_LIMIT_MESSAGE })
  })

  it("says the mail could not be sent, in its own words rather than a generic 5xx", async () => {
    mocks.issueJoinEmailCode.mockResolvedValue({ kind: "delivery_failed" })
    const response = await POST(request({ code: "ACDE-4FGH-7JKL", email: "ada@ke.com.pk" }))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: JOIN_EMAIL_CODE_SEND_FAILED_MESSAGE })
  })

  it("never echoes an internal error", async () => {
    mocks.issueJoinEmailCode.mockRejectedValue(new Error("relation join_email_verifications does not exist"))
    const response = await POST(request({ code: "ACDE-4FGH-7JKL", email: "ada@ke.com.pk" }))
    expect(response.status).toBe(500)
    expect(await response.text()).not.toMatch(/relation|join_email_verifications/)
  })
})
