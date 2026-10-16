import type { NextRequest } from "next/server"

import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { sendWelcomeEmail } from "@/lib/email"
import { sendJoinApproverNoticeEmail, sendJoinDecisionEmail } from "@/lib/email/join-request"
import { handleError } from "@/lib/error-handler"
import { DEPARTMENT_SIGNUP_FORM_VERSION } from "@/lib/join-department-signup"
import { JOIN_REQUEST_MANAGEMENT_ROLES } from "@/lib/organization-join-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { invalidateSessionValidationCache } from "@/lib/session-validation-cache"
import { env } from "@/lib/server/env"
import {
  departmentJoinApproverReplaceSchema,
  departmentJoinDecisionSchema,
  departmentJoinUpdateSchema,
  joinRequestDecisionSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"
import { decideJoinRequest } from "@/lib/server/organization-join"
import { writeJoinAudit } from "@/lib/server/organization-join-audit"
import {
  decideDepartmentJoinRequest,
  loadDepartmentJoinReview,
  readJoinRequestFormVersion,
  replaceDepartmentJoinApprover,
} from "@/lib/server/organization-join-department"
import { updateDepartmentJoinRequest } from "@/lib/server/organization-join-department-edit"
import { resolveJoinManagementScope } from "@/lib/server/organization-join-scope"

/** Digits only, before parsing: "1.5" or "1abc" must never decide request 1. */
function parseRequestId(id: string): number | null {
  if (!/^\d+$/.test(id)) return null
  const requestId = Number.parseInt(id, 10)
  return Number.isSafeInteger(requestId) && requestId > 0 ? requestId : null
}

/**
 * GET /api/v1/join-requests/[id] — one department sign-up and the preview of
 * what approving it would do (plans/OF-JOIN-department-signup-multi-user.md).
 *
 * Head Office of the request's own organization only; the tenant is the
 * session's, so another tenant's request reads as not found. A standard
 * request is reviewed from the queue row and is not served here.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authError = await requireApiRole(JOIN_REQUEST_MANAGEMENT_ROLES)
    if (authError) return authError

    const scope = await resolveJoinManagementScope()
    if (!scope.ok) return scope.response

    const { id } = await params
    const requestId = parseRequestId(id)
    if (requestId === null) return error("Invalid join request id", 400)

    const review = await loadDepartmentJoinReview({
      requestId,
      organizationId: scope.organizationId,
      deciderUserId: scope.actorUserId,
    })
    if (!review) return error("Join request not found", 404)
    return ok({ item: review })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "read join request")
    return error(message, status)
  }
}

/**
 * PATCH /api/v1/join-requests/[id] — approve or reject one request.
 *
 * **The only route in the application that turns a join request into a user**,
 * and it admits Head Office alone. Without a call to this endpoint a request
 * stays a row: nobody joins an organization without its head office saying so.
 *
 * The fence is the pair `(id, organizationId-from-session)` in the `WHERE` of
 * the `FOR UPDATE` lock inside `decideJoinRequest`. A request belonging to
 * another tenant is therefore *not found* rather than forbidden — the same
 * answer as one that does not exist, so the id space cannot be enumerated.
 *
 * Replay is handled by that same lock plus the status check: two administrators
 * approving at once produce one user and one 409, and a retried approval of an
 * already-decided request is a 409 rather than a second account.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authError = await requireApiRole(JOIN_REQUEST_MANAGEMENT_ROLES)
    if (authError) return authError

    const scope = await resolveJoinManagementScope()
    if (!scope.ok) return scope.response

    const rateLimit = await withRateLimit("sensitive", scope.actorUserId)
    if (rateLimit) return rateLimit

    const { id } = await params
    // Digits only, before parsing. `Number.parseInt` would read "1.5" and "1abc"
    // as 1 and go on to decide request 1 — a different row than the caller
    // named, on an endpoint that creates an account.
    const requestId = parseRequestId(id)
    if (requestId === null) return error("Invalid join request id", 400)

    const rawBody = await readJson<unknown>(req)
    if (!rawBody) return error("Invalid body", 400)

    // A department sign-up is decided by its own path, which creates the
    // approvers and branches too. The version is the stored one, never the
    // body's; an unknown or foreign request is not found either way.
    const formVersion = await readJoinRequestFormVersion(requestId, scope.organizationId)
    if (formVersion === null) return error("Join request not found", 404)
    if (formVersion === DEPARTMENT_SIGNUP_FORM_VERSION) {
      return await patchDepartmentSignup(requestId, scope, rawBody)
    }

    const parsed = joinRequestDecisionSchema.safeParse(rawBody)
    if (!parsed.success) return error(validationMessage(parsed.error), 400)
    const input = parsed.data

    const outcome = await decideJoinRequest({
      requestId,
      organizationId: scope.organizationId,
      actorUserId: scope.actorUserId,
      decision: input.decision,
      reason: input.reason ?? null,
      // Picked field by field rather than spread, so a future schema addition
      // cannot become an applied update by accident.
      overrides: {
        role: input.role,
        branchId: input.branchId,
        groupIds: input.groupIds,
        branchIds: input.branchIds,
        budgetAllocationEnabled: input.budgetAllocationEnabled,
      },
    })

    if (!outcome.ok) return error(outcome.message, outcome.status)

    await writeJoinAudit({
      action: outcome.decision === "approve"
        ? "APPROVE_ORGANIZATION_JOIN_REQUEST"
        : "REJECT_ORGANIZATION_JOIN_REQUEST",
      organizationId: scope.organizationId,
      actorUserId: scope.actorUserId,
      entityId: String(outcome.requestId),
      metadata: {
        createdUserId: outcome.createdUserId,
        grantedRole: outcome.role,
        username: outcome.username,
        reasonGiven: Boolean(input.reason),
        overridden: input.role !== undefined
          || input.branchId !== undefined
          || input.groupIds !== undefined
          || input.branchIds !== undefined,
        budgetAllocationEnabled: input.budgetAllocationEnabled === true,
      },
    })

    // Non-blocking: the decision is committed, and a mail failure must not make
    // Head Office believe it did not happen.
    void sendJoinDecisionEmail({
      to: outcome.email,
      firstName: outcome.firstName,
      username: outcome.username,
      organizationName: outcome.organizationName,
      approved: outcome.decision === "approve",
      loginUrl: new URL("/login", env.NEXTAUTH_URL).toString(),
    }).catch((emailError) => {
      console.error("[JOIN_REQUESTS] Failed to send the decision email:", emailError)
    })

    return ok({
      id: outcome.requestId,
      status: outcome.decision === "approve" ? "approved" : "rejected",
      createdUserId: outcome.createdUserId,
    })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "decide join request")
    return error(message, status)
  }
}

type ManagementScope = { organizationId: number; actorUserId: string; actorRole: string }

/**
 * A department sign-up: either Head Office names a different approver for one
 * level, or decides the request. The decision creates, in one transaction,
 * the initiator, any new branches, the delivery addresses, and each approver's
 * account, branches and level; the emails go only after it commits.
 */
async function replaceApprover(requestId: number, scope: ManagementScope, rawBody: unknown) {
  const parsedReplace = departmentJoinApproverReplaceSchema.safeParse(rawBody)
  if (!parsedReplace.success) return error(validationMessage(parsedReplace.error), 400)
  const replaced = await replaceDepartmentJoinApprover({
    requestId,
    organizationId: scope.organizationId,
    approver: parsedReplace.data.replaceApprover,
  })
  if (!replaced.ok) return error(replaced.message, replaced.status)
  await writeJoinAudit({
    action: "REPLACE_ORGANIZATION_JOIN_REQUEST_APPROVER",
    organizationId: scope.organizationId,
    actorUserId: scope.actorUserId,
    entityId: String(requestId),
    metadata: {
      level: parsedReplace.data.replaceApprover.level,
      previousEmail: replaced.previousEmail,
      email: parsedReplace.data.replaceApprover.email,
    },
  })
  return ok({ id: requestId, replaced: true })
}

/**
 * Head Office correcting a pending sign-up before deciding it. The edited
 * request is re-validated as the submission was; the audit names what
 * changed, never the values, which are personal data.
 */
async function updateRequest(requestId: number, scope: ManagementScope, rawBody: unknown) {
  const parsedUpdate = departmentJoinUpdateSchema.safeParse(rawBody)
  if (!parsedUpdate.success) return error(validationMessage(parsedUpdate.error), 400)
  const fields = parsedUpdate.data.update
  const updated = await updateDepartmentJoinRequest({
    requestId,
    organizationId: scope.organizationId,
    // Picked field by field rather than spread.
    update: {
      firstName: fields.firstName,
      lastName: fields.lastName,
      email: fields.email,
      username: fields.username,
      phone: fields.phone,
      ipExtension: fields.ipExtension,
      employeeId: fields.employeeId,
      department: fields.department,
      branches: fields.branches,
      addresses: fields.addresses,
      approvers: fields.approvers,
    },
  })
  if (!updated.ok) return error(updated.message, updated.status)

  const changed = updated.changedFields.length > 0
    || updated.changedApproverLevels.length > 0
    || updated.branchesChanged
    || updated.addressesChanged
  if (changed) {
    await writeJoinAudit({
      action: "UPDATE_ORGANIZATION_JOIN_REQUEST",
      organizationId: scope.organizationId,
      actorUserId: scope.actorUserId,
      entityId: String(requestId),
      metadata: {
        formVersion: DEPARTMENT_SIGNUP_FORM_VERSION,
        changedFields: updated.changedFields,
        changedApproverLevels: updated.changedApproverLevels,
        branchesChanged: updated.branchesChanged,
        addressesChanged: updated.addressesChanged,
      },
    })
  }
  return ok({ id: requestId, updated: changed })
}

/** The emails a committed decision sends; best effort, after the commit. */
function sendDepartmentDecisionEmails(
  outcome: Extract<Awaited<ReturnType<typeof decideDepartmentJoinRequest>>, { ok: true }>,
) {
  const loginUrl = new URL("/login", env.NEXTAUTH_URL).toString()
  void sendJoinDecisionEmail({
    to: outcome.email,
    firstName: outcome.firstName,
    username: outcome.username,
    organizationName: outcome.organizationName,
    approved: outcome.decision === "approve",
    loginUrl,
  }).catch((emailError) => {
    console.error("[JOIN_REQUESTS] Failed to send the decision email:", emailError)
  })
  // A new approver's password reaches it the way every new account's does.
  for (const credentials of outcome.newApproverCredentials) {
    void sendWelcomeEmail(
      credentials.email,
      credentials.firstName,
      credentials.username,
      credentials.temporaryPassword,
      loginUrl,
    ).catch((emailError) => {
      console.error("[JOIN_REQUESTS] Failed to send an approver welcome email:", emailError)
    })
  }
  for (const approver of outcome.notifiedApprovers) {
    void sendJoinApproverNoticeEmail({
      to: approver.email,
      firstName: approver.firstName,
      level: approver.level,
      initiatorName: outcome.firstName,
      organizationName: outcome.organizationName,
      becameGroupUser: approver.becameGroupUser,
      loginUrl,
    }).catch((emailError) => {
      console.error("[JOIN_REQUESTS] Failed to send an approver notice:", emailError)
    })
  }
}

async function patchDepartmentSignup(requestId: number, scope: ManagementScope, rawBody: unknown) {
  if (typeof rawBody === "object" && rawBody !== null && "replaceApprover" in rawBody) {
    return replaceApprover(requestId, scope, rawBody)
  }
  if (typeof rawBody === "object" && rawBody !== null && "update" in rawBody) {
    return updateRequest(requestId, scope, rawBody)
  }

  const parsed = departmentJoinDecisionSchema.safeParse(rawBody)
  if (!parsed.success) return error(validationMessage(parsed.error), 400)
  const input = parsed.data
  if (input.decision === "approve" && !input.expectedResolutions) {
    return error("Review the request before approving it.", 400)
  }

  const outcome = await decideDepartmentJoinRequest({
    requestId,
    organizationId: scope.organizationId,
    actor: { userId: scope.actorUserId, role: scope.actorRole },
    decision: input.decision,
    reason: input.reason ?? null,
    // Picked field by field rather than spread.
    username: input.username,
    newBranches: input.newBranches,
    addressBranches: input.addressBranches,
    expectedResolutions: input.expectedResolutions,
  })
  if (!outcome.ok) return error(outcome.message, outcome.status)

  await writeJoinAudit({
    action: outcome.decision === "approve"
      ? "APPROVE_ORGANIZATION_JOIN_REQUEST"
      : "REJECT_ORGANIZATION_JOIN_REQUEST",
    organizationId: scope.organizationId,
    actorUserId: scope.actorUserId,
    entityId: String(outcome.requestId),
    metadata: {
      formVersion: DEPARTMENT_SIGNUP_FORM_VERSION,
      createdUserId: outcome.createdUserId,
      grantedRole: outcome.role,
      username: outcome.username,
      reasonGiven: Boolean(input.reason),
      branchIds: outcome.branchIds,
      createdBranchIds: outcome.createdBranchIds,
      approvers: outcome.approvers,
    },
  })

  if (outcome.decision === "approve") {
    await invalidateByPrefix("users")
    if (outcome.createdBranchIds.length > 0) await invalidateByPrefix("branches")
    // A Branch Admin converted to Group User was signed out in the transaction;
    // its cached session check must not outlive that.
    for (const userId of outcome.convertedUserIds) await invalidateSessionValidationCache(userId)
  }

  // Non-blocking: the decision is committed, and a mail failure must not make
  // Head Office believe it did not happen.
  sendDepartmentDecisionEmails(outcome)

  return ok({
    id: outcome.requestId,
    status: outcome.decision === "approve" ? "approved" : "rejected",
    createdUserId: outcome.createdUserId,
  })
}
