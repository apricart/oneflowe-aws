import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { eq, inArray, like } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as categoriesRoute from "@/app/api/v1/categories/route"
import * as groupsRoute from "@/app/api/v1/groups/route"
import * as branchProductsRoute from "@/app/api/v1/inventory/branch-products/route"
import * as orgProductsRoute from "@/app/api/v1/inventory/organization-products/route"
import * as modifiersRoute from "@/app/api/v1/modifiers/route"
import * as notificationsRoute from "@/app/api/v1/notifications/route"
import * as settingsRoute from "@/app/api/v1/settings/route"
import * as subcategoriesRoute from "@/app/api/v1/subcategories/route"
import * as suppliersRoute from "@/app/api/v1/suppliers/route"
import {
  auditLogs,
  branches,
  categories,
  globalProducts,
  groupAuditLogs,
  groups,
  modifiers,
  notifications,
  organizationProducts,
  organizationSettings,
  organizations,
  roles,
  suppliers,
  systemLogs,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The catalogue and tenant-administration routes: categories, subcategories,
 * modifiers, groups, suppliers, organization settings, notifications and the
 * legacy organization/branch product listings.
 *
 * Each is held to its role allowlist, to the caller's tenant where it has
 * one, and run through its main write path once so a broken query fails here
 * rather than in production.
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
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
type Actor = { id: string; role: string; organizationId: number | null; branchId?: number | null }

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "catalogue it" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const [home, foreign] = await db.insert(organizations).values([
    { name: `IT Cat Home ${suffix}`, code: `ITCH-${suffix}` },
    { name: `IT Cat Foreign ${suffix}`, code: `ITCF-${suffix}` },
  ]).returning({ id: organizations.id })
  const [north, abroad] = await db.insert(branches).values([
    { organizationId: home.id, name: `Cat North ${suffix}`, status: "active" },
    { organizationId: foreign.id, name: `Cat Abroad ${suffix}`, status: "active" },
  ]).returning({ id: branches.id })

  const person = async (label: string, role: string, organizationId: number | null, branchId: number | null = null) => {
    const [row] = await db.insert(users).values({
      email: `it-cat-${label}-${suffix}@example.test`,
      username: `it-cat-${label}-${suffix}`,
      passwordHash: "x",
      roleId: await roleId(role),
      organizationId,
      branchId,
    }).returning({ id: users.id })
    return row.id
  }

  const superAdminId = await person("sa", "SUPER_ADMIN", null)
  const headOfficeId = await person("ho", "HEAD_OFFICE", home.id)
  const branchAdminId = await person("ba", "BRANCH_ADMIN", home.id, north.id)
  const orderPortalId = await person("op", "ORDER_PORTAL", home.id, north.id)

  const [product] = await db.insert(globalProducts).values({
    productCode: `ITC-${suffix}`, name: `Cat Product ${suffix}`, basePrice: 1_000, status: "active", unit: "unit",
  }).returning({ id: globalProducts.id })
  await db.insert(organizationProducts).values({
    organizationId: foreign.id,
    globalProductId: product.id,
    customPrice: 777,
    customName: `Foreign Secret Name ${suffix}`,
    isEnabled: true,
  } as any)

  return {
    suffix,
    home: home.id,
    foreign: foreign.id,
    north: north.id,
    abroad: abroad.id,
    superAdminId,
    headOfficeId,
    branchAdminId,
    orderPortalId,
    productId: product.id,
  }
}

async function destroyFixtures(f: Fixtures): Promise<void> {
  const orgs = [f.home, f.foreign]
  const people = [f.superAdminId, f.headOfficeId, f.branchAdminId, f.orderPortalId]
  await db.delete(notifications).where(inArray(notifications.userId, people))
  await db.delete(auditLogs).where(inArray(auditLogs.userId, people))
  await db.delete(systemLogs).where(inArray(systemLogs.userId, people))
  await db.delete(suppliers).where(inArray(suppliers.organizationId, orgs))
  await db.delete(organizationSettings).where(inArray(organizationSettings.organizationId, orgs))
  await db.delete(organizationProducts).where(inArray(organizationProducts.organizationId, orgs))
  const groupIds = (await db.select({ id: groups.id }).from(groups).where(inArray(groups.organizationId, orgs))).map((row) => row.id)
  if (groupIds.length) await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.groupId, groupIds))
  await db.delete(groups).where(inArray(groups.organizationId, orgs))
  await db.delete(branches).where(inArray(branches.organizationId, orgs))
  await db.delete(modifiers).where(like(modifiers.name, `%${f.suffix}%`))
  await db.delete(categories).where(like(categories.name, `Sub %${f.suffix}%`))
  await db.delete(categories).where(like(categories.name, `%${f.suffix}%`))
  await db.delete(users).where(inArray(users.id, people))
  await db.delete(globalProducts).where(eq(globalProducts.id, f.productId))
  await db.delete(organizations).where(inArray(organizations.id, orgs))
}

