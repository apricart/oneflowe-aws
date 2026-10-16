import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, desc, eq, inArray } from "drizzle-orm"

import * as usersRoute from "@/app/api/v1/users/route"
import * as accessRoute from "@/app/api/v1/users/[id]/access/route"
import * as levelRoute from "@/app/api/v1/users/[id]/approval-level/route"
import * as approvalLevelsRoute from "@/app/api/v1/organizations/[id]/approval-levels/route"
import { auditLogs, organizationApprovalLevels, organizations, roles, sessions, systemLogs, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { USER_APPROVAL_LEVEL_AUDIT_ACTION } from "@/lib/order-approval-levels"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * Assigning users to order approval levels against Postgres
 * (plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md).
 *
 * The real user, access, approval-level and organization-levels routes write
 * the real rows; only the session, rate limiting, cache, password hashing and
 * mail are stubbed.
 */
const mocks = vi.hoisted(() => ({
  hashPassword: vi.fn(async () => "integration-test-password-hash"),
  sendWelcomeEmail: vi.fn(async () => {}),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/password", () => ({ hashPassword: mocks.hashPassword }))
vi.mock("@/lib/email", () => ({ sendWelcomeEmail: mocks.sendWelcomeEmail }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: vi.fn(async () => undefined),
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId?: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

const request = (method: string, url: string, body?: unknown) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const read = async (response: Response) => ({ status: response.status, body: await response.json() })

describe.skipIf(!hasTestDatabase)("user approval levels", () => {
  let f: GroupRoleFixtures
  let branchAdminId: string
  let orderPortalId: string
  let foreignBranchAdminId: string
  const createdUserIds: string[] = []
  let createCounter = 0

  const superAdmin = (): Actor => ({ id: f.superAdminId, email: `sa-${f.suffix}@example.test`, role: "SUPER_ADMIN", organizationId: null })
  const headOffice = (): Actor => ({ id: f.headOfficeId, email: `head-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const foreignHeadOffice = (): Actor => ({ id: f.foreignHeadOfficeId, email: `fho-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.foreignOrganizationId })
  const groupUser = (): Actor => ({ id: f.approverId, email: `ap-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })

  const levelUrl = (userId: string) => `http://localhost/api/v1/users/${userId}/approval-level`
  const putLevel = async (userId: string, body: unknown) =>
    read(await levelRoute.PUT(request("PUT", levelUrl(userId), body), { params: Promise.resolve({ id: userId }) }))
  const putOrganizationLevels = async (organizationId: number, body: unknown) =>
    read(await approvalLevelsRoute.PUT(
      request("PUT", `http://localhost/api/v1/organizations/${organizationId}/approval-levels`, body),
      { params: Promise.resolve({ id: String(organizationId) }) },
    ))
  const getOrganizationLevels = async (organizationId: number) =>
    read(await approvalLevelsRoute.GET(
      request("GET", `http://localhost/api/v1/organizations/${organizationId}/approval-levels`),
      { params: Promise.resolve({ id: String(organizationId) }) },
    ))
  const patchAccess = async (userId: string, body: unknown) =>
    read(await accessRoute.PATCH(
      request("PATCH", `http://localhost/api/v1/users/${userId}/access`, body),
      { params: Promise.resolve({ id: userId }) },
    ))

  const levelOf = async (userId: string) => {
    const [row] = await db.select({ level: users.orderApprovalLevel }).from(users).where(eq(users.id, userId))
    return row?.level ?? null
  }
  const assignmentAudits = (userId: string) => db
    .select({ metadata: auditLogs.metadata, userId: auditLogs.userId })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, USER_APPROVAL_LEVEL_AUDIT_ACTION), eq(auditLogs.entityId, userId)))
    .orderBy(desc(auditLogs.id))

  async function person(label: string, roleName: string, organizationId: number, branchId: number | null) {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, roleName)).limit(1)
    const [row] = await db.insert(users).values({
      email: `it-ual-${label}-${f.suffix}@example.test`,
      username: `it-ual-${label}-${f.suffix}`,
      passwordHash: "not-a-real-hash",
      roleId: role.id,
      organizationId,
      branchId,
      firstName: label,
      lastName: f.suffix,
      fullName: `${label} ${f.suffix}`,
    }).returning({ id: users.id })
    createdUserIds.push(row.id)
    return row.id
  }

  async function createUser(actor: Actor, overrides: Record<string, unknown>) {
    createCounter += 1
    signIn(actor)
    const result = await read(await usersRoute.POST(new Request("http://localhost/api/v1/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: "Level",
        lastName: `Test${createCounter}`,
        email: `it-ual-new-${createCounter}-${f.suffix}@example.test`,
        username: `it-ual-new-${createCounter}-${f.suffix}`,
        password: "Str0ng!Passw0rd#2026",
        role: "BRANCH_ADMIN",
        organizationId: f.organizationId,
        branchId: f.alphaNorthId,
        ...overrides,
      }),
    })))
    if (result.status === 201) createdUserIds.push(result.body.item.id)
    return result
  }

  /** The organization's approval set-up, written straight to the rows. */
  async function configure(values: { required?: boolean; levelsEnabled?: boolean; approverRole?: string; levels?: number[] }) {
    await db.update(organizations).set({
      orderApprovalRequired: values.required ?? true,
      orderApprovalLevelsEnabled: values.levelsEnabled ?? true,
      orderApproverRole: values.approverRole ?? "BRANCH_ADMIN",
    }).where(eq(organizations.id, f.organizationId))
    await db.delete(organizationApprovalLevels).where(eq(organizationApprovalLevels.organizationId, f.organizationId))
    const amounts = values.levels ?? [6_000_000, 2_000_000, 500_000]
    if (amounts.length > 0) {
      await db.insert(organizationApprovalLevels).values(amounts.map((maxAmountCents, index) => ({
        organizationId: f.organizationId,
        level: index + 1,
        maxAmountCents,
      })))
    }
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
    branchAdminId = await person("ba", "BRANCH_ADMIN", f.organizationId, f.alphaNorthId)
    orderPortalId = await person("op", "ORDER_PORTAL", f.organizationId, f.alphaNorthId)
    foreignBranchAdminId = await person("fba", "BRANCH_ADMIN", f.foreignOrganizationId, f.foreignBranchId)
  })

  beforeEach(async () => {
    const ids = [branchAdminId, orderPortalId, foreignBranchAdminId, f.approverId, f.headOfficeId, ...createdUserIds]
    await db.update(users).set({ orderApprovalLevel: null }).where(inArray(users.id, ids))
    await db.delete(auditLogs).where(and(
      eq(auditLogs.action, USER_APPROVAL_LEVEL_AUDIT_ACTION),
      inArray(auditLogs.entityId, ids),
    ))
    await configure({})
  })

  afterAll(async () => {
    if (f) {
      const all = [branchAdminId, orderPortalId, foreignBranchAdminId, ...createdUserIds].filter(Boolean)
      await db.delete(sessions).where(inArray(sessions.userId, all))
      await db.delete(auditLogs).where(inArray(auditLogs.entityId, [...all, f.approverId, f.headOfficeId]))
      // User creation and access changes log here with the user as the resource.
      await db.delete(systemLogs).where(inArray(systemLogs.resourceId, all))
      await db.delete(organizationApprovalLevels).where(eq(organizationApprovalLevels.organizationId, f.organizationId))
      await destroyGroupRoleFixtures(f, all)
    }
    await closePool()
  })

  describe("who may assign", () => {
    it("refuses a signed-out caller", async () => {
      signIn(null)
      expect((await putLevel(branchAdminId, { level: 1 })).status).toBe(401)
      expect(await levelOf(branchAdminId)).toBeNull()
    })

    it("refuses roles that do not manage users", async () => {
      signIn(groupUser())
      expect((await putLevel(branchAdminId, { level: 1 })).status).toBe(403)
      expect(await levelOf(branchAdminId)).toBeNull()
    })

    it("answers another organization's Head Office as if the user did not exist", async () => {
      signIn(foreignHeadOffice())
      expect((await putLevel(branchAdminId, { level: 1 })).status).toBe(404)
      expect(await levelOf(branchAdminId)).toBeNull()
    })

    it("refuses anyone changing their own level", async () => {
      await configure({ approverRole: "HEAD_OFFICE" })
      signIn(headOffice())
      expect((await putLevel(f.headOfficeId, { level: 1 })).status).toBe(403)
      expect(await levelOf(f.headOfficeId)).toBeNull()
    })

    it("lets Head Office assign within its organization, recorded with before and after, without ending sessions", async () => {
      const [{ sessionVersion }] = await db.select({ sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, branchAdminId))
      signIn(headOffice())
      const saved = await putLevel(branchAdminId, { level: 2 })
      expect(saved).toMatchObject({ status: 200, body: { item: { orderApprovalLevel: 2 }, changed: true } })
      expect(await levelOf(branchAdminId)).toBe(2)

      const [audit] = await assignmentAudits(branchAdminId)
      expect(audit.userId).toBe(f.headOfficeId)
      expect(audit.metadata).toMatchObject({ before: { orderApprovalLevel: null }, after: { orderApprovalLevel: 2 } })

      const [after] = await db.select({ sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, branchAdminId))
      expect(after.sessionVersion).toBe(sessionVersion)
    })

    it("lets Super Admin assign in any organization, clear the level, and records nothing for no change", async () => {
      signIn(superAdmin())
      expect((await putLevel(branchAdminId, { level: 1 })).status).toBe(200)
      expect((await putLevel(branchAdminId, { level: 1 })).body.changed).toBe(false)
      expect(await assignmentAudits(branchAdminId)).toHaveLength(1)

      expect((await putLevel(branchAdminId, { level: null })).body).toMatchObject({ changed: true, item: { orderApprovalLevel: null } })
      expect(await levelOf(branchAdminId)).toBeNull()
      expect(await assignmentAudits(branchAdminId)).toHaveLength(2)
    })

    it("answers 404 for an unknown or malformed id", async () => {
      signIn(superAdmin())
      expect((await putLevel("00000000-0000-0000-0000-000000000000", { level: 1 })).status).toBe(404)
      expect((await putLevel("not-a-uuid", { level: 1 })).status).toBe(404)
    })
  })

  describe("what may be assigned", () => {
    it("gives a Group User a level whatever the configured approver role", async () => {
      await configure({ approverRole: "HEAD_OFFICE" })
      signIn(superAdmin())
      expect((await putLevel(f.approverId, { level: 3 })).status).toBe(200)
      expect(await levelOf(f.approverId)).toBe(3)
    })

    it.each([
      ["an ordering role", () => orderPortalId, {}],
      ["a Branch Admin where Head Office approves", () => branchAdminId, { approverRole: "HEAD_OFFICE" }],
      ["an organization that does not require approval", () => branchAdminId, { required: false }],
      ["an organization with levels off", () => branchAdminId, { levelsEnabled: false }],
    ])("refuses %s, and stores nothing", async (_label, userId, setup) => {
      await configure(setup)
      signIn(superAdmin())
      const result = await putLevel(userId(), { level: 1 })
      expect(result.status).toBe(400)
      expect(await levelOf(userId())).toBeNull()
    })

    it.each([
      ["a level the organization does not have", { level: 4 }, 400],
      ["level zero", { level: 0 }, 400],
      ["a level past the maximum", { level: 11 }, 400],
      ["a level sent as a string", { level: "1" }, 400],
      ["a missing level", {}, 400],
      ["an unknown field", { level: 1, organizationId: 1 }, 400],
    ])("refuses %s", async (_label, body, status) => {
      signIn(superAdmin())
      expect((await putLevel(branchAdminId, body)).status).toBe(status)
      expect(await levelOf(branchAdminId)).toBeNull()
    })

    it("leaves a stored level in place when the organization switches levels off", async () => {
      signIn(superAdmin())
      await putLevel(branchAdminId, { level: 2 })
      await configure({ levelsEnabled: false })
      expect(await levelOf(branchAdminId)).toBe(2)
    })
  })

  describe("Create User", () => {
    it("creates a Branch Admin holding a level", async () => {
      const result = await createUser(headOffice(), { orderApprovalLevel: 2 })
      expect(result.status).toBe(201)
      expect(await levelOf(result.body.item.id)).toBe(2)
    })

    it("creates a user with no level when the field is absent", async () => {
      const result = await createUser(superAdmin(), {})
      expect(result.status).toBe(201)
      expect(await levelOf(result.body.item.id)).toBeNull()
    })

    it.each([
      ["an ordering role", { role: "ORDER_PORTAL", orderApprovalLevel: 1 }],
      ["a level the organization does not have", { orderApprovalLevel: 4 }],
      ["a level sent as a string", { orderApprovalLevel: "1" }],
    ])("refuses %s, and creates no one", async (_label, overrides) => {
      const before = createdUserIds.length
      const result = await createUser(superAdmin(), overrides)
      expect(result.status).toBe(400)
      expect(createdUserIds).toHaveLength(before)
    })

    it("refuses a level while levels are off, and creates no one", async () => {
      await configure({ levelsEnabled: false })
      const before = createdUserIds.length
      expect((await createUser(superAdmin(), { orderApprovalLevel: 1 })).status).toBe(400)
      expect(createdUserIds).toHaveLength(before)
    })
  })

  describe("an access change", () => {
    it("clears the level when the role changes, and keeps it for an unrelated change", async () => {
      signIn(superAdmin())
      await putLevel(branchAdminId, { level: 2 })

      expect((await patchAccess(branchAdminId, { mfaEnabled: false })).status).toBe(200)
      expect(await levelOf(branchAdminId)).toBe(2)

      expect((await patchAccess(branchAdminId, { role: "ORDER_PORTAL" })).status).toBe(200)
      expect(await levelOf(branchAdminId)).toBeNull()

      // Put the fixture back for the tests after this one.
      expect((await patchAccess(branchAdminId, { role: "BRANCH_ADMIN" })).status).toBe(200)
      expect(await levelOf(branchAdminId)).toBeNull()
    })
  })

  describe("removing a level from the organization", () => {
    it("is refused while a user holds it, and allowed once they no longer do", async () => {
      signIn(superAdmin())
      await putLevel(branchAdminId, { level: 3 })

      const refused = await putOrganizationLevels(f.organizationId, { enabled: true, levels: [{ maxAmountCents: 6_000_000 }, { maxAmountCents: 2_000_000 }] })
      expect(refused.status).toBe(409)
      expect(refused.body.error).toContain("Level 3 (1 user)")
      const stored = await db.select({ level: organizationApprovalLevels.level }).from(organizationApprovalLevels)
        .where(eq(organizationApprovalLevels.organizationId, f.organizationId))
      expect(stored).toHaveLength(3)

      // Changing amounts, or keeping the count, is never blocked.
      expect((await putOrganizationLevels(f.organizationId, { enabled: true, levels: [{ maxAmountCents: 7_000_000 }, { maxAmountCents: 3_000_000 }, { maxAmountCents: 400_000 }] })).status).toBe(200)

      await putLevel(branchAdminId, { level: 1 })
      expect((await putOrganizationLevels(f.organizationId, { enabled: true, levels: [{ maxAmountCents: 7_000_000 }, { maxAmountCents: 3_000_000 }] })).status).toBe(200)
    })

    it("ignores a deleted user's level", async () => {
      signIn(superAdmin())
      const created = await createUser(superAdmin(), { orderApprovalLevel: 3 })
      await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, created.body.item.id))
      expect((await putOrganizationLevels(f.organizationId, { enabled: true, levels: [{ maxAmountCents: 6_000_000 }] })).status).toBe(200)
    })

    it("lets an assignment and a removal race to exactly one consistent outcome", async () => {
      signIn(superAdmin())
      const [assigned, removed] = await Promise.all([
        putLevel(branchAdminId, { level: 3 }),
        putOrganizationLevels(f.organizationId, { enabled: true, levels: [{ maxAmountCents: 6_000_000 }, { maxAmountCents: 2_000_000 }] }),
      ])
      const levelCount = (await db.select({ level: organizationApprovalLevels.level }).from(organizationApprovalLevels)
        .where(eq(organizationApprovalLevels.organizationId, f.organizationId))).length
      const held = await levelOf(branchAdminId)
      // Never a user holding a level the organization no longer has.
      expect(held === null || held <= levelCount).toBe(true)
      expect([assigned.status, removed.status].sort()).toEqual(
        held === 3 ? [200, 409] : [200, 400].sort(),
      )
    })
  })

  describe("reading the levels for the user forms", () => {
    it("lets Head Office read its own organization's levels and approval set-up", async () => {
      signIn(headOffice())
      const result = await getOrganizationLevels(f.organizationId)
      expect(result.status).toBe(200)
      expect(result.body).toMatchObject({ enabled: true, orderApprovalRequired: true, orderApproverRole: "BRANCH_ADMIN" })
      expect(result.body.levels).toHaveLength(3)
    })

    it("answers Head Office asking for another organization as not found", async () => {
      signIn(headOffice())
      expect((await getOrganizationLevels(f.foreignOrganizationId)).status).toBe(404)
    })

    it("still refuses Head Office writing the levels", async () => {
      signIn(headOffice())
      expect((await putOrganizationLevels(f.organizationId, { enabled: false })).status).toBe(403)
    })

    it("lists each user's level in the users list", async () => {
      signIn(superAdmin())
      await putLevel(branchAdminId, { level: 2 })
      signIn(headOffice())
      const listed = await read(await usersRoute.GET(new Request("http://localhost/api/v1/users?refresh=1")))
      const row = listed.body.items.find((item: any) => item.id === branchAdminId)
      expect(row.orderApprovalLevel).toBe(2)
    })
  })
})
