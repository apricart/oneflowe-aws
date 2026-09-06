import "server-only"

import { and, eq, sql } from "drizzle-orm"

import { orders } from "@/db/schema"
import { db } from "@/lib/db"
import { normalizeFulfillmentStatus, type FulfillmentStatus } from "@/lib/fulfillment-status"
import { isMissingFulfillmentStatusColumn } from "@/lib/order-select"

/**
 * Where a fulfilment token hand-off is remembered.
 *
 * A hand-off no longer settles its order on its own — the goods have to be
 * delivered too — so the hand-off has to survive between the two events. It is
 * written on the order itself rather than inferred from the audit trail so the
 * delivery transition can find it with the same primary-key read it already
 * does, inside the tenant and branch the caller was authorized for.
 *
 * Authorization is **not** performed here. Every caller has already decided
 * that this actor may act on this order and passes the tenant and branch it
 * authorized, which every statement re-asserts in its own WHERE clause — a
 * mismatched pair simply writes nothing rather than touching another tenant's
 * order.
 *
 * The columns are read through `to_jsonb` and written behind an undefined-column
 * guard, exactly as `fulfillment_status` and `payment_status` are, so an
 * environment whose migration has not been applied yet degrades to "no hand-off
 * recorded" instead of failing every hand-off outright.
 */

export type TokenHandoffTarget = {
  orderId: number
  /**
   * The tenant the caller authorized; re-asserted by the write. Orders predate
   * the column being required, so a legacy row can carry no tenant at all —
   * there is simply nothing to re-assert for those.
   */
  organizationId: number | null
  /** The branch the caller authorized; re-asserted by the write. */
  branchId: number
}

export type TokenHandoffRecord =
  /** The hand-off is recorded; `fulfillmentStatus` decides whether it settles now. */
  | { outcome: "recorded"; fulfillmentStatus: FulfillmentStatus }
  /** No approved order matched the authorized tenant, branch and id. */
  | { outcome: "not-claimed" }
  /** The hand-off columns are not in the database yet. */
  | { outcome: "migration-missing" }

export type PendingTokenHandoff = {
  handedOffAt: string
  /** Null only for a row written before the sender could be resolved. */
  handedOffByUserId: string | null
}

/**
 * Read defensively, so an unmigrated database reports "never handed over"
 * rather than throwing on a column that is not there yet.
 */
const handoffAtSql = sql<string | null>`to_jsonb("orders") ->> 'token_handoff_at'`
const handoffByUserIdSql = sql<string | null>`to_jsonb("orders") ->> 'token_handoff_by_user_id'`
const fulfillmentStatusSql = sql<string>`COALESCE(to_jsonb("orders") ->> 'fulfillment_status', 'NOT_STARTED')`

/** The scope every statement in this module re-asserts. */
function scopedToOrder({ orderId, organizationId, branchId }: TokenHandoffTarget) {
  return and(
    eq(orders.id, orderId),
    organizationId === null ? undefined : eq(orders.organizationId, organizationId),
    eq(orders.branchId, branchId),
  )
}

/**
 * Record that this actor handed the order's token to admin operations, and
 * report the delivery status the order stands at.
 *
 * The write is idempotent: a token that is re-sent keeps the first hand-off's
 * timestamp and sender, so the record stays the moment the administrator first
 * received the credential. Only an approved order can be claimed, which is the
 * same gate the sending route applies before the email leaves.
 */
export async function recordOrderTokenHandoff(
  target: TokenHandoffTarget & { handedOffByUserId: string },
): Promise<TokenHandoffRecord> {
  try {
    return await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(orders)
        .set({
          tokenHandoffAt: sql`COALESCE(${orders.tokenHandoffAt}, NOW())`,
          tokenHandoffByUserId: sql`COALESCE(${orders.tokenHandoffByUserId}, ${target.handedOffByUserId}::uuid)`,
          updatedAt: new Date(),
        })
        .where(and(
          scopedToOrder(target),
          sql`UPPER(TRIM(${orders.status})) = 'APPROVED'`,
        ))
        .returning({ id: orders.id })

      if (!claimed) return { outcome: "not-claimed" } as const

      const [current] = await tx
        .select({ fulfillmentStatus: fulfillmentStatusSql })
        .from(orders)
        .where(eq(orders.id, target.orderId))
        .limit(1)

      return {
        outcome: "recorded",
        fulfillmentStatus: normalizeFulfillmentStatus(current?.fulfillmentStatus),
      } as const
    })
  } catch (writeError) {
    if (isMissingFulfillmentStatusColumn(writeError)) return { outcome: "migration-missing" }
    throw writeError
  }
}

/**
 * The hand-off waiting on this order, if the token has already been handed over
 * and the order has not been settled yet. Returns null when no token was ever
 * handed over — which is also what an unmigrated database reports.
 */
export async function findPendingTokenHandoff(
  target: TokenHandoffTarget,
): Promise<PendingTokenHandoff | null> {
  const [row] = await db
    .select({
      handedOffAt: handoffAtSql,
      handedOffByUserId: handoffByUserIdSql,
    })
    .from(orders)
    .where(scopedToOrder(target))
    .limit(1)

  if (!row?.handedOffAt) return null

  return {
    handedOffAt: row.handedOffAt,
    handedOffByUserId: row.handedOffByUserId ?? null,
  }
}
