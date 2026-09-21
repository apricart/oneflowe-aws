import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Contract tests for the watchlist's aggregate and its route.
 *
 * The behaviour is exercised for real in
 * `tests/integration/budget-burn-api.test.ts`; these pin the *shape* of the
 * code, which is what a later edit is most likely to loosen without noticing:
 * the fence it borrows, the grain it keeps, the statuses it counts, and the
 * order the route checks things in. Read as source, line endings normalized so
 * the assertions hold on a CRLF checkout.
 */
const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")

const queries = source("lib/server/budget-burn-queries.ts")
const route = source("app/api/v1/analytics/executive/budget-burn/route.ts")
const risk = source("lib/budget-burn-risk.ts")

describe("the aggregate", () => {
  it("is server-only and fenced through the shared executive conditions, never a hand-written where", () => {
    expect(queries.startsWith('import "server-only"')).toBe(true)
    expect(queries).toContain("orderConditions(scope, filtersFor(window), { revenueEligible: false })")
    expect(queries).not.toMatch(/inArray\(orders\.branchId/)
    expect(queries).not.toMatch(/inArray\(orders\.organizationId/)
  })

  it("stays at order grain", () => {
    expect(queries).not.toContain("orderItems")
    expect(queries).toContain("GREATEST(0, ${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0))")
  })

  it("counts spend with the Center's revenue rule and pending separately", () => {
    expect(queries).toContain("REVENUE_ELIGIBLE_FILTER")
    expect(queries).toContain("UPPER(${orders.status}) = 'PENDING'")
  })

  it("counts approver rejections only — never a cancellation", () => {
    expect(queries).toContain("UPPER(${orders.status}) = 'REJECTED'")
    // The word may appear in a comment; the SQL literal may not.
    expect(queries).not.toContain("'CANCELLED'")
  })

  it("joins the two 1:1 identity tables and nothing else", () => {
    const joins = queries.match(/\.(inner|left)Join\(\w+/g) ?? []
    expect(joins).toEqual([".innerJoin(users", ".innerJoin(roles"])
  })

  it("labels a person without falling back to their email, and bounds the read", () => {
    expect(queries).not.toContain("users.email")
    expect(queries).toContain(".limit(BUDGET_BURN_QUERY_ROW_CAP)")
  })
})

describe("the route", () => {
  it("rate limits, resolves the caller's scope, then narrows the role before anything is read", () => {
    const rateLimit = route.indexOf('withRateLimit("search"')
    const scope = route.indexOf("resolveExecutiveScope(session, url.searchParams)")
    const role = route.indexOf("isBudgetBurnRole(scope.role)")
    const read = route.indexOf("loadCreatorMonth(scope")
    expect(rateLimit).toBeGreaterThan(-1)
    expect(scope).toBeGreaterThan(rateLimit)
    expect(role).toBeGreaterThan(scope)
    expect(read).toBeGreaterThan(role)
  })

  it("validates its own inputs with a schema and bounds the row limit", () => {
    expect(route).toContain("querySchema.safeParse(")
    expect(route).toContain("clampWatchlistLimit(")
    expect(route).toContain("monthWindows(month, now)")
  })

  it("never reads a branch, tenant or user id from the request itself", () => {
    // Only `month` and `limit` are this route's own; everything else reaches
    // the scope resolver untouched.
    const reads = route.match(/searchParams\.get\("(\w+)"\)/g) ?? []
    expect(reads.sort()).toEqual(['searchParams.get("limit")', 'searchParams.get("month")'])
  })

  it("answers an unexpected failure through the shared handler, never a raw message", () => {
    expect(route).toContain('handleError(error, "EXECUTIVE_BUDGET_BURN")')
    expect(route).not.toContain("error.message")
    expect(route).not.toContain("console.")
  })
})

describe("the role list", () => {
  it("admits the two tenant-wide administrative roles and no other, by name", () => {
    expect(risk).toContain('export const BUDGET_BURN_ROLES = ["SUPER_ADMIN", "HEAD_OFFICE"] as const')
  })
})
