import { beforeEach, describe, expect, it, vi } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  update: vi.fn(),
  select: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({
  db: {
    insert: mocks.insert,
    update: mocks.update,
    select: mocks.select,
  },
}))

import {
  advanceAuthSessionRecord,
  createAuthSessionRecord,
  revokeAuthSessionRecord,
  validateAuthSessionRecord,
} from "@/lib/server/auth-session-store"

const START = 2_000_000_000_000
const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000"
const dialect = new PgDialect()

function compile(expression: SQL): string {
  return dialect.sqlToQuery(expression).sql.replace(/\s+/g, " ").trim()
}

const identity = {
  sessionId: SESSION_ID,
  subjectId: "user-1",
  organizationId: 17,
  sessionStartedAt: START,
  sessionAbsoluteExpiresAt: START + 8 * 60 * 60_000,
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    subjectId: "user-1",
    organizationId: 17,
    startedAt: new Date(START),
    lastActivityAt: new Date(START),
    absoluteExpiresAt: new Date(START + 8 * 60 * 60_000),
    revokedAt: null,
    ...overrides,
  }
}

function mockUpdateReturning(rows: unknown[]) {
  const chain: any = {
    set: vi.fn(() => chain),
    where: vi.fn(() => chain),
    returning: vi.fn().mockResolvedValue(rows),
  }
  mocks.update.mockReturnValueOnce(chain)
  return chain
}

function mockSelectRows(rows: unknown[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn().mockResolvedValue(rows),
  }
  mocks.select.mockReturnValueOnce(chain)
  return chain
}

describe("auth session registry", () => {
  beforeEach(() => {
    mocks.insert.mockReset()
    mocks.update.mockReset()
    mocks.select.mockReset()
  })

  it("creates a durable record for string user or employee subjects", async () => {
    const values = vi.fn().mockResolvedValue(undefined)
    mocks.insert.mockReturnValue({ values })

    await createAuthSessionRecord({
      sessionId: SESSION_ID,
      subjectId: "emp_42",
      organizationId: 17,
      claims: {
        sessionPolicyVersion: 1,
        sessionStartedAt: START,
        sessionLastActivityAt: START,
        sessionIdleTimeoutMinutes: 5,
        sessionAbsoluteExpiresAt: START + 8 * 60 * 60_000,
      },
    })

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id: SESSION_ID,
        subjectId: "emp_42",
        organizationId: 17,
      }),
    )
  })

  it("returns the authoritative live activity timestamp", async () => {
    mockUpdateReturning([])
    mockSelectRows([row({ lastActivityAt: new Date(START + 60_000) })])

    const result = await validateAuthSessionRecord(
      identity,
      5,
      START + 2 * 60_000,
    )

    expect(result).toEqual({
      kind: "valid",
      claims: expect.objectContaining({
        sessionLastActivityAt: START + 60_000,
        sessionIdleTimeoutMinutes: 5,
      }),
    })
  })

  it("persists expiry as a one-way revocation", async () => {
    const update = mockUpdateReturning([
      row({ lastActivityAt: new Date(START), revokedAt: new Date(START + 5 * 60_000) }),
    ])

    await expect(
      validateAuthSessionRecord(identity, 5, START + 5 * 60_000),
    ).resolves.toEqual({ kind: "invalid", reason: "idle_timeout" })
    expect(mocks.select).not.toHaveBeenCalled()
    const whereSql = compile(update.where.mock.calls[0][0])
    expect(whereSql).toContain('"auth_sessions"."id" = $1')
    expect(whereSql).toContain('"auth_sessions"."subject_id" = $2')
    expect(whereSql).toContain('"auth_sessions"."revoked_at" is null')
    expect(whereSql).toContain('"auth_sessions"."absolute_expires_at" <= $3')
    expect(whereSql).toContain(
      '"auth_sessions"."last_activity_at" + ($4 * INTERVAL \'1 minute\') <= $5',
    )
  })

  it("atomically advances a live record and uses its monotonic result", async () => {
    const update = mockUpdateReturning([
      row({ lastActivityAt: new Date(START + 2 * 60_000) }),
    ])

    const result = await advanceAuthSessionRecord(
      identity,
      5,
      START + 2 * 60_000,
    )

    expect(result).toEqual({
      kind: "valid",
      claims: expect.objectContaining({
        sessionLastActivityAt: START + 2 * 60_000,
      }),
    })
    expect(update.set).toHaveBeenCalledWith({
      lastActivityAt: expect.anything(),
    })
    const setSql = compile(update.set.mock.calls[0][0].lastActivityAt)
    const whereSql = compile(update.where.mock.calls[0][0])
    expect(setSql).toContain(
      'GREATEST("auth_sessions"."last_activity_at", $1)',
    )
    expect(whereSql).toContain('"auth_sessions"."id" = $1')
    expect(whereSql).toContain('"auth_sessions"."subject_id" = $2')
    expect(whereSql).toContain('"auth_sessions"."revoked_at" is null')
    expect(whereSql).toContain('"auth_sessions"."absolute_expires_at" > $3')
    expect(whereSql).toContain(
      '"auth_sessions"."last_activity_at" + ($4 * INTERVAL \'1 minute\') > $5',
    )
  })

  it("distinguishes a registry outage from an invalid session", async () => {
    mocks.update.mockImplementation(() => {
      throw new Error("database unavailable")
    })

    const result = await validateAuthSessionRecord(identity, 5, START + 60_000)

    expect(result.kind).toBe("unavailable")
  })

  it("revokes exactly one browser session and subject", async () => {
    const where = vi.fn().mockResolvedValue(undefined)
    const chain: any = {
      set: vi.fn(() => chain),
      where,
    }
    mocks.update.mockReturnValue(chain)

    await revokeAuthSessionRecord(SESSION_ID, "user-1", START + 60_000)

    expect(chain.set).toHaveBeenCalledWith({
      revokedAt: new Date(START + 60_000),
    })
    expect(where).toHaveBeenCalledTimes(1)
    const whereSql = compile(where.mock.calls[0][0])
    expect(whereSql).toContain('"auth_sessions"."id" = $1')
    expect(whereSql).toContain('"auth_sessions"."subject_id" = $2')
    expect(whereSql).toContain('"auth_sessions"."revoked_at" is null')
  })
})
