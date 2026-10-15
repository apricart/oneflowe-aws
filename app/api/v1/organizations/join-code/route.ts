import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { handleError } from "@/lib/error-handler"
import { JOIN_REQUEST_MANAGEMENT_ROLES } from "@/lib/organization-join-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { joinCodeSetSchema, validationMessage } from "@/lib/server/mutation-validation"
import { writeJoinAudit } from "@/lib/server/organization-join-audit"
import { resolveJoinManagementScope } from "@/lib/server/organization-join-scope"
import {
  clearJoinCode,
  readJoinCode,
  readOrganizationEmailDomain,
  setJoinCode,
} from "@/lib/server/organization-join"

/**
 * The join code an organization hands out, as Head Office manages it.
 *
 * Head Office **alone** — see `lib/organization-join-access.ts` for why Super
 * Admin is deliberately not on that list. The organization is always the
 * caller's own, taken from the session by `resolveJoinManagementScope`; there is
 * no `organizationId` parameter on any of the three methods, so there is no
 * tenant to cross.
 *
 * This is the only route that can read a code back, which is why the code lives
 * in its own table rather than on `organizations` — the organization reads that
 * every tenant role can reach return the whole row.
 *
 * A tenant with no code cannot be joined at all, so DELETE is how joining is
 * closed again, and the feature stays off until a PUT turns it on.
 */

export async function GET() {
  try {
    const authError = await requireApiRole(JOIN_REQUEST_MANAGEMENT_ROLES, { viewerReadsAsHeadOffice: true })
    if (authError) return authError

    const scope = await resolveJoinManagementScope()
    if (!scope.ok) return scope.response

    const [record, emailDomain] = await Promise.all([
      readJoinCode(scope.organizationId),
      readOrganizationEmailDomain(scope.organizationId),
    ])
    return ok({
      code: record?.code ?? null,
      updatedAt: record?.updatedAt ?? null,
      joiningOpen: Boolean(record),
      // Shown beside the code: without a domain the join form refuses every
      // applicant, so a code handed out then leads nowhere.
      emailDomain,
    })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "read join code")
    return error(message, status)
  }
}

export async function PUT(req: Request) {
  try {
    const authError = await requireApiRole(JOIN_REQUEST_MANAGEMENT_ROLES)
    if (authError) return authError

    const scope = await resolveJoinManagementScope()
    if (!scope.ok) return scope.response

    const rateLimit = await withRateLimit("sensitive", scope.actorUserId)
    if (rateLimit) return rateLimit

    const rawBody = await readJson<unknown>(req)
    // An empty body means "generate one for me", which is the recommended path.
    const parsed = joinCodeSetSchema.safeParse(rawBody ?? {})
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await setJoinCode({
      organizationId: scope.organizationId,
      code: parsed.data.code,
      actorUserId: scope.actorUserId,
    })
    if ("message" in outcome) return error(outcome.message, outcome.status)

    await writeJoinAudit({
      action: "SET_ORGANIZATION_JOIN_CODE",
      organizationId: scope.organizationId,
      actorUserId: scope.actorUserId,
      entityId: String(scope.organizationId),
      // The code itself is never written to the trail. Who opened joining and
      // when is the auditable fact; the secret is not.
      metadata: { generated: parsed.data.code === undefined },
    })

    return ok({ code: outcome.code, joiningOpen: true })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "set join code")
    return error(message, status)
  }
}

export async function DELETE() {
  try {
    const authError = await requireApiRole(JOIN_REQUEST_MANAGEMENT_ROLES)
    if (authError) return authError

    const scope = await resolveJoinManagementScope()
    if (!scope.ok) return scope.response

    const removed = await clearJoinCode(scope.organizationId)
    if (removed) {
      await writeJoinAudit({
        action: "CLEAR_ORGANIZATION_JOIN_CODE",
        organizationId: scope.organizationId,
        actorUserId: scope.actorUserId,
        entityId: String(scope.organizationId),
        metadata: {},
      })
    }

    return ok({ code: null, joiningOpen: false })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "clear join code")
    return error(message, status)
  }
}
