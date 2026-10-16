import { createHash } from "node:crypto"

import { error, ok, readJson } from "@/lib/api"
import { handleError } from "@/lib/error-handler"
import {
  DEPARTMENT_JOIN_IDENTITY_CONFLICT_MESSAGE,
  JOIN_IDENTITY_CONFLICT_MESSAGE,
  JOIN_REQUEST_RECEIVED_MESSAGE,
  UNKNOWN_JOIN_CODE_MESSAGE,
  joinEmailDomainRefusal,
} from "@/lib/organization-join"
import { hashPassword } from "@/lib/password"
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
} from "@/lib/rate-limiter"
import { db } from "@/lib/db"
import {
  DEPARTMENT_SIGNUP_FORM_VERSION,
  approverListError,
  deriveUsernameFromEmail,
  splitFullName,
} from "@/lib/join-department-signup"
import {
  departmentJoinSubmitSchema,
  joinRequestSubmitSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"
import { resolveRequestClientIp } from "@/lib/server/request-ip"
import {
  createJoinRequest,
  normalizeJoinSubmissionIdentity,
  resolveOrganizationByJoinCode,
} from "@/lib/server/organization-join"
import {
  createDepartmentJoinRequest,
  departmentSignupBands,
  loadDepartmentJoinSettings,
  usesDepartmentSignup,
} from "@/lib/server/organization-join-department"

/** What either form is told when it is the wrong form for its organization. */
const STANDARD_FORM_ONLY_MESSAGE =
  "This organization does not use the department sign-up. Reload the page and try again."
const DEPARTMENT_FORM_ONLY_MESSAGE =
  "This organization uses the department sign-up. Reload the page and try again."

type JoinFailure = { kind: "identity" | "scope" | "limit"; message: string; status: number }

function failureResponse(outcome: JoinFailure, identityConflictMessage: string) {
  // Only the identity conflict is flattened: the other two describe the
  // tenant's own structure or its queue, which the code already disclosed.
  const message = outcome.kind === "identity" ? identityConflictMessage : outcome.message
  return error(message, outcome.status)
}

/**
 * POST /api/v1/join/requests — ask to join an organization.
 *
 * **Deliberately unauthenticated**, and deliberately incapable of creating a
 * user. It writes one `organization_join_requests` row with status `pending`.
 * Only `PATCH /api/v1/join-requests/[id]`, which admits Head Office alone, turns
 * one of those into an account.
 *
 * The controls, in the order they run:
 *
 *   1. **Validation** — `joinRequestSubmitSchema` is `.strict()` and has no
 *      `organizationId`, `isActive`, `mfaEnabled` or `budgetAllocationEnabled`
 *      member. Sending any of them is a 400, not something quietly applied.
 *   2. **Rate limiting** — the caller's address and a hash of the code, both on
 *      the `login` budget, so neither one address nor one leaked code can be
 *      used to mass-enrol.
 *   3. **Tenant resolution from the code.** This is the control that makes the
 *      endpoint tenant-safe: the applicant names no organization, so there is
 *      no organization id to tamper with. The branch and group ids they *do*
 *      name are checked against the resolved tenant in `createJoinRequest`.
 *   4. **The organization's email domain.** The address must be at exactly the
 *      domain Super Admin set on the resolved organization, and an
 *      organization with none takes no request at all. Checked here, against
 *      the domain read on this request, so a caller that skips the join page —
 *      or edits what it was told — is held to the same rule.
 *   5. **Role allowlist** — `JOINABLE_ROLES`, in the schema, in the server
 *      module and in a check constraint. `HEAD_OFFICE` is unreachable.
 *   6. **One conflict message per form.** It lists every field that is checked
 *      and why each can clash, but email, username, phone, employee number and
 *      an already-waiting request all answer with the identical text, so the
 *      form cannot be used to test whether a colleague has an account.
 *   7. **The password is hashed here** and only its hash is stored, on the
 *      request row. There is no path that reads it back.
 */
export async function POST(req: Request) {
  try {
    const rawBody = await readJson<unknown>(req)
    if (!rawBody) return error("Invalid body", 400)

    // The department sign-up names its version; the standard form never has.
    const isDepartmentSignup = typeof rawBody === "object"
      && (rawBody as { formVersion?: unknown }).formVersion === DEPARTMENT_SIGNUP_FORM_VERSION
    if (isDepartmentSignup) return await submitDepartmentSignup(req, rawBody)

    const parsed = joinRequestSubmitSchema.safeParse(rawBody)
    if (!parsed.success) return error(validationMessage(parsed.error), 400)
    const input = parsed.data

    const clientIdentifier = await getClientIdentifier()
    const codeIdentifier = `join-submit:${createHash("sha256").update(input.code).digest("hex").slice(0, 32)}`
    const [clientLimit, codeLimit] = await Promise.all([
      checkRateLimit(clientIdentifier, "login"),
      checkRateLimit(codeIdentifier, "login"),
    ])
    if (!clientLimit.allowed || !codeLimit.allowed) {
      return rateLimitResponse(Math.max(clientLimit.resetIn, codeLimit.resetIn))
    }

    const organization = await resolveOrganizationByJoinCode(input.code)
    if (!organization) return error(UNKNOWN_JOIN_CODE_MESSAGE, 404)

    const identity = normalizeJoinSubmissionIdentity(input)

    // Before the password is hashed or the queue is read: neither is worth
    // doing for an address the organization would never accept.
    const domainRefusal = joinEmailDomainRefusal(identity.email, organization.emailDomain)
    if (domainRefusal) return error(domainRefusal.message, domainRefusal.status)

    // An organization with order approval levels on takes only the department
    // sign-up: the standard form would let an applicant skip naming approvers.
    // Judged on the setting read on this request, never on what the page says.
    const settings = await loadDepartmentJoinSettings(db, organization.organizationId)
    if (settings && usesDepartmentSignup(settings)) return error(DEPARTMENT_FORM_ONLY_MESSAGE, 400)

    const outcome = await createJoinRequest({
      organizationId: organization.organizationId,
      role: input.role,
      branchId: input.branchId ?? null,
      groupIds: input.groupIds,
      branchIds: input.branchIds,
      firstName: input.firstName,
      lastName: input.lastName,
      email: identity.email,
      username: identity.username,
      passwordHash: await hashPassword(input.password),
      phone: identity.phone,
      employeeId: identity.employeeId,
      imprestHolder: input.imprestHolder ?? null,
      contactPerson: input.contactPerson ?? null,
      location: input.location ?? null,
      address: input.address ?? null,
      // Kept only so an administrator investigating abuse of a leaked code can
      // see where it came from. Never returned by any read.
      submittedIp: await resolveRequestClientIp(),
      // Read off the request itself rather than through `next/headers`: the
      // Request is already in hand, and the dynamic API needs a request store
      // this handler has no reason to depend on.
      submittedUserAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    })

    if ("kind" in outcome) return failureResponse(outcome, JOIN_IDENTITY_CONFLICT_MESSAGE)

    return ok({ message: JOIN_REQUEST_RECEIVED_MESSAGE }, { status: 201 })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "join request submit")
    return error(message, status)
  }
}

