import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * The structural controls behind self-service joining.
 *
 * These are contract tests in the sense of `lib/server/security-boundaries.test.ts`
 * and `lib/pricing-access.test.ts`: each guarantee below is about the *shape* of
 * the feature rather than the value a function returns, and each one is a hole
 * the moment a future edit forgets it.
 *
 * **When a route is added to this feature, add it to the lists here.** A route
 * missing from them is silently unprotected.
 */

function repositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

/**
 * The file with its prose removed.
 *
 * Needed because several assertions below are "this name appears nowhere", and
 * the documentation in these files necessarily *names* the fields it is
 * explaining as absent. Block comments go, and so does any line that is only a
 * comment; a trailing `//` is left alone so a URL inside a string cannot be
 * mangled.
 */
function codeOf(path: string): string {
  return repositoryFile(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith("//") && !trimmed.startsWith("*")
    })
    .join("\n")
}

/** The two endpoints an anonymous caller may reach. */
const PUBLIC_JOIN_ROUTES = [
  "app/api/v1/join/lookup/route.ts",
  "app/api/v1/join/requests/route.ts",
]

/** Every endpoint that issues a code or decides who joins. */
const MANAGED_JOIN_ROUTES = [
  "app/api/v1/organizations/join-code/route.ts",
  "app/api/v1/join-requests/route.ts",
  "app/api/v1/join-requests/[id]/route.ts",
]

