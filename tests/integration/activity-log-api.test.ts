import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { and, eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as activityRoute from "@/app/api/v1/activity-logs/route"
import * as categoriesRoute from "@/app/api/v1/categories/route"
import {
  auditLogs,
  categories,
  emailOutbox,
  supportMessages,
  supportThreadReads,
  supportThreads,
} from "@/db/schema"
import {
  ACTIVITY_MAX_WINDOW_DAYS,
  ACTIVITY_PAGE_SIZE_MAX,
  type ActivityEvent,
  type ActivityLogPage,
} from "@/lib/activity-log"
import { closePool, db } from "@/lib/db"
import { MAX_AUDIT_ENTITY_ID_LENGTH, recordAuditEvent } from "@/lib/server/activity-audit"

import {
  EXPECTED_ORDER,
  NO_DATABASE_REASON,
  WINDOW,
  createActivityLogFixtures,
  destroyActivityLogFixtures,
  hasTestDatabase,
  type ActivityLogFixtures,
  type EventKey,
} from "./helpers/activity-log-fixtures"

/**
 * `GET /api/v1/activity-logs` against real rows.
 *
 * Only identity and rate limiting are faked. The union, the keyset cursor, the
 * generated operation `CASE` and the name enrichment all run as SQL against
 * Postgres — which is the whole point, because those are the parts a unit test
 * cannot reach and the parts that decide whether a page of an audit trail is
 * complete.
 *
 * The last block closes the loop the other way: it drives a *mutation* through
 * `app/api/v1/categories/route.ts`, which this change retrofitted with
 * `recordAuditEvent`, and then reads the row back through this endpoint. The
 * writer and the reader are checked against each other rather than each against
 * its own idea of the schema.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
// Rate limiting needs Redis; the limit itself is unit-tested elsewhere.
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))

const { getServerSession } = mockedNextAuth

type Actor = { id: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(actor === null ? null : ({ user: actor } as any))
}

function superAdmin(fixtures: ActivityLogFixtures): Actor {
  return { id: fixtures.superAdminId, role: "SUPER_ADMIN", organizationId: null, branchId: null }
}

/** Every query in this suite is fenced to the fixture window — see the fixture note. */
function requestUrl(params: Record<string, string | number | undefined> = {}): string {
  const search = new URLSearchParams({
    from: WINDOW.from.toISOString(),
    to: WINDOW.to.toISOString(),
  })
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    search.set(key, String(value))
  }
  return `http://localhost/api/v1/activity-logs?${search.toString()}`
}

async function read(params: Record<string, string | number | undefined> = {}) {
  const response = await activityRoute.GET(new NextRequest(requestUrl(params)))
  const body = await response.json()
  return { status: response.status, body: body as ActivityLogPage & { error?: string }, response }
}

/** The fixture keys behind a page, in the order the endpoint returned them. */
function keysOf(fixtures: ActivityLogFixtures, items: ActivityEvent[]): EventKey[] {
  const byId = new Map<string, EventKey>(
    (Object.keys(fixtures.events) as EventKey[]).map((key) => [fixtures.eventId(key), key]),
  )
  return items.map((item) => byId.get(item.id)).filter((key): key is EventKey => key !== undefined)
}

function eventFor(fixtures: ActivityLogFixtures, items: ActivityEvent[], key: EventKey): ActivityEvent {
  const found = items.find((item) => item.id === fixtures.eventId(key))
  if (!found) throw new Error(`${key} is not on this page`)
  return found
}

