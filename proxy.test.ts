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
    ["GROUP_USER", "/budgets", "/dashboard"],
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
    // The join queue is Head Office's alone. Super Admin is bounced too, and
    // deliberately so: issuing a tenant's join code and deciding who joins it
    // belong to that tenant's own gatekeeper (lib/organization-join-access.ts).
    ["HEAD_OFFICE", "/join-requests", null],
    ["SUPER_ADMIN", "/join-requests", "/dashboard"],
    ["BRANCH_ADMIN", "/join-requests", "/dashboard"],
    ["GROUP_USER", "/join-requests", "/dashboard"],
    ["GROUP_ORDER_PORTAL", "/join-requests", "/group-portal"],
    ["ORDER_PORTAL", "/join-requests", "/shop"],
    // The read-only account reaches its dashboard and nothing else — not the
    // shared invoice page, not the support area, not another role's portal.
    // The proxy is navigation only; every endpoint refuses it besides.
    ["VIEWER", "/dashboard", null],
    ["VIEWER", "/orders", "/dashboard"],
    ["VIEWER", "/orders/42", "/dashboard"],
    ["VIEWER", "/users", "/dashboard"],
    ["VIEWER", "/budgets", "/dashboard"],
    ["VIEWER", "/budget-by-quantity", "/dashboard"],
    ["VIEWER", "/reports", "/dashboard"],
    ["VIEWER", "/reports/graphical", "/dashboard"],
    ["VIEWER", "/settings", "/dashboard"],
    ["VIEWER", "/inventory", "/dashboard"],
    ["VIEWER", "/branch-inventory", "/dashboard"],
    ["VIEWER", "/groups", "/dashboard"],
    ["VIEWER", "/refunds", "/dashboard"],
    ["VIEWER", "/products", "/dashboard"],
    ["VIEWER", "/employee-management", "/dashboard"],
    ["VIEWER", "/approvals", "/dashboard"],
    ["VIEWER", "/branches", "/dashboard"],
    ["VIEWER", "/join-requests", "/dashboard"],
    ["VIEWER", "/organizations", "/dashboard"],
    ["VIEWER", "/shop", "/dashboard"],
    ["VIEWER", "/group-portal", "/dashboard"],
    ["VIEWER", "/group-portal/bulk-order", "/dashboard"],
    ["VIEWER", "/invoices/42", "/dashboard"],
    ["VIEWER", "/receipts/42", "/dashboard"],
    ["VIEWER", "/support", "/dashboard"],
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

  it.each(["/join", "/login"])("lets an unauthenticated caller reach %s", async (path) => {
    // The public join page must work with no session — it is how somebody with
    // no account asks to be let into an organization. It can create nothing:
    // the endpoint behind it records a pending request and Head Office decides
    // it (plans/OF-JOIN-organization-self-service-join.md).
    mocks.getToken.mockResolvedValue(null)

    const response = await proxy(request(path))

    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })

  it("does not let /join open the Head Office queue at /join-requests", async () => {
    mocks.getToken.mockResolvedValue(null)

    const response = await proxy(request("/join-requests"))

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("https://app.test/login")
  })

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

