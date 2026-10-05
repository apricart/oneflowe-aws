import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, desc, eq, inArray } from "drizzle-orm"
import * as mockedNextAuth from "next-auth"

import * as branchRoute from "@/app/api/v1/branches/[id]/route"
import * as branchesRoute from "@/app/api/v1/branches/route"
import { auditLogs, branches, groups, organizations, roles, userBranchAssignments, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * /api/v1/branches and /api/v1/branches/[id], end to end.
 *
 * Every role that may list branches is checked against the set it should see:
 * Super Admin everything it asks for, Head Office its tenant, Branch Admin its
 * own branch, a Group User its assignments — and any non-Super-Admin caller
 * without an organization nothing at all. Creation and editing are held to the
 * caller's tenant, and every write leaves an audit row.
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
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

type Fixtures = Awaited<ReturnType<typeof createFixtures>>

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "branches it" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const [home, foreign] = await db.insert(organizations).values([
    { name: `IT Branches Home ${suffix}`, code: `ITBH${suffix}` },
    { name: `IT Branches Foreign ${suffix}`, code: `ITBF${suffix}` },
  ]).returning({ id: organizations.id, code: organizations.code })

  const [north, south, abroad] = await db.insert(branches).values([
    { organizationId: home.id, name: `North ${suffix}`, status: "active", code: `${home.code}-01` },
    { organizationId: home.id, name: `South ${suffix}`, status: "active", code: `${home.code}-02` },
    { organizationId: foreign.id, name: `Abroad ${suffix}`, status: "active", code: `${foreign.code}-01` },
  ]).returning({ id: branches.id })

  const person = async (label: string, role: string, organizationId: number | null, branchId: number | null = null) => {
    const [row] = await db.insert(users).values({
      email: `it-branches-${label}-${suffix}@example.test`,
      username: `it-branches-${label}-${suffix}`,
      passwordHash: "x",
      roleId: await roleId(role),
      organizationId,
      branchId,
    }).returning({ id: users.id })
    return row.id
  }

  const superAdminId = await person("super", "SUPER_ADMIN", null)
  const headOfficeId = await person("head", "HEAD_OFFICE", home.id)
  const branchAdminId = await person("ba", "BRANCH_ADMIN", home.id, north.id)
  const groupUserId = await person("gu", "GROUP_USER", home.id)
  const orderPortalId = await person("op", "ORDER_PORTAL", home.id, north.id)
  const orphanOrderPortalId = await person("orphan-op", "ORDER_PORTAL", null, null)
  await db.insert(userBranchAssignments).values({
    userId: groupUserId,
    branchId: south.id,
    organizationId: home.id,
    createdByUserId: headOfficeId,
  })

  const [homeGroup] = await db.insert(groups)
    .values({ organizationId: home.id, name: `Home Group ${suffix}`, createdByUserId: headOfficeId })
    .returning({ id: groups.id })
  const [foreignGroup] = await db.insert(groups)
    .values({ organizationId: foreign.id, name: `Foreign Group ${suffix}`, createdByUserId: headOfficeId })
    .returning({ id: groups.id })

  return {
    suffix,
    home: home.id,
    homeCode: home.code,
    foreign: foreign.id,
    north: north.id,
    south: south.id,
    abroad: abroad.id,
    homeGroup: homeGroup.id,
    foreignGroup: foreignGroup.id,
    superAdminId,
    headOfficeId,
    branchAdminId,
    groupUserId,
    orderPortalId,
    orphanOrderPortalId,
  }
}

async function destroyFixtures(f: Fixtures): Promise<void> {
  const orgs = [f.home, f.foreign]
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgs))
  await db.delete(userBranchAssignments).where(inArray(userBranchAssignments.organizationId, orgs))
  await db.delete(branches).where(inArray(branches.organizationId, orgs))
  await db.delete(groups).where(inArray(groups.id, [f.homeGroup, f.foreignGroup]))
  await db.delete(users).where(inArray(users.id, [
    f.superAdminId, f.headOfficeId, f.branchAdminId, f.groupUserId, f.orderPortalId, f.orphanOrderPortalId,
  ]))
  await db.delete(organizations).where(inArray(organizations.id, orgs))
}

function signIn(user: { id: string; role: string } | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    user === null ? null : ({ user: { ...user, email: "actor@example.test", mustChangePassword: false } } as any),
  )
}

