import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray, like, sql } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as lookupRoute from "@/app/api/v1/join/lookup/route"
import * as submitRoute from "@/app/api/v1/join/requests/route"
import { submitWithJoinEmailProof } from "./helpers/join-email-proof"
import * as joinCodeRoute from "@/app/api/v1/organizations/join-code/route"
import * as organizationRoute from "@/app/api/v1/organizations/[id]/route"
import * as organizationsRoute from "@/app/api/v1/organizations/route"
import {
  auditLogs,
  branches,
  organizationAllowedIps,
  organizationJoinCodes,
  organizationJoinRequests,
  organizationSettings,
  organizations,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE } from "@/lib/organization-join"

import {
  JOIN_FIXTURE_EMAIL_DOMAIN,
  NO_DATABASE_REASON,
  createJoinFixtures,
  destroyJoinFixtures,
  hasTestDatabase,
  resolveRoleId,
  type JoinFixtures,
} from "./helpers/organization-join-fixtures"

/**
 * The organization's email domain, from where Super Admin sets it to where the
 * public join endpoints hold an applicant to it — against real Postgres.
 *
 * Only the session, the password hasher, the rate limiter and the cache are
 * faked. The schema, the check constraint, the normalisation, the audit rows and
 * the tenant resolution all run for real.
 */

const mocks = vi.hoisted(() => ({
  hashPassword: vi.fn(async (plain: string) => `hashed:${plain}`),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 10, resetIn: 60 })),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/password", () => ({ hashPassword: mocks.hashPassword }))
vi.mock("@/lib/rate-limiter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limiter")>()
  return {
    ...actual,
    withRateLimit: vi.fn(async () => null),
    checkRateLimit: mocks.checkRateLimit,
    getClientIdentifier: async () => "ip:127.0.0.1",
  }
})
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
    coalesceInFlight: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
    invalidateByPrefix: vi.fn(async () => {}),
  }
})

const { getServerSession } = mockedNextAuth
const { POST: createOrganization } = organizationsRoute
const { PATCH: updateOrganization } = organizationRoute
const { POST: lookup } = lookupRoute
const submit = submitWithJoinEmailProof(submitRoute.POST)
const { GET: readJoinCode } = joinCodeRoute

type Actor = { id: string; role: string; organizationId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null
      ? null
      : ({ user: { ...actor, email: `${actor.id}@example.test`, mustChangePassword: false } } as any),
  )
}

