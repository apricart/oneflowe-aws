import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  getSessionValidationCache: vi.fn(),
  setSessionValidationCache: vi.fn(),
  resolveSessionIdleTimeoutMinutes: vi.fn(),
  createAuthSessionRecord: vi.fn(),
  revokeAuthSessionFromToken: vi.fn(),
  validateAuthSessionRecord: vi.fn(),
  advanceAuthSessionRecord: vi.fn(),
  evaluateNetworkAccess: vi.fn(),
  resolveRequestClientIp: vi.fn(),
}))

vi.mock("@/lib/server/env", () => ({
  env: {
    NODE_ENV: "test",
    NEXTAUTH_SECRET: "n".repeat(48),
  },
}))

vi.mock("@/lib/db", () => ({
  db: { select: mocks.dbSelect },
}))

vi.mock("@/lib/password", () => ({ verifyPassword: vi.fn() }))
vi.mock("@/lib/mfa", () => ({
  verifyOTP: vi.fn(),
  clearDailyCount: vi.fn(),
}))
vi.mock("bcryptjs", () => ({ compare: vi.fn() }))
vi.mock("@/lib/session-validation-cache", () => ({
  getSessionValidationCache: mocks.getSessionValidationCache,
  setSessionValidationCache: mocks.setSessionValidationCache,
}))
vi.mock("@/lib/server/session-policy", () => ({
  resolveSessionIdleTimeoutMinutes: mocks.resolveSessionIdleTimeoutMinutes,
}))
vi.mock("@/lib/server/auth-session-store", () => ({
  createAuthSessionRecord: mocks.createAuthSessionRecord,
  revokeAuthSessionFromToken: mocks.revokeAuthSessionFromToken,
  validateAuthSessionRecord: mocks.validateAuthSessionRecord,
  advanceAuthSessionRecord: mocks.advanceAuthSessionRecord,
}))
vi.mock("@/lib/server/network-policy", () => ({
  evaluateNetworkAccess: mocks.evaluateNetworkAccess,
}))
vi.mock("@/lib/server/request-ip", () => ({
  resolveRequestClientIp: mocks.resolveRequestClientIp,
}))

import { authOptions } from "@/lib/auth-options"
import {
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_ACTIVITY_UPDATE_MARKER,
} from "@/lib/session-policy"

const START = 2_000_000_000_000
const MINUTE = 60_000
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000"
let registryLastActivityAt = START

const jwtCallback = authOptions.callbacks?.jwt as any
const sessionCallback = authOptions.callbacks?.session as any

function userToken() {
  return {
    sub: "user-1",
    email: "user@example.test",
    role: "HEAD_OFFICE",
    organizationId: 17,
    branchId: null,
    fullName: "Test User",
    username: "test-user",
    isEmployee: false,
    sessionVersion: 7,
    mustChangePassword: false,
    sessionId: SESSION_ID,
    sessionRegistryStatus: "valid",
  }
}

function mockSessionDbRow(row: Record<string, unknown>) {
  const chain: any = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn().mockResolvedValue([row]),
  }
  mocks.dbSelect.mockReturnValue(chain)
  return chain
}

