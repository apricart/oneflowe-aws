import { beforeEach, describe, expect, it, vi } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"

import { authSessions, sessions, users } from "@/db/schema"
import type { AuthAuditEvent } from "./auth-audit"

/**
 * `changeOwnPassword` with the database stubbed: which queries it runs, in
 * what order, with which predicate, under each setting of
 * `lib/password-change-policy.ts`. The real transaction against Postgres is
 * covered by `tests/integration/password-rotation.test.ts` (proof required)
 * and `tests/integration/password-change-direct.test.ts` (proof off); what
 * is pinned here is the shape — that switching the proof off removes the
 * freshness term and *only* the freshness term, and that every other rule
 * still runs.
 */

type Row = Record<string, unknown>

const state = vi.hoisted(() => ({
  /** What the account lookup returns. */
  accountRows: [] as Row[],
  /** What the advisory proof lookup returns. */
  proofRows: [] as Row[],
  /** What `update(auth_sessions) … returning` finds inside the transaction. */
  sessionRows: [] as Row[],
  /** What `update(users) … returning` finds inside the transaction. */
  userRows: [] as Row[],
  /** Which tables the account/proof lookups read, in order. */
  selects: [] as string[],
  /** Every statement the transaction issued, in order. */
  tx: [] as { verb: "update" | "delete"; table: string; set?: Row; where?: unknown }[],
}))

const mocks = vi.hoisted(() => ({
  emailVerificationRequired: vi.fn(() => true),
  hashPassword: vi.fn(async (value: string) => `hash(${value})`),
  verifyPassword: vi.fn(async (value: string, hash: string) => hash === `hash(${value})`),
  validatePassword: vi.fn((_value: string) => ({ valid: true, errors: [] as string[] })),
  evaluateLockout: vi.fn((_account: unknown): { locked: false } | { locked: true; retryAfterSeconds: number } => ({ locked: false })),
  registerFailedLogin: vi.fn(async () => undefined),
  invalidateSessionValidationCache: vi.fn(async () => undefined),
  recordAuthAuditEvent: vi.fn(async (_event: AuthAuditEvent) => undefined),
}))

function tableName(table: unknown): string {
  if (table === users) return "users"
  if (table === authSessions) return "auth_sessions"
  if (table === sessions) return "sessions"
  return "?"
}

/** A thenable Drizzle-shaped chain: every builder method returns itself, `await` yields `rows()`. */
function chain(rows: () => Row[], onCall?: (method: string, arg: unknown) => void) {
  const link: Record<string, unknown> = {}
  for (const method of ["from", "leftJoin", "where", "limit", "set", "returning"]) {
    link[method] = vi.fn((arg: unknown) => {
      onCall?.(method, arg)
      return link
    })
  }
  link.then = (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(rows()).then(resolve, reject)
  return link
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => {
      let table = "?"
      return chain(
        () => (table === "users" ? state.accountRows : table === "auth_sessions" ? state.proofRows : []),
        (method, arg) => {
          if (method === "from") {
            table = tableName(arg)
            state.selects.push(table)
          }
        },
      )
    },
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        update: (table: unknown) => {
          const entry = { verb: "update" as const, table: tableName(table), set: undefined as Row | undefined, where: undefined as unknown }
          state.tx.push(entry)
          return chain(
            () => (table === authSessions ? state.sessionRows : table === users ? state.userRows : []),
            (method, arg) => {
              if (method === "set") entry.set = arg as Row
              if (method === "where") entry.where = arg
            },
          )
        },
        delete: (table: unknown) => {
          const entry = { verb: "delete" as const, table: tableName(table), where: undefined as unknown }
          state.tx.push(entry)
          return chain(() => [], (method, arg) => {
            if (method === "where") entry.where = arg
          })
        },
      }
      return work(tx)
    },
  },
}))
vi.mock("@/lib/password", () => ({
  hashPassword: mocks.hashPassword,
  verifyPassword: mocks.verifyPassword,
  validatePassword: mocks.validatePassword,
}))
vi.mock("@/lib/password-change-policy", () => ({
  isEmailVerificationRequiredForPasswordChange: mocks.emailVerificationRequired,
}))
vi.mock("@/lib/server/auth-lockout", () => ({
  evaluateLockout: mocks.evaluateLockout,
  registerFailedLogin: mocks.registerFailedLogin,
}))
vi.mock("@/lib/server/auth-audit", () => ({ recordAuthAuditEvent: mocks.recordAuthAuditEvent }))
vi.mock("@/lib/server/email-verification", () => ({ EMAIL_VERIFICATION_VALIDITY_SECONDS: 600 }))
vi.mock("@/lib/session-validation-cache", () => ({
  invalidateSessionValidationCache: mocks.invalidateSessionValidationCache,
}))

import { changeOwnPassword } from "./password-change"

