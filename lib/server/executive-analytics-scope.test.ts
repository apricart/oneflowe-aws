import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Security tests for the Executive Analytics Center's authorization boundary.
 *
 * These exercise the real `resolveExecutiveScope` against a stubbed database,
 * because the property under test is not "does SQL run" but "which branch set
 * does the caller end up fenced to" — and that decision is made entirely in
 * this module, before any query is built.
 */

vi.mock("server-only", () => ({}))
// `cache-utils` pulls in the Redis client, which validates the whole server
// environment on import. The key builder under test needs neither.
vi.mock("@/lib/redis", () => ({ redis: {} }))

type UserRow = { organizationId: number | null; branchId: number | null; roleName: string | null }

const fixture = {
  user: null as UserRow | null,
  /** branchId -> organizationId, the whole world of branches. */
  branches: new Map<number, number>(),
}

/**
 * A chainable stand-in for drizzle. It answers the two shapes this module
 * issues — the caller lookup and the tenant branch list — and resolves from the
 * fixture rather than a database.
 */
function makeQuery(table: "users" | "branches") {
  let organizationFilter: number[] | null = null

  const chain: any = {
    from: () => chain,
    leftJoin: () => chain,
    where: (condition: any) => {
      if (table === "branches") organizationFilter = condition?.__orgIds ?? null
      return chain
    },
    limit: () => chain,
    orderBy: () => chain,
    then: (resolve: (rows: any[]) => unknown) => {
      if (table === "users") return resolve(fixture.user ? [fixture.user] : [])
      const rows = Array.from(fixture.branches.entries())
        .filter(([, orgId]) => organizationFilter === null || organizationFilter.includes(orgId))
        .map(([id]) => ({ id }))
      return resolve(rows)
    },
  }
  return chain
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (table: any) => makeQuery(table?.__tableName === "users" ? "users" : "branches"),
    }),
  },
}))

// `inArray(branches.organizationId, ids)` is the only condition the module
// builds for the branch lookup, so tagging it is enough to model the filter.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>()
  return {
    ...actual,
    inArray: (column: any, values: any[]) => ({ __orgIds: values, __column: column }),
    eq: (...args: any[]) => ({ __eq: args }),
    and: (...args: any[]) => args.find((entry) => entry?.__orgIds) ?? { __and: args },
  }
})

vi.mock("@/db/schema", () => ({
  users: { __tableName: "users", organizationId: {}, branchId: {}, roleId: {}, id: {} },
  roles: { __tableName: "roles", id: {}, name: {} },
  branches: {
    __tableName: "branches",
    id: {},
    name: {},
    organizationId: { __column: "branches.organizationId" },
    groupId: {},
    baselineBudgetCents: {},
  },
}))

import { resolveExecutiveScope } from "./executive-analytics-scope"

const TENANT_A = 1
const TENANT_B = 2

function seed() {
  fixture.branches = new Map([
    [10, TENANT_A],
    [11, TENANT_A],
    [12, TENANT_A],
    [90, TENANT_B],
    [91, TENANT_B],
  ])
}

const session = (id = "user-1", role = "HEAD_OFFICE") => ({ user: { id, role } })
const params = (query = "") => new URLSearchParams(query)

beforeEach(() => {
  seed()
  fixture.user = null
})

describe("tenant isolation", () => {
  it("confines a head office user to its own tenant's branches", async () => {
    fixture.user = { organizationId: TENANT_A, branchId: null, roleName: "HEAD_OFFICE" }

    const scope = await resolveExecutiveScope(session(), params())

    expect(scope.ok).toBe(true)
    if (!scope.ok) return
    expect(scope.organizationIds).toEqual([TENANT_A])
    expect(scope.branchIds).toEqual([10, 11, 12])
    expect(scope.branchIds).not.toContain(90)
  })

  it("ignores an organizationId pointing at another tenant", async () => {
    fixture.user = { organizationId: TENANT_A, branchId: null, roleName: "HEAD_OFFICE" }

    const scope = await resolveExecutiveScope(session(), params(`organizationId=${TENANT_B}`))

    expect(scope.ok).toBe(true)
    if (!scope.ok) return
    // The requested tenant is discarded outright, not merged.
    expect(scope.organizationIds).toEqual([TENANT_A])
    expect(scope.branchIds).toEqual([10, 11, 12])
  })

  it("drops another tenant's branch ids instead of honouring them", async () => {
    fixture.user = { organizationId: TENANT_A, branchId: null, roleName: "HEAD_OFFICE" }

    const scope = await resolveExecutiveScope(session(), params("branchIds=10,90,91"))

    expect(scope.ok).toBe(true)
    if (!scope.ok) return
    expect(scope.branchIds).toEqual([10])
  })

  it("denies rather than widening when every requested branch is foreign", async () => {
    fixture.user = { organizationId: TENANT_A, branchId: null, roleName: "HEAD_OFFICE" }

    const scope = await resolveExecutiveScope(session(), params("branchIds=90,91"))

    expect(scope).toEqual({ ok: false, error: "No branches in scope", status: 403 })
  })
})

