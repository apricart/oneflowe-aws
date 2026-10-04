import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as decideRoute from "@/app/api/v1/join-requests/[id]/route"
import * as queueRoute from "@/app/api/v1/join-requests/route"
import * as lookupRoute from "@/app/api/v1/join/lookup/route"
import * as submitRoute from "@/app/api/v1/join/requests/route"
import * as joinCodeRoute from "@/app/api/v1/organizations/join-code/route"
import {
  auditLogs,
  organizationJoinRequests,
  roles,
  userBranchAssignments,
  userGroupAssignments,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"

import {
  NO_DATABASE_REASON,
  createJoinFixtures,
  destroyJoinFixtures,
  findRequestByEmail,
  hasTestDatabase,
  readStoredRequest,
  type JoinFixtures,
} from "./helpers/organization-join-fixtures"

const mocks = vi.hoisted(() => ({
  hashPassword: vi.fn(async (plain: string) => `hashed:${plain}`),
  sendJoinDecisionEmail: vi.fn(async () => true),
  withRateLimit: vi.fn(async () => null),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 10, resetIn: 60 })),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/password", () => ({ hashPassword: mocks.hashPassword }))
vi.mock("@/lib/email/join-request", () => ({
  sendJoinDecisionEmail: mocks.sendJoinDecisionEmail,
}))
vi.mock("@/lib/rate-limiter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limiter")>()
  return {
    ...actual,
    // No Redis here. The limiters themselves are covered by the contract test,
    // which asserts every public route consults both budgets.
    withRateLimit: mocks.withRateLimit,
    checkRateLimit: mocks.checkRateLimit,
    getClientIdentifier: async () => "ip:127.0.0.1",
  }
})

const { getServerSession } = mockedNextAuth
const { POST: lookup } = lookupRoute
const { POST: submit } = submitRoute
const { GET: readCode, PUT: setCode, DELETE: clearCode } = joinCodeRoute
const { GET: listQueue } = queueRoute
const { PATCH: decide } = decideRoute