function signIn(actor: Actor | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, email: "a@example.test", mustChangePassword: false } } as any),
  )
}

function req(path: string, method = "GET", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function json(response: Response) {
  return { status: response.status, body: await response.json() }
}

describe.skipIf(!hasTestDatabase)("catalogue and administration routes", () => {
  let f: Fixtures
  const sa = (): Actor => ({ id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null })
  const ho = (): Actor => ({ id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.home })
  const ba = (): Actor => ({ id: f.branchAdminId, role: "BRANCH_ADMIN", organizationId: f.home, branchId: f.north })
  const op = (): Actor => ({ id: f.orderPortalId, role: "ORDER_PORTAL", organizationId: f.home, branchId: f.north })

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
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  describe("categories and subcategories", () => {
    it("are written by Super Admin only", async () => {
      for (const actor of [ho(), ba(), op()]) {
        signIn(actor)
        expect((await categoriesRoute.POST(req("/x", "POST", { name: `Nope ${f.suffix}` }))).status, actor.role).toBe(403)
        expect((await subcategoriesRoute.POST(req("/x", "POST", { name: "x", categoryId: 1 }))).status, actor.role).toBe(403)
        expect((await categoriesRoute.DELETE(req("/x?id=1", "DELETE"))).status, actor.role).toBe(403)
      }
      signIn(null)
      expect((await categoriesRoute.GET(req("/x"))).status).toBe(401)
    })

    it("go through their whole life: create, refuse a duplicate, rename, nest, refuse deleting a parent, delete", async () => {
      signIn(sa())
      const parent = await json(await categoriesRoute.POST(req("/x", "POST", { name: `Stationery ${f.suffix}` })))
      expect(parent.status, JSON.stringify(parent.body)).toBeLessThan(300)
      const parentId = parent.body.category?.id ?? parent.body.item?.id ?? parent.body.id
      expect(parentId).toBeTruthy()

      // Duplicates are matched exactly (case-sensitively), for categories and subcategories alike.
      expect((await categoriesRoute.POST(req("/x", "POST", { name: `Stationery ${f.suffix}` }))).status).toBe(409)
      expect((await categoriesRoute.POST(req("/x", "POST", { name: " " }))).status).toBe(400)

      const sub = await json(await subcategoriesRoute.POST(req("/x", "POST", { name: `Sub Paper ${f.suffix}`, categoryId: parentId })))
      expect(sub.status, JSON.stringify(sub.body)).toBeLessThan(300)
      const subId = sub.body.subcategory?.id ?? sub.body.item?.id ?? sub.body.id
      expect((await subcategoriesRoute.POST(req("/x", "POST", { name: `Sub Paper ${f.suffix}`, categoryId: parentId }))).status).toBe(409)
      expect((await subcategoriesRoute.POST(req("/x", "POST", { name: "x", categoryId: 2_147_483_000 }))).status).toBe(404)

      expect((await categoriesRoute.PUT(req("/x", "PUT", { id: parentId, name: `Stationery & Co ${f.suffix}` }))).status).toBeLessThan(300)
      expect((await categoriesRoute.PUT(req("/x", "PUT", { id: parentId, name: "x", parentId }))).status).toBe(400)
      expect((await categoriesRoute.PUT(req("/x", "PUT", { id: 2_147_483_000, name: "x" }))).status).toBe(404)

      expect((await categoriesRoute.DELETE(req(`/x?id=${parentId}`, "DELETE"))).status).toBe(400)
      expect((await subcategoriesRoute.DELETE(req(`/x?id=${subId}`, "DELETE"))).status).toBeLessThan(300)
      expect((await categoriesRoute.DELETE(req(`/x?id=${parentId}`, "DELETE"))).status).toBeLessThan(300)

      const list = await json(await categoriesRoute.GET(req("/x")))
      expect(JSON.stringify(list.body)).not.toContain(`Stationery & Co ${f.suffix}`)
    })
  })

  describe("modifiers", () => {
    it("are Super Admin only, refuse duplicates and go through their life", async () => {
      signIn(ho())
      expect((await modifiersRoute.GET(req("/x"))).status).toBe(403)
      signIn(sa())
      const created = await json(await modifiersRoute.POST(req("/x", "POST", { name: `Size ${f.suffix}`, type: "size", status: "active" })))
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
      const id = created.body.modifier?.id ?? created.body.item?.id ?? created.body.id
      expect((await modifiersRoute.POST(req("/x", "POST", { name: `Size ${f.suffix}`, type: "size" }))).status).toBe(409)
      expect((await modifiersRoute.POST(req("/x", "POST", { name: `No type ${f.suffix}` }))).status).toBe(400)
      expect((await modifiersRoute.PUT(req("/x", "PUT", { id, name: `Size L ${f.suffix}`, type: "size" }))).status).toBeLessThan(300)
      expect((await modifiersRoute.PUT(req("/x", "PUT", { id: 2_147_483_000, name: "x", type: "size" }))).status).toBe(404)
      expect(JSON.stringify((await json(await modifiersRoute.GET(req("/x")))).body)).toContain(`Size L ${f.suffix}`)
      expect((await modifiersRoute.DELETE(req(`/x?id=${id}`, "DELETE"))).status).toBeLessThan(300)
      expect((await modifiersRoute.DELETE(req("/x", "DELETE"))).status).toBe(400)
    })
  })

  describe("groups", () => {
    it("lets Head Office create groups in its own tenant only", async () => {
      signIn(ho())
      const created = await json(await groupsRoute.POST(req("/x", "POST", { organizationId: f.home, name: `G ${f.suffix}` })))
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
      // A tenant named in the body is replaced with Head Office's own, never honoured.
      await groupsRoute.POST(req("/x", "POST", { organizationId: f.foreign, name: `GF ${f.suffix}` }))
      expect(await db.select().from(groups).where(eq(groups.organizationId, f.foreign))).toHaveLength(0)

      const [redirected] = await db.select().from(groups).where(eq(groups.name, `GF ${f.suffix}`))
      expect(redirected.organizationId).toBe(f.home)

      const listed = await json(await groupsRoute.GET(req(`/x?organizationId=${f.foreign}`)))
      expect((listed.body.groups as any[]).every((group) => group.organizationId === f.home)).toBe(true)
    })

    it("refuses roles that may not create groups", async () => {
      signIn(op())
      expect((await groupsRoute.POST(req("/x", "POST", { organizationId: f.home, name: `GX ${f.suffix}` }))).status).toBe(403)
    })
  })

  describe("suppliers", () => {
    it("are created inside the caller's tenant and refused outside it", async () => {
      signIn(ho())
      const created = await json(await suppliersRoute.POST(req("/x", "POST", {
        organizationId: f.home, branchId: f.north, name: `Supplier ${f.suffix}`, email: "",
      })))
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)

      const foreign = await suppliersRoute.POST(req("/x", "POST", { organizationId: f.foreign, branchId: f.abroad, name: `SupplierF ${f.suffix}` }))
      expect(foreign.status).toBeGreaterThanOrEqual(400)
      const mismatched = await suppliersRoute.POST(req("/x", "POST", { organizationId: f.home, branchId: f.abroad, name: `SupplierM ${f.suffix}` }))
      expect(mismatched.status).toBeGreaterThanOrEqual(400)

      const listed = await json(await suppliersRoute.GET(req("/x")))
      expect(JSON.stringify(listed.body)).toContain(`Supplier ${f.suffix}`)
      expect(JSON.stringify(listed.body)).not.toContain(`SupplierF ${f.suffix}`)

      signIn(ba())
      expect((await suppliersRoute.GET(req("/x"))).status).toBe(403)
    })
  })

  describe("organization settings", () => {
    it("answers Head Office with its own settings whatever organization the query names", async () => {
      await db.insert(organizationSettings).values({ organizationId: f.foreign, key: "default_currency", value: "EUR" })
      signIn(ho())
      expect((await settingsRoute.GET(req(`/x?organizationId=${f.home}`))).status).toBe(200)
      const asked = await json(await settingsRoute.GET(req(`/x?organizationId=${f.foreign}`)))
      expect(JSON.stringify(asked.body)).not.toContain("EUR")
      expect((await settingsRoute.POST(req("/x", "POST", { organizationId: f.foreign, key: "default_currency", value: "USD" }))).status).toBe(403)
      signIn(op())
      expect((await settingsRoute.GET(req(`/x?organizationId=${f.home}`))).status).toBe(403)
    })

    it("refuses unknown keys and validates the body", async () => {
      signIn(sa())
      expect((await settingsRoute.POST(req("/x", "POST", { organizationId: f.home, key: "not_a_real_key", value: 1 }))).status).toBe(400)
      expect((await settingsRoute.POST(req("/x", "POST", { key: "x" }))).status).toBe(400)
    })

    it("lets Super Admin write and remove a known setting", async () => {
      signIn(sa())
      const written = await json(await settingsRoute.POST(req("/x", "POST", { organizationId: f.home, key: "budget_allocation_mode", value: "quantity" })))
      expect(written.status, JSON.stringify(written.body)).toBeLessThan(300)
      const [row] = await db.select().from(organizationSettings).where(eq(organizationSettings.organizationId, f.home))
      expect(row.value).toBe("quantity")
      expect((await settingsRoute.DELETE(req("/x", "DELETE"))).status).toBe(400)
      expect((await settingsRoute.DELETE(req("/x?id=2147483000", "DELETE"))).status).toBe(404)
      const removed = await settingsRoute.DELETE(req(`/x?id=${row.id}`, "DELETE"))
      expect(removed.status).toBeLessThan(300)
      expect(await db.select().from(organizationSettings).where(eq(organizationSettings.id, row.id))).toHaveLength(0)

      signIn(ho())
      expect((await settingsRoute.DELETE(req(`/x?id=${row.id}`, "DELETE"))).status).toBe(403)
    })
  })

  describe("notifications", () => {
    it("shows each person their own notifications and marks them read", async () => {
      await db.insert(notifications).values([
        // ORDER_CREATED is withheld from anyone who cannot approve orders, so use a type every reader gets.
        { userId: f.headOfficeId, organizationId: f.home, type: "ORDER_APPROVED", targetRole: "HEAD_OFFICE", message: `Mine ${f.suffix}` },
        { userId: f.branchAdminId, organizationId: f.home, branchId: f.north, type: "ORDER_CREATED", targetRole: "BRANCH_ADMIN", message: `Theirs ${f.suffix}` },
      ])
      signIn(ho())
      const listed = await json(await notificationsRoute.GET(req("/x")))
      expect(JSON.stringify(listed.body)).toContain(`Mine ${f.suffix}`)
      expect(JSON.stringify(listed.body)).not.toContain(`Theirs ${f.suffix}`)

      const marked = await notificationsRoute.PATCH(req("/x", "PATCH", { markAllRead: true }))
      expect(marked.status).toBeLessThan(500)

      signIn(null)
      expect((await notificationsRoute.GET(req("/x"))).status).toBe(401)
    })
  })

  describe("legacy product listings", () => {
    it("refuses another tenant's branch products to every non-Super-Admin role", async () => {
      for (const actor of [op(), ho(), ba(), { id: f.orderPortalId, role: "GROUP_USER", organizationId: f.home }, { id: f.orderPortalId, role: "VIEWER", organizationId: f.home }]) {
        signIn(actor)
        const foreign = await branchProductsRoute.GET(req(`/x?organizationId=${f.foreign}&branchId=${f.abroad}`))
        expect(foreign.status, actor.role).toBe(403)
        const mixed = await branchProductsRoute.GET(req(`/x?organizationId=${f.home}&branchId=${f.abroad}`))
        expect(mixed.status, actor.role).toBe(403)
      }
    })

    it("pins Branch Admin and Order Portal to their own branch, and serves their own", async () => {
      signIn(op())
      expect((await branchProductsRoute.GET(req(`/x?organizationId=${f.home}&branchId=${f.north}`))).status).toBe(200)
      signIn(ho())
      expect((await branchProductsRoute.GET(req(`/x?organizationId=${f.home}&branchId=${f.north}`))).status).toBe(200)
      expect((await branchProductsRoute.GET(req("/x"))).status).toBe(400)
    })

    it("lets Super Admin read any tenant's branch products", async () => {
      signIn(sa())
      const listed = await json(await branchProductsRoute.GET(req(`/x?organizationId=${f.foreign}&branchId=${f.abroad}`)))
      expect(listed.status).toBe(200)
      expect(JSON.stringify(listed.body)).toContain(`Foreign Secret Name ${f.suffix}`)
    })

    it("refuses another tenant's organization products", async () => {
      signIn(ho())
      expect((await orgProductsRoute.GET(req(`/x?organizationId=${f.foreign}`))).status).toBe(403)
      const own = await json(await orgProductsRoute.GET(req("/x")))
      expect(JSON.stringify(own.body)).not.toContain(`Foreign Secret Name ${f.suffix}`)
    })
  })
})
