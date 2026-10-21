import { eq } from "drizzle-orm"
import { orders, riderOrderAssignments, riderPodImages, riderProfiles } from "@/db/schema"
import { error, ok, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { canManageRiders } from "@/lib/rider-access"

export async function GET(
  _req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const id = Number((await props.params).id)
    if (!Number.isSafeInteger(id) || id <= 0) return error("Not found", 404)

    const [row] = await db
      .select({
        assignment: riderOrderAssignments,
        orderTid: orders.tid,
        orderStatus: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        riderCode: riderProfiles.code,
      })
      .from(riderOrderAssignments)
      .innerJoin(orders, eq(orders.id, riderOrderAssignments.orderId))
      .innerJoin(riderProfiles, eq(riderProfiles.userId, riderOrderAssignments.riderUserId))
      .where(eq(riderOrderAssignments.id, id))
      .limit(1)

    if (!row) return error("Assignment not found", 404)

    const images = await db
      .select({
        id: riderPodImages.id,
        storageKey: riderPodImages.storageKey,
        uploadedAt: riderPodImages.uploadedAt,
      })
      .from(riderPodImages)
      .where(eq(riderPodImages.assignmentId, id))

    return ok({ ...row, proofImages: images })
  } catch (err) {
    console.error("[rider-ops/assignments/:id]", err)
    return error("Failed to load assignment", 500)
  }
}
