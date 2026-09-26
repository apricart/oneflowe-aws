import { describe, expect, it, vi } from "vitest"

import { METADATA_MASK } from "@/lib/activity-log"
import {
  MAX_AUDIT_ACTION_LENGTH,
  MAX_AUDIT_ENTITY_ID_LENGTH,
  auditActorFromSession,
  buildAuditRow,
  normalizeAuditAction,
  normalizeAuditEntityId,
  recordAuditEvent,
  type AuditExecutor,
} from "@/lib/server/activity-audit"

/**
 * The centralized writer, without a database.
 *
 * `buildAuditRow` is separated from the insert for exactly this reason: the row
 * it produces is where the guarantees live — one spelling per event, one id per
 * row, no secret in the payload — and none of them needs Postgres to check.
 *
 * `recordAuditEvent` writing to the caller's transaction is proved against real
 * rows in `tests/integration/activity-log-api.test.ts`, which rolls a category
 * create back by failing its audit write.
 */

/** A stand-in for `db` or a transaction handle, recording what it was handed. */
function fakeExecutor() {
  const values = vi.fn()
  const insert = vi.fn(() => ({ values }))
  return { executor: { insert } as unknown as AuditExecutor, insert, values }
}

describe("normalizeAuditAction", () => {
  it("settles on one spelling whatever the caller wrote", () => {
    expect(normalizeAuditAction("update category")).toBe("UPDATE_CATEGORY")
    expect(normalizeAuditAction("update-category")).toBe("UPDATE_CATEGORY")
    expect(normalizeAuditAction("update.category")).toBe("UPDATE_CATEGORY")
    expect(normalizeAuditAction("UPDATE_CATEGORY")).toBe("UPDATE_CATEGORY")
    expect(normalizeAuditAction("  update   category  ")).toBe("UPDATE_CATEGORY")
  })

  it("collapses and trims separators rather than leaving them in the key", () => {
    expect(normalizeAuditAction("__update___category__")).toBe("UPDATE_CATEGORY")
  })

  it("fits the column", () => {
    expect(normalizeAuditAction("x".repeat(MAX_AUDIT_ACTION_LENGTH + 50))).toHaveLength(
      MAX_AUDIT_ACTION_LENGTH,
    )
  })
})

