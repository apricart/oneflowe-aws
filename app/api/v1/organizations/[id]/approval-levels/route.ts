import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { logError } from "@/lib/global-logger"
import { orderApprovalLevelsSchema, validationMessage } from "@/lib/server/mutation-validation"
import {
  readOrganizationApprovalLevels,
  saveOrganizationApprovalLevels,
} from "@/lib/server/order-approval-levels"

export const dynamic = "force-dynamic"

/**
 * An organization's order approval levels
 * (plans/OF-APPROVAL-LEVELS-organization-approval-levels.md).
 *
 * Writing is SUPER_ADMIN only: whether a tenant's orders carry approval levels,
 * and what each level may approve, is set by Apricart, never by the tenant.
 * Reading is also open to HEAD_OFFICE for its own organization, whose user
 * forms list the levels to assign (plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md).
 * Kept off the organization PATCH, as private network login is, so the whole
 * set is read and replaced as one thing.
 */

function parseOrganizationId(value: string): number | null {
  // Digits only, so "1.5" or "1e3" can never be read as some other organization.
  if (!/^\d{1,9}$/.test(value)) return null
  const organizationId = Number(value)
  return organizationId > 0 ? organizationId : null
}

/** GET /api/v1/organizations/:id/approval-levels */
export async function GET(
  _req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
  if (authError) return authError

  try {
    const { id } = await props.params
    const organizationId = parseOrganizationId(id)
    if (organizationId === null) return error("Invalid organization ID", 400)

    // Head Office reads its own organization only; any other reads as absent.
    // The organization comes from the session's user row, never the request.
    const scope = await getRequestScope()
    if (!scope) return error("Invalid session data", 401)
    if (scope.role !== "SUPER_ADMIN" && scope.organizationId !== organizationId) {
      return error("Organization not found", 404)
    }

    const state = await readOrganizationApprovalLevels(organizationId)
    if (!state) return error("Organization not found", 404)

    return ok(state)
  } catch (e: unknown) {
    logError(e, "ORGANIZATION_APPROVAL_LEVELS_GET")
    return error("Failed to load approval levels", 500)
  }
}

/**
 * PUT /api/v1/organizations/:id/approval-levels
 *
 * `{ enabled, levels? }`. Replaces the switch and, when sent, the whole list in
 * one transaction. Omitting `levels` keeps the stored ones.
 */
export async function PUT(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(["SUPER_ADMIN"])
  if (authError) return authError

  try {
    const { id } = await props.params
    const organizationId = parseOrganizationId(id)
    if (organizationId === null) return error("Invalid organization ID", 400)

    const parsedBody = orderApprovalLevelsSchema.safeParse(await readJson<unknown>(req))
    if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)

    const scope = await getRequestScope()
    if (!scope?.userId) return error("Invalid session data", 401)

    const outcome = await saveOrganizationApprovalLevels({
      organizationId,
      enabled: parsedBody.data.enabled,
      amountsCents: parsedBody.data.levels?.map((level) => level.maxAmountCents),
      actor: { id: scope.userId, role: scope.role },
    })
    if (outcome.kind === "not-found") return error("Organization not found", 404)
    if (outcome.kind === "levels-held") return error(outcome.message, 409)

    if (outcome.changed) await invalidateByPrefix("organizations")

    return ok({
      ...outcome.state,
      changed: outcome.changed,
      message: outcome.changed ? "Approval levels saved" : "Approval levels unchanged",
    })
  } catch (e: unknown) {
    logError(e, "ORGANIZATION_APPROVAL_LEVELS_PUT")
    return error("Failed to save approval levels", 500)
  }
}
