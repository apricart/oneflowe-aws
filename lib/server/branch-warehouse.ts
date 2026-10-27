import "server-only"

import { and, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm"

import {
  apricartWarehouseMemberBranches,
  apricartWarehouseMemberships,
  apricartWarehouses,
  branches,
  roles,
  users,
} from "@/db/schema"
import type { db } from "@/lib/db"
import { branchCityKeySql } from "@/lib/server/branch-city-key"
import { WAREHOUSE_ROLE } from "@/lib/warehouse-access"

/**
 * Which Apricart warehouse a branch is in, decided in one place.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2).
 *
 * Evaluated at read time and never copied into rows: a branch created by any
 * path, or given a city later, is in its warehouse the moment its organization
 * and city match a rule — exactly as a warehouse user's city assignment works.
 * Precedence: a manual route (`branch_fulfillment_routes`), else the rule for
 * the branch's organization and city, else the rule for its organization.
 * `resolveBranchWarehouse` (`lib/apricart-warehouses.ts`) states the same.
 *
 * Nothing here is read while `WAREHOUSE_ORDER_OWNERSHIP` is "branch"
 * (`lib/warehouse-ownership-policy.ts`), except by Super Admin's Warehouses
 * section and the read-only ownership check.
 */

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * The warehouse of the `branches` row in scope, or NULL. Every column is
 * written out in full: the subqueries alias their own tables, and `branches`
 * is named explicitly, because a bare `"id"` or `"organization_id"` would bind
 * to the nearest table that has one (`users` has both).
 */
export function branchWarehouseSql(): SQL<number | null> {
  return sql<number | null>`COALESCE(
    (SELECT bfr."warehouse_id" FROM "branch_fulfillment_routes" bfr WHERE bfr."branch_id" = "branches"."id"),
    (SELECT wrr."warehouse_id" FROM "warehouse_route_rules" wrr
      WHERE wrr."organization_id" = "branches"."organization_id"
        AND wrr."city_key" = ${branchCityKeySql(sql`"branches"."city"`)}),
    (SELECT wrr."warehouse_id" FROM "warehouse_route_rules" wrr
      WHERE wrr."organization_id" = "branches"."organization_id" AND wrr."city_key" IS NULL)
  )`
}

/** The live warehouse of each branch asked for (null when it is in none). */
export async function loadBranchWarehouses(
  client: DbClient,
  branchIds: readonly number[],
): Promise<Map<number, number | null>> {
  if (branchIds.length === 0) return new Map()
  const rows = await client
    .select({ branchId: branches.id, warehouseId: sql<number | null>`${branchWarehouseSql()}` })
    .from(branches)
    .where(inArray(branches.id, [...new Set(branchIds)]))
  return new Map(rows.map((row) => [row.branchId, row.warehouseId === null ? null : Number(row.warehouseId)]))
}

/** Of these branches, those in no warehouse, ascending. */
export async function branchIdsWithoutWarehouse(client: DbClient, branchIds: readonly number[]): Promise<number[]> {
  const warehouses = await loadBranchWarehouses(client, branchIds)
  return [...warehouses.entries()].filter(([, warehouseId]) => warehouseId === null).map(([branchId]) => branchId).sort((a, b) => a - b)
}

/** The operator's scope admits the branch in scope: all of its warehouse's branches, or this one selected. */
function memberScopeAdmitsBranch(client: DbClient): SQL {
  return or(
    eq(apricartWarehouseMemberships.branchScope, "ALL"),
    exists(
      client.select({ one: sql`1` })
        .from(apricartWarehouseMemberBranches)
        .where(and(
          eq(apricartWarehouseMemberBranches.membershipId, apricartWarehouseMemberships.id),
          sql`${apricartWarehouseMemberBranches.branchId} = "branches"."id"`,
        )),
    ),
  )!
}

/** An active, undeleted `WAREHOUSE` account holding an operator membership. */
function liveOperatorConditions(): SQL[] {
  return [
    eq(apricartWarehouseMemberships.responsibility, "WAREHOUSE_OPERATOR"),
    eq(roles.name, WAREHOUSE_ROLE),
    eq(users.isActive, true),
    isNull(users.deletedAt),
  ]
}

/**
 * The branches an account works through the warehouses it is an operator of:
 * every branch whose live warehouse is one of them, narrowed by its scope.
 * With `lock`, the membership and warehouse rows are taken FOR SHARE, so a
 * rule, route or membership change (which takes the warehouse FOR UPDATE)
 * waits for an in-flight write.
 */
export async function loadMembershipBranchIds(
  client: DbClient,
  userId: string,
  options: { branchId?: number; lock?: boolean } = {},
): Promise<number[]> {
  const query = client
    .select({ branchId: branches.id })
    .from(apricartWarehouseMemberships)
    .innerJoin(apricartWarehouses, eq(apricartWarehouses.id, apricartWarehouseMemberships.warehouseId))
    .innerJoin(users, eq(users.id, apricartWarehouseMemberships.userId))
    .innerJoin(roles, eq(roles.id, users.roleId))
    .innerJoin(branches, sql`${branchWarehouseSql()} = ${apricartWarehouseMemberships.warehouseId}`)
    .where(and(
      eq(apricartWarehouseMemberships.userId, userId),
      ...liveOperatorConditions(),
      memberScopeAdmitsBranch(client),
      options.branchId === undefined ? undefined : eq(branches.id, options.branchId),
    ))
  const rows = options.lock
    ? await query.for("share", { of: [apricartWarehouseMemberships, apricartWarehouses] })
    : await query
  return [...new Set(rows.map((row) => row.branchId))].sort((a, b) => a - b)
}

/**
 * The accounts that work any of these branches through warehouse membership —
 * the recipients counterpart of `loadMembershipBranchIds`. Active, undeleted
 * `WAREHOUSE` accounts only.
 */
export async function loadMembershipAccountIdsServingBranches(
  client: DbClient,
  branchIds: readonly number[],
): Promise<string[]> {
  if (branchIds.length === 0) return []
  const rows = await client
    .selectDistinct({ userId: apricartWarehouseMemberships.userId })
    .from(apricartWarehouseMemberships)
    .innerJoin(users, eq(users.id, apricartWarehouseMemberships.userId))
    .innerJoin(roles, eq(roles.id, users.roleId))
    .innerJoin(branches, sql`${branchWarehouseSql()} = ${apricartWarehouseMemberships.warehouseId}`)
    .where(and(
      inArray(branches.id, [...new Set(branchIds)]),
      ...liveOperatorConditions(),
      memberScopeAdmitsBranch(client),
    ))
  return rows.map((row) => row.userId).sort((a, b) => a.localeCompare(b))
}

/**
 * Active branches in this warehouse that none of its active operators works —
 * whose orders nobody would see once membership decides. The guard compares
 * this before and after a change and refuses one that raises it.
 */
export async function countStrandedBranches(client: DbClient, warehouseId: number): Promise<number> {
  const [row] = await client
    .select({ stranded: sql<number>`count(*)::int` })
    .from(branches)
    .where(and(
      eq(branches.status, "active"),
      sql`${branchWarehouseSql()} = ${warehouseId}`,
      sql`NOT ${exists(
        client.select({ one: sql`1` })
          .from(apricartWarehouseMemberships)
          .innerJoin(users, eq(users.id, apricartWarehouseMemberships.userId))
          .innerJoin(roles, eq(roles.id, users.roleId))
          .where(and(
            eq(apricartWarehouseMemberships.warehouseId, warehouseId),
            ...liveOperatorConditions(),
            memberScopeAdmitsBranch(client),
          )),
      )}`,
    ))
  return Number(row?.stranded ?? 0)
}
