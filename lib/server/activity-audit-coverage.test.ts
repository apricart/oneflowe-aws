import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Which mutating routes record what they did.
 *
 * An audit review found 94 of 135 route files under `app/api/v1/` writing no
 * audit row at all. This change retrofitted the seven listed below through
 * `lib/server/activity-audit.ts`; this is the **control** that keeps them
 * recorded, in the same shape as `lib/pricing-access.test.ts`.
 *
 * Two things are asserted, and the second is the one that matters:
 *
 *  1. Each listed file writes an audit row for each mutating handler it has.
 *  2. Each of those writes is **inside a transaction**, so the record commits
 *     with the change or neither does. A write through `db.insert` rather than
 *     `tx.insert` is the "best effort" pattern the review flagged, and it would
 *     pass a naive grep for `recordAuditEvent`.
 *
 * `app/api/v1/settings/route.ts` is deliberately absent: it already wrote a
 * transactional audit row with a previous value before this change, and is the
 * pattern the writer generalizes.
 *
 * **When you audit another route, add it here.** A route missing from this list
 * is silently free to stop recording.
 */

type Covered = {
  file: string
  /** The handlers that mutate and must each record. */
  handlers: readonly string[]
  /** The action strings the handlers write, so a rename cannot go unnoticed. */
  actions: readonly string[]
}

const COVERED: readonly Covered[] = [
  {
    file: "app/api/v1/categories/route.ts",
    handlers: ["POST", "PUT", "DELETE"],
    actions: ["CREATE_CATEGORY", "UPDATE_CATEGORY", "DELETE_CATEGORY"],
  },
  {
    file: "app/api/v1/subcategories/route.ts",
    handlers: ["POST", "PUT", "DELETE"],
    actions: ["CREATE_SUBCATEGORY", "UPDATE_SUBCATEGORY", "DELETE_SUBCATEGORY"],
  },
  {
    file: "app/api/v1/modifiers/route.ts",
    handlers: ["POST", "PUT", "DELETE"],
    actions: ["CREATE_MODIFIER", "UPDATE_MODIFIER", "DELETE_MODIFIER"],
  },
  {
    file: "app/api/v1/suppliers/route.ts",
    handlers: ["POST"],
    actions: ["CREATE_SUPPLIER"],
  },
  {
    file: "app/api/v1/suppliers/[id]/route.ts",
    handlers: ["PATCH", "DELETE"],
    actions: ["UPDATE_SUPPLIER", "DELETE_SUPPLIER"],
  },
  {
    file: "app/api/v1/branches/[id]/route.ts",
    handlers: ["PATCH", "DELETE"],
    actions: ["UPDATE_BRANCH", "DEACTIVATE_BRANCH"],
  },
  {
    file: "app/api/v1/reports/schedule/route.ts",
    handlers: ["POST", "DELETE"],
    actions: ["CREATE_REPORT_SCHEDULE", "UPDATE_REPORT_SCHEDULE", "DELETE_REPORT_SCHEDULE"],
  },
]

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8")
}

describe("retrofitted audit coverage", () => {
  it.each(COVERED)("$file records every mutation it performs", ({ file, handlers, actions }) => {
    const source = read(file)

    expect(source, `${file} must import the centralized writer`).toContain(
      "@/lib/server/activity-audit",
    )

    // One audit write per mutating handler, at least.
    const writes = source.match(/recordAuditEvent\(/g) ?? []
    expect(
      writes.length,
      `${file} has ${handlers.length} mutating handlers but ${writes.length} audit writes`,
    ).toBeGreaterThanOrEqual(handlers.length)

    for (const action of actions) {
      expect(source, `${file} no longer writes ${action}`).toContain(`"${action}"`)
    }
  })

  it.each(COVERED)("$file writes its audit row inside the transaction", ({ file }) => {
    const source = read(file)

    // Every call must be handed a transaction handle, never the module-level
    // client: `recordAuditEvent(db, …)` would commit independently of the change
    // it claims to describe.
    const executors = [...source.matchAll(/recordAuditEvent\(\s*([A-Za-z_$][\w$]*)/g)].map(
      (match) => match[1],
    )
    expect(executors.length).toBeGreaterThan(0)
    for (const executor of executors) {
      expect(executor, `${file} passes "${executor}" instead of a transaction handle`).toBe("tx")
    }

    expect(source, `${file} must open a transaction around the change and its record`).toMatch(
      /db\.transaction\(/,
    )
  })

  it("keeps the writer the only way these routes reach audit_logs", () => {
    // A direct `insert(auditLogs)` alongside the writer means two spellings of
    // one event again, which is what the centralization was for.
    for (const { file } of COVERED) {
      const source = read(file)
      expect(source, `${file} bypasses the writer`).not.toMatch(/insert\(auditLogs\)/)
    }
  })
})

describe("the writer itself", () => {
  const source = read("lib/server/activity-audit.ts")

  it("stays server-only", () => {
    expect(source).toContain('import "server-only"')
  })

  it("does not fall back to its own client when given an executor", () => {
    // `recordAuditEvent(executor, …)` must use `executor`, so there is no path
    // on which a caller inside a transaction silently writes outside it.
    expect(source).toMatch(/executor\.insert\(auditLogs\)/)
    expect(source).not.toMatch(/executor: AuditExecutor = db/)
  })

  it("masks the payload on the way in", () => {
    expect(source).toContain("maskAuditMetadata")
  })
})