describe.skipIf(!hasTestDatabase)("GET /api/v1/activity-logs", () => {
  let fixtures: ActivityLogFixtures

  beforeAll(async () => {
    fixtures = await createActivityLogFixtures()
  })

  afterAll(async () => {
    if (fixtures) await destroyActivityLogFixtures(fixtures)
    await closePool()
  })

  describe("who may read it", () => {
    it("refuses an unauthenticated caller with 401", async () => {
      signIn(null)
      const { status, body } = await read()
      expect(status).toBe(401)
      expect(body.items).toBeUndefined()
    })

    it.each([
      ["HEAD_OFFICE", "headOfficeId"],
      ["BRANCH_ADMIN", "branchAdminId"],
      ["GROUP_USER", "groupUserId"],
      ["GROUP_ORDER_PORTAL", "groupOrderPortalId"],
      ["ORDER_PORTAL", "orderPortalId"],
    ] as const)("refuses %s with 403", async (role, idKey) => {
      signIn({
        id: fixtures[idKey],
        role,
        organizationId: fixtures.organizationId,
        branchId: fixtures.northBranchId,
      })
      const { status, body } = await read()
      expect(status).toBe(403)
      expect(body.items).toBeUndefined()
    })

    it("admits SUPER_ADMIN, and never lets a shared cache hold the page", async () => {
      signIn(superAdmin(fixtures))
      const { status, response } = await read()
      expect(status).toBe(200)
      expect(response.headers.get("cache-control")).toContain("no-store")
      expect(response.headers.get("cache-control")).toContain("private")
    })

    it("does not let a refused role learn anything from the error body", async () => {
      signIn({
        id: fixtures.headOfficeId,
        role: "HEAD_OFFICE",
        organizationId: fixtures.organizationId,
        branchId: null,
      })
      const { body } = await read()
      expect(JSON.stringify(body)).not.toContain(fixtures.suffix)
    })
  })

  describe("the merge", () => {
    beforeAll(() => signIn(superAdmin(fixtures)))

    it("returns every source, newest first, with ties broken by source rank", async () => {
      const { body } = await read({ limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(keysOf(fixtures, body.items)).toEqual([...EXPECTED_ORDER])
    })

    it("crosses tenants, because the trail is not the Super Admin's own tenant", async () => {
      const { body } = await read({ limit: ACTIVITY_PAGE_SIZE_MAX })
      const keys = keysOf(fixtures, body.items)
      // E10 and E11 are the neighbour's; E12 belongs to no tenant at all.
      expect(keys).toContain("E10")
      expect(keys).toContain("E11")
      expect(keys).toContain("E12")
    })

    it("labels each row from the action string it holds", async () => {
      const { body } = await read({ limit: ACTIVITY_PAGE_SIZE_MAX })

      const deleted = eventFor(fixtures, body.items, "E2")
      expect(deleted).toMatchObject({
        source: "audit",
        action: "DELETE_CATEGORY",
        operation: "delete",
        category: "catalogue",
        severity: "critical",
        entity: "category",
        entityId: "4242",
        success: true,
      })

      const priced = eventFor(fixtures, body.items, "E8")
      expect(priced).toMatchObject({ operation: "update", category: "pricing", severity: "critical" })

      // A recorded *read*: `VIEW_GROUP_REPORT` is the only one in the
      // application. Its category is the subject it reported on, not "reports" —
      // `CATEGORY_RULES` puts GROUP ahead of REPORT deliberately, so the noun
      // answers "what was touched" while `operation: export` answers "how".
      const report = eventFor(fixtures, body.items, "E9")
      expect(report).toMatchObject({ source: "group", operation: "export", category: "group" })
    })

    it("marks a failed attempt as a warning and keeps its reason", async () => {
      const { body } = await read({ limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(eventFor(fixtures, body.items, "E1")).toMatchObject({
        operation: "auth",
        category: "authentication",
        severity: "warning",
        success: false,
        errorMessage: "invalid_password",
        ipAddress: "198.51.100.7",
      })
    })

    it("fills in the names behind the ids", async () => {
      const { body } = await read({ limit: ACTIVITY_PAGE_SIZE_MAX })
      const event = eventFor(fixtures, body.items, "E6")
      expect(event.organizationName).toContain(fixtures.suffix)
      expect(event.branchName).toContain("South")
      expect(event.actor.email).toContain("headoffice")
      expect(event.actor.role).toBe("HEAD_OFFICE")
    })

    it("keeps an employee principal readable without passing it to a uuid column", async () => {
      const { body } = await read({ limit: ACTIVITY_PAGE_SIZE_MAX })
      const event = eventFor(fixtures, body.items, "E7")
      expect(event.actor.id).toBe(`emp_${fixtures.suffix}`)
      // The row's own denormalized copy is what survives.
      expect(event.actor.email).toContain("employee")
      expect(event.actor.role).toBe("ORDER_PORTAL")
    })

    it("recovers an IP from metadata for a table with no column for one", async () => {
      const { body } = await read({ limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(eventFor(fixtures, body.items, "E2").ipAddress).toBe("198.51.100.10")
      expect(eventFor(fixtures, body.items, "E3").ipAddress).toBe("203.0.113.9")
    })

    it("masks a secret that an older row already holds", async () => {
      const { body } = await read({ limit: ACTIVITY_PAGE_SIZE_MAX })
      const event = eventFor(fixtures, body.items, "E2")
      const metadata = event.metadata as Record<string, unknown>
      expect(metadata.password).toBe("***MASKED***")
      expect(JSON.stringify(body)).not.toContain("must-not-appear")
    })
  })

  describe("keyset pagination", () => {
    beforeAll(() => signIn(superAdmin(fixtures)))

    it("walks the whole ordered list without repeating or losing a row", async () => {
      const collected: EventKey[] = []
      let cursor: string | undefined
      // Two at a time, so the walk has to step through the three-way timestamp
      // tie rather than swallowing it inside one page.
      for (let page = 0; page < 20; page += 1) {
        const { body } = await read({ limit: 2, cursor })
        collected.push(...keysOf(fixtures, body.items))
        if (!body.nextCursor) break
        cursor = body.nextCursor
      }
      expect(collected).toEqual([...EXPECTED_ORDER])
      expect(new Set(collected).size).toBe(collected.length)
    })

    it("steps across a shared timestamp in source-rank order", async () => {
      const first = await read({ limit: 2 })
      expect(keysOf(fixtures, first.body.items)).toEqual(["E1", "E3"])

      const second = await read({ limit: 2, cursor: first.body.nextCursor ?? undefined })
      // E4 (system, rank 2) then E2 (audit, rank 1): both share E3's timestamp
      // and both must still be unread after a cursor that stopped at E3.
      expect(keysOf(fixtures, second.body.items)).toEqual(["E4", "E2"])
    })

    it("reports no next cursor on the last page", async () => {
      const { body } = await read({ limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(body.nextCursor).toBeNull()
      expect(body.hasMore).toBe(false)
    })

    it("refuses a malformed cursor rather than silently restarting", async () => {
      const { status, body } = await read({ cursor: "not-a-cursor" })
      expect(status).toBe(400)
      expect(body.error).toMatch(/cursor/i)
    })
  })

  describe("filters", () => {
    beforeAll(() => signIn(superAdmin(fixtures)))

    it("narrows to one source", async () => {
      const { body } = await read({ source: "group", limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(keysOf(fixtures, body.items)).toEqual(["E3", "E9"])
      expect(body.items.every((item) => item.source === "group")).toBe(true)
    })

    it("accepts several sources at once", async () => {
      const { body } = await read({ source: "audit,group", limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(keysOf(fixtures, body.items)).toEqual(["E3", "E2", "E5", "E6", "E8", "E9", "E10", "E12"])
    })

    it("narrows by operation, using the CASE generated from ACTION_RULES", async () => {
      const { body } = await read({ operation: "delete", limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(keysOf(fixtures, body.items)).toEqual(["E2", "E10"])
      // The label the row carries and the filter that selected it agree.
      expect(body.items.every((item) => item.operation === "delete")).toBe(true)
    })

    it("narrows by category", async () => {
      const { body } = await read({ category: "authentication", limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(keysOf(fixtures, body.items)).toEqual(["E1", "E4", "E7", "E11"])
    })

    it("narrows by exact action, case-insensitively", async () => {
      const { body } = await read({ action: "delete_category", limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(keysOf(fixtures, body.items)).toEqual(["E2"])
    })

    it("narrows by organization, excluding the neighbour", async () => {
      const { body } = await read({
        organizationId: fixtures.organizationId,
        limit: ACTIVITY_PAGE_SIZE_MAX,
      })
      const keys = keysOf(fixtures, body.items)
      expect(keys).not.toContain("E10")
      expect(keys).not.toContain("E11")
      // E12 carries no organization, so an organization filter excludes it too.
      expect(keys).not.toContain("E12")
      expect(keys).toContain("E2")
    })

    it("narrows by branch, and drops the source that has no branch column", async () => {
      const { body } = await read({ branchId: fixtures.northBranchId, limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(keysOf(fixtures, body.items)).toEqual(["E1", "E4", "E7"])
    })

    it("narrows by actor across the uuid and varchar columns alike", async () => {
      const bySuperAdmin = await read({ actorId: fixtures.superAdminId, limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(keysOf(fixtures, bySuperAdmin.body.items)).toEqual(["E2", "E5", "E8", "E10", "E12"])

      const byEmployee = await read({ actorId: `emp_${fixtures.suffix}`, limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(keysOf(fixtures, byEmployee.body.items)).toEqual(["E7"])
    })

    it("narrows to failures, which only one source records", async () => {
      const { body } = await read({ outcome: "failure", limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(keysOf(fixtures, body.items)).toEqual(["E1"])
    })

    it("searches action, entity and actor without treating a wildcard as one", async () => {
      const byAction = await read({ search: "supplier", limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(keysOf(fixtures, byAction.body.items)).toEqual(["E6", "E10"])

      const byEmail = await read({ search: "headoffice", limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(keysOf(fixtures, byEmail.body.items)).toEqual(["E3", "E6"])

      // `%` is a literal here, not "match everything".
      const wildcard = await read({ search: "%", limit: ACTIVITY_PAGE_SIZE_MAX })
      expect(wildcard.body.items).toHaveLength(0)
    })

    it("combines filters", async () => {
      const { body } = await read({
        source: "audit",
        operation: "delete",
        organizationId: fixtures.organizationId,
        limit: ACTIVITY_PAGE_SIZE_MAX,
      })
      expect(keysOf(fixtures, body.items)).toEqual(["E2"])
    })

    it("returns an empty page when the filters exclude every source", async () => {
      // Failures live only in `system_logs`, and that is the source excluded.
      const { status, body } = await read({ source: "audit", outcome: "failure" })
      expect(status).toBe(200)
      expect(body.items).toEqual([])
      expect(body.hasMore).toBe(false)
    })
  })

  describe("bounds", () => {
    beforeAll(() => signIn(superAdmin(fixtures)))

    it("refuses a window longer than the maximum instead of truncating it", async () => {
      const from = new Date(WINDOW.to.getTime() - (ACTIVITY_MAX_WINDOW_DAYS + 5) * 86_400_000)
      const response = await activityRoute.GET(
        new NextRequest(
          `http://localhost/api/v1/activity-logs?from=${from.toISOString()}&to=${WINDOW.to.toISOString()}`,
        ),
      )
      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(/exceed/i)
    })

    it("refuses a limit above the maximum", async () => {
      const { status } = await read({ limit: ACTIVITY_PAGE_SIZE_MAX + 1 })
      expect(status).toBe(400)
    })

    it("refuses an unknown query parameter rather than ignoring it", async () => {
      const { status, body } = await read({ organisationId: 1 })
      expect(status).toBe(400)
      expect(body.error).toBeTruthy()
    })

    it("refuses a reversed range", async () => {
      const response = await activityRoute.GET(
        new NextRequest(
          `http://localhost/api/v1/activity-logs?from=${WINDOW.to.toISOString()}&to=${WINDOW.from.toISOString()}`,
        ),
      )
      expect(response.status).toBe(400)
    })
  })

  describe("the writer and the reader, end to end", () => {
    it("shows a category create, update and delete driven through the real route", async () => {
      signIn(superAdmin(fixtures))
      const name = `Activity Audit Category ${fixtures.suffix}`

      const created = await categoriesRoute.POST(
        new NextRequest("http://localhost/api/v1/categories", {
          method: "POST",
          body: JSON.stringify({ name }),
          headers: { "content-type": "application/json" },
        }),
      )
      expect(created.status).toBe(201)
      const categoryId: number = (await created.json()).item.id

      const renamed = `${name} Renamed`
      const updated = await categoriesRoute.PUT(
        new NextRequest("http://localhost/api/v1/categories", {
          method: "PUT",
          body: JSON.stringify({ id: categoryId, name: renamed }),
          headers: { "content-type": "application/json" },
        }),
      )
      expect(updated.status).toBe(200)

      const removed = await categoriesRoute.DELETE(
        new NextRequest(`http://localhost/api/v1/categories?id=${categoryId}`, { method: "DELETE" }),
      )
      expect(removed.status).toBe(200)

      try {
        // Read them back through the screen's own endpoint, over a window that
        // contains "now" rather than the fixture day.
        const response = await activityRoute.GET(
          new NextRequest(
            `http://localhost/api/v1/activity-logs?search=${encodeURIComponent(String(categoryId))}&source=audit&limit=50`,
          ),
        )
        expect(response.status).toBe(200)
        const page = (await response.json()) as ActivityLogPage

        const mine = page.items.filter((item) => item.entityId === String(categoryId))
        expect(mine.map((item) => item.action)).toEqual([
          "DELETE_CATEGORY",
          "UPDATE_CATEGORY",
          "CREATE_CATEGORY",
        ])
        expect(mine.map((item) => item.operation)).toEqual(["delete", "update", "create"])

        const update = mine.find((item) => item.action === "UPDATE_CATEGORY")
        const metadata = update?.metadata as { before?: { name?: string }; after?: { name?: string } }
        expect(metadata.before?.name).toBe(name)
        expect(metadata.after?.name).toBe(renamed)

        const create = mine.find((item) => item.action === "CREATE_CATEGORY")
        expect(create?.actor.id).toBe(fixtures.superAdminId)
        expect(create?.entity).toBe("category")
      } finally {
        await db.delete(auditLogs).where(eq(auditLogs.entityId, String(categoryId)))
        await db.delete(categories).where(eq(categories.id, categoryId))
      }
    })

    it("records a support thread, its reply and its status change, from the shared module", async () => {
      // `lib/server/support-threads.ts` is where three routes' audit rows are
      // written, so this exercises the module rather than each route — the same
      // pattern as `fulfillApprovedOrder`.
      const { createSupportThread, postSupportMessage, updateSupportThread } = await import(
        "@/lib/server/support-threads"
      )

      const author = {
        userId: fixtures.branchAdminId,
        role: "BRANCH_ADMIN" as const,
        organizationId: fixtures.organizationId,
        branchId: fixtures.northBranchId,
        fullName: `Activity branchadmin ${fixtures.suffix}`,
      }

      const created = await createSupportThread({
        author,
        subject: `Activity audit thread ${fixtures.suffix}`,
        category: "OTHER",
        priority: "NORMAL",
        body: "This body must never reach the audit trail.",
        orderId: null,
        productId: null,
        attachmentIds: [],
      })
      expect(created.ok).toBe(true)
      if (!created.ok) return
      const threadId = created.threadId

      try {
        const replied = await postSupportMessage({
          author,
          threadId,
          body: "A reply.",
          attachmentIds: [],
        })
        expect(replied.ok).toBe(true)

        const updated = await updateSupportThread(
          { actor: author, threadId, priority: "HIGH" },
          () => ({ ok: true as const }),
        )
        expect(updated.ok).toBe(true)

        const rows = await db
          .select({ action: auditLogs.action, metadata: auditLogs.metadata })
          .from(auditLogs)
          .where(and(eq(auditLogs.entity, "support_thread"), eq(auditLogs.entityId, String(threadId))))
          .orderBy(auditLogs.id)

        expect(rows.map((row) => row.action)).toEqual([
          "CREATE_SUPPORT_THREAD",
          "REPLY_SUPPORT_THREAD",
          "UPDATE_SUPPORT_THREAD",
        ])

        // The customer's words stay out of the trail; the change to the thread
        // does not.
        expect(JSON.stringify(rows)).not.toContain("must never reach the audit trail")
        const priorityChange = rows[2].metadata as { before?: { priority?: string }; after?: { priority?: string } }
        expect(priorityChange.before?.priority).toBe("NORMAL")
        expect(priorityChange.after?.priority).toBe("HIGH")
      } finally {
        await db.delete(auditLogs).where(
          and(eq(auditLogs.entity, "support_thread"), eq(auditLogs.entityId, String(threadId))),
        )
        await db.delete(supportThreadReads).where(eq(supportThreadReads.threadId, threadId))
        await db.delete(supportMessages).where(eq(supportMessages.threadId, threadId))
        await db.delete(emailOutbox).where(eq(emailOutbox.supportThreadId, threadId))
        await db.delete(supportThreads).where(eq(supportThreads.id, threadId))
      }
    })

    it("rolls the business change back when its audit row cannot be written", async () => {
      const name = `Activity Rollback Category ${fixtures.suffix}`

      // The guarantee under test is the one the review asked for: the audit
      // write is not "best effort". An entity id longer than the column holds
      // makes the write fail for real — no mock — and the category must not
      // survive it, because both are in the one transaction.
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(categories).values({ name, parentId: null, organizationId: null })
          await recordAuditEvent(tx, {
            action: "CREATE_CATEGORY",
            entity: "category",
            entityId: "x".repeat(MAX_AUDIT_ENTITY_ID_LENGTH + 1),
            actor: { id: fixtures.superAdminId },
          })
        }),
      ).rejects.toThrow()

      const [survivor] = await db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.name, name))
        .limit(1)
      expect(survivor).toBeUndefined()
    })
  })
})

describe.skipIf(hasTestDatabase)("activity log endpoint integration suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})
