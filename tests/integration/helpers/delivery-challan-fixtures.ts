import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"

import { orderDeliveryChallans, orders } from "@/db/schema"
import { db } from "@/lib/db"

/**
 * An uploaded, not yet attached delivery challan for one order, as
 * `POST /api/v1/upload/image` (purpose `delivery-challan`) would leave it.
 *
 * For suites that only need to record a delivery through the progress route,
 * which now requires one. The upload itself is exercised end to end in
 * `delivery-challan-api.test.ts`.
 */
export async function stageDeliveryChallan(orderId: number, uploadedByUserId: string): Promise<number> {
  const [order] = await db
    .select({ organizationId: orders.organizationId, branchId: orders.branchId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)
  if (!order?.organizationId) throw new Error(`Order ${orderId} has no organization`)

  const [row] = await db.insert(orderDeliveryChallans).values({
    orderId,
    organizationId: order.organizationId,
    branchId: order.branchId,
    storageKey: `delivery-challan/${randomUUID()}.pdf`,
    fileName: "delivery-challan.pdf",
    contentType: "application/pdf",
    sizeBytes: 512,
    uploadedByUserId,
  }).returning({ id: orderDeliveryChallans.id })
  return row.id
}