describe("pages for a session that still owes a password change, per role", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    mocks.getToken.mockReset()
    mocks.logger.mockReset()
  })

  afterEach(() => vi.restoreAllMocks())

  // Every role the K-Electric rotation flags, with the page each lands on
  // after sign-in. The redirect has to fire for all of them, and
  // `/change-password` itself has to be reachable by all of them — including
  // the ones normally confined to another area — or the flow loops.
  const homes: [string, string][] = [
    ["ORDER_PORTAL", "/shop"],
    ["BRANCH_ADMIN", "/dashboard"],
    ["HEAD_OFFICE", "/dashboard"],
    ["GROUP_ORDER_PORTAL", "/group-portal"],
    ["GROUP_USER", "/dashboard"],
    ["VIEWER", "/dashboard"],
  ]

  it.each(homes)("sends a flagged %s from %s to /change-password", async (role, home) => {
    mocks.getToken.mockResolvedValue({ ...validToken(role), mustChangePassword: true })

    const response = await proxy(request(home))

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("https://app.test/change-password")
  })

  it.each(homes)("lets a flagged %s stay on /change-password — no redirect loop", async (role) => {
    mocks.getToken.mockResolvedValue({ ...validToken(role), mustChangePassword: true })

    const response = await proxy(request("/change-password"))

    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-next")).toBe("1")
    expect(response.headers.get("cache-control")).toContain("no-store")
  })

  it.each(homes)("refuses a flagged %s the rest of the API, whatever its role", async (role) => {
    mocks.getToken.mockResolvedValue({ ...validToken(role), mustChangePassword: true })

    const response = await proxy(request("/api/v1/users/me"))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" })
  })

  it.each(homes)("still lets a flagged %s reach the three endpoints the change needs", async (role) => {
    mocks.getToken.mockResolvedValue({ ...validToken(role), mustChangePassword: true })

    for (const path of [
      "/api/v1/users/me/email-verification/send",
      "/api/v1/users/me/email-verification/verify",
      "/api/v1/users/me/change-password",
    ]) {
      const response = await proxy(request(path))
      expect(response.status, path).toBe(200)
      expect(response.headers.get("x-middleware-next"), path).toBe("1")
    }
  })

  it("sends an unauthenticated visitor to /change-password on to the login page", async () => {
    mocks.getToken.mockResolvedValue(null)

    const response = await proxy(request("/change-password"))

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("https://app.test/login")
  })

  it("does not read the flag off a request the gate is not for: an expired session is expired first", async () => {
    mocks.getToken.mockResolvedValue({
      ...validToken("BRANCH_ADMIN"),
      mustChangePassword: true,
      sessionAbsoluteExpiresAt: NOW - 1,
    })

    const response = await proxy(request("/dashboard"))

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).not.toBe("https://app.test/change-password")
  })
})