describe("normalizeAuditEntityId", () => {
  it("accepts one id as a number or a string", () => {
    expect(normalizeAuditEntityId(42)).toBe("42")
    expect(normalizeAuditEntityId("42")).toBe("42")
    expect(normalizeAuditEntityId("  42 ")).toBe("42")
  })

  it("accepts absence", () => {
    expect(normalizeAuditEntityId(null)).toBeNull()
    expect(normalizeAuditEntityId(undefined)).toBeNull()
    expect(normalizeAuditEntityId("")).toBeNull()
  })

  it("refuses a list, rather than overflowing the column at run time", () => {
    // A comma-joined list here overflowed `varchar(128)` and threw *after* the
    // business rows were written — see `lib/audit-entity-id.test.ts`.
    expect(() => normalizeAuditEntityId([1, 2, 3] as unknown as string)).toThrow(TypeError)
    expect(() => normalizeAuditEntityId({ id: 1 } as unknown as string)).toThrow(TypeError)
  })

  it("refuses an id longer than the column and says where a list belongs", () => {
    expect(() => normalizeAuditEntityId("x".repeat(MAX_AUDIT_ENTITY_ID_LENGTH + 1))).toThrow(
      /metadata/,
    )
  })

  it("refuses a non-finite number rather than storing NaN", () => {
    expect(normalizeAuditEntityId(Number.NaN)).toBeNull()
    expect(normalizeAuditEntityId(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe("buildAuditRow", () => {
  const actor = { id: "u-1", role: "SUPER_ADMIN", email: "admin@example.test" }

  it("normalizes the action and the entity", () => {
    return expect(
      buildAuditRow({ action: "create category", entity: "  category  ", entityId: 7, actor }),
    ).resolves.toMatchObject({ action: "CREATE_CATEGORY", entity: "category", entityId: "7" })
  })

  it("carries the actor from the caller, not from a body", async () => {
    const row = await buildAuditRow({ action: "X", entity: "y", entityId: null, actor })
    expect(row.userId).toBe("u-1")
    expect(row.metadata).toMatchObject({ actorRole: "SUPER_ADMIN", actorEmail: "admin@example.test" })
  })

  it("records both sides of an update", async () => {
    const row = await buildAuditRow({
      action: "UPDATE_CATEGORY",
      entity: "category",
      entityId: 7,
      actor,
      before: { name: "Old" },
      after: { name: "New" },
    })
    expect(row.metadata).toMatchObject({ before: { name: "Old" }, after: { name: "New" } })
  })

  it("keeps a before that is deliberately empty", async () => {
    // `{}` and absent mean different things: one says nothing changed there, the
    // other says nothing was recorded.
    const row = await buildAuditRow({ action: "X", entity: "y", entityId: 1, actor, before: {} })
    expect(row.metadata).toHaveProperty("before")
  })

  it("masks a secret a caller happens to have in scope", async () => {
    const row = await buildAuditRow({
      action: "X",
      entity: "y",
      entityId: 1,
      actor,
      after: { name: "n", passwordHash: "$2b$10$abc" },
      context: { resetToken: "t" },
    })
    const metadata = row.metadata as { after: Record<string, unknown>; resetToken: unknown }
    expect(metadata.after.passwordHash).toBe(METADATA_MASK)
    expect(metadata.resetToken).toBe(METADATA_MASK)
    expect(JSON.stringify(row.metadata)).not.toContain("$2b$10$abc")
  })

  it("drops a scope id that would break a foreign key", async () => {
    // `audit_logs` carries FKs on both scope columns, and a stale or zero value
    // would abort the insert — taking the business change with it.
    const row = await buildAuditRow({
      action: "X",
      entity: "y",
      entityId: 1,
      actor,
      organizationId: 0,
      branchId: -3,
    })
    expect(row.organizationId).toBeNull()
    expect(row.branchId).toBeNull()
  })

  it("keeps a real scope id", async () => {
    const row = await buildAuditRow({
      action: "X",
      entity: "y",
      entityId: 1,
      actor,
      organizationId: 10,
      branchId: 4,
    })
    expect(row).toMatchObject({ organizationId: 10, branchId: 4 })
  })

  it("survives having no request scope at all", async () => {
    // A script or a cron sweep has no headers; the write must still happen.
    const row = await buildAuditRow({ action: "X", entity: "y", entityId: 1, actor: { id: null } })
    expect(row.userId).toBeNull()
    expect(row.action).toBe("X")
  })

  it("does not invent an actor role or email", async () => {
    const row = await buildAuditRow({ action: "X", entity: "y", entityId: 1, actor: { id: "u" } })
    expect(row.metadata).not.toHaveProperty("actorRole")
    expect(row.metadata).not.toHaveProperty("actorEmail")
  })
})

describe("recordAuditEvent", () => {
  it("writes through the executor it was given, not through its own client", async () => {
    // This is what makes the record share the caller's transaction instead of
    // being best effort.
    const { executor, insert, values } = fakeExecutor()
    await recordAuditEvent(executor, {
      action: "CREATE_CATEGORY",
      entity: "category",
      entityId: 5,
      actor: { id: "u-1" },
    })
    expect(insert).toHaveBeenCalledOnce()
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CREATE_CATEGORY", entity: "category", entityId: "5" }),
    )
  })

  it("propagates a refusal instead of swallowing it", async () => {
    const { executor } = fakeExecutor()
    await expect(
      recordAuditEvent(executor, {
        action: "X",
        entity: "y",
        entityId: "x".repeat(MAX_AUDIT_ENTITY_ID_LENGTH + 1),
        actor: { id: "u" },
      }),
    ).rejects.toThrow()
  })

  it("propagates a database failure, so the caller's transaction rolls back", async () => {
    const values = vi.fn(() => Promise.reject(new Error("insert failed")))
    const executor = { insert: vi.fn(() => ({ values })) } as unknown as AuditExecutor
    await expect(
      recordAuditEvent(executor, { action: "X", entity: "y", entityId: 1, actor: { id: "u" } }),
    ).rejects.toThrow("insert failed")
  })
})

describe("auditActorFromSession", () => {
  it("reads the session", () => {
    expect(
      auditActorFromSession({ user: { id: "u-1", role: "SUPER_ADMIN", email: "a@b.test" } }),
    ).toEqual({ id: "u-1", role: "SUPER_ADMIN", email: "a@b.test" })
  })

  it("returns an empty actor rather than throwing on a missing session", () => {
    expect(auditActorFromSession(null)).toEqual({ id: null, role: null, email: null })
    expect(auditActorFromSession({})).toEqual({ id: null, role: null, email: null })
    expect(auditActorFromSession({ user: {} })).toEqual({ id: null, role: null, email: null })
  })

  it("ignores a non-string id, so a crafted session cannot put an object in the column", () => {
    expect(auditActorFromSession({ user: { id: { toString: () => "x" } } }).id).toBeNull()
    expect(auditActorFromSession({ user: { id: "" } }).id).toBeNull()
  })
})
