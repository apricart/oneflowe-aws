import { orders } from "@/db/schema"
import { sql } from "drizzle-orm"
import type { FulfillmentStatus } from "@/lib/fulfillment-status"
import type { PaymentStatus } from "@/lib/payment-status"

export const orderSelectColumns = {
  id: orders.id,
  tid: orders.tid,
  organizationId: orders.organizationId,
  branchId: orders.branchId,
  status: orders.status,
  fulfillmentStatus: sql<FulfillmentStatus>`COALESCE(to_jsonb("orders") ->> 'fulfillment_status', 'NOT_STARTED')`,
  paymentStatus: sql<PaymentStatus>`COALESCE(to_jsonb("orders") ->> 'payment_status', 'UNPAID')`,
  paidAt: sql<string | null>`to_jsonb("orders") ->> 'paid_at'`,
  // Read the same defensive way as the columns above, so an environment whose
  // hand-off migration has not been applied reports "never handed over" rather
  // than failing every order read.
  tokenHandoffAt: sql<string | null>`to_jsonb("orders") ->> 'token_handoff_at'`,
  paidByUserId: sql<string | null>`to_jsonb("orders") ->> 'paid_by_user_id'`,
  subtotalCents: orders.subtotalCents,
  taxCents: orders.taxCents,
  totalCents: orders.totalCents,
  notes: orders.notes,
  poNumber: orders.poNumber,
  // Read the same defensive way as the columns above, so an environment whose
  // delivery-address migration has not been applied reports "sent to the
  // branch's own address" rather than failing every order read. Production
  // migrations here are applied by hand and the application can be running
  // ahead of them.
  deliveryAddressId: sql<number | null>`NULLIF(to_jsonb("orders") ->> 'delivery_address_id', '')::int`,
  createdByUserId: orders.createdByUserId,
  // Whether the order took a budget hold — what every ledger move after
  // creation keys on (`orderTakesBudget`). Read defensively like the columns
  // above: before the migration every order took a hold, so a missing column
  // honestly reads "tracked".
  budgetTracked: sql<boolean>`COALESCE((to_jsonb("orders") ->> 'budget_tracked')::boolean, true)`,
  // The approval level the order waits at, or null (decided as before). Read
  // defensively like the columns above: before its migration no order had one.
  // See plans/OF-APPROVAL-LEVELS-route-orders-by-level.md.
  approvalLevel: sql<number | null>`NULLIF(to_jsonb("orders") ->> 'approval_level', '')::int`,
  createdAt: orders.createdAt,
  deliveredAt: orders.deliveredAt,
  fulfilledAt: orders.fulfilledAt,
  updatedAt: orders.updatedAt,
  approvedByUserId: orders.approvedByUserId,
  approvedAt: orders.approvedAt,
  rejectedByUserId: orders.rejectedByUserId,
  rejectedAt: orders.rejectedAt,
  rejectionReason: orders.rejectionReason,
  // The open correction request, while one is open — see
  // plans/OF-ORDER-RETURN-for-correction.md. Who sent it back stays out of
  // the shared read: the history on the order detail names people.
  returnedForCorrectionAt: orders.returnedForCorrectionAt,
  correctionRequestNote: orders.correctionRequestNote,
  approvalToken: orders.approvalToken,
  approvalTokenHash: orders.approvalTokenHash,
  approvalTokenCreatedAt: orders.approvalTokenCreatedAt,
  fulfilledByUserId: orders.fulfilledByUserId,
  refundedAt: orders.refundedAt,
  refundedByUserId: orders.refundedByUserId,
  statusAtRefund: orders.statusAtRefund,
  refundAmountCents: orders.refundAmountCents,
  refundReason: orders.refundReason,
  receiptData: orders.receiptData,
}

export function isMissingFulfillmentStatusColumn(error: any) {
  return error?.code === "42703" || error?.cause?.code === "42703"
}

