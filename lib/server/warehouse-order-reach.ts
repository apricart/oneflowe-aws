import "server-only"

import { and, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm"

import { branches, orders } from "@/db/schema"
import type { WarehouseOrderReach } from "@/lib/order-warehouse-transfer"

/**
 * The SQL form of `isOrderInWarehouseOrderReach`: an order transferred to a
 * warehouse is the work of that warehouse's operators only; an order naming no
 * warehouse is the work of whoever serves its branch. An empty reach matches
 * nothing. Every warehouse order list goes through this, so a transferred order
 * leaves the branch's accounts' queue, dashboard and notices at once.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 */
export function warehouseOrderReachCondition(reach: WarehouseOrderReach): SQL {
  const byBranch = reach.branchIds.length === 0
    ? undefined
    : and(isNull(orders.fulfillmentWarehouseId), inArray(orders.branchId, [...reach.branchIds]))
  const byWarehouse = reach.warehouseIds.length === 0
    ? undefined
    : and(isNotNull(orders.fulfillmentWarehouseId), inArray(orders.fulfillmentWarehouseId, [...reach.warehouseIds]))
  if (!byBranch && !byWarehouse) return sql`FALSE`
  return or(byBranch, byWarehouse)!
}

/**
 * The branches a reach shows in its filters: those it serves, and those of the
 * orders transferred to its warehouses, which may be anywhere.
 */
export function warehouseReachBranchCondition(reach: WarehouseOrderReach): SQL {
  const served = reach.branchIds.length === 0 ? undefined : inArray(branches.id, [...reach.branchIds])
  const transferredIn = reach.warehouseIds.length === 0
    ? undefined
    : sql`${branches.id} IN (
      SELECT ${orders.branchId} FROM ${orders}
      WHERE ${inArray(orders.fulfillmentWarehouseId, [...reach.warehouseIds])}
    )`
  if (!served && !transferredIn) return sql`FALSE`
  return or(served, transferredIn)!
}