const USER_ID = "3b1a6a3e-1111-4c7b-9a2e-000000000001"
const SESSION_ID = "9d2f0c4a-2222-4d8e-8b3f-000000000002"
const OLD_PASSWORD = "Handout-Passw0rd!"
const NEW_PASSWORD = "Chosen-Passw0rd!2026"

const dialect = new PgDialect()
/** The predicate as Postgres would see it, parameters as `$n`. */
const predicateText = (where: unknown): string => dialect.sqlToQuery(where as SQL).sql
const FRESHNESS_TERM = "make_interval"

function account(overrides: Partial<Row> = {}): Row {
  return {
    id: USER_ID,
    email: "imrank@ke.com.pk",
    username: "imran-17655-ba",
    role: "BRANCH_ADMIN",
    organizationId: 10,
    branchId: 77,
    passwordHash: `hash(${OLD_PASSWORD})`,
    sessionVersion: 3,
    mustChangePassword: true,
    lockoutUntil: null,
    ...overrides,
  }
}

const input = (overrides: Partial<Parameters<typeof changeOwnPassword>[0]> = {}) => ({
  userId: USER_ID,
  sessionId: SESSION_ID,
  currentPassword: OLD_PASSWORD,
  newPassword: NEW_PASSWORD,
  ...overrides,
})

const auditEvents = () => mocks.recordAuthAuditEvent.mock.calls.map(([event]) => event)
const auditActions = () => auditEvents().map((event) => event.action)
const sessionUpdate = () => state.tx.find((entry) => entry.verb === "update" && entry.table === "auth_sessions")
const userUpdate = () => state.tx.find((entry) => entry.verb === "update" && entry.table === "users")

beforeEach(() => {
  state.accountRows = [account()]
  state.proofRows = [{ id: SESSION_ID }]
  state.sessionRows = [{ id: SESSION_ID }]
  state.userRows = [{ id: USER_ID }]
  state.selects.length = 0
  state.tx.length = 0
  mocks.emailVerificationRequired.mockReset().mockReturnValue(true)
  mocks.hashPassword.mockClear()
  mocks.verifyPassword.mockClear()
  mocks.validatePassword.mockReset().mockReturnValue({ valid: true, errors: [] })
  mocks.evaluateLockout.mockReset().mockReturnValue({ locked: false })
  mocks.registerFailedLogin.mockClear()
  mocks.invalidateSessionValidationCache.mockClear()
  mocks.recordAuthAuditEvent.mockClear()
})

describe("with the emailed proof required", () => {
  it("looks for a fresh proof on this session before anything is spent, and refuses without one", async () => {
    state.proofRows = []

    const outcome = await changeOwnPassword(input())

    expect(outcome).toEqual({ kind: "verification_required" })
    expect(state.selects).toEqual(["users", "auth_sessions"])
    expect(mocks.verifyPassword).not.toHaveBeenCalled()
    expect(state.tx).toEqual([])
    expect(auditEvents()).toEqual([expect.objectContaining({
      action: "AUTH_PASSWORD_CHANGE_FAILURE",
      reason: "email_verification_required",
      success: false,
    })])
  })

  it("consumes the proof under a freshness predicate in the same transaction as the hash write", async () => {
    const outcome = await changeOwnPassword(input())

    expect(outcome).toEqual({ kind: "changed", forced: true })
    expect(state.tx.map((entry) => `${entry.verb} ${entry.table}`)).toEqual([
      "update auth_sessions",
      "update users",
      "delete sessions",
    ])
    const proof = sessionUpdate()!
    expect(proof.set).toEqual({ emailVerifiedAt: null })
    const text = predicateText(proof.where)
    expect(text).toContain('"auth_sessions"."id" = $')
    expect(text).toContain('"auth_sessions"."subject_id" = $')
    expect(text).toContain('"auth_sessions"."revoked_at" is null')
    expect(text).toContain(FRESHNESS_TERM)
    expect(auditEvents().at(-1)).toMatchObject({
      action: "AUTH_PASSWORD_CHANGED",
      success: true,
      details: { forced: true, emailVerified: true },
    })
  })

  it("treats a proof that vanished inside the transaction as verification required", async () => {
    state.sessionRows = []

    const outcome = await changeOwnPassword(input())

    expect(outcome).toEqual({ kind: "verification_required" })
    expect(userUpdate()).toBeUndefined()
    expect(mocks.invalidateSessionValidationCache).not.toHaveBeenCalled()
    expect(auditEvents().at(-1)).toMatchObject({ reason: "email_verification_required" })
  })
})

