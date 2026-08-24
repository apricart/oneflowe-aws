import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  verifyPassword: vi.fn(),
  bcryptCompare: vi.fn(),
  verifyOTP: vi.fn(),
  clearDailyCount: vi.fn(),
  evaluateNetworkAccess: vi.fn(),
  resolveRequestClientIp: vi.fn(),
  recordAuthAuditEvent: vi.fn(),
  registerFailedLogin: vi.fn(),
  clearFailedLogins: vi.fn(),
}))

vi.mock("@/lib/server/env", () => ({
  env: { NODE_ENV: "test", NEXTAUTH_SECRET: "n".repeat(48) },
}))
vi.mock("@/lib/db", () => ({ db: { select: mocks.dbSelect } }))
vi.mock("@/lib/password", () => ({ verifyPassword: mocks.verifyPassword }))
vi.mock("@/lib/server/password-hasher", () => ({ bcryptCompare: mocks.bcryptCompare }))
vi.mock("@/lib/mfa", () => ({
  verifyOTP: mocks.verifyOTP,
  clearDailyCount: mocks.clearDailyCount,
}))
vi.mock("@/lib/session-validation-cache", () => ({
  getSessionValidationCache: vi.fn(),
  setSessionValidationCache: vi.fn(),
}))
vi.mock("@/lib/server/session-policy", () => ({
  resolveSessionIdleTimeoutMinutes: vi.fn().mockResolvedValue(10),
}))
vi.mock("@/lib/server/auth-session-store", () => ({
  createAuthSessionRecord: vi.fn(),
  revokeAuthSessionFromToken: vi.fn(),
  validateAuthSessionRecord: vi.fn(),
  advanceAuthSessionRecord: vi.fn(),
}))
vi.mock("@/lib/server/network-policy", () => ({
  evaluateNetworkAccess: mocks.evaluateNetworkAccess,
}))
vi.mock("@/lib/server/request-ip", () => ({
  resolveRequestClientIp: mocks.resolveRequestClientIp,
}))
vi.mock("@/lib/server/auth-audit", () => ({
  recordAuthAuditEvent: mocks.recordAuthAuditEvent,
}))
// The lockout decision is the real pure implementation; only the two database
// writers are stubbed, so these tests exercise the rule that actually ships.
vi.mock("@/lib/server/auth-lockout", async () => {
  const policy = await vi.importActual<typeof import("@/lib/auth-lockout-policy")>(
    "@/lib/auth-lockout-policy",
  )
  return {
    ...policy,
    registerFailedLogin: mocks.registerFailedLogin,
    clearFailedLogins: mocks.clearFailedLogins,
  }
})

import { authOptions } from "@/lib/auth-options"

type Provider = {
  id?: string
  authorize: (c: any) => Promise<any>
  // next-auth v4 keeps the supplied config here and stubs a default
  // `authorize` on the provider itself, so the real one must be read from
  // `options` rather than the top level.
  options?: { authorize: (c: any) => Promise<any> }
}

const providers = authOptions.providers as unknown as Provider[]

function authorizeOf(index: number) {
  const provider = providers[index]
  const authorize = provider.options?.authorize ?? provider.authorize
  return (credentials: any) => authorize(credentials)
}

const staffLogin = authorizeOf(0)
const staffMfaLogin = authorizeOf(1)
const employeeLogin = authorizeOf(2)

/**
 * The providers await some queries at `.where(...)` and others at `.limit(1)`,
 * so the chain resolves one queued result per await regardless of shape.
 */
function queueQueryResults(...results: unknown[][]) {
  const queue = [...results]
  const chain: any = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: () => chain,
    then: (resolve: (value: unknown) => void) => resolve(queue.shift() ?? []),
  }
  mocks.dbSelect.mockReturnValue(chain)
}

function staffRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    username: "jrivera",
    email: "jrivera@example.test",
    hash: "$2a$12$storedhash",
    roleId: 3,
    organizationId: 17,
    branchId: null,
    fullName: "J Rivera",
    mfaEnabled: false,
    isActive: true,
    sessionVersion: 4,
    mustChangePassword: false,
    failedLoginAttempts: 0,
    lockoutUntil: null,
    // Resolved by the same query as the account, via the tenant/role joins.
    organizationStatus: "active",
    branchStatus: null,
    roleName: "HEAD_OFFICE",
    ...overrides,
  }
}

/**
 * The employee lookup joins its tenant scope, so the provider reads the
 * account from the `employee` key of a single joined row.
 */
function employeeRow(overrides: Record<string, unknown> = {}) {
  return {
    organizationStatus: "active",
    branchStatus: "active",
    employee: {
      id: 42,
      username: "shopfloor",
      email: "shopfloor@example.test",
      passwordHash: "$2a$12$storedhash",
      firstName: "Sam",
      lastName: "Okafor",
      mfaEnabled: false,
      mfaSecret: null,
      isActive: true,
      organizationId: 17,
      branchId: 5,
      sessionVersion: 2,
      failedLoginAttempts: 0,
      lockoutUntil: null,
      ...overrides,
    },
  }
}

/** All audit events recorded during the attempt, in order. */
function auditedEvents() {
  return mocks.recordAuthAuditEvent.mock.calls.map(([event]) => event)
}

function auditedActions() {
  return auditedEvents().map((event) => event.action)
}

const CREDENTIALS = { username: "jrivera", password: "correct horse battery" }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.evaluateNetworkAccess.mockResolvedValue("allowed")
  mocks.resolveRequestClientIp.mockResolvedValue("203.0.113.7")
  mocks.recordAuthAuditEvent.mockResolvedValue(undefined)
  mocks.clearFailedLogins.mockResolvedValue(true)
  mocks.clearDailyCount.mockResolvedValue(undefined)
  mocks.registerFailedLogin.mockResolvedValue({
    lockedNow: false,
    lockoutUntil: null,
    attempts: 1,
    threshold: 5,
  })
})