describe("role gate", () => {
  it.each([
    ["BRANCH_ADMIN"],
    ["ORDER_PORTAL"],
    ["GROUP_USER"],
    ["GROUP_ORDER_PORTAL"],
  ])("refuses %s before any query runs", async (role) => {
    fixture.user = { organizationId: TENANT_A, branchId: 10, roleName: role }

    const scope = await resolveExecutiveScope(session("user-1", role), params())

    expect(scope).toEqual({ ok: false, error: "Forbidden: Insufficient permissions", status: 403 })
  })

  it("refuses a branch admin that claims HEAD_OFFICE in its session", async () => {
    // The database row is the truth; the session claim is only a fallback.
    fixture.user = { organizationId: TENANT_A, branchId: 10, roleName: "BRANCH_ADMIN" }

    const scope = await resolveExecutiveScope(session("user-1", "HEAD_OFFICE"), params())

    expect(scope.ok).toBe(false)
  })

  it("refuses an unauthenticated caller", async () => {
    const scope = await resolveExecutiveScope(null, params())
    expect(scope).toEqual({ ok: false, error: "Unauthorized", status: 401 })
  })

  it("refuses a head office user with no tenant on its row", async () => {
    fixture.user = { organizationId: null, branchId: null, roleName: "HEAD_OFFICE" }

    const scope = await resolveExecutiveScope(session(), params())

    expect(scope).toEqual({ ok: false, error: "Organization context missing", status: 403 })
  })
})

describe("super admin scope", () => {
  it("sees every branch when no tenant is selected", async () => {
    fixture.user = { organizationId: null, branchId: null, roleName: "SUPER_ADMIN" }

    const scope = await resolveExecutiveScope(session("admin", "SUPER_ADMIN"), params())

    expect(scope.ok).toBe(true)
    if (!scope.ok) return
    expect(scope.branchIds).toBeNull()
    expect(scope.organizationIds).toEqual([])
  })

  it("narrows to the selected tenant", async () => {
    fixture.user = { organizationId: null, branchId: null, roleName: "SUPER_ADMIN" }

    const scope = await resolveExecutiveScope(session("admin", "SUPER_ADMIN"), params(`organizationId=${TENANT_B}`))

    expect(scope.ok).toBe(true)
    if (!scope.ok) return
    expect(scope.organizationIds).toEqual([TENANT_B])
    expect(scope.branchIds).toEqual([90, 91])
  })
})

describe("cache isolation", () => {
  it("keys two tenants' identical requests differently", async () => {
    const { executiveCacheKey } = await import("./executive-analytics-scope")

    fixture.user = { organizationId: TENANT_A, branchId: null, roleName: "HEAD_OFFICE" }
    const scopeA = await resolveExecutiveScope(session("a"), params())
    fixture.user = { organizationId: TENANT_B, branchId: null, roleName: "HEAD_OFFICE" }
    const scopeB = await resolveExecutiveScope(session("b"), params())

    expect(scopeA.ok && scopeB.ok).toBe(true)
    if (!scopeA.ok || !scopeB.ok) return

    const filters = { metric: "spend", start: "2026-01-01" }
    expect(executiveCacheKey("exec:overview", scopeA, filters))
      .not.toEqual(executiveCacheKey("exec:overview", scopeB, filters))
  })

  it("keys a narrowed branch selection apart from the full tenant", async () => {
    const { executiveCacheKey } = await import("./executive-analytics-scope")

    fixture.user = { organizationId: TENANT_A, branchId: null, roleName: "HEAD_OFFICE" }
    const wide = await resolveExecutiveScope(session(), params())
    const narrow = await resolveExecutiveScope(session(), params("branchIds=10"))

    expect(wide.ok && narrow.ok).toBe(true)
    if (!wide.ok || !narrow.ok) return

    expect(executiveCacheKey("exec:overview", wide, {}))
      .not.toEqual(executiveCacheKey("exec:overview", narrow, {}))
  })
})
