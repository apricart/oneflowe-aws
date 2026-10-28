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

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

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
    return await db.transaction((tx) => writeTokenHandoff(tx, target))
  } catch (writeError) {
    if (isMissingFulfillmentStatusColumn(writeError)) return { outcome: "migration-missing" }
    throw writeError
  }
}

async function writeTokenHandoff(
  client: DbClient,
  target: TokenHandoffTarget & { handedOffByUserId: string },
): Promise<TokenHandoffRecord> {
  const [claimed] = await client
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

  if (!claimed) return { outcome: "not-claimed" }

  const [current] = await client
    .select({ fulfillmentStatus: fulfillmentStatusSql })
    .from(orders)
    .where(eq(orders.id, target.orderId))
    .limit(1)

  return {
    outcome: "recorded",
    fulfillmentStatus: normalizeFulfillmentStatus(current?.fulfillmentStatus),
  }
}

/** What the caller's send step reports back, so a failed email records nothing. */
export type TokenEmailDelivery =
  | { delivered: true }
  | { delivered: false; reason: string }

export type TokenEmailOnceOutcome =
  /** The email left for these orders, and their hand-off is recorded. */
  | { outcome: "sent"; orderIds: ReadonlySet<number> }
  /** Every order's token had already been emailed; nothing was sent. */
  | { outcome: "already-sent" }
  /** Another request is emailing one of these tokens right now; nothing was sent. */
  | { outcome: "in-progress" }
  /** The email itself failed; nothing was recorded, so it may be retried. */
  | { outcome: "failed"; reason: string }

/** Namespaces the per-order advisory lock away from every other one. */
const TOKEN_EMAIL_LOCK_NAMESPACE = "oneflowe:order-token-email"

/**
 * Email each order's fulfilment token at most once.
 *
 * `token_handoff_at` is the record that a token has reached admin operations,
 * so an order that already carries it is not emailed again — a second message
 * would only put a duplicate credential in the mailbox and spend the sender's
 * email allowance on nothing. The check alone would let two simultaneous clicks
 * (or the raiser and their approver at once) both pass, so each order is held
 * under a transaction-scoped advisory lock from the check until its hand-off is
 * written; a concurrent sender is told the email is in progress rather than
 * sending another.
 *
 * The hand-off is written only after `send` reports the email delivered, on the
 * same transaction that holds the lock, so a failed email leaves the order free
 * to be retried. The order row itself is never locked across the email, so a
 * delivery recorded meanwhile is not held up; the caller settles the order
 * afterwards with `settleOrdersAfterTokenHandoff`, exactly as before.
 *
 * Authorization is the caller's, as for everything in this module: `targets`
 * are orders it has already authorized, and every statement re-asserts their
 * tenant and branch.
 */
export async function sendTokenEmailOncePerOrder(
  targets: readonly TokenHandoffTarget[],
  handedOffByUserId: string,
  send: (unsentOrderIds: ReadonlySet<number>) => Promise<TokenEmailDelivery>,
): Promise<TokenEmailOnceOutcome> {
  // Locks are always taken in ascending id order, so two group hand-offs that
  // share orders cannot each hold half of the other's set.
  const ordered = [...targets].sort((left, right) => left.orderId - right.orderId)

  return db.transaction(async (tx) => {
    for (const target of ordered) {
      const lock = await tx.execute<{ acquired: boolean }>(sql`
        SELECT pg_try_advisory_xact_lock(
          hashtext(${TOKEN_EMAIL_LOCK_NAMESPACE}),
          ${target.orderId}::integer
        ) AS acquired
      `)
      if (!lock.rows[0]?.acquired) return { outcome: "in-progress" } as const
    }

    const unsent: TokenHandoffTarget[] = []
    for (const target of ordered) {
      const [row] = await tx
        .select({ handedOffAt: handoffAtSql })
        .from(orders)
        .where(scopedToOrder(target))
        .limit(1)
      if (row && !row.handedOffAt) unsent.push(target)
    }
    if (unsent.length === 0) return { outcome: "already-sent" } as const

    const unsentOrderIds = new Set(unsent.map((target) => target.orderId))
    const delivery = await send(unsentOrderIds)
    if (!delivery.delivered) return { outcome: "failed", reason: delivery.reason } as const

    // A database whose hand-off columns are not migrated yet cannot remember
    // the send; the email has gone, so that must not turn into a failure.
    try {
      await tx.transaction(async (savepoint) => {
        for (const target of unsent) {
          await writeTokenHandoff(savepoint, { ...target, handedOffByUserId })
        }
      })
    } catch (writeError) {
      if (!isMissingFulfillmentStatusColumn(writeError)) throw writeError
    }

    return { outcome: "sent", orderIds: unsentOrderIds } as const
  })
}

export type TokenSettlementState = {
  status: string
  fulfillmentStatus: string
  tokenHandoffAt: string | null
}

/**
 * The three fields that say whether an order is waiting on a failed settlement
 * (`tokenSettlementNeedsRetry`), read live inside the authorized scope. Null
 * when no order matches it.
 */
export async function loadTokenSettlementState(
  target: TokenHandoffTarget,
): Promise<TokenSettlementState | null> {
  const [row] = await db
    .select({
      status: orders.status,
      fulfillmentStatus: fulfillmentStatusSql,
      tokenHandoffAt: handoffAtSql,
    })
    .from(orders)
    .where(scopedToOrder(target))
    .limit(1)

  return row ?? null
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
