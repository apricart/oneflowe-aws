import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuthAuditEvent } from "./auth-audit"

import { authSessions, users } from "@/db/schema"

/**
 * How `lib/mfa.ts`'s answers become the outcomes the send/verify handlers map
 * to statuses, and what each outcome leaves in the audit trail. The database
 * is a stub here — the row the subject query returns, and what the session
 * update finds — so the branches that are hard to reach against Postgres
 * (a cooldown, a transport failure, a session revoked between the code and
 * the proof) are exercised deterministically. The real proof-on-session
 * behaviour is covered in `tests/integration/password-rotation.test.ts`.
 */

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  /** What the subject lookup returns. */
  subjectRows: [] as Row[],
  /** What `update(auth_sessions) … returning` finds inside the transaction. */
  sessionRows: [] as Row[],
  /** Which tables the transaction updated, in order. */
  txUpdates: [] as string[],
}))

const mocks = vi.hoisted(() => ({
  generateAndSendOTP: vi.fn(),
  verifyOTP: vi.fn(),
  otpExpiryMinutes: vi.fn(() => 10),
  recordAuthAuditEvent: vi.fn(async (_event: AuthAuditEvent) => undefined),
}))

/** A thenable Drizzle-shaped chain: every builder method returns itself, `await` yields `rows`. */
function chain(rows: () => Row[]) {
  const link: Record<string, unknown> = {}
  for (const method of ["from", "leftJoin", "where", "limit", "set", "returning"]) {
    link[method] = vi.fn(() => link)
  }
  link.then = (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(rows()).then(resolve, reject)
  return link
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => chain(() => state.subjectRows),
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: (table: unknown) => {
          const name = table === authSessions ? "auth_sessions" : table === users ? "users" : "?"
          state.txUpdates.push(name)
          return chain(() => (table === authSessions ? state.sessionRows : []))
        },
      }
      return work(tx)
    },
  },
}))
vi.mock("@/lib/mfa", () => ({
  generateAndSendOTP: mocks.generateAndSendOTP,
  verifyOTP: mocks.verifyOTP,
  otpExpiryMinutes: mocks.otpExpiryMinutes,
}))
vi.mock("@/lib/server/auth-audit", () => ({ recordAuthAuditEvent: mocks.recordAuthAuditEvent }))

import {
  accountLabelForRole,
  confirmEmailVerificationCode,
  EMAIL_VERIFICATION_VALIDITY_SECONDS,
  sendEmailVerificationCode,
} from "./email-verification"

const USER_ID = "3b1a6a3e-1111-4c7b-9a2e-000000000001"
const SESSION_ID = "9d2f0c4a-2222-4d8e-8b3f-000000000002"

function subject(overrides: Partial<Row> = {}): Row {
  return {
    id: USER_ID,
    email: "imrank@ke.com.pk",
    username: "imran-17655-ba",
    role: "BRANCH_ADMIN",
    organizationId: 10,
    branchId: 77,
    ...overrides,
  }
}

const auditActions = () => mocks.recordAuthAuditEvent.mock.calls.map(([event]) => event.action)

beforeEach(() => {
  state.subjectRows = [subject()]
  state.sessionRows = [{ id: SESSION_ID }]
  state.txUpdates.length = 0
  mocks.generateAndSendOTP.mockReset().mockResolvedValue({ success: true, message: "sent" })
  mocks.verifyOTP.mockReset().mockResolvedValue({ success: true, message: "ok" })
  mocks.recordAuthAuditEvent.mockClear()
})

describe("accountLabelForRole — the words the mail uses for the account the code opens", () => {
  it.each([
    ["BRANCH_ADMIN", "Financial Approver"],
    ["ORDER_PORTAL", "Order Initiator"],
    ["HEAD_OFFICE", "Head Office"],
    ["GROUP_ORDER_PORTAL", "Group Order Initiator"],
    ["GROUP_USER", "Group Financial Approver"],
    ["SUPER_ADMIN", "Super Admin"],
  ])("names a %s account after its role template", (role, label) => {
    expect(accountLabelForRole(role)).toBe(label)
  })

  it("falls back to the raw role for one without a template, and to the product with no role", () => {
    expect(accountLabelForRole("AUDITOR")).toBe("AUDITOR")
    expect(accountLabelForRole(null)).toBe("OneFlowe")
  })
})

