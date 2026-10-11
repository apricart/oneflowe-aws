import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { eq, inArray } from "drizzle-orm"
import * as mockedNextAuth from "next-auth"

import * as branchCountsRoute from "@/app/api/v1/groups/[id]/branch-counts/route"
import * as groupBranchesRoute from "@/app/api/v1/groups/[id]/branches/route"
import * as cleanRoute from "@/app/api/v1/groups/[id]/branches/clean/route"
import * as groupRoute from "@/app/api/v1/groups/[id]/route"
import {
  auditLogs,
  branchInventory,
  branches,
  globalProducts,
  groupAuditLogs,
  groups,
  organizationInventory,
  organizations,
  roles,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Group administration: reading, renaming, deleting a group, choosing its
 * branches, counting them, and clearing a branch's products. Head Office acts
 * inside its tenant only; a branch can belong to one group at a time, and the
 * refusal for a branch held by another group must reach the user as the
 * actionable message it is, not as a server error.
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }))
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
  const [created] = await db.insert(roles).values({ name, description: "groups it" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const [home, foreign] = await db.insert(organizations).values([
    { name: `IT Grp Home ${suffix}`, code: `ITGH-${suffix}` },
    { name: `IT Grp Foreign ${suffix}`, code: `ITGFo-${suffix}` },
  ]).returning({ id: organizations.id })
  const [headOffice, superAdmin] = await db.insert(users).values([
    { email: `it-grp-ho-${suffix}@example.test`, username: `it-grp-ho-${suffix}`, passwordHash: "x", roleId: await roleId("HEAD_OFFICE"), organizationId: home.id },
    { email: `it-grp-sa-${suffix}@example.test`, username: `it-grp-sa-${suffix}`, passwordHash: "x", roleId: await roleId("SUPER_ADMIN") },
  ]).returning({ id: users.id })
  const [alpha, beta, foreignGroup] = await db.insert(groups).values([
    { organizationId: home.id, name: `Alpha ${suffix}`, createdByUserId: headOffice.id },
    { organizationId: home.id, name: `Beta ${suffix}`, createdByUserId: headOffice.id },
    { organizationId: foreign.id, name: `Foreign ${suffix}`, createdByUserId: superAdmin.id },
  ]).returning({ id: groups.id })
  const [one, two, inBeta, abroad] = await db.insert(branches).values([
    { organizationId: home.id, groupId: alpha.id, name: `One ${suffix}`, status: "active" },
    { organizationId: home.id, name: `Two ${suffix}`, status: "active" },
    { organizationId: home.id, groupId: beta.id, name: `In Beta ${suffix}`, status: "active" },
    { organizationId: foreign.id, groupId: foreignGroup.id, name: `Abroad ${suffix}`, status: "active" },
  ]).returning({ id: branches.id })

  const [product] = await db.insert(globalProducts).values({
    productCode: `ITGR2-${suffix}`, name: `Grp Product ${suffix}`, basePrice: 100, status: "active", unit: "unit",
  }).returning({ id: globalProducts.id })
  const [inventory] = await db.insert(organizationInventory).values({
    organizationId: home.id, globalProductId: product.id, assignedByUserId: superAdmin.id, isActive: true,
  }).returning({ id: organizationInventory.id })
  await db.insert(branchInventory).values({
    branchId: one.id, organizationId: home.id, organizationInventoryId: inventory.id, assignedByUserId: superAdmin.id, isVisible: true, isActive: true,
  })

  return {
    suffix,
    home: home.id,
    foreign: foreign.id,
    headOfficeId: headOffice.id,
    superAdminId: superAdmin.id,
    alpha: alpha.id,
    beta: beta.id,
    foreignGroup: foreignGroup.id,
    one: one.id,
    two: two.id,
    inBeta: inBeta.id,
    abroad: abroad.id,
    productId: product.id,
  }
}

async function destroyFixtures(f: Fixtures): Promise<void> {
  const orgs = [f.home, f.foreign]
  await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.organizationId, orgs))
  await db.delete(auditLogs).where(inArray(auditLogs.userId, [f.headOfficeId, f.superAdminId]))
  await db.delete(branchInventory).where(inArray(branchInventory.organizationId, orgs))
  await db.delete(organizationInventory).where(inArray(organizationInventory.organizationId, orgs))
  await db.delete(branches).where(inArray(branches.organizationId, orgs))
  await db.delete(groups).where(inArray(groups.organizationId, orgs))
  await db.delete(users).where(inArray(users.id, [f.headOfficeId, f.superAdminId]))
  await db.delete(globalProducts).where(eq(globalProducts.id, f.productId))
  await db.delete(organizations).where(inArray(organizations.id, orgs))
}

function signIn(actor: { id: string; role: string; organizationId: number | null } | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, email: "a@example.test", mustChangePassword: false } } as any),
  )
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })
const body = (method: string, payload?: unknown) => new Request("http://localhost/x", {
  method,
  headers: { "Content-Type": "application/json" },
  body: payload === undefined ? undefined : JSON.stringify(payload),
})

async function json(response: Response) {
  return { status: response.status, body: await response.json() }
}

