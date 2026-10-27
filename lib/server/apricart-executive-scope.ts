import "server-only"

import { and, eq, inArray, sql, type SQL } from "drizzle-orm"

import { apricartExecutiveAssignments, orders, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import { APRICART_EXECUTIVE_ROLE, resolveExecutiveApprovalReach } from "@/lib/apricart-executive-access"
import { ORDER_DESK_ROLE } from "@/lib/order-desk-access"
import { SUPER_ADMIN_DESK_APPROVER_ROLE, type DeskApprovalReach } from "@/lib/order-desk-approval"

/**
 * The rows the executive approval rule (`resolveExecutiveApprovalReach`)
 * judges, read from the database every time — never from the session.
 *
 * The account row is re-read too, so an executive who was deactivated,
 * deleted or moved to another role reaches nothing while an old token is
 * still in flight. See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
 */

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

type LoadOptions = {
  /** Narrow to one organization (the order being decided). */
  organizationId?: number
  /**
   * Take a FOR SHARE lock on the assignment rows. Used inside a deciding
   * transaction so a Super Admin removing the grant waits for an in-flight
   * decision instead of racing past it.
   */
  lock?: boolean
}

/** The organizations this executive may decide Order Desk orders for. */
export async function loadExecutiveApprovalReach(
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
  if (!account || account.role !== APRICART_EXECUTIVE_ROLE) return []

  const assignmentQuery = client
    .select({ organizationId: apricartExecutiveAssignments.organizationId })
    .from(apricartExecutiveAssignments)
    .where(and(
      eq(apricartExecutiveAssignments.userId, userId),
      options.organizationId === undefined
        ? undefined
        : eq(apricartExecutiveAssignments.organizationId, options.organizationId),
    ))
  const assignments = options.lock ? await assignmentQuery.for("share") : await assignmentQuery

  return resolveExecutiveApprovalReach({
    account: { role: account.role, isActive: account.isActive, deleted: account.deletedAt !== null },
    assignedOrganizationIds: assignments.map((row) => row.organizationId),
  })
}

/**
 * The orders an executive may read for approval: Order Desk entries in an
 * assigned organization. An empty reach matches nothing.
 */
export function executiveApprovalOrderCondition(reachOrganizationIds: readonly number[]): SQL {
  if (reachOrganizationIds.length === 0) return sql`false`
  return and(
    eq(orders.createdByRole, ORDER_DESK_ROLE),
    inArray(orders.organizationId, [...reachOrganizationIds]),
  ) as SQL
}

/**
 * Which desk orders this account may list and decide, read from the rows as
 * they are now: an active, undeleted Super Admin reaches every one; an
 * executive the organizations assigned to it (`loadExecutiveApprovalReach`,
 * with the same options); anyone else none.
 * See plans/OF-DESK-TEAM-super-admin-desk-orders-tab.md.
 */
export async function loadDeskApprovalReach(
  client: DbClient,
  userId: string,
  options: LoadOptions = {},
): Promise<DeskApprovalReach> {
  const [account] = await client
    .select({ role: roles.name, isActive: users.isActive, deletedAt: users.deletedAt })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId))
    .limit(1)
  if (account?.role === SUPER_ADMIN_DESK_APPROVER_ROLE && account.isActive && account.deletedAt === null) {
    return { kind: "all" }
  }
  if (account?.role !== APRICART_EXECUTIVE_ROLE) return { kind: "organizations", organizationIds: [] }
  return { kind: "organizations", organizationIds: await loadExecutiveApprovalReach(client, userId, options) }
}

/** The desk orders a reach covers. An empty reach matches nothing. */
export function deskApprovalOrderCondition(reach: DeskApprovalReach): SQL {
  if (reach.kind === "all") return eq(orders.createdByRole, ORDER_DESK_ROLE)
  return executiveApprovalOrderCondition(reach.organizationIds)
}
