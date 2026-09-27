import { describe, expect, it } from "vitest"

import {
  describeMigrationFailure,
  failingStatementOf,
  pendingMigrations,
  reasonOf,
  type JournalEntry,
} from "./migration-report"

function entry(idx: number, when: number, tag: string): JournalEntry {
  return { idx, version: "7", when, tag, breakpoints: true }
}

const JOURNAL = [
  entry(0, 1_000, "0000_first"),
  entry(1, 2_000, "0001_second"),
  entry(2, 3_000, "0002_third"),
]

/** The shape drizzle hands up: its own wrapper, with the pg error as `cause`. */
function drizzleFailure(statement: string, pgError: Record<string, unknown>) {
  const cause = Object.assign(new Error(String(pgError.message)), pgError)
  return Object.assign(new Error(`Failed query: ${statement}\nparams: `), { cause })
}

describe("pendingMigrations", () => {
  it("applies everything when nothing has ever been applied", () => {
    expect(pendingMigrations(JOURNAL, null).map((e) => e.tag))
      .toEqual(["0000_first", "0001_second", "0002_third"])
  })

  it("applies only entries newer than the last recorded created_at", () => {
    expect(pendingMigrations(JOURNAL, 1_000).map((e) => e.tag)).toEqual(["0001_second", "0002_third"])
    expect(pendingMigrations(JOURNAL, 2_000).map((e) => e.tag)).toEqual(["0002_third"])
  })

  it("is empty when the newest entry is already applied", () => {
    expect(pendingMigrations(JOURNAL, 3_000)).toEqual([])
    // A database ahead of the checkout — nothing to do, not an error.
    expect(pendingMigrations(JOURNAL, 9_000)).toEqual([])
  })

  it("compares strictly, so an entry sharing the last timestamp is not replayed", () => {
    // Mirrors PgDialect.migrate: `lastDbMigration.created_at < folderMillis`.
    expect(pendingMigrations([entry(0, 5_000, "0000_same")], 5_000)).toEqual([])
  })

  it("orders by timestamp regardless of the order it is given them", () => {
    const shuffled = [JOURNAL[2], JOURNAL[0], JOURNAL[1]]
    expect(pendingMigrations(shuffled, null).map((e) => e.tag))
      .toEqual(["0000_first", "0001_second", "0002_third"])
  })

  it("does not mutate the journal it is given", () => {
    const original = [JOURNAL[2], JOURNAL[0], JOURNAL[1]]
    const snapshot = [...original]
    pendingMigrations(original, null)
    expect(original).toEqual(snapshot)
  })
})

describe("reasonOf / failingStatementOf", () => {
  it("prefers the driver's message over drizzle's wrapper", () => {
    const error = drizzleFailure("ALTER TABLE x ...", {
      message: 'check constraint "c_ck" of relation "t" is violated by some row',
      code: "23514",
    })
    expect(reasonOf(error)).toBe('check constraint "c_ck" of relation "t" is violated by some row')
  })

  it("pulls the statement out of the wrapper and drops the params tail", () => {
    const error = drizzleFailure("ALTER TABLE x ADD COLUMN y int", { message: "boom" })
    expect(failingStatementOf(error)).toBe("ALTER TABLE x ADD COLUMN y int")
  })

  it("returns null when the message is not in drizzle's shape", () => {
    expect(failingStatementOf(new Error("connection refused"))).toBeNull()
  })

  it("falls back to the only message there is", () => {
    expect(reasonOf(new Error("The server does not support SSL connections")))
      .toBe("The server does not support SSL connections")
  })

  it("terminates on a cause cycle and still reports the innermost message", () => {
    const a: { message: string; cause?: unknown } = { message: "outer" }
    const b: { message: string; cause?: unknown } = { message: "inner", cause: a }
    a.cause = b
    // The walk stops when it meets a link it has already seen, so the chain
    // is [a, b] and the innermost message it reaches is b's.
    expect(reasonOf(a)).toBe("inner")
  })
})

describe("describeMigrationFailure", () => {
  it("reports the reason, the pg fields and the failing statement", () => {
    // The real 2026-09-26 production failure.
    const error = drizzleFailure(
      'ALTER TABLE "budget_addons" ADD CONSTRAINT "budget_addons_forfeit_bounds_ck"\n  CHECK (...)',
      {
        message: 'check constraint "budget_addons_forfeit_bounds_ck" of relation "budget_addons" is violated by some row',
        code: "23514",
        table: "budget_addons",
      },
    )
    const text = describeMigrationFailure(error)

    expect(text).toContain("Migration FAILED.")
    expect(text).toContain("is violated by some row")
    expect(text).toContain("23514")
    expect(text).toContain("budget_addons")
    expect(text).toContain('ADD CONSTRAINT "budget_addons_forfeit_bounds_ck"')
  })

  it("always says the run rolled back, so nobody hunts a half-migrated database", () => {
    expect(describeMigrationFailure(new Error("anything"))).toContain("Nothing was applied")
  })

  it("reports a plain connection error without inventing pg fields", () => {
    const text = describeMigrationFailure(new Error("connect ECONNREFUSED 127.0.0.1:5432"))
    expect(text).toContain("connect ECONNREFUSED")
    expect(text).not.toContain("pg code")
    expect(text).not.toContain("failing statement")
  })

  it("does not throw on a non-error value", () => {
    expect(() => describeMigrationFailure("just a string")).not.toThrow()
    expect(() => describeMigrationFailure(null)).not.toThrow()
  })
})
