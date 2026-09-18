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
type BranchRow = { organizationId: number; groupId: number | null }

const fixture = {
  user: null as UserRow | null,
  /** branchId -> its tenant and group, the whole world of branches. */
  branches: new Map<number, BranchRow>(),
  /**
   * userId -> branch ids the multi-branch resolver would return. The resolver
   * itself is covered by `multi-branch-scope.test.ts` and the group-roles
   * integration suite; here only what this module does with its answer is
   * under test.
   */
  assignments: new Map<string, number[]>(),
}

vi.mock("@/lib/server/multi-branch-scope", () => ({
  resolveScopedBranchIds: vi.fn(async (_client: unknown, userId: string) => fixture.assignments.get(userId) ?? []),
}))

/**
 * A chainable stand-in for drizzle. It answers the three shapes this module
 * issues — the caller lookup, the tenant branch list and the group member
 * list — and resolves from the fixture rather than a database.
 */
function makeQuery(table: "users" | "branches") {
  let organizationFilter: number[] | null = null
  let groupFilter: number[] | null = null

  // The module builds `inArray` predicates on the tenant and group columns,
  // alone or joined with `and`; anything else is not modelled.
  const apply = (condition: any) => {
    if (!condition) return
    if (condition.__and) {
      for (const entry of condition.__and) apply(entry)
      return
    }
    if (condition.__column === "branches.organizationId") organizationFilter = condition.__in
    if (condition.__column === "branches.groupId") groupFilter = condition.__in
  }

  const chain: any = {
    from: () => chain,
    leftJoin: () => chain,
    where: (condition: any) => {
      if (table === "branches") apply(condition)
      return chain
    },
    limit: () => chain,
    orderBy: () => chain,
    then: (resolve: (rows: any[]) => unknown) => {
      if (table === "users") return resolve(fixture.user ? [fixture.user] : [])
      const rows = Array.from(fixture.branches.entries())
        .filter(([, row]) => organizationFilter === null || organizationFilter.includes(row.organizationId))
        .filter(([, row]) => groupFilter === null || (row.groupId !== null && groupFilter.includes(row.groupId)))
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

// `inArray` on the tenant and group columns are the only conditions the module
// builds for the branch lookups, so tagging them is enough to model the filter.
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>()
  return {
    ...actual,
    inArray: (column: any, values: any[]) => ({ __in: values, __column: column?.__column }),
    eq: (...args: any[]) => ({ __eq: args }),
    and: (...args: any[]) => ({ __and: args }),
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
    groupId: { __column: "branches.groupId" },
    baselineBudgetCents: {},
  },
}))

import { resolveExecutiveScope } from "./executive-analytics-scope"

const TENANT_A = 1
const TENANT_B = 2
/** Tenant A's groups: North holds 10 and 11, South holds 12. Tenant B's Coast holds 90. */
const GROUP_NORTH = 5
const GROUP_SOUTH = 6
const GROUP_COAST = 7
/** A group with no branches at all. */
const GROUP_EMPTY = 8

function seed() {
  fixture.branches = new Map<number, BranchRow>([
    [10, { organizationId: TENANT_A, groupId: GROUP_NORTH }],
    [11, { organizationId: TENANT_A, groupId: GROUP_NORTH }],
    [12, { organizationId: TENANT_A, groupId: GROUP_SOUTH }],
    [90, { organizationId: TENANT_B, groupId: GROUP_COAST }],
    [91, { organizationId: TENANT_B, groupId: null }],
  ])
}

const session = (id = "user-1", role = "HEAD_OFFICE") => ({ user: { id, role } })
const params = (query = "") => new URLSearchParams(query)

