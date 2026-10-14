import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import {
  contentTypeForDeliveryChallanKey,
  deliveryChallanContentDisposition,
  isDeliveryChallanKey,
} from "@/lib/delivery-challan"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadDeliveryChallanFile } from "@/lib/server/delivery-challan"
import { getImage, isImageStorageConfigured } from "@/lib/server/image-storage"
import { ORDER_DETAIL_READ_ROLES, canReadOrderDetail } from "@/lib/server/order-read-access"

/**
 * One delivery challan's bytes, for whoever may read the order. Non-Super-Admin
 * readers reach only the current challan. Anything out of scope — another
 * tenant's order, an id that is not this order's, a replaced challan — is the
 * same 404.
 *
 * Served from the private store with the content type the server decided at
 * upload, never shared-cached, never sniffed, sandboxed, and a PDF always as a
 * download: it was inspected, not re-encoded, so it never renders in this
 * origin.
 */
export async function GET(
  _req: Request,
  props: { params: Promise<{ id: string; challanId: string }> },
) {
  const roleError = await requireApiRole([...ORDER_DETAIL_READ_ROLES], { viewerReadsAsHeadOffice: true })
  if (roleError) return roleError

  const { id, challanId } = await props.params
  const orderId = /^\d+$/.test(id) ? Number(id) : NaN
  const fileId = /^\d+$/.test(challanId) ? Number(challanId) : NaN
  if (!Number.isSafeInteger(orderId) || orderId <= 0 || !Number.isSafeInteger(fileId) || fileId <= 0) {
    return error("Not found", 404)
  }

  const scope = await getRequestScope()
  if (!scope) return error("Unauthorized", 401)
  const rateLimited = await withRateLimit("api", scope.userId)
  if (rateLimited) return rateLimited

  try {
    if (!await canReadOrderDetail({ orderId, scope, viewerReadsAsHeadOffice: true })) return error("Not found", 404)
    const file = await loadDeliveryChallanFile({
      orderId,
      challanId: fileId,
      includeReplaced: scope.role === "SUPER_ADMIN",
    })
    const contentType = file ? contentTypeForDeliveryChallanKey(file.storageKey) : null
    if (!file || !isDeliveryChallanKey(file.storageKey) || !contentType) return error("Not found", 404)

    if (!isImageStorageConfigured()) return error("File storage is not configured", 503)
    const object = await getImage(file.storageKey)
    if (!object?.body) return error("Not found", 404)

    const headers = new Headers({
      // From the key the server generated, never from the stored object's metadata.
      "Content-Type": contentType,
      "Content-Disposition": deliveryChallanContentDisposition(contentType, file.fileName),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
    })
    if (object.contentLength !== undefined) headers.set("Content-Length", String(object.contentLength))
    return new NextResponse(object.body.transformToWebStream(), { headers })
  } catch (loadError) {
    const handled = handleError(loadError, "GET /api/v1/orders/[id]/delivery-challan/[challanId]/file")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
