import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { canRaiseProductRequest } from "@/lib/product-request-access"
import { sanitizeRasterUpload } from "@/lib/server/upload-security"
import { withRateLimit } from "@/lib/rate-limiter"
import { db } from "@/lib/db"
import { auditActorFromSession, recordAuditEvent } from "@/lib/server/activity-audit"
import { isOrderDeskRole } from "@/lib/order-desk-access"
import { DELIVERY_CHALLAN_UPLOAD_PURPOSE } from "@/lib/delivery-challan"
import { storeDeliveryChallanUpload } from "@/lib/server/delivery-challan"
import { warehouseChallanUploadRefusal } from "@/lib/server/warehouse-orders"
import { isWarehouseRole } from "@/lib/warehouse-access"
import {
  buildImageKey,
  buildOrderIntakeAttachmentKey,
  extensionForMime,
  imagePathForKey,
  isImageStorageConfigured,
  putImage,
} from "@/lib/server/image-storage"

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Super Admin uploads catalogue images. Head Office uploads the picture on a
    // new-product request — through this path rather than one of its own,
    // because it is the one raster upload the production WAF lets through
    // (see `plans/OF-PRODUCT-REQUEST-head-office-new-product-requests.md`).
    // That grants Head Office no new reach: it already sets its catalogue's
    // `custom_image_url` through `PUT /api/v1/head-office/organization-inventory`.
    // The Order Desk uploads the screenshot of a customer's WhatsApp message or
    // email, here for the same WAF reason. Its upload is stored privately and
    // handled apart from catalogue images below. The warehouse uploads a
    // delivery challan and nothing else (plans/OF-WAREHOUSE-warehouse-fulfilment-role.md).
    const userRole = (session.user as any).role
    if (
      userRole !== "SUPER_ADMIN"
      && !canRaiseProductRequest(userRole)
      && !isOrderDeskRole(userRole)
      && !isWarehouseRole(userRole)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("upload", (session.user as any).id)
    if (rateLimit) return rateLimit

    const formData = await req.formData()
    const file = formData.get("image")

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No image file provided" }, { status: 400 })
    }

    // A delivery challan (an image or a PDF) for an order Super Admin is
    // marking delivered. Through this path for the same WAF reason as the
    // others; handled entirely apart from catalogue images.
    if (formData.get("purpose") === DELIVERY_CHALLAN_UPLOAD_PURPOSE) {
      return storeDeliveryChallan(session, userRole, formData.get("orderId"), file)
    }
    // The warehouse uploads challans only — never a catalogue image.
    if (isWarehouseRole(userRole)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)

    // Re-encodes through sharp, which drops EXIF and any embedded payload. This
    // has to happen server-side, which is why uploads are proxied here rather
    // than handed a presigned URL straight to the bucket.
    const validation = await sanitizeRasterUpload({
      buffer,
      declaredMime: file.type,
    })
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 })
    }

    const extension = extensionForMime(validation.image.mime)
    if (!extension) {
      return NextResponse.json({ error: "Unsupported image type" }, { status: 400 })
    }

    if (isOrderDeskRole(userRole)) {
      return storeOrderIntakeAttachment(session, validation, extension)
    }

    if (!isImageStorageConfigured()) {
      // Never silently fall back to a base64 column in production - that is the
      // behaviour this endpoint exists to replace.
      if (process.env.NODE_ENV === "production") {
        console.error("Upload rejected: AWS_REGION/S3_UPLOADS_BUCKET are not configured")
        return NextResponse.json(
          { error: "Image storage is not configured" },
          { status: 503 },
        )
      }

      console.warn(
        "[upload] S3 is not configured; returning an inline data URL for local development only",
      )
      return NextResponse.json({
        url: `data:${validation.image.mime};base64,${validation.buffer.toString("base64")}`,
        fileName: validation.generatedFileName,
        size: validation.buffer.length,
        type: validation.image.mime,
        width: validation.image.width,
        height: validation.image.height,
      })
    }

    const key = buildImageKey(extension)
    await putImage({
      key,
      body: validation.buffer,
      contentType: validation.image.mime,
    })

    // Recorded after the object lands, and a failure here propagates.
    //
    // There is no transaction to share with an S3 write, so the two cannot be
    // made atomic. Of the two failure modes, an orphaned object the caller
    // retries past is better than a file silently accepted with no record of
    // who put it there — and an orphan was already possible whenever a client
    // disconnects mid-upload.
    await recordAuditEvent(db, {
      action: "UPLOAD_IMAGE",
      entity: "image",
      entityId: key,
      actor: auditActorFromSession(session),
      after: {
        path: imagePathForKey(key),
        type: validation.image.mime,
        sizeBytes: validation.buffer.length,
        width: validation.image.width,
        height: validation.image.height,
      },
      // The name the browser sent, kept because it is the only clue to what the
      // file was meant to be; the stored key is deliberately not derived from it.
      context: { originalFileName: validation.generatedFileName },
    })

    return NextResponse.json({
      url: imagePathForKey(key),
      fileName: validation.generatedFileName,
      size: validation.buffer.length,
      type: validation.image.mime,
      width: validation.image.width,
      height: validation.image.height,
    })

  } catch (error: any) {
    console.error("Critical Upload Error:", error)
    return NextResponse.json({
      error: "Internal Server Error",
      details: "Upload failed"
    }, { status: 500 })
  }
}