beforeEach(() => {
  seed()
  fixture.user = null
  fixture.assignments = new Map()
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

describe("group user scope", () => {
  const groupUser = (id = "approver") => session(id, "GROUP_USER")

  beforeEach(() => {
    fixture.user = { organizationId: TENANT_A, branchId: null, roleName: "GROUP_USER" }
  })

  it("confines the approver to its assigned branches, not the tenant's list", async () => {
    fixture.assignments.set("approver", [10, 11])

    const scope = await resolveExecutiveScope(groupUser(), params())

    expect(scope.ok).toBe(true)
    if (!scope.ok) return
    expect(scope.role).toBe("GROUP_USER")
    expect(scope.organizationIds).toEqual([TENANT_A])
    expect(scope.branchIds).toEqual([10, 11])
    // Branch 12 is in the tenant but not assigned; it may not even be named.
    expect(scope.allowedBranchIds).toEqual([10, 11])
  })

  it("lets a requested branch narrow within the assignments and never beyond them", async () => {
    fixture.assignments.set("approver", [10, 11])

    const narrowed = await resolveExecutiveScope(groupUser(), params("branchIds=11"))
    expect(narrowed.ok && narrowed.branchIds).toEqual([11])

    // Branch 12 belongs to the same tenant but is not assigned: it drops out
    // rather than joining the set.
    const mixed = await resolveExecutiveScope(groupUser(), params("branchIds=10,12"))
    expect(mixed.ok && mixed.branchIds).toEqual([10])
  })

  it("denies rather than widening when every requested branch is outside the assignments", async () => {
    fixture.assignments.set("approver", [10, 11])

    expect(await resolveExecutiveScope(groupUser(), params("branchIds=12")))
      .toEqual({ ok: false, error: "No branches in scope", status: 403 })
    expect(await resolveExecutiveScope(groupUser(), params("branchIds=90,91")))
      .toEqual({ ok: false, error: "No branches in scope", status: 403 })
  })

  it("refuses an approver with no assignments instead of falling back to the tenant", async () => {
    fixture.assignments.set("approver", [])

    expect(await resolveExecutiveScope(groupUser(), params()))
      .toEqual({ ok: false, error: "No branches in scope", status: 403 })
  })

  it("drops an assignment that points at another tenant's branch", async () => {
    // A stale or inconsistent assignment row names the neighbour's branch. The
    // tenant on the user row is re-asserted, so it contributes nothing.
    fixture.assignments.set("approver", [10, 90])

    const scope = await resolveExecutiveScope(groupUser(), params())

    expect(scope.ok && scope.branchIds).toEqual([10])
    expect(scope.ok && scope.allowedBranchIds).toEqual([10])
  })

  it("ignores an organizationId pointing at another tenant", async () => {
    fixture.assignments.set("approver", [10])

    const scope = await resolveExecutiveScope(groupUser(), params(`organizationId=${TENANT_B}`))

    expect(scope.ok && scope.organizationIds).toEqual([TENANT_A])
    expect(scope.ok && scope.branchIds).toEqual([10])
  })

  it("refuses an approver with no tenant on its row", async () => {
    fixture.user = { organizationId: null, branchId: null, roleName: "GROUP_USER" }
    fixture.assignments.set("approver", [10])

    expect(await resolveExecutiveScope(groupUser(), params()))
      .toEqual({ ok: false, error: "Organization context missing", status: 403 })
  })

  it("keys two approvers with different assignments apart in the cache", async () => {
    const { executiveCacheKey } = await import("./executive-analytics-scope")

    fixture.assignments.set("approver", [10, 11])
    fixture.assignments.set("other", [11, 12])
    const first = await resolveExecutiveScope(groupUser("approver"), params())
    const second = await resolveExecutiveScope(groupUser("other"), params())

    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(executiveCacheKey("exec:overview", first, {}))
      .not.toEqual(executiveCacheKey("exec:overview", second, {}))
  })

  it("leaves Head Office on the tenant's full list, untouched by the assignment path", async () => {
    // A Head Office user never has assignment rows, and if one somehow did
    // they must not narrow it: the tenant list is its scope.
    fixture.user = { organizationId: TENANT_A, branchId: null, roleName: "HEAD_OFFICE" }
    fixture.assignments.set("user-1", [10])

    const scope = await resolveExecutiveScope(session(), params())

    expect(scope.ok && scope.branchIds).toEqual([10, 11, 12])
    expect(scope.ok && scope.allowedBranchIds).toEqual([10, 11, 12])
  })
})

describe("role gate", () => {
  it.each([
    ["BRANCH_ADMIN"],
    ["ORDER_PORTAL"],
    ["GROUP_ORDER_PORTAL"],
  ])("refuses %s before any query runs", async (role) => {
    fixture.user = { organizationId: TENANT_A, branchId: 10, roleName: role }
    // Even with assignments on file: the ordering group role has no reporting
    // surface, and no other role reads through the assignment path.
    fixture.assignments.set("user-1", [10, 11])

    const scope = await resolveExecutiveScope(session("user-1", role), params())

    expect(scope).toEqual({ ok: false, error: "Forbidden: Insufficient permissions", status: 403 })
  })

  it("refuses a group requester that claims GROUP_USER in its session", async () => {
    fixture.user = { organizationId: TENANT_A, branchId: null, roleName: "GROUP_ORDER_PORTAL" }
    fixture.assignments.set("user-1", [10, 11])

    const scope = await resolveExecutiveScope(session("user-1", "GROUP_USER"), params())

    expect(scope.ok).toBe(false)
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

describe("group selection", () => {
  const headOffice = () => {
    fixture.user = { organizationId: TENANT_A, branchId: null, roleName: "HEAD_OFFICE" }
  }

  it("narrows the tenant to the members of the selected groups", async () => {
    headOffice()

    const one = await resolveExecutiveScope(session(), params(`groupIds=${GROUP_NORTH}`))
    expect(one.ok && one.branchIds).toEqual([10, 11])

    const both = await resolveExecutiveScope(session(), params(`groupIds=${GROUP_NORTH},${GROUP_SOUTH}`))
    expect(both.ok && both.branchIds).toEqual([10, 11, 12])

    // What may be *named* is still the whole tenant: the filter list must not
    // shrink to the current selection or it could never be changed.
    expect(one.ok && one.allowedBranchIds).toEqual([10, 11, 12])
  })

  it("intersects a group with a branch selection rather than adding to it", async () => {
    headOffice()

    const inside = await resolveExecutiveScope(session(), params(`groupIds=${GROUP_NORTH}&branchIds=11`))
    expect(inside.ok && inside.branchIds).toEqual([11])

    // Branch 12 is in the tenant but not in North: naming both yields nothing,
    // and nothing is a refusal — never the tenant, never the group.
    const outside = await resolveExecutiveScope(session(), params(`groupIds=${GROUP_NORTH}&branchIds=12`))
    expect(outside).toEqual({ ok: false, error: "No branches in scope", status: 403 })
  })

  it("refuses another tenant's group and a group with no branches, instead of widening", async () => {
    headOffice()

    const foreign = await resolveExecutiveScope(session(), params(`groupIds=${GROUP_COAST}`))
    expect(foreign).toEqual({ ok: false, error: "No branches in scope", status: 403 })

    const empty = await resolveExecutiveScope(session(), params(`groupIds=${GROUP_EMPTY}`))
    expect(empty).toEqual({ ok: false, error: "No branches in scope", status: 403 })

    // A foreign group beside a legitimate one contributes nothing to the set.
    const mixed = await resolveExecutiveScope(session(), params(`groupIds=${GROUP_SOUTH},${GROUP_COAST}`))
    expect(mixed.ok && mixed.branchIds).toEqual([12])
  })

  it("keeps the approver inside its assignments even when the group reaches further", async () => {
    fixture.user = { organizationId: TENANT_A, branchId: null, roleName: "GROUP_USER" }
    fixture.assignments.set("approver", [11])

    // North holds 10 and 11; only 11 is assigned.
    const scope = await resolveExecutiveScope(session("approver", "GROUP_USER"), params(`groupIds=${GROUP_NORTH}`))
    expect(scope.ok && scope.branchIds).toEqual([11])

    // South is in the tenant but none of it is assigned.
    const unassigned = await resolveExecutiveScope(session("approver", "GROUP_USER"), params(`groupIds=${GROUP_SOUTH}`))
    expect(unassigned).toEqual({ ok: false, error: "No branches in scope", status: 403 })
  })

  it("is a narrowing for a super admin, never the unrestricted case", async () => {
    fixture.user = { organizationId: null, branchId: null, roleName: "SUPER_ADMIN" }

    const noTenant = await resolveExecutiveScope(session("admin", "SUPER_ADMIN"), params(`groupIds=${GROUP_COAST}`))
    expect(noTenant.ok && noTenant.branchIds).toEqual([90])

    // With a tenant selected, a group from another tenant is not reachable
    // even for the platform role.
    const crossed = await resolveExecutiveScope(
      session("admin", "SUPER_ADMIN"),
      params(`organizationId=${TENANT_A}&groupIds=${GROUP_COAST}`),
    )
    expect(crossed).toEqual({ ok: false, error: "No branches in scope", status: 403 })
  })

  it("ignores malformed group ids rather than failing on them", async () => {
    headOffice()
    const scope = await resolveExecutiveScope(session(), params("groupIds=abc,-1,0"))
    // Nothing valid was asked for, so no narrowing applies.
    expect(scope.ok && scope.branchIds).toEqual([10, 11, 12])
  })

  it("bounds the group list as the filter parser does, so the two cannot disagree", async () => {
    headOffice()
    // North's group sits past the cap: it is dropped, and with every group
    // that survives being empty the request is refused rather than widened.
    const past = Array.from({ length: 100 }, (_, index) => 1000 + index).concat(GROUP_NORTH).join(",")
    expect(await resolveExecutiveScope(session(), params(`groupIds=${past}`)))
      .toEqual({ ok: false, error: "No branches in scope", status: 403 })
    // Inside the cap it is honoured.
    const within = Array.from({ length: 99 }, (_, index) => 1000 + index).concat(GROUP_NORTH).join(",")
    const scope = await resolveExecutiveScope(session(), params(`groupIds=${within}`))
    expect(scope.ok && scope.branchIds).toEqual([10, 11])
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
