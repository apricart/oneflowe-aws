import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, asc, desc, eq, inArray } from "drizzle-orm"

import * as organizationsRoute from "@/app/api/v1/organizations/route"
import * as approvalLevelsRoute from "@/app/api/v1/organizations/[id]/approval-levels/route"
import {
  auditLogs,
  organizationAllowedIps,
  organizationApprovalLevels,
  organizationSettings,
  organizations,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { ORDER_APPROVAL_LEVELS_AUDIT_ACTION } from "@/lib/order-approval-levels"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * Order approval levels against Postgres
 * (plans/OF-APPROVAL-LEVELS-organization-approval-levels.md).
 *
 * The real organization POST and the real approval-levels route write the real
 * column and table; only the session, rate limiting and cache are stubbed.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
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

const levels = (...amounts: number[]) => amounts.map((maxAmountCents) => ({ maxAmountCents }))

describe.skipIf(!hasTestDatabase)("order approval levels", () => {
  let f: GroupRoleFixtures
  const createdOrganizationIds: number[] = []
  let createCounter = 0

  const superAdmin = (): Actor => ({ id: f.superAdminId, email: `sa-${f.suffix}@example.test`, role: "SUPER_ADMIN", organizationId: null })
  const headOffice = (): Actor => ({ id: f.headOfficeId, email: `head-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const groupUser = (): Actor => ({ id: f.approverId, email: `ap-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })
  // Role checks run on the session alone, so these borrow a real user id.
  const branchAdmin = (): Actor => ({ id: f.approverId, email: `ba-${f.suffix}@example.test`, role: "BRANCH_ADMIN", organizationId: f.organizationId, branchId: f.alphaNorthId })
  const orderPortal = (): Actor => ({ id: f.requesterId, email: `op-${f.suffix}@example.test`, role: "ORDER_PORTAL", organizationId: f.organizationId, branchId: f.alphaNorthId })

  const url = (organizationId: number | string) =>
    `http://localhost/api/v1/organizations/${organizationId}/approval-levels`
  const params = (organizationId: number | string) => ({ params: Promise.resolve({ id: String(organizationId) }) })

  const getLevels = async (organizationId: number | string) =>
    read(await approvalLevelsRoute.GET(request("GET", url(organizationId)), params(organizationId)))
  const putLevels = async (organizationId: number | string, body: unknown) =>
    read(await approvalLevelsRoute.PUT(request("PUT", url(organizationId), body), params(organizationId)))

  /** What is actually stored, read past the API. */
  const stored = async (organizationId: number) => {
    const [organization] = await db
      .select({ enabled: organizations.orderApprovalLevelsEnabled })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
    const rows = await db
      .select({ level: organizationApprovalLevels.level, maxAmountCents: organizationApprovalLevels.maxAmountCents })
      .from(organizationApprovalLevels)
      .where(eq(organizationApprovalLevels.organizationId, organizationId))
      .orderBy(asc(organizationApprovalLevels.level))
    return { enabled: organization?.enabled, levels: rows }
  }

  const auditRows = (organizationId: number) => db
    .select({ action: auditLogs.action, metadata: auditLogs.metadata, userId: auditLogs.userId })
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.action, ORDER_APPROVAL_LEVELS_AUDIT_ACTION)))
    .orderBy(desc(auditLogs.id))

  async function createOrganization(extra: Record<string, unknown> = {}) {
    createCounter += 1
    signIn(superAdmin())
    const result = await read(await organizationsRoute.POST(request("POST", "http://localhost/api/v1/organizations", {
      name: `Approval Levels ${f.suffix} ${createCounter}`,
      code: `ITAL${f.suffix.replaceAll(/[^A-Za-z0-9]/g, "").slice(0, 8)}${createCounter}`,
      ...extra,
    })))
    if (result.status === 201) createdOrganizationIds.push(result.body.item.id)
    return result
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
  })

  beforeEach(async () => {
    await db.delete(organizationApprovalLevels).where(eq(organizationApprovalLevels.organizationId, f.organizationId))
    await db.update(organizations).set({ orderApprovalLevelsEnabled: false }).where(eq(organizations.id, f.organizationId))
    await db.delete(auditLogs).where(and(
      eq(auditLogs.organizationId, f.organizationId),
      eq(auditLogs.action, ORDER_APPROVAL_LEVELS_AUDIT_ACTION),
    ))
  })

  afterAll(async () => {
    if (createdOrganizationIds.length > 0) {
      await db.delete(auditLogs).where(inArray(auditLogs.organizationId, createdOrganizationIds))
      await db.delete(organizationSettings).where(inArray(organizationSettings.organizationId, createdOrganizationIds))
      await db.delete(organizationAllowedIps).where(inArray(organizationAllowedIps.organizationId, createdOrganizationIds))
      await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds))
    }
    if (f) await destroyGroupRoleFixtures(f)
    await closePool()
  })

  describe("who may reach it", () => {
    it("refuses a signed-out caller on both methods", async () => {
      signIn(null)
      expect((await getLevels(f.organizationId)).status).toBe(401)
      expect((await putLevels(f.organizationId, { enabled: true, levels: levels(100) })).status).toBe(401)
      expect(await stored(f.organizationId)).toEqual({ enabled: false, levels: [] })
    })

    it.each([
      ["a Group User", () => groupUser()],
      ["a Branch Admin", () => branchAdmin()],
      ["an Order Portal user", () => orderPortal()],
    ])("refuses %s on both methods, and stores nothing", async (_label, actor) => {
      signIn(actor())
      expect((await getLevels(f.organizationId)).status).toBe(403)
      expect((await putLevels(f.organizationId, { enabled: true, levels: levels(100) })).status).toBe(403)
      expect(await stored(f.organizationId)).toEqual({ enabled: false, levels: [] })
      expect(await auditRows(f.organizationId)).toHaveLength(0)
    })

    // Head Office reads its own organization's levels for the user forms
    // (plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md), but never writes them.
    it("lets Head Office read its own organization's levels but never write them", async () => {
      signIn(headOffice())
      expect((await getLevels(f.organizationId)).status).toBe(200)
      expect((await getLevels(f.foreignOrganizationId)).status).toBe(404)
      expect((await putLevels(f.organizationId, { enabled: true, levels: levels(100) })).status).toBe(403)
      expect(await stored(f.organizationId)).toEqual({ enabled: false, levels: [] })
      expect(await auditRows(f.organizationId)).toHaveLength(0)
    })

    it("refuses Head Office creating an organization with levels", async () => {
      signIn(headOffice())
      const result = await read(await organizationsRoute.POST(request("POST", "http://localhost/api/v1/organizations", {
        name: `Not Allowed ${f.suffix}`,
        code: "ITALNOPE",
        orderApprovalLevels: { enabled: true, levels: levels(100) },
      })))
      expect(result.status).toBe(403)
    })
  })

  describe("Create Organization", () => {
    it("creates an organization with the feature off and no levels when the field is absent", async () => {
      const result = await createOrganization()
      expect(result.status).toBe(201)
      expect(result.body.item.orderApprovalLevelsEnabled).toBe(false)
      expect(await stored(result.body.item.id)).toEqual({ enabled: false, levels: [] })
    })

    it("creates the switch and the levels in one go, and records them", async () => {
      const result = await createOrganization({
        orderApprovalLevels: { enabled: true, levels: levels(15_000_000, 8_000_000, 4_000_000) },
      })
      expect(result.status).toBe(201)
      const id = result.body.item.id
      expect(await stored(id)).toEqual({
        enabled: true,
        levels: [
          { level: 1, maxAmountCents: 15_000_000 },
          { level: 2, maxAmountCents: 8_000_000 },
          { level: 3, maxAmountCents: 4_000_000 },
        ],
      })

      const [created] = await db
        .select({ metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(and(eq(auditLogs.organizationId, id), eq(auditLogs.action, "CREATE_ORGANIZATION")))
      expect(created.metadata).toMatchObject({
        orderApprovalLevelsEnabled: true,
        orderApprovalLevels: [
          { level: 1, maxAmountCents: 15_000_000 },
          { level: 2, maxAmountCents: 8_000_000 },
          { level: 3, maxAmountCents: 4_000_000 },
        ],
      })
    })

    it.each([
      ["switched on with no levels", { enabled: true }],
      ["levels that do not fall", { enabled: true, levels: levels(4_000_000, 8_000_000) }],
      ["an amount sent as a string", { enabled: true, levels: [{ maxAmountCents: "4000000" }] }],
    ])("refuses %s and creates nothing", async (_label, orderApprovalLevels) => {
      const before = createdOrganizationIds.length
      const result = await createOrganization({ orderApprovalLevels })
      expect(result.status).toBe(400)
      expect(createdOrganizationIds).toHaveLength(before)
    })
  })

  describe("Edit Organization", () => {
    it("reads an organization that has never set levels as off, with none", async () => {
      signIn(superAdmin())
      expect(await getLevels(f.organizationId)).toEqual({
        status: 200,
        body: { enabled: false, levels: [], orderApprovalRequired: true, orderApproverRole: "BRANCH_ADMIN" },
      })
    })

    it("switches on with levels, records before and after, and reads them back", async () => {
      signIn(superAdmin())
      const saved = await putLevels(f.organizationId, { enabled: true, levels: levels(8_000_000, 4_000_000) })
      expect(saved.status).toBe(200)
      expect(saved.body).toMatchObject({
        enabled: true,
        changed: true,
        levels: [{ level: 1, maxAmountCents: 8_000_000 }, { level: 2, maxAmountCents: 4_000_000 }],
      })
      expect(await getLevels(f.organizationId)).toMatchObject({
        status: 200,
        body: { enabled: true, levels: [{ level: 1, maxAmountCents: 8_000_000 }, { level: 2, maxAmountCents: 4_000_000 }] },
      })

      const [audit] = await auditRows(f.organizationId)
      expect(audit.userId).toBe(f.superAdminId)
      expect(audit.metadata).toMatchObject({
        before: { enabled: false, levels: [] },
        after: { enabled: true, levels: [{ level: 1, maxAmountCents: 8_000_000 }, { level: 2, maxAmountCents: 4_000_000 }] },
      })
    })

    it("replaces the whole list: adding, changing and removing levels", async () => {
      signIn(superAdmin())
      await putLevels(f.organizationId, { enabled: true, levels: levels(8_000_000, 4_000_000) })
      await putLevels(f.organizationId, { enabled: true, levels: levels(20_000_000, 8_000_000, 5_000_000) })
      expect((await stored(f.organizationId)).levels).toEqual([
        { level: 1, maxAmountCents: 20_000_000 },
        { level: 2, maxAmountCents: 8_000_000 },
        { level: 3, maxAmountCents: 5_000_000 },
      ])

      await putLevels(f.organizationId, { enabled: true, levels: levels(5_000_000) })
      expect((await stored(f.organizationId)).levels).toEqual([{ level: 1, maxAmountCents: 5_000_000 }])
    })

    it("switching off without levels keeps them, and switching back on restores them", async () => {
      signIn(superAdmin())
      await putLevels(f.organizationId, { enabled: true, levels: levels(8_000_000, 4_000_000) })

      const off = await putLevels(f.organizationId, { enabled: false })
      expect(off.status).toBe(200)
      expect(off.body).toMatchObject({ enabled: false, changed: true })
      expect(await stored(f.organizationId)).toEqual({
        enabled: false,
        levels: [{ level: 1, maxAmountCents: 8_000_000 }, { level: 2, maxAmountCents: 4_000_000 }],
      })

      await putLevels(f.organizationId, { enabled: true, levels: levels(8_000_000, 4_000_000) })
      expect((await stored(f.organizationId)).enabled).toBe(true)
    })

    it("writes no audit row for a save that changes nothing", async () => {
      signIn(superAdmin())
      await putLevels(f.organizationId, { enabled: true, levels: levels(8_000_000, 4_000_000) })
      expect(await auditRows(f.organizationId)).toHaveLength(1)

      const again = await putLevels(f.organizationId, { enabled: true, levels: levels(8_000_000, 4_000_000) })
      expect(again.body).toMatchObject({ changed: false, message: "Approval levels unchanged" })
      expect(await auditRows(f.organizationId)).toHaveLength(1)

      await putLevels(f.organizationId, { enabled: false })
      await putLevels(f.organizationId, { enabled: false })
      expect(await auditRows(f.organizationId)).toHaveLength(2)
    })

    it.each([
      ["switched on with no levels", { enabled: true }],
      ["switched on with an empty list", { enabled: true, levels: [] }],
      ["equal amounts", { enabled: true, levels: levels(4_000_000, 4_000_000) }],
      ["a rising amount", { enabled: true, levels: levels(4_000_000, 8_000_000) }],
      ["a zero amount", { enabled: true, levels: levels(0) }],
      ["an amount over the maximum", { enabled: true, levels: levels(100_000_000_001) }],
      ["a fractional amount", { enabled: true, levels: levels(100.5) }],
      ["an amount sent as a string", { enabled: true, levels: [{ maxAmountCents: "100" }] }],
      ["eleven levels", { enabled: true, levels: levels(...Array.from({ length: 11 }, (_, i) => (11 - i) * 100)) }],
      ["an unknown field", { enabled: true, levels: levels(100), organizationId: 1 }],
    ])("refuses %s and stores nothing", async (_label, body) => {
      signIn(superAdmin())
      await putLevels(f.organizationId, { enabled: true, levels: levels(4_000_000) })

      const result = await putLevels(f.organizationId, body)
      expect(result.status).toBe(400)
      expect(await stored(f.organizationId)).toEqual({ enabled: true, levels: [{ level: 1, maxAmountCents: 4_000_000 }] })
      expect(await auditRows(f.organizationId)).toHaveLength(1)
    })

    it("answers 404 for an organization that does not exist", async () => {
      signIn(superAdmin())
      expect((await getLevels(999_999_999)).status).toBe(404)
      expect((await putLevels(999_999_999, { enabled: false })).status).toBe(404)
    })

    it.each(["0", "-1", "1.5", "1e3", "abc", "1;DROP"])("answers 400 for the id %j", async (id) => {
      signIn(superAdmin())
      expect((await getLevels(id)).status).toBe(400)
      expect((await putLevels(id, { enabled: false })).status).toBe(400)
    })

    it("keeps one organization's levels out of another's", async () => {
      signIn(superAdmin())
      await putLevels(f.organizationId, { enabled: true, levels: levels(4_000_000) })
      expect(await getLevels(f.foreignOrganizationId)).toMatchObject({ status: 200, body: { enabled: false, levels: [] } })
    })

    it("lets two concurrent saves both finish, leaving one of the two complete lists", async () => {
      signIn(superAdmin())
      const [first, second] = await Promise.all([
        putLevels(f.organizationId, { enabled: true, levels: levels(2_000, 1_000) }),
        putLevels(f.organizationId, { enabled: true, levels: levels(5_000, 4_000, 3_000) }),
      ])
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      const amounts = (await stored(f.organizationId)).levels.map((level) => level.maxAmountCents)
      expect([[2_000, 1_000], [5_000, 4_000, 3_000]]).toContainEqual(amounts)
    })
  })

  describe("the database itself", () => {
    const rawInsert = (values: { level: number; maxAmountCents: number }) =>
      db.insert(organizationApprovalLevels).values({ organizationId: f.organizationId, ...values })

    it("refuses a level outside 1..10, an amount outside its bounds, and a duplicate level", async () => {
      await expect(rawInsert({ level: 0, maxAmountCents: 100 })).rejects.toThrow()
      await expect(rawInsert({ level: 11, maxAmountCents: 100 })).rejects.toThrow()
      await expect(rawInsert({ level: 1, maxAmountCents: 0 })).rejects.toThrow()
      await expect(rawInsert({ level: 1, maxAmountCents: 100_000_000_001 })).rejects.toThrow()

      await rawInsert({ level: 1, maxAmountCents: 100 })
      await expect(rawInsert({ level: 1, maxAmountCents: 200 })).rejects.toThrow()
    })

    it("removes an organization's levels with the organization", async () => {
      const result = await createOrganization({ orderApprovalLevels: { enabled: true, levels: levels(200, 100) } })
      const id = result.body.item.id
      expect((await stored(id)).levels).toHaveLength(2)

      await db.delete(auditLogs).where(eq(auditLogs.organizationId, id))
      await db.delete(organizationSettings).where(eq(organizationSettings.organizationId, id))
      await db.delete(organizations).where(eq(organizations.id, id))
      const left = await db
        .select({ id: organizationApprovalLevels.id })
        .from(organizationApprovalLevels)
        .where(eq(organizationApprovalLevels.organizationId, id))
      expect(left).toHaveLength(0)
    })
  })
})
