import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray, notInArray, sql } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as decideRoute from "@/app/api/v1/join-requests/[id]/route"
import * as lookupRoute from "@/app/api/v1/join/lookup/route"
import * as submitRoute from "@/app/api/v1/join/requests/route"
import { submitWithJoinEmailProof } from "./helpers/join-email-proof"
import * as joinCodeRoute from "@/app/api/v1/organizations/join-code/route"
import {
  auditLogs,
  branchDeliveryAddresses,
  branches,
  organizationApprovalLevels,
  organizationJoinRequestBranches,
  organizationJoinRequests,
  orders,
  organizations,
  roles,
  sessions,
  systemLogs,
  userBranchAssignments,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { DEPARTMENT_JOIN_IDENTITY_CONFLICT_MESSAGE } from "@/lib/organization-join"
import { organizationUsername } from "@/lib/username-prefix"

import {
  createJoinFixtures,
  destroyJoinFixtures,
  findRequestByEmail,
  hasTestDatabase,
  resolveRoleId,
  type JoinFixtures,
} from "./helpers/organization-join-fixtures"

/**
 * The department sign-up's edges (plans/OF-JOIN-department-signup-multi-user.md):
 * what `organization-join-department.test.ts` does not reach — an approval that
 * fails part-way and must leave nothing behind, two decisions at once, a
 * username already held or taken in between, CRCs that are ambiguous or retired, bodies meant
 * for the other form version, and Head Office's edit at its limits.
 */

const TEMPORARY_PASSWORD = "Temp-Pass-2026!x"
const STRONG_PASSWORD = "Join-Flow-2026!x"
/** Where every new branch submitted here says it is (plans/OF-JOIN-applicant-new-branch-city.md). */
const KARACHI = { city: "Karachi", province: "Sindh" }

const mocks = vi.hoisted(() => ({
  hashPassword: vi.fn(async (plain: string) => `hashed:${plain}`),
  generateRandomPassword: vi.fn(() => "Temp-Pass-2026!x"),
  sendJoinDecisionEmail: vi.fn(async () => true),
  sendJoinApproverNoticeEmail: vi.fn(async () => true),
  sendWelcomeEmail: vi.fn(async () => true),
  withRateLimit: vi.fn(async () => null),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 10, resetIn: 60 })),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/password", () => ({
  hashPassword: mocks.hashPassword,
  generateRandomPassword: mocks.generateRandomPassword,
}))
vi.mock("@/lib/email/join-request", () => ({
  sendJoinDecisionEmail: mocks.sendJoinDecisionEmail,
  sendJoinApproverNoticeEmail: mocks.sendJoinApproverNoticeEmail,
}))
vi.mock("@/lib/email", () => ({ sendWelcomeEmail: mocks.sendWelcomeEmail }))
vi.mock("@/lib/rate-limiter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limiter")>()
  return {
    ...actual,
    withRateLimit: mocks.withRateLimit,
    checkRateLimit: mocks.checkRateLimit,
    getClientIdentifier: async () => "ip:127.0.0.1",
  }
})

const { getServerSession } = mockedNextAuth

type Actor = { id: string; role: string; organizationId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, email: "actor@example.test", mustChangePassword: false } } as any),
  )
}

