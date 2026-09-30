import "server-only"

import { and, eq, inArray, sql } from "drizzle-orm"

import { orders } from "@/db/schema"
import { db } from "@/lib/db"
import { getOrderStatusesForFilter } from "@/lib/order-status"
import {
  evaluateRoleChangeReadiness,
  toRoleChangeBlockers,
  type RoleChangeReadiness,
} from "@/lib/role-change-preconditions"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"

/**
 * Does this user have orders still in flight?
 *
 * The rule itself is pure and lives in `lib/role-change-preconditions.ts`; this
 * only fetches the two counts it needs. Deliberately a single grouped
 * aggregate rather than two queries, so the answer cannot be assembled from two
 * different instants.
 *
 * Counted on `orders.created_by_user_id` with no branch or tenant predicate of
 * its own: the caller has already established that it may manage this user, and
 * an order they raised blocks the change wherever it sits. Narrowing by the
 * user's *current* branch would miss an order raised before they were moved,
 * which is exactly the kind of order that must not be stranded.
 */

const PENDING_STATUSES = getOrderStatusesForFilter("pending")
const APPROVED_STATUSES = getOrderStatusesForFilter("approved")

function statusTuple(statuses: readonly string[]) {
  return sql.join(statuses.map((status) => sql`${status}`), sql`, `)
}

/**
 * Orders awaiting a decision across a departing approver's assigned branches.
 *
 * Advisory only, and deliberately **not** part of the block. `GROUP_USER` is
 * the only group role that decides orders, so moving one off that role removes
 * an approver from those branches — but nothing is stranded, because
 * `BRANCH_ADMIN` and `HEAD_OFFICE` can still approve every one of them
 * (`app/api/v1/orders/[id]/approve/route.ts`). Refusing the change would be
 * obstruction; saying nothing would hide a real operational consequence, so the
 * administrator is told the number and decides.
 *
 * Returns 0 for any role that is not leaving `GROUP_USER`, and for an approver
 * with no assignments — an empty scope reaches no branches, never all of them.
 */
async function countOrdersAwaitingDepartingApprover(
  targetUserId: string,
  targetRole: string,
  nextRole: string,
  client: ReadinessClient,
): Promise<number> {
  if (targetRole !== "GROUP_USER" || nextRole === "GROUP_USER") return 0

  const branchIds = await resolveScopedBranchIds(client, targetUserId)
  if (branchIds.length === 0) return 0

  const [row] = await client
    .select({ pending: sql<number>`COUNT(*)`.mapWith(Number) })
    .from(orders)
    .where(and(
      inArray(orders.branchId, branchIds),
      sql`UPPER(${orders.status}) IN (${statusTuple(PENDING_STATUSES)})`,
    ))

  return row?.pending ?? 0
}

/**
 * A database handle, so the decision can be taken inside the same transaction
 * that performs the write.
 *
 * The check is a read followed by a write, which outside a transaction is the
 * TOCTOU shape rule 06 forbids: an order raised between the check and the update
 * would slip past a rule that says there are none. Taking it on the transaction
 * closes that window as far as READ COMMITTED allows.
 *
 * The residual is bounded and benign: an order committed by another transaction
 * during the switch is invisible here, but it is stamped with the creator's role
 * at creation (`orders.created_by_role`) and the switch then kills that session,
 * so nothing is left inconsistent — the order is simply in flight when the
 * administrator was told there would be none.
 */
type ReadinessClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function loadRoleChangeReadiness(
  targetUserId: string,
  roles?: { currentRole: string; nextRole: string },
  client: ReadinessClient = db,
): Promise<RoleChangeReadiness> {
  const [counts] = await client
    .select({
      pendingOrderCount: sql<number>`COUNT(*) FILTER (WHERE UPPER(${orders.status}) IN (${statusTuple(PENDING_STATUSES)}))`.mapWith(Number),
      approvedOrderCount: sql<number>`COUNT(*) FILTER (WHERE UPPER(${orders.status}) IN (${statusTuple(APPROVED_STATUSES)}))`.mapWith(Number),
    })
    .from(orders)
    .where(and(
      eq(orders.createdByUserId, targetUserId),
      sql`UPPER(${orders.status}) IN (${statusTuple([...PENDING_STATUSES, ...APPROVED_STATUSES])})`,
    ))

  const verdict = evaluateRoleChangeReadiness(toRoleChangeBlockers(counts ?? {}))
  if (!roles) return verdict

  const ordersAwaitingApproval = await countOrdersAwaitingDepartingApprover(
    targetUserId,
    roles.currentRole,
    roles.nextRole,
    client,
  )
  return ordersAwaitingApproval > 0 ? { ...verdict, ordersAwaitingApproval } : verdict
}
