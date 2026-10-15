import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { logError } from "@/lib/global-logger"
import { userApprovalLevelUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"
import { setUserApprovalLevel } from "@/lib/server/user-approval-level"
import { USER_MANAGEMENT_ROLES } from "@/lib/user-management-access"

export const dynamic = "force-dynamic"

/**
 * PUT /api/v1/users/:id/approval-level — `{ level: number | null }`
 * (plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md).
 *
 * Super Admin, or Head Office for a user of its own organization. Kept off
 * `PATCH .../access`, which ends every session of the user on any change: a
 * level is not part of the session, so assigning one must not sign anyone out.
 * The rules and the audit row live in `lib/server/user-approval-level.ts`.
 */
export async function PUT(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(USER_MANAGEMENT_ROLES)
  if (authError) return authError

  try {
    const scope = await getRequestScope()
    if (!scope?.userId) return error("Invalid session data", 401)

    const { id: targetUserId } = await props.params
    // A malformed id is answered like an absent one, before it reaches a uuid column.
    if (!/^[0-9a-f-]{36}$/i.test(targetUserId)) return error("User not found", 404)

    const parsedBody = userApprovalLevelUpdateSchema.safeParse(await readJson<unknown>(req))
    if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)

    const outcome = await setUserApprovalLevel({
      actor: { userId: scope.userId, role: scope.role, organizationId: scope.organizationId ?? null },
      targetUserId,
      level: parsedBody.data.level,
    })

    if (outcome.kind === "not-found") return error("User not found", 404)
    if (outcome.kind === "forbidden") return error(outcome.message, 403)
    if (outcome.kind === "refused") return error(outcome.message, 400)

    if (outcome.changed) await invalidateByPrefix("users")
    return ok({ item: { id: targetUserId, orderApprovalLevel: outcome.level }, changed: outcome.changed })
  } catch (e: unknown) {
    logError(e, "USER_APPROVAL_LEVEL_PUT")
    return error("Failed to save the approval level", 500)
  }
}