function jsonRequest(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!hasTestDatabase)("the department sign-up, at its edges", () => {
  let fixtures: JoinFixtures
  let code = ""
  let foreignCode = ""
  let levelOneUserId = ""
  let sharedCrc = ""
  let retiredCrc = ""

  const head = (): Actor => ({ id: fixtures.headOfficeId, role: "HEAD_OFFICE", organizationId: fixtures.organizationId })
  const foreignHead = (): Actor => ({ id: fixtures.foreignHeadOfficeId, role: "HEAD_OFFICE", organizationId: fixtures.foreignOrganizationId })
  const unique = () => Math.random().toString(36).slice(2, 8)
  const phone = () => `030${Math.floor(10_000_000 + Math.random() * 89_999_999)}`

  const signup = (overrides: Record<string, unknown> = {}) => {
    const tag = unique()
    return {
      formVersion: 2,
      code,
      fullName: "Edge Case",
      email: `edge-${fixtures.suffix}-${tag}@example.test`,
      password: STRONG_PASSWORD,
      phone: phone(),
      ipExtension: "1234",
      employeeId: `EC-${fixtures.suffix}-${tag}`,
      department: "Operations",
      branches: [{ branchId: fixtures.northBranchId }],
      addresses: ["Plot 1, Clifton, Karachi"],
      approvers: [
        { level: 1, email: `edge-one-${fixtures.suffix}@example.test`, designation: "Head of Finance" },
        { level: 2, email: `edge-two-${fixtures.suffix}-${tag}@example.test`, designation: "Manager" },
      ],
      termsAccepted: true,
      ...overrides,
    }
  }

  async function submit(body: Record<string, unknown>) {
    signIn(null)
    return submitWithJoinEmailProof(submitRoute.POST)(jsonRequest("/api/v1/join/requests", "POST", body))
  }

  async function submitAccepted(body: Record<string, unknown>) {
    const response = await submit(body)
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201)
    return (await findRequestByEmail(String(body.email).toLowerCase()))!
  }

  async function review(requestId: number, actor: Actor = head()) {
    signIn(actor)
    const response = await decideRoute.GET(jsonRequest(`/api/v1/join-requests/${requestId}`, "GET"), params(requestId))
    return { status: response.status, item: response.status === 200 ? (await response.json()).item : null }
  }

  async function patch(requestId: number | string, body: unknown, actor: Actor | null = head()) {
    signIn(actor)
    return decideRoute.PATCH(jsonRequest(`/api/v1/join-requests/${requestId}`, "PATCH", body), params(requestId))
  }

  const expectedFrom = (item: any) => item.approvers.map((approver: any) => ({
    level: approver.level,
    kind: approver.resolution.kind,
    userId: approver.resolution.userId ?? null,
  }))

  const editFrom = (item: any) => ({
    firstName: item.person.firstName,
    lastName: item.person.lastName,
    email: item.person.email,
    username: item.person.username,
    phone: item.person.phone,
    ipExtension: item.person.ipExtension,
    employeeId: item.person.employeeId,
    department: item.person.department,
    branches: item.branches.map((row: any) => (row.kind === "existing" ? { branchId: row.branchId } : { crc: row.costCenterId })),
    addresses: item.addresses.map((row: any) => row.address),
    approvers: item.approvers.map((approver: any) => ({ level: approver.level, email: approver.email, designation: approver.designation })),
  })

  const accountsAt = (email: string) => db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`)

  async function requestRow(id: number) {
    const [row] = await db.select().from(organizationJoinRequests).where(eq(organizationJoinRequests.id, id))
    return row
  }

  async function newBranch(values: { name: string; status?: string; costCenterId?: string }) {
    const [row] = await db.insert(branches).values({
      organizationId: fixtures.organizationId,
      name: values.name,
      status: values.status ?? "active",
      costCenterId: values.costCenterId ?? null,
    }).returning({ id: branches.id })
    return row.id
  }

  beforeAll(async () => {
    fixtures = await createJoinFixtures()
    await db.update(organizations).set({
      orderApprovalRequired: true,
      orderApprovalLevelsEnabled: true,
      orderApproverRole: "BRANCH_ADMIN",
    }).where(eq(organizations.id, fixtures.organizationId))
    await db.insert(organizationApprovalLevels).values([
      { organizationId: fixtures.organizationId, level: 1, maxAmountCents: 8_000_000 },
      { organizationId: fixtures.organizationId, level: 2, maxAmountCents: 4_000_000 },
    ])

    const [levelOne] = await db.insert(users).values({
      email: `edge-one-${fixtures.suffix}@example.test`,
      username: `it-edge-one-${fixtures.suffix}`,
      passwordHash: "x",
      roleId: await resolveRoleId("GROUP_USER"),
      organizationId: fixtures.organizationId,
      firstName: "Edge",
      lastName: "One",
    }).returning({ id: users.id })
    levelOneUserId = levelOne.id

    // A CRC two active branches share is ambiguous; one only a retired branch carries is free.
    sharedCrc = `IT-SHARED-${fixtures.suffix}`.toUpperCase()
    retiredCrc = `IT-RETIRED-${fixtures.suffix}`.toUpperCase()
    await newBranch({ name: `Shared A ${fixtures.suffix}`, costCenterId: sharedCrc })
    await newBranch({ name: `Shared B ${fixtures.suffix}`, costCenterId: sharedCrc })
    await newBranch({ name: `Retired CRC ${fixtures.suffix}`, status: "inactive", costCenterId: retiredCrc })

    signIn(head())
    code = (await (await joinCodeRoute.PUT(jsonRequest("/api/v1/organizations/join-code", "PUT", {
      code: `JOIN-${fixtures.suffix}`,
    }))).json()).code
    signIn(foreignHead())
    foreignCode = (await (await joinCodeRoute.PUT(jsonRequest("/api/v1/organizations/join-code", "PUT", {
      code: `FOREIGN-${fixtures.suffix}`,
    }))).json()).code
  })

  afterAll(async () => {
    if (fixtures) {
      const orgs = [fixtures.organizationId, fixtures.foreignOrganizationId]
      await db.delete(orders).where(inArray(orders.organizationId, orgs))
      await db.delete(sessions).where(inArray(sessions.organizationId, orgs))
      await db.delete(organizationJoinRequests).where(inArray(organizationJoinRequests.organizationId, orgs))
      await db.delete(branchDeliveryAddresses).where(inArray(branchDeliveryAddresses.organizationId, orgs))
      await db.delete(userBranchAssignments).where(inArray(userBranchAssignments.organizationId, orgs))
      await db.update(users).set({ branchId: null }).where(inArray(users.organizationId, orgs))
      await db.delete(systemLogs).where(inArray(systemLogs.organizationId, orgs))
      await db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgs))
      const fixturePeople = [
        fixtures.headOfficeId,
        fixtures.foreignHeadOfficeId,
        fixtures.suspendedHeadOfficeId,
        fixtures.branchAdminId,
        fixtures.orderPortalId,
      ]
      await db.delete(users).where(and(inArray(users.organizationId, orgs), notInArray(users.id, fixturePeople)))
      await db.delete(branches).where(and(
        inArray(branches.organizationId, orgs),
        notInArray(branches.id, [fixtures.northBranchId, fixtures.retiredBranchId, fixtures.foreignBranchId]),
      ))
      await destroyJoinFixtures(fixtures)
    }
    await closePool()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 10, resetIn: 60 })
    mocks.generateRandomPassword.mockReturnValue(TEMPORARY_PASSWORD)
    signIn(null)
  })

  /* ── Submitting ────────────────────────────────────────────────────────── */

  describe("submitting", () => {
    it("keeps a CRC two active branches share as a CRC, for Head Office to map", async () => {
      const stored = await submitAccepted(signup({ branches: [{ crc: sharedCrc.toLowerCase(), name: "New Depot", ...KARACHI }] }))
      const rows = await db.select().from(organizationJoinRequestBranches).where(eq(organizationJoinRequestBranches.requestId, stored.id))
      expect(rows).toEqual([expect.objectContaining({ existingBranchId: null, costCenterId: sharedCrc })])
    })

    it("treats a CRC that only a retired branch carries as a new one", async () => {
      const stored = await submitAccepted(signup({ branches: [{ crc: retiredCrc, name: "New Depot", ...KARACHI }] }))
      const rows = await db.select().from(organizationJoinRequestBranches).where(eq(organizationJoinRequestBranches.requestId, stored.id))
      expect(rows).toEqual([expect.objectContaining({ existingBranchId: null, costCenterId: retiredCrc })])
    })

    it("stores a branch picked twice, or a CRC typed twice in different case, once", async () => {
      const crc = `IT-TWICE-${unique()}`.toUpperCase()
      const stored = await submitAccepted(signup({
        branches: [{ branchId: fixtures.northBranchId }, { branchId: fixtures.northBranchId }, { crc, name: "New Depot", ...KARACHI }, { crc: ` ${crc.toLowerCase()} `, name: "New Depot", ...KARACHI }],
      }))
      const rows = await db.select().from(organizationJoinRequestBranches).where(eq(organizationJoinRequestBranches.requestId, stored.id))
      expect(rows).toHaveLength(2)
      expect(stored.requestedRole).toBe("GROUP_ORDER_PORTAL")
    })

    it("refuses a retired branch picked by id", async () => {
      expect((await submit(signup({ branches: [{ branchId: fixtures.retiredBranchId }] }))).status).toBe(400)
    })

    it.each([
      ["eleven branches", { branches: Array.from({ length: 11 }, (_, index) => ({ crc: `IT-MANY-${index}`, name: "New Depot", ...KARACHI })) }],
      ["six addresses", { addresses: Array.from({ length: 6 }, (_, index) => `Plot ${index + 10}, Clifton`) }],
      ["no address", { addresses: [] }],
      ["no branch", { branches: [] }],
      ["a new branch named only by its CRC", { branches: [{ crc: "IT-NO-NAME", ...KARACHI }] }],
      ["a new branch with a one-letter name", { branches: [{ crc: "IT-SHORT-NAME", name: "K", ...KARACHI }] }],
      ["a new branch with no city", { branches: [{ crc: "IT-NO-CITY", name: "New Depot" }] }],
      ["a new branch in a city not on the list", { branches: [{ crc: "IT-ODD-CITY", name: "New Depot", city: "Atlantis", province: "Sindh" }] }],
      ["a new branch under another city's province", { branches: [{ crc: "IT-ODD-PROV", name: "New Depot", city: "Karachi", province: "Punjab" }] }],
      ["an unknown department", { department: "Treasury" }],
      ["an IP extension of two digits", { ipExtension: "12" }],
      ["a password below the policy", { password: "short" }],
      ["a form version of 3", { formVersion: 3 }],
    ])("refuses %s, storing nothing", async (_case, overrides) => {
      const body = signup(overrides)
      expect((await submit(body)).status).toBe(400)
      expect(await findRequestByEmail(String(body.email))).toBeNull()
    })

    it("answers a public caller the same whether an approver already has an account or not", async () => {
      const known = await submit(signup())
      const unknown = await submit(signup({
        approvers: [
          { level: 1, email: `nobody-${unique()}@example.test`, designation: "Head" },
          { level: 2, email: `nobody-${unique()}@example.test`, designation: "Manager" },
        ],
      }))
      expect(known.status).toBe(201)
      expect(unknown.status).toBe(201)
      expect(await known.json()).toEqual(await unknown.json())
    })

    it("refuses, with the same answer, an email an account holds and one another pending request holds", async () => {
      const first = signup()
      await submitAccepted(first)
      const pendingClash = await submit(signup({ email: first.email }))
      const accountClash = await submit(signup({ email: `it-join-head-office-${fixtures.suffix}@example.test` }))
      expect(pendingClash.status).toBe(409)
      expect(accountClash.status).toBe(409)
      expect((await pendingClash.json()).error).toBe((await accountClash.json()).error)
    })

    it("answers a clash on the email, the mobile number or the employee number with one text that lists all three", async () => {
      const tag = unique()
      const heldPhone = phone()
      const heldEmployeeId = `EC-HELD-${fixtures.suffix}-${tag}`
      await db.insert(users).values({
        email: `holder-${fixtures.suffix}-${tag}@example.test`,
        username: `it-edge-holder-${fixtures.suffix}-${tag}`,
        passwordHash: "x",
        phone: heldPhone,
        employeeId: heldEmployeeId,
        roleId: await resolveRoleId("ORDER_PORTAL"),
        organizationId: fixtures.foreignOrganizationId,
      })

      const answers = await Promise.all([
        submit(signup({ email: `it-join-head-office-${fixtures.suffix}@example.test` })),
        submit(signup({ phone: heldPhone })),
        submit(signup({ employeeId: heldEmployeeId.toLowerCase() })),
      ])
      for (const response of answers) {
        expect(response.status).toBe(409)
        // The same text whatever clashed, so it cannot say whose phone or
        // employee number is on the platform — but it tells the applicant what
        // to check. The department form has no username field to point at.
        expect((await response.json()).error).toBe(DEPARTMENT_JOIN_IDENTITY_CONFLICT_MESSAGE)
      }
      expect(DEPARTMENT_JOIN_IDENTITY_CONFLICT_MESSAGE).toMatch(/email address, mobile number or employee number/)
      expect(DEPARTMENT_JOIN_IDENTITY_CONFLICT_MESSAGE).not.toMatch(/username/i)
    })

    it("is refused while the organization has no email domain, and the lookup offers no form", async () => {
      await db.update(organizations).set({ emailDomain: null }).where(eq(organizations.id, fixtures.organizationId))
      try {
        const body = signup()
        expect((await submit(body)).status).toBe(409)
        expect(await findRequestByEmail(String(body.email))).toBeNull()
        const lookup = await (await lookupRoute.POST(jsonRequest("/api/v1/join/lookup", "POST", { code }))).json()
        expect(lookup.emailDomain).toBeNull()
        expect(lookup).not.toHaveProperty("approvalLevels")
      } finally {
        await db.update(organizations).set({ emailDomain: "example.test" }).where(eq(organizations.id, fixtures.organizationId))
      }
    })
  })

  /* ── An approval that fails leaves nothing behind ─────────────────────── */

  const levelOneHolding = async () => {
    const [row] = await db.select({ level: users.orderApprovalLevel }).from(users).where(eq(users.id, levelOneUserId))
    return row.level
  }

  describe("an approval that fails part-way creates nothing", () => {
    // Other tests may already have given the shared Level 1 account its level;
    // what matters is that a failed approval does not change it.
    let levelBefore: number | null = null
    beforeEach(async () => {
      levelBefore = await levelOneHolding()
    })

    async function expectNothingCreated(stored: { id: number; email: string }, approverEmail: string, crc?: string) {
      expect(await accountsAt(stored.email)).toHaveLength(0)
      expect(await accountsAt(approverEmail)).toHaveLength(0)
      if (crc) expect(await db.select({ id: branches.id }).from(branches).where(eq(branches.costCenterId, crc))).toHaveLength(0)
      const row = await requestRow(stored.id)
      expect(row.status).toBe("pending")
      expect(row.createdUserId).toBeNull()
      const requestBranches = await db.select({ resolved: organizationJoinRequestBranches.resolvedBranchId })
        .from(organizationJoinRequestBranches).where(eq(organizationJoinRequestBranches.requestId, stored.id))
      expect(requestBranches.every((entry) => entry.resolved === null)).toBe(true)
      expect(await levelOneHolding()).toBe(levelBefore)
      expect(mocks.sendWelcomeEmail).not.toHaveBeenCalled()
      expect(mocks.sendJoinDecisionEmail).not.toHaveBeenCalled()
      expect(mocks.sendJoinApproverNoticeEmail).not.toHaveBeenCalled()
    }

    it("when the new branch's name is already taken — after the branch would have been created", async () => {
      const crc = `IT-DUP-${unique()}`.toUpperCase()
      const body = signup({ branches: [{ crc, name: "New Depot", ...KARACHI }] })
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      const response = await patch(stored.id, {
        decision: "approve",
        newBranches: [{ requestBranchId: item.branches[0].requestBranchId, name: fixtures.names.northBranch, province: "Sindh", city: "Karachi", address: "Plot 9, Clifton" }],
        expectedResolutions: expectedFrom(item),
      })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toMatch(/already exists/)
      await expectNothingCreated(stored, body.approvers[1].email, crc)
    })

    it("when an address is given no branch — after a new branch was created for it", async () => {
      const crc = `IT-ADDR-${unique()}`.toUpperCase()
      const body = signup({ branches: [{ branchId: fixtures.northBranchId }, { crc, name: "New Depot", ...KARACHI }] })
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      const fresh = item.branches.find((row: any) => row.kind === "new")
      const response = await patch(stored.id, {
        decision: "approve",
        newBranches: [{ requestBranchId: fresh.requestBranchId, name: `Addr ${crc}`, province: "Sindh", city: "Karachi", address: "Plot 9, Clifton" }],
        expectedResolutions: expectedFrom(item),
      })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(/Choose the branch for the address/)
      await expectNothingCreated(stored, body.approvers[1].email, crc)
    })

    it("when a CRC is mapped onto another organization's branch", async () => {
      const body = signup({ branches: [{ crc: `IT-MAP-${unique()}`, name: "New Depot", ...KARACHI }] })
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      const response = await patch(stored.id, {
        decision: "approve",
        newBranches: [{ requestBranchId: item.branches[0].requestBranchId, mapToBranchId: fixtures.foreignBranchId }],
        expectedResolutions: expectedFrom(item),
      })
      expect(response.status).toBe(400)
      await expectNothingCreated(stored, body.approvers[1].email)
    })

    it("when a CRC to create arrives with no details at all", async () => {
      const body = signup({ branches: [{ crc: `IT-BARE-${unique()}`, name: "New Depot", ...KARACHI }] })
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      const response = await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(/Give the details of the new branch for CRC/)
      await expectNothingCreated(stored, body.approvers[1].email)
    })

    it("when a requested branch was retired after the request was sent", async () => {
      const branchId = await newBranch({ name: `Soon retired ${unique()}` })
      const body = signup({ branches: [{ branchId }] })
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      await db.update(branches).set({ status: "inactive" }).where(eq(branches.id, branchId))
      const response = await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })
      expect(response.status).toBe(409)
      await expectNothingCreated(stored, body.approvers[1].email)
    })

    it("when the initiator's phone was registered to someone else in between", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      await db.insert(users).values({
        email: `phone-thief-${unique()}@example.test`,
        username: `it-edge-thief-${unique()}`,
        passwordHash: "x",
        roleId: await resolveRoleId("ORDER_PORTAL"),
        organizationId: fixtures.organizationId,
        phone: body.phone,
      })
      expect((await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })).status).toBe(409)
      await expectNothingCreated(stored, body.approvers[1].email)
    })
  })

  /* ── The initiator's username ─────────────────────────────────────────── */

  describe("a username another account holds", () => {
    async function takeUsername(username: string) {
      await db.insert(users).values({
        email: `taker-${unique()}@example.test`,
        username,
        passwordHash: "x",
        roleId: await resolveRoleId("ORDER_PORTAL"),
        organizationId: fixtures.foreignOrganizationId,
      })
    }

    /** The username this organization gives `typed`: its prefix in front (plans/OF-USERS-organization-username-prefix.md). */
    async function ownUsername(typed: string): Promise<string> {
      const [organization] = await db.select({ name: organizations.name }).from(organizations)
        .where(eq(organizations.id, fixtures.organizationId))
      return organizationUsername(organization.name, typed)
    }

    it("leaves the applicant free of another organization's account with the same unprefixed username", async () => {
      const body = signup()
      const local = String(body.email).split("@")[0].toLowerCase()
      await takeUsername(local)

      const stored = await submitAccepted(body)
      expect(stored.username).toBe(await ownUsername(local))
      expect(stored.username).not.toBe(local)
      const { item } = await review(stored.id)
      expect(item.person.usernameTaken).toBe(false)
      const approved = await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })
      expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(200)
      const [account] = await db.select({ username: users.username }).from(users).where(eq(users.email, body.email))
      expect(account.username).toBe(stored.username)
    })

    it("does not refuse the applicant when the username derived from their email is already held", async () => {
      // The applicant never typed a username and has no field to change, so
      // refusing here would leave them stuck. Head Office resolves it at review.
      const body = signup()
      await takeUsername(await ownUsername(String(body.email).split("@")[0]))

      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      expect(item.person.usernameTaken).toBe(true)
      const refused = await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })
      expect(refused.status).toBe(409)
      expect(await accountsAt(String(body.email))).toHaveLength(0)
    })

    it("is flagged at review when taken after the request was sent, refused without a replacement, and approved with one", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      await takeUsername(stored.username)

      const { item } = await review(stored.id)
      expect(item.person.usernameTaken).toBe(true)
      const refused = await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })
      expect(refused.status).toBe(409)
      expect((await refused.json()).error).toMatch(/has since been taken/)

      const replacement = `${stored.username}-2`
      const approved = await patch(stored.id, { decision: "approve", username: replacement.toUpperCase(), expectedResolutions: expectedFrom(item) })
      expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(200)
      const [account] = await db.select({ username: users.username }).from(users).where(eq(users.email, body.email))
      expect(account.username).toBe(replacement)
      expect((await requestRow(stored.id)).username).toBe(replacement)
    })

    it("refuses a replacement that is itself taken", async () => {
      const stored = await submitAccepted(signup())
      const replacement = `it-edge-taken-${unique()}`
      await takeUsername(stored.username)
      // Head Office types it bare; the approval would create it under the prefix.
      await takeUsername(await ownUsername(replacement))
      const { item } = await review(stored.id)
      const response = await patch(stored.id, { decision: "approve", username: replacement, expectedResolutions: expectedFrom(item) })
      expect(response.status).toBe(409)
      expect((await requestRow(stored.id)).status).toBe("pending")
    })
  })

  /* ── Two decisions at once ────────────────────────────────────────────── */

  describe("concurrency", () => {
    it("lets exactly one of two simultaneous approvals through, creating each account once", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      const decision = { decision: "approve", expectedResolutions: expectedFrom(item) }

      signIn(head())
      const responses = await Promise.all([1, 2].map(() => decideRoute.PATCH(
        jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", decision),
        params(stored.id),
      )))
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
      expect(await accountsAt(body.email)).toHaveLength(1)
      expect(await accountsAt(body.approvers[1].email)).toHaveLength(1)
      expect(mocks.sendWelcomeEmail).toHaveBeenCalledTimes(1)
    })

    it("lets an approval and a rejection race with one winner", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      signIn(head())
      const [approved, rejected] = await Promise.all([
        decideRoute.PATCH(jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "approve", expectedResolutions: expectedFrom(item) }), params(stored.id)),
        decideRoute.PATCH(jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "reject" }), params(stored.id)),
      ])
      expect([approved.status, rejected.status].sort()).toEqual([200, 409])
      const row = await requestRow(stored.id)
      expect(await accountsAt(body.email)).toHaveLength(row.status === "approved" ? 1 : 0)
    })

    it("serializes an edit and an approval: the account matches the request as it was decided", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      const editedPhone = phone()

      signIn(head())
      const [edited, approved] = await Promise.all([
        decideRoute.PATCH(jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { update: { ...editFrom(item), phone: editedPhone } }), params(stored.id)),
        decideRoute.PATCH(jsonRequest(`/api/v1/join-requests/${stored.id}`, "PATCH", { decision: "approve", expectedResolutions: expectedFrom(item) }), params(stored.id)),
      ])
      expect(approved.status).toBe(200)
      const row = await requestRow(stored.id)
      const [account] = await db.select({ phone: users.phone }).from(users).where(eq(users.email, body.email))
      expect(account.phone).toBe(row.phone)
      // Either the edit went first and the account carries it, or it came too late and was refused.
      expect(edited.status === 200 ? account.phone === editedPhone : edited.status === 409).toBe(true)
    })
  })

  /* ── The approvers' roles: one branch is a Branch Admin, more a Group User ── */

  describe("approver roles", () => {
    async function accountAt(email: string) {
      const [row] = await db
        .select({
          id: users.id,
          role: roles.name,
          branchId: users.branchId,
          level: users.orderApprovalLevel,
          sessionVersion: users.sessionVersion,
          mustChange: users.mustChangePassword,
        })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      return row
    }

    const assignedBranches = async (userId: string) =>
      (await db.select({ id: userBranchAssignments.branchId }).from(userBranchAssignments)
        .where(eq(userBranchAssignments.userId, userId))).map((row) => row.id).sort((a, b) => a - b)

    async function branchAdminAt(branchId: number, tag = unique()) {
      const email = `edge-ba-${tag}@example.test`
      const [row] = await db.insert(users).values({
        email,
        username: `it-edge-ba-${tag}`,
        passwordHash: "x",
        roleId: await resolveRoleId("BRANCH_ADMIN"),
        organizationId: fixtures.organizationId,
        branchId,
        firstName: "Branch",
        lastName: "Admin",
      }).returning({ id: users.id })
      return { id: row.id, email }
    }

    /** Submits, reviews, and approves with whatever details new CRCs need. */
    async function approveAsReviewed(stored: { id: number }, mapping: Record<number, number> = {}) {
      const { item } = await review(stored.id)
      const fresh = item.branches.filter((row: any) => row.kind === "new")
      const response = await patch(stored.id, {
        decision: "approve",
        newBranches: fresh.map((row: any) => (mapping[row.requestBranchId]
          ? { requestBranchId: row.requestBranchId, mapToBranchId: mapping[row.requestBranchId] }
          : { requestBranchId: row.requestBranchId, name: `Role ${row.costCenterId}`, province: "Sindh", city: "Karachi", address: "Plot 9, Clifton" })),
        addressBranches: item.addresses.map((row: any) => ({ requestAddressId: row.requestAddressId, requestBranchId: item.branches[0].requestBranchId })),
        expectedResolutions: expectedFrom(item),
      })
      return { item, response }
    }

    it("creates a new approver for one branch as a Branch Admin of that branch", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      const { item, response } = await approveAsReviewed(stored)
      expect(item.approvers[1].resolution).toEqual({ kind: "create", role: "BRANCH_ADMIN" })
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)

      const created = await accountAt(body.approvers[1].email)
      expect(created).toMatchObject({ role: "BRANCH_ADMIN", branchId: fixtures.northBranchId, level: 2, mustChange: true })
      expect(await assignedBranches(created.id)).toEqual([])
      expect(mocks.sendWelcomeEmail).toHaveBeenCalledWith(body.approvers[1].email, expect.any(String), expect.any(String), TEMPORARY_PASSWORD, expect.any(String))
    })

    it("creates a new approver for one CRC still to be created as a Branch Admin of the new branch", async () => {
      const crc = `IT-ROLE-${unique()}`.toUpperCase()
      const body = signup({ branches: [{ crc, name: "New Depot", ...KARACHI }] })
      const stored = await submitAccepted(body)
      const { response } = await approveAsReviewed(stored)
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
      const [created] = await db.select({ id: branches.id }).from(branches).where(eq(branches.costCenterId, crc))
      expect(await accountAt(body.approvers[1].email)).toMatchObject({ role: "BRANCH_ADMIN", branchId: created.id, level: 2 })
    })

    it("creates a new approver for several branches as a Group User assigned to all of them", async () => {
      const crc = `IT-ROLE-${unique()}`.toUpperCase()
      const body = signup({ branches: [{ branchId: fixtures.northBranchId }, { crc, name: "New Depot", ...KARACHI }] })
      const stored = await submitAccepted(body)
      const { item, response } = await approveAsReviewed(stored)
      expect(item.approvers[1].resolution).toEqual({ kind: "create", role: "GROUP_USER" })
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
      const [created] = await db.select({ id: branches.id }).from(branches).where(eq(branches.costCenterId, crc))
      const approver = await accountAt(body.approvers[1].email)
      expect(approver).toMatchObject({ role: "GROUP_USER", branchId: null, level: 2 })
      expect(await assignedBranches(approver.id)).toEqual([fixtures.northBranchId, created.id].sort((a, b) => a - b))
    })

    it("decides a new approver's role on the final branches when a CRC is mapped onto one already listed", async () => {
      const body = signup({ branches: [{ branchId: fixtures.northBranchId }, { crc: `IT-MAPPED-${unique()}`, name: "New Depot", ...KARACHI }] })
      const stored = await submitAccepted(body)
      const { item: before } = await review(stored.id)
      expect(before.approvers[1].resolution).toEqual({ kind: "create", role: "GROUP_USER" })
      const fresh = before.branches.find((row: any) => row.kind === "new")
      const { response } = await approveAsReviewed(stored, { [fresh.requestBranchId]: fixtures.northBranchId })
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
      // One branch after all: the initiator orders through the shop, and the approver is its Branch Admin.
      expect(await accountAt(body.email)).toMatchObject({ role: "ORDER_PORTAL", branchId: fixtures.northBranchId })
      expect(await accountAt(body.approvers[1].email)).toMatchObject({ role: "BRANCH_ADMIN", branchId: fixtures.northBranchId })
    })

    it("blocks a new one-branch approver where the approver role is Head Office, and creates nothing", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      await db.update(organizations).set({ orderApproverRole: "HEAD_OFFICE" }).where(eq(organizations.id, fixtures.organizationId))
      try {
        const { item } = await review(stored.id)
        expect(item.approvers[1].resolution.kind).toBe("blocked")
        expect(item.approvers[1].resolution.reason).toMatch(/created as a Financial Approver/)
        const response = await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })
        expect(response.status).toBe(409)
        expect(await accountsAt(body.email)).toHaveLength(0)
        expect(await accountsAt(body.approvers[1].email)).toHaveLength(0)
      } finally {
        await db.update(organizations).set({ orderApproverRole: "BRANCH_ADMIN" }).where(eq(organizations.id, fixtures.organizationId))
      }
    })

    it("converts an existing Branch Admin of another branch into a Group User, keeping its branch, and signs it out", async () => {
      const otherBranchId = await newBranch({ name: `Admin home ${unique()}` })
      const admin = await branchAdminAt(otherBranchId)
      const before = await accountAt(admin.email)
      await db.insert(sessions).values({
        userId: admin.id,
        organizationId: fixtures.organizationId,
        refreshTokenHash: `hash-${unique()}`,
        expiresAt: new Date(Date.now() + 3_600_000),
      })

      const body = signup({ approvers: [signup().approvers[0], { level: 2, email: admin.email, designation: "Manager" }] })
      const stored = await submitAccepted(body)
      const { item, response } = await approveAsReviewed(stored)
      expect(item.approvers[1].resolution).toEqual({ kind: "assign", userId: admin.id, addBranchIds: [fixtures.northBranchId], becomesGroupUser: true })
      expect(item.approvers[1].existingRole).toBe("BRANCH_ADMIN")
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)

      const after = await accountAt(admin.email)
      expect(after).toMatchObject({ role: "GROUP_USER", branchId: null, level: 2 })
      expect(after.sessionVersion).toBe(before.sessionVersion + 1)
      expect(await assignedBranches(admin.id)).toEqual([fixtures.northBranchId, otherBranchId].sort((a, b) => a - b))
      expect(await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, admin.id))).toHaveLength(0)

      const [log] = await db.select({ details: systemLogs.details }).from(systemLogs).where(and(
        eq(systemLogs.action, "USER_ACCESS_UPDATE"),
        eq(systemLogs.resourceId, admin.id),
      ))
      expect(log.details).toMatchObject({ previousRole: "BRANCH_ADMIN", nextRole: "GROUP_USER", previousBranchId: otherBranchId, source: "DEPARTMENT_JOIN_APPROVAL" })
      const [audit] = await db.select({ metadata: auditLogs.metadata }).from(auditLogs).where(and(
        eq(auditLogs.action, "APPROVE_ORGANIZATION_JOIN_REQUEST"),
        eq(auditLogs.entityId, String(stored.id)),
      ))
      expect((audit.metadata as any).approvers[1]).toMatchObject({ userId: admin.id, roleSet: "GROUP_USER", resolution: "assigned" })
      expect(mocks.sendJoinApproverNoticeEmail).toHaveBeenCalledWith(expect.objectContaining({ to: admin.email, becameGroupUser: true }))
    })

    it("converts a Branch Admin of the initiator's own branch when a new branch is added too", async () => {
      const admin = await branchAdminAt(fixtures.northBranchId)
      const crc = `IT-PLUS-${unique()}`.toUpperCase()
      const body = signup({
        branches: [{ branchId: fixtures.northBranchId }, { crc, name: "New Depot", ...KARACHI }],
        approvers: [signup().approvers[0], { level: 2, email: admin.email, designation: "Manager" }],
      })
      const stored = await submitAccepted(body)
      const { response } = await approveAsReviewed(stored)
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
      const [created] = await db.select({ id: branches.id }).from(branches).where(eq(branches.costCenterId, crc))
      expect(await accountAt(admin.email)).toMatchObject({ role: "GROUP_USER", branchId: null, level: 2 })
      expect(await assignedBranches(admin.id)).toEqual([fixtures.northBranchId, created.id].sort((a, b) => a - b))
    })

    it("leaves a Branch Admin of the only branch a Branch Admin, giving it the level", async () => {
      const admin = await branchAdminAt(fixtures.northBranchId)
      const before = await accountAt(admin.email)
      const body = signup({ approvers: [signup().approvers[0], { level: 2, email: admin.email, designation: "Manager" }] })
      const stored = await submitAccepted(body)
      const { item, response } = await approveAsReviewed(stored)
      expect(item.approvers[1].resolution).toEqual({ kind: "assign", userId: admin.id, addBranchIds: [], becomesGroupUser: false })
      expect(response.status).toBe(200)
      const after = await accountAt(admin.email)
      expect(after).toMatchObject({ role: "BRANCH_ADMIN", branchId: fixtures.northBranchId, level: 2 })
      expect(after.sessionVersion).toBe(before.sessionVersion)
      expect(mocks.sendJoinApproverNoticeEmail).toHaveBeenCalledWith(expect.objectContaining({ to: admin.email, becameGroupUser: false }))
    })

    it("refuses to convert a Branch Admin with orders of its own still in flight, and changes nothing", async () => {
      const otherBranchId = await newBranch({ name: `Busy admin ${unique()}` })
      const admin = await branchAdminAt(otherBranchId)
      await db.insert(orders).values({
        tid: `edge${unique()}${unique()}`.slice(0, 26),
        organizationId: fixtures.organizationId,
        branchId: otherBranchId,
        createdByUserId: admin.id,
        status: "PENDING",
      })
      const body = signup({ approvers: [signup().approvers[0], { level: 2, email: admin.email, designation: "Manager" }] })
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      expect(item.approvers[1].resolution.kind).toBe("blocked")
      expect(item.approvers[1].resolution.reason).toMatch(/still has orders they raised/)
      expect((await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })).status).toBe(409)
      expect(await accountAt(admin.email)).toMatchObject({ role: "BRANCH_ADMIN", branchId: otherBranchId, level: null })
      expect(await accountsAt(body.email)).toHaveLength(0)
    })

    it("refuses a Branch Admin that gained an order between the review and the approval", async () => {
      const otherBranchId = await newBranch({ name: `Late admin ${unique()}` })
      const admin = await branchAdminAt(otherBranchId)
      const body = signup({ approvers: [signup().approvers[0], { level: 2, email: admin.email, designation: "Manager" }] })
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      expect(item.approvers[1].resolution.becomesGroupUser).toBe(true)
      await db.insert(orders).values({
        tid: `late${unique()}${unique()}`.slice(0, 26),
        organizationId: fixtures.organizationId,
        branchId: otherBranchId,
        createdByUserId: admin.id,
        status: "APPROVED",
      })
      const response = await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })
      expect(response.status).toBe(409)
      expect(await accountAt(admin.email)).toMatchObject({ role: "BRANCH_ADMIN", branchId: otherBranchId })
    })

    it("never turns an existing Group User into a Branch Admin, even for one branch", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      const { response } = await approveAsReviewed(stored)
      expect(response.status).toBe(200)
      expect((await accountAt(`edge-one-${fixtures.suffix}@example.test`)).role).toBe("GROUP_USER")
    })

    it("never converts an Order Portal user named as an approver", async () => {
      const [orderPortal] = await db.select({ email: users.email }).from(users).where(eq(users.id, fixtures.orderPortalId))
      const body = signup({ approvers: [signup().approvers[0], { level: 2, email: orderPortal.email, designation: "Manager" }] })
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      expect(item.approvers[1].resolution.kind).toBe("blocked")
      expect((await accountAt(orderPortal.email)).role).toBe("ORDER_PORTAL")
    })
  })

  /* ── Bodies meant for the other form ──────────────────────────────────── */

  describe("the stored version decides which body a request takes", () => {
    let standardRequestId = 0

    beforeAll(async () => {
      const email = `standard-${fixtures.suffix}@example.test`
      signIn(null)
      const response = await submitWithJoinEmailProof(submitRoute.POST)(jsonRequest("/api/v1/join/requests", "POST", {
        code: foreignCode,
        firstName: "Standard",
        lastName: "Applicant",
        email,
        username: `it-edge-standard-${fixtures.suffix}`,
        password: STRONG_PASSWORD,
        role: "ORDER_PORTAL",
        branchId: fixtures.foreignBranchId,
      }))
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(201)
      standardRequestId = (await findRequestByEmail(email))!.id
    })

    it("refuses an edit or an approver replacement on a standard request", async () => {
      const before = await requestRow(standardRequestId)
      const edit = await patch(standardRequestId, { update: { firstName: "Changed" } }, foreignHead())
      const replace = await patch(standardRequestId, { replaceApprover: { level: 1, email: "a@example.test", designation: "Head" } }, foreignHead())
      expect(edit.status).toBe(400)
      expect(replace.status).toBe(400)
      const after = await requestRow(standardRequestId)
      expect(after.firstName).toBe(before.firstName)
      expect(after.status).toBe("pending")
    })

    it("does not serve a standard request through the department review", async () => {
      expect((await review(standardRequestId, foreignHead())).status).toBe(404)
    })

    it("refuses the standard form's role override on a department request", async () => {
      const stored = await submitAccepted(signup())
      const response = await patch(stored.id, { decision: "approve", role: "BRANCH_ADMIN", expectedResolutions: [] })
      expect(response.status).toBe(400)
      expect((await requestRow(stored.id)).status).toBe("pending")
    })

    it("refuses an update and a decision in the same body", async () => {
      const stored = await submitAccepted(signup())
      const { item } = await review(stored.id)
      const response = await patch(stored.id, { update: editFrom(item), decision: "approve" })
      expect(response.status).toBe(400)
      expect((await requestRow(stored.id)).status).toBe("pending")
    })
  })

  describe("the route's own gate", () => {
    it.each(["1abc", "1.5", "0", "-3"])("refuses the id %s", async (id) => {
      expect((await patch(id, { decision: "reject" })).status).toBe(400)
    })

    it("refuses an unauthenticated edit, and a malformed body", async () => {
      const stored = await submitAccepted(signup())
      expect((await patch(stored.id, { update: {} }, null)).status).toBe(401)
      signIn(head())
      const malformed = await decideRoute.PATCH(new NextRequest(`http://localhost/api/v1/join-requests/${stored.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }), params(stored.id))
      expect(malformed.status).toBe(400)
    })

    it.each(["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "SUPER_ADMIN"])("refuses %s an edit", async (role) => {
      const stored = await submitAccepted(signup())
      const { item } = await review(stored.id)
      const actor: Actor = role === "SUPER_ADMIN"
        ? { id: fixtures.headOfficeId, role, organizationId: null }
        : { id: fixtures.branchAdminId, role, organizationId: fixtures.organizationId }
      const response = await patch(stored.id, { update: { ...editFrom(item), firstName: "Intruder" } }, actor)
      expect([401, 403]).toContain(response.status)
      expect((await requestRow(stored.id)).firstName).toBe("Edge")
    })
  })

  /* ── Head Office's edit at its limits ─────────────────────────────────── */

  describe("editing", () => {
    // plans/OF-JOIN-crc-match-at-review.md: an edit no longer folds a typed CRC
    // into the branch carrying it; the review names the match instead.
    it("keeps every typed CRC as a CRC, and the review names the one exactly one branch carries", async () => {
      const ownCrc = `IT-OWN-${unique()}`.toUpperCase()
      const ownBranchId = await newBranch({ name: `Own CRC ${ownCrc}`, costCenterId: ownCrc })
      const stored = await submitAccepted(signup())
      const { item } = await review(stored.id)
      const response = await patch(stored.id, { update: { ...editFrom(item), branches: [{ crc: ownCrc.toLowerCase() }, { crc: sharedCrc }] } })
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)

      const rows = await db.select().from(organizationJoinRequestBranches).where(eq(organizationJoinRequestBranches.requestId, stored.id))
      expect(rows.map((row) => [row.existingBranchId, row.costCenterId]).sort()).toEqual([[null, sharedCrc], [null, ownCrc]].sort())
      const row = await requestRow(stored.id)
      expect(row.requestedRole).toBe("GROUP_ORDER_PORTAL")
      expect(row.requestedBranchId).toBeNull()
      expect(row.requestedBranchIds).toEqual([])

      const matches = Object.fromEntries((await review(stored.id)).item.branches.map((entry: any) => [entry.costCenterId, entry.crcMatch]))
      expect(matches).toEqual({ [ownCrc]: { branchId: ownBranchId, name: `Own CRC ${ownCrc}` }, [sharedCrc]: null })
    })

    // plans/OF-JOIN-applicant-new-branch-city.md
    it("keeps the applicant's city through an edit that does not send one, and moves it when one is sent", async () => {
      const crc = `IT-CITY-${unique()}`.toUpperCase()
      const stored = await submitAccepted(signup({ branches: [{ crc, name: "City Depot", ...KARACHI }] }))
      const { item } = await review(stored.id)
      const location = async () => {
        const [row] = await db.select().from(organizationJoinRequestBranches)
          .where(and(eq(organizationJoinRequestBranches.requestId, stored.id), eq(organizationJoinRequestBranches.costCenterId, crc)))
        return [row.id, row.requestedBranchCity, row.requestedBranchProvince]
      }
      const [rowId] = await location()

      expect((await patch(stored.id, { update: { ...editFrom(item), branches: [{ crc }] } })).status).toBe(200)
      expect(await location()).toEqual([rowId, "Karachi", "Sindh"])

      const moved = await patch(stored.id, { update: { ...editFrom(item), branches: [{ crc, city: "lahore", province: "Punjab" }] } })
      expect(moved.status, JSON.stringify(await moved.clone().json())).toBe(200)
      // The same row, so the review's choices still name it.
      expect(await location()).toEqual([rowId, "Lahore", "Punjab"])
      expect((await review(stored.id)).item.branches[0]).toMatchObject({ requestedCity: "Lahore", requestedProvince: "Punjab" })

      const refused = await patch(stored.id, { update: { ...editFrom(item), branches: [{ crc, city: "Lahore", province: "Sindh" }] } })
      expect(refused.status).toBe(400)
      expect(await location()).toEqual([rowId, "Lahore", "Punjab"])
    })

    it("lets the database refuse a location on an existing branch's row, or half a location", async () => {
      const stored = await submitAccepted(signup())
      const insert = (values: Partial<typeof organizationJoinRequestBranches.$inferInsert>) => db
        .insert(organizationJoinRequestBranches)
        .values({ requestId: stored.id, organizationId: fixtures.organizationId, ...values })
      const code = async (attempt: Promise<unknown>) => {
        try {
          await attempt
          return null
        } catch (caughtError: any) {
          return String(caughtError?.code ?? caughtError?.cause?.code)
        }
      }
      const otherBranchId = await newBranch({ name: `Located ${unique()}` })
      expect(await code(insert({ existingBranchId: otherBranchId, requestedBranchCity: "Karachi", requestedBranchProvince: "Sindh" })))
        .toBe("23514")
      expect(await code(insert({ costCenterId: `IT-HALF-${unique()}`.toUpperCase(), requestedBranchCity: "Karachi" }))).toBe("23514")
      expect(await code(insert({ costCenterId: `IT-BLANK-${unique()}`.toUpperCase(), requestedBranchCity: " ", requestedBranchProvince: "Sindh" })))
        .toBe("23514")
    })

    it("turns a several-branch request into a one-branch request and back", async () => {
      const stored = await submitAccepted(signup({ branches: [{ branchId: fixtures.northBranchId }, { crc: `IT-TWO-${unique()}`, name: "New Depot", ...KARACHI }] }))
      expect(stored.requestedRole).toBe("GROUP_ORDER_PORTAL")
      const { item } = await review(stored.id)

      expect((await patch(stored.id, { update: { ...editFrom(item), branches: [{ branchId: fixtures.northBranchId }] } })).status).toBe(200)
      let row = await requestRow(stored.id)
      expect([row.requestedRole, row.requestedBranchId]).toEqual(["ORDER_PORTAL", fixtures.northBranchId])

      // A single CRC still to be created is a one-branch request with no branch yet.
      expect((await patch(stored.id, { update: { ...editFrom(item), branches: [{ crc: `IT-ONE-${unique()}` }] } })).status).toBe(200)
      row = await requestRow(stored.id)
      expect([row.requestedRole, row.requestedBranchId]).toEqual(["ORDER_PORTAL", null])
    })

    it.each([
      ["a phone", "phone"],
      ["an employee ID", "employeeId"],
    ])("refuses %s an account holds, and changes nothing", async (_case, field) => {
      const taken = field === "phone" ? phone() : `EC-TAKEN-${unique()}`
      await db.insert(users).values({
        email: `holder-${unique()}@example.test`,
        username: `it-edge-holder-${unique()}`,
        passwordHash: "x",
        roleId: await resolveRoleId("ORDER_PORTAL"),
        organizationId: fixtures.foreignOrganizationId,
        [field]: taken,
      })
      const stored = await submitAccepted(signup())
      const { item } = await review(stored.id)
      expect((await patch(stored.id, { update: { ...editFrom(item), [field]: taken } })).status).toBe(409)
      expect((await requestRow(stored.id) as any)[field]).toBe((stored as any)[field])
    })

    it("does not refuse an unchanged field that has since been registered", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      await db.insert(users).values({
        email: `late-${unique()}@example.test`,
        username: `it-edge-late-${unique()}`,
        passwordHash: "x",
        roleId: await resolveRoleId("ORDER_PORTAL"),
        organizationId: fixtures.foreignOrganizationId,
        employeeId: body.employeeId,
      })
      const { item } = await review(stored.id)
      // Correcting the department is still possible; the clash is the approval's to refuse.
      expect((await patch(stored.id, { update: { ...editFrom(item), department: "IT" } })).status).toBe(200)
      expect((await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })).status).toBe(409)
    })

    it("is refused once the organization's email domain is cleared", async () => {
      const stored = await submitAccepted(signup())
      const { item } = await review(stored.id)
      await db.update(organizations).set({ emailDomain: null }).where(eq(organizations.id, fixtures.organizationId))
      try {
        expect((await patch(stored.id, { update: { ...editFrom(item), firstName: "Nope" } })).status).toBe(409)
      } finally {
        await db.update(organizations).set({ emailDomain: "example.test" }).where(eq(organizations.id, fixtures.organizationId))
      }
      expect((await requestRow(stored.id)).firstName).toBe("Edge")
    })

    it("makes an approval against the review from before the edit a 409, and the fresh review approves", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      const levelBefore = await levelOneHolding()
      const { item: before } = await review(stored.id)
      const replacement = `edge-replacement-${unique()}@example.test`
      const edit = editFrom(before)
      // Level 1 moves from the existing account to nobody yet (create).
      edit.approvers = [{ level: 1, email: replacement, designation: "Director" }, edit.approvers[1]]
      expect((await patch(stored.id, { update: edit })).status).toBe(200)

      const stale = await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(before) })
      expect(stale.status).toBe(409)
      expect(await accountsAt(body.email)).toHaveLength(0)

      const { item: after } = await review(stored.id)
      expect(after.approvers.map((approver: any) => approver.resolution.kind)).toEqual(["create", "create"])
      expect((await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(after) })).status).toBe(200)
      expect(await accountsAt(replacement)).toHaveLength(1)
      // The account the applicant first named is left as it was.
      expect(await levelOneHolding()).toBe(levelBefore)
    })

    it("shows an approver edited to another organization's account as blocked", async () => {
      const stored = await submitAccepted(signup())
      const { item } = await review(stored.id)
      const edit = editFrom(item)
      edit.approvers = [edit.approvers[0], { level: 2, email: `it-join-foreign-head-${fixtures.suffix}@example.test`, designation: "Manager" }]
      expect((await patch(stored.id, { update: edit })).status).toBe(200)
      const { item: after } = await review(stored.id)
      expect(after.approvers[1].resolution.kind).toBe("blocked")
      expect((await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(after) })).status).toBe(409)
    })

    // plans/OF-JOIN-email-otp-verification.md: the applicant proved the address
    // they typed, not one Head Office typed for them.
    it("keeps the email verification through other edits and clears it when the email changes", async () => {
      const stored = await submitAccepted(signup())
      expect((await requestRow(stored.id)).emailVerifiedAt).toBeInstanceOf(Date)

      const { item } = await review(stored.id)
      expect((await patch(stored.id, { update: { ...editFrom(item), department: "IT" } })).status).toBe(200)
      expect((await requestRow(stored.id)).emailVerifiedAt).toBeInstanceOf(Date)

      const { item: edited } = await review(stored.id)
      const corrected = `edge-corrected-${unique()}@example.test`
      expect((await patch(stored.id, { update: { ...editFrom(edited), email: corrected } })).status).toBe(200)
      const after = await requestRow(stored.id)
      expect(after.email).toBe(corrected)
      expect(after.emailVerifiedAt).toBeNull()
    })

    it("refuses edited approvers that skip or repeat a level", async () => {
      const stored = await submitAccepted(signup())
      const { item } = await review(stored.id)
      const edit = editFrom(item)
      const twoLevelOnes = { ...edit, approvers: [edit.approvers[0], { ...edit.approvers[1], level: 1 }] }
      const levelThree = { ...edit, approvers: [...edit.approvers, { level: 3, email: `three-${unique()}@example.test`, designation: "Clerk" }] }
      expect((await patch(stored.id, { update: twoLevelOnes })).status).toBe(400)
      expect((await patch(stored.id, { update: levelThree })).status).toBe(400)
    })
  })

  describe("a rejection", () => {
    it("tells the applicant, creates nothing, and records the reason", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      expect((await patch(stored.id, { decision: "reject", reason: "Not our department" })).status).toBe(200)
      expect(mocks.sendJoinDecisionEmail).toHaveBeenCalledWith(expect.objectContaining({ to: body.email, approved: false }))
      expect(mocks.sendWelcomeEmail).not.toHaveBeenCalled()
      expect(await accountsAt(body.email)).toHaveLength(0)
      const row = await requestRow(stored.id)
      expect([row.status, row.decisionReason]).toEqual(["rejected", "Not our department"])
      // A decided request takes no edit and no second decision.
      const { item } = await review(stored.id)
      expect((await patch(stored.id, { update: editFrom(item) })).status).toBe(409)
      expect((await patch(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })).status).toBe(409)
    })
  })

})
