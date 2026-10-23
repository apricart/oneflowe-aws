import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The Ordering Blocks list handler: Head Office only, its organization from
 * the session, a bounded and allowlisted query. What it reads is in
 * `tests/integration/ordering-block-branches-api.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  currentRole: null as string | null,
  getRequestScope: vi.fn(),
  loadOrderingBlockBranches: vi.fn(),
  logError: vi.fn(),
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    requireApiRole: vi.fn(async (allowed: string[]) => {
      if (!mocks.currentRole) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      if (!allowed.includes(mocks.currentRole)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      return null
    }),
  }
})
vi.mock("@/lib/auth", () => ({ getRequestScope: mocks.getRequestScope }))
vi.mock("@/lib/global-logger", () => ({ logError: mocks.logError }))
vi.mock("@/lib/db", () => ({ db: { tag: "db" } }))
vi.mock("@/lib/server/ordering-block-branches", () => ({ loadOrderingBlockBranches: mocks.loadOrderingBlockBranches }))

import { GET } from "./route"

const HO_USER = "3b1a6a3e-1111-4c7b-9a2e-000000000001"

function signIn(role: string | null, scope: Partial<{ organizationId: number | null }> = {}) {
  mocks.currentRole = role
  mocks.getRequestScope.mockResolvedValue(role ? { role, userId: HO_USER, organizationId: 10, branchId: null, ...scope } : null)
}

const get = (query = "") => GET(new NextRequest(`http://localhost/api/v1/payment-control/branches${query}`))

beforeEach(() => {
  mocks.getRequestScope.mockReset()
  mocks.logError.mockReset()
  mocks.loadOrderingBlockBranches.mockReset().mockResolvedValue({ enabled: false })
  signIn("HEAD_OFFICE")
})

describe("GET /api/v1/payment-control/branches — who may ask", () => {
  it("refuses without a session", async () => {
    signIn(null)
    expect((await get()).status).toBe(401)
    expect(mocks.loadOrderingBlockBranches).not.toHaveBeenCalled()
  })

  it.each(["SUPER_ADMIN", "VIEWER", "BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "GROUP_ORDER_PORTAL", "WAREHOUSE", "ORDER_DESK", "APRICART_EXECUTIVE", "APRICART_SUPPORT"])(
    "refuses %s with 403",
    async (role) => {
      signIn(role)
      expect((await get()).status).toBe(403)
      expect(mocks.loadOrderingBlockBranches).not.toHaveBeenCalled()
    },
  )

  it("Head Office with no organization on its account cannot read", async () => {
    signIn("HEAD_OFFICE", { organizationId: null })
    expect((await get()).status).toBe(400)
    expect(mocks.loadOrderingBlockBranches).not.toHaveBeenCalled()
  })
})

describe("GET /api/v1/payment-control/branches — the query", () => {
  it.each([
    ["an organization", "?organizationId=2", "Unknown field: organizationId"],
    ["a branch", "?branchId=5", "Unknown field: branchId"],
    ["an unknown filter", "?filter=everything", undefined],
    ["an oversized page", "?pageSize=1000", undefined],
  ])("refuses %s with 400, reading nothing", async (_label, query, message) => {
    const response = await get(query)
    expect(response.status).toBe(400)
    if (message) await expect(response.json()).resolves.toEqual({ error: message })
    expect(mocks.loadOrderingBlockBranches).not.toHaveBeenCalled()
  })

  it("reads the session's organization with the parsed query", async () => {
    await get("?filter=blocked&search=north&page=2&pageSize=10")
    expect(mocks.loadOrderingBlockBranches).toHaveBeenCalledWith({ tag: "db" }, {
      organizationId: 10,
      query: { filter: "blocked", search: "north", page: 2, pageSize: 10 },
      now: expect.any(Date),
    })
  })
})

describe("GET /api/v1/payment-control/branches — the answer", () => {
  it("passes the loader's view through, never cached by a shared cache", async () => {
    const view = { enabled: true, threshold: 2, summary: { branches: 1, blocked: 1, exceptionActive: 0, lastOrder: 0 }, items: [], total: 0, page: 1, pageSize: 25 }
    mocks.loadOrderingBlockBranches.mockResolvedValue(view)
    const response = await get()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(view)
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0")
  })

  it("answers `enabled: false` for an organization that does not block", async () => {
    await expect((await get()).json()).resolves.toEqual({ enabled: false })
  })

  it("an unexpected failure is a generic 500 with the detail logged", async () => {
    mocks.loadOrderingBlockBranches.mockRejectedValue(new Error("relation branches does not exist"))
    const response = await get()
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.not.toMatchObject({ error: expect.stringContaining("relation") })
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(Error), "PAYMENT_CONTROL_BRANCH_LIST")
  })
})
