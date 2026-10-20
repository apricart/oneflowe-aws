import "server-only"

import { and, eq } from "drizzle-orm"

import {
  branches,
  orders,
  roles,
  users,
  warehouseAssignments,
  warehouseCityAssignments,
  warehouseCityOrganizations,
} from "@/db/schema"
import { db } from "@/lib/db"
import { warehouseCityBranchOn, warehouseCityOrganizationOn } from "@/lib/server/warehouse-city-rule"
import { resolveWarehouseReach } from "@/lib/warehouse-access"
import { isWarehouseWorkStatus } from "@/lib/warehouse-orders"

/**
 * The rows the warehouse reach rule (`resolveWarehouseReach`) judges, read from
 * the database every time — never from the session.
 *
 * The account row is re-read too, so a warehouse user who was deactivated,
 * deleted or moved to another role reaches nothing while an old token is still
 * in flight. See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 */

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

type LoadOptions = {
  /** Narrow to one branch (the order being worked). */
  branchId?: number
  /**
   * Take a FOR SHARE lock on the assignment rows — branch, city and the city
   * rule's organization alike. Used inside a writing transaction so a Super
   * Admin withdrawing the branch, the city or the organization waits for an in-flight write instead of racing past it.
   */
  lock?: boolean
}

/**
 * The branches this warehouse user serves: those assigned one by one, and every
 * branch now in a city assigned to it **and** in an organization chosen for its
 * cities. Empty means none, never "all".
 */
export async function loadWarehouseReach(
  client: DbClient,
  userId: string,
  options: LoadOptions = {},
): Promise<number[]> {
  const [account] = await client
    .select({ role: roles.name, isActive: users.isActive, deletedAt: users.deletedAt })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId))
    .limit(1)
  if (!account) return []

  const assignmentQuery = client
    .select({ branchId: warehouseAssignments.branchId })
    .from(warehouseAssignments)
    .where(and(
      eq(warehouseAssignments.userId, userId),
      options.branchId === undefined ? undefined : eq(warehouseAssignments.branchId, options.branchId),
    ))
  // Every branch currently in a city assigned to this user, in an organization
  // chosen for it — a branch opened there later is reached with no write. See
  // plans/OF-WAREHOUSE-city-assignments-by-organization.md.
  const cityQuery = client
    .select({ branchId: branches.id })
    .from(warehouseCityAssignments)
    .innerJoin(branches, warehouseCityBranchOn())
    .innerJoin(warehouseCityOrganizations, warehouseCityOrganizationOn())
    .where(and(
      eq(warehouseCityAssignments.userId, userId),
      options.branchId === undefined ? undefined : eq(branches.id, options.branchId),
    ))
  const assignments = options.lock ? await assignmentQuery.for("share") : await assignmentQuery
  const cityBranches = options.lock ? await cityQuery.for("share", { of: [warehouseCityAssignments, warehouseCityOrganizations] }) : await cityQuery

  return resolveWarehouseReach({
    account: { role: account.role, isActive: account.isActive, deleted: account.deletedAt !== null },
    assignedBranchIds: [...assignments, ...cityBranches].map((row) => row.branchId),
  })
}

export type WarehouseOrderRef = { id: number; organizationId: number; branchId: number }

/**
 * One order, when it is the warehouse's work (approved, or fulfilled history —
 * `isWarehouseWorkStatus`), sits at a branch this warehouse user serves, and
 * that branch belongs to the order's own organization; otherwise null, which
 * every caller answers as 404. A pending, rejected, cancelled or refunded
 * order at its own branch is therefore indistinguishable from one at another
 * branch or one that does not exist (AC1,
 * plans/OF-WAREHOUSE-warehouse-fulfilment-role.md).
 */
export async function loadWarehouseOrderInReach(
  client: DbClient,
  userId: string,
  orderId: number,
  options: { lock?: boolean } = {},
): Promise<WarehouseOrderRef | null> {
  const [order] = await client
    .select({
      id: orders.id,
      organizationId: orders.organizationId,
      branchId: orders.branchId,
      status: orders.status,
      branchOrganizationId: branches.organizationId,
    })
    .from(orders)
    .innerJoin(branches, eq(branches.id, orders.branchId))
    .where(eq(orders.id, orderId))
    .limit(1)
  if (!order?.organizationId || order.branchOrganizationId !== order.organizationId) return null
  if (!isWarehouseWorkStatus(order.status)) return null

  const reach = await loadWarehouseReach(client, userId, { branchId: order.branchId, lock: options.lock })
  if (!reach.includes(order.branchId)) return null
  return { id: order.id, organizationId: order.organizationId, branchId: order.branchId }
}

/** Whether the order's branch, of the order's own tenant, is inside this user's reach. */
export async function isOrderBranchInWarehouseReach(
  userId: string,
  order: { organizationId: number | null; branchId: number },
  options: { client?: DbClient; lock?: boolean } = {},
): Promise<boolean> {
  const client = options.client ?? db
  if (!order.organizationId) return false
  const [branch] = await client
    .select({ organizationId: branches.organizationId })
    .from(branches)
    .where(eq(branches.id, order.branchId))
    .limit(1)
  if (!branch || branch.organizationId !== order.organizationId) return false
  const reach = await loadWarehouseReach(client, userId, { branchId: order.branchId, lock: options.lock })
  return reach.includes(order.branchId)
}
