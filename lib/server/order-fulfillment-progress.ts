import "server-only"

import { eq } from "drizzle-orm"

import { auditLogs, orders } from "@/db/schema"
import { db } from "@/lib/db"
import { FULFILLMENT_STATUSES, normalizeFulfillmentStatus, type FulfillmentStatus } from "@/lib/fulfillment-status"
import { orderSelectColumns, transitionOrderFulfillmentStatusColumn } from "@/lib/order-select"
import { attachDeliveryChallan } from "@/lib/server/delivery-challan"
import { settleDeliveredOrderAfterTokenHandoff } from "@/lib/server/order-fulfillment"
import { issueTaxInvoice } from "@/lib/server/invoice-issuance"
import { isInvoiceCodeMissingError } from "@/lib/invoice-number"
import { issuesTaxInvoiceOnStep } from "@/lib/invoice-policy"
import {
  attemptImmediateOrderEmailDelivery,
  queueOrderDeliveredNotifications,
} from "@/lib/server/order-notifications"

/**
 * Moving an order's delivery forward one stage — the single place it happens.
 *
 * Two routes call it: Super Admin's `POST /api/v1/orders/[id]/fulfillment-status`
 * and the warehouse's `POST /api/v1/warehouse/orders/[id]/progress`. Each
 * authorizes its own caller (the `authorize` and `guardInTransaction` hooks);
 * everything after that — the stage rule, the compare-and-set, the challan,
 * the audit row, and the settlement of a waiting token hand-off — is here, so
 * a delivery recorded by either has exactly the same effects.
 *
 * Delivery is recorded nowhere else. Fulfilment requires it and never writes
 * it (`fulfillApprovedOrder`). Marking an order In Process issues its tax
 * invoice, in the same transaction, so the warehouse can print it and send it
 * with the goods (`issueTaxInvoice`, `issuesTaxInvoiceOnStep`,
 * plans/OF-INVOICE-issue-at-processing.md). Recording the delivery tells the
 * order's raiser and approver to acknowledge it, in the same transaction
 * (`queueOrderDeliveredNotifications`,
 * plans/OF-NOTIFY-order-delivered-acknowledge.md). See
 * plans/OF-WAREHOUSE-warehouse-fulfilment-role.md and
 * plans/OF-DELIVERY-CHALLAN-proof-of-delivery.md.
 */

const DELIVERY_CHALLAN_NOT_ATTACHABLE = "DELIVERY_CHALLAN_NOT_ATTACHABLE"
const OUT_OF_SCOPE = "FULFILLMENT_PROGRESS_OUT_OF_SCOPE"

export const PROGRESS_STATUSES = FULFILLMENT_STATUSES.filter(
  (status) => status !== "NOT_STARTED",
) as FulfillmentStatus[]

type OrderRow = Awaited<ReturnType<typeof loadOrder>>
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type FulfillmentProgressOutcome =
  | { kind: "updated"; order: NonNullable<OrderRow>; fulfilled: boolean }
  | { kind: "not-found" }
  | { kind: "out-of-scope" }
  | { kind: "not-approved"; status: string }
  | { kind: "invalid-step"; from: FulfillmentStatus; to: FulfillmentStatus }
  | { kind: "challan-refused" }
  /** The organization has no usable company code, so its tax invoice cannot be numbered. */
  | { kind: "invoice-code-missing" }
  | { kind: "conflict" }
  | { kind: "missing-column" }

async function loadOrder(client: typeof db | Tx, orderId: number) {
  const [order] = await client.select(orderSelectColumns).from(orders).where(eq(orders.id, orderId)).limit(1)
  return order ?? null
}

/** The order this module reads and, once delivered, may settle. */
type ProgressOrder = {
  id: number
  tid: string
  organizationId: number | null
  branchId: number
}

