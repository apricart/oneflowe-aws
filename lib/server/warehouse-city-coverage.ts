import "server-only"

import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm"

import { branches, roles, users, warehouseAssignments, warehouseCityAssignments } from "@/db/schema"
import { db } from "@/lib/db"
import { recordAuditEvent } from "@/lib/server/activity-audit"
import { branchCityKeySql } from "@/lib/server/branch-city-key"
import { WAREHOUSE_ASSIGNMENT_AUDIT_ACTION, WAREHOUSE_ROLE } from "@/lib/warehouse-access"

/**
 * Which Apricart warehouse serves a city, and attaching a branch a department
 * sign-up has just created to it (plans/OF-JOIN-new-branch-city-warehouse.md).
 *
 * A warehouse serves a city when it is an active, undeleted `WAREHOUSE`
 * account that either holds the city as a whole (`warehouse_city_assignments`)
 * or is assigned one by one to an active branch in it — in any organization,
 * because a warehouse's reach is geography, not a tenant. Cities are matched
 * only by `branchCityKeySql`, in SQL, on both sides.
 *
 * Neither function ever returns a warehouse account to its caller: Head Office
 * is told how many serve a city, never who.
 */

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]
type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Every active, undeleted warehouse account; the set "serves" is judged within. */
function activeWarehouseAccounts(executor: Executor) {
  return executor
    .select({ id: users.id })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(roles.name, WAREHOUSE_ROLE), eq(users.isActive, true), isNull(users.deletedAt)))
}

/**
 * The listed cities an active warehouse serves, each with how many do. For
 * Head Office's review: a city not in the answer is served by none.
 */
export async function loadWarehouseServedCities(
  executor: Executor,
  cityNames: readonly string[],
): Promise<Array<{ city: string; warehouseCount: number }>> {
  if (cityNames.length === 0) return []
  const listed = sql`unnest(ARRAY[${sql.join(cityNames.map((name) => sql`${name}`), sql`, `)}]::text[])`
  const cityKey = branchCityKeySql(sql`listed.name`)
  const rows = await executor.execute<{ city: string; warehouse_count: number }>(sql`
    WITH listed AS (SELECT name FROM ${listed} AS listed(name)),
    warehouses AS (
      SELECT ${users.id} AS id
      FROM ${users}
      INNER JOIN ${roles} ON ${roles.id} = ${users.roleId}
      WHERE ${roles.name} = ${WAREHOUSE_ROLE} AND ${users.isActive} = true AND ${users.deletedAt} IS NULL
    ),
    serving AS (
      SELECT ${warehouseCityAssignments.userId} AS user_id, ${warehouseCityAssignments.cityKey} AS city_key
      FROM ${warehouseCityAssignments}
      UNION
      SELECT ${warehouseAssignments.userId}, ${branchCityKeySql(branches.city)}
      FROM ${warehouseAssignments}
      INNER JOIN ${branches} ON ${branches.id} = ${warehouseAssignments.branchId}
      WHERE ${branches.status} = 'active'
    )
    SELECT listed.name AS city, count(DISTINCT serving.user_id)::int AS warehouse_count
    FROM listed
    INNER JOIN serving ON serving.city_key = ${cityKey}
    INNER JOIN warehouses ON warehouses.id = serving.user_id
    GROUP BY listed.name
    ORDER BY listed.name
  `)
  return rows.rows.map((row) => ({ city: row.city, warehouseCount: Number(row.warehouse_count) }))
}

