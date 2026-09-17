import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The session id that binds an emailed proof to one browser comes from the
 * signed token and nowhere else. These pin that it is read with the app's own
 * cookie name and secret, and that anything but a non-empty string is treated
 * as "no session" rather than passed on.
 */

const mocks = vi.hoisted(() => ({ getToken: vi.fn() }))

vi.mock("next-auth/jwt", () => ({ getToken: mocks.getToken }))
vi.mock("@/lib/auth-options", () => ({
  authOptions: { cookies: { sessionToken: { name: "__Secure-oneflowe.session" } } },
}))
vi.mock("@/lib/server/env", () => ({ env: { NEXTAUTH_SECRET: "s".repeat(48) } }))

import { getCurrentSessionId } from "./current-session"

const req = () => new NextRequest("https://app.test/api/v1/users/me/change-password", { method: "POST" })

beforeEach(() => mocks.getToken.mockReset())

describe("getCurrentSessionId", () => {
  it("returns the registry id carried by the signed token", async () => {
    mocks.getToken.mockResolvedValue({ sub: "user-1", sessionId: "9d2f0c4a-2222-4d8e-8b3f-000000000002" })

    await expect(getCurrentSessionId(req())).resolves.toBe("9d2f0c4a-2222-4d8e-8b3f-000000000002")
  })

  it("reads the token from the application's own cookie with the server secret", async () => {
    mocks.getToken.mockResolvedValue({ sessionId: "abc" })
    const request = req()

    await getCurrentSessionId(request)

    expect(mocks.getToken).toHaveBeenCalledWith({
      req: request,
      secret: "s".repeat(48),
      cookieName: "__Secure-oneflowe.session",
    })
  })

  it("answers null when there is no token at all", async () => {
    mocks.getToken.mockResolvedValue(null)

    await expect(getCurrentSessionId(req())).resolves.toBeNull()
  })

  it.each([
    ["no session id", { sub: "user-1" }],
    ["an empty session id", { sub: "user-1", sessionId: "" }],
    ["a numeric session id", { sub: "user-1", sessionId: 42 }],
    ["an object where the id should be", { sub: "user-1", sessionId: { id: "x" } }],
  ])("answers null for a token with %s rather than passing it on", async (_label, token) => {
    mocks.getToken.mockResolvedValue(token)

    await expect(getCurrentSessionId(req())).resolves.toBeNull()
  })
})