describe("authentication audit trail", () => {
  it("records a successful sign-in with the resolved principal and tenant", async () => {
    queueQueryResults([staffRow()])
    mocks.verifyPassword.mockResolvedValue(true)

    const principal = await staffLogin(CREDENTIALS)

    expect(principal).toMatchObject({ id: "user-1", role: "HEAD_OFFICE" })
    expect(auditedEvents()).toEqual([
      expect.objectContaining({
        action: "AUTH_LOGIN_SUCCESS",
        success: true,
        subjectId: "user-1",
        email: "jrivera@example.test",
        role: "HEAD_OFFICE",
        organizationId: 17,
        provider: "credentials",
        attemptedIdentifier: "jrivera",
      }),
    ])
  })

  it("records an unmatched username without touching the lockout counters", async () => {
    queueQueryResults([])

    await expect(staffLogin(CREDENTIALS)).resolves.toBeNull()

    expect(auditedEvents()).toEqual([
      expect.objectContaining({
        action: "AUTH_LOGIN_FAILURE",
        success: false,
        reason: "unknown_account",
        subjectId: null,
        attemptedIdentifier: "jrivera",
      }),
    ])
    expect(mocks.registerFailedLogin).not.toHaveBeenCalled()
  })

  it("records a wrong password and keeps the CredentialsSignin contract", async () => {
    queueQueryResults([staffRow()])
    mocks.verifyPassword.mockResolvedValue(false)

    // Returning null is what NextAuth turns into CredentialsSignin, which the
    // sign-in page relies on to try the employee provider next.
    await expect(staffLogin(CREDENTIALS)).resolves.toBeNull()

    expect(auditedEvents()).toEqual([
      expect.objectContaining({
        action: "AUTH_LOGIN_FAILURE",
        reason: "invalid_password",
        subjectId: "user-1",
        success: false,
      }),
    ])
  })

  it("classifies a deactivated account rather than reporting a bad password", async () => {
    queueQueryResults([staffRow({ isActive: false })])
    mocks.verifyPassword.mockResolvedValue(true)

    await expect(staffLogin(CREDENTIALS)).rejects.toThrow("USER_INACTIVE")

    expect(auditedEvents()).toEqual([
      expect.objectContaining({
        action: "AUTH_LOGIN_FAILURE",
        reason: "user_inactive",
        subjectId: "user-1",
      }),
    ])
  })

  it("records a blocked tenant network as its own reason", async () => {
    queueQueryResults([staffRow()])
    mocks.verifyPassword.mockResolvedValue(true)
    mocks.evaluateNetworkAccess.mockResolvedValue("denied")

    await expect(staffLogin(CREDENTIALS)).rejects.toThrow("NETWORK_RESTRICTED")

    expect(auditedEvents()).toEqual([
      expect.objectContaining({ reason: "network_restricted", success: false }),
    ])
  })

  it("treats a pending OTP as an MFA challenge, not a failed login", async () => {
    queueQueryResults([staffRow({ mfaEnabled: true })])
    mocks.verifyPassword.mockResolvedValue(true)

    await expect(staffLogin(CREDENTIALS)).rejects.toThrow("MFA_REQUIRED")

    expect(auditedEvents()).toEqual([
      expect.objectContaining({
        action: "AUTH_MFA_CHALLENGE",
        reason: "mfa_required",
        subjectId: "user-1",
      }),
    ])
  })

  it("distinguishes an account with no MFA enrolment from an unknown one", async () => {
    queueQueryResults([staffRow({ mfaEnabled: false })])
    mocks.verifyPassword.mockResolvedValue(true)

    await expect(
      staffMfaLogin({ ...CREDENTIALS, otp: "123456" }),
    ).resolves.toBeNull()

    expect(auditedEvents()).toEqual([
      expect.objectContaining({
        action: "AUTH_LOGIN_FAILURE",
        reason: "mfa_not_enrolled",
        subjectId: "user-1",
      }),
    ])
    expect(mocks.verifyOTP).not.toHaveBeenCalled()
  })

  it("never passes the submitted password into an audit event", async () => {
    queueQueryResults([staffRow()])
    mocks.verifyPassword.mockResolvedValue(false)

    await staffLogin(CREDENTIALS)

    const serialized = JSON.stringify(auditedEvents())
    expect(serialized).not.toContain(CREDENTIALS.password)
    expect(serialized).toContain("jrivera")
  })
})

