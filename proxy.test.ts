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
    // Group Order Portal is confined to its own area, and its area is closed
    // to everyone else.
    ["GROUP_ORDER_PORTAL", "/dashboard", "/group-portal"],
    ["GROUP_ORDER_PORTAL", "/shop", "/group-portal"],
    ["GROUP_ORDER_PORTAL", "/organizations", "/group-portal"],
    ["GROUP_ORDER_PORTAL", "/group-portal", null],
    // The approver works inside the shared shell, but only in the areas its
    // role has: its dashboard and order directory, its queue, the reports its
    // assignments scope, and settings.
    ["GROUP_USER", "/approvals", null],
    ["GROUP_USER", "/dashboard", null],
    ["GROUP_USER", "/orders", null],
    ["GROUP_USER", "/orders/42", null],
    ["GROUP_USER", "/reports", null],
    ["GROUP_USER", "/reports/order-report", null],
    ["GROUP_USER", "/reports/graphical", null],
    // Money budgets for its assigned branches; the quantity ledger stays closed.
    ["GROUP_USER", "/budgets", null],
    ["GROUP_USER", "/settings", null],
    // Everything else in the shell stays closed to it, and its home is now the
    // dashboard rather than the queue.
    ["GROUP_USER", "/shop", "/dashboard"],
    ["GROUP_USER", "/organizations", "/dashboard"],
    ["GROUP_USER", "/users", "/dashboard"],
    ["GROUP_USER", "/branches", "/dashboard"],
    ["GROUP_USER", "/inventory", "/dashboard"],
    ["GROUP_USER", "/branch-inventory", "/dashboard"],
    ["GROUP_USER", "/budget-by-quantity", "/dashboard"],
    ["GROUP_USER", "/groups", "/dashboard"],
    ["GROUP_USER", "/refunds", "/dashboard"],
    ["GROUP_USER", "/products", "/dashboard"],
    ["GROUP_USER", "/employee-management", "/dashboard"],
    ["GROUP_USER", "/group-portal", "/dashboard"],
    // The multi-branch ordering workspace is exclusive to the requesting role.
    ["GROUP_ORDER_PORTAL", "/group-portal/bulk-order", null],
    ["GROUP_USER", "/group-portal/bulk-order", "/dashboard"],
    ["SUPER_ADMIN", "/group-portal/bulk-order", "/dashboard"],
    ["ORDER_PORTAL", "/group-portal/bulk-order", "/shop"],
    // The approval queue is the approver's alone; no administrator and neither
    // of the single-branch roles may reach it.
    ["GROUP_ORDER_PORTAL", "/approvals", "/group-portal"],
    ["SUPER_ADMIN", "/approvals", "/dashboard"],
    ["HEAD_OFFICE", "/approvals", "/dashboard"],
    ["BRANCH_ADMIN", "/approvals", "/dashboard"],
    ["ORDER_PORTAL", "/approvals", "/shop"],
    ["SUPER_ADMIN", "/group-portal", "/dashboard"],
    ["HEAD_OFFICE", "/group-portal", "/dashboard"],
    ["BRANCH_ADMIN", "/group-portal", "/dashboard"],
    ["ORDER_PORTAL", "/group-portal", "/shop"],
    // The invoice page is shared: the store links to it and the admin orders
    // directory links to it, so neither role is bounced home from it. Which
    // invoice each may actually read is enforced by the invoice endpoints.
    ["ORDER_PORTAL", "/invoices/42", null],
    ["SUPER_ADMIN", "/invoices/42", null],
    ["HEAD_OFFICE", "/invoices/42", null],
    ["BRANCH_ADMIN", "/invoices/42", null],
    // The store role gains the invoice page and nothing else.
    ["ORDER_PORTAL", "/orders", "/shop"],
    ["ORDER_PORTAL", "/reports", "/shop"],
    // The group roles read invoices from their own surfaces too: the approval
    // queue and the group order history both link to the shared page.
    ["GROUP_USER", "/invoices/42", null],
    ["GROUP_ORDER_PORTAL", "/invoices/42", null],
    // The rest of each area stays exactly as closed as before.
    ["GROUP_ORDER_PORTAL", "/orders", "/group-portal"],
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

  it("leaves API authorization to the handlers while still applying no-store", async () => {
    // No session at all: the proxy neither redirects nor refuses an API
    // request — the handler answers 401 itself.
    mocks.getToken.mockResolvedValue(null)

    const response = await proxy(request("/api/v1/orders"))

    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-next")).toBe("1")
    expect(response.headers.get("cache-control")).toContain("no-store")
  })
})

describe("API requests from a session that still owes a password change", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    mocks.getToken.mockReset()
    mocks.logger.mockReset()
  })

  afterEach(() => vi.restoreAllMocks())

  const flagged = () => ({ ...validToken("ORDER_PORTAL"), mustChangePassword: true })

  it.each([
    "/api/v1/orders",
    "/api/v1/orders/42/approve",
    "/api/v1/users/me",
    "/api/v1/budgets",
    "/api/v1/users/me/change-password/extra",
  ])("refuses %s with 403 and a stable code", async (path) => {
    mocks.getToken.mockResolvedValue(flagged())

    const response = await proxy(request(path))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: "Password change required",
      code: "PASSWORD_CHANGE_REQUIRED",
    })
    expect(response.headers.get("cache-control")).toContain("no-store")
    expect(mocks.logger).toHaveBeenCalledWith("middleware", {
      reason: "password_change_required",
      path,
    })
  })

  it.each([
    "/api/v1/users/me/change-password",
    "/api/v1/users/me/email-verification/send",
    "/api/v1/users/me/email-verification/verify",
    "/api/v1/users/me/email-verification/verify/",
  ])("lets %s through so the change can complete", async (path) => {
    mocks.getToken.mockResolvedValue(flagged())

    const response = await proxy(request(path))

    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })

  it("does not touch a session that has already changed its password", async () => {
    mocks.getToken.mockResolvedValue({ ...validToken("ORDER_PORTAL"), mustChangePassword: false })

    const response = await proxy(request("/api/v1/orders"))

    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })

  it("still sends the same session to /change-password for pages", async () => {
    mocks.getToken.mockResolvedValue(flagged())

    const response = await proxy(request("/shop"))

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("https://app.test/change-password")
  })
})
