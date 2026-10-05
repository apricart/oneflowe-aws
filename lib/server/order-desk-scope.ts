import "server-only"

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm"

import { branches, orderDeskAssignments, orders, organizations, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import {
  ORDER_DESK_ROLE,
  resolveDeskReach,
  type DeskReach,
  type DeskReachInput,
  type DeskReachPurpose,
} from "@/lib/order-desk-access"

/**
 * The rows the Order Desk rules in `lib/order-desk-access.ts` judge, read from
 * the database every time — never from the session.
 *
 * Reach is always loaded for one user id taken from the session, and every
 * read here is keyed by it. The account row is re-read too, so a desk user who
 * was deactivated, deleted or moved to another role reaches nothing even while
 * an old token is still in flight.
 */

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

type LoadOptions = {
  /** Narrow to one organization (the target of a create or an order). */
  organizationId?: number
  /**
   * Take FOR SHARE locks on the assignment and organization rows. Used inside
   * the order-creation transaction so a Super Admin removing the grant or the
   * managed flag waits for an in-flight order instead of racing past it.
   */
  lock?: boolean
}

async function loadReachInput(client: DbClient, userId: string, options: LoadOptions = {}): Promise<DeskReachInput> {
  const [account] = await client
    .select({ role: roles.name, isActive: users.isActive, deletedAt: users.deletedAt })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId))
    .limit(1)

  if (!account || account.role !== ORDER_DESK_ROLE) {
    return { account: null, assignments: [], organizations: [], branches: [] }
  }

  const assignmentQuery = client
    .select({ organizationId: orderDeskAssignments.organizationId, branchId: orderDeskAssignments.branchId })
    .from(orderDeskAssignments)
    .where(and(
      eq(orderDeskAssignments.userId, userId),
      options.organizationId === undefined ? undefined : eq(orderDeskAssignments.organizationId, options.organizationId),
    ))
  const assignments = options.lock ? await assignmentQuery.for("share") : await assignmentQuery

  const organizationIds = [...new Set(assignments.map((row) => row.organizationId))]
  if (organizationIds.length === 0) {
    return {
      account: { role: account.role, isActive: account.isActive, deleted: account.deletedAt !== null },
      assignments: [],
      organizations: [],
      branches: [],
    }
  }

  const organizationQuery = client
    .select({ id: organizations.id, managedOrdering: organizations.managedOrdering, status: organizations.status })
    .from(organizations)
    .where(inArray(organizations.id, organizationIds))
  const organizationRows = options.lock ? await organizationQuery.for("share") : await organizationQuery

  const branchRows = await client
    .select({ id: branches.id, organizationId: branches.organizationId, status: branches.status })
    .from(branches)
    .where(inArray(branches.organizationId, organizationIds))

  return {
    account: { role: account.role, isActive: account.isActive, deleted: account.deletedAt !== null },
    assignments,
    organizations: organizationRows,
    branches: branchRows.flatMap((row) => (row.organizationId === null ? [] : [{ ...row, organizationId: row.organizationId }])),
  }
}

/** The organizations and branches this desk user reaches, for one purpose. */
export async function loadOrderDeskReach(
  client: DbClient,
  userId: string,
  purpose: DeskReachPurpose,
  options: LoadOptions = {},
): Promise<DeskReach> {
  return resolveDeskReach(await loadReachInput(client, userId, options), purpose)
}

/**
 * Whether this desk user may order for this branch of this organization right
 * now. False for anything not assigned, not managed, inactive, or a branch of
 * a different organization.
 */
export async function isOrderDeskTarget(
  client: DbClient,
  input: { userId: string; organizationId: number; branchId: number; lock?: boolean },
): Promise<boolean> {
  const reach = await loadOrderDeskReach(client, input.userId, "order", {
    organizationId: input.organizationId,
    lock: input.lock,
  })
  return reach.organizationIds.includes(input.organizationId) && reach.branchIds.includes(input.branchId)
}

export type OrderDeskTarget = {
  id: number
  name: string
  code: string | null
  branches: { id: number; name: string; city: string | null }[]
}

/** The organization → branch picker for a new order. Names only, no prices. */
export async function loadOrderDeskTargets(userId: string): Promise<OrderDeskTarget[]> {
  const reach = await loadOrderDeskReach(db, userId, "order")
  if (reach.branchIds.length === 0) return []

  const [organizationRows, branchRows] = await Promise.all([
    db
      .select({ id: organizations.id, name: organizations.name, code: organizations.code })
      .from(organizations)
      .where(inArray(organizations.id, reach.organizationIds))
      .orderBy(asc(organizations.name)),
    db
      .select({ id: branches.id, name: branches.name, city: branches.city, organizationId: branches.organizationId })
      .from(branches)
      .where(and(inArray(branches.id, reach.branchIds), inArray(branches.organizationId, reach.organizationIds)))
      .orderBy(asc(branches.name)),
  ])

  return organizationRows.map((organization) => ({
    ...organization,
    branches: branchRows
      .filter((branch) => branch.organizationId === organization.id)
      .map(({ id, name, city }) => ({ id, name, city })),
  }))
}

/**
 * The orders a desk user may read and act on: orders the desk entered, at a
 * branch it currently reaches. An empty reach matches nothing.
 */
export function orderDeskOrderCondition(reach: DeskReach): SQL {
  if (reach.branchIds.length === 0 || reach.organizationIds.length === 0) return sql`false`
  return and(
    eq(orders.createdByRole, ORDER_DESK_ROLE),
    inArray(orders.organizationId, reach.organizationIds),
    inArray(orders.branchId, reach.branchIds),
  ) as SQL
}