describe("sendEmailVerificationCode", () => {
  it("sends a VERIFY_EMAIL code to the address on the row, naming the account, and audits it", async () => {
    const outcome = await sendEmailVerificationCode(USER_ID)

    expect(outcome).toEqual({ kind: "sent", emailHint: "i***@ke.com.pk", validForMinutes: 10 })
    expect(mocks.generateAndSendOTP).toHaveBeenCalledWith(USER_ID, "imrank@ke.com.pk", "VERIFY_EMAIL", {
      username: "imran-17655-ba",
      accountLabel: "Financial Approver",
    })
    expect(auditActions()).toEqual(["AUTH_EMAIL_VERIFICATION_SENT"])
    expect(mocks.recordAuthAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      subjectId: USER_ID,
      organizationId: 10,
      branchId: 77,
      success: true,
    }))
  })

  it.each([
    "nadia.k@ke-legacy.invalid",
    "author@historical.invalid",
    "not-an-address",
  ])("never generates a code for %s — it would only lock the person out", async (email) => {
    state.subjectRows = [subject({ email, username: "nadia-1-op", role: "ORDER_PORTAL" })]

    const outcome = await sendEmailVerificationCode(USER_ID)

    expect(outcome.kind).toBe("unroutable")
    expect(mocks.generateAndSendOTP).not.toHaveBeenCalled()
    expect(auditActions()).toEqual(["AUTH_EMAIL_VERIFICATION_FAILURE"])
    expect(mocks.recordAuthAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "email_unroutable", success: false }))
  })

  it("masks the address in the unroutable outcome too", async () => {
    state.subjectRows = [subject({ email: "nadia.k@ke-legacy.invalid" })]

    expect(await sendEmailVerificationCode(USER_ID)).toEqual({ kind: "unroutable", emailHint: "n***@ke-legacy.invalid" })
  })

  it("passes a cooldown through as throttled, with when it ends, and audits nothing as sent", async () => {
    const cooldownUntil = new Date(Date.now() + 40_000)
    mocks.generateAndSendOTP.mockResolvedValue({ success: false, message: "Please wait 1 minute before requesting another OTP", cooldownUntil })

    const outcome = await sendEmailVerificationCode(USER_ID)

    expect(outcome).toEqual({ kind: "throttled", message: "Please wait 1 minute before requesting another OTP", cooldownUntil })
    expect(auditActions()).toEqual([])
  })

  it.each([
    "Daily OTP request limit exceeded. Please try again tomorrow.",
    "Failed to send OTP email. Please try again.",
    "Failed to save OTP. Please try again.",
  ])("passes any other refusal through as failed: %s", async (message) => {
    mocks.generateAndSendOTP.mockResolvedValue({ success: false, message })

    expect(await sendEmailVerificationCode(USER_ID)).toEqual({ kind: "failed", message })
    expect(auditActions()).toEqual([])
  })

  it("answers not_found for an account the subject query does not return (deleted, inactive, unknown)", async () => {
    state.subjectRows = []

    expect(await sendEmailVerificationCode(USER_ID)).toEqual({ kind: "not_found" })
    expect(mocks.generateAndSendOTP).not.toHaveBeenCalled()
    expect(auditActions()).toEqual([])
  })

  it("labels a Head Office account as such in the mail", async () => {
    state.subjectRows = [subject({ username: "head-1734549", role: "HEAD_OFFICE" })]

    await sendEmailVerificationCode(USER_ID)

    expect(mocks.generateAndSendOTP).toHaveBeenCalledWith(USER_ID, "imrank@ke.com.pk", "VERIFY_EMAIL", {
      username: "head-1734549",
      accountLabel: "Head Office",
    })
  })
})

describe("confirmEmailVerificationCode", () => {
  it("stamps the proof on the entering session and the account, and audits the verification", async () => {
    const outcome = await confirmEmailVerificationCode(USER_ID, SESSION_ID, "123456")

    expect(outcome).toEqual({ kind: "verified", validForSeconds: EMAIL_VERIFICATION_VALIDITY_SECONDS })
    expect(mocks.verifyOTP).toHaveBeenCalledWith(USER_ID, "123456", "VERIFY_EMAIL")
    expect(state.txUpdates).toEqual(["auth_sessions", "users"])
    expect(auditActions()).toEqual(["AUTH_EMAIL_VERIFIED"])
  })

  it("the proof lasts ten minutes", () => {
    expect(EMAIL_VERIFICATION_VALIDITY_SECONDS).toBe(600)
  })

  it("writes nothing for a wrong code, and reports the attempts left", async () => {
    mocks.verifyOTP.mockResolvedValue({ success: false, message: "Invalid OTP code", remainingAttempts: 2 })

    const outcome = await confirmEmailVerificationCode(USER_ID, SESSION_ID, "000000")

    expect(outcome).toEqual({ kind: "rejected", message: "Invalid OTP code", remainingAttempts: 2 })
    expect(state.txUpdates).toEqual([])
    expect(auditActions()).toEqual(["AUTH_EMAIL_VERIFICATION_FAILURE"])
    expect(mocks.recordAuthAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ reason: "mfa_invalid", errorMessage: "Invalid OTP code" }))
  })

  it("reports no attempt count when the module gives none (an expired code)", async () => {
    mocks.verifyOTP.mockResolvedValue({ success: false, message: "OTP has expired" })

    expect(await confirmEmailVerificationCode(USER_ID, SESSION_ID, "123456")).toEqual({
      kind: "rejected",
      message: "OTP has expired",
      remainingAttempts: null,
    })
  })

  it("marks the account as verified only if the session took the proof — a revoked session gets nothing", async () => {
    // The code was right, but the session row no longer matches (revoked, or
    // another person's): the session update finds no row, so the account is
    // not marked either and the caller learns the session is invalid.
    state.sessionRows = []

    const outcome = await confirmEmailVerificationCode(USER_ID, SESSION_ID, "123456")

    expect(outcome).toEqual({ kind: "session_invalid" })
    expect(state.txUpdates).toEqual(["auth_sessions"])
    expect(auditActions()).toEqual([])
  })

  it("treats an account the subject query does not return as an invalid session, without spending a code", async () => {
    state.subjectRows = []

    expect(await confirmEmailVerificationCode(USER_ID, SESSION_ID, "123456")).toEqual({ kind: "session_invalid" })
    expect(mocks.verifyOTP).not.toHaveBeenCalled()
    expect(state.txUpdates).toEqual([])
  })
})