export async function updateOrderPaymentStatusColumn(
  client: { execute: (query: any) => Promise<any> },
  orderId: number,
  status: PaymentStatus,
  userId: string,
) {
  try {
    if (status === "PAID") {
      await client.execute(sql`
        UPDATE "orders"
        SET "payment_status" = ${status}, "paid_at" = NOW(), "paid_by_user_id" = ${userId}, "updated_at" = NOW()
        WHERE "id" = ${orderId}
      `)
    } else {
      await client.execute(sql`
        UPDATE "orders"
        SET "payment_status" = ${status}, "paid_at" = NULL, "paid_by_user_id" = NULL, "updated_at" = NOW()
        WHERE "id" = ${orderId}
      `)
    }
    return true
  } catch (error) {
    if (isMissingFulfillmentStatusColumn(error)) return false
    throw error
  }
}

export async function updateOrderFulfillmentStatusColumn(
  client: { execute: (query: any) => Promise<any> },
  orderId: number,
  status: FulfillmentStatus,
) {
  try {
    await client.execute(sql`
      UPDATE "orders"
      SET "fulfillment_status" = ${status},
          "delivered_at" = CASE
            WHEN ${status} = 'DELIVERED' THEN COALESCE("delivered_at", NOW())
            ELSE "delivered_at"
          END,
          "updated_at" = NOW()
      WHERE "id" = ${orderId}
    `)
    return true
  } catch (error) {
    if (isMissingFulfillmentStatusColumn(error)) return false
    throw error
  }
}

export type AtomicTransitionResult = "updated" | "conflict" | "missing-column"

export async function transitionOrderPaymentStatusColumn(
  client: { execute: (query: any) => Promise<any> },
  orderId: number,
  currentStatus: PaymentStatus,
  nextStatus: PaymentStatus,
  userId: string,
): Promise<AtomicTransitionResult> {
  try {
    const result = nextStatus === "PAID"
      ? await client.execute(sql`
          UPDATE "orders"
          SET "payment_status" = ${nextStatus}, "paid_at" = NOW(), "paid_by_user_id" = ${userId}, "updated_at" = NOW()
          WHERE "id" = ${orderId}
            AND UPPER(TRIM("status")) IN ('APPROVED', 'FULFILLED')
            AND COALESCE("payment_status", 'UNPAID') = ${currentStatus}
          RETURNING "id"
        `)
      : await client.execute(sql`
          UPDATE "orders"
          SET "payment_status" = ${nextStatus}, "paid_at" = NULL, "paid_by_user_id" = NULL, "updated_at" = NOW()
          WHERE "id" = ${orderId}
            AND UPPER(TRIM("status")) IN ('APPROVED', 'FULFILLED')
            AND COALESCE("payment_status", 'UNPAID') = ${currentStatus}
          RETURNING "id"
        `)

    return (result as any)?.rows?.length > 0 ? "updated" : "conflict"
  } catch (error) {
    if (isMissingFulfillmentStatusColumn(error)) return "missing-column"
    throw error
  }
}

export async function transitionOrderFulfillmentStatusColumn(
  client: { execute: (query: any) => Promise<any> },
  orderId: number,
  currentStatus: FulfillmentStatus,
  nextStatus: FulfillmentStatus,
): Promise<AtomicTransitionResult> {
  try {
    const result = await client.execute(sql`
      UPDATE "orders"
      SET "fulfillment_status" = ${nextStatus},
          "delivered_at" = CASE
            WHEN ${nextStatus} = 'DELIVERED' THEN COALESCE("delivered_at", NOW())
            ELSE "delivered_at"
          END,
          "updated_at" = NOW()
      WHERE "id" = ${orderId}
        AND UPPER("status") = 'APPROVED'
        AND COALESCE("fulfillment_status", 'NOT_STARTED') = ${currentStatus}
      RETURNING "id"
    `)
    return (result as any)?.rows?.length > 0 ? "updated" : "conflict"
  } catch (error) {
    if (isMissingFulfillmentStatusColumn(error)) return "missing-column"
    throw error
  }
}
