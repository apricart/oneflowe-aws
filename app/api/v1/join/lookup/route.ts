import { createHash } from "node:crypto"

import { error, ok, readJson } from "@/lib/api"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { UNKNOWN_JOIN_CODE_MESSAGE } from "@/lib/organization-join"
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
} from "@/lib/rate-limiter"
import { joinLookupSchema, validationMessage } from "@/lib/server/mutation-validation"
import {
  loadJoinFormOptions,
  resolveOrganizationByJoinCode,
} from "@/lib/server/organization-join"
import {
  activeParentBranchIds,
  departmentSignupBands,
  loadDepartmentJoinSettings,
  usesDepartmentSignup,
} from "@/lib/server/organization-join-department"

/**
 * POST /api/v1/join/lookup — which organization a join code opens.
 *
 * **Deliberately unauthenticated.** It is the first step of the public join
 * flow: somebody with no account types the code their organization gave them
 * and gets back the organization's name and the branches and groups the join
 * form can offer. Four things keep that from being a hole:
 *
 *   * **POST, not GET.** A code in a query string reaches the access log, the
 *     browser history and the `Referer` of anything the page later loads.
 *   * **Rate limited twice** — on the caller's address against the `login`
 *     budget (15 per 15 minutes), and on a hash of the code itself, so a code
 *     cannot be probed faster than that from a pool of addresses either.
 *   * **One answer for every failure.** A wrong code, a code belonging to a
 *     de-activated tenant, and a tenant that never opened joining are
 *     indistinguishable, so a guesser cannot narrow the space.
 *   * **No organization id leaves here.** The submit endpoint resolves the
 *     tenant from the code again. Nothing the client holds names a tenant, so
 *     there is nothing for it to tamper with.
 *
 * What it *does* disclose to a holder of the code — the tenant's name, its email
 * domain, and its active branch and group names — is the price of a form that
 * can be filled in. It is identity fields only; no money, no administrator, no
 * external ids.
 *
 * An organization with no email domain answers 200 with `emailDomain: null` and
 * no branches or groups: the code is real, but the organization cannot take a
 * request, and the page shows the "domain not set" prompt rather than the form.
 * Only a valid code reaches that answer, so it is no oracle for a guesser.
 */
export async function POST(req: Request) {
  try {
    const rawBody = await readJson<unknown>(req)
    if (!rawBody) return error("Invalid body", 400)

    const parsed = joinLookupSchema.safeParse(rawBody)
    if (!parsed.success) return error(validationMessage(parsed.error), 400)
    const { code } = parsed.data

    const clientIdentifier = await getClientIdentifier()
    const codeIdentifier = `join-code:${createHash("sha256").update(code).digest("hex").slice(0, 32)}`
    const [clientLimit, codeLimit] = await Promise.all([
      checkRateLimit(clientIdentifier, "login"),
      checkRateLimit(codeIdentifier, "login"),
    ])
    if (!clientLimit.allowed || !codeLimit.allowed) {
      return rateLimitResponse(Math.max(clientLimit.resetIn, codeLimit.resetIn))
    }

    const organization = await resolveOrganizationByJoinCode(code)
    if (!organization) return error(UNKNOWN_JOIN_CODE_MESSAGE, 404)

    const options = await loadJoinFormOptions(organization)
    // A domainless organization takes no request at all; its answer is
    // exactly as before, and the page shows the "domain not set" prompt.
    if (!options.emailDomain) return ok(options)

    // An organization with order approval levels on takes the department
    // sign-up instead (plans/OF-JOIN-department-signup-multi-user.md), and its
    // applicant names one approver per level, so the bands are shown. Every
    // other organization's answer is exactly as before, plus `form`.
    const settings = await loadDepartmentJoinSettings(db, organization.organizationId)
    if (!settings || !usesDepartmentSignup(settings)) return ok({ ...options, form: "standard" })
    // Which listed branches are parents, so a new branch can be made a child
    // of one (plans/OF-JOIN-new-branch-parent-child.md): a label on names
    // already disclosed above, nothing more.
    return ok({
      ...options,
      form: "department",
      approvalLevels: departmentSignupBands(settings),
      parentBranchIds: await activeParentBranchIds(db, organization.organizationId),
    })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "join lookup")
    return error(message, status)
  }
}