describe("auth session policy callbacks", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.dbSelect.mockReset()
    mocks.setSessionValidationCache.mockReset()
    mocks.resolveSessionIdleTimeoutMinutes.mockReset().mockResolvedValue(10)
    mocks.createAuthSessionRecord.mockReset().mockResolvedValue(undefined)
    mocks.revokeAuthSessionFromToken.mockReset().mockResolvedValue(undefined)
    registryLastActivityAt = START
    mocks.validateAuthSessionRecord.mockReset().mockImplementation(
      async (identity: any, idleTimeoutMinutes: number) => ({
        kind: "valid",
        claims: {
          sessionPolicyVersion: 1,
          sessionStartedAt: identity.sessionStartedAt,
          sessionLastActivityAt: registryLastActivityAt,
          sessionIdleTimeoutMinutes: idleTimeoutMinutes,
          sessionAbsoluteExpiresAt: identity.sessionAbsoluteExpiresAt,
        },
      }),
    )
    mocks.advanceAuthSessionRecord.mockReset().mockImplementation(
      async (identity: any, idleTimeoutMinutes: number) => {
        registryLastActivityAt = Date.now()
        return {
          kind: "valid",
          claims: {
            sessionPolicyVersion: 1,
            sessionStartedAt: identity.sessionStartedAt,
            sessionLastActivityAt: registryLastActivityAt,
            sessionIdleTimeoutMinutes: idleTimeoutMinutes,
            sessionAbsoluteExpiresAt: identity.sessionAbsoluteExpiresAt,
          },
        }
      },
    )
    mocks.getSessionValidationCache.mockReset().mockResolvedValue({
      sv: 7,
      org: 17,
      br: null,
      role: "HEAD_OFFICE",
    })
    mocks.evaluateNetworkAccess.mockReset().mockResolvedValue("allowed")
    mocks.resolveRequestClientIp.mockReset().mockResolvedValue("203.0.113.10")
  })

  it("issues and registers a bounded policy for a newly authenticated user", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START)

    const token = await jwtCallback({
      token: { sub: "user-1" },
      user: userToken(),
    })

    expect(token.sessionStartedAt).toBe(START)
    expect(token.sessionLastActivityAt).toBe(START)
    expect(token.sessionAbsoluteExpiresAt).toBe(
      START + SESSION_ABSOLUTE_TIMEOUT_MS,
    )
    expect(token.sessionIdleTimeoutMinutes).toBe(10)
    expect(token.role).toBe("HEAD_OFFICE")
    expect(token.organizationId).toBe(17)
    expect(token.sessionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(mocks.createAuthSessionRecord).toHaveBeenCalledWith({
      sessionId: token.sessionId,
      subjectId: "user-1",
      organizationId: 17,
      claims: expect.objectContaining({
        sessionStartedAt: START,
        sessionIdleTimeoutMinutes: 10,
      }),
    })
  })

  it("uses the same registered policy for an employee principal", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START)
    const employee = {
      ...userToken(),
      id: "emp_42",
      role: "EMPLOYEE",
      branchId: 3,
      isEmployee: true,
      employeeId: 42,
    }

    const token = await jwtCallback({
      token: { sub: "emp_42" },
      user: employee,
    })

    expect(token.sessionStartedAt).toBe(START)
    expect(token.sessionAbsoluteExpiresAt).toBe(
      START + SESSION_ABSOLUTE_TIMEOUT_MS,
    )
    expect(mocks.createAuthSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: "emp_42",
        organizationId: 17,
      }),
    )
  })

  it("does not advance policy timestamps during passive polling", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const next = await jwtCallback({ token })

    expect(next.sessionStartedAt).toBe(START)
    expect(next.sessionLastActivityAt).toBe(START)
    expect(next.sessionAbsoluteExpiresAt).toBe(
      START + SESSION_ABSOLUTE_TIMEOUT_MS,
    )
    expect(mocks.getSessionValidationCache).not.toHaveBeenCalled()
  })

  it("cannot revive an idle session when a tenant timeout is increased", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + 6 * MINUTE)
    mocks.resolveSessionIdleTimeoutMinutes.mockResolvedValue(15)
    mocks.validateAuthSessionRecord.mockResolvedValue({
      kind: "invalid",
      reason: "idle_timeout",
    })
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 5,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const next = await jwtCallback({ token })

    expect(mocks.validateAuthSessionRecord).toHaveBeenCalledWith(
      expect.any(Object),
      5,
      START + 6 * MINUTE,
    )
    expect(next.sessionInvalidReason).toBe("idle_timeout")
  })

  it("adopts an increased timeout only after activity passes the old deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + 4 * MINUTE)
    mocks.resolveSessionIdleTimeoutMinutes.mockResolvedValue(15)
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 5,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const next = await jwtCallback({
      token,
      trigger: "update",
      session: { activity: SESSION_ACTIVITY_UPDATE_MARKER },
    })

    expect(mocks.advanceAuthSessionRecord).toHaveBeenCalledWith(
      expect.any(Object),
      5,
      START + 4 * MINUTE,
    )
    expect(next.sessionLastActivityAt).toBe(START + 4 * MINUTE)
    expect(next.sessionIdleTimeoutMinutes).toBe(15)
  })

  it("advances activity with server time without accepting client claim changes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const next = await jwtCallback({
      token,
      trigger: "update",
      session: {
        activity: SESSION_ACTIVITY_UPDATE_MARKER,
        role: "SUPER_ADMIN",
        organizationId: 999,
        sessionStartedAt: 1,
      },
    })

    expect(next.sessionLastActivityAt).toBe(START + MINUTE)
    expect(next.sessionStartedAt).toBe(START)
    expect(next.sessionAbsoluteExpiresAt).toBe(
      START + SESSION_ABSOLUTE_TIMEOUT_MS,
    )
    expect(next.role).toBe("HEAD_OFFICE")
    expect(next.organizationId).toBe(17)
    expect(mocks.getSessionValidationCache).toHaveBeenCalledWith("user-1")
  })

  it("rejects an expired token before database validation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + 10 * MINUTE)
    mocks.getSessionValidationCache.mockClear()
    mocks.validateAuthSessionRecord.mockResolvedValue({
      kind: "invalid",
      reason: "idle_timeout",
    })
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const validatedToken = await jwtCallback({ token })
    const result = await sessionCallback({
      session: { user: {}, expires: "rolling" },
      token: validatedToken,
    })

    expect(result).toBeNull()
    expect(mocks.getSessionValidationCache).not.toHaveBeenCalled()
  })

  it("fails closed before policy checks can be bypassed by a missing session user", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const result = await sessionCallback({
      session: { expires: "rolling" },
      token,
    })

    expect(result).toBeNull()
    expect(mocks.getSessionValidationCache).not.toHaveBeenCalled()
  })

  it("returns the effective deadline while preserving role and tenant claims", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const result = await sessionCallback({
      session: {
        user: { email: "user@example.test" },
        expires: "rolling",
      },
      token,
    })

    expect(result.user.role).toBe("HEAD_OFFICE")
    expect(result.user.organizationId).toBe(17)
    expect(result.expires).toBe(new Date(START + 10 * MINUTE).toISOString())
    expect(result.idleTimeoutMinutes).toBe(10)
  })

  it("ends a live session that moved outside the tenant's allowed network", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    mocks.evaluateNetworkAccess.mockResolvedValue("denied")
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const result = await sessionCallback({
      session: { user: {}, expires: "rolling" },
      token,
    })

    expect(result).toBeNull()
    expect(mocks.revokeAuthSessionFromToken).toHaveBeenCalled()
    expect(mocks.evaluateNetworkAccess).toHaveBeenCalledWith({
      role: "HEAD_OFFICE",
      organizationId: 17,
      clientIp: "203.0.113.10",
    })
  })

  it("does not end a session when the network policy cannot be read", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    mocks.evaluateNetworkAccess.mockResolvedValue("unavailable")
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const result = await sessionCallback({
      session: { user: {}, expires: "rolling" },
      token,
    })

    expect(result).toEqual({ sessionValidationUnavailable: true })
    expect(mocks.revokeAuthSessionFromToken).not.toHaveBeenCalled()
  })

  it("does not renew the idle deadline for a session outside the allowed network", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.evaluateNetworkAccess.mockResolvedValue("denied")
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const next = await jwtCallback({
      token,
      trigger: "update",
      session: { activity: SESSION_ACTIVITY_UPDATE_MARKER },
    })

    expect(mocks.advanceAuthSessionRecord).not.toHaveBeenCalled()
    expect(next.sessionLastActivityAt).toBe(START)
    expect(next.sessionInvalidReason).toBe("invalid_policy")
    expect(mocks.revokeAuthSessionFromToken).toHaveBeenCalled()
  })

  it("leaves an unrestricted tenant's session untouched", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const result = await sessionCallback({
      session: { user: { email: "user@example.test" }, expires: "rolling" },
      token,
    })

    expect(result.user.role).toBe("HEAD_OFFICE")
    expect(mocks.revokeAuthSessionFromToken).not.toHaveBeenCalled()
  })

  it("fails closed when identity validation cannot reach the database", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    mocks.getSessionValidationCache.mockResolvedValue(null)
    mocks.dbSelect.mockImplementation(() => {
      throw new Error("database unavailable")
    })
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const result = await sessionCallback({
      session: { user: {}, expires: "rolling" },
      token,
    })

    expect(result).toEqual({ sessionValidationUnavailable: true })
  })

  it("does not mint activity time when identity validation fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.getSessionValidationCache.mockResolvedValue(null)
    mocks.dbSelect.mockImplementation(() => {
      throw new Error("database unavailable")
    })
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const result = await jwtCallback({
      token,
      trigger: "update",
      session: { activity: SESSION_ACTIVITY_UPDATE_MARKER },
    })

    expect(result.sessionLastActivityAt).toBe(START)
    expect(mocks.resolveSessionIdleTimeoutMinutes).not.toHaveBeenCalled()
    expect(result.sessionRegistryStatus).toBe("unavailable")
    expect(mocks.advanceAuthSessionRecord).not.toHaveBeenCalled()
  })

  it("validates a normal user's current tenant, branch, role, and version from the database", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    mocks.getSessionValidationCache.mockResolvedValue(null)
    mockSessionDbRow({
      isActive: true,
      deletedAt: null,
      sessionVersion: 7,
      organizationId: 17,
      branchId: null,
      role: "HEAD_OFFICE",
      orgStatus: "active",
      branchStatus: null,
    })
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const result = await sessionCallback({
      session: { user: { email: token.email }, expires: "rolling" },
      token,
    })

    expect(result?.user?.role).toBe("HEAD_OFFICE")
    expect(mocks.setSessionValidationCache).toHaveBeenCalledWith("user-1", {
      sv: 7,
      org: 17,
      br: null,
      role: "HEAD_OFFICE",
    })
  })

  it("validates an employee subject through the employee assignment path", async () => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    mocks.getSessionValidationCache.mockResolvedValue(null)
    const chain = mockSessionDbRow({
      isActive: true,
      deletedAt: null,
      sessionVersion: 4,
      organizationId: 17,
      branchId: 3,
      role: "EMPLOYEE",
      orgStatus: "active",
      branchStatus: "active",
    })
    const token = {
      ...userToken(),
      sub: "emp_42",
      role: "EMPLOYEE",
      branchId: 3,
      isEmployee: true,
      employeeId: 42,
      sessionVersion: 4,
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const result = await sessionCallback({
      session: { user: { email: token.email }, expires: "rolling" },
      token,
    })

    expect(result?.user?.id).toBe("emp_42")
    expect(chain.leftJoin).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["organization", { organizationId: 99 }],
    ["branch", { branchId: 8 }],
    ["role", { role: "BRANCH_ADMIN" }],
  ])("rejects a current database %s mismatch", async (_name, mismatch) => {
    vi.spyOn(Date, "now").mockReturnValue(START + MINUTE)
    vi.spyOn(console, "log").mockImplementation(() => {})
    mocks.getSessionValidationCache.mockResolvedValue(null)
    mockSessionDbRow({
      isActive: true,
      deletedAt: null,
      sessionVersion: 7,
      organizationId: 17,
      branchId: null,
      role: "HEAD_OFFICE",
      orgStatus: "active",
      branchStatus: null,
      ...mismatch,
    })
    const token = {
      ...userToken(),
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    }

    const result = await sessionCallback({
      session: { user: { email: token.email }, expires: "rolling" },
      token,
    })

    expect(result).toBeNull()
    expect(mocks.revokeAuthSessionFromToken).toHaveBeenCalledWith(token)
    expect(mocks.setSessionValidationCache).not.toHaveBeenCalled()
  })
})
