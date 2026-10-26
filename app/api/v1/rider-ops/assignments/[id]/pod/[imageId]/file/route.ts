import { and, eq } from "drizzle-orm"
import { NextResponse } from "next/server"

import { riderOrderAssignments, riderPodImages, riderProfiles } from "@/db/schema"
import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders } from "@/lib/rider-access"
import { contentTypeForKey, getImage, isImageStorageConfigured } from "@/lib/server/image-storage"

/** Accepts current + legacy POD key prefixes in the uploads bucket. */
const RIDER_POD_KEY =
  /^(?:proof-of-delivery|rider-pod)\/[0-9a-f-]{36}\.(jpg|jpeg|png|gif|webp)$/i

/**
 * One POD proof image for warehouse review. Fenced to assignments whose rider
 * belongs to this warehouse (same fence as assignment GET).
 */
export async function GET(
  _req: Request,
  props: { params: Promise<{ id: string; imageId: string }> },
) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const assignmentId = Number((await props.params).id)
    const imageId = Number((await props.params).imageId)
    if (!Number.isSafeInteger(assignmentId) || assignmentId <= 0) return error("Not found", 404)
    if (!Number.isSafeInteger(imageId) || imageId <= 0) return error("Not found", 404)

    const limited = await withRateLimit("api", user.id)
    if (limited) return limited

    const [row] = await db
      .select({
        storageKey: riderPodImages.storageKey,
        contentType: riderPodImages.contentType,
        riderUserId: riderOrderAssignments.riderUserId,
        warehouseUserId: riderProfiles.warehouseUserId,
      })
      .from(riderPodImages)
      .innerJoin(
        riderOrderAssignments,
        eq(riderOrderAssignments.id, riderPodImages.assignmentId),
      )
      .innerJoin(riderProfiles, eq(riderProfiles.userId, riderOrderAssignments.riderUserId))
      .where(
        and(
          eq(riderPodImages.id, imageId),
          eq(riderPodImages.assignmentId, assignmentId),
        ),
      )
      .limit(1)

    if (!row) return error("Not found", 404)
    if (user.role === "WAREHOUSE" && row.warehouseUserId !== user.id) {
      return error("Not found", 404)
    }
    if (!RIDER_POD_KEY.test(row.storageKey)) return error("Not found", 404)

    if (!isImageStorageConfigured()) return error("File storage is not configured", 503)
    const object = await getImage(row.storageKey)
    if (!object?.body) return error("Not found", 404)

    const contentType =
      row.contentType || contentTypeForKey(row.storageKey) || object.contentType || "image/jpeg"
    const headers = new Headers({
      "Content-Type": contentType,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
    })
    if (object.contentLength !== undefined) {
      headers.set("Content-Length", String(object.contentLength))
    }
    return new NextResponse(object.body.transformToWebStream(), { headers })
  } catch (caught) {
    const handled = handleError(
      caught,
      "GET /api/v1/rider-ops/assignments/[id]/pod/[imageId]/file",
    )
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