/** Who serves the city, and how: a whole-city assignment, or single branches there. */
async function servingWarehouses(
  tx: TransactionExecutor,
  input: { city: string; excludeBranchId: number; within?: string[] },
): Promise<{ byCity: Set<string>; byBranch: Set<string> }> {
  const accounts = (await activeWarehouseAccounts(tx)).map((row) => row.id)
  const candidates = input.within ? accounts.filter((id) => input.within!.includes(id)) : accounts
  if (candidates.length === 0) return { byCity: new Set(), byBranch: new Set() }

  const cityKey = branchCityKeySql(input.city)
  const [cityRows, branchRows] = await Promise.all([
    tx
      .select({ userId: warehouseCityAssignments.userId })
      .from(warehouseCityAssignments)
      .where(and(inArray(warehouseCityAssignments.userId, candidates), eq(warehouseCityAssignments.cityKey, cityKey))),
    tx
      .selectDistinct({ userId: warehouseAssignments.userId })
      .from(warehouseAssignments)
      .innerJoin(branches, eq(branches.id, warehouseAssignments.branchId))
      .where(and(
        inArray(warehouseAssignments.userId, candidates),
        eq(branches.status, "active"),
        ne(branches.id, input.excludeBranchId),
        eq(branchCityKeySql(branches.city), cityKey),
      )),
  ])
  return {
    byCity: new Set(cityRows.map((row) => row.userId)),
    byBranch: new Set(branchRows.map((row) => row.userId)),
  }
}

export type NewBranchWarehouseCoverage = {
  branchId: number
  city: string
  /** Warehouses holding the whole city: they reach the branch with no write. */
  servedByCity: number
  /** Warehouses serving the city through single branches, now given this one. */
  assigned: number
}

/**
 * Give a branch this transaction has just created to every warehouse that
 * serves its city through single branches there. A whole-city warehouse
 * already reaches it and is not written to.
 *
 * The serving accounts are taken `FOR SHARE`, in id order, and their
 * assignments re-read under that lock: Super Admin's `replaceWarehouseBranches`
 * takes the same rows `FOR UPDATE` and replaces an organization's branches
 * wholesale, so without the lock it could delete the row written here.
 * Additive only, and audited exactly as Super Admin's assignment is.
 */
export async function attachNewBranchToCityWarehouses(
  tx: TransactionExecutor,
  input: {
    branchId: number
    organizationId: number
    city: string
    actor: { userId: string; role: string }
    joinRequestId: number
  },
): Promise<NewBranchWarehouseCoverage> {
  const first = await servingWarehouses(tx, { city: input.city, excludeBranchId: input.branchId })
  const seen = [...new Set([...first.byCity, ...first.byBranch])].sort((a, b) => a.localeCompare(b))
  if (seen.length === 0) return { branchId: input.branchId, city: input.city, servedByCity: 0, assigned: 0 }

  await tx
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, seen))
    .orderBy(asc(users.id))
    .for("share")

  const { byCity, byBranch } = await servingWarehouses(tx, {
    city: input.city,
    excludeBranchId: input.branchId,
    within: seen,
  })
  const toAssign = [...byBranch].filter((userId) => !byCity.has(userId)).sort((a, b) => a.localeCompare(b))

  for (const userId of toAssign) {
    const before = (await tx
      .select({ branchId: warehouseAssignments.branchId })
      .from(warehouseAssignments)
      .innerJoin(branches, eq(branches.id, warehouseAssignments.branchId))
      .where(and(eq(warehouseAssignments.userId, userId), eq(branches.organizationId, input.organizationId))))
      .map((row) => row.branchId)
      .sort((a, b) => a - b)

    await tx
      .insert(warehouseAssignments)
      .values({ userId, branchId: input.branchId, createdByUserId: input.actor.userId })
      .onConflictDoNothing()

    await recordAuditEvent(tx, {
      action: WAREHOUSE_ASSIGNMENT_AUDIT_ACTION,
      entity: "user",
      entityId: userId,
      actor: { id: input.actor.userId, role: input.actor.role },
      organizationId: input.organizationId,
      branchId: input.branchId,
      before: { branchIds: before },
      after: { branchIds: [...new Set([...before, input.branchId])].sort((a, b) => a - b) },
      context: {
        source: "DEPARTMENT_JOIN_APPROVAL",
        joinRequestId: input.joinRequestId,
        city: input.city,
      },
    })
  }

  return { branchId: input.branchId, city: input.city, servedByCity: byCity.size, assigned: toAssign.length }
}
