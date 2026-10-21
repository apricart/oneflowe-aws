import { z } from "zod"
import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders } from "@/lib/rider-access"
import { rejectPod } from "@/lib/server/rider-assignments"

const bodySchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict()

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const limited = await withRateLimit("write", user.id)
    if (limited) return limited

    const parsed = bodySchema.safeParse(await readJson(req))
    if (!parsed.success) return error("reason is required", 400)

    const id = Number((await props.params).id)
    if (!Number.isSafeInteger(id) || id <= 0) return error("Not found", 404)

    const result = await rejectPod({
      actorUserId: user.id,
      actorRole: user.role,
      assignmentId: id,
      reason: parsed.data.reason,
    })

    if (result.kind === "not_found") return error("Assignment not found", 404)
    if (result.kind === "conflict") {
      return error(`Cannot reject POD from status ${result.status}`, 409)
    }

    return ok({ rejected: true })
  } catch (err) {
    console.error("[rider-ops/.../pod/reject]", err)
    return error("Failed to reject POD", 500)
  }
}
