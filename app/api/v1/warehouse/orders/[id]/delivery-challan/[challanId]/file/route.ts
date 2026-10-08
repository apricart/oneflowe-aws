import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import {
  contentTypeForDeliveryChallanKey,
  deliveryChallanContentDisposition,
  isDeliveryChallanKey,
} from "@/lib/delivery-challan"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadDeliveryChallanFile } from "@/lib/server/delivery-challan"
import { getImage, isImageStorageConfigured } from "@/lib/server/image-storage"
import { loadWarehouseOrderInReach } from "@/lib/server/warehouse-scope"
import { parseRouteId } from "@/lib/warehouse-orders"

/**
 * One delivery challan's bytes, for the warehouse: current challans of orders
 * at its branches only. Anything else is the same 404. Served exactly as the
 * order readers' route serves it — private, never sniffed, sandboxed, a PDF
 * always as a download.
 */
export async function GET(
  _req: Request,
  props: { params: Promise<{ id: string; challanId: string }> },
) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const { id, challanId } = await props.params
    const orderId = parseRouteId(id)
    const fileId = parseRouteId(challanId)
    if (orderId === null || fileId === null) return error("Not found", 404)

    const rateLimited = await withRateLimit("api", user.id)
    if (rateLimited) return rateLimited

    if (!await loadWarehouseOrderInReach(db, user.id, orderId)) return error("Not found", 404)
    const file = await loadDeliveryChallanFile({ orderId, challanId: fileId, includeReplaced: false })
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
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/orders/[id]/delivery-challan/[challanId]/file")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