async function list(query = "") {
  const response = await branchesRoute.GET(new Request(`http://localhost/api/v1/branches?refresh=1${query}`))
  const body = await response.json()
  return { status: response.status, body, ids: (body.items ?? []).map((item: { id: number }) => item.id) as number[] }
}

async function create(body: unknown) {
  const response = await branchesRoute.POST(new Request("http://localhost/api/v1/branches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
  return { status: response.status, body: await response.json() }
}

async function getOne(id: number | string) {
  const response = await branchRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: String(id) }) })
  return { status: response.status, body: await response.json() }
}

async function patchOne(id: number, body: unknown) {
  const response = await branchRoute.PATCH(new Request("http://localhost/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: String(id) }) })
  return { status: response.status, body: await response.json() }
}

async function deleteOne(id: number) {
  const response = await branchRoute.DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ id: String(id) }),
  })
  return { status: response.status, body: await response.json() }
}

const validBranch = (organizationId: number, name: string) => ({
  organizationId,
  name,
  province: "Sindh",
  city: "Karachi",
  address: "Plot 1, Street 2",
})

describe.skipIf(!hasTestDatabase)("branches API", () => {
  let f: Fixtures

  beforeAll(async () => {
    f = await createFixtures()
  })

  afterAll(async () => {
    if (f) await destroyFixtures(f)
    await closePool()
  })

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  describe("listing", () => {
    it("refuses anonymous callers and roles not on the list", async () => {
      signIn(null)
      expect((await list()).status).toBe(401)
      signIn({ id: f.superAdminId, role: "GROUP_ORDER_PORTAL" })
      expect((await list()).status).toBe(403)
    })

    it("shows Super Admin the tenants it asks for", async () => {
      signIn({ id: f.superAdminId, role: "SUPER_ADMIN" })
      const both = await list(`&organizationId=${f.home},${f.foreign}`)
      expect(both.ids).toEqual(expect.arrayContaining([f.north, f.south, f.abroad]))
      const one = await list(`&organizationId=${f.foreign}`)
      expect(one.ids).toEqual([f.abroad])
    })

    it("validates the organization filter", async () => {
      signIn({ id: f.superAdminId, role: "SUPER_ADMIN" })
      expect((await list("&organizationId=abc")).status).toBe(400)
      expect((await list("&organizationId=0")).status).toBe(400)
    })

    it("keeps Head Office inside its tenant whatever the query names", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const result = await list(`&organizationId=${f.foreign}`)
      expect(result.status).toBe(200)
      expect(result.ids.sort()).toEqual([f.north, f.south].sort())
    })

    it("shows a Branch Admin its own branch only", async () => {
      signIn({ id: f.branchAdminId, role: "BRANCH_ADMIN" })
      expect((await list()).ids).toEqual([f.north])
    })

    it("shows a Group User only its assigned branches", async () => {
      signIn({ id: f.groupUserId, role: "GROUP_USER" })
      expect((await list()).ids).toEqual([f.south])
    })

    it("lets an Order Portal user see its tenant's branches and nothing beyond", async () => {
      signIn({ id: f.orderPortalId, role: "ORDER_PORTAL" })
      const result = await list()
      expect(result.ids.sort()).toEqual([f.north, f.south].sort())
    })

    it("refuses any non-Super-Admin caller without an organization instead of listing every tenant", async () => {
      signIn({ id: f.orphanOrderPortalId, role: "ORDER_PORTAL" })
      const result = await list()
      expect(result.status).toBe(403)
      expect(result.ids).toEqual([])
    })

    it("filters by group", async () => {
      await db.update(branches).set({ groupId: f.homeGroup }).where(eq(branches.id, f.north))
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const result = await list(`&groupIds=${f.homeGroup}`)
      expect(result.ids).toEqual([f.north])
      expect(result.body.items[0].groupName).toBe(`Home Group ${f.suffix}`)
      await db.update(branches).set({ groupId: null }).where(eq(branches.id, f.north))
    })
  })

  describe("creating", () => {
    it("creates a branch with the next code in sequence and audits it", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const result = await create(validBranch(f.home, `East ${f.suffix}`))

      expect(result.status).toBe(201)
      expect(result.body.item).toMatchObject({ organizationId: f.home, code: `${f.homeCode}-03`, status: "active" })
      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "CREATE_BRANCH"),
        eq(auditLogs.entityId, String(result.body.item.id)),
      ))
      expect(audit).toMatchObject({ userId: f.headOfficeId, organizationId: f.home })
    })

    it("refuses a duplicate name, case- and space-insensitively", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const result = await create(validBranch(f.home, `  NORTH ${f.suffix.toUpperCase()} `))
      expect(result.status).toBe(409)
    })

    it("keeps Head Office from creating in another tenant", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const result = await create(validBranch(f.foreign, `Sneaky ${f.suffix}`))
      expect(result.status).toBe(403)
      expect(await db.select().from(branches).where(eq(branches.name, `Sneaky ${f.suffix}`))).toHaveLength(0)
    })

    it("lets Super Admin create anywhere, and answers 404 for an unknown tenant", async () => {
      signIn({ id: f.superAdminId, role: "SUPER_ADMIN" })
      expect((await create(validBranch(f.foreign, `Abroad Two ${f.suffix}`))).status).toBe(201)
      expect((await create(validBranch(2_147_483_000, `Nowhere ${f.suffix}`))).status).toBe(404)
    })

    it("refuses roles that may not create, and malformed bodies", async () => {
      signIn({ id: f.branchAdminId, role: "BRANCH_ADMIN" })
      expect((await create(validBranch(f.home, `X ${f.suffix}`))).status).toBe(403)

      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      expect((await create({ ...validBranch(f.home, "A"), })).status).toBe(400)
      expect((await create({ ...validBranch(f.home, `Y ${f.suffix}`), address: "x" })).status).toBe(400)
      expect((await create({ ...validBranch(f.home, `Z ${f.suffix}`), code: "MINE" })).status).toBe(400)
    })
  })

  describe("reading and editing one branch", () => {
    it("lets Head Office read its tenant's branch and refuses another tenant's", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      expect((await getOne(f.south)).status).toBe(200)
      expect((await getOne(f.abroad)).status).toBe(403)
      expect((await getOne(2_147_483_000)).status).toBe(404)
    })

    it("lets a Branch Admin read its own branch but not a sibling", async () => {
      signIn({ id: f.branchAdminId, role: "BRANCH_ADMIN" })
      expect((await getOne(f.north)).status).toBe(200)
      expect((await getOne(f.south)).status).toBe(403)
    })

    it("edits a branch, recording the before and after of only the touched fields", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const result = await patchOne(f.south, { city: "Lahore", groupId: f.homeGroup })
      expect(result.status).toBe(200)
      expect(result.body.item).toMatchObject({ city: "Lahore", groupId: f.homeGroup })

      const [audit] = await db.select().from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE_BRANCH"), eq(auditLogs.entityId, String(f.south))))
        .orderBy(desc(auditLogs.id))
        .limit(1)
      expect(JSON.stringify(audit.metadata)).toContain("Lahore")
      expect(JSON.stringify(audit.metadata)).not.toContain("adminUserId")
    })

    it("refuses another tenant's group, another tenant's branch, a duplicate name, and a bad status", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      expect((await patchOne(f.south, { groupId: f.foreignGroup })).status).toBe(400)
      expect((await patchOne(f.abroad, { city: "Lahore" })).status).toBe(403)
      expect((await patchOne(f.south, { name: `north ${f.suffix}` })).status).toBe(409)
      expect((await patchOne(f.south, { status: "closed" })).status).toBe(400)
      expect((await patchOne(f.south, {})).status).toBe(400)
      expect((await patchOne(2_147_483_000, { city: "Lahore" })).status).toBe(404)
    })

    it("keeps deactivation to Super Admin, and deactivates rather than deletes", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      expect((await deleteOne(f.south)).status).toBe(403)

      signIn({ id: f.superAdminId, role: "SUPER_ADMIN" })
      const result = await deleteOne(f.south)
      expect(result.status).toBe(200)
      expect(result.body.item.status).toBe("inactive")
      expect((await deleteOne(f.south)).status).toBe(400)
      expect((await deleteOne(2_147_483_000)).status).toBe(404)

      const [audit] = await db.select().from(auditLogs)
        .where(and(eq(auditLogs.action, "DEACTIVATE_BRANCH"), eq(auditLogs.entityId, String(f.south))))
      expect(audit.userId).toBe(f.superAdminId)
    })
  })
})
