import { error, ok, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders } from "@/lib/rider-access"
import { approvePod } from "@/lib/server/rider-assignments"

export async function POST(
  _req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const limited = await withRateLimit("write", user.id)
    if (limited) return limited

    const id = Number((await props.params).id)
    if (!Number.isSafeInteger(id) || id <= 0) return error("Not found", 404)

    const result = await approvePod({
      actorUserId: user.id,
      actorRole: user.role,
      assignmentId: id,
    })

    if (result.kind === "not_found") return error("Assignment not found", 404)
    if (result.kind === "conflict") {
      return error(`Cannot approve POD from status ${result.status}`, 409)
    }
    if (result.kind === "progress_failed") {
      return error(`Could not mark order delivered (${result.outcome})`, 409)
    }

    return ok({ approved: true })
  } catch (err) {
    console.error("[rider-ops/.../pod/approve]", err)
    return error("Failed to approve POD", 500)
  }
}
