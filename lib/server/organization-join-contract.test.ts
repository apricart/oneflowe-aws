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

  it("flattens an identity conflict to a message that names no field", () => {
    const submit = repositoryFile("app/api/v1/join/requests/route.ts")
    expect(submit).toContain("JOIN_IDENTITY_CONFLICT_MESSAGE")
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

describe("the managed join endpoints admit Head Office alone", () => {
  it("gates every one of them on the shared allowlist", () => {
    for (const path of MANAGED_JOIN_ROUTES) {
      const route = repositoryFile(path)
      expect(route).toContain("requireApiRole(JOIN_REQUEST_MANAGEMENT_ROLES)")
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

  it("audits the code being issued and every decision", () => {
    const code = repositoryFile("app/api/v1/organizations/join-code/route.ts")
    expect(code).toContain("SET_ORGANIZATION_JOIN_CODE")
    expect(code).toContain("CLEAR_ORGANIZATION_JOIN_CODE")

    const decide = repositoryFile("app/api/v1/join-requests/[id]/route.ts")
    expect(decide).toContain("APPROVE_ORGANIZATION_JOIN_REQUEST")
    expect(decide).toContain("REJECT_ORGANIZATION_JOIN_REQUEST")
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
    // Head Office alone: the area table takes a role list since the activity
    // log admitted two roles, and this entry must still list exactly one.
    expect(proxy).toContain('{ prefix: "/join-requests", roles: ["HEAD_OFFICE"]')
  })

  it("gates the Head Office page in a server layout as well", () => {
    const layout = repositoryFile("app/(portal)/join-requests/layout.tsx")
    expect(layout).toContain("canManageJoinRequests")
    expect(layout).toContain('redirect("/login")')
  })
})
