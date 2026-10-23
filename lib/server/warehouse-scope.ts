import "server-only"

import { and, eq, isNull } from "drizzle-orm"

import {
  apricartWarehouseMemberships,
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
import {
  EMPTY_WAREHOUSE_ORDER_REACH,
  isOrderInWarehouseOrderReach,
  type WarehouseOrderReach,
} from "@/lib/order-warehouse-transfer"
import { WAREHOUSE_ROLE, resolveWarehouseReach } from "@/lib/warehouse-access"
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

/**
 * The warehouses this account is an active operator of — the orders Super
 * Admin transferred to them are its work (plans/OF-WAREHOUSE-order-ownership-and-transfer.md).
 * The account row is re-read with the membership, so a deactivated, deleted or
 * re-roled account is an operator of nothing.
 */
export async function loadWarehouseMemberships(
  client: DbClient,
  userId: string,
  options: { warehouseId?: number; lock?: boolean } = {},
): Promise<number[]> {
  const query = client
    .select({ warehouseId: apricartWarehouseMemberships.warehouseId })
    .from(apricartWarehouseMemberships)
    .innerJoin(users, eq(users.id, apricartWarehouseMemberships.userId))
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(
      eq(apricartWarehouseMemberships.userId, userId),
      eq(apricartWarehouseMemberships.responsibility, "WAREHOUSE_OPERATOR"),
      options.warehouseId === undefined ? undefined : eq(apricartWarehouseMemberships.warehouseId, options.warehouseId),
      eq(roles.name, WAREHOUSE_ROLE),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
  // FOR SHARE on the membership row: Super Admin removing the member waits
  // for an in-flight write instead of racing past it.
  const rows = options.lock ? await query.for("share", { of: [apricartWarehouseMemberships] }) : await query
  return [...new Set(rows.map((row) => row.warehouseId))].sort((a, b) => a - b)
}

/**
 * Everything one warehouse account may work: the orders at the branches it
 * serves that name no warehouse, and the orders transferred to a warehouse it
 * operates. Every order list, dashboard and notice fence reads this.
 */
export async function loadWarehouseOrderReach(client: DbClient, userId: string): Promise<WarehouseOrderReach> {
  const [branchIds, warehouseIds] = await Promise.all([
    loadWarehouseReach(client, userId),
    loadWarehouseMemberships(client, userId),
  ])
  if (branchIds.length === 0 && warehouseIds.length === 0) return EMPTY_WAREHOUSE_ORDER_REACH
  return { branchIds, warehouseIds }
}

export type WarehouseOrderRef = { id: number; organizationId: number; branchId: number }

type OrderScopeRow = {
  id: number
  organizationId: number | null
  branchId: number
  status: string | null
  fulfillmentWarehouseId: number | null
  branchOrganizationId: number | null
}

async function readOrderScope(client: DbClient, orderId: number, lock: boolean): Promise<OrderScopeRow | null> {
  const query = client
    .select({
      id: orders.id,
      organizationId: orders.organizationId,
      branchId: orders.branchId,
      status: orders.status,
      fulfillmentWarehouseId: orders.fulfillmentWarehouseId,
      branchOrganizationId: branches.organizationId,
    })
    .from(orders)
    .innerJoin(branches, eq(branches.id, orders.branchId))
    .where(eq(orders.id, orderId))
    .limit(1)
  // FOR UPDATE on the order row only: a transfer takes the same lock, so a
  // write and a transfer of one order have one winner.
  const [row] = lock ? await query.for("update", { of: [orders] }) : await query
  return row ?? null
}

/**
 * Whether this one order is the account's to work, judged by the single rule
 * (`isOrderInWarehouseOrderReach`): a transferred order by membership of its
 * warehouse, any other by the branch reach. The branch must belong to the
 * order's own organization.
 */
async function orderScopeAllows(client: DbClient, userId: string, order: OrderScopeRow, lock: boolean): Promise<boolean> {
  if (!order.organizationId || order.branchOrganizationId !== order.organizationId) return false
  const reach: WarehouseOrderReach = order.fulfillmentWarehouseId === null
    ? { branchIds: await loadWarehouseReach(client, userId, { branchId: order.branchId, lock }), warehouseIds: [] }
    : { branchIds: [], warehouseIds: await loadWarehouseMemberships(client, userId, { warehouseId: order.fulfillmentWarehouseId, lock }) }
  return isOrderInWarehouseOrderReach(order, reach)
}

/**
 * One order, when it is the warehouse's work (approved, or fulfilled history —
 * `isWarehouseWorkStatus`), and this account works it (its branch reach, or —
 * for a transferred order — membership of the order's warehouse); otherwise
 * null, which every caller answers as 404. A pending, rejected, cancelled or
 * refunded order is therefore indistinguishable from one at another branch or
 * one that does not exist (AC1, plans/OF-WAREHOUSE-warehouse-fulfilment-role.md).
 */
export async function loadWarehouseOrderInReach(
  client: DbClient,
  userId: string,
  orderId: number,
  options: { lock?: boolean } = {},
): Promise<WarehouseOrderRef | null> {
  const order = await readOrderScope(client, orderId, false)
  if (!order?.organizationId || !isWarehouseWorkStatus(order.status)) return null
  if (!await orderScopeAllows(client, userId, order, options.lock === true)) return null
  return { id: order.id, organizationId: order.organizationId, branchId: order.branchId }
}

/**
 * Whether this account works the order, whatever its status — the guard a
 * writing transaction re-runs. With `lock`, the order row is taken FOR UPDATE
 * and the reach rows FOR SHARE, so neither a transfer nor a withdrawn
 * assignment can slip in between the check and the write.
 */
export async function isOrderInWarehouseReach(
  userId: string,
  orderId: number,
  options: { client?: DbClient; lock?: boolean } = {},
): Promise<boolean> {
  const client = options.client ?? db
  const lock = options.lock === true
  const order = await readOrderScope(client, orderId, lock)
  if (!order) return false
  return orderScopeAllows(client, userId, order, lock)
}
