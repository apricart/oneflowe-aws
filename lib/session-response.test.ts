import { describe, expect, it } from "vitest"

import {
  hardenSessionEndpointResponse,
  withoutSetCookieHeaders,
} from "@/lib/session-response"

describe("passive session response", () => {
  it("preserves the payload and security headers but strips cookie writes", async () => {
    const source = new Response(JSON.stringify({ user: { id: "user-1" } }), {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "application/json",
        "Set-Cookie": "next-auth.session-token=stale; Path=/; HttpOnly",
      },
    })

    const result = withoutSetCookieHeaders(source)

    expect(result.status).toBe(200)
    expect(result.headers.get("set-cookie")).toBeNull()
    expect(result.headers.get("cache-control")).toBe("private, no-store")
    await expect(result.json()).resolves.toEqual({ user: { id: "user-1" } })
  })

  it("preserves activity cookie writes after successful validation", async () => {
    const source = new Response(JSON.stringify({ user: { id: "user-1" } }), {
      headers: { "Set-Cookie": "next-auth.session-token=fresh; Path=/" },
    })

    const result = await hardenSessionEndpointResponse(source, {
      allowCookieWrite: true,
    })

    expect(result.headers.get("set-cookie")).toContain("fresh")
  })

  it("returns no-store 503 without cookie mutation when validation is unavailable", async () => {
    const source = new Response(
      JSON.stringify({ sessionValidationUnavailable: true }),
      { headers: { "Set-Cookie": "next-auth.session-token=rolled; Path=/" } },
    )

    const result = await hardenSessionEndpointResponse(source, {
      allowCookieWrite: true,
    })

    expect(result.status).toBe(503)
    expect(result.headers.get("set-cookie")).toBeNull()
    expect(result.headers.get("cache-control")).toContain("no-store")
  })
})
