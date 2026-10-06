import "server-only"

import { randomUUID } from "node:crypto"

import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm"

import { orderDeliveryChallans, orders, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import {
  DELIVERY_CHALLAN_KEY_PREFIX,
  MAX_DELIVERY_CHALLAN_BYTES,
  deliveryChallanExtensionFor,
  isDeliveryChallanContentType,
  sanitizeDeliveryChallanFileName,
  type DeliveryChallanContentType,
} from "@/lib/delivery-challan"
import { isOrderDelivered } from "@/lib/fulfillment-status"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"
import { isImageStorageConfigured, putImage } from "@/lib/server/image-storage"
import { inspectPdfUpload } from "@/lib/server/pdf-upload-security"
import { sanitizeRasterUpload } from "@/lib/server/upload-security"

/**
 * Delivery challans: storing, attaching, replacing and reading them.
 * See plans/OF-DELIVERY-CHALLAN-proof-of-delivery.md and `lib/delivery-challan.ts`.
 *
 * Who may *write* is Super Admin, checked by each route; who may *read* is
 * whoever may read the order (`canReadOrderDetail`), checked by the read
 * routes. Nothing here widens either.
 */

const PDF_SIGNATURE = Buffer.from("%PDF-", "latin1")

export type DeliveryChallanUploadOutcome =
  | {
    ok: true
    challan: { id: number; fileName: string; contentType: DeliveryChallanContentType; sizeBytes: number }
  }
  | { ok: false; status: number; error: string }

/** Statuses an order can be in while a challan is still relevant to it. */
const CHALLAN_ORDER_STATUSES = new Set(["APPROVED", "FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"])

/**
 * Check and store one uploaded file as a challan for one order, unattached.
 *
 * Images are re-encoded through sharp; PDFs are inspected and refused if they
 * carry anything active. The type is decided by the bytes, never by the name
 * or the browser's claim. The row is bound to this order and this uploader, and
 * only a later delivery or replacement by the same uploader can attach it.
 */
export async function storeDeliveryChallanUpload(input: {
  actor: AuditActor & { id: string }
  orderId: number
  file: File
}): Promise<DeliveryChallanUploadOutcome> {
  const [order] = await db
    .select({ id: orders.id, organizationId: orders.organizationId, branchId: orders.branchId, status: orders.status })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1)
  if (!order?.organizationId) return { ok: false, status: 404, error: "Order not found" }
  if (!CHALLAN_ORDER_STATUSES.has(String(order.status).toUpperCase())) {
    return { ok: false, status: 409, error: `A delivery challan cannot be added to a ${order.status} order` }
  }

  if (input.file.size <= 0) return { ok: false, status: 400, error: "The file is empty" }
  if (input.file.size > MAX_DELIVERY_CHALLAN_BYTES) {
    return { ok: false, status: 400, error: "The delivery challan must be 4 MB or smaller" }
  }
  const raw = Buffer.from(await input.file.arrayBuffer())

  let body: Buffer
  let contentType: DeliveryChallanContentType
  if (raw.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    const inspection = inspectPdfUpload(raw)
    if (!inspection.ok) return { ok: false, status: 400, error: inspection.error }
    body = raw
    contentType = "application/pdf"
  } else {
    const image = await sanitizeRasterUpload({ buffer: raw, declaredMime: input.file.type })
    if (!image.ok) return { ok: false, status: 400, error: image.error }
    if (!isDeliveryChallanContentType(image.image.mime)) {
      return { ok: false, status: 400, error: "A delivery challan must be a JPG, PNG, WebP or PDF file" }
    }
    body = image.buffer
    contentType = image.image.mime
  }
  if (body.length > MAX_DELIVERY_CHALLAN_BYTES) {
    return { ok: false, status: 400, error: "The delivery challan must be 4 MB or smaller" }
  }

  // Never a data: URL, not even in development: a challan is a client's
  // document and lives only in the private store.
  if (!isImageStorageConfigured()) return { ok: false, status: 503, error: "File storage is not configured" }

  const extension = deliveryChallanExtensionFor(contentType)
  const key = `${DELIVERY_CHALLAN_KEY_PREFIX}/${randomUUID()}.${extension}`
  const fileName = sanitizeDeliveryChallanFileName(input.file.name, extension)
  await putImage({ key, body, contentType })

  // The object is already stored and cannot share a transaction; the row and
  // its audit entry can, so the trail never disagrees with the table.
  const challan = await db.transaction(async (tx) => {
    const [row] = await tx.insert(orderDeliveryChallans).values({
      orderId: order.id,
      organizationId: order.organizationId!,
      branchId: order.branchId,
      storageKey: key,
      fileName,
      contentType,
      sizeBytes: body.length,
      uploadedByUserId: input.actor.id,
    }).returning({ id: orderDeliveryChallans.id })

    await recordAuditEvent(tx, {
      action: "UPLOAD_DELIVERY_CHALLAN",
      entity: "order",
      entityId: order.id,
      actor: input.actor,
      organizationId: order.organizationId,
      branchId: order.branchId,
      after: { deliveryChallanId: row.id, fileName, contentType, sizeBytes: body.length },
      context: { attached: false },
    })
    return row
  })

  return { ok: true, challan: { id: challan.id, fileName, contentType, sizeBytes: body.length } }
}

/**
 * Attach an uploaded challan, inside the caller's transaction. Matches only a
 * row for **this order**, uploaded by **this actor**, never attached — so a
 * challan id cannot be borrowed from another order, another person, or reused.
 */