/**
 * Settle an order whose fulfilment token already reached admin operations.
 *
 * A hand-off does not complete an order on its own — the goods have to arrive —
 * so a token handed over before delivery is remembered on the order. Recording
 * the delivery is the other half of that rule, and this is where it is applied.
 *
 * It runs after the progress transition has committed, never inside it: the
 * settlement opens its own transaction against the same row. It adds no reach —
 * the caller has already been authorized against this order, and it settles
 * that order alone, re-asserting the same tenant and branch.
 *
 * An order with no hand-off recorded is left approved exactly as before, which
 * is every order whose token is redeemed by the administrator directly.
 */
async function settleOnDeliveryIfTokenHandedOff(
  order: ProgressOrder,
  actorUserId: string,
): Promise<boolean> {
  const outcome = await settleDeliveredOrderAfterTokenHandoff({
    orderId: order.id,
    organizationId: order.organizationId,
    branchId: order.branchId,
  })

  if (outcome !== "fulfilled") return false

  await db.insert(auditLogs).values({
    userId: actorUserId,
    organizationId: order.organizationId,
    branchId: order.branchId,
    action: "ORDER_FULFILLED_ON_DELIVERY",
    entity: "Order",
    entityId: String(order.id),
    metadata: {
      tid: order.tid,
      reason: "Fulfilment token was already handed to admin operations; delivery completed the order",
    },
  })

  return true
}

/**
 * Why this order cannot move to `nextStatus` with this challan, or the stage it
 * is moving from when it can. Read from the order as loaded; the
 * compare-and-set in the transaction re-asserts the same stage and status.
 */
function stepCheck(
  order: { status: string | null; fulfillmentStatus: string | null },
  nextStatus: FulfillmentStatus,
  deliveryChallanId: number | null,
  challanRequired: boolean,
): FulfillmentProgressOutcome | { kind: "ok"; currentStatus: FulfillmentStatus } {
  const orderStatus = String(order.status || "").toUpperCase()
  if (orderStatus !== "APPROVED") return { kind: "not-approved", status: String(order.status) }

  const currentStatus = normalizeFulfillmentStatus(order.fulfillmentStatus)
  if (FULFILLMENT_STATUSES.indexOf(nextStatus) !== FULFILLMENT_STATUSES.indexOf(currentStatus) + 1) {
    return { kind: "invalid-step", from: currentStatus, to: nextStatus }
  }
  if (nextStatus === "DELIVERED" && challanRequired && deliveryChallanId === null) return { kind: "challan-refused" }
  if (nextStatus !== "DELIVERED" && deliveryChallanId !== null) return { kind: "challan-refused" }
  return { kind: "ok", currentStatus }
}

/** The refusals thrown from inside the transaction to roll it back, as outcomes. */
function transitionErrorOutcome(transitionError: unknown): FulfillmentProgressOutcome | null {
  if (!(transitionError instanceof Error)) return null
  if (transitionError.message === DELIVERY_CHALLAN_NOT_ATTACHABLE) return { kind: "challan-refused" }
  if (transitionError.message === OUT_OF_SCOPE) return { kind: "out-of-scope" }
  if (isInvoiceCodeMissingError(transitionError)) return { kind: "invoice-code-missing" }
  return null
}

