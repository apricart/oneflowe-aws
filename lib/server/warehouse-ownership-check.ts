import "server-only"

import { and, asc, count, eq, isNull, sql } from "drizzle-orm"

import { apricartWarehouses, branches, orders, roles, users } from "@/db/schema"
import type { db } from "@/lib/db"
import { compareWarehouseReach, type WarehouseReachDifference } from "@/lib/apricart-warehouses"
import { WAREHOUSE_ROLE } from "@/lib/warehouse-access"
import { branchWarehouseSql, countStrandedBranches } from "@/lib/server/branch-warehouse"
import { loadWarehouseReach } from "@/lib/server/warehouse-scope"

/**
 * Whether moving warehouse accounts from their own assignments to warehouse
 * membership would change what any of them sees — the gate before
 * `WAREHOUSE_ORDER_OWNERSHIP` leaves "branch".
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2, decision 5).
 *
 * Read-only. Each account's reach is taken from `loadWarehouseReach` itself in
 * each mode, never from a copy of its rules. Comparing branch sets is enough:
 * the orders an account works (`isOrderInWarehouseOrderReach`), its support
 * threads (`supportBranchReachCondition`), its catalogue fence, its dashboard
 * and its notices are all derived from that set and from its warehouse
 * memberships, and memberships read the same in every mode.
 *
 * Takes its client, so `scripts/check-warehouse-ownership.ts` runs it on a
 * tool connection and Super Admin's page on the app's.
 */

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export type WarehouseOwnershipCheck = {
  checkedAt: string
  accounts: Array<{ id: string; username: string | null; branchCount: number }>
  /** Per account, branches lost or gained under each membership mode. Empty means identical. */
  differences: {
    "membership-fallback": WarehouseReachDifference[]
    membership: WarehouseReachDifference[]
  }
  /** Open orders, not transferred, whose branch is in no warehouse: nobody works them in "membership". */
  unroutedOpenOrders: number
  /** Active branches in a warehouse that no active operator of it works. */
  strandedBranches: Array<{ warehouseId: number; code: string; branches: number }>
  ready: { "membership-fallback": boolean; membership: boolean }
}

/** Every active warehouse account is checked; there are a handful, read one at a time. */
const ACCOUNT_LIMIT = 400

export async function runWarehouseOwnershipCheck(client: DbClient, now: Date = new Date()): Promise<WarehouseOwnershipCheck> {
  const accounts = await client
    .select({ id: users.id, username: users.username })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(roles.name, WAREHOUSE_ROLE), eq(users.isActive, true), isNull(users.deletedAt)))
    .orderBy(asc(users.id))
    .limit(ACCOUNT_LIMIT)

  const current = new Map<string, number[]>()
  const fallback = new Map<string, number[]>()
  const membership = new Map<string, number[]>()
  for (const account of accounts) {
    current.set(account.id, await loadWarehouseReach(client, account.id, { mode: "branch" }))
    fallback.set(account.id, await loadWarehouseReach(client, account.id, { mode: "membership-fallback" }))
    membership.set(account.id, await loadWarehouseReach(client, account.id, { mode: "membership" }))
  }

  const [{ unrouted }] = await client
    .select({ unrouted: count() })
    .from(orders)
    .innerJoin(branches, eq(branches.id, orders.branchId))
    .where(and(
      sql`UPPER(${orders.status}) IN ('PENDING', 'APPROVED')`,
      isNull(orders.fulfillmentWarehouseId),
      sql`${branchWarehouseSql()} IS NULL`,
    ))

  const warehouses = await client
    .select({ id: apricartWarehouses.id, code: apricartWarehouses.code })
    .from(apricartWarehouses)
    .orderBy(asc(apricartWarehouses.id))
  const strandedBranches: WarehouseOwnershipCheck["strandedBranches"] = []
  for (const warehouse of warehouses) {
    const stranded = await countStrandedBranches(client, warehouse.id)
    if (stranded > 0) strandedBranches.push({ warehouseId: warehouse.id, code: warehouse.code, branches: stranded })
  }

  const differences = {
    "membership-fallback": compareWarehouseReach(current, fallback),
    membership: compareWarehouseReach(current, membership),
  }
  return {
    checkedAt: now.toISOString(),
    accounts: accounts.map((account) => ({ ...account, branchCount: current.get(account.id)?.length ?? 0 })),
    differences,
    unroutedOpenOrders: Number(unrouted),
    strandedBranches,
    ready: {
      "membership-fallback": differences["membership-fallback"].length === 0 && strandedBranches.length === 0,
      membership: differences.membership.length === 0 && strandedBranches.length === 0 && Number(unrouted) === 0,
    },
  }
}
