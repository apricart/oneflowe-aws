import { z } from "zod"
import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders } from "@/lib/rider-access"
import { reorderSequences } from "@/lib/server/rider-assignments"

const bodySchema = z
  .object({
    riderId: z.string().uuid(),
    orderedAssignmentIds: z.array(z.number().int().positive()).min(1).max(100),
  })
  .strict()

export async function PATCH(req: Request) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const limited = await withRateLimit("write", user.id)
    if (limited) return limited

    const parsed = bodySchema.safeParse(await readJson(req))
    if (!parsed.success) return error("Invalid body", 400)

    const result = await reorderSequences({
      actorUserId: user.id,
      actorRole: user.role,
      riderUserId: parsed.data.riderId,
      orderedAssignmentIds: parsed.data.orderedAssignmentIds,
    })

    if (result.kind === "not_found") {
      return error(`Assignment ${result.assignmentId} not found for rider`, 404)
    }

    return ok({ reordered: true })
  } catch (err) {
    console.error("[rider-ops/assignments/sequence]", err)
    return error("Failed to reorder", 500)
  }
}
