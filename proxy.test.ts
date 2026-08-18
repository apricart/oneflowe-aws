import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  logger: vi.fn(),
}))

vi.mock("next-auth/jwt", () => ({ getToken: mocks.getToken }))
vi.mock("@/lib/edge/env", () => ({
  edgeEnv: { NEXTAUTH_SECRET: "n".repeat(48) },
}))
vi.mock("@/lib/utils", () => ({ logger: mocks.logger }))

import { proxy } from "@/proxy"

const NOW = 2_000_000_000_000

function validToken(role = "HEAD_OFFICE") {
  return {
    sub: "user-1",
    role,
    organizationId: 17,
    branchId: null,
    sessionPolicyVersion: 1,
    sessionStartedAt: NOW - 60_000,
    sessionLastActivityAt: NOW - 1_000,
    sessionIdleTimeoutMinutes: 15,
    sessionAbsoluteExpiresAt: NOW + 7 * 60 * 60_000,
  }
}

function request(path: string, cookie?: string) {
  return new NextRequest(`https://app.test${path}`, {
    headers: cookie ? { cookie } : undefined,
  })
}

describe("session policy proxy enforcement", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    mocks.getToken.mockReset()
    mocks.logger.mockReset()
  })

  afterEach(() => vi.restoreAllMocks())

  it.each(["/branch-inventory", "/budget-by-quantity", "/employee-management", "/products/categories", "/refunds", "/groups", "/invoices/42", "/receipts/42"])(
    "protects the real application route %s before rendering",
    async (path) => {
      mocks.getToken.mockResolvedValue(null)

      const response = await proxy(request(path))

      expect(response.status).toBe(307)
      expect(response.headers.get("location")).toBe("https://app.test/login")
    },
  )

  it.each([
    ["absolute", { sessionAbsoluteExpiresAt: NOW }],
    ["malformed", { sessionStartedAt: undefined }],
  ])("rejects an %s-expired or invalid signed policy", async (_name, patch) => {
    mocks.getToken.mockResolvedValue({ ...validToken(), ...patch })

    const response = await proxy(request("/dashboard"))

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toContain(
      "/login?reason=session-expired",
    )
  })

  it("leaves mutable idle enforcement to the monotonic server registry", async () => {
    mocks.getToken.mockResolvedValue({
      ...validToken(),
      sessionStartedAt: NOW - 16 * 60_000,
      sessionLastActivityAt: NOW - 15 * 60_000,
    })

    const response = await proxy(request("/dashboard"))

    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })

  it("expires every chunk of a production secure cookie with Secure attributes", async () => {
    mocks.getToken.mockResolvedValue({
      ...validToken(),
      sessionAbsoluteExpiresAt: NOW,
    })

    const response = await proxy(
      request(
        "/dashboard",
        "__Secure-next-auth.session-token.0=a; __Secure-next-auth.session-token.1=b",
      ),
    )
    const setCookie = response.headers.get("set-cookie") ?? ""

    expect(setCookie).toContain("__Secure-next-auth.session-token.0=")
    expect(setCookie).toContain("__Secure-next-auth.session-token.1=")
    const deletedCookies = setCookie.split(/,(?=\s*__Secure-)/)
    expect(deletedCookies).toHaveLength(4)
    for (const cookie of deletedCookies) {
      expect(cookie).toMatch(/;\s*Path=\/(?:;|$)/i)
      expect(cookie).toMatch(/;\s*Max-Age=0(?:;|$)/i)
      if (cookie.trimStart().startsWith("__Secure-")) {
        expect(cookie).toMatch(/;\s*Secure(?:;|$)/i)
      }
    }
  })

  it.each([
    ["ORDER_PORTAL", "/dashboard", "/shop"],
    ["HEAD_OFFICE", "/shop", "/dashboard"],
    ["BRANCH_ADMIN", "/organizations", "/login"],
    ["SUPER_ADMIN", "/organizations", null],
    ["HEAD_OFFICE", "/branches", null],
  ])(
    "preserves %s routing for %s",
    async (role, path, redirectedPath) => {
      mocks.getToken.mockResolvedValue(validToken(role))

      const response = await proxy(request(path))

      if (redirectedPath) {
        expect(response.status).toBe(307)
        expect(new URL(response.headers.get("location")!).pathname).toBe(
          redirectedPath,
        )
      } else {
        expect(response.status).toBe(200)
        expect(response.headers.get("x-middleware-next")).toBe("1")
      }
    },
  )

  it("leaves API authorization to getServerSession while still applying no-store", async () => {
    const response = await proxy(request("/api/v1/orders"))

    expect(mocks.getToken).not.toHaveBeenCalled()
    expect(response.headers.get("cache-control")).toContain("no-store")
  })
})
