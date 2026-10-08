import "server-only"

import { and, count, eq } from "drizzle-orm"

import { orders, organizations } from "@/db/schema"
import type { db } from "@/lib/db"
import { viewerStatusBucketCondition } from "@/lib/server/order-delivery-status-sql"
import {
  DeliveryAcknowledgementBlockedError,
  resolveDeliveryAcknowledgement,
  type DeliveryAcknowledgementStatus,
} from "@/lib/unacknowledged-delivery-block"

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type DeliveryAcknowledgementScope = { organizationId: number; branchId: number }

/**
 * The branch's delivered-but-unacknowledged orders
 * (plans/OF-ORDERS-unacknowledged-delivery-ordering-block.md).
 *
 * The organization opts in with `block_ordering_on_unacknowledged_deliveries`;
 * with it off nothing is counted and nothing is blocked. With it on, the
 * branch stops at the organization's own
 * `unacknowledged_delivery_block_threshold`, read from the same row. The
 * count uses the dashboard's own DELIVERED_UNACKNOWLEDGED predicate, fenced by
 * both the organization and the branch the caller was given — never by the
 * request. Every order at the branch counts, whoever raised it, group orders
 * included.
 */
export async function resolveBranchDeliveryAcknowledgement(
  client: DbClient,
  scope: DeliveryAcknowledgementScope,
): Promise<DeliveryAcknowledgementStatus> {
  const [organization] = await client
    .select({
      enabled: organizations.blockOrderingOnUnacknowledgedDeliveries,
      threshold: organizations.unacknowledgedDeliveryBlockThreshold,
    })
    .from(organizations)
    .where(eq(organizations.id, scope.organizationId))
    .limit(1)
  if (organization?.enabled !== true) {
    return resolveDeliveryAcknowledgement({ enabled: false, unacknowledgedCount: 0 })
  }

  const [{ total }] = await client
    .select({ total: count() })
    .from(orders)
    .where(and(
      eq(orders.organizationId, scope.organizationId),
      eq(orders.branchId, scope.branchId),
      viewerStatusBucketCondition("DELIVERED_UNACKNOWLEDGED"),
    ))

  return resolveDeliveryAcknowledgement({
    enabled: true,
    unacknowledgedCount: Number(total),
    threshold: organization.threshold,
  })
}

/**
 * The order gate. Called inside each order-creation transaction, right after
 * the payment-control gate and before any lock or write, so a blocked branch
 * costs one read and holds no row. Throws DeliveryAcknowledgementBlockedError,
 * which both creation paths map to a stable refusal.
 */
export async function assertBranchDeliveriesAcknowledged(
  tx: Tx,
  scope: DeliveryAcknowledgementScope,
): Promise<DeliveryAcknowledgementStatus> {
  const status = await resolveBranchDeliveryAcknowledgement(tx, scope)
  if (!status.orderingAllowed) throw new DeliveryAcknowledgementBlockedError(status)
  return status
}
