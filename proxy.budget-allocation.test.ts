import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({ getToken: vi.fn(), logger: vi.fn() }))
vi.mock("next-auth/jwt", () => ({ getToken: mocks.getToken }))
vi.mock("@/lib/edge/env", () => ({ edgeEnv: { NEXTAUTH_SECRET: "n".repeat(48) } }))
vi.mock("@/lib/utils", () => ({ logger: mocks.logger }))

import { proxy } from "@/proxy"

const NOW = 2_000_000_000_000
const token = (budgetAllocationEnabled?: unknown) => ({
  sub: "group-user-1",
  role: "GROUP_USER",
  organizationId: 17,
  branchId: null,
  budgetAllocationEnabled,
  sessionPolicyVersion: 1,
  sessionStartedAt: NOW - 60_000,
  sessionLastActivityAt: NOW - 1_000,
  sessionIdleTimeoutMinutes: 15,
  sessionAbsoluteExpiresAt: NOW + 7 * 60 * 60_000,
})

describe("Group User budget page gate", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW))
  afterEach(() => {
    vi.restoreAllMocks()
    mocks.getToken.mockReset()
  })

  it.each([undefined, false, "true"])("redirects a Group User with claim %s", async (claim) => {
    mocks.getToken.mockResolvedValue(token(claim))
    const response = await proxy(new NextRequest("https://app.test/budgets"))
    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("https://app.test/dashboard")
  })

  it("allows an explicitly enabled Group User through to the server page gate", async () => {
    mocks.getToken.mockResolvedValue(token(true))
    const response = await proxy(new NextRequest("https://app.test/budgets"))
    expect(response.status).toBe(200)
  })
})
