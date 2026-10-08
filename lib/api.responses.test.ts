import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getSharedServerSession: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
  getSharedServerSession: mocks.getSharedServerSession,
}))

import { error, ok, okCached, parsePaginationParams, readJson, requireApiRole } from "@/lib/api"
import { isValidRole as rbacIsValidRole } from "@/lib/rbac"

/**
 * The shared response helpers every route handler returns through. The two
 * properties with security weight are that a 5xx never carries the caller's
 * message to the client, and that `requireApiRole` answers 401 / 403 / 503 for
 * exactly the right reasons and in the right order.
 */

beforeEach(() => {
  mocks.getCurrentUser.mockReset()
  mocks.getSharedServerSession.mockReset()
  mocks.getSharedServerSession.mockResolvedValue({ user: {} })
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("ok / okCached", () => {
  it("serialises data, turning undefined into null", async () => {
    expect(await ok({ a: 1 }).json()).toEqual({ a: 1 })
    expect(await ok(undefined).json()).toBeNull()
    expect(ok({}, { status: 201 }).status).toBe(201)
  })

  it("caches for the requested window, bounded to a year", () => {
    expect(okCached({}, 60).headers.get("Cache-Control")).toBe("public, max-age=60, stale-while-revalidate=600")
    expect(okCached({}, 0).headers.get("Cache-Control")).toContain("max-age=30")
    expect(okCached({}, 31_536_001).headers.get("Cache-Control")).toContain("max-age=30")
  })
})

describe("error", () => {
  it("passes a client error message through with its status", async () => {
    const response = error("Branch not found", 404)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Branch not found" })
  })

  it("never exposes a 5xx message", async () => {
    const response = error('relation "users" does not exist', 500)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "An unexpected error occurred. Please try again later." })
    expect(await error("x", 503).json()).toEqual({ error: "An unexpected error occurred. Please try again later." })
  })

  it("defaults a missing message and an out-of-range status", async () => {
    expect(await error("").json()).toEqual({ error: "An error occurred" })
    expect(error("x", 200).status).toBe(400)
    expect(error("x", 600).status).toBe(400)
    expect(error("x").status).toBe(400)
  })
})

describe("readJson", () => {
  const post = (body: string | null, contentType = "application/json") =>
    new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    })

  it("parses a JSON body", async () => {
    expect(await readJson(post('{"a":1}'))).toEqual({ a: 1 })
  })

  it("returns null for no body, invalid JSON, or an empty body", async () => {
    expect(await readJson(new Request("http://localhost/x"))).toBeNull()
    expect(await readJson(post("{not json"))).toBeNull()
    expect(await readJson(post(""))).toBeNull()
  })

  it("still parses JSON sent with another content type", async () => {
    expect(await readJson(post('[1,2]', "text/plain"))).toEqual([1, 2])
  })
})

describe("requireApiRole", () => {
  const user = (role: string, extra: Record<string, unknown> = {}) => ({
    id: "u1",
    email: "u@example.test",
    role,
    mustChangePassword: false,
    ...extra,
  })

  it("allows a caller whose role is listed", async () => {
    mocks.getCurrentUser.mockResolvedValue(user("HEAD_OFFICE"))
    expect(await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])).toBeNull()
  })

  it("answers 401 with no user", async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    const response = await requireApiRole(["SUPER_ADMIN"])
    expect(response?.status).toBe(401)
  })

  it("answers 403 for a role that is not listed", async () => {
    mocks.getCurrentUser.mockResolvedValue(user("ORDER_PORTAL"))
    const response = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
    expect(response?.status).toBe(403)
    expect(await response?.json()).toEqual({ error: "Forbidden", message: "Insufficient permissions" })
  })

  it("blocks even an allowed role while a password change is pending", async () => {
    mocks.getCurrentUser.mockResolvedValue(user("SUPER_ADMIN", { mustChangePassword: true }))
    const response = await requireApiRole(["SUPER_ADMIN"])
    expect(response?.status).toBe(403)
    expect(await response?.json()).toMatchObject({ message: "Password change required" })
  })

  it("refuses a user whose stored role is not a known role", async () => {
    mocks.getCurrentUser.mockResolvedValue(user("ROOT"))
    expect((await requireApiRole(["SUPER_ADMIN"]))?.status).toBe(403)
  })

  it("answers 500 for a route configured with no roles or an unknown role, before reading the session", async () => {
    expect((await requireApiRole([]))?.status).toBe(500)
    expect((await requireApiRole(["ROOT" as never]))?.status).toBe(500)
    expect(mocks.getSharedServerSession).not.toHaveBeenCalled()
  })

  it("answers 500 rather than allowing when the user lookup throws", async () => {
    mocks.getCurrentUser.mockRejectedValue(new Error("db down"))
    expect((await requireApiRole(["SUPER_ADMIN"]))?.status).toBe(500)
  })
})

describe("parsePaginationParams", () => {
  const parse = (query: string) => parsePaginationParams(new URLSearchParams(query))

  it("defaults to page 1 of 20", () => {
    expect(parse("")).toEqual({ page: 1, limit: 20, offset: 0 })
  })

  it("computes the offset", () => {
    expect(parse("page=3&limit=25")).toEqual({ page: 3, limit: 25, offset: 50 })
  })

  it("caps the limit at 100 and the page at 10000", () => {
    expect(parse("limit=5000").limit).toBe(100)
    expect(parse("page=999999").page).toBe(10_000)
  })

  it("ignores zero, negative and non-numeric values", () => {
    expect(parse("page=0&limit=-5")).toEqual({ page: 1, limit: 20, offset: 0 })
    expect(parse("page=abc&limit=xyz")).toEqual({ page: 1, limit: 20, offset: 0 })
  })
})

describe("role lists", () => {
  // `lib/auth.ts` keeps its own copy of the role list, and its fallback grants
  // BRANCH_ADMIN to anything it does not recognise. The two must not drift.
  it("agree between lib/auth and lib/rbac for every role and for unknown values", async () => {
    const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth")
    const roles = [
      "SUPER_ADMIN", "HEAD_OFFICE", "GROUP_USER", "BRANCH_ADMIN",
      "GROUP_ORDER_PORTAL", "ORDER_PORTAL", "VIEWER", "ORDER_DESK",
      "ROOT", "", "super_admin",
    ]
    for (const role of roles) {
      expect(actual.isValidRole(role), role).toBe(rbacIsValidRole(role))
    }
  })
})
