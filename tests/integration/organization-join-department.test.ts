import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as decideRoute from "@/app/api/v1/join-requests/[id]/route"
import * as lookupRoute from "@/app/api/v1/join/lookup/route"
import * as submitRoute from "@/app/api/v1/join/requests/route"
import * as joinCodeRoute from "@/app/api/v1/organizations/join-code/route"
import {
  auditLogs,
  branchDeliveryAddresses,
  branches,
  organizationApprovalLevels,
  organizationJoinRequestApprovers,
  organizationJoinRequestBranches,
  organizationJoinRequests,
  organizations,
  roles,
  systemLogs,
  userBranchAssignments,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
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
 * The department sign-up, end to end (plans/OF-JOIN-department-signup-multi-user.md):
 * the join form of an organization with order approval levels on, and Head
 * Office's approval creating the initiator, branches, addresses and approvers
 * in one transaction.
 */

const TEMPORARY_PASSWORD = "Temp-Pass-2026!x"

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

const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })

const STRONG_PASSWORD = "Join-Flow-2026!x"

describe.skipIf(!hasTestDatabase)("the department sign-up, end to end", () => {
  let fixtures: JoinFixtures
  let code = ""
  let foreignCode = ""
  let groupUserId = ""
  let levelOneHolderId = ""
  let crcBranchId = 0

  const head = (): Actor => ({ id: fixtures.headOfficeId, role: "HEAD_OFFICE", organizationId: fixtures.organizationId })
  const foreignHead = (): Actor => ({ id: fixtures.foreignHeadOfficeId, role: "HEAD_OFFICE", organizationId: fixtures.foreignOrganizationId })
  const unique = () => Math.random().toString(36).slice(2, 8)

  /** A body that would succeed, so each test can spoil one field. */
  const signup = (overrides: Record<string, unknown> = {}) => {
    const tag = unique()
    return {
      formVersion: 2,
      code,
      fullName: "Huzaifa Abid",
      email: `initiator-${fixtures.suffix}-${tag}@example.test`,
      password: STRONG_PASSWORD,
      phone: `030${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      ipExtension: "1234",
      employeeId: `E-${fixtures.suffix}-${tag}`,
      department: "Finance",
      branches: [{ branchId: fixtures.northBranchId }],
      addresses: ["Plot 1, Clifton, Karachi"],
      approvers: [
        { level: 1, email: `level-one-${fixtures.suffix}@example.test`, designation: "Head of Finance" },
        { level: 2, email: `new-approver-${fixtures.suffix}-${tag}@example.test`, designation: "Manager" },
      ],
      termsAccepted: true,
      ...overrides,
    }
  }

  async function submitSignup(body: Record<string, unknown>) {
    return submitRoute.POST(jsonRequest("/api/v1/join/requests", "POST", body))
  }

  async function submitAccepted(body: Record<string, unknown>) {
    const response = await submitSignup(body)
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(201)
    const stored = await findRequestByEmail(String(body.email).toLowerCase())
    expect(stored).not.toBeNull()
    return stored!
  }

  async function review(requestId: number, actor: Actor = head()) {
    signIn(actor)
    const response = await decideRoute.GET(jsonRequest(`/api/v1/join-requests/${requestId}`, "GET"), params(requestId))
    return { status: response.status, item: response.status === 200 ? (await response.json()).item : null }
  }

  async function decide(requestId: number, body: Record<string, unknown>, actor: Actor = head()) {
    signIn(actor)
    return decideRoute.PATCH(jsonRequest(`/api/v1/join-requests/${requestId}`, "PATCH", body), params(requestId))
  }

  function expectedFrom(item: any) {
    return item.approvers.map((approver: any) => ({
      level: approver.level,
      kind: approver.resolution.kind,
      userId: approver.resolution.userId ?? null,
    }))
  }

  async function setLevels(enabled: boolean) {
    await db.update(organizations).set({ orderApprovalLevelsEnabled: enabled }).where(eq(organizations.id, fixtures.organizationId))
  }

  beforeAll(async () => {
    fixtures = await createJoinFixtures()

    // Tenant A takes the department sign-up: approval required, levels on,
    // Level 1 = 80,000 and above, Level 2 = everything below.
    await db.update(organizations).set({
      orderApprovalRequired: true,
      orderApprovalLevelsEnabled: true,
      orderApproverRole: "BRANCH_ADMIN",
    }).where(eq(organizations.id, fixtures.organizationId))
    await db.insert(organizationApprovalLevels).values([
      { organizationId: fixtures.organizationId, level: 1, maxAmountCents: 8_000_000 },
      { organizationId: fixtures.organizationId, level: 2, maxAmountCents: 4_000_000 },
    ])

    const groupUserRole = await resolveRoleId("GROUP_USER")
    const [groupUser, holder] = await db.insert(users).values([
      {
        email: `level-one-${fixtures.suffix}@example.test`,
        username: `it-dept-level-one-${fixtures.suffix}`,
        passwordHash: "x",
        roleId: groupUserRole,
        organizationId: fixtures.organizationId,
        firstName: "Level",
        lastName: "One",
      },
      {
        email: `holder-${fixtures.suffix}@example.test`,
        // Held under the organization's prefix, as an edit typing it bare would create it.
        username: organizationUsername(fixtures.organizationName, `it-dept-holder-${fixtures.suffix}`),
        passwordHash: "x",
        roleId: groupUserRole,
        organizationId: fixtures.organizationId,
        orderApprovalLevel: 1,
      },
    ]).returning({ id: users.id })
    groupUserId = groupUser.id
    levelOneHolderId = holder.id

    const [crcBranch] = await db.insert(branches).values({
      organizationId: fixtures.organizationId,
      name: `CRC Branch ${fixtures.suffix}`,
      status: "active",
      costCenterId: `IT-CRC-${fixtures.suffix}`.toUpperCase(),
    }).returning({ id: branches.id })
    crcBranchId = crcBranch.id

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
      // Requests first: their address rows reference the delivery addresses.
      await db.delete(organizationJoinRequests).where(inArray(organizationJoinRequests.organizationId, orgs))
      await db.delete(branchDeliveryAddresses).where(inArray(branchDeliveryAddresses.organizationId, orgs))
      await db.delete(userBranchAssignments).where(inArray(userBranchAssignments.organizationId, orgs))
      await db.update(users).set({ branchId: null }).where(inArray(users.organizationId, orgs))
      await db.delete(systemLogs).where(inArray(systemLogs.organizationId, orgs))
      await db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgs))
      // Everyone an approval created; the fixture's own people go with its groups.
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
    await setLevels(true)
  })

  describe("which form an organization takes", () => {
    it("answers the lookup with the department sign-up and its bands only where levels are on", async () => {
      const mine = await (await lookupRoute.POST(jsonRequest("/api/v1/join/lookup", "POST", { code }))).json()
      expect(mine.form).toBe("department")
      expect(mine.approvalLevels).toEqual([
        { level: 1, fromCents: 8_000_000, belowCents: null },
        { level: 2, fromCents: null, belowCents: 8_000_000 },
      ])

      const theirs = await (await lookupRoute.POST(jsonRequest("/api/v1/join/lookup", "POST", { code: foreignCode }))).json()
      expect(theirs.form).toBe("standard")
      expect(theirs).not.toHaveProperty("approvalLevels")
    })

    it("refuses the standard form for a levels-enabled organization", async () => {
      const response = await submitSignup({
        code,
        firstName: "Ada",
        lastName: "Lovelace",
        email: `std-${fixtures.suffix}@example.test`,
        username: `std-${fixtures.suffix}`,
        password: STRONG_PASSWORD,
        role: "ORDER_PORTAL",
        branchId: fixtures.northBranchId,
      })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(/uses the department sign-up/)
    })

    it("refuses the department sign-up for an organization without levels", async () => {
      const response = await submitSignup(signup({ code: foreignCode }))
      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(/does not use the department sign-up/)
    })

    it("refuses the department sign-up once levels are switched off, judged on this request", async () => {
      await setLevels(false)
      expect((await submitSignup(signup())).status).toBe(400)
    })
  })

  describe("validation", () => {
    it.each([
      ["a missing level", { approvers: [{ level: 1, email: `a-${unique()}@example.test`, designation: "Head" }] }, /each of the 2/],
      ["an approver at another domain", { approvers: [
        { level: 1, email: `a-${unique()}@example.test`, designation: "Head" },
        { level: 2, email: "someone@gmail.com", designation: "Manager" },
      ] }, /@example.test/],
      ["a username the applicant tries to choose", { username: "chosen" }, /Unknown field/],
      ["a role the applicant tries to choose", { role: "HEAD_OFFICE" }, /Unknown field/],
      ["an organization id", { organizationId: 1 }, /Unknown field/],
      ["terms not accepted", { termsAccepted: false }, /./],
      ["a malformed phone", { phone: "12345" }, /11-digit/],
    ])("refuses %s", async (_case, overrides, message) => {
      const response = await submitSignup(signup(overrides))
      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(message)
    })

    it("refuses a branch from another organization", async () => {
      const response = await submitSignup(signup({ branches: [{ branchId: fixtures.foreignBranchId }] }))
      expect(response.status).toBe(400)
    })
  })

  describe("approving a package", () => {
    it("creates the initiator, a new branch, the addresses, and each approver, in one go", async () => {
      const crc = `IT-NEW-${unique()}`.toUpperCase()
      const requestedName = `Signup Depot ${unique()}`
      const body = signup({
        branches: [{ branchId: fixtures.northBranchId }, { name: `  ${requestedName} `, crc: crc.toLowerCase() }],
        addresses: ["Plot 1, Clifton, Karachi", "Office 9, Saddar, Karachi"],
      })
      const stored = await submitAccepted(body)
      expect(stored.formVersion).toBe(2)
      expect(stored.requestedRole).toBe("GROUP_ORDER_PORTAL")

      const { item } = await review(stored.id)
      expect(item.initiatorRole).toBe("GROUP_ORDER_PORTAL")
      expect(item.approvers.map((approver: any) => approver.resolution.kind)).toEqual(["assign", "create"])
      const newBranch = item.branches.find((row: any) => row.kind === "new")
      const northRow = item.branches.find((row: any) => row.branchId === fixtures.northBranchId)
      // The branch is asked for by the applicant's name, with its CRC beside it.
      expect(newBranch).toMatchObject({ costCenterId: crc, requestedName, name: null })
      const [storedRow] = await db.select().from(organizationJoinRequestBranches)
        .where(eq(organizationJoinRequestBranches.id, newBranch.requestBranchId))
      expect(storedRow).toMatchObject({ costCenterId: crc, requestedBranchName: requestedName })

      const response = await decide(stored.id, {
        decision: "approve",
        newBranches: [{
          requestBranchId: newBranch.requestBranchId,
          name: newBranch.requestedName,
          province: "Sindh",
          city: "Karachi",
          address: "Plot 1, Clifton, Karachi",
        }],
        addressBranches: item.addresses.map((address: any, index: number) => ({
          requestAddressId: address.requestAddressId,
          requestBranchId: index === 0 ? northRow.requestBranchId : newBranch.requestBranchId,
        })),
        expectedResolutions: expectedFrom(item),
      })
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)

      const [createdBranch] = await db.select().from(branches).where(eq(branches.costCenterId, crc))
      expect(createdBranch.organizationId).toBe(fixtures.organizationId)
      // Named as the applicant named it, never after its CRC.
      expect(createdBranch.name).toBe(requestedName)

      const [initiator] = await db
        .select({ id: users.id, role: roles.name, branchId: users.branchId, mustChange: users.mustChangePassword, department: users.department, ipExtension: users.ipExtension })
        .from(users).innerJoin(roles, eq(users.roleId, roles.id))
        .where(eq(users.email, String(body.email)))
      expect(initiator).toMatchObject({ role: "GROUP_ORDER_PORTAL", branchId: null, mustChange: false, department: "Finance", ipExtension: "1234" })
      const initiatorBranches = await db.select({ id: userBranchAssignments.branchId }).from(userBranchAssignments)
        .where(eq(userBranchAssignments.userId, initiator.id))
      expect(initiatorBranches.map((row) => row.id).sort()).toEqual([fixtures.northBranchId, createdBranch.id].sort())

      // The existing Group User got Level 1 and both branches.
      const [levelOne] = await db.select({ level: users.orderApprovalLevel }).from(users).where(eq(users.id, groupUserId))
      expect(levelOne.level).toBe(1)
      const levelOneBranches = await db.select({ id: userBranchAssignments.branchId }).from(userBranchAssignments)
        .where(eq(userBranchAssignments.userId, groupUserId))
      expect(levelOneBranches.map((row) => row.id).sort()).toEqual([fixtures.northBranchId, createdBranch.id].sort())

      // The new approver: a Group User, Level 2, both branches, a rotated temporary password.
      const approverEmail = (body.approvers as any[])[1].email
      const [created] = await db
        .select({ id: users.id, role: roles.name, level: users.orderApprovalLevel, mustChange: users.mustChangePassword, hash: users.passwordHash, designation: users.designation })
        .from(users).innerJoin(roles, eq(users.roleId, roles.id))
        .where(eq(users.email, approverEmail))
      expect(created).toMatchObject({ role: "GROUP_USER", level: 2, mustChange: true, hash: `hashed:${TEMPORARY_PASSWORD}`, designation: "Manager" })
      expect(mocks.sendWelcomeEmail).toHaveBeenCalledWith(approverEmail, expect.any(String), expect.any(String), TEMPORARY_PASSWORD, expect.any(String))
      expect(mocks.sendJoinApproverNoticeEmail).toHaveBeenCalledTimes(1)
      expect(mocks.sendJoinDecisionEmail).toHaveBeenCalledTimes(1)

      const addresses = await db.select({ branchId: branchDeliveryAddresses.branchId, status: branchDeliveryAddresses.status })
        .from(branchDeliveryAddresses).where(eq(branchDeliveryAddresses.requestedByUserId, initiator.id))
      expect(addresses.map((row) => row.branchId).sort()).toEqual([fixtures.northBranchId, createdBranch.id].sort())
      expect(addresses.every((row) => row.status === "approved")).toBe(true)

      const recorded = await db.select({ level: organizationJoinRequestApprovers.level, resolution: organizationJoinRequestApprovers.resolution })
        .from(organizationJoinRequestApprovers).where(eq(organizationJoinRequestApprovers.requestId, stored.id))
      expect(recorded.sort((a, b) => a.level - b.level)).toEqual([{ level: 1, resolution: "assigned" }, { level: 2, resolution: "created" }])

      const levelAudits = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(
        eq(auditLogs.action, "ASSIGN_ORDER_APPROVAL_LEVEL"),
        inArray(auditLogs.entityId, [groupUserId, created.id]),
      ))
      expect(levelAudits).toHaveLength(2)

      // A replay is refused rather than creating anything twice.
      expect((await decide(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })).status).toBe(409)
    })

    // plans/OF-JOIN-crc-match-at-review.md: a typed CRC an existing branch
    // carries used to be stored as that branch, dropping the new branch the
    // applicant asked for. It is now kept, and the review names the match.
    it("keeps a typed CRC an existing branch carries as a new branch, and shows Head Office the match", async () => {
      const body = signup({ branches: [{ name: "Typed CRC Depot", crc: `it-crc-${fixtures.suffix}` }] })
      const stored = await submitAccepted(body)
      const rows = await db.select().from(organizationJoinRequestBranches).where(eq(organizationJoinRequestBranches.requestId, stored.id))
      expect(rows).toEqual([expect.objectContaining({
        existingBranchId: null,
        costCenterId: `IT-CRC-${fixtures.suffix}`.toUpperCase(),
        requestedBranchName: "Typed CRC Depot",
      })])
      expect(stored.requestedRole).toBe("ORDER_PORTAL")

      const { item } = await review(stored.id)
      expect(item.branches).toEqual([expect.objectContaining({
        kind: "new",
        branchId: null,
        requestedName: "Typed CRC Depot",
        crcMatch: { branchId: crcBranchId, name: `CRC Branch ${fixtures.suffix}` },
      })])

      // An approval that settles nothing for the CRC is refused, as for any CRC.
      const unsettled = await decide(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })
      expect(unsettled.status).toBe(400)

      const response = await decide(stored.id, {
        decision: "approve",
        newBranches: [{ requestBranchId: item.branches[0].requestBranchId, mapToBranchId: crcBranchId }],
        expectedResolutions: expectedFrom(item),
      })
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)

      const [initiator] = await db.select({ role: roles.name, branchId: users.branchId }).from(users)
        .innerJoin(roles, eq(users.roleId, roles.id)).where(eq(users.email, String(body.email)))
      expect(initiator).toEqual({ role: "ORDER_PORTAL", branchId: crcBranchId })
    })

    it("creates the branch the applicant named when Head Office chooses a new one over the matching branch", async () => {
      const crc = `IT-CRC-NEW-${unique()}`.toUpperCase()
      const [matching] = await db.insert(branches).values({
        organizationId: fixtures.organizationId,
        name: `Matching ${crc}`,
        status: "active",
        costCenterId: crc,
      }).returning({ id: branches.id })
      const body = signup({ branches: [{ name: `Orangi ${crc}`, crc }] })
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      expect(item.branches[0].crcMatch).toEqual({ branchId: matching.id, name: `Matching ${crc}` })

      const response = await decide(stored.id, {
        decision: "approve",
        newBranches: [{
          requestBranchId: item.branches[0].requestBranchId,
          name: item.branches[0].requestedName,
          province: "Sindh",
          city: "Karachi",
          address: "Plot 1, Orangi, Karachi",
        }],
        expectedResolutions: expectedFrom(item),
      })
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)

      const created = await db.select({ id: branches.id, name: branches.name }).from(branches)
        .where(and(eq(branches.costCenterId, crc), ne(branches.id, matching.id)))
      expect(created).toEqual([{ id: expect.any(Number), name: `Orangi ${crc}` }])
      const [initiator] = await db.select({ branchId: users.branchId }).from(users).where(eq(users.email, String(body.email)))
      expect(initiator.branchId).toBe(created[0].id)

      // Once decided, the review reports no match.
      expect((await review(stored.id)).item.branches[0].crcMatch).toBeNull()
    })

    it("refuses an approval when an approver changed since the review, and creates nothing", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      const reviewedKinds = expectedFrom(item)

      // The Level 2 email is now taken by someone else in the organization.
      const level2Email = (body.approvers as any[])[1].email
      await db.insert(users).values({
        email: level2Email,
        username: `it-dept-drift-${unique()}`,
        passwordHash: "x",
        roleId: await resolveRoleId("GROUP_USER"),
        organizationId: fixtures.organizationId,
      })

      const response = await decide(stored.id, { decision: "approve", expectedResolutions: reviewedKinds })
      expect(response.status).toBe(409)
      expect((await response.json()).error).toMatch(/changed since you reviewed/)
      expect(await db.select({ id: users.id }).from(users).where(eq(users.email, String(body.email)))).toHaveLength(0)
      const [after] = await db.select({ status: organizationJoinRequests.status }).from(organizationJoinRequests).where(eq(organizationJoinRequests.id, stored.id))
      expect(after.status).toBe("pending")
    })

    it("blocks an approver who holds another level or belongs to another tenant, until Head Office replaces them", async () => {
      const body = signup({
        approvers: [
          { level: 1, email: `holder-${fixtures.suffix}@example.test`, designation: "Head" },
          { level: 2, email: `it-join-foreign-head-${fixtures.suffix}@example.test`, designation: "Manager" },
        ],
      })
      const stored = await submitAccepted(body)
      const { item } = await review(stored.id)
      // The Level 1 holder does not reach the branch yet, so it would be extended.
      expect(item.approvers.map((approver: any) => approver.resolution.kind)).toEqual(["extend", "blocked"])
      expect(item.approvers[1].resolution.reason).toMatch(/outside your organization/)
      expect((await decide(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })).status).toBe(409)

      const replaced = await decide(stored.id, {
        replaceApprover: { level: 2, email: `replacement-${unique()}@example.test`, designation: "Manager" },
      })
      expect(replaced.status).toBe(200)
      const { item: after } = await review(stored.id)
      expect(after.approvers.map((approver: any) => approver.resolution.kind)).toEqual(["extend", "create"])
    })

    it("refuses a replacement approver at another domain", async () => {
      const stored = await submitAccepted(signup())
      const response = await decide(stored.id, { replaceApprover: { level: 2, email: "x@gmail.com", designation: "Manager" } })
      expect(response.status).toBe(400)
    })

    it("assigns no level when levels were switched off after the request was sent (D7)", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      await setLevels(false)
      const { item } = await review(stored.id)
      expect(item.approvalLevelsApply).toBe(false)
      expect(item.approvers.every((approver: any) => approver.resolution.kind === "not_applied")).toBe(true)

      const response = await decide(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
      expect(await db.select({ id: users.id }).from(users).where(eq(users.email, (body.approvers as any[])[1].email))).toHaveLength(0)
      expect(mocks.sendWelcomeEmail).not.toHaveBeenCalled()
    })

    it("rejects without creating anything", async () => {
      const body = signup()
      const stored = await submitAccepted(body)
      const response = await decide(stored.id, { decision: "reject", reason: "Not ours" })
      expect(response.status).toBe(200)
      expect(await db.select({ id: users.id }).from(users).where(eq(users.email, String(body.email)))).toHaveLength(0)
    })

    it("refuses to approve without the reviewed resolutions", async () => {
      const stored = await submitAccepted(signup())
      expect((await decide(stored.id, { decision: "approve" })).status).toBe(400)
    })
  })

  describe("Head Office editing a pending request before deciding it", () => {
    /** The request as the review shows it, as an edit body that changes nothing. */
    const unchangedEdit = (item: any) => ({
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

    it("edits every field, and the approval creates the corrected package with the applicant's own password", async () => {
      const stored = await submitAccepted(signup({ addresses: ["Plot 1, Clifton, Karachi", "Office 9, Saddar, Karachi"] }))
      const { item } = await review(stored.id)
      const keptBranchRow = item.branches[0].requestBranchId
      const keptAddressRow = item.addresses[0].requestAddressId

      const tag = unique()
      const crc = `IT-EDIT-${tag}`.toUpperCase()
      const edited = {
        firstName: "Sana",
        lastName: "Mir Khan",
        email: `edited-${fixtures.suffix}-${tag}@example.test`,
        username: `edited-${fixtures.suffix}-${tag}`,
        phone: `031${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
        ipExtension: "98765",
        employeeId: `EE-${fixtures.suffix}-${tag}`,
        department: "IT",
        branches: [{ branchId: fixtures.northBranchId }, { crc, name: "Edited Depot" }],
        addresses: ["Plot 1, Clifton, Karachi", "Office 10, Saddar, Karachi"],
        approvers: [
          { level: 1, email: `edited-cfo-${fixtures.suffix}-${tag}@example.test`, designation: "Chief Financial Officer" },
          { level: 2, email: `edited-approver-${fixtures.suffix}-${tag}@example.test`, designation: "Finance Manager" },
        ],
      }
      const response = await decide(stored.id, { update: edited })
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200)
      expect(await response.json()).toEqual({ id: stored.id, updated: true })

      const { item: after } = await review(stored.id)
      expect(after.person).toMatchObject({
        firstName: "Sana",
        lastName: "Mir Khan",
        email: edited.email,
        username: organizationUsername(fixtures.organizationName, edited.username),
        phone: edited.phone,
        ipExtension: "98765",
        employeeId: edited.employeeId,
        department: "IT",
      })
      expect(after.initiatorRole).toBe("GROUP_ORDER_PORTAL")
      // Unchanged rows keep their ids, so a choice made against them still names them.
      expect(after.branches.map((row: any) => [row.requestBranchId === keptBranchRow, row.kind, row.costCenterId, row.requestedName]))
        .toEqual([[true, "existing", null, null], [false, "new", crc, "Edited Depot"]])
      expect(after.addresses.map((row: any) => row.address)).toEqual(edited.addresses)
      expect(after.addresses[0].requestAddressId).toBe(keptAddressRow)
      expect(after.approvers.map((approver: any) => [approver.email, approver.designation, approver.resolution.kind]))
        .toEqual([
          [edited.approvers[0].email, "Chief Financial Officer", "create"],
          [edited.approvers[1].email, "Finance Manager", "create"],
        ])

      // The trail names what changed, never the values.
      const [audit] = await db.select({ metadata: auditLogs.metadata }).from(auditLogs).where(and(
        eq(auditLogs.action, "UPDATE_ORGANIZATION_JOIN_REQUEST"),
        eq(auditLogs.entityId, String(stored.id)),
      ))
      expect(audit.metadata).toMatchObject({
        changedFields: ["firstName", "lastName", "email", "username", "phone", "ipExtension", "employeeId", "department"],
        changedApproverLevels: [1, 2],
        branchesChanged: true,
        addressesChanged: true,
      })
      expect(JSON.stringify(audit.metadata)).not.toContain(edited.email)

      const approved = await decide(stored.id, {
        decision: "approve",
        expectedResolutions: expectedFrom(after),
        newBranches: [{ requestBranchId: after.branches[1].requestBranchId, name: `Edited ${tag}`, province: "Sindh", city: "Karachi", address: "Plot 9, Clifton, Karachi" }],
        addressBranches: after.addresses.map((row: any) => ({ requestAddressId: row.requestAddressId, requestBranchId: keptBranchRow })),
      })
      expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(200)
      const [initiator] = await db
        .select({ username: users.username, phone: users.phone, department: users.department, ipExtension: users.ipExtension, passwordHash: users.passwordHash, firstName: users.firstName })
        .from(users)
        .where(eq(users.email, edited.email))
      expect(initiator).toMatchObject({ username: organizationUsername(fixtures.organizationName, edited.username), phone: edited.phone, department: "IT", ipExtension: "98765", firstName: "Sana" })
      expect(initiator.passwordHash).toBe(`hashed:${STRONG_PASSWORD}`)
      expect(await db.select({ id: users.id }).from(users).where(eq(users.email, String(stored.email)))).toHaveLength(0)
    })

    it("lets two levels swap approvers", async () => {
      const stored = await submitAccepted(signup())
      const { item } = await review(stored.id)
      const edit = unchangedEdit(item)
      const [one, two] = edit.approvers
      edit.approvers = [{ ...one, email: two.email }, { ...two, email: one.email }]

      expect((await decide(stored.id, { update: edit })).status).toBe(200)
      const { item: after } = await review(stored.id)
      expect(after.approvers.map((approver: any) => approver.email)).toEqual([two.email, one.email])
    })

    it("writes no audit row when nothing changed", async () => {
      const stored = await submitAccepted(signup())
      const { item } = await review(stored.id)
      const response = await decide(stored.id, { update: unchangedEdit(item) })
      expect(await response.json()).toEqual({ id: stored.id, updated: false })
      expect(await db.select({ id: auditLogs.id }).from(auditLogs).where(and(
        eq(auditLogs.action, "UPDATE_ORGANIZATION_JOIN_REQUEST"),
        eq(auditLogs.entityId, String(stored.id)),
      ))).toHaveLength(0)
    })

    it.each([
      ["an email at another domain", (edit: any) => ({ ...edit, email: "someone@gmail.com" }), 400],
      ["an approver who is the initiator", (edit: any) => ({ ...edit, approvers: [{ ...edit.approvers[0], email: edit.email }, edit.approvers[1]] }), 400],
      ["a missing level", (edit: any) => ({ ...edit, approvers: [edit.approvers[0]] }), 400],
      ["a branch of another organization", (edit: any) => ({ ...edit, branches: [{ branchId: fixtures.foreignBranchId }] }), 400],
      ["a password", (edit: any) => ({ ...edit, password: STRONG_PASSWORD }), 400],
      ["a role", (edit: any) => ({ ...edit, requestedRole: "HEAD_OFFICE" }), 400],
      ["a username an account holds", (edit: any) => ({ ...edit, username: `it-dept-holder-${fixtures.suffix}` }), 409],
      ["an email an account holds", (edit: any) => ({ ...edit, email: `holder-${fixtures.suffix}@example.test` }), 409],
    ])("refuses %s and changes nothing", async (_case, spoil, status) => {
      const stored = await submitAccepted(signup())
      const { item } = await review(stored.id)
      const response = await decide(stored.id, { update: spoil(unchangedEdit(item)) })
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(status)
      const { item: after } = await review(stored.id)
      expect(unchangedEdit(after)).toEqual(unchangedEdit(item))
    })

    it("refuses the email of another pending request", async () => {
      const first = await submitAccepted(signup())
      const second = await submitAccepted(signup())
      const { item } = await review(second.id)
      const response = await decide(second.id, { update: { ...unchangedEdit(item), email: first.email } })
      expect(response.status).toBe(409)
    })

    it("is Head Office of the request's own organization only, and only while pending", async () => {
      const stored = await submitAccepted(signup())
      const { item } = await review(stored.id)
      const edit = { ...unchangedEdit(item), firstName: "Intruder" }

      const branchAdmin: Actor = { id: fixtures.branchAdminId, role: "BRANCH_ADMIN", organizationId: fixtures.organizationId }
      expect((await decide(stored.id, { update: edit }, branchAdmin)).status).toBe(403)
      expect((await decide(stored.id, { update: edit }, foreignHead())).status).toBe(404)

      expect((await decide(stored.id, { decision: "reject" })).status).toBe(200)
      expect((await decide(stored.id, { update: edit })).status).toBe(409)
      const [row] = await db.select({ firstName: organizationJoinRequests.firstName }).from(organizationJoinRequests)
        .where(eq(organizationJoinRequests.id, stored.id))
      expect(row.firstName).toBe(item.person.firstName)
    })
  })

  describe("who may review and decide", () => {
    it("is Head Office of the request's own organization only", async () => {
      const stored = await submitAccepted(signup())

      signIn(null)
      expect((await decideRoute.GET(jsonRequest(`/api/v1/join-requests/${stored.id}`, "GET"), params(stored.id))).status).toBe(401)

      const branchAdmin: Actor = { id: fixtures.branchAdminId, role: "BRANCH_ADMIN", organizationId: fixtures.organizationId }
      expect((await review(stored.id, branchAdmin)).status).toBe(403)
      expect((await decide(stored.id, { decision: "reject" }, branchAdmin)).status).toBe(403)

      // Another tenant's Head Office cannot tell the request exists.
      expect((await review(stored.id, foreignHead())).status).toBe(404)
      expect((await decide(stored.id, { decision: "reject" }, foreignHead())).status).toBe(404)
      const [still] = await db.select({ status: organizationJoinRequests.status }).from(organizationJoinRequests)
        .where(eq(organizationJoinRequests.id, stored.id))
      expect(still.status).toBe("pending")
    })

    it("never returns the password hash or the temporary password", async () => {
      const stored = await submitAccepted(signup())
      const { item } = await review(stored.id)
      const text = JSON.stringify(item)
      expect(text).not.toContain("hashed:")
      expect(text).not.toMatch(/passwordHash|submittedIp/)

      const response = await decide(stored.id, { decision: "approve", expectedResolutions: expectedFrom(item) })
      const answer = JSON.stringify(await response.json())
      expect(answer).not.toContain(TEMPORARY_PASSWORD)
      const [audit] = await db.select({ metadata: auditLogs.metadata }).from(auditLogs).where(and(
        eq(auditLogs.action, "APPROVE_ORGANIZATION_JOIN_REQUEST"),
        eq(auditLogs.entityId, String(stored.id)),
      ))
      expect(JSON.stringify(audit?.metadata ?? {})).not.toContain(TEMPORARY_PASSWORD)
    })
  })

  it("keeps one row per request branch, approver and address", async () => {
    const counts = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM organization_join_request_branches b JOIN organization_join_requests r ON r.id = b.request_id WHERE r.organization_id = ${fixtures.organizationId})::int AS branches,
        (SELECT count(*) FROM organization_join_request_approvers a JOIN organization_join_requests r ON r.id = a.request_id WHERE r.organization_id = ${fixtures.organizationId})::int AS approvers
    `)
    const row = (counts.rows as Array<{ branches: number; approvers: number }>)[0]
    expect(row.branches).toBeGreaterThan(0)
    expect(row.approvers).toBeGreaterThan(0)
  })
})