function jsonRequest(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function body(response: Response): Promise<any> {
  return response.json()
}

const STRONG_PASSWORD = "Join-Flow-2026!x"

describe.skipIf(!hasTestDatabase)("an organization's email domain", () => {
  let fixtures: JoinFixtures
  let superAdminId = ""
  /** A tenant of this suite's own, whose domain each test arranges for itself. */
  let switchOrganizationId = 0
  let switchBranchId = 0
  let switchCode = ""
  /** Tenant A from the join fixtures, whose domain is `example.test`. */
  let openCode = ""
  const namePrefix = () => `IT Domain ${fixtures.suffix}`

  const superAdmin = (): Actor => ({ id: superAdminId, role: "SUPER_ADMIN", organizationId: null })
  const headOffice = (): Actor => ({
    id: fixtures.headOfficeId,
    role: "HEAD_OFFICE",
    organizationId: fixtures.organizationId,
  })

  /** Arrange a domain directly, so a test depends on no earlier one. */
  async function arrangeDomain(organizationId: number, emailDomain: string | null) {
    await db.update(organizations).set({ emailDomain }).where(eq(organizations.id, organizationId))
  }

  async function storedDomain(organizationId: number): Promise<string | null> {
    const [row] = await db
      .select({ emailDomain: organizations.emailDomain })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1)
    return row.emailDomain
  }

  async function domainAuditRows(organizationId: number) {
    return db
      .select({ userId: auditLogs.userId, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(
        eq(auditLogs.organizationId, organizationId),
        eq(auditLogs.action, "UPDATE_ORGANIZATION_EMAIL_DOMAIN"),
      ))
      .orderBy(auditLogs.id)
  }

  async function requestsFor(organizationId: number) {
    return db
      .select({ id: organizationJoinRequests.id, email: organizationJoinRequests.email })
      .from(organizationJoinRequests)
      .where(eq(organizationJoinRequests.organizationId, organizationId))
  }

  const patch = (organizationId: number, payload: unknown) =>
    updateOrganization(
      jsonRequest(`/api/v1/organizations/${organizationId}`, "PATCH", payload),
      { params: Promise.resolve({ id: String(organizationId) }) },
    )

  /** A submission that would succeed at tenant A, so each test can spoil one field. */
  const submission = (overrides: Record<string, unknown> = {}) => {
    const unique = Math.random().toString(36).slice(2, 8)
    return {
      code: openCode,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-${fixtures.suffix}-${unique}@${JOIN_FIXTURE_EMAIL_DOMAIN}`,
      username: `ada-dom-${fixtures.suffix}-${unique}`,
      password: STRONG_PASSWORD,
      role: "ORDER_PORTAL",
      branchId: fixtures.northBranchId,
      ...overrides,
    }
  }

  beforeAll(async () => {
    fixtures = await createJoinFixtures()
    const suffix = fixtures.suffix

    const [admin] = await db
      .insert(users)
      .values({
        email: `it-domain-super-${suffix}@example.test`,
        username: `it-domain-super-${suffix}`,
        passwordHash: "not-a-real-hash",
        roleId: await resolveRoleId("SUPER_ADMIN"),
        organizationId: null,
        fullName: `Domain Super ${suffix}`,
      })
      .returning({ id: users.id })
    superAdminId = admin.id

    const [switchOrganization] = await db
      .insert(organizations)
      .values({ name: `${namePrefix()} Switch`, code: `ITDS_${suffix}`, status: "active" })
      .returning({ id: organizations.id })
    switchOrganizationId = switchOrganization.id

    const [switchBranch] = await db
      .insert(branches)
      .values({ organizationId: switchOrganizationId, name: `Switch ${suffix}`, status: "active" })
      .returning({ id: branches.id })
    switchBranchId = switchBranch.id

    // Codes written directly: issuing one is the join-code suite's subject, not this one's.
    openCode = `ITDA-${suffix}`.toUpperCase()
    switchCode = `ITDS-${suffix}`.toUpperCase()
    await db.insert(organizationJoinCodes).values([
      { organizationId: fixtures.organizationId, code: openCode },
      { organizationId: switchOrganizationId, code: switchCode },
    ])
  })

  afterAll(async () => {
    if (fixtures) {
      const created = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(like(organizations.name, `${namePrefix()}%`))
      const organizationIds = created.map((row) => row.id)

      if (organizationIds.length > 0) {
        await db.delete(auditLogs).where(inArray(auditLogs.organizationId, organizationIds))
        await db.delete(organizationJoinRequests)
          .where(inArray(organizationJoinRequests.organizationId, organizationIds))
        await db.delete(organizationJoinCodes)
          .where(inArray(organizationJoinCodes.organizationId, organizationIds))
        await db.delete(organizationSettings)
          .where(inArray(organizationSettings.organizationId, organizationIds))
        await db.delete(organizationAllowedIps)
          .where(inArray(organizationAllowedIps.organizationId, organizationIds))
        await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
        await db.delete(organizations).where(inArray(organizations.id, organizationIds))
      }
      if (superAdminId) {
        await db.delete(auditLogs).where(eq(auditLogs.userId, superAdminId))
      }
      await destroyJoinFixtures(fixtures, superAdminId ? [superAdminId] : [])
    }
    await closePool()
  })

  beforeEach(() => {
    mocks.hashPassword.mockClear()
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 10, resetIn: 60 })
    signIn(null)
  })

  /* ── Setting it: Create Company ─────────────────────────────────────────── */

  describe("creating an organization with a domain", () => {
    const createBody = (name: string, code: string, extra: Record<string, unknown> = {}) => ({
      name,
      code,
      ...extra,
    })

    it("is refused unauthenticated and to Head Office", async () => {
      const payload = createBody(`${namePrefix()} Refused`, `ITDR_${fixtures.suffix}`, {
        emailDomain: "refused.example.test",
      })

      signIn(null)
      expect((await createOrganization(jsonRequest("/api/v1/organizations", "POST", payload))).status)
        .toBe(401)

      signIn(headOffice())
      expect((await createOrganization(jsonRequest("/api/v1/organizations", "POST", payload))).status)
        .toBe(403)

      const [row] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.name, `${namePrefix()} Refused`))
      expect(row).toBeUndefined()
    })

    it("stores the domain normalised, and records it on the creation audit row", async () => {
      signIn(superAdmin())
      const response = await createOrganization(jsonRequest(
        "/api/v1/organizations",
        "POST",
        createBody(`${namePrefix()} Created`, `ITDC_${fixtures.suffix}`, {
          emailDomain: "  @Created.Example.TEST ",
        }),
      ))
      expect(response.status).toBe(201)
      const created = (await body(response)).item
      expect(created.emailDomain).toBe("created.example.test")
      expect(await storedDomain(created.id)).toBe("created.example.test")

      const [audit] = await db
        .select({ metadata: auditLogs.metadata, userId: auditLogs.userId })
        .from(auditLogs)
        .where(and(
          eq(auditLogs.organizationId, created.id),
          eq(auditLogs.action, "CREATE_ORGANIZATION"),
        ))
      expect(audit.userId).toBe(superAdminId)
      expect((audit.metadata as any).emailDomain).toBe("created.example.test")
    })

    it("stores null when no domain is given, and when a blank one is", async () => {
      signIn(superAdmin())
      for (const [label, extra] of [
        ["Absent", {}],
        ["Blank", { emailDomain: "   " }],
      ] as const) {
        const response = await createOrganization(jsonRequest(
          "/api/v1/organizations",
          "POST",
          createBody(`${namePrefix()} ${label}`, `ITD${label[0]}_${fixtures.suffix}`, extra),
        ))
        expect(response.status).toBe(201)
        expect(await storedDomain((await body(response)).item.id)).toBeNull()
      }
    })

    it("refuses a malformed domain and creates nothing", async () => {
      signIn(superAdmin())
      for (const emailDomain of ["not a domain", "name@example.test", "localhost", "ke..com"]) {
        const response = await createOrganization(jsonRequest(
          "/api/v1/organizations",
          "POST",
          createBody(`${namePrefix()} Malformed`, `ITDM_${fixtures.suffix}`, { emailDomain }),
        ))
        expect(response.status).toBe(400)
        expect((await body(response)).error).toMatch(/domain/i)
      }
      const [row] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.name, `${namePrefix()} Malformed`))
      expect(row).toBeUndefined()
    })

    it("lets two organizations share a domain, as tenants on one mail system do", async () => {
      signIn(superAdmin())
      const shared = `shared-${fixtures.suffix}.example.test`
      for (const label of ["Shared One", "Shared Two"]) {
        const response = await createOrganization(jsonRequest(
          "/api/v1/organizations",
          "POST",
          createBody(`${namePrefix()} ${label}`, `ITD${label.replace(" ", "")}_${fixtures.suffix}`.slice(0, 20), {
            emailDomain: shared,
          }),
        ))
        expect(response.status).toBe(201)
      }
      const rows = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.emailDomain, shared))
      expect(rows).toHaveLength(2)
    })
  })

  /* ── Setting it: Edit Company ───────────────────────────────────────────── */

  describe("editing an organization's domain", () => {
    it("is refused unauthenticated and to Head Office, even for its own tenant", async () => {
      await arrangeDomain(fixtures.organizationId, JOIN_FIXTURE_EMAIL_DOMAIN)

      signIn(null)
      expect((await patch(fixtures.organizationId, { emailDomain: "taken.example.test" })).status)
        .toBe(401)

      signIn(headOffice())
      expect((await patch(fixtures.organizationId, { emailDomain: "taken.example.test" })).status)
        .toBe(403)

      expect(await storedDomain(fixtures.organizationId)).toBe(JOIN_FIXTURE_EMAIL_DOMAIN)
    })

    it("sets it normalised and audits what it replaced", async () => {
      await arrangeDomain(switchOrganizationId, null)
      const before = (await domainAuditRows(switchOrganizationId)).length

      signIn(superAdmin())
      const response = await patch(switchOrganizationId, { emailDomain: "@Switch.Example.TEST" })
      expect(response.status).toBe(200)
      expect((await body(response)).item.emailDomain).toBe("switch.example.test")
      expect(await storedDomain(switchOrganizationId)).toBe("switch.example.test")

      const rows = await domainAuditRows(switchOrganizationId)
      expect(rows).toHaveLength(before + 1)
      expect(rows.at(-1)!.userId).toBe(superAdminId)
      expect(rows.at(-1)!.metadata).toEqual({
        previousEmailDomain: null,
        emailDomain: "switch.example.test",
      })
    })

    it("writes no audit row when the domain is saved unchanged", async () => {
      await arrangeDomain(switchOrganizationId, "same.example.test")
      const before = (await domainAuditRows(switchOrganizationId)).length

      signIn(superAdmin())
      // The Edit dialog always sends the field; saving another field must not
      // leave a spurious "domain changed" row behind.
      expect((await patch(switchOrganizationId, { emailDomain: "SAME.example.test" })).status)
        .toBe(200)
      expect(await domainAuditRows(switchOrganizationId)).toHaveLength(before)
    })

    it("clears it with null and with a blank string", async () => {
      signIn(superAdmin())
      for (const cleared of [null, ""]) {
        await arrangeDomain(switchOrganizationId, "clear-me.example.test")
        const response = await patch(switchOrganizationId, { emailDomain: cleared })
        expect(response.status).toBe(200)
        expect(await storedDomain(switchOrganizationId)).toBeNull()

        const last = (await domainAuditRows(switchOrganizationId)).at(-1)!
        expect(last.metadata).toEqual({
          previousEmailDomain: "clear-me.example.test",
          emailDomain: null,
        })
      }
    })

    it("leaves it alone when another field is edited without it", async () => {
      await arrangeDomain(switchOrganizationId, "kept.example.test")
      signIn(superAdmin())
      expect((await patch(switchOrganizationId, { ntnNumber: "1234567-8" })).status).toBe(200)
      expect(await storedDomain(switchOrganizationId)).toBe("kept.example.test")
    })

    it("refuses a malformed domain and keeps the stored one", async () => {
      await arrangeDomain(switchOrganizationId, "kept.example.test")
      signIn(superAdmin())
      for (const emailDomain of ["not a domain", "a@b.example.test", "example", "-x.example.test"]) {
        const response = await patch(switchOrganizationId, { emailDomain })
        expect(response.status).toBe(400)
      }
      expect(await storedDomain(switchOrganizationId)).toBe("kept.example.test")
    })
  })

  /* ── The database holds the same rule ───────────────────────────────────── */

  describe("the check constraint", () => {
    it.each(["UPPER.EXAMPLE.TEST", "not a domain", "localhost", "a@b.example.test", "x.123"])(
      "refuses %j written around the API",
      async (emailDomain) => {
        // Straight to the table, the way a script or a future endpoint might.
        const failure = await db
          .execute(sql`UPDATE organizations SET email_domain = ${emailDomain} WHERE id = ${switchOrganizationId}`)
          .then(() => null, (caught: any) => caught)
        expect(failure).not.toBeNull()
        // 23514 is check_violation; Drizzle may or may not wrap the driver error.
        expect(String(failure.code ?? failure.cause?.code)).toBe("23514")
        expect(String(failure.constraint ?? failure.cause?.constraint))
          .toBe("organizations_email_domain_shape_ck")
      },
    )

    it("accepts a well-formed domain and null", async () => {
      await db.execute(sql`UPDATE organizations SET email_domain = 'ok.example.test' WHERE id = ${switchOrganizationId}`)
      await db.execute(sql`UPDATE organizations SET email_domain = NULL WHERE id = ${switchOrganizationId}`)
      expect(await storedDomain(switchOrganizationId)).toBeNull()
    })
  })

  /* ── The lookup ─────────────────────────────────────────────────────────── */

  describe("looking an organization up by code", () => {
    it("returns the domain with the form's options when one is set", async () => {
      await arrangeDomain(fixtures.organizationId, JOIN_FIXTURE_EMAIL_DOMAIN)
      const response = await lookup(jsonRequest("/api/v1/join/lookup", "POST", { code: openCode }))
      expect(response.status).toBe(200)
      const payload = await body(response)
      expect(payload.emailDomain).toBe(JOIN_FIXTURE_EMAIL_DOMAIN)
      expect(payload.branches.map((branch: any) => branch.id)).toContain(fixtures.northBranchId)
    })

    it("answers a domainless organization with no domain, and withholds its branches and groups", async () => {
      await arrangeDomain(switchOrganizationId, null)
      const response = await lookup(jsonRequest("/api/v1/join/lookup", "POST", { code: switchCode }))
      expect(response.status).toBe(200)
      expect(await body(response)).toEqual({
        organizationName: `${namePrefix()} Switch`,
        emailDomain: null,
        branches: [],
        groups: [],
      })
    })

    it("answers an unknown code exactly as before — the domain adds no oracle", async () => {
      const response = await lookup(jsonRequest("/api/v1/join/lookup", "POST", { code: "ZZZZ-ZZZZ-ZZZZ" }))
      expect(response.status).toBe(404)
      const payload = await body(response)
      expect(payload.emailDomain).toBeUndefined()
      expect(payload.error).toMatch(/not recognised/)
    })
  })

  /* ── The submission ─────────────────────────────────────────────────────── */

  describe("submitting a request", () => {
    it("refuses every address when the organization has no domain, and stores nothing", async () => {
      await arrangeDomain(switchOrganizationId, null)
      const before = await requestsFor(switchOrganizationId)

      const response = await submit(jsonRequest("/api/v1/join/requests", "POST", submission({
        code: switchCode,
        branchId: switchBranchId,
      })))
      expect(response.status).toBe(409)
      expect((await body(response)).error).toBe(JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE)

      expect(await requestsFor(switchOrganizationId)).toHaveLength(before.length)
      // Refused before the password was even hashed.
      expect(mocks.hashPassword).not.toHaveBeenCalled()
    })

    it.each([
      ["another domain", "gmail.com"],
      ["a subdomain", `mail.${JOIN_FIXTURE_EMAIL_DOMAIN}`],
      ["the domain with more labels after it", `${JOIN_FIXTURE_EMAIL_DOMAIN}.evil.test`],
      ["a name that merely ends in the domain", `evil${JOIN_FIXTURE_EMAIL_DOMAIN}`],
    ])("refuses %s with 400 and stores nothing", async (_label, domain) => {
      await arrangeDomain(fixtures.organizationId, JOIN_FIXTURE_EMAIL_DOMAIN)
      const before = await requestsFor(fixtures.organizationId)

      const response = await submit(jsonRequest("/api/v1/join/requests", "POST", submission({
        email: `ada-${fixtures.suffix}@${domain}`,
      })))
      expect(response.status).toBe(400)
      expect((await body(response)).error).toBe(`Use your @${JOIN_FIXTURE_EMAIL_DOMAIN} email address to join.`)

      expect(await requestsFor(fixtures.organizationId)).toHaveLength(before.length)
      expect(mocks.hashPassword).not.toHaveBeenCalled()
    })

    it("accepts an address at the domain in any case, and stores it lower-cased", async () => {
      await arrangeDomain(fixtures.organizationId, JOIN_FIXTURE_EMAIL_DOMAIN)
      const localPart = `Ada.Case-${fixtures.suffix}`
      const response = await submit(jsonRequest("/api/v1/join/requests", "POST", submission({
        email: `${localPart}@EXAMPLE.Test`,
      })))
      expect(response.status).toBe(201)

      const stored = (await requestsFor(fixtures.organizationId))
        .find((row) => row.email === `${localPart.toLowerCase()}@${JOIN_FIXTURE_EMAIL_DOMAIN}`)
      expect(stored).toBeDefined()
    })

    it("judges the domain the organization has now, not the one the page was shown", async () => {
      // The applicant looked the code up while the domain was one thing...
      await arrangeDomain(switchOrganizationId, "before.example.test")
      const shown = await body(await lookup(jsonRequest("/api/v1/join/lookup", "POST", { code: switchCode })))
      expect(shown.emailDomain).toBe("before.example.test")

      // ...and Super Admin changed it before they pressed Send.
      await arrangeDomain(switchOrganizationId, "after.example.test")
      const stale = await submit(jsonRequest("/api/v1/join/requests", "POST", submission({
        code: switchCode,
        branchId: switchBranchId,
        email: `ada-${fixtures.suffix}@before.example.test`,
      })))
      expect(stale.status).toBe(400)
      expect((await body(stale)).error).toMatch(/@after\.example\.test/)

      const current = await submit(jsonRequest("/api/v1/join/requests", "POST", submission({
        code: switchCode,
        branchId: switchBranchId,
        email: `ada-${fixtures.suffix}@after.example.test`,
      })))
      expect(current.status).toBe(201)
    })

    it("closes the moment the domain is cleared, even for a page already showing the form", async () => {
      await arrangeDomain(switchOrganizationId, "open.example.test")
      expect((await body(await lookup(
        jsonRequest("/api/v1/join/lookup", "POST", { code: switchCode }),
      ))).emailDomain).toBe("open.example.test")

      await arrangeDomain(switchOrganizationId, null)
      const response = await submit(jsonRequest("/api/v1/join/requests", "POST", submission({
        code: switchCode,
        branchId: switchBranchId,
        email: `late-${fixtures.suffix}@open.example.test`,
      })))
      expect(response.status).toBe(409)
      expect((await body(response)).error).toBe(JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE)
    })

    it("refuses an emailDomain field in the body rather than letting the caller pick one", async () => {
      await arrangeDomain(fixtures.organizationId, JOIN_FIXTURE_EMAIL_DOMAIN)
      const response = await submit(jsonRequest("/api/v1/join/requests", "POST", submission({
        email: `ada-${fixtures.suffix}@gmail.com`,
        emailDomain: "gmail.com",
      })))
      expect(response.status).toBe(400)
      expect((await body(response)).error).toMatch(/Unknown field/i)
    })
  })

  /* ── Head Office sees it beside the code ────────────────────────────────── */

  describe("Head Office's join-code view", () => {
    it("shows its own organization's domain, and only its own", async () => {
      await arrangeDomain(fixtures.organizationId, JOIN_FIXTURE_EMAIL_DOMAIN)
      await arrangeDomain(fixtures.foreignOrganizationId, null)

      signIn(headOffice())
      expect((await body(await readJoinCode())).emailDomain).toBe(JOIN_FIXTURE_EMAIL_DOMAIN)

      signIn({
        id: fixtures.foreignHeadOfficeId,
        role: "HEAD_OFFICE",
        organizationId: fixtures.foreignOrganizationId,
      })
      expect((await body(await readJoinCode())).emailDomain).toBeNull()

      await arrangeDomain(fixtures.foreignOrganizationId, JOIN_FIXTURE_EMAIL_DOMAIN)
    })
  })
})

describe.skipIf(hasTestDatabase)("organization email domain integration suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})