/**
 * The department sign-up (plans/OF-JOIN-department-signup-multi-user.md):
 * the same controls as the standard form, in the same order, plus the two
 * that belong to it: the organization must have order approval levels on,
 * and the approvers must name every level, at the organization's domain.
 */
async function submitDepartmentSignup(req: Request, rawBody: unknown) {
  const parsed = departmentJoinSubmitSchema.safeParse(rawBody)
  if (!parsed.success) return error(validationMessage(parsed.error), 400)
  const input = parsed.data

  const clientIdentifier = await getClientIdentifier()
  const codeIdentifier = `join-submit:${createHash("sha256").update(input.code).digest("hex").slice(0, 32)}`
  const [clientLimit, codeLimit] = await Promise.all([
    checkRateLimit(clientIdentifier, "login"),
    checkRateLimit(codeIdentifier, "login"),
  ])
  if (!clientLimit.allowed || !codeLimit.allowed) {
    return rateLimitResponse(Math.max(clientLimit.resetIn, codeLimit.resetIn))
  }

  const organization = await resolveOrganizationByJoinCode(input.code)
  if (!organization) return error(UNKNOWN_JOIN_CODE_MESSAGE, 404)

  const identity = normalizeJoinSubmissionIdentity({
    email: input.email,
    username: deriveUsernameFromEmail(input.email),
    phone: input.phone,
    employeeId: input.employeeId,
  })

  const domainRefusal = joinEmailDomainRefusal(identity.email, organization.emailDomain)
  if (domainRefusal) return error(domainRefusal.message, domainRefusal.status)

  const settings = await loadDepartmentJoinSettings(db, organization.organizationId)
  if (!settings || !usesDepartmentSignup(settings)) return error(STANDARD_FORM_ONLY_MESSAGE, 400)

  const approverRefusal = approverListError({
    initiatorEmail: identity.email,
    approvers: input.approvers,
    levelCount: settings.levels.length,
    emailDomain: organization.emailDomain as string,
  })
  if (approverRefusal) return error(approverRefusal, 400)

  const name = splitFullName(input.fullName)
  const outcome = await createDepartmentJoinRequest({
    organizationId: organization.organizationId,
    firstName: name.firstName,
    lastName: name.lastName,
    email: identity.email,
    username: identity.username,
    passwordHash: await hashPassword(input.password),
    phone: identity.phone as string,
    employeeId: identity.employeeId as string,
    ipExtension: input.ipExtension,
    department: input.department,
    branches: input.branches,
    addresses: input.addresses,
    approvers: input.approvers,
    approvalLevelsSnapshot: departmentSignupBands(settings),
    submittedIp: await resolveRequestClientIp(),
    submittedUserAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
  })
  if ("kind" in outcome) return failureResponse(outcome, DEPARTMENT_JOIN_IDENTITY_CONFLICT_MESSAGE)

  return ok({ message: JOIN_REQUEST_RECEIVED_MESSAGE }, { status: 201 })
}
