import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The change handler: two passwords in, one status out. The account and the
 * session are the token's, never the body's; a body that tries to name
 * either — or a role, or a flag — is refused whole. The rules (emailed proof,
 * current password, policy, must differ) live in
 * `lib/server/password-change.ts` and run against Postgres in
 * `tests/integration/password-rotation.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  withRateLimit: vi.fn(),
  getCurrentSessionId: vi.fn(),
  changeOwnPassword: vi.fn(),
  logError: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: mocks.withRateLimit }))
vi.mock("@/lib/server/current-session", () => ({ getCurrentSessionId: mocks.getCurrentSessionId }))
vi.mock("@/lib/server/password-change", () => ({ changeOwnPassword: mocks.changeOwnPassword }))
vi.mock("@/lib/global-logger", () => ({ logError: mocks.logError }))

import { EMAIL_VERIFICATION_REQUIRED_CODE, POST } from "./route"

const USER_ID = "3b1a6a3e-1111-4c7b-9a2e-000000000001"
const SESSION_ID = "9d2f0c4a-2222-4d8e-8b3f-000000000002"
const GOOD_BODY = { currentPassword: "Handout-Passw0rd!", password: "Chosen-Passw0rd!2026" }

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/users/me/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.getCurrentUser.mockReset().mockResolvedValue({ id: USER_ID, role: "BRANCH_ADMIN" })
  mocks.withRateLimit.mockReset().mockResolvedValue(null)
  mocks.getCurrentSessionId.mockReset().mockResolvedValue(SESSION_ID)
  mocks.changeOwnPassword.mockReset().mockResolvedValue({ kind: "changed", forced: true })
  mocks.logError.mockReset()
})

describe("POST /api/v1/users/me/change-password — guards", () => {
  it("refuses without a session", async () => {
    mocks.getCurrentUser.mockResolvedValue(null)

    expect((await POST(post(GOOD_BODY))).status).toBe(401)
    expect(mocks.changeOwnPassword).not.toHaveBeenCalled()
  })

  it("is not for employee-store principals", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "emp_9" })

    expect((await POST(post(GOOD_BODY))).status).toBe(400)
    expect(mocks.changeOwnPassword).not.toHaveBeenCalled()
  })

  it("rate limits on the sensitive bucket per user before reading the body", async () => {
    mocks.withRateLimit.mockResolvedValue(NextResponse.json({ error: "Too many requests" }, { status: 429 }))

    const response = await POST(post(GOOD_BODY))

    expect(response.status).toBe(429)
    expect(mocks.withRateLimit).toHaveBeenCalledWith("sensitive", USER_ID)
    expect(mocks.changeOwnPassword).not.toHaveBeenCalled()
  })

  it("refuses a token with no registry session id — nothing could hold the proof", async () => {
    mocks.getCurrentSessionId.mockResolvedValue(null)

    expect((await POST(post(GOOD_BODY))).status).toBe(401)
    expect(mocks.changeOwnPassword).not.toHaveBeenCalled()
  })
})

describe("POST /api/v1/users/me/change-password — body", () => {
  it.each([
    ["no current password", { password: GOOD_BODY.password }],
    ["an empty current password", { currentPassword: "", password: GOOD_BODY.password }],
    ["no new password", { currentPassword: GOOD_BODY.currentPassword }],
    ["an empty new password", { currentPassword: GOOD_BODY.currentPassword, password: "" }],
    ["a new password over 128 characters", { currentPassword: GOOD_BODY.currentPassword, password: "A1!".repeat(43) }],
    ["a non-string password", { currentPassword: GOOD_BODY.currentPassword, password: 12345678901234 }],
    ["a confirmation field the server never asked for", { ...GOOD_BODY, confirmPassword: GOOD_BODY.password }],
    ["a role", { ...GOOD_BODY, role: "SUPER_ADMIN" }],
    ["a user id", { ...GOOD_BODY, userId: "someone-else" }],
    ["a session id", { ...GOOD_BODY, sessionId: "another-session" }],
    ["the flag itself", { ...GOOD_BODY, mustChangePassword: false }],
  ])("rejects a body with %s, changing nothing", async (_label, body) => {
    const response = await POST(post(body))

    expect(response.status).toBe(400)
    expect(mocks.changeOwnPassword).not.toHaveBeenCalled()
  })

  it("names the field in a validation failure", async () => {
    const response = await POST(post({ currentPassword: "", password: GOOD_BODY.password }))

    await expect(response.json()).resolves.toEqual({ error: "Current password is required" })
  })

  it("names the unexpected field so a mass-assignment attempt is legible in the log", async () => {
    const response = await POST(post({ ...GOOD_BODY, role: "SUPER_ADMIN" }))

    await expect(response.json()).resolves.toEqual({ error: "Unknown field: role" })
  })

  it("changes for the signed-in account on the token's session, with exactly the two passwords", async () => {
    await POST(post(GOOD_BODY))

    expect(mocks.changeOwnPassword).toHaveBeenCalledTimes(1)
    expect(mocks.changeOwnPassword).toHaveBeenCalledWith({
      userId: USER_ID,
      sessionId: SESSION_ID,
      currentPassword: GOOD_BODY.currentPassword,
      newPassword: GOOD_BODY.password,
    })
  })
})

describe("POST /api/v1/users/me/change-password — outcomes", () => {
  it("answers a change with success and nothing about the account", async () => {
    const response = await POST(post(GOOD_BODY))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true })
  })

  it("refuses without a fresh emailed proof, with the code the page restarts on", async () => {
    mocks.changeOwnPassword.mockResolvedValue({ kind: "verification_required" })

    const response = await POST(post(GOOD_BODY))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: EMAIL_VERIFICATION_REQUIRED_CODE })
  })

  it("answers a session the module could not find — revoked, or another account's — with 401", async () => {
    mocks.changeOwnPassword.mockResolvedValue({ kind: "session_invalid" })

    const response = await POST(post(GOOD_BODY))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" })
  })

  it("answers a locked account with 423 and when to retry", async () => {
    mocks.changeOwnPassword.mockResolvedValue({ kind: "locked", retryAfterSeconds: 540 })

    const response = await POST(post(GOOD_BODY))

    expect(response.status).toBe(423)
    expect(response.headers.get("Retry-After")).toBe("540")
    await expect(response.json()).resolves.toMatchObject({ code: "ACCOUNT_LOCKED" })
  })

  it("answers a wrong current password with 400 and no hint about which part was wrong", async () => {
    mocks.changeOwnPassword.mockResolvedValue({ kind: "invalid_current_password" })

    const response = await POST(post(GOOD_BODY))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: "The current password is incorrect." })
  })

  it("answers a new password equal to the old one with 400", async () => {
    mocks.changeOwnPassword.mockResolvedValue({ kind: "password_unchanged" })

    const response = await POST(post(GOOD_BODY))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("different") })
  })

  it("lists every policy failure of a weak password", async () => {
    mocks.changeOwnPassword.mockResolvedValue({
      kind: "invalid_password",
      errors: ["Password must be at least 12 characters", "Password must contain a special character"],
    })

    const response = await POST(post(GOOD_BODY))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Password must be at least 12 characters, Password must contain a special character",
    })
  })

  it("answers 404 for a session whose account is gone or inactive", async () => {
    mocks.changeOwnPassword.mockResolvedValue({ kind: "not_found" })

    expect((await POST(post(GOOD_BODY))).status).toBe(404)
  })

  it("hides an unexpected failure behind a generic 500 and logs it, never echoing a password", async () => {
    mocks.changeOwnPassword.mockRejectedValue(new Error(`bcrypt failed for ${GOOD_BODY.password}`))

    const response = await POST(post(GOOD_BODY))

    expect(response.status).toBe(500)
    const body = await response.json()
    // `lib/api`'s error() replaces every 5xx message with this one, so not
    // even the handler's own wording reaches the caller — let alone the cause.
    expect(body).toEqual({ error: "An unexpected error occurred. Please try again later." })
    expect(JSON.stringify(body)).not.toContain(GOOD_BODY.password)
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(Error), "API_CHANGE_PASSWORD")
  })
})