describe("Apricart's Order Desk session", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    mocks.getToken.mockReset()
    mocks.logger.mockReset()
  })

  afterEach(() => vi.restoreAllMocks())

  // A desk account has no organization of its own.
  const deskToken = () => ({ ...validToken("ORDER_DESK"), organizationId: null })

  function apiRequest(path: string, method: string) {
    return new NextRequest(`https://app.test${path}`, {
      method,
      headers: { origin: "https://app.test", "sec-fetch-site": "same-origin" },
    })
  }

  it.each([
    ["POST", "/api/v1/orders"],
    ["GET", "/api/v1/order-desk/targets"],
    ["GET", "/api/v1/order-desk/catalogue"],
    ["GET", "/api/v1/order-desk/orders"],
    ["GET", "/api/v1/order-desk/orders/"],
    ["PUT", "/api/v1/order-desk/orders/42"],
    ["POST", "/api/v1/order-desk/orders/42/fulfil"],
    ["POST", "/api/v1/order-desk/orders/42/cancel"],
    ["GET", "/api/v1/order-desk/orders/42/attachment"],
    ["POST", "/api/v1/upload/image"],
    ["GET", "/api/v1/orders/42/refunds"],
    ["POST", "/api/v1/orders/42/refunds"],
    ["POST", "/api/v1/users/me/change-password"],
    // "Forgot password" in the desk's own profile menu, while still signed in.
    ["POST", "/api/v1/auth/password-reset/request"],
    ["POST", "/api/v1/auth/password-reset/verify"],
    ["POST", "/api/v1/auth/password-reset/complete"],
  ])("lets %s %s through to its handler", async (method, path) => {
    mocks.getToken.mockResolvedValue(deskToken())

    const response = await proxy(apiRequest(path, method))

    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })

  it.each([
    // Reads that would otherwise run with no tenant on the session.
    ["GET", "/api/v1/orders"],
    ["GET", "/api/v1/orders/42"],
    ["GET", "/api/v1/users"],
    ["GET", "/api/v1/organizations"],
    ["GET", "/api/v1/branches"],
    ["GET", "/api/v1/budgets"],
    ["GET", "/api/v1/branch/inventory"],
    ["GET", "/api/v1/analytics/sales-performance"],
    ["GET", "/api/v1/activity-logs"],
    // Writes it must never reach: prices, users, tenants, approvals, the
    // Super Admin fulfilment route, and its own team administration.
    ["PATCH", "/api/v1/organizations/7"],
    ["POST", "/api/v1/users"],
    ["PATCH", "/api/v1/users/u-1/access"],
    ["PUT", "/api/v1/groups/3/prices"],
    ["POST", "/api/v1/orders/42/approve"],
    ["POST", "/api/v1/orders/42/fulfill"],
    ["POST", "/api/v1/orders/42/fulfillment-status"],
    // Delivery is Super Admin's to record; the desk's old step is gone.
    ["POST", "/api/v1/order-desk/orders/42/delivery"],
    ["GET", "/api/v1/images/products/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.png"],
    ["PATCH", "/api/v1/admin/refunds/9"],
    ["GET", "/api/v1/order-desk/team"],
    ["PUT", "/api/v1/order-desk/team/u-1/assignments"],
    // Right path, wrong method or a lookalike path.
    ["GET", "/api/v1/order-desk/orders/42/fulfil"],
    ["DELETE", "/api/v1/orders"],
    ["POST", "/api/v1/order-desk/orders/abc/fulfil"],
    ["POST", "/api/v1/order-desk/orders/42/fulfil/extra"],
    ["POST", "/api/v1/orders-export"],
  ])("refuses %s %s before any handler runs", async (method, path) => {
    mocks.getToken.mockResolvedValue(deskToken())

    const response = await proxy(apiRequest(path, method))

    expect(response.status).toBe(403)
    expect(response.headers.get("x-middleware-next")).toBeNull()
    expect(response.headers.get("cache-control")).toContain("no-store")
  })

  it("leaves every other role's API traffic to its handlers", async () => {
    mocks.getToken.mockResolvedValue(validToken("SUPER_ADMIN"))

    const response = await proxy(apiRequest("/api/v1/order-desk/team", "GET"))

    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })

  it("still holds a desk session that owes a password change to the change endpoints", async () => {
    mocks.getToken.mockResolvedValue({ ...deskToken(), mustChangePassword: true })

    const response = await proxy(apiRequest("/api/v1/order-desk/targets", "GET"))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" })
  })

  it.each([
    ["/order-desk", null],
    ["/order-desk/anything", null],
    ["/dashboard", "/order-desk"],
    ["/orders", "/order-desk"],
    ["/users", "/order-desk"],
    ["/organizations", "/order-desk"],
    ["/desk-team", "/order-desk"],
    ["/shop", "/order-desk"],
    ["/group-portal", "/order-desk"],
    ["/invoices/42", "/order-desk"],
    ["/support", "/order-desk"],
  ])("confines the desk's pages: %s", async (path, redirectedPath) => {
    mocks.getToken.mockResolvedValue(deskToken())

    const response = await proxy(request(path))

    if (redirectedPath) {
      expect(response.status).toBe(307)
      expect(new URL(response.headers.get("location")!).pathname).toBe(redirectedPath)
    } else {
      expect(response.status).toBe(200)
    }
  })

  it.each([
    ["SUPER_ADMIN", "/desk-team", null],
    ["HEAD_OFFICE", "/desk-team", "/dashboard"],
    ["BRANCH_ADMIN", "/desk-team", "/dashboard"],
    ["SUPER_ADMIN", "/order-desk", "/dashboard"],
    ["HEAD_OFFICE", "/order-desk", "/dashboard"],
    // The warehouse's branches are assigned on a page of their own, which the
    // warehouse workspace's "/warehouse" prefix must not swallow.
    ["SUPER_ADMIN", "/warehouse-team", null],
    ["HEAD_OFFICE", "/warehouse-team", "/dashboard"],
    ["ORDER_DESK", "/warehouse-team", "/order-desk"],
    ["WAREHOUSE", "/warehouse-team", "/warehouse"],
    ["WAREHOUSE", "/warehouse", null],
    ["SUPER_ADMIN", "/warehouse", "/dashboard"],
  ])("keeps %s to its own side of %s", async (role, path, redirectedPath) => {
    mocks.getToken.mockResolvedValue(validToken(role))

    const response = await proxy(request(path))

    if (redirectedPath) {
      expect(response.status).toBe(307)
      expect(new URL(response.headers.get("location")!).pathname).toBe(redirectedPath)
    } else {
      expect(response.status).toBe(200)
    }
  })
})
