import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray, isNull } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as assignmentsRoute from "@/app/api/v1/head-office/branch-assignments/route"
import * as toggleRoute from "@/app/api/v1/head-office/branch-assignments/toggle/route"
import * as orgInventoryRoute from "@/app/api/v1/head-office/organization-inventory/route"
import {
  auditLogs,
  branchInventory,
  branches,
  globalProducts,
  groups,
  organizationInventory,
  organizations,
  roles,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The Head Office catalogue routes: which branches stock which of the
 * tenant's products, switching a product on and off per group, and the
 * tenant's own catalogue listing.
 *
 * ```text
 * tenant A                     tenant B
 *   group G: A1, A2              B1
 *   A3 (no group)
 *   catalogue: I1 (P1), I2 (P2)  catalogue: J1 (P1)
 * ```
 *
 * Head Office sessions carry their organization on the token (these routes
 * authorize from the session, which the session callback keeps equal to the
 * database). Every case that names tenant B from a tenant-A session must come
 * back refused and leave B's rows untouched.
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
vi.mock("@/lib/global-logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/global-logger")>()
  return { ...actual, logInventoryAction: vi.fn(), logEvent: vi.fn() }
})

const { getServerSession } = mockedNextAuth

type Fixtures = Awaited<ReturnType<typeof createFixtures>>

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "head office it" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const [a, b] = await db.insert(organizations).values([
    { name: `IT HO A ${suffix}`, code: `ITHOA-${suffix}` },
    { name: `IT HO B ${suffix}`, code: `ITHOB-${suffix}` },
  ]).returning({ id: organizations.id })

  const [headOffice, foreignHeadOffice, superAdmin] = await db.insert(users).values([
    { email: `it-ho-a-${suffix}@example.test`, username: `it-ho-a-${suffix}`, passwordHash: "x", roleId: await roleId("HEAD_OFFICE"), organizationId: a.id },
    { email: `it-ho-b-${suffix}@example.test`, username: `it-ho-b-${suffix}`, passwordHash: "x", roleId: await roleId("HEAD_OFFICE"), organizationId: b.id },
    { email: `it-ho-sa-${suffix}@example.test`, username: `it-ho-sa-${suffix}`, passwordHash: "x", roleId: await roleId("SUPER_ADMIN"), organizationId: null },
  ]).returning({ id: users.id })

  const [group] = await db.insert(groups)
    .values({ organizationId: a.id, name: `G ${suffix}`, createdByUserId: headOffice.id })
    .returning({ id: groups.id })
  const [foreignGroup] = await db.insert(groups)
    .values({ organizationId: b.id, name: `GB ${suffix}`, createdByUserId: foreignHeadOffice.id })
    .returning({ id: groups.id })

  const [a1, a2, a3, b1] = await db.insert(branches).values([
    { organizationId: a.id, groupId: group.id, name: `A1 ${suffix}`, status: "active" },
    { organizationId: a.id, groupId: group.id, name: `A2 ${suffix}`, status: "active" },
    { organizationId: a.id, name: `A3 ${suffix}`, status: "active" },
    { organizationId: b.id, groupId: foreignGroup.id, name: `B1 ${suffix}`, status: "active" },
  ]).returning({ id: branches.id })

  const [p1, p2] = await db.insert(globalProducts).values([
    { productCode: `ITHO-1-${suffix}`, name: `Product One ${suffix}`, basePrice: 1_000, status: "active", unit: "unit" },
    { productCode: `ITHO-2-${suffix}`, name: `Product Two ${suffix}`, basePrice: 2_000, status: "active", unit: "unit" },
  ]).returning({ id: globalProducts.id })

  const [i1, i2, j1] = await db.insert(organizationInventory).values([
    { organizationId: a.id, globalProductId: p1.id, assignedByUserId: superAdmin.id, isActive: true, customPrice: 1_500 },
    { organizationId: a.id, globalProductId: p2.id, assignedByUserId: superAdmin.id, isActive: true },
    { organizationId: b.id, globalProductId: p1.id, assignedByUserId: superAdmin.id, isActive: true },
  ]).returning({ id: organizationInventory.id })

  // Tenant B already stocks J1 at B1.
  const [b1Row] = await db.insert(branchInventory).values({
    branchId: b1.id,
    organizationId: b.id,
    organizationInventoryId: j1.id,
    assignedByUserId: foreignHeadOffice.id,
    isVisible: true,
    isActive: true,
  }).returning({ id: branchInventory.id })

  return {
    suffix,
    a: a.id,
    b: b.id,
    headOfficeId: headOffice.id,
    foreignHeadOfficeId: foreignHeadOffice.id,
    superAdminId: superAdmin.id,
    group: group.id,
    foreignGroup: foreignGroup.id,
    a1: a1.id,
    a2: a2.id,
    a3: a3.id,
    b1: b1.id,
    p1: p1.id,
    p2: p2.id,
    i1: i1.id,
    i2: i2.id,
    j1: j1.id,
    b1Row: b1Row.id,
  }
}