type Actor = { id: string; email: string; role: string; organizationId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

function jsonRequest(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function getRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`)
}

async function body(response: Response): Promise<any> {
  return response.json()
}

const STRONG_PASSWORD = "Join-Flow-2026!x"

describe.skipIf(!hasTestDatabase)("joining an organization, end to end", () => {
  let fixtures: JoinFixtures
  const createdUserIds: string[] = []
  let code = ""

  const actor = (kind: "head" | "foreignHead" | "branchAdmin" | "orderPortal"): Actor => {
    const values = {
      head: { id: fixtures.headOfficeId, role: "HEAD_OFFICE", organizationId: fixtures.organizationId },
      foreignHead: {
        id: fixtures.foreignHeadOfficeId,
        role: "HEAD_OFFICE",
        organizationId: fixtures.foreignOrganizationId,
      },
      branchAdmin: {
        id: fixtures.branchAdminId,
        role: "BRANCH_ADMIN",
        organizationId: fixtures.organizationId,
      },
      orderPortal: {
        id: fixtures.orderPortalId,
        role: "ORDER_PORTAL",
        organizationId: fixtures.organizationId,
      },
    }[kind]
    return { ...values, email: `${kind}-${fixtures.suffix}@example.test` }
  }

  /** A submission body that would succeed, so each test can spoil one field. */
  const submission = (overrides: Record<string, unknown> = {}) => ({
    code,
    firstName: "Ada",
    lastName: "Lovelace",
    email: `ada-${fixtures.suffix}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    username: `ada-${fixtures.suffix}-${Math.random().toString(36).slice(2, 8)}`,
    password: STRONG_PASSWORD,
    role: "ORDER_PORTAL",
    branchId: fixtures.northBranchId,
    ...overrides,
  })

  async function issueCode(): Promise<string> {
    signIn(actor("head"))
    const response = await setCode(jsonRequest("/api/v1/organizations/join-code", "PUT", {}))
    expect(response.status).toBe(200)
    return (await body(response)).code as string
  }

  /** Submit and return the stored row, asserting the endpoint accepted it. */
  async function submitAccepted(input: Record<string, unknown>) {
    const response = await submit(jsonRequest("/api/v1/join/requests", "POST", input))
    expect(response.status).toBe(201)
    const stored = await findRequestByEmail(String(input.email).toLowerCase())
    expect(stored).not.toBeNull()
    return stored!
  }

  beforeAll(async () => {
    fixtures = await createJoinFixtures()
    code = await issueCode()
  })

  afterAll(async () => {
    if (fixtures) await destroyJoinFixtures(fixtures, createdUserIds)
    await closePool()
  })

  beforeEach(() => {
    mocks.sendJoinDecisionEmail.mockClear()
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 10, resetIn: 60 })
    signIn(null)
  })

  /* ── The code ─────────────────────────────────────────────────────────── */

  describe("issuing the code", () => {
    it("is refused to an unauthenticated caller", async () => {
      signIn(null)
      expect((await setCode(jsonRequest("/api/v1/organizations/join-code", "PUT", {}))).status)
        .toBe(401)
      expect((await readCode()).status).toBe(401)
      expect((await clearCode()).status).toBe(401)
    })

    it.each(["branchAdmin", "orderPortal"] as const)(
      "is refused to %s, who may not open the tenant to outsiders",
      async (kind) => {
        signIn(actor(kind))
        expect((await readCode()).status).toBe(403)
        expect((await setCode(jsonRequest("/api/v1/organizations/join-code", "PUT", {}))).status)
          .toBe(403)
        expect((await clearCode()).status).toBe(403)
      },
    )

    it("generates a code that satisfies the shape its check constraint enforces", async () => {
      expect(code).toMatch(/^[A-Z0-9-]{8,32}$/)
    })

    it("reads back only to the head office that owns it", async () => {
      signIn(actor("head"))
      const mine = await body(await readCode())
      expect(mine.code).toBe(code)
      expect(mine.joiningOpen).toBe(true)

      // The neighbour sees its own tenant's state, never this code. There is no
      // organizationId parameter to point it anywhere else.
      signIn(actor("foreignHead"))
      const theirs = await body(await readCode())
      expect(theirs.code).toBeNull()
      expect(theirs.joiningOpen).toBe(false)
    })

    it("refuses a code another tenant already holds", async () => {
      signIn(actor("foreignHead"))
      const response = await setCode(
        jsonRequest("/api/v1/organizations/join-code", "PUT", { code }),
      )
      expect(response.status).toBe(409)
      expect((await body(response)).error).toMatch(/already in use/i)
    })

    it("refuses a code too short to be worth guessing at", async () => {
      signIn(actor("head"))
      const response = await setCode(
        jsonRequest("/api/v1/organizations/join-code", "PUT", { code: "SHORT1" }),
      )
      expect(response.status).toBe(400)
    })

    it("accepts a typed code, upper-cased, and replaces the previous one", async () => {
      signIn(actor("head"))
      const typed = `it-typed-${fixtures.suffix}`
      const response = await setCode(
        jsonRequest("/api/v1/organizations/join-code", "PUT", { code: typed }),
      )
      expect(response.status).toBe(200)
      expect((await body(response)).code).toBe(typed.toUpperCase())

      // The old code stops working the moment it is replaced.
      const stale = await lookup(jsonRequest("/api/v1/join/lookup", "POST", { code }))
      expect(stale.status).toBe(404)

      // Put the generated one back for the rest of the suite.
      code = await issueCode()
    })

    it("writes an audit row naming who opened joining, and never the code", async () => {
      signIn(actor("head"))
      await setCode(jsonRequest("/api/v1/organizations/join-code", "PUT", {}))

      const rows = await db
        .select({ action: auditLogs.action, userId: auditLogs.userId, metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(and(
          eq(auditLogs.organizationId, fixtures.organizationId),
          eq(auditLogs.action, "SET_ORGANIZATION_JOIN_CODE"),
        ))
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.userId).toBe(fixtures.headOfficeId)
        expect(JSON.stringify(row.metadata)).not.toContain(code)
      }

      code = await issueCode()
    })

    it("closes joining when the code is cleared, and reopens on a new one", async () => {
      signIn(actor("head"))
      expect((await clearCode()).status).toBe(200)

      const closed = await lookup(jsonRequest("/api/v1/join/lookup", "POST", { code }))
      expect(closed.status).toBe(404)

      code = await issueCode()
      const open = await lookup(jsonRequest("/api/v1/join/lookup", "POST", { code }))
      expect(open.status).toBe(200)
    })
  })

  /* ── The lookup ───────────────────────────────────────────────────────── */

  describe("looking an organization up by code", () => {
    it("returns the tenant's name and only its active branches and groups", async () => {
      const response = await lookup(jsonRequest("/api/v1/join/lookup", "POST", { code }))
      expect(response.status).toBe(200)
      const payload = await body(response)

      expect(payload.organizationName).toBe(fixtures.organizationName)

      const branchIds = payload.branches.map((branch: any) => branch.id)
      expect(branchIds).toContain(fixtures.northBranchId)
      // De-activated and foreign rows never appear.
      expect(branchIds).not.toContain(fixtures.retiredBranchId)
      expect(branchIds).not.toContain(fixtures.foreignBranchId)

      const groupIds = payload.groups.map((group: any) => group.id)
      expect(groupIds).toContain(fixtures.northGroupId)
      expect(groupIds).not.toContain(fixtures.retiredGroupId)
      expect(groupIds).not.toContain(fixtures.foreignGroupId)
    })

    it("carries identity fields only — nothing about money or administration", async () => {
      const payload = await body(await lookup(jsonRequest("/api/v1/join/lookup", "POST", { code })))
      for (const branch of payload.branches) {
        expect(Object.keys(branch).sort()).toEqual(["id", "name"])
      }
      for (const group of payload.groups) {
        expect(Object.keys(group).sort()).toEqual(["id", "name"])
      }
      const serialized = JSON.stringify(payload)
      expect(serialized).not.toContain("baselineBudget")
      expect(serialized).not.toContain("adminUserId")
      expect(serialized).not.toContain("externalId")
      // Crucially, no tenant id: the submit step re-sends the code instead.
      expect(payload.organizationId).toBeUndefined()
    })

    it("accepts the code in any case and with surrounding space", async () => {
      const response = await lookup(
        jsonRequest("/api/v1/join/lookup", "POST", { code: `  ${code.toLowerCase()}  ` }),
      )
      expect(response.status).toBe(200)
    })

    it("answers an unknown code and a suspended tenant's code identically", async () => {
      // Give the suspended tenant a real code, then confirm it is as invisible as
      // a code that never existed — a status change must not become an oracle.
      // A real head office *of* the suspended tenant. Claiming its
      // organizationId from a session would not work and must not: the scope is
      // read from the database by user id.
      signIn({
        id: fixtures.suspendedHeadOfficeId,
        email: `suspended-head-${fixtures.suffix}@example.test`,
        role: "HEAD_OFFICE",
        organizationId: fixtures.suspendedOrganizationId,
      })
      const suspendedCode = (await body(
        await setCode(jsonRequest("/api/v1/organizations/join-code", "PUT", {})),
      )).code as string
      signIn(null)

      const unknown = await lookup(
        jsonRequest("/api/v1/join/lookup", "POST", { code: "ZZZZ-ZZZZ-ZZZZ" }),
      )
      const suspended = await lookup(
        jsonRequest("/api/v1/join/lookup", "POST", { code: suspendedCode }),
      )

      expect(unknown.status).toBe(404)
      expect(suspended.status).toBe(404)
      expect((await body(unknown)).error).toBe((await body(suspended)).error)
    })

    it("refuses a malformed body and an unknown field", async () => {
      expect((await lookup(jsonRequest("/api/v1/join/lookup", "POST", { code: 42 }))).status)
        .toBe(400)
      expect((await lookup(
        jsonRequest("/api/v1/join/lookup", "POST", { code, organizationId: 1 }),
      )).status).toBe(400)
    })

    it("answers 429 once either budget is spent", async () => {
      mocks.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetIn: 900 })
      const response = await lookup(jsonRequest("/api/v1/join/lookup", "POST", { code }))
      expect(response.status).toBe(429)
      expect(response.headers.get("Retry-After")).toBe("900")
    })
  })

  /* ── Submitting ───────────────────────────────────────────────────────── */

  describe("submitting a request", () => {
    it("records a pending request and creates no user", async () => {
      const input = submission()
      const stored = await submitAccepted(input)

      expect(stored.status).toBe("pending")
      expect(stored.organizationId).toBe(fixtures.organizationId)
      expect(stored.requestedRole).toBe("ORDER_PORTAL")
      expect(stored.requestedBranchId).toBe(fixtures.northBranchId)
      expect(stored.createdUserId).toBeNull()
      expect(stored.decidedAt).toBeNull()

      const [account] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, String(input.username).toLowerCase()))
        .limit(1)
      expect(account).toBeUndefined()
    })

    it("stores only a hash of the chosen password", async () => {
      const input = submission()
      const stored = await submitAccepted(input)

      // What is stored is whatever `hashPassword` returned and nothing else, so
      // the plaintext has no column of its own. (The mock's output deliberately
      // embeds the input so the carry-over to `users` can be traced; the real
      // bcrypt output does not, which is why this asserts the *provenance* of
      // the column rather than the absence of a substring.)
      expect(mocks.hashPassword).toHaveBeenCalledWith(STRONG_PASSWORD)
      expect(stored.passwordHash).toBe(`hashed:${STRONG_PASSWORD}`)
      expect(Object.keys(stored)).not.toContain("password")
    })

    it("lower-cases the email and username it stores", async () => {
      const input = submission({
        email: `MiXeD-${fixtures.suffix}@Example.TEST`,
        username: `MiXeD-${fixtures.suffix}`,
      })
      const response = await submit(jsonRequest("/api/v1/join/requests", "POST", input))
      expect(response.status).toBe(201)

      const stored = await findRequestByEmail(`mixed-${fixtures.suffix}@example.test`)
      expect(stored?.username).toBe(`mixed-${fixtures.suffix}`)
    })

    it("refuses an administrative role at the schema boundary", async () => {
      for (const role of ["HEAD_OFFICE", "SUPER_ADMIN"]) {
        const response = await submit(
          jsonRequest("/api/v1/join/requests", "POST", submission({ role })),
        )
        expect(response.status).toBe(400)
      }
    })

    it("refuses an attempt to activate, enable MFA, or grant budget allocation", async () => {
      for (const field of ["isActive", "mfaEnabled", "budgetAllocationEnabled"]) {
        const response = await submit(
          jsonRequest("/api/v1/join/requests", "POST", submission({ [field]: true })),
        )
        expect(response.status).toBe(400)
        expect((await body(response)).error).toMatch(/Unknown field/i)
      }
    })

    it("refuses an organizationId in the body outright", async () => {
      // Not "ignores" — the schema is strict, so naming a tenant is a 400. That
      // is what makes it impossible to aim a submission at another tenant.
      const response = await submit(
        jsonRequest("/api/v1/join/requests", "POST", submission({
          organizationId: fixtures.foreignOrganizationId,
        })),
      )
      expect(response.status).toBe(400)
    })

    it("refuses a branch belonging to another tenant", async () => {
      const response = await submit(
        jsonRequest("/api/v1/join/requests", "POST", submission({
          branchId: fixtures.foreignBranchId,
        })),
      )
      expect(response.status).toBe(400)
      expect((await body(response)).error).toMatch(/not available in this organization/i)
    })

    it("refuses a de-activated branch of its own tenant", async () => {
      const response = await submit(
        jsonRequest("/api/v1/join/requests", "POST", submission({
          branchId: fixtures.retiredBranchId,
        })),
      )
      expect(response.status).toBe(400)
    })

    it("refuses a group role with no assignment, rather than widening to the tenant", async () => {
      const response = await submit(
        jsonRequest("/api/v1/join/requests", "POST", submission({
          role: "GROUP_ORDER_PORTAL",
          branchId: null,
          groupIds: [],
          branchIds: [],
        })),
      )
      expect(response.status).toBe(400)
      expect((await body(response)).error).toMatch(/at least one group or one branch/i)
    })

    it("refuses a group role carrying a single branch, and a single-branch role carrying lists", async () => {
      const groupWithBranch = await submit(
        jsonRequest("/api/v1/join/requests", "POST", submission({
          role: "GROUP_USER",
          branchId: fixtures.northBranchId,
          groupIds: [fixtures.northGroupId],
        })),
      )
      expect(groupWithBranch.status).toBe(400)

      const singleWithLists = await submit(
        jsonRequest("/api/v1/join/requests", "POST", submission({
          role: "BRANCH_ADMIN",
          branchId: fixtures.northBranchId,
          groupIds: [fixtures.northGroupId],
        })),
      )
      expect(singleWithLists.status).toBe(400)
    })

    it("refuses another tenant's group and a deleted group", async () => {
      for (const groupId of [fixtures.foreignGroupId, fixtures.retiredGroupId]) {
        const response = await submit(
          jsonRequest("/api/v1/join/requests", "POST", submission({
            role: "GROUP_USER",
            branchId: null,
            groupIds: [groupId],
          })),
        )
        expect(response.status).toBe(400)
      }
    })

    it("refuses a weak password", async () => {
      for (const password of ["short", "alllowercase1!", "NOUPPERLOWER123!", "NoSymbols1234"]) {
        const response = await submit(
          jsonRequest("/api/v1/join/requests", "POST", submission({ password })),
        )
        expect(response.status).toBe(400)
      }
    })

    it("refuses an unrecognised code without touching the queue", async () => {
      const before = await db
        .select({ id: organizationJoinRequests.id })
        .from(organizationJoinRequests)
        .where(eq(organizationJoinRequests.organizationId, fixtures.organizationId))

      const response = await submit(
        jsonRequest("/api/v1/join/requests", "POST", submission({ code: "ZZZZ-ZZZZ-ZZZZ" })),
      )
      expect(response.status).toBe(404)

      const after = await db
        .select({ id: organizationJoinRequests.id })
        .from(organizationJoinRequests)
        .where(eq(organizationJoinRequests.organizationId, fixtures.organizationId))
      expect(after).toHaveLength(before.length)
    })

    it("answers a duplicate pending request without naming the field", async () => {
      const input = submission()
      await submitAccepted(input)

      const again = await submit(jsonRequest("/api/v1/join/requests", "POST", input))
      expect(again.status).toBe(409)
      const message = (await body(again)).error as string
      expect(message).not.toMatch(/email|username|phone|employee/i)
      expect(message).toMatch(/cannot be used to join/i)
    })

    it("lets a second tenant queue the same person, and resolves it at approval", async () => {
      // The pending-request indexes are keyed on the organization on purpose. A
      // global one would let anybody holding tenant A's code block a person from
      // ever applying to tenant B — a cross-tenant denial neither tenant can see
      // or clear. Two queues may hold the same person; the account rule is still
      // application-wide, so only one of them can be approved.
      signIn(actor("foreignHead"))
      const foreignCode = (await body(
        await setCode(jsonRequest("/api/v1/organizations/join-code", "PUT", {})),
      )).code as string
      signIn(null)

      const shared = submission()
      const mine = await submitAccepted(shared)

      const theirs = await submit(jsonRequest("/api/v1/join/requests", "POST", {
        ...shared,
        code: foreignCode,
        branchId: fixtures.foreignBranchId,
      }))
      expect(theirs.status).toBe(201)

      // First approval wins.
      signIn(actor("head"))
      const first = await decide(
        jsonRequest(`/api/v1/join-requests/${mine.id}`, "PATCH", { decision: "approve" }),
        { params: Promise.resolve({ id: String(mine.id) }) },
      )
      expect(first.status).toBe(200)
      createdUserIds.push((await body(first)).createdUserId)

      // The neighbour's own queue entry is now unapprovable, and says so.
      const [neighbourRequest] = await db
        .select({ id: organizationJoinRequests.id })
        .from(organizationJoinRequests)
        .where(and(
          eq(organizationJoinRequests.organizationId, fixtures.foreignOrganizationId),
          eq(organizationJoinRequests.email, String(shared.email).toLowerCase()),
        ))
        .limit(1)
      expect(neighbourRequest).toBeDefined()

      signIn(actor("foreignHead"))
      const second = await decide(
        jsonRequest(`/api/v1/join-requests/${neighbourRequest.id}`, "PATCH", { decision: "approve" }),
        { params: Promise.resolve({ id: String(neighbourRequest.id) }) },
      )
      expect(second.status).toBe(409)

      // Exactly one account exists for that person, in the tenant that acted first.
      const accounts = await db
        .select({ organizationId: users.organizationId })
        .from(users)
        .where(eq(users.email, String(shared.email).toLowerCase()))
      expect(accounts).toHaveLength(1)
      expect(accounts[0].organizationId).toBe(fixtures.organizationId)

      signIn(actor("foreignHead"))
      await clearCode()
    })

    it("still refuses a duplicate pending request inside the same tenant", async () => {
      const input = submission()
      await submitAccepted(input)
      const again = await submit(jsonRequest("/api/v1/join/requests", "POST", input))
      expect(again.status).toBe(409)
    })

    it("answers an email already held by a real account the same way", async () => {
      const existing = actor("branchAdmin")
      const [row] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, existing.id))
        .limit(1)

      const response = await submit(
        jsonRequest("/api/v1/join/requests", "POST", submission({ email: row.email })),
      )
      expect(response.status).toBe(409)
      expect((await body(response)).error).toMatch(/cannot be used to join/i)
    })
  })

  /* ── The queue ────────────────────────────────────────────────────────── */

  describe("the queue", () => {
    it("is refused unauthenticated and to every role but head office", async () => {
      signIn(null)
      expect((await listQueue(getRequest("/api/v1/join-requests"))).status).toBe(401)

      for (const kind of ["branchAdmin", "orderPortal"] as const) {
        signIn(actor(kind))
        expect((await listQueue(getRequest("/api/v1/join-requests"))).status).toBe(403)
      }
    })

    it("shows the tenant's own requests and never the neighbour's", async () => {
      const input = submission()
      const stored = await submitAccepted(input)

      signIn(actor("head"))
      const mine = await body(await listQueue(getRequest("/api/v1/join-requests")))
      expect(mine.items.map((item: any) => item.id)).toContain(stored.id)

      signIn(actor("foreignHead"))
      const theirs = await body(await listQueue(getRequest("/api/v1/join-requests")))
      expect(theirs.items.map((item: any) => item.id)).not.toContain(stored.id)
    })

    it("never returns the password hash or the submitting address", async () => {
      await submitAccepted(submission())

      signIn(actor("head"))
      const payload = await body(await listQueue(getRequest("/api/v1/join-requests")))
      const serialized = JSON.stringify(payload)
      expect(serialized).not.toContain("passwordHash")
      expect(serialized).not.toContain("hashed:")
      expect(serialized).not.toContain("submittedIp")
      expect(serialized).not.toContain("submittedUserAgent")
    })

    it("refuses a status filter that is not one of the three", async () => {
      signIn(actor("head"))
      const response = await listQueue(getRequest("/api/v1/join-requests?status=deleted"))
      expect(response.status).toBe(400)
    })

    it("bounds the page however large a limit is asked for", async () => {
      signIn(actor("head"))
      const response = await listQueue(getRequest("/api/v1/join-requests?limit=100000"))
      expect(response.status).toBe(200)
      expect((await body(response)).items.length).toBeLessThanOrEqual(200)
    })
  })

  /* ── Deciding ─────────────────────────────────────────────────────────── */

  describe("deciding a request", () => {
    it("is refused unauthenticated, and to every role but head office", async () => {
      const stored = await submitAccepted(submission())

      signIn(null)
      expect((await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "approve" }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      )).status).toBe(401)

      for (const kind of ["branchAdmin", "orderPortal"] as const) {
        signIn(actor(kind))
        expect((await decide(
          jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "approve" }),
          { params: Promise.resolve({ id: String(stored.id) }) },
        )).status).toBe(403)
      }

      // Still pending, and still no account.
      expect((await readStoredRequest(stored.id))?.status).toBe("pending")
    })

    it("is not found for a head office in another tenant", async () => {
      const stored = await submitAccepted(submission())

      signIn(actor("foreignHead"))
      const response = await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "approve" }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      )
      // 404, not 403 — the same answer as an id that does not exist, so the id
      // space cannot be walked.
      expect(response.status).toBe(404)
      expect((await readStoredRequest(stored.id))?.status).toBe("pending")
    })

    it("creates the account on approval, with the requested role and branch", async () => {
      const input = submission()
      const stored = await submitAccepted(input)

      signIn(actor("head"))
      const response = await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "approve" }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      )
      expect(response.status).toBe(200)
      const payload = await body(response)
      expect(payload.status).toBe("approved")
      createdUserIds.push(payload.createdUserId)

      const [account] = await db
        .select({
          id: users.id,
          email: users.email,
          username: users.username,
          passwordHash: users.passwordHash,
          organizationId: users.organizationId,
          branchId: users.branchId,
          isActive: users.isActive,
          mfaEnabled: users.mfaEnabled,
          mustChangePassword: users.mustChangePassword,
          budgetAllocationEnabled: users.budgetAllocationEnabled,
          roleName: roles.name,
        })
        .from(users)
        .leftJoin(roles, eq(roles.id, users.roleId))
        .where(eq(users.id, payload.createdUserId))
        .limit(1)

      expect(account.roleName).toBe("ORDER_PORTAL")
      expect(account.organizationId).toBe(fixtures.organizationId)
      expect(account.branchId).toBe(fixtures.northBranchId)
      expect(account.username).toBe(String(input.username).toLowerCase())
      expect(account.email).toBe(String(input.email).toLowerCase())
      // The hash chosen at submission is carried over untouched.
      expect(account.passwordHash).toBe(`hashed:${STRONG_PASSWORD}`)
      expect(account.isActive).toBe(true)
      expect(account.mfaEnabled).toBe(false)
      expect(account.budgetAllocationEnabled).toBe(false)
      // False on purpose: the person chose this password themselves.
      expect(account.mustChangePassword).toBe(false)

      const decided = await readStoredRequest(stored.id)
      expect(decided?.status).toBe("approved")
      expect(decided?.createdUserId).toBe(payload.createdUserId)
      expect(decided?.decidedByUserId).toBe(fixtures.headOfficeId)
      expect(decided?.decidedAt).not.toBeNull()
    })

    it("writes the group and branch assignments for a group role", async () => {
      const input = submission({
        role: "GROUP_ORDER_PORTAL",
        branchId: null,
        groupIds: [fixtures.northGroupId],
        branchIds: [fixtures.northBranchId],
      })
      const stored = await submitAccepted(input)

      signIn(actor("head"))
      const payload = await body(await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "approve" }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      ))
      createdUserIds.push(payload.createdUserId)

      const [assignedGroups, assignedBranches] = await Promise.all([
        db.select({ groupId: userGroupAssignments.groupId, organizationId: userGroupAssignments.organizationId })
          .from(userGroupAssignments)
          .where(eq(userGroupAssignments.userId, payload.createdUserId)),
        db.select({ branchId: userBranchAssignments.branchId })
          .from(userBranchAssignments)
          .where(eq(userBranchAssignments.userId, payload.createdUserId)),
      ])
      expect(assignedGroups.map((row) => row.groupId)).toEqual([fixtures.northGroupId])
      expect(assignedGroups[0].organizationId).toBe(fixtures.organizationId)
      expect(assignedBranches.map((row) => row.branchId)).toEqual([fixtures.northBranchId])

      const [account] = await db
        .select({ branchId: users.branchId })
        .from(users)
        .where(eq(users.id, payload.createdUserId))
        .limit(1)
      expect(account.branchId).toBeNull()
    })

    it("lets head office change the role and assignment before approving", async () => {
      const stored = await submitAccepted(submission())

      signIn(actor("head"))
      const payload = await body(await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", {
          decision: "approve",
          role: "GROUP_USER",
          branchId: null,
          groupIds: [fixtures.northGroupId],
          branchIds: [],
          budgetAllocationEnabled: true,
        }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      ))
      createdUserIds.push(payload.createdUserId)

      const [account] = await db
        .select({
          branchId: users.branchId,
          budgetAllocationEnabled: users.budgetAllocationEnabled,
          roleName: roles.name,
        })
        .from(users)
        .leftJoin(roles, eq(roles.id, users.roleId))
        .where(eq(users.id, payload.createdUserId))
        .limit(1)

      expect(account.roleName).toBe("GROUP_USER")
      expect(account.branchId).toBeNull()
      // Granted here and only here — the applicant has no way to ask for it.
      expect(account.budgetAllocationEnabled).toBe(true)

      // What was granted is recorded on the request, not only what was asked.
      const decided = await readStoredRequest(stored.id)
      expect(decided?.requestedRole).toBe("GROUP_USER")
      expect(decided?.requestedGroupIds).toEqual([fixtures.northGroupId])
    })

    it("refuses an override that names another tenant's branch", async () => {
      const stored = await submitAccepted(submission())

      signIn(actor("head"))
      const response = await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", {
          decision: "approve",
          role: "BRANCH_ADMIN",
          branchId: fixtures.foreignBranchId,
        }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      )
      expect(response.status).toBe(400)
      expect((await readStoredRequest(stored.id))?.status).toBe("pending")
    })

    it("refuses an override to an administrative role", async () => {
      const stored = await submitAccepted(submission())

      signIn(actor("head"))
      for (const role of ["HEAD_OFFICE", "SUPER_ADMIN"]) {
        const response = await decide(
          jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "approve", role }),
          { params: Promise.resolve({ id: String(stored.id) }) },
        )
        expect(response.status).toBe(400)
      }
      expect((await readStoredRequest(stored.id))?.status).toBe("pending")
    })

    it("refuses a role override that leaves the assignment unusable", async () => {
      // ORDER_PORTAL -> GROUP_USER without a group or branch: the stored branch
      // cannot follow the new shape, so it is refused rather than half-applied.
      const stored = await submitAccepted(submission())

      signIn(actor("head"))
      const response = await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", {
          decision: "approve",
          role: "GROUP_USER",
        }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      )
      expect(response.status).toBe(400)
      expect((await body(response)).error).toMatch(/at least one group or one branch/i)
    })

    it("refuses assignment fields on a rejection", async () => {
      const stored = await submitAccepted(submission())

      signIn(actor("head"))
      const response = await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", {
          decision: "reject",
          role: "GROUP_USER",
        }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      )
      expect(response.status).toBe(400)
      expect((await readStoredRequest(stored.id))?.status).toBe("pending")
    })

    it("creates nothing on rejection, and keeps the reason out of the applicant's mail", async () => {
      const input = submission()
      const stored = await submitAccepted(input)

      signIn(actor("head"))
      const response = await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", {
          decision: "reject",
          reason: "Not a current employee",
        }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      )
      expect(response.status).toBe(200)
      expect((await body(response)).createdUserId).toBeNull()

      const decided = await readStoredRequest(stored.id)
      expect(decided?.status).toBe("rejected")
      expect(decided?.decisionReason).toBe("Not a current employee")
      expect(decided?.createdUserId).toBeNull()

      const [account] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, String(input.username).toLowerCase()))
        .limit(1)
      expect(account).toBeUndefined()

      // The reason is in the trail, not in the mail.
      expect(mocks.sendJoinDecisionEmail).toHaveBeenCalledTimes(1)
      const [mail] = mocks.sendJoinDecisionEmail.mock.calls[0] as any[]
      expect(mail.approved).toBe(false)
      expect(JSON.stringify(mail)).not.toContain("Not a current employee")
    })

    it("answers a second decision with 409 and creates no second account", async () => {
      const stored = await submitAccepted(submission())

      signIn(actor("head"))
      const first = await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "approve" }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      )
      expect(first.status).toBe(200)
      const createdUserId = (await body(first)).createdUserId
      createdUserIds.push(createdUserId)

      for (const decision of ["approve", "reject"]) {
        const replay = await decide(
          jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision }),
          { params: Promise.resolve({ id: String(stored.id) }) },
        )
        expect(replay.status).toBe(409)
      }

      const accounts = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, stored.email))
      expect(accounts.map((row) => row.id)).toEqual([createdUserId])
    })

    it("refuses an approval whose identity was taken while the request waited", async () => {
      const input = submission()
      const stored = await submitAccepted(input)

      // An administrator creates the same username directly in the meantime.
      const [roleRow] = await db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.name, "ORDER_PORTAL"))
        .limit(1)
      const [collision] = await db
        .insert(users)
        .values({
          email: `collision-${fixtures.suffix}-${stored.id}@example.test`,
          username: String(input.username).toLowerCase(),
          passwordHash: "not-a-real-hash",
          roleId: roleRow.id,
          organizationId: fixtures.organizationId,
          branchId: fixtures.northBranchId,
          firstName: "Collision",
          lastName: "Case",
          fullName: "Collision Case",
        })
        .returning({ id: users.id })
      createdUserIds.push(collision.id)

      signIn(actor("head"))
      const response = await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "approve" }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      )
      expect(response.status).toBe(409)
      // Named here, because the caller is this tenant's own administrator rather
      // than an anonymous applicant.
      expect((await body(response)).error).toMatch(/username/i)
      expect((await readStoredRequest(stored.id))?.status).toBe("pending")
    })

    it("audits every decision against the deciding head office", async () => {
      const stored = await submitAccepted(submission())

      signIn(actor("head"))
      const payload = await body(await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "approve" }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      ))
      createdUserIds.push(payload.createdUserId)

      const rows = await db
        .select({
          action: auditLogs.action,
          userId: auditLogs.userId,
          entityId: auditLogs.entityId,
          metadata: auditLogs.metadata,
        })
        .from(auditLogs)
        .where(and(
          eq(auditLogs.organizationId, fixtures.organizationId),
          eq(auditLogs.action, "APPROVE_ORGANIZATION_JOIN_REQUEST"),
          eq(auditLogs.entityId, String(stored.id)),
        ))
      expect(rows).toHaveLength(1)
      expect(rows[0].userId).toBe(fixtures.headOfficeId)
      expect((rows[0].metadata as any).createdUserId).toBe(payload.createdUserId)
      expect((rows[0].metadata as any).grantedRole).toBe("ORDER_PORTAL")
      // The hash never reaches the trail.
      expect(JSON.stringify(rows[0].metadata)).not.toContain("hashed:")
    })

    it("refuses an id that is not a positive integer", async () => {
      signIn(actor("head"))
      // "1.5" and "1abc" matter most: parsed loosely they become 1, and the
      // endpoint would decide a different row than the caller named.
      for (const id of ["0", "-1", "abc", "1.5", "1abc", "01e3", " 1", ""]) {
        const response = await decide(
          jsonRequest(`/api/v1/join-requests/${id}`, "PATCH", { decision: "approve" }),
          { params: Promise.resolve({ id }) },
        )
        expect(response.status).toBe(400)
      }
    })

    it("refuses a decision that is neither approve nor reject", async () => {
      const stored = await submitAccepted(submission())

      signIn(actor("head"))
      const response = await decide(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "delete" }),
        { params: Promise.resolve({ id: String(stored.id) }) },
      )
      expect(response.status).toBe(400)
      expect((await readStoredRequest(stored.id))?.status).toBe("pending")
    })
  })

  /* ── The whole way round ──────────────────────────────────────────────── */

  it("lets an approved applicant's account exist exactly once, from code to sign-in", async () => {
    // The journey the feature exists for, asserted as one sequence so a future
    // change cannot break the join between the steps while each step still
    // passes on its own.
    const options = await body(await lookup(jsonRequest("/api/v1/join/lookup", "POST", { code })))
    expect(options.organizationName).toBe(fixtures.organizationName)

    const chosenBranch = options.branches.find((branch: any) => branch.id === fixtures.northBranchId)
    expect(chosenBranch).toBeDefined()

    const input = submission({ role: "BRANCH_ADMIN", branchId: chosenBranch.id })
    const stored = await submitAccepted(input)

    signIn(actor("head"))
    const queue = await body(await listQueue(getRequest("/api/v1/join-requests?status=pending")))
    expect(queue.items.some((item: any) => item.id === stored.id)).toBe(true)
    expect(queue.pendingCount).toBeGreaterThan(0)

    const payload = await body(await decide(
      jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "approve" }),
      { params: Promise.resolve({ id: String(stored.id) }) },
    ))
    createdUserIds.push(payload.createdUserId)

    const accounts = await db
      .select({ id: users.id, roleName: roles.name, branchId: users.branchId })
      .from(users)
      .leftJoin(roles, eq(roles.id, users.roleId))
      .where(inArray(users.username, [String(input.username).toLowerCase()]))
    expect(accounts).toHaveLength(1)
    expect(accounts[0].roleName).toBe("BRANCH_ADMIN")
    expect(accounts[0].branchId).toBe(fixtures.northBranchId)

    expect(mocks.sendJoinDecisionEmail).toHaveBeenCalledWith(
      expect.objectContaining({ approved: true, username: String(input.username).toLowerCase() }),
    )
  })
})