describe("account lockout", () => {
  it("refuses a locked account before the password is ever verified", async () => {
    queueQueryResults([
      staffRow({ lockoutUntil: new Date(Date.now() + 15 * 60_000) }),
    ])

    await expect(staffLogin(CREDENTIALS)).rejects.toThrow("ACCOUNT_LOCKED")

    // The whole point of checking first: a locked account must not reveal
    // whether the supplied password was correct.
    expect(mocks.verifyPassword).not.toHaveBeenCalled()
    expect(auditedEvents()).toEqual([
      expect.objectContaining({
        action: "AUTH_LOCKOUT_BLOCKED",
        reason: "account_locked",
        subjectId: "user-1",
      }),
    ])
  })

  it("lets an expired lockout through to a normal password check", async () => {
    queueQueryResults([staffRow({ lockoutUntil: new Date(Date.now() - 1_000) })])
    mocks.verifyPassword.mockResolvedValue(true)

    await expect(staffLogin(CREDENTIALS)).resolves.toMatchObject({ id: "user-1" })
    expect(auditedActions()).toEqual(["AUTH_LOGIN_SUCCESS"])
  })

  it("counts the failure against the account, not the client address", async () => {
    queueQueryResults([staffRow()])
    mocks.verifyPassword.mockResolvedValue(false)

    await staffLogin(CREDENTIALS)

    expect(mocks.registerFailedLogin).toHaveBeenCalledWith({
      kind: "user",
      id: "user-1",
    })
  })

  it("locks and reports the threshold crossing on the deciding attempt", async () => {
    queueQueryResults([staffRow({ failedLoginAttempts: 4 })])
    mocks.verifyPassword.mockResolvedValue(false)
    const lockoutUntil = new Date(Date.now() + 30 * 60_000)
    mocks.registerFailedLogin.mockResolvedValue({
      lockedNow: true,
      lockoutUntil,
      attempts: 0,
      threshold: 5,
    })

    await expect(staffLogin(CREDENTIALS)).rejects.toThrow("ACCOUNT_LOCKED")

    expect(auditedActions()).toEqual(["AUTH_LOGIN_FAILURE", "AUTH_ACCOUNT_LOCKED"])
    expect(auditedEvents()[1]).toMatchObject({
      details: { lockoutUntil: lockoutUntil.toISOString(), threshold: 5 },
    })
  })

  it("clears the counters once an authentication completes", async () => {
    queueQueryResults([staffRow({ failedLoginAttempts: 3 })])
    mocks.verifyPassword.mockResolvedValue(true)

    await staffLogin(CREDENTIALS)

    expect(mocks.clearFailedLogins).toHaveBeenCalledWith({ kind: "user", id: "user-1" })
  })

  it("does not clear the counters when the login stops at the MFA challenge", async () => {
    queueQueryResults([staffRow({ mfaEnabled: true })])
    mocks.verifyPassword.mockResolvedValue(true)

    await expect(staffLogin(CREDENTIALS)).rejects.toThrow("MFA_REQUIRED")

    expect(mocks.clearFailedLogins).not.toHaveBeenCalled()
  })

  it("counts a rejected OTP against the same account budget", async () => {
    queueQueryResults([staffRow({ mfaEnabled: true })])
    mocks.verifyPassword.mockResolvedValue(true)
    mocks.verifyOTP.mockResolvedValue({ success: false, message: "Invalid code" })

    await expect(
      staffMfaLogin({ ...CREDENTIALS, otp: "000000" }),
    ).rejects.toThrow("Invalid code")

    expect(mocks.registerFailedLogin).toHaveBeenCalledWith({ kind: "user", id: "user-1" })
    expect(auditedActions()).toEqual(["AUTH_MFA_FAILURE"])
  })

  it("locks the account when repeated OTP failures cross the threshold", async () => {
    queueQueryResults([staffRow({ mfaEnabled: true })])
    mocks.verifyPassword.mockResolvedValue(true)
    mocks.verifyOTP.mockResolvedValue({ success: false, message: "Invalid code" })
    mocks.registerFailedLogin.mockResolvedValue({
      lockedNow: true,
      lockoutUntil: new Date(Date.now() + 30 * 60_000),
      attempts: 0,
      threshold: 5,
    })

    // The lockout supersedes the MFA module's own message.
    await expect(
      staffMfaLogin({ ...CREDENTIALS, otp: "000000" }),
    ).rejects.toThrow("ACCOUNT_LOCKED")

    expect(auditedActions()).toEqual(["AUTH_MFA_FAILURE", "AUTH_ACCOUNT_LOCKED"])
  })

  it("applies the same lockout to employee portal accounts", async () => {
    queueQueryResults([employeeRow()])
    mocks.bcryptCompare.mockResolvedValue(false)

    await expect(
      employeeLogin({ username: "shopfloor", password: "wrong" }),
    ).resolves.toBeNull()

    expect(mocks.registerFailedLogin).toHaveBeenCalledWith({ kind: "employee", id: 42 })
    expect(auditedEvents()).toEqual([
      expect.objectContaining({
        action: "AUTH_LOGIN_FAILURE",
        reason: "invalid_password",
        subjectId: "emp_42",
        role: "EMPLOYEE",
        provider: "employee-credentials",
      }),
    ])
  })

  it("refuses a locked employee account before verifying its password", async () => {
    queueQueryResults([
      employeeRow({ lockoutUntil: new Date(Date.now() + 5 * 60_000) }),
    ])

    await expect(
      employeeLogin({ username: "shopfloor", password: "irrelevant" }),
    ).rejects.toThrow("ACCOUNT_LOCKED")

    expect(mocks.bcryptCompare).not.toHaveBeenCalled()
    expect(auditedActions()).toEqual(["AUTH_LOCKOUT_BLOCKED"])
  })
})