describe("the public join endpoints never let a caller name a tenant", () => {
  it("resolves the organization from the code on every request", () => {
    for (const path of PUBLIC_JOIN_ROUTES) {
      const route = repositoryFile(path)
      expect(route).toContain("resolveOrganizationByJoinCode")
    }
  })

  it("never reads an organizationId out of the request", () => {
    // This is the control that makes the public surface tenant-safe. An
    // organizationId a caller can send is an organizationId a caller can change.
    for (const path of PUBLIC_JOIN_ROUTES) {
      const route = repositoryFile(path)
      expect(route).not.toMatch(/organizationId:\s*(input|body|parsed|rawBody)/)
      expect(route).not.toMatch(/searchParams\.get\(["']organizationId["']\)/)
    }
  })

  it("is rate limited on the caller and on the code, on the strict login budget", () => {
    for (const path of PUBLIC_JOIN_ROUTES) {
      const route = repositoryFile(path)
      expect(route).toContain("getClientIdentifier")
      expect(route).toContain('checkRateLimit(clientIdentifier, "login")')
      // A second budget keyed on the code, so one leaked code cannot be fanned
      // out from a pool of addresses.
      expect(route).toContain('checkRateLimit(codeIdentifier, "login")')
      expect(route).toContain("rateLimitResponse")
    }
  })

  it("answers an unrecognised code with the one generic message", () => {
    for (const path of PUBLIC_JOIN_ROUTES) {
      const route = repositoryFile(path)
      expect(route).toContain("UNKNOWN_JOIN_CODE_MESSAGE")
    }
  })

  it("cannot create a user, activate one, or grant anything", () => {
    for (const path of PUBLIC_JOIN_ROUTES) {
      const route = codeOf(path)
      expect(route).not.toContain("usersTable")
      expect(route).not.toMatch(/insert\(\s*users\s*\)/)
      // None of the three privileged flags is even mentioned in the executable
      // part of a public route, let alone taken from the body.
      expect(route).not.toContain("isActive")
      expect(route).not.toContain("mfaEnabled")
      expect(route).not.toContain("budgetAllocationEnabled")
      expect(route).not.toContain("mustChangePassword")
    }
  })

  it("stores no plaintext password anywhere", () => {
    const submit = repositoryFile("app/api/v1/join/requests/route.ts")
    // The only thing handed to the store is the output of hashPassword.
    expect(submit).toContain("passwordHash: await hashPassword(input.password)")
    expect(submit).not.toMatch(/password:\s*input\.password/)
  })

  it("flattens an identity conflict to one constant message per form, never the cause", () => {
    const submit = repositoryFile("app/api/v1/join/requests/route.ts")
    expect(submit).toContain("failureResponse(outcome, JOIN_IDENTITY_CONFLICT_MESSAGE)")
    expect(submit).toContain("failureResponse(outcome, DEPARTMENT_JOIN_IDENTITY_CONFLICT_MESSAGE)")
    // The identity outcome's own message (which says what clashed) never reaches the caller.
    expect(submit).toContain('outcome.kind === "identity" ? identityConflictMessage : outcome.message')
  })

  it("checks a username against accounts only where the applicant typed it", () => {
    const standard = repositoryFile("lib/server/organization-join.ts")
    const department = repositoryFile("lib/server/organization-join-department.ts")
    expect(standard).toContain("identityConflictReason({ ...submission, checkAccountUsername: true })")
    expect(department).toContain("checkAccountUsername: false")
  })
})

describe("the public join endpoints hold an applicant to the organization's email domain", () => {
  it("checks the address against the domain resolved on this request, before any other work", () => {
    const submit = codeOf("app/api/v1/join/requests/route.ts")
    // The domain comes off the organization the code resolved to, never from
    // the body — the page is told the domain, and could send back anything.
    expect(submit).toContain(
      "joinEmailDomainRefusal(identity.email, organization.emailDomain)",
    )
    expect(submit).not.toMatch(/input\.emailDomain|rawBody\.emailDomain/)

    // Before the password is hashed and before a request can be stored.
    const refusal = submit.indexOf("joinEmailDomainRefusal(")
    expect(refusal).toBeGreaterThan(submit.indexOf("resolveOrganizationByJoinCode(input.code)"))
    expect(refusal).toBeLessThan(submit.indexOf("hashPassword("))
    expect(refusal).toBeLessThan(submit.indexOf("createJoinRequest("))
  })

  it("has no field for a domain in the public submission, so none can be supplied", () => {
    const validation = repositoryFile("lib/server/mutation-validation.ts")
    const submitSchema = validation.slice(
      validation.indexOf("export const joinRequestSubmitSchema"),
      validation.indexOf("export const joinCodeSetSchema"),
    )
    expect(submitSchema.length).toBeGreaterThan(0)
    expect(submitSchema).not.toContain("emailDomain")
    expect(submitSchema).toContain("}).strict()")
  })

  it("reads the domain with the code, and withholds the form's options when there is none", () => {
    const server = repositoryFile("lib/server/organization-join.ts")
    const resolver = server.slice(
      server.indexOf("export async function resolveOrganizationByJoinCode"),
      server.indexOf("export async function loadJoinFormOptions"),
    )
    expect(resolver).toContain("emailDomain: organizations.emailDomain")

    const options = server.slice(
      server.indexOf("export async function loadJoinFormOptions"),
      server.indexOf("export async function readOrganizationEmailDomain"),
    )
    // The early return comes before either query is issued.
    expect(options.indexOf("if (!organization.emailDomain)"))
      .toBeLessThan(options.indexOf(".from(branches)"))
  })
})

describe("the public join endpoints require a proven address", () => {
  // plans/OF-JOIN-email-otp-verification.md
  const REQUEST_ROUTE = "app/api/v1/join/email-verification/request/route.ts"
  const VERIFY_ROUTE = "app/api/v1/join/email-verification/verify/route.ts"

  it("sends a code only for the organization the join code names, at its domain", () => {
    const route = codeOf(REQUEST_ROUTE)
    expect(route).toContain("resolveOrganizationByJoinCode(code)")
    expect(route).not.toMatch(/organizationId:\s*(input|body|parsed|rawBody)/)
    expect(route).toContain("UNKNOWN_JOIN_CODE_MESSAGE")
    const refusal = route.indexOf("joinEmailDomainRefusal(email, organization.emailDomain)")
    expect(refusal).toBeGreaterThan(route.indexOf("resolveOrganizationByJoinCode(code)"))
    expect(refusal).toBeLessThan(route.indexOf("issueJoinEmailCode("))
    expect(route).toContain("organizationId: organization.organizationId")
  })

  it("limits the mail-out on the caller, the code and the address, and the verify on the caller and the challenge", () => {
    const request = codeOf(REQUEST_ROUTE)
    expect(request).toContain('checkRateLimit(clientIdentifier, "login")')
    expect(request).toContain('checkRateLimit(codeIdentifier, "login")')
    expect(request).toContain('checkRateLimit(addressIdentifier, "otpSend")')
    const verify = codeOf(VERIFY_ROUTE)
    expect(verify).toContain('checkRateLimit(clientIdentifier, "login")')
    expect(verify).toContain('checkRateLimit(challengeIdentifier, "otpVerify")')
    for (const route of [request, verify]) expect(route).toContain("rateLimitResponse")
  })

  it("checks the proof on both forms after the domain and before the password is hashed", () => {
    const submit = codeOf("app/api/v1/join/requests/route.ts")
    const standard = submit.slice(0, submit.indexOf("async function submitDepartmentSignup"))
    const department = submit.slice(submit.indexOf("async function submitDepartmentSignup"))
    for (const path of [standard, department]) {
      const check = path.indexOf("joinEmailProofIsLive(")
      expect(check).toBeGreaterThan(path.indexOf("joinEmailDomainRefusal("))
      expect(check).toBeLessThan(path.indexOf("hashPassword("))
      // Bound to the address about to be stored and the tenant from the code.
      expect(path).toContain("organizationId: organization.organizationId, email: identity.email")
      expect(path).toContain("emailProof,")
    }
  })

  it("spends the proof inside the transaction that inserts the request, before the insert", () => {
    for (const path of ["lib/server/organization-join.ts", "lib/server/organization-join-department.ts"]) {
      const server = codeOf(path)
      const creator = server.slice(
        server.indexOf(path.endsWith("department.ts") ? "export async function createDepartmentJoinRequest" : "export async function createJoinRequest"),
      )
      const transaction = creator.indexOf("db.transaction(async (tx)")
      const spend = creator.indexOf("spendJoinEmailProof(tx,")
      const insert = creator.indexOf(".insert(organizationJoinRequests)")
      expect(transaction).toBeGreaterThan(-1)
      expect(spend).toBeGreaterThan(transaction)
      expect(spend).toBeLessThan(insert)
      expect(creator).toContain("emailVerifiedAt: new Date()")
      expect(creator).toContain("instanceof JoinEmailProofRejected")
    }
  })

  it("makes the proof a required field of both submissions", () => {
    const validation = repositoryFile("lib/server/mutation-validation.ts")
    for (const [start, end] of [
      ["export const joinRequestSubmitSchema", "export const joinCodeSetSchema"],
      ["export const departmentJoinSubmitSchema", "/** One field of a new branch"],
    ]) {
      const schema = validation.slice(validation.indexOf(start), validation.indexOf(end))
      expect(schema).toContain("emailVerification: joinEmailVerificationSchema,")
      expect(schema).not.toContain("emailVerification: joinEmailVerificationSchema.optional()")
    }
  })

  it("clears the verification when Head Office edits the address", () => {
    const edit = codeOf("lib/server/organization-join-department-edit.ts")
    expect(edit).toContain('changedFields.includes("email") ? { emailVerifiedAt: null } : {}')
  })
})

describe("the managed join endpoints admit Head Office alone", () => {
  it("gates every one of them on the shared allowlist", () => {
    for (const path of MANAGED_JOIN_ROUTES) {
      const route = repositoryFile(path)
      // A GET may add the read-only Viewer opt-in; nothing else may differ.
      expect(route).toMatch(/requireApiRole\(JOIN_REQUEST_MANAGEMENT_ROLES(?:, \{ viewerReadsAsHeadOffice: true \})?\)/)
      expect(route).toContain('from "@/lib/organization-join-access"')
    }
  })

  it("never spells a role inline, so the allowlist is the only place it lives", () => {
    for (const path of MANAGED_JOIN_ROUTES) {
      const route = repositoryFile(path)
      expect(route).not.toContain('"HEAD_OFFICE"')
      expect(route).not.toContain('"SUPER_ADMIN"')
    }
  })

  it("takes the tenant from the session through the one shared resolver", () => {
    for (const path of MANAGED_JOIN_ROUTES) {
      const route = repositoryFile(path)
      expect(route).toContain("resolveJoinManagementScope()")
      expect(route).toContain("scope.organizationId")
      // No organizationId parameter exists on any of them, so there is nothing
      // for a caller to substitute.
      expect(route).not.toMatch(/searchParams\.get\(["']organizationId["']\)/)
    }
  })

  it("rate limits each write", () => {
    for (const path of [
      "app/api/v1/organizations/join-code/route.ts",
      "app/api/v1/join-requests/[id]/route.ts",
    ]) {
      expect(repositoryFile(path)).toContain('withRateLimit("sensitive"')
    }
  })

  it("audits the code being set and every decision", () => {
    const code = repositoryFile("app/api/v1/organizations/join-code/route.ts")
    expect(code).toContain("SET_ORGANIZATION_JOIN_CODE")
    expect(code).not.toContain("CLEAR_ORGANIZATION_JOIN_CODE")

    const decide = repositoryFile("app/api/v1/join-requests/[id]/route.ts")
    expect(decide).toContain("APPROVE_ORGANIZATION_JOIN_REQUEST")
    expect(decide).toContain("REJECT_ORGANIZATION_JOIN_REQUEST")
  })

  it("makes the organization's manually entered code permanent", () => {
    const route = repositoryFile("app/api/v1/organizations/join-code/route.ts")
    expect(route).not.toMatch(/export async function DELETE/)

    const server = repositoryFile("lib/server/organization-join.ts")
    const setter = server.slice(
      server.indexOf("export async function setJoinCode"),
      server.indexOf("/* ── Submitting a request"),
    )
    expect(setter).toContain(".insert(organizationJoinCodes)")
    expect(setter).not.toContain(".onConflictDoUpdate(")
    expect(setter).not.toContain(".update(organizationJoinCodes)")
    expect(setter).not.toContain(".delete(organizationJoinCodes)")

    const validation = repositoryFile("lib/server/mutation-validation.ts")
    const schema = validation.slice(
      validation.indexOf("export const joinCodeSetSchema"),
      validation.indexOf("export const joinRequestDecisionSchema"),
    )
    expect(schema).toContain("code: joinCodeSchema,")
    expect(schema).not.toContain("code: joinCodeSchema.optional()")
  })

  it("keeps the code out of its own audit trail", () => {
    const audit = repositoryFile("lib/server/organization-join-audit.ts")
    // `metadata` is assembled by the caller field by field, never spread, and
    // the code is not one of the fields.
    expect(audit).toContain("metadata: input.metadata")
    // The metadata object carries no `code` key, so the secret itself is never
    // in the trail even though who issued it and when are.
    const code = codeOf("app/api/v1/organizations/join-code/route.ts")
    expect(code).not.toMatch(/metadata:\s*\{[^}]*\bcode:/)
  })

  it("picks decision overrides field by field rather than spreading the body", () => {
    const decide = repositoryFile("app/api/v1/join-requests/[id]/route.ts")
    expect(decide).not.toMatch(/overrides:\s*\{\s*\.\.\./)
    expect(decide).toContain("role: input.role")
  })
})

describe("only one code path turns a request into a user", () => {
  it("is the approval inside lib/server/organization-join.ts", () => {
    const server = repositoryFile("lib/server/organization-join.ts")
    // One insert into `users`, in the approval transaction.
    expect(server.match(/\.insert\(usersTable\)/g) || []).toHaveLength(1)
    expect(server).toContain("db.transaction")
  })

  it("locks the request row before reading it, so a double approval cannot double-create", () => {
    const server = repositoryFile("lib/server/organization-join.ts")
    expect(server).toContain('.for("update")')
    expect(server).toContain('if (stored.status !== "pending")')
  })

  it("fences the lock on the caller's own organization, not only on the id", () => {
    const server = repositoryFile("lib/server/organization-join.ts")
    expect(server).toContain("eq(organizationJoinRequests.organizationId, input.organizationId)")
  })

  it("re-validates the branch and group assignment inside the transaction", () => {
    const server = repositoryFile("lib/server/organization-join.ts")
    // Once at submission and once at approval — the branch could have moved
    // tenant, been de-activated or been deleted while the request waited.
    expect(server.match(/await scopeTenantError\(/g) || []).toHaveLength(2)
  })

  it("never takes isActive, mfaEnabled or the allocation right from the applicant", () => {
    const server = repositoryFile("lib/server/organization-join.ts")
    expect(server).toContain("mfaEnabled: false")
    expect(server).toContain("isActive: true")
    expect(server).toContain("input.overrides.budgetAllocationEnabled === true")
    // The applicant's stored row is never consulted for any of the three.
    expect(server).not.toMatch(/stored\.(isActive|mfaEnabled|budgetAllocationEnabled)/)
  })

  it("never returns the stored password hash from a read", () => {
    const server = repositoryFile("lib/server/organization-join.ts")
    const listing = server.slice(
      server.indexOf("export async function listJoinRequests"),
      server.indexOf("export type JoinDecisionOverrides"),
    )
    expect(listing.length).toBeGreaterThan(0)
    expect(listing).not.toContain("passwordHash")
    expect(listing).not.toContain("submittedIp")
    expect(listing).not.toContain("submittedUserAgent")
  })
})

describe("the schema holds the rules the endpoints also hold", () => {
  const schema = repositoryFile("db/schema.ts")

  it("pins the four joinable roles in a check constraint", () => {
    expect(schema).toContain("organization_join_requests_role_ck")
    expect(schema).toContain(
      "IN ('BRANCH_ADMIN', 'ORDER_PORTAL', 'GROUP_USER', 'GROUP_ORDER_PORTAL')",
    )
  })

  it("pins the code's minimum length in a check constraint", () => {
    expect(schema).toContain("organization_join_codes_code_shape_ck")
    expect(schema).toContain("'^[A-Z0-9-]{8,32}$'")
  })

  it("makes one code resolve to exactly one organization", () => {
    expect(schema).toContain("organization_join_codes_code_uq")
    expect(schema).toContain("organization_join_codes_org_uq")
  })

  it("makes a duplicate pending request a database error rather than a race", () => {
    expect(schema).toContain("organization_join_requests_pending_email_uq")
    expect(schema).toContain("organization_join_requests_pending_username_uq")
  })

  it("keys those indexes on the organization, so one tenant cannot block another", () => {
    // A global index here would let anyone holding one tenant's join code stop a
    // person applying to a different tenant. The organization column is what
    // keeps the queue a tenant-local thing.
    const requestsTable = schema.slice(
      schema.indexOf("export const organizationJoinRequests = pgTable("),
    )
    for (const name of [
      "organization_join_requests_pending_email_uq",
      "organization_join_requests_pending_username_uq",
    ]) {
      const index = requestsTable.slice(requestsTable.indexOf(name))
      expect(index.slice(0, 160)).toContain("t.organizationId")
    }
  })

  it("does not put the join code on the organizations table", () => {
    // `GET /api/v1/organizations` selects the whole row and admits every tenant
    // role, so a column there would hand the code to the roles least entitled
    // to it. This is the reason the separate table exists.
    const organizationsTable = schema.slice(
      schema.indexOf('export const organizations = pgTable('),
      schema.indexOf('export const branches = pgTable('),
    )
    expect(organizationsTable.length).toBeGreaterThan(0)
    expect(organizationsTable.toLowerCase()).not.toContain("join")
  })

  it("pins the email domain's shape, and does not make it unique", () => {
    const organizationsTable = schema.slice(
      schema.indexOf('export const organizations = pgTable('),
      schema.indexOf('export const branches = pgTable('),
    )
    expect(organizationsTable).toContain("organizations_email_domain_shape_ck")
    // Tenants that share a mail system share a domain — K-Electric and
    // K-E-Demo do — so a unique index would make one of them unconfigurable.
    expect(organizationsTable).not.toMatch(/uniqueIndex\([^)]*\)\.on\(t\.emailDomain\)/)
  })
})

describe("the way in is reachable and the way out is not mislabelled", () => {
  it("links to the join page from the login page", () => {
    const login = repositoryFile("app/(auth)/login/page.tsx")
    expect(login).toContain('href="/join"')
  })

  it("names /join public and leaves /join-requests protected in the proxy", () => {
    const proxy = repositoryFile("proxy.ts")
    expect(proxy).toContain('const isPublicPath = ["/login", "/join"].includes(pathname)')
    expect(proxy).toContain('"/join-requests",')
    // Head Office decides; the read-only Viewer may open the page and read the
    // queue (every decision endpoint still refuses it). No one else.
    expect(proxy).toContain('{ prefix: "/join-requests", roles: ["HEAD_OFFICE", "VIEWER"]')
  })

  it("gates the Head Office page in a server layout as well", () => {
    const layout = repositoryFile("app/(portal)/join-requests/layout.tsx")
    expect(layout).toContain("canManageJoinRequests")
    expect(layout).toContain('redirect("/login")')
  })
})

/*
 * The department sign-up (plans/OF-JOIN-department-signup-multi-user.md).
 *
 * The rule above, "only one code path turns a request into a user", is
 * deliberately extended rather than broken: a department sign-up is approved
 * by decideDepartmentJoinRequest, which creates the initiator **and** any new
 * approvers, still only inside Head Office's approval transaction, and the
 * standard approval refuses a department request outright.
 */
describe("the department sign-up", () => {
  const department = "lib/server/organization-join-department.ts"
  const submit = "app/api/v1/join/requests/route.ts"
  const decideRoute = "app/api/v1/join-requests/[id]/route.ts"

  it("is taken only by an organization with approval levels on, judged on this request", () => {
    const route = codeOf(submit)
    // The standard form is refused for a levels-enabled organization, and the
    // department form for any other, both after the code resolved the tenant.
    expect(route).toContain("if (settings && usesDepartmentSignup(settings)) return error(DEPARTMENT_FORM_ONLY_MESSAGE, 400)")
    expect(route).toContain("if (!settings || !usesDepartmentSignup(settings)) return error(STANDARD_FORM_ONLY_MESSAGE, 400)")
    expect(route.indexOf("loadDepartmentJoinSettings(db, organization.organizationId)"))
      .toBeGreaterThan(route.indexOf("resolveOrganizationByJoinCode(input.code)"))
  })

  it("lets the applicant name no tenant, role or username", async () => {
    const { departmentJoinSubmitSchema } = await import("@/lib/server/mutation-validation")
    const keys = Object.keys(departmentJoinSubmitSchema.shape)
    for (const forbidden of ["organizationId", "role", "username", "isActive", "mfaEnabled", "budgetAllocationEnabled"]) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it("never looks an approver's email up for a public caller", () => {
    const server = repositoryFile(department)
    const create = server.slice(
      server.indexOf("export async function createDepartmentJoinRequest"),
      server.indexOf("/* ── Reading a request back"),
    )
    expect(create).not.toContain("loadApproverCandidates")
    expect(create).not.toMatch(/\.from\(users\)/)
  })

  it("creates users only inside the approval transaction, after locking the request", () => {
    const server = repositoryFile(department)
    expect(server.match(/\.insert\(users\)/g) || []).toHaveLength(2)
    expect(server).toContain('.for("update")')
    expect(server.indexOf("const stored = await lockDepartmentRequest(tx, input)"))
      .toBeLessThan(server.indexOf("approveDepartmentRequest(context, stored, roleIdByName)"))
  })

  it("assigns approval levels only through the shipped writer", () => {
    const server = repositoryFile(department)
    expect(server).toContain("writeApprovalLevelInTx(")
    expect(server).not.toMatch(/orderApprovalLevel:/)
  })

  it("gives a new approver a rotated temporary password, and never returns it", () => {
    const server = repositoryFile(department)
    expect(server).toContain("generateRandomPassword(16)")
    expect(server).toContain("mustChangePassword: true")
    const route = codeOf(decideRoute)
    expect(route).toContain("sendWelcomeEmail(")
    // Read once, by the email loop alone: never into the audit or the response.
    expect(route.match(/newApproverCredentials/g) || []).toHaveLength(1)
    expect(route).toContain("for (const credentials of outcome.newApproverCredentials)")
    expect(route).not.toMatch(/ok\(\{[^}]*temporaryPassword/)
  })

  it("is decided by its own path, chosen by the stored version, never the body", () => {
    const route = codeOf(decideRoute)
    expect(route.indexOf("readJoinRequestFormVersion(requestId, scope.organizationId)"))
      .toBeLessThan(route.indexOf("joinRequestDecisionSchema.safeParse(rawBody)"))
    // And the standard approval cannot decide a department request.
    expect(repositoryFile("lib/server/organization-join.ts")).toContain("eq(organizationJoinRequests.formVersion, 1)")
  })

  it("lets Head Office edit a pending request, never its password, and never outside the request", () => {
    const edit = codeOf("lib/server/organization-join-department-edit.ts")
    // Fenced and locked like the approval: this tenant, this form, pending.
    expect(edit).toContain("eq(organizationJoinRequests.organizationId, organizationId)")
    expect(edit).toContain("eq(organizationJoinRequests.formVersion, DEPARTMENT_SIGNUP_FORM_VERSION)")
    expect(edit).toContain('.for("update")')
    expect(edit).toContain('if (stored.status !== "pending")')
    // Held to the submission's rules.
    expect(edit).toContain("joinEmailDomainRefusal(identity.email, settings.emailDomain)")
    expect(edit).toContain("approverListError(")
    // Writes only the request and its own rows: no account, no password.
    expect(edit).not.toMatch(/\.(insert|update|delete)\(users\)/)
    expect(edit).not.toMatch(/passwordHash|termsAcceptedAt/)

    // Dispatched only after the stored version chose the department path.
    const route = codeOf(decideRoute)
    expect(route.indexOf("readJoinRequestFormVersion(requestId, scope.organizationId)"))
      .toBeLessThan(route.indexOf("return updateRequest(requestId, scope, rawBody)"))
    expect(route).toContain("departmentJoinUpdateSchema.safeParse(rawBody)")
    expect(route).toContain('action: "UPDATE_ORGANIZATION_JOIN_REQUEST"')
  })

  it("refuses an approval that does not reproduce what Head Office reviewed", () => {
    const server = repositoryFile(department)
    expect(server).toContain("assertReviewedResolutions(input, plans)")
    expect(server.indexOf("assertReviewedResolutions(input, plans)"))
      .toBeLessThan(server.indexOf("await createInitiator("))
  })
})