describe("with the emailed proof switched off", () => {
  beforeEach(() => {
    mocks.emailVerificationRequired.mockReturnValue(false)
  })

  it("never looks for a proof, and changes the password in the one transaction", async () => {
    const outcome = await changeOwnPassword(input())

    expect(outcome).toEqual({ kind: "changed", forced: true })
    expect(state.selects).toEqual(["users"])
    expect(state.tx.map((entry) => `${entry.verb} ${entry.table}`)).toEqual([
      "update auth_sessions",
      "update users",
      "delete sessions",
    ])
    expect(mocks.hashPassword).toHaveBeenCalledWith(NEW_PASSWORD)
    expect(mocks.invalidateSessionValidationCache).toHaveBeenCalledWith(USER_ID)
  })

  it("drops the freshness term and only the freshness term: the row must still be this account's live session", async () => {
    await changeOwnPassword(input())

    const proof = sessionUpdate()!
    expect(proof.set).toEqual({ emailVerifiedAt: null })
    const text = predicateText(proof.where)
    expect(text).toContain('"auth_sessions"."id" = $')
    expect(text).toContain('"auth_sessions"."subject_id" = $')
    expect(text).toContain('"auth_sessions"."revoked_at" is null')
    expect(text).not.toContain(FRESHNESS_TERM)
    expect(dialect.sqlToQuery(proof.where as SQL).params).toEqual([SESSION_ID, USER_ID])
  })

  it("still writes everything the rotation needs on the account", async () => {
    await changeOwnPassword(input())

    const update = userUpdate()!
    expect(update.set).toMatchObject({
      passwordHash: `hash(${NEW_PASSWORD})`,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      lockoutUntil: null,
    })
    expect(predicateText(update.set!.sessionVersion as SQL)).toContain('"users"."session_version" + ')
    expect(update.set).toHaveProperty("passwordChangedAt")
    const drop = state.tx.find((entry) => entry.verb === "delete")!
    expect(drop.table).toBe("sessions")
    expect(predicateText(drop.where)).toContain('"sessions"."user_id" = $')
  })

  it("records in the audit row that no proof was taken", async () => {
    await changeOwnPassword(input())

    expect(auditActions()).toEqual(["AUTH_PASSWORD_CHANGED"])
    expect(auditEvents()[0]).toMatchObject({
      subjectId: USER_ID,
      organizationId: 10,
      branchId: 77,
      success: true,
      details: { forced: true, emailVerified: false },
    })
  })

  it("answers session_invalid, not verification_required, when the session row is revoked or another account's", async () => {
    state.sessionRows = []

    const outcome = await changeOwnPassword(input())

    expect(outcome).toEqual({ kind: "session_invalid" })
    expect(userUpdate()).toBeUndefined()
    expect(mocks.invalidateSessionValidationCache).not.toHaveBeenCalled()
    expect(auditEvents()).toEqual([expect.objectContaining({
      action: "AUTH_PASSWORD_CHANGE_FAILURE",
      reason: "session_invalid",
      success: false,
    })])
  })

  it("still refuses a locked account before touching the password", async () => {
    mocks.evaluateLockout.mockReturnValue({ locked: true, retryAfterSeconds: 240 })

    const outcome = await changeOwnPassword(input())

    expect(outcome).toEqual({ kind: "locked", retryAfterSeconds: 240 })
    expect(mocks.verifyPassword).not.toHaveBeenCalled()
    expect(state.tx).toEqual([])
    expect(auditEvents()[0]).toMatchObject({ reason: "account_locked" })
  })

  it("still requires the current password, and counts a wrong one against the lockout budget", async () => {
    const outcome = await changeOwnPassword(input({ currentPassword: "not-the-password" }))

    expect(outcome).toEqual({ kind: "invalid_current_password" })
    expect(mocks.registerFailedLogin).toHaveBeenCalledWith({ kind: "user", id: USER_ID })
    expect(state.tx).toEqual([])
    expect(auditEvents()[0]).toMatchObject({ reason: "invalid_password" })
  })

  it("still applies the password policy", async () => {
    mocks.validatePassword.mockReturnValue({ valid: false, errors: ["Password must be at least 12 characters"] })

    const outcome = await changeOwnPassword(input({ newPassword: "short" }))

    expect(outcome).toEqual({ kind: "invalid_password", errors: ["Password must be at least 12 characters"] })
    expect(state.tx).toEqual([])
  })

  it("still refuses a new password equal to the current one", async () => {
    const outcome = await changeOwnPassword(input({ newPassword: OLD_PASSWORD }))

    expect(outcome).toEqual({ kind: "password_unchanged" })
    expect(mocks.hashPassword).not.toHaveBeenCalled()
    expect(state.tx).toEqual([])
    expect(auditEvents()[0]).toMatchObject({ reason: "password_unchanged" })
  })

  it("answers not_found for an account the lookup does not return, spending nothing", async () => {
    state.accountRows = []

    expect(await changeOwnPassword(input())).toEqual({ kind: "not_found" })
    expect(mocks.verifyPassword).not.toHaveBeenCalled()
    expect(state.tx).toEqual([])
    expect(auditEvents()).toEqual([])
  })

  it("reports an unforced change as such", async () => {
    state.accountRows = [account({ mustChangePassword: false })]

    expect(await changeOwnPassword(input())).toEqual({ kind: "changed", forced: false })
    expect(auditEvents().at(-1)).toMatchObject({ details: { forced: false, emailVerified: false } })
  })
})
