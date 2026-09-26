import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"

import {
  ACTIVITY_PAGE_SIZE_DEFAULT,
  ACTIVITY_SOURCES,
  CATEGORY_RULES,
  OPERATION_RULES,
  UNCLASSIFIED,
  encodeActivityCursor,
  operationOf,
  type ActivityFilters,
} from "@/lib/activity-log"
import {
  activityPageQuery,
  categoryCaseSql,
  operationCaseSql,
  sourceCanMatch,
  sourceShapeOf,
} from "@/lib/server/activity-log-sql"

/**
 * The generated SQL, rendered without a database.
 *
 * `PgDialect.sqlToQuery` gives the exact text and parameter list Postgres would
 * receive, which lets the two guarantees that matter be asserted as facts rather
 * than as intentions:
 *
 *  1. **The classification is generated from the rule tables** — one arm per
 *     rule, in table order, so the operation filter cannot disagree with the
 *     label the same rules produce in TypeScript.
 *  2. **Nothing is concatenated.** Every value arrives as a bound parameter,
 *     including the rule values themselves.
 *
 * The behaviour of the query against real rows is
 * `tests/integration/activity-log-api.test.ts`.
 */

const dialect = new PgDialect()

function render(fragment: ReturnType<typeof sql>) {
  return dialect.sqlToQuery(fragment)
}

function baseFilters(overrides: Partial<ActivityFilters> = {}): ActivityFilters {
  return {
    from: new Date("2026-09-01T00:00:00.000Z"),
    to: new Date("2026-09-08T00:00:00.000Z"),
    limit: ACTIVITY_PAGE_SIZE_DEFAULT,
    cursor: null,
    sources: null,
    operation: null,
    category: null,
    action: null,
    organizationId: null,
    branchId: null,
    actorId: null,
    success: null,
    search: null,
    ...overrides,
  }
}