export async function attachDeliveryChallan(tx: any, input: {
  challanId: number
  orderId: number
  actorUserId: string
  at: Date
}): Promise<boolean> {
  const [attached] = await tx
    .update(orderDeliveryChallans)
    .set({ attachedAt: input.at })
    .where(and(
      eq(orderDeliveryChallans.id, input.challanId),
      eq(orderDeliveryChallans.orderId, input.orderId),
      eq(orderDeliveryChallans.uploadedByUserId, input.actorUserId),
      isNull(orderDeliveryChallans.attachedAt),
    ))
    .returning({ id: orderDeliveryChallans.id })
  return Boolean(attached)
}

export type ReplaceDeliveryChallanOutcome =
  | { kind: "replaced"; previousChallanId: number | null }
  | { kind: "not-found" }
  | { kind: "not-delivered"; status: string }
  | { kind: "invalid-challan" }

/**
 * Super Admin swaps a delivered order's challan. The previous one is kept,
 * marked replaced; both moves and the audit row share one transaction, under
 * the order's row lock.
 */
export async function replaceDeliveryChallan(input: {
  orderId: number
  challanId: number
  actor: AuditActor & { id: string }
}): Promise<ReplaceDeliveryChallanOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const [order] = await tx
        .select({
          id: orders.id,
          tid: orders.tid,
          organizationId: orders.organizationId,
          branchId: orders.branchId,
          fulfillmentStatus: orders.fulfillmentStatus,
        })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .for("update")
        .limit(1)
      if (!order) return { kind: "not-found" } as const
      if (!isOrderDelivered(order.fulfillmentStatus)) {
        return { kind: "not-delivered", status: String(order.fulfillmentStatus ?? "NOT_STARTED") } as const
      }

      const now = new Date()
      const [previous] = await tx
        .update(orderDeliveryChallans)
        .set({ replacedAt: now, replacedByUserId: input.actor.id })
        .where(and(
          eq(orderDeliveryChallans.orderId, order.id),
          isNotNull(orderDeliveryChallans.attachedAt),
          isNull(orderDeliveryChallans.replacedAt),
        ))
        .returning({ id: orderDeliveryChallans.id })

      const attached = await attachDeliveryChallan(tx, {
        challanId: input.challanId,
        orderId: order.id,
        actorUserId: input.actor.id,
        at: now,
      })
      // Roll the replacement of the old one back with it.
      if (!attached) throw new Error("DELIVERY_CHALLAN_NOT_ATTACHABLE")

      await recordAuditEvent(tx, {
        action: "REPLACE_DELIVERY_CHALLAN",
        entity: "order",
        entityId: order.id,
        actor: input.actor,
        organizationId: order.organizationId,
        branchId: order.branchId,
        before: { deliveryChallanId: previous?.id ?? null },
        after: { deliveryChallanId: input.challanId },
        context: { tid: order.tid },
      })
      return { kind: "replaced", previousChallanId: previous?.id ?? null } as const
    })
  } catch (error) {
    if (error instanceof Error && error.message === "DELIVERY_CHALLAN_NOT_ATTACHABLE") return { kind: "invalid-challan" }
    throw error
  }
}

export type DeliveryChallanSummary = {
  id: number
  fileName: string
  contentType: string
  sizeBytes: number
  uploadedAt: Date
  /** The uploader's role, never the person: every reader of the order sees this. */
  uploadedByRole: string | null
  attachedAt: Date | null
  replacedAt: Date | null
  current: boolean
}

/**
 * An order's challans: the current one, and — for Super Admin — every one it
 * replaced. Unattached uploads are never listed. The caller has authorized the
 * read of this order.
 */
export async function listDeliveryChallans(input: {
  orderId: number
  includeReplaced: boolean
}): Promise<DeliveryChallanSummary[]> {
  const rows = await db
    .select({
      id: orderDeliveryChallans.id,
      fileName: orderDeliveryChallans.fileName,
      contentType: orderDeliveryChallans.contentType,
      sizeBytes: orderDeliveryChallans.sizeBytes,
      uploadedAt: orderDeliveryChallans.uploadedAt,
      uploadedByRole: roles.name,
      attachedAt: orderDeliveryChallans.attachedAt,
      replacedAt: orderDeliveryChallans.replacedAt,
    })
    .from(orderDeliveryChallans)
    .leftJoin(users, eq(users.id, orderDeliveryChallans.uploadedByUserId))
    .leftJoin(roles, eq(roles.id, users.roleId))
    .where(and(
      eq(orderDeliveryChallans.orderId, input.orderId),
      isNotNull(orderDeliveryChallans.attachedAt),
      input.includeReplaced ? undefined : isNull(orderDeliveryChallans.replacedAt),
    ))
    .orderBy(sql`${orderDeliveryChallans.replacedAt} IS NULL DESC`, asc(orderDeliveryChallans.attachedAt))
    .limit(50)
  return rows.map((row) => ({ ...row, current: row.replacedAt === null }))
}

/** One attached challan of this order, for streaming. Replaced ones only when allowed. */
export async function loadDeliveryChallanFile(input: {
  orderId: number
  challanId: number
  includeReplaced: boolean
}): Promise<{ storageKey: string; fileName: string; contentType: string } | null> {
  const [row] = await db
    .select({
      storageKey: orderDeliveryChallans.storageKey,
      fileName: orderDeliveryChallans.fileName,
      contentType: orderDeliveryChallans.contentType,
    })
    .from(orderDeliveryChallans)
    .where(and(
      eq(orderDeliveryChallans.id, input.challanId),
      eq(orderDeliveryChallans.orderId, input.orderId),
      isNotNull(orderDeliveryChallans.attachedAt),
      input.includeReplaced ? undefined : isNull(orderDeliveryChallans.replacedAt),
    ))
    .limit(1)
  return row ?? null
}
