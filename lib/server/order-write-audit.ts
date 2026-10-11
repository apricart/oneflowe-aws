import "server-only"

import { notifications } from "@/db/schema"

/**
 * Telling the raiser that somebody else acted on their order.
 *
 * The branch owns its orders (`lib/order-write-access.ts`), so a colleague may
 * edit or refund an order this person raised. Accountability is what creator
 * equality used to provide and no longer does, so it is reconstructed here:
 * the audit row names both parties, and this puts the same fact in front of the
 * person answerable for the order.
 *
 * Written on the caller's transaction handle on purpose. If the edit or the
 * refund rolls back, the notification rolls back with it and nobody is told
 * about a change that never happened.
 */
export type OrderWriteNotice = {
  write: { onBehalfOfUserId: string | null; isCrossRequesterWrite: boolean } | null | undefined
  organizationId: number
  branchId: number
  orderId: number
  tid: string | null | undefined
  message: string
  type: string
  /**
   * Names the occurrence when the same kind of write can recur on one order —
   * a correction round. Without it the notice is one per order and type.
   */
  occurrence?: string | number
}

type TxClient = {
  insert: (table: typeof notifications) => {
    values: (rows: typeof notifications.$inferInsert) => { onConflictDoNothing: () => Promise<unknown> }
  }
}

export async function notifyRaiserOfOrderWrite(
  tx: TxClient,
  notice: OrderWriteNotice,
): Promise<boolean> {
  const raiser = notice.write?.onBehalfOfUserId
  // Nothing to say when the actor is the raiser, which is still the common case.
  if (!notice.write?.isCrossRequesterWrite || !raiser) return false

  await tx.insert(notifications).values({
    userId: raiser,
    organizationId: notice.organizationId,
    branchId: notice.branchId,
    type: notice.type,
    orderId: notice.orderId,
    // Scoped to this order and this event so a retry of the same write does not
    // stack duplicate notices on the raiser.
    eventKey: notice.occurrence === undefined
      ? `${notice.type}:${notice.orderId}`
      : `${notice.type}:${notice.orderId}:${notice.occurrence}`,
    message: notice.message,
  // The key is unique. A second colleague edit of the same order produces the
  // same key; the raiser has already been told this order is being changed by
  // others, so the repeat is dropped rather than failing the write it reports.
  }).onConflictDoNothing()
  return true
}
