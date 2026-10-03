import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * The control for `orders.created_by_role`.
 *
 * A user's role can now be changed from the admin UI. Every report that groups
 * orders by the *requester role* therefore has to read the role recorded on the
 * order, not the creator's role today — otherwise promoting one Order Portal
 * user silently rewrites months of history in four separate reports at once.
 *
 * This file is the list. A reader that keys on the creator's role and is not
 * named here is free to drift, so a new one goes on the list with the rest.
 */

/** Every write path that creates an `orders` row. */
const ORDER_WRITE_PATHS = [
  "app/api/v1/orders/route.ts",
  "lib/server/group-order-creation.ts",
  "scripts/import-ke-orders.ts",
] as const

/** Every reader that decides something from the creator's role. */
const CREATOR_ROLE_READER_PATHS = [
  "app/api/v1/orders/route.ts",
  "app/api/v1/analytics/users/performance/route.ts",
  "app/api/v1/analytics/users/list/route.ts",
  "lib/server/budget-burn-queries.ts",
] as const

describe("every order records the role its creator held", () => {
  it("sets created_by_role on every path that inserts an order", () => {
    for (const path of ORDER_WRITE_PATHS) {
      expect(source(path), `${path} must record the creator's role`)
        .toMatch(/created_?[Bb]y_?[Rr]ole/)
    }
  })

  it("takes the role from the acting session, never from request input", () => {
    // A client-supplied creator role would be a mass-assignment hole: it decides
    // which reports the order appears in.
    expect(source("app/api/v1/orders/route.ts")).toContain("createdByRole: context.role")
    expect(source("lib/server/group-order-creation.ts")).toContain("createdByRole: context.actor.role")
  })

  it("stamps the KE import with the only role it resolves a user to", () => {
    const importer = source("scripts/import-ke-orders.ts")
    expect(importer).toContain("r.name = 'ORDER_PORTAL'")
    expect(importer).toContain("'ORDER_PORTAL', x.created_at")
  })
})