describe("operationCaseSql", () => {
  const rendered = render(operationCaseSql(sql`upper(t.action)`))

  it("emits one arm per rule, in table order", () => {
    const arms = rendered.sql.match(/when /g) ?? []
    expect(arms).toHaveLength(OPERATION_RULES.length)

    // The results appear as parameters in the order the rules declare them,
    // which is what makes first-match-wins mean the same thing in both languages.
    const results = OPERATION_RULES.map((rule) => rule.result)
    const paramResults = rendered.params.filter(
      (value): value is string => typeof value === "string" && results.includes(value as never),
    )
    for (const [index, rule] of OPERATION_RULES.entries()) {
      expect(paramResults[index]).toBe(rule.result)
    }
  })

  it("falls back to the same value the TypeScript classifier does", () => {
    expect(rendered.params.at(-1)).toBe(UNCLASSIFIED.operation)
    expect(operationOf("NOTHING_MATCHES_THIS")).toBe(UNCLASSIFIED.operation)
  })

  it("passes every rule value as a parameter, never as SQL text", () => {
    for (const rule of OPERATION_RULES) {
      expect(rendered.params).toContain(rule.value)
      // The literal must not appear quoted inline anywhere in the statement.
      expect(rendered.sql).not.toContain(`'${rule.value}'`)
    }
  })

  it("avoids LIKE, whose wildcards nearly every action string contains", () => {
    // `_` is a LIKE wildcard and AUTH_LOGIN_SUCCESS has three of them.
    expect(rendered.sql.toLowerCase()).not.toContain("like")
    expect(rendered.sql).toMatch(/left\(|right\(|position\(/)
  })
})

describe("categoryCaseSql", () => {
  it("emits one arm per rule and the shared fallback", () => {
    const rendered = render(categoryCaseSql(sql`upper(t.action)`))
    expect(rendered.sql.match(/when /g) ?? []).toHaveLength(CATEGORY_RULES.length)
    expect(rendered.params.at(-1)).toBe(UNCLASSIFIED.category)
  })
})

describe("sourceCanMatch", () => {
  it("drops a source the filters exclude by name", () => {
    const filters = baseFilters({ sources: ["group"] })
    expect(sourceCanMatch(sourceShapeOf("group"), filters)).toBe(true)
    expect(sourceCanMatch(sourceShapeOf("audit"), filters)).toBe(false)
  })

  it("drops the two sources that record no outcome when failures are asked for", () => {
    const filters = baseFilters({ success: false })
    expect(sourceCanMatch(sourceShapeOf("system"), filters)).toBe(true)
    expect(sourceCanMatch(sourceShapeOf("audit"), filters)).toBe(false)
    expect(sourceCanMatch(sourceShapeOf("group"), filters)).toBe(false)
  })

  it("keeps every source when successes are asked for", () => {
    const filters = baseFilters({ success: true })
    for (const source of ACTIVITY_SOURCES) {
      expect(sourceCanMatch(sourceShapeOf(source), filters)).toBe(true)
    }
  })

  it("drops the source with no branch column when a branch is named", () => {
    const filters = baseFilters({ branchId: 7 })
    expect(sourceCanMatch(sourceShapeOf("group"), filters)).toBe(false)
    expect(sourceCanMatch(sourceShapeOf("audit"), filters)).toBe(true)
  })
})

describe("activityPageQuery", () => {
  it("unions all three tables and orders by the documented key", () => {
    const rendered = render(activityPageQuery(baseFilters()))
    expect(rendered.sql).toContain("audit_logs al")
    expect(rendered.sql).toContain("system_logs sl")
    expect(rendered.sql).toContain("group_audit_logs gal")
    expect(rendered.sql.match(/union all/g) ?? []).toHaveLength(2)
    expect(rendered.sql).toContain(
      "order by merged.occurred_at desc, merged.source_rank desc, merged.id desc",
    )
  })

  it("never uses OFFSET", () => {
    // The whole reason the cursor exists: OFFSET n re-reads and discards n rows
    // on tables that grow without bound.
    const rendered = render(activityPageQuery(baseFilters({ cursor: null })))
    expect(rendered.sql.toLowerCase()).not.toContain("offset")
  })

  it("asks for one row more than the page, and never counts", () => {
    const rendered = render(activityPageQuery(baseFilters({ limit: 25 })))
    // Three branch limits plus the outer one, all limit + 1.
    expect(rendered.params.filter((value) => value === 26)).toHaveLength(4)
    expect(rendered.sql.toLowerCase()).not.toContain("count(")
  })

  it("orders and limits inside each branch, so the union merges short streams", () => {
    const rendered = render(activityPageQuery(baseFilters()))
    expect(rendered.sql.match(/order by/g) ?? []).toHaveLength(4)
    expect(rendered.sql.match(/limit /g) ?? []).toHaveLength(4)
  })

  it("bounds every branch by the window", () => {
    const from = new Date("2026-01-01T00:00:00.000Z")
    const to = new Date("2026-01-08T00:00:00.000Z")
    const rendered = render(activityPageQuery(baseFilters({ from, to })))
    expect(rendered.params.filter((value) => value === from)).toHaveLength(3)
    expect(rendered.params.filter((value) => value === to)).toHaveLength(3)
  })

  it("pushes the cursor into every branch, and the id into only one", () => {
    const at = new Date("2026-09-05T00:00:00.000Z")
    const cursor = { occurredAtMs: at.getTime(), source: "group" as const, id: 42 }
    const rendered = render(activityPageQuery(baseFilters({ cursor })))

    // One cursor timestamp per branch, because each branch filters on its own
    // time column so each can use its own index — and twice in the cursor's own
    // branch, which compares `time < T OR (time = T AND id < I)`.
    expect(rendered.params.filter((value) => String(value) === String(at))).toHaveLength(4)
    // group is the cursor's own source, so it alone also compares the id.
    expect(rendered.params.filter((value) => value === 42)).toHaveLength(1)
  })

  it("compares an equal timestamp inclusively only for the sources not yet read", () => {
    const at = new Date("2026-09-05T00:00:00.000Z")
    const windowEnd = baseFilters().to

    // Each branch already carries `time <= $to` from the window, so three `<=`
    // are the window's. A cursor on group (rank 3, sorted first) leaves system
    // and audit rows at that same instant unread, adding two more.
    const onGroup = render(
      activityPageQuery(baseFilters({ cursor: { occurredAtMs: at.getTime(), source: "group", id: 42 } })),
    )
    expect(onGroup.sql.match(/<= \$/g) ?? []).toHaveLength(5)

    // A cursor on audit (rank 1, sorted last) means the other two were already
    // read at that instant, so neither adds an inclusive comparison.
    const onAudit = render(
      activityPageQuery(baseFilters({ cursor: { occurredAtMs: at.getTime(), source: "audit", id: 42 } })),
    )
    expect(onAudit.sql.match(/<= \$/g) ?? []).toHaveLength(3)
    expect(onAudit.params.filter((value) => String(value) === String(windowEnd))).toHaveLength(3)
  })

  it("holds a place for the cursor id only in the cursor's own branch", () => {
    const cursor = { occurredAtMs: Date.parse("2026-09-05T00:00:00.000Z"), source: "audit" as const, id: 99 }
    const rendered = render(activityPageQuery(baseFilters({ cursor })))
    expect(rendered.params.filter((value) => value === 99)).toHaveLength(1)
  })

  it("accepts a cursor the encoder produced", () => {
    const encoded = encodeActivityCursor({ occurredAtMs: 1_767_000_000_000, source: "system", id: 5 })
    expect(typeof encoded).toBe("string")
  })

  it("compares an actor id as text so an employee principal cannot break the cast", () => {
    const rendered = render(activityPageQuery(baseFilters({ actorId: "emp_42" })))
    expect(rendered.params).toContain("emp_42")
    expect(rendered.sql).toContain("::text = $")
  })

  it("searches without LIKE, so a wildcard in the term is a literal", () => {
    const rendered = render(activityPageQuery(baseFilters({ search: "50%" })))
    expect(rendered.params).toContain("50%")
    expect(rendered.sql.toLowerCase()).not.toContain("like")
  })

  it("adds the resolved actor ids to the search, as parameters", () => {
    const ids = ["11111111-1111-4111-8111-111111111111"]
    const rendered = render(activityPageQuery(baseFilters({ search: "ali", searchActorIds: ids })))
    expect(rendered.params).toContain(ids[0])
    expect(rendered.sql).not.toContain(ids[0])
  })

  it("emits no classification CASE when neither filter asks for one", () => {
    // The common read must not pay for ~60 CASE arms per branch it never uses.
    const rendered = render(activityPageQuery(baseFilters()))
    expect(rendered.sql).not.toContain("case when")
  })

  it("emits the CASE once per branch when the operation is filtered", () => {
    const rendered = render(activityPageQuery(baseFilters({ operation: "delete" })))
    expect(rendered.params.filter((value) => value === "delete").length).toBeGreaterThanOrEqual(3)
  })

  it("returns a no-row query rather than an empty union when every source is excluded", () => {
    // Failures live only in `system_logs`, and that is the source excluded.
    const rendered = render(activityPageQuery(baseFilters({ sources: ["audit"], success: false })))
    expect(rendered.sql).toContain("where false")
    expect(rendered.sql).not.toContain("union all")
  })

  it("passes every caller value as a parameter", () => {
    const rendered = render(
      activityPageQuery(
        baseFilters({
          action: "DELETE_CATEGORY",
          organizationId: 10,
          branchId: 5,
          actorId: "someone",
          search: "'; drop table audit_logs; --",
        }),
      ),
    )
    expect(rendered.params).toContain("'; DROP TABLE AUDIT_LOGS; --")
    expect(rendered.sql).not.toContain("drop table")
    expect(rendered.sql).not.toContain("DELETE_CATEGORY")
    expect(rendered.params).toContain("DELETE_CATEGORY")
  })

  it("names only the identifiers this module owns in raw text", () => {
    // `sql.raw` is used for table and column names alone. Nothing a caller sends
    // may reach it, so the raw text must be a closed vocabulary.
    const rendered = render(
      activityPageQuery(baseFilters({ search: "al\".\"secret", action: "x\"y" })),
    )
    const rawIdentifiers = rendered.sql.match(/"[a-z_]+"/g) ?? []
    const allowed = new Set([
      "id", "created_at", "timestamp", "action", "entity", "entity_id", "resource_type",
      "resource_id", "user_id", "user_role", "user_email", "organization_id", "branch_id",
      "metadata", "details", "ip_address", "user_agent", "success", "error_message",
      "group_id", "performed_by_user_id", "performed_by_role",
    ])
    for (const identifier of rawIdentifiers) {
      expect(allowed.has(identifier.replaceAll('"', ""))).toBe(true)
    }
  })
})