/**
 * A delivery challan is uploaded by Super Admin, or by the warehouse for an
 * order at a branch it serves that is out for delivery or delivered — never by
 * anyone else this route admits. It is checked by content (re-encoded if an image, inspected if a
 * PDF), stored under the private `delivery-challan/` prefix, and answered with
 * a row id bound to this order and this uploader — never a path.
 */
async function storeDeliveryChallan(
  session: unknown,
  userRole: unknown,
  rawOrderId: FormDataEntryValue | null,
  file: File,
) {
  if (userRole !== "SUPER_ADMIN" && !isWarehouseRole(userRole)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const orderId = typeof rawOrderId === "string" && /^\d+$/.test(rawOrderId) ? Number(rawOrderId) : NaN
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "A valid orderId is required" }, { status: 400 })
  }
  const actor = auditActorFromSession(session)
  if (!actor.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (isWarehouseRole(userRole)) {
    const refusal = await warehouseChallanUploadRefusal(actor.id, orderId)
    if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status })
  }

  const outcome = await storeDeliveryChallanUpload({ actor: { ...actor, id: actor.id }, orderId, file })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
  return NextResponse.json({ deliveryChallan: outcome.challan }, { status: 201 })
}

/**
 * A desk screenshot carries a customer's personal details, so it is never a
 * catalogue image: it is stored under the private `order-intake/` prefix (which
 * the public image route cannot serve), never as a `data:` URL even in local
 * development, and answered with its key rather than a readable path. The key
 * is bound to its uploader by this audit row; order creation checks it.
 */
async function storeOrderIntakeAttachment(
  session: unknown,
  validation: { buffer: Buffer; image: { mime: string; width: number; height: number } },
  extension: NonNullable<ReturnType<typeof extensionForMime>>,
) {
  if (!isImageStorageConfigured()) {
    return NextResponse.json({ error: "Image storage is not configured" }, { status: 503 })
  }
  const key = buildOrderIntakeAttachmentKey(extension)
  await putImage({ key, body: validation.buffer, contentType: validation.image.mime })
  // Written after the object lands, for the reason given on the catalogue path.
  await recordAuditEvent(db, {
    action: "UPLOAD_ORDER_INTAKE_ATTACHMENT",
    entity: "image",
    entityId: key,
    actor: auditActorFromSession(session),
    after: {
      type: validation.image.mime,
      sizeBytes: validation.buffer.length,
      width: validation.image.width,
      height: validation.image.height,
    },
  })
  return NextResponse.json({
    attachmentKey: key,
    size: validation.buffer.length,
    type: validation.image.mime,
  })
}