describe("every reader resolves the creator role through one module", () => {
  it("routes each reader through lib/server/order-creator-role-sql", () => {
    for (const path of CREATOR_ROLE_READER_PATHS) {
      expect(source(path), `${path} must resolve the creator role through the shared module`)
        .toContain("@/lib/server/order-creator-role-sql")
    }
  })

  it("no reader rebuilds the fallback with its own COALESCE", () => {
    // Stated once or it will be stated differently twice.
    for (const path of CREATOR_ROLE_READER_PATHS) {
      expect(source(path), `${path} must not hand-write the fallback`)
        .not.toMatch(/COALESCE\(\s*\$\{?orders\.createdByRole/)
    }
  })

  it("keeps the fallback to the live join, so pre-migration history is not dropped", () => {
    const sqlModule = source("lib/server/order-creator-role-sql.ts")
    expect(sqlModule).toContain("COALESCE(${orders.createdByRole}, ${roles.name})")
    // Treating NULL as "not a requester" would empty every attribution report
    // of its entire pre-migration history the moment this shipped.
    expect(sqlModule).toContain("isNull(orders.createdByRole)")
  })
})

/**
 * These are the assertions that used to live in
 * `group-order-cross-role-visibility.test.ts` against the live-role expression.
 * The guarantee is unchanged — both requester roles count, ORDER_PORTAL is
 * never named alone — only the expression carrying it has moved.
 */
describe("attribution reports still recognise both requester roles", () => {
  it("counts both in user performance, and names neither alone", () => {
    const performance = source("app/api/v1/analytics/users/performance/route.ts")
    expect(performance).toContain("isRequesterCreatedOrderSql")
    expect(performance).not.toContain('eq(roles.name, "ORDER_PORTAL")')
  })

  it("builds the requester-role predicate from ORDER_CREATOR_ROLES, not a literal list", () => {
    const sqlModule = source("lib/server/order-creator-role-sql.ts")
    expect(sqlModule).toContain("ORDER_CREATOR_ROLES")
    expect(sqlModule).not.toMatch(/"ORDER_PORTAL",\s*"GROUP_ORDER_PORTAL"/)
  })

  it("keeps the requester filter list a union of current role and recorded history", () => {
    const list = source("app/api/v1/analytics/users/list/route.ts")
    // Current role alone drops a promoted requester and their history with them;
    // recorded role alone drops someone who has not ordered yet. Both arms.
    expect(list).toContain("inArray(roles.name, [...ORDER_CREATOR_ROLES])")
    expect(list).toContain("hasRaisedOrderAsRequesterSql")
    expect(list).not.toContain('eq(roles.name, "ORDER_PORTAL")')
    // The branch predicate a multi-branch requester needs is not disturbed.
    expect(list).toContain("resolveUsersScopedToBranches(db, branchIds)")
  })

  it("finds a branch's past requesters from the orders, not from assignments alone", () => {
    const list = source("app/api/v1/analytics/users/list/route.ts")
    // Assignments are deleted when a user leaves a group role, and
    // `users.branch_id` moves when a user is reassigned. Without the orders arm
    // a former group requester's orders stay in the branch's totals while the
    // person disappears from the filter meant to select them.
    expect(list).toContain("raisedOrderAtBranchesSql(branchIds)")

    const sqlModule = source("lib/server/order-creator-role-sql.ts")
    expect(sqlModule).toContain("inArray(orders.branchId, branchIds)")
    // An empty branch list must match nothing, never everything.
    expect(sqlModule).toContain("if (branchIds.length === 0) return sql`false`")
  })

  it("lists the watchlist by the recorded role while every creator still counts", () => {
    const queries = source("lib/server/budget-burn-queries.ts")
    // Not the live role — a promoted requester would drop off the panel taking
    // their consumption history with them while the branch denominators kept
    // counting it. And not the per-row recorded role either: see the aggregate
    // block below, which is where that distinction is pinned down.
    expect(queries).toContain("aggregatedRequesterRoleSql")
    expect(queries).not.toContain("role: roles.name")
  })

  it("narrows the orders list tab by the recorded role", () => {
    const orders = source("app/api/v1/orders/route.ts")
    expect(orders).toContain("orderCreatedByRoleMatches(creatorRole)")
  })
})

/**
 * The aggregate that keeps one row per creator.
 *
 * This is the control for a defect that only appears once the role-switch
 * feature is used: with a per-row role in the `GROUP BY`, a person whose role
 * changed mid-window split into two rows, and because the panel keys creators on
 * `userId:branchId` (`creatorKey`) `unionCreators` then dropped one of them and
 * understated what that person consumed.
 */
describe("the budget-burn aggregate emits one row per creator", () => {
  it("selects an aggregated role and groups by no role at all", () => {
    const queries = source("lib/server/budget-burn-queries.ts")
    expect(queries).toContain("role: aggregatedRequesterRoleSql")
    // A per-row expression in the GROUP BY is exactly what splits a creator.
    const groupBy = queries.slice(queries.indexOf(".groupBy("), queries.indexOf(".orderBy("))
    expect(groupBy).not.toContain("effectiveCreatorRoleSql")
    expect(groupBy).not.toContain("roles.name")
    expect(groupBy).not.toContain("createdByRole")
  })

  it("prefers a requester role, so a mid-window promotion is still listed", () => {
    const sqlModule = source("lib/server/order-creator-role-sql.ts")
    const fragment = sqlModule.slice(sqlModule.indexOf("aggregatedRequesterRoleSql"))
    // MAX over the requester-only CASE first, then MAX over everything as the
    // fallback — one value per group either way.
    expect(fragment).toContain("MAX(CASE WHEN")
    expect(fragment).toContain("COALESCE(")
    expect(fragment).toContain("roleTuple(ORDER_CREATOR_ROLES)")
  })

  it("keeps the per-row expression for the readers that need one", () => {
    // `effectiveCreatorRoleSql` is still correct row by row — it is only unsafe
    // inside a GROUP BY. The two must not be collapsed into one another.
    const sqlModule = source("lib/server/order-creator-role-sql.ts")
    expect(sqlModule).toContain("export const effectiveCreatorRoleSql")
    expect(sqlModule).toContain("export const aggregatedRequesterRoleSql")
  })
})

/**
 * Notifications are the deliberate exception and must stay that way.
 */
describe("order notifications keep reading the live role", () => {
  it("still asks who the creator is today, not who they were", () => {
    const notifications = source("lib/server/order-notifications.ts")
    // Deciding who to notify *now* is a question about the person's present
    // role. Pinning it to the order's history would address a stale portal.
    expect(notifications).toContain("inArray(roles.name, [...ORDER_CREATOR_ROLES])")
    expect(notifications).not.toContain("@/lib/server/order-creator-role-sql")
  })
})
