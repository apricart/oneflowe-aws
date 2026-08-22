import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => {
  const handler = vi.fn()
  return {
    handler,
    nextAuth: vi.fn((_options?: any): any => handler),
    revokeAuthSessionFromToken: vi.fn(),
  }
})

vi.mock("next-auth", () => ({ default: mocks.nextAuth }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({
  checkRateLimit: vi.fn(),
  getClientIdentifier: vi.fn(),
  resetRateLimit: vi.fn(),
}))
vi.mock("@/lib/server/auth-session-store", () => ({
  revokeAuthSessionFromToken: mocks.revokeAuthSessionFromToken,
}))

import { GET, POST } from "@/app/api/auth/[...nextauth]/route"

describe("NextAuth session route hardening", () => {
  beforeEach(() => {
    mocks.handler.mockReset()
    mocks.revokeAuthSessionFromToken.mockReset().mockResolvedValue(undefined)
  })

  it("strips Set-Cookie from passive GET /session", async () => {
    mocks.handler.mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "user-1" } }), {
        headers: { "Set-Cookie": "next-auth.session-token=rolled; Path=/" },
      }),
    )

    const result = await GET(
      new NextRequest("https://app.test/api/auth/session"),
      {},
    )

    expect(result.headers.get("set-cookie")).toBeNull()
    await expect(result.json()).resolves.toEqual({ user: { id: "user-1" } })
  })

  it("preserves Set-Cookie for a successful activity POST /session", async () => {
    mocks.handler.mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "user-1" } }), {
        headers: { "Set-Cookie": "next-auth.session-token=fresh; Path=/" },
      }),
    )

    const result = await POST(
      new NextRequest("https://app.test/api/auth/session", { method: "POST" }),
      {},
    )

    expect(result.headers.get("set-cookie")).toContain("fresh")
  })

  it("preserves cookies on non-session GET endpoints", async () => {
    mocks.handler.mockResolvedValue(
      new Response(JSON.stringify({ csrfToken: "csrf" }), {
        headers: { "Set-Cookie": "next-auth.csrf-token=value; Path=/" },
      }),
    )

    const result = await GET(
      new NextRequest("https://app.test/api/auth/csrf"),
      {},
    )

    expect(result.headers.get("set-cookie")).toContain("csrf-token")
  })

  it("turns validation-store failure into 503 without a cookie write", async () => {
    mocks.handler.mockResolvedValue(
      new Response(JSON.stringify({ sessionValidationUnavailable: true }), {
        headers: { "Set-Cookie": "next-auth.session-token=rolled; Path=/" },
      }),
    )

    const result = await POST(
      new NextRequest("https://app.test/api/auth/session", { method: "POST" }),
      {},
    )

    expect(result.status).toBe(503)
    expect(result.headers.get("set-cookie")).toBeNull()
  })

  it("revokes the exact token before completing sign-out", async () => {
    const token = {
      sub: "user-1",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
    }
    const order: string[] = []
    mocks.revokeAuthSessionFromToken.mockImplementation(async () => {
      order.push("revoked")
    })
    mocks.nextAuth.mockImplementationOnce((options: any) => async () => {
      await options.events.signOut({ token })
      order.push("response")
      return new Response(JSON.stringify({ url: "https://app.test/login" }), {
        headers: {
          "Set-Cookie": "next-auth.session-token=; Max-Age=0; Path=/",
        },
      })
    })

    const result = await POST(
      new NextRequest("https://app.test/api/auth/signout", { method: "POST" }),
      {},
    )

    expect(mocks.revokeAuthSessionFromToken).toHaveBeenCalledWith(token)
    expect(order).toEqual(["revoked", "response"])
    expect(result.status).toBe(200)
    expect(result.headers.get("set-cookie")).toContain("Max-Age=0")
  })

  it("keeps the cookie retryable and returns 503 when revocation fails", async () => {
    const token = {
      sub: "user-1",
      sessionId: "123e4567-e89b-42d3-a456-426614174000",
    }
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.revokeAuthSessionFromToken.mockRejectedValue(
      new Error("registry unavailable"),
    )
    mocks.nextAuth.mockImplementationOnce((options: any) => async () => {
      try {
        await options.events.signOut({ token })
      } catch {
        // NextAuth swallows event failures and would otherwise clear the cookie.
      }
      return new Response(JSON.stringify({ url: "https://app.test/login" }), {
        headers: {
          "Set-Cookie": "next-auth.session-token=; Max-Age=0; Path=/",
        },
      })
    })

    const result = await POST(
      new NextRequest("https://app.test/api/auth/signout", { method: "POST" }),
      {},
    )

    expect(result.status).toBe(503)
    expect(result.headers.get("retry-after")).toBe("5")
    expect(result.headers.get("set-cookie")).toBeNull()
  })

  it("allows a no-token sign-out to clear stale browser state", async () => {
    mocks.nextAuth.mockImplementationOnce((options: any) => async () => {
      await options.events.signOut({ token: undefined })
      return new Response(JSON.stringify({ url: "https://app.test/login" }), {
        headers: {
          "Set-Cookie": "next-auth.session-token=; Max-Age=0; Path=/",
        },
      })
    })

    const result = await POST(
      new NextRequest("https://app.test/api/auth/signout", { method: "POST" }),
      {},
    )

    expect(mocks.revokeAuthSessionFromToken).toHaveBeenCalledWith(undefined)
    expect(result.status).toBe(200)
  })
})
