import { describe, expect, it } from "vitest"

import {
  ACTIVITY_MAX_WINDOW_DAYS,
  ACTIVITY_PAGE_SIZE_DEFAULT,
  ACTIVITY_PAGE_SIZE_MAX,
  ACTIVITY_SEARCH_MAX_LENGTH,
  MS_PER_DAY,
  encodeActivityCursor,
} from "@/lib/activity-log"
import { parseActivityLogRequest } from "@/lib/activity-log-request"

/**
 * The query string, validated.
 *
 * Every bound the endpoint promises is asserted here rather than in the
 * integration suite, because none of them needs a database and a refusal is
 * cheaper to get right when it is cheap to test.
 */

const NOW = new Date("2026-09-26T12:00:00.000Z")

function parse(query: string) {
  return parseActivityLogRequest(new URLSearchParams(query), NOW)
}

function filtersOf(query: string) {
  const result = parse(query)
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`)
  return result.filters
}

describe("defaults", () => {
  it("bounds the first read to the recent past", () => {
    const filters = filtersOf("")
    expect(filters.to).toEqual(NOW)
    expect((NOW.getTime() - filters.from.getTime()) / MS_PER_DAY).toBe(7)
    expect(filters.limit).toBe(ACTIVITY_PAGE_SIZE_DEFAULT)
  })

  it("leaves every filter off", () => {
    expect(filtersOf("")).toMatchObject({
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
    })
  })
})

describe("the window", () => {
  it("accepts an explicit range", () => {
    const filters = filtersOf("from=2026-09-01T00:00:00.000Z&to=2026-09-10T00:00:00.000Z")
    expect(filters.from.toISOString()).toBe("2026-09-01T00:00:00.000Z")
    expect(filters.to.toISOString()).toBe("2026-09-10T00:00:00.000Z")
  })

  it("refuses a range beyond the maximum instead of truncating it", () => {
    const to = new Date("2026-09-20T00:00:00.000Z")
    const from = new Date(to.getTime() - (ACTIVITY_MAX_WINDOW_DAYS + 1) * MS_PER_DAY)
    const result = parse(`from=${from.toISOString()}&to=${to.toISOString()}`)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("exceed") })
  })

  it("refuses a reversed range", () => {
    const result = parse("from=2026-09-10T00:00:00.000Z&to=2026-09-01T00:00:00.000Z")
    expect(result).toMatchObject({ ok: false, field: "from" })
  })

  it("refuses an unparseable date and names the field", () => {
    expect(parse("from=yesterday")).toMatchObject({ ok: false, field: "from" })
    expect(parse("to=2026-13-45")).toMatchObject({ ok: false, field: "to" })
  })

  it("takes only `from`, defaulting the end to now", () => {
    const filters = filtersOf("from=2026-09-25T00:00:00.000Z")
    expect(filters.to).toEqual(NOW)
  })
})

describe("the limit", () => {
  it("accepts a value in range", () => {
    expect(filtersOf("limit=10").limit).toBe(10)
    expect(filtersOf(`limit=${ACTIVITY_PAGE_SIZE_MAX}`).limit).toBe(ACTIVITY_PAGE_SIZE_MAX)
  })

  it("refuses a value above the maximum", () => {
    // An unbounded limit is both a denial-of-service and an exfiltration path,
    // so it is refused rather than silently clamped.
    expect(parse(`limit=${ACTIVITY_PAGE_SIZE_MAX + 1}`)).toMatchObject({ ok: false, field: "limit" })
    expect(parse("limit=100000")).toMatchObject({ ok: false })
  })

  it("refuses zero, a negative, and a non-number", () => {
    expect(parse("limit=0")).toMatchObject({ ok: false })
    expect(parse("limit=-5")).toMatchObject({ ok: false })
    expect(parse("limit=lots")).toMatchObject({ ok: false })
  })
})

describe("the cursor", () => {
  it("accepts one the encoder produced", () => {
    const cursor = { occurredAtMs: Date.parse("2026-09-20T00:00:00.000Z"), source: "system" as const, id: 7 }
    expect(filtersOf(`cursor=${encodeActivityCursor(cursor)}`).cursor).toEqual(cursor)
  })

  it("refuses a malformed one rather than silently restarting the list", () => {
    // Silently returning page one would read as new activity to whoever is paging.
    expect(parse("cursor=nonsense")).toMatchObject({ ok: false, field: "cursor" })
  })
})

describe("filters", () => {
  it("takes one source or several", () => {
    expect(filtersOf("source=group").sources).toEqual(["group"])
    expect(filtersOf("source=audit,group").sources).toEqual(["audit", "group"])
  })

  it("drops a repeated source rather than scanning twice", () => {
    expect(filtersOf("source=audit,audit").sources).toEqual(["audit"])
  })

  it("refuses an unknown source", () => {
    expect(parse("source=everything")).toMatchObject({ ok: false })
    expect(parse("source=audit,nope")).toMatchObject({ ok: false })
  })

  it("takes an operation and a category from the closed sets", () => {
    expect(filtersOf("operation=delete").operation).toBe("delete")
    expect(filtersOf("category=pricing").category).toBe("pricing")
    expect(parse("operation=destroy")).toMatchObject({ ok: false })
    expect(parse("category=everything")).toMatchObject({ ok: false })
  })

  it("maps outcome onto the boolean the query uses", () => {
    expect(filtersOf("outcome=success").success).toBe(true)
    expect(filtersOf("outcome=failure").success).toBe(false)
    expect(filtersOf("").success).toBeNull()
    expect(parse("outcome=maybe")).toMatchObject({ ok: false })
  })

  it("takes positive ids only", () => {
    expect(filtersOf("organizationId=10&branchId=3")).toMatchObject({
      organizationId: 10,
      branchId: 3,
    })
    expect(parse("organizationId=0")).toMatchObject({ ok: false })
    expect(parse("organizationId=-1")).toMatchObject({ ok: false })
    expect(parse("branchId=abc")).toMatchObject({ ok: false })
  })

  it("bounds the search term", () => {
    expect(filtersOf("search=ali").search).toBe("ali")
    expect(parse(`search=${"x".repeat(ACTIVITY_SEARCH_MAX_LENGTH + 1)}`)).toMatchObject({ ok: false })
  })

  it("keeps a search term with SQL in it as a term", () => {
    expect(filtersOf("search=%27%3B+drop+table+--").search).toBe("'; drop table --")
  })
})

describe("robustness", () => {
  it("treats an empty parameter as absent, which is how a cleared filter arrives", () => {
    const filters = filtersOf("operation=&search=&branchId=&cursor=")
    expect(filters).toMatchObject({ operation: null, search: null, branchId: null, cursor: null })
  })

  it("refuses an unknown parameter rather than ignoring it", () => {
    // A misspelled `organizationId` must not silently return an unfiltered page
    // of a cross-tenant trail.
    expect(parse("organisationId=1")).toMatchObject({ ok: false })
    expect(parse("statuses=consumed")).toMatchObject({ ok: false })
  })

  it("never returns filters on a refusal", () => {
    const result = parse("limit=99999")
    expect(result.ok).toBe(false)
    expect("filters" in result).toBe(false)
  })
})