async function destroyFixtures(f: Fixtures): Promise<void> {
  const orgs = [f.a, f.b]
  await db.delete(auditLogs).where(inArray(auditLogs.userId, [f.headOfficeId, f.foreignHeadOfficeId, f.superAdminId]))
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgs))
  await db.delete(branchInventory).where(inArray(branchInventory.organizationId, orgs))
  await db.delete(branchInventory).where(inArray(branchInventory.branchId, [f.a1, f.a2, f.a3, f.b1]))
  await db.delete(organizationInventory).where(inArray(organizationInventory.organizationId, orgs))
  await db.delete(branches).where(inArray(branches.organizationId, orgs))
  await db.delete(groups).where(inArray(groups.id, [f.group, f.foreignGroup]))
  await db.delete(users).where(inArray(users.id, [f.headOfficeId, f.foreignHeadOfficeId, f.superAdminId]))
  await db.delete(globalProducts).where(inArray(globalProducts.id, [f.p1, f.p2]))
  await db.delete(organizations).where(inArray(organizations.id, orgs))
}

type Actor = { id: string; role: string; organizationId: number | null }

function signIn(actor: Actor | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, email: "actor@example.test", mustChangePassword: false } } as any),
  )
}

function request(path: string, method = "GET", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function json(response: Response) {
  return { status: response.status, body: await response.json() }
}

async function liveRows(organizationId: number) {
  return db.select().from(branchInventory)
    .where(and(eq(branchInventory.organizationId, organizationId), isNull(branchInventory.deletedAt)))
}

describe.skipIf(!hasTestDatabase)("Head Office catalogue routes", () => {
  let f: Fixtures
  const headOffice = (): Actor => ({ id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.a })
  const superAdmin = (): Actor => ({ id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null })

  beforeAll(async () => {
    f = await createFixtures()
  })

  afterAll(async () => {
    if (f) await destroyFixtures(f)
    await closePool()
  })

  beforeEach(async () => {
    await db.delete(branchInventory).where(eq(branchInventory.organizationId, f.a))
    await db.delete(branchInventory).where(and(eq(branchInventory.branchId, f.b1), eq(branchInventory.organizationId, f.a)))
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    signIn(headOffice())
  })

  describe("assigning products to branches", () => {
    it("refuses anonymous callers and other roles", async () => {
      signIn(null)
      expect((await assignmentsRoute.GET(request("/x"))).status).toBe(401)
      signIn({ id: f.headOfficeId, role: "BRANCH_ADMIN", organizationId: f.a })
      expect((await assignmentsRoute.POST(request("/x", "POST", {}))).status).toBe(403)
    })

    it("assigns to every branch of a group, auditing the write", async () => {
      const result = await json(await assignmentsRoute.POST(request("/x", "POST", {
        organizationInventoryIds: [f.i1, f.i2],
        groupId: f.group,
      })))

      expect(result.status).toBe(200)
      expect(result.body).toMatchObject({ branchCount: 2, skipped: 0, groupName: `G ${f.suffix}` })
      const rows = await liveRows(f.a)
      expect(rows.map((row) => `${row.organizationInventoryId}-${row.branchId}`).sort()).toEqual([
        `${f.i1}-${f.a1}`, `${f.i1}-${f.a2}`, `${f.i2}-${f.a1}`, `${f.i2}-${f.a2}`,
      ].sort())

      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.organizationId, f.a),
        eq(auditLogs.entity, "BranchAssignment"),
        eq(auditLogs.action, "CREATE"),
      ))
      expect(audit.userId).toBe(f.headOfficeId)
    })

    it("is idempotent: a repeat assigns nothing more", async () => {
      await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.i1], branchIds: [f.a3] }))
      const repeat = await json(await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.i1], branchIds: [f.a3] })))
      expect(repeat.body.message).toBe("All selected products are already assigned to the selected branches")
      expect(await liveRows(f.a)).toHaveLength(1)
    })

    it("restores a removed assignment rather than duplicating it", async () => {
      await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.i1], branchIds: [f.a3] }))
      const [row] = await liveRows(f.a)
      await assignmentsRoute.DELETE(request(`/x?id=${row.id}`, "DELETE"))
      expect(await liveRows(f.a)).toHaveLength(0)

      await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.i1], branchIds: [f.a3] }))
      const restored = await liveRows(f.a)
      expect(restored.map((r) => r.id)).toEqual([row.id])
    })

    it("refuses another tenant's branch named directly, writing nothing", async () => {
      const result = await json(await assignmentsRoute.POST(request("/x", "POST", {
        organizationInventoryIds: [f.i1],
        branchIds: [f.a3, f.b1],
      })))
      expect(result.status).toBe(403)
      expect(await db.select().from(branchInventory).where(and(
        eq(branchInventory.branchId, f.b1),
        eq(branchInventory.organizationId, f.a),
      ))).toHaveLength(0)
      expect(await liveRows(f.a)).toHaveLength(0)
    })

    it("refuses another tenant's group and another tenant's catalogue entry", async () => {
      expect((await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.i1], groupId: f.foreignGroup }))).status).toBe(403)
      expect((await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.j1], branchIds: [f.a3] }))).status).toBe(400)
    })

    it("ignores an organization named in the body by Head Office", async () => {
      const result = await json(await assignmentsRoute.POST(request("/x", "POST", {
        organizationId: f.b,
        organizationInventoryIds: [f.j1],
        branchIds: [f.b1],
      })))
      expect(result.status).toBe(403)
      expect(await db.select().from(branchInventory).where(eq(branchInventory.organizationInventoryId, f.j1))).toHaveLength(1)
    })

    it("validates the body", async () => {
      expect((await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [], branchIds: [f.a3] }))).status).toBe(400)
      expect((await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: ["x"], branchIds: [f.a3] }))).status).toBe(400)
      expect((await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.i1] }))).status).toBe(400)
      expect((await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.i1], branchIds: [0] }))).status).toBe(400)
    })

    it("lets Super Admin assign for a tenant it names", async () => {
      signIn(superAdmin())
      const result = await json(await assignmentsRoute.POST(request("/x", "POST", {
        organizationId: f.a,
        organizationInventoryIds: [f.i2],
        branchIds: [f.a3],
      })))
      expect(result.status).toBe(200)
      expect(await liveRows(f.a)).toHaveLength(1)
    })
  })

  describe("listing assignments", () => {
    beforeEach(async () => {
      await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.i1, f.i2], groupId: f.group }))
      await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.i1], branchIds: [f.a3] }))
    })

    it("lists one row per branch, inside the tenant, with the organization price", async () => {
      const result = await json(await assignmentsRoute.GET(request("/x")))
      expect(result.body.total).toBe(5)
      expect(result.body.items.every((item: any) => item.organizationId === f.a)).toBe(true)
      const i1Row = result.body.items.find((item: any) => item.organizationInventoryId === f.i1)
      expect(i1Row.customPrice).toBe(1_500)
    })

    it("filters by branch, group and product", async () => {
      expect((await json(await assignmentsRoute.GET(request(`/x?branchId=${f.a3}`)))).body.total).toBe(1)
      expect((await json(await assignmentsRoute.GET(request(`/x?groupId=${f.group}`)))).body.total).toBe(4)
      expect((await json(await assignmentsRoute.GET(request(`/x?productId=${f.p2}`)))).body.total).toBe(2)
    })

    it("reports which products cover the whole group and which only part of it", async () => {
      await db.update(branchInventory).set({ deletedAt: new Date() })
        .where(and(eq(branchInventory.organizationInventoryId, f.i2), eq(branchInventory.branchId, f.a2)))

      const state = await json(await assignmentsRoute.GET(request(`/x?view=assignment-state&groupId=${f.group}`)))
      expect(state.body).toEqual({
        organizationInventoryIds: [f.i1],
        partialOrganizationInventoryIds: [f.i2],
        branchCount: 2,
      })
    })

    it("collapses the group view to one row per product", async () => {
      const view = await json(await assignmentsRoute.GET(request(`/x?view=group-products&groupId=${f.group}`)))
      expect(view.body.total).toBe(2)
      expect(view.body.items.map((item: any) => item.branchCount)).toEqual([2, 2])
    })

    it("refuses a group view without a group or for another tenant's group", async () => {
      expect((await assignmentsRoute.GET(request("/x?view=group-products"))).status).toBe(400)
      expect((await assignmentsRoute.GET(request(`/x?view=assignment-state&groupId=${f.foreignGroup}`))).status).toBe(404)
    })

    it("does not let Head Office list another tenant by naming it", async () => {
      const result = await json(await assignmentsRoute.GET(request(`/x?organizationId=${f.b}`)))
      expect(result.body.items.every((item: any) => item.organizationId === f.a)).toBe(true)
    })
  })

  describe("removing and editing assignments", () => {
    beforeEach(async () => {
      await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.i1, f.i2], groupId: f.group }))
    })

    it("removes by product across branches, softly", async () => {
      const result = await json(await assignmentsRoute.DELETE(request(`/x?productId=${f.p1}`, "DELETE")))
      expect(result).toEqual({ status: 200, body: { message: "Branch assignments removed successfully", count: 2 } })
      expect((await liveRows(f.a)).map((row) => row.organizationInventoryId)).toEqual([f.i2, f.i2])
    })

    it("removes everything at one branch", async () => {
      expect((await json(await assignmentsRoute.DELETE(request(`/x?branchId=${f.a1}`, "DELETE")))).body.count).toBe(2)
    })

    it("cannot reach another tenant's assignment by id", async () => {
      expect((await assignmentsRoute.DELETE(request(`/x?id=${f.b1Row}`, "DELETE"))).status).toBe(404)
      const [b1Row] = await db.select().from(branchInventory).where(eq(branchInventory.id, f.b1Row))
      expect(b1Row.deletedAt).toBeNull()
    })

    it("gives a Head Office without an organization nothing to delete, even by the row's own id", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: null })
      expect((await assignmentsRoute.DELETE(request(`/x?id=${f.b1Row}`, "DELETE"))).status).toBe(400)
      const [b1Row] = await db.select().from(branchInventory).where(eq(branchInventory.id, f.b1Row))
      expect(b1Row.deletedAt).toBeNull()
    })

    it("requires something to delete by", async () => {
      expect((await assignmentsRoute.DELETE(request("/x", "DELETE"))).status).toBe(400)
    })

    it("hides an assignment from the shop, and cannot touch another tenant's", async () => {
      const [row] = await liveRows(f.a)
      const result = await json(await assignmentsRoute.PUT(request("/x", "PUT", { id: row.id, isVisible: false })))
      expect(result.body.assignment.isVisible).toBe(false)

      expect((await assignmentsRoute.PUT(request("/x", "PUT", { id: f.b1Row, isVisible: false }))).status).toBe(404)
      expect((await assignmentsRoute.PUT(request("/x", "PUT", {}))).status).toBe(400)
    })
  })

  describe("switching a product per group", () => {
    beforeEach(async () => {
      await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.i1], groupId: f.group }))
    })

    it("reports the product's groups and status", async () => {
      const result = await json(await toggleRoute.GET(request(`/x?organizationInventoryId=${f.i1}&organizationId=${f.a}`)))
      expect(result.body.groups).toEqual([expect.objectContaining({ groupId: f.group, allActive: true, allInactive: false })])
      expect(result.body.groups[0].branches).toHaveLength(2)
    })

    it("refuses to report another tenant's product to Head Office", async () => {
      const result = await toggleRoute.GET(request(`/x?organizationInventoryId=${f.j1}&organizationId=${f.b}`))
      expect(result.status).toBe(403)
    })

    it("lets Super Admin read any tenant", async () => {
      signIn(superAdmin())
      const result = await json(await toggleRoute.GET(request(`/x?organizationInventoryId=${f.j1}&organizationId=${f.b}`)))
      expect(result.body.groups[0].groupId).toBe(f.foreignGroup)
    })

    it("deactivates and hides the product across the group, and refuses another tenant", async () => {
      const off = await json(await toggleRoute.PUT(request("/x", "PUT", {
        organizationInventoryId: f.i1,
        organizationId: f.a,
        isActive: false,
        groupIds: [f.group],
      })))
      expect(off.body.updatedCount).toBe(2)
      expect((await liveRows(f.a)).every((row) => !row.isActive && !row.isVisible)).toBe(true)

      expect((await toggleRoute.PUT(request("/x", "PUT", {
        organizationInventoryId: f.j1,
        organizationId: f.b,
        isActive: false,
        groupIds: "all",
      }))).status).toBe(403)
      const [b1Row] = await db.select().from(branchInventory).where(eq(branchInventory.id, f.b1Row))
      expect(b1Row.isActive).toBe(true)
    })

    it("answers 400 when the chosen groups hold no branches, or the body is malformed", async () => {
      expect((await toggleRoute.PUT(request("/x", "PUT", {
        organizationInventoryId: f.i1,
        organizationId: f.a,
        isActive: true,
        groupIds: [f.foreignGroup],
      }))).status).toBe(400)
      expect((await toggleRoute.PUT(request("/x", "PUT", { isActive: true }))).status).toBe(400)
      expect((await toggleRoute.GET(request("/x"))).status).toBe(400)
    })
  })

  describe("the tenant catalogue", () => {
    it("shows Head Office its own catalogue without the global base price", async () => {
      const result = await json(await orgInventoryRoute.GET(request(`/x?organizationId=${f.b}`)))
      expect(result.status).toBe(200)
      const ids = result.body.items.map((item: any) => item.id)
      expect(ids.sort()).toEqual([f.i1, f.i2].sort())
      expect(result.body.canViewGlobalBasePrice).toBe(false)
      expect(result.body.items.every((item: any) => item.basePrice === null)).toBe(true)
      const one = result.body.items.find((item: any) => item.id === f.i1)
      expect(one.effectivePriceCents).toBe(1_500)
      const two = result.body.items.find((item: any) => item.id === f.i2)
      expect(two.effectivePriceCents).toBe(2_000)
    })

    it("shows Super Admin the base price for the tenant it names", async () => {
      signIn(superAdmin())
      const result = await json(await orgInventoryRoute.GET(request(`/x?organizationId=${f.b}`)))
      expect(result.body.items.map((item: any) => item.id)).toEqual([f.j1])
      expect(result.body.items[0].basePrice).toBe(1_000)
    })

    it("keeps editing to Super Admin", async () => {
      expect((await orgInventoryRoute.PUT(request("/x", "PUT", { id: f.i1, customName: "Mine" }))).status).toBe(403)
    })

    it("lets Super Admin rename and switch off a product, cascading to its branches", async () => {
      await assignmentsRoute.POST(request("/x", "POST", { organizationInventoryIds: [f.i2], groupId: f.group }))
      signIn(superAdmin())

      const result = await json(await orgInventoryRoute.PUT(request("/x", "PUT", {
        id: f.i2,
        organizationId: f.a,
        customName: "Renamed",
        isActive: false,
      })))
      expect(result.status).toBe(200)
      expect(result.body.inventory).toMatchObject({ customName: "Renamed", isActive: false })
      expect((await liveRows(f.a)).every((row) => row.isActive === false)).toBe(true)

      await orgInventoryRoute.PUT(request("/x", "PUT", { id: f.i2, organizationId: f.a, isActive: true }))
    })

    it("validates the edit and refuses another tenant's row", async () => {
      signIn(superAdmin())
      expect((await orgInventoryRoute.PUT(request("/x", "PUT", { organizationId: f.a }))).status).toBe(400)
      expect((await orgInventoryRoute.PUT(request("/x", "PUT", { id: f.i1, organizationId: f.a, isActive: "yes" }))).status).toBe(400)
      expect((await orgInventoryRoute.PUT(request("/x", "PUT", { id: f.i1, organizationId: f.a, customPrice: -1 }))).status).toBe(400)
      expect((await orgInventoryRoute.PUT(request("/x", "PUT", { id: f.i1, organizationId: f.a, customImageUrl: "javascript:alert(1)" }))).status).toBe(400)
      expect((await orgInventoryRoute.PUT(request("/x", "PUT", { id: f.j1, organizationId: f.a, customName: "x" }))).status).toBe(404)
    })
  })
})