export async function progressOrderFulfillment(input: {
  orderId: number
  nextStatus: FulfillmentStatus
  /** An unattached upload by this actor for this order, or null for none. */
  deliveryChallanId: number | null
  /** Whether `DELIVERED` needs a challan. Super Admin's route: yes. The warehouse's: no. */
  challanRequired: boolean
  actor: { id: string; role: string }
  /** The caller's scope check on the order as read, before anything moves. */
  authorize: (order: { organizationId: number | null; branchId: number }) => Promise<boolean>
  /**
   * The caller's scope check again, inside the writing transaction, for a
   * reach that can be withdrawn mid-request (the warehouse's branches).
   */
  guardInTransaction?: (tx: Tx, order: { organizationId: number | null; branchId: number }) => Promise<boolean>
}): Promise<FulfillmentProgressOutcome> {
  const { orderId, nextStatus, actor } = input
  if (!PROGRESS_STATUSES.includes(nextStatus)) {
    return { kind: "invalid-step", from: "NOT_STARTED", to: nextStatus }
  }

  const order = await loadOrder(db, orderId)
  if (!order) return { kind: "not-found" }
  if (!await input.authorize({ organizationId: order.organizationId, branchId: order.branchId })) {
    return { kind: "out-of-scope" }
  }

  const deliveryChallanId = input.deliveryChallanId
  const check = stepCheck(order, nextStatus, deliveryChallanId, input.challanRequired)
  if (check.kind !== "ok") return check
  const { currentStatus } = check

  let updated: NonNullable<OrderRow> | "conflict" | "missing-column"
  let deliveredEventKeys: string[] = []
  try {
    updated = await db.transaction(async (tx) => {
      if (input.guardInTransaction
        && !await input.guardInTransaction(tx, { organizationId: order.organizationId, branchId: order.branchId })) {
        throw new Error(OUT_OF_SCOPE)
      }

      const transition = await transitionOrderFulfillmentStatusColumn(tx, orderId, currentStatus, nextStatus)
      if (transition !== "updated") return transition

      // A challan named on a delivery is attached here, in the same
      // transaction, and only an upload for this order by this actor that is
      // not yet attached matches. Otherwise the whole transition rolls back.
      if (nextStatus === "DELIVERED" && deliveryChallanId !== null) {
        const attached = await attachDeliveryChallan(tx, {
          challanId: deliveryChallanId,
          orderId,
          actorUserId: actor.id,
          at: new Date(),
        })
        if (!attached) throw new Error(DELIVERY_CHALLAN_NOT_ATTACHABLE)
      }

      await tx.insert(auditLogs).values({
        userId: actor.id,
        organizationId: order.organizationId,
        branchId: order.branchId,
        action: "ORDER_FULFILLMENT_STATUS_UPDATE",
        entity: "Order",
        entityId: String(order.id),
        metadata: {
          tid: order.tid,
          from: currentStatus,
          to: nextStatus,
          actorRole: actor.role,
          ...(deliveryChallanId !== null ? { deliveryChallanId } : {}),
        },
      })

      // Processing has started, so the tax invoice is issued now, numbered and
      // dated in this transaction: if it cannot be, the step is not recorded
      // either. A later step finds it issued and does nothing — or issues it,
      // for an order that was already past In Process when the stage moved.
      if (issuesTaxInvoiceOnStep(nextStatus)) {
        await issueTaxInvoice(tx, { orderId, actor, stage: nextStatus })
      }

      // The goods have arrived: the raiser and the approver are asked to
      // acknowledge them. Nobody is asked when the token was already handed
      // over, because the settlement below fulfils the order at once.
      if (nextStatus === "DELIVERED") {
        deliveredEventKeys = (await queueOrderDeliveredNotifications(tx, { orderId })).eventKeys
      }

      return (await loadOrder(tx, orderId)) ?? { ...order, fulfillmentStatus: nextStatus }
    })
  } catch (transitionError) {
    const refusal = transitionErrorOutcome(transitionError)
    if (refusal) return refusal
    throw transitionError
  }

  if (updated === "missing-column") return { kind: "missing-column" }
  if (updated === "conflict") return { kind: "conflict" }

  await attemptImmediateOrderEmailDelivery(deliveredEventKeys)

  const fulfilled = nextStatus === "DELIVERED"
    && await settleOnDeliveryIfTokenHandedOff(
      { id: order.id, tid: order.tid, organizationId: order.organizationId, branchId: order.branchId },
      actor.id,
    )

  // Settling the order changed the row this reports, so it is read back rather
  // than describing the state it had a moment earlier.
  const settled = fulfilled ? await loadOrder(db, orderId) : null
  return { kind: "updated", order: settled ?? updated, fulfilled }
}