describe.skipIf(!hasTestDatabase)("group administration", () => {
  let f: Fixtures
  const headOffice = () => ({ id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.home })

  beforeAll(async () => {
    f = await createFixtures()
  })
  afterAll(async () => {
    if (f) await destroyFixtures(f)
    await closePool()
  })
  beforeEach(() => {
    signIn(headOffice())
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  it("reads its own groups and refuses another tenant's", async () => {
    expect((await groupRoute.GET(body("GET") as any, params(f.alpha))).status).toBe(200)
    expect((await groupRoute.GET(body("GET") as any, params(f.foreignGroup))).status).toBe(403)
    expect((await groupRoute.GET(body("GET") as any, params("abc"))).status).toBe(400)
    expect((await groupRoute.GET(body("GET") as any, params(2_147_483_000))).status).toBe(404)
    signIn(null)
    expect((await groupRoute.GET(body("GET") as any, params(f.alpha))).status).toBe(401)
  })

  it("renames its own group, refuses a duplicate name and another tenant's group", async () => {
    expect((await groupRoute.PUT(body("PUT", { name: `Alpha Renamed ${f.suffix}` }) as any, params(f.alpha))).status).toBeLessThan(300)
    expect((await groupRoute.PUT(body("PUT", { name: `Beta ${f.suffix}` }) as any, params(f.alpha))).status).toBeGreaterThanOrEqual(400)
    expect((await groupRoute.PUT(body("PUT", { name: "x" }) as any, params(f.foreignGroup))).status).toBe(403)
    signIn({ id: f.headOfficeId, role: "BRANCH_ADMIN", organizationId: f.home })
    expect((await groupRoute.PUT(body("PUT", { name: "x" }) as any, params(f.alpha))).status).toBe(403)
  })

  it("counts and lists a group's branches", async () => {
    const counts = await json(await branchCountsRoute.GET(body("GET") as any, params(f.alpha)))
    expect(counts.status).toBe(200)
    const listed = await json(await groupBranchesRoute.GET(body("GET"), params(f.alpha)))
    expect(JSON.stringify(listed.body)).toContain(`One ${f.suffix}`)
    expect((await branchCountsRoute.GET(body("GET") as any, params(f.foreignGroup))).status).toBe(403)
    expect((await groupBranchesRoute.GET(body("GET"), params(f.foreignGroup))).status).toBe(403)
  })

  it("adds a free branch to a group, copying the group's products to it", async () => {
    const result = await json(await groupBranchesRoute.PUT(body("PUT", { branchIds: [f.one, f.two] }), params(f.alpha)))
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    const [two] = await db.select().from(branches).where(eq(branches.id, f.two))
    expect(two.groupId).toBe(f.alpha)
    const copied = await db.select().from(branchInventory).where(eq(branchInventory.branchId, f.two))
    expect(copied.length).toBeGreaterThan(0)
  })

  it("answers a branch held by another group with an actionable 409, not a server error", async () => {
    const result = await json(await groupBranchesRoute.PUT(body("PUT", { branchIds: [f.one, f.two, f.inBeta] }), params(f.alpha)))
    expect(result.status).toBe(409)
    expect(result.body.error).toBe(`These branches are already assigned to another group: In Beta ${f.suffix}. Please release them first.`)
    const [inBeta] = await db.select().from(branches).where(eq(branches.id, f.inBeta))
    expect(inBeta.groupId).toBe(f.beta)
  })

  it("refuses another tenant's branch without naming it", async () => {
    const result = await json(await groupBranchesRoute.PUT(body("PUT", { branchIds: [f.one, f.two, f.abroad] }), params(f.alpha)))
    expect(result.status).toBe(403)
    expect(JSON.stringify(result.body)).not.toContain(`Abroad ${f.suffix}`)
    const [abroad] = await db.select().from(branches).where(eq(branches.id, f.abroad))
    expect(abroad.groupId).toBe(f.foreignGroup)
  })

  it("refuses to drop a branch that still has products until they are cleaned, then cleans them", async () => {
    const blocked = await json(await groupBranchesRoute.PUT(body("PUT", { branchIds: [f.two] }), params(f.alpha)))
    expect(blocked.status).toBe(400)

    const cleaned = await json(await cleanRoute.POST(body("POST", { branchId: f.one }) as any, params(f.alpha)))
    expect(cleaned.status, JSON.stringify(cleaned.body)).toBeLessThan(300)
    const live = (await db.select().from(branchInventory).where(eq(branchInventory.branchId, f.one))).filter((row) => row.deletedAt === null)
    expect(live).toHaveLength(0)
    expect((await cleanRoute.POST(body("POST", { branchId: f.abroad }) as any, params(f.alpha))).status).toBe(404)
    expect((await cleanRoute.POST(body("POST", { branchId: f.abroad }) as any, params(f.foreignGroup))).status).toBe(403)
  })

  it("deletes its own group but not another tenant's", async () => {
    expect((await groupRoute.DELETE(body("DELETE") as any, params(f.foreignGroup))).status).toBe(403)
    const removed = await groupRoute.DELETE(body("DELETE") as any, params(f.beta))
    expect(removed.status).toBeLessThan(500)
  })
})
