import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { eq, inArray, or } from "drizzle-orm"

import * as organizationsRoute from "@/app/api/v1/warehouse/catalog/organizations/route"
import * as organizationProductsRoute from "@/app/api/v1/warehouse/catalog/organization-products/route"
import * as groupProductsRoute from "@/app/api/v1/warehouse/catalog/group-products/route"
import * as priceHistoryRoute from "@/app/api/v1/warehouse/catalog/price-history/route"
import * as productRequestsRoute from "@/app/api/v1/warehouse/catalog/product-requests/route"
import * as categoriesRoute from "@/app/api/v1/warehouse/catalog/taxonomy/categories/route"
import * as subcategoriesRoute from "@/app/api/v1/warehouse/catalog/taxonomy/subcategories/route"
import {
  auditLogs,
  branchInventory,
  branches,
  categories,
  globalProducts,
  groupInventoryPrices,
  groups,
  organizationInventory,
  organizations,
  productPriceHistory,
  productRequests,
  roles,
  users,
  warehouseAssignments,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The warehouse's full read-only catalogue against Postgres.
 * See plans/OF-WAREHOUSE-full-read-only-catalog.md.
 *
 * ```text
 * Tenant A (served: branch A1 assigned to "wh")    Tenant B (not served)
 *   group GA { A1 } — group price 300                group GB { B1 }
 *   product P: base 500, A's own price 400            product P: B's own price 450
 *   request "A-REQ"                                   request "B-REQ"
 * ```
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(actor ? ({ user: { ...actor, mustChangePassword: false } } as any) : null)
}

async function read(response: Response) {
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by warehouse catalogue tests" }).returning({ id: roles.id })
  return created.id
}

type Handler = (req: Request) => Promise<Response>

const ROUTES: Record<string, { module: Record<string, unknown>; path: string }> = {
  organizations: { module: organizationsRoute, path: "/api/v1/warehouse/catalog/organizations" },
  organizationProducts: { module: organizationProductsRoute, path: "/api/v1/warehouse/catalog/organization-products" },
  groupProducts: { module: groupProductsRoute, path: "/api/v1/warehouse/catalog/group-products" },
  priceHistory: { module: priceHistoryRoute, path: "/api/v1/warehouse/catalog/price-history" },
  productRequests: { module: productRequestsRoute, path: "/api/v1/warehouse/catalog/product-requests" },
  categories: { module: categoriesRoute, path: "/api/v1/warehouse/catalog/taxonomy/categories" },
  subcategories: { module: subcategoriesRoute, path: "/api/v1/warehouse/catalog/taxonomy/subcategories" },
}

describe.skipIf(!hasTestDatabase)("the warehouse's full read-only catalogue", () => {
  const suffix = randomUUID().slice(0, 8)
  const actors: Record<string, Actor> = {}
  let orgA: number
  let orgB: number
  let branchA1: number
  let branchB1: number
  let groupA: number
  let groupB: number
  let productId: number
  let categoryId: number
  let subcategoryId: number

  const get = async (actor: Actor | null, route: keyof typeof ROUTES, query = "") => {
    signIn(actor)
    const { module, path } = ROUTES[route]
    return read(await (module.GET as Handler)(new NextRequest(`http://localhost${path}${query}`, { method: "GET" })))
  }

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all(
      ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "WAREHOUSE"].map(async (name) => [name, await resolveRoleId(name)] as const),
    ))
    const [a] = await db.insert(organizations).values({ name: `IT WC A ${suffix}`, code: `ITWCA_${suffix}` }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT WC B ${suffix}`, code: `ITWCB_${suffix}` }).returning({ id: organizations.id })
    orgA = a.id
    orgB = b.id

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null) => {
      const email = `it-wc-${label}-${suffix}@example.test`
      const [row] = await db.insert(users).values({
        email, username: `it-wc-${label}-${suffix}`, passwordHash: "x", roleId: roleIds[role], organizationId, branchId, fullName: `Person ${label} ${suffix}`, isActive: true,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }
    await person("superAdmin", "SUPER_ADMIN", null, null)
    await person("headOfficeA", "HEAD_OFFICE", orgA, null)
    await person("headOfficeB", "HEAD_OFFICE", orgB, null)
    await person("wh", "WAREHOUSE", null, null)
    await person("whNone", "WAREHOUSE", null, null)

    const [ga] = await db.insert(groups).values({ organizationId: orgA, name: `IT WC GA ${suffix}`, createdByUserId: actors.superAdmin.id }).returning({ id: groups.id })
    const [gb] = await db.insert(groups).values({ organizationId: orgB, name: `IT WC GB ${suffix}`, createdByUserId: actors.superAdmin.id }).returning({ id: groups.id })
    groupA = ga.id
    groupB = gb.id
    const [a1, b1] = await db.insert(branches).values([
      { organizationId: orgA, name: `IT WC A1 ${suffix}`, city: "Lahore", status: "active", groupId: groupA },
      { organizationId: orgB, name: `IT WC B1 ${suffix}`, city: "Karachi", status: "active", groupId: groupB },
    ]).returning({ id: branches.id })
    branchA1 = a1.id
    branchB1 = b1.id
    await person("branchAdmin", "BRANCH_ADMIN", orgA, branchA1)
    await db.insert(warehouseAssignments).values({ userId: actors.wh.id, branchId: branchA1, createdByUserId: actors.superAdmin.id })

    const [category] = await db.insert(categories).values({ name: `IT WC Beverages ${suffix}` }).returning({ id: categories.id })
    const [subcategory] = await db.insert(categories).values({ name: `IT WC Tea ${suffix}`, parentId: category.id }).returning({ id: categories.id })
    categoryId = category.id
    subcategoryId = subcategory.id

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITWC-${suffix}`, name: `IT WC Tea ${suffix}`, basePrice: 50_000, status: "active", unit: "box", stockQuantity: 40, categoryId: subcategoryId,
    }).returning({ id: globalProducts.id })
    productId = product.id

    const [invA] = await db.insert(organizationInventory).values({ organizationId: orgA, globalProductId: productId, assignedByUserId: actors.superAdmin.id, customPrice: 40_000 }).returning({ id: organizationInventory.id })
    const [invB] = await db.insert(organizationInventory).values({ organizationId: orgB, globalProductId: productId, assignedByUserId: actors.superAdmin.id, customPrice: 45_000 }).returning({ id: organizationInventory.id })
    await db.insert(branchInventory).values([
      { branchId: branchA1, organizationId: orgA, organizationInventoryId: invA.id, assignedByUserId: actors.superAdmin.id },
      { branchId: branchB1, organizationId: orgB, organizationInventoryId: invB.id, assignedByUserId: actors.superAdmin.id },
    ])
    await db.insert(groupInventoryPrices).values({ groupId: groupA, organizationId: orgA, organizationInventoryId: invA.id, customPriceCents: 30_000 })

    await db.insert(productRequests).values([
      { organizationId: orgA, requestedByUserId: actors.headOfficeA.id, productName: `A-REQ ${suffix}`, expectedPriceCents: 12_300 },
      { organizationId: orgB, requestedByUserId: actors.headOfficeB.id, productName: `B-REQ ${suffix}` },
    ])

    // Price history: whatever the triggers wrote for the rows above, plus one
    // explicit change at each tier so both tenants certainly have a timeline.
    await db.insert(productPriceHistory).values([
      { globalProductId: productId, scope: "ORGANIZATION", organizationId: orgA, priceCents: 41_000, previousPriceCents: 40_000, changeType: "UPDATE", source: "CATALOG_CHANGE", changedAt: new Date() },
      { globalProductId: productId, scope: "ORGANIZATION", organizationId: orgB, priceCents: 46_000, previousPriceCents: 45_000, changeType: "UPDATE", source: "CATALOG_CHANGE", changedAt: new Date() },
    ])
  })

  afterAll(async () => {
    if (!orgA) return
    const organizationIds = [orgA, orgB]
    const actorIds = Object.values(actors).map((actor) => actor.id)
    await db.delete(productPriceHistory).where(eq(productPriceHistory.globalProductId, productId))
    await db.delete(productRequests).where(inArray(productRequests.organizationId, organizationIds))
    await db.delete(groupInventoryPrices).where(inArray(groupInventoryPrices.organizationId, organizationIds))
    await db.delete(branchInventory).where(inArray(branchInventory.organizationId, organizationIds))
    await db.delete(organizationInventory).where(inArray(organizationInventory.organizationId, organizationIds))
    await db.delete(globalProducts).where(eq(globalProducts.id, productId))
    await db.delete(categories).where(inArray(categories.id, [subcategoryId, categoryId]))
    await db.delete(warehouseAssignments).where(inArray(warehouseAssignments.userId, actorIds))
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, actorIds)))
    // Branches first (users.branch_id is ON DELETE SET NULL), then the groups
    // the people created, then the people.
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(groups).where(inArray(groups.organizationId, organizationIds))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  beforeEach(() => vi.mocked(getServerSession).mockReset())

  describe("who may read it", () => {
    it.each(Object.keys(ROUTES))("%s refuses an unauthenticated caller and every other role", async (route) => {
      const query = ["organizationProducts", "groupProducts"].includes(route) ? `?organizationId=${orgA}` : ""
      expect((await get(null, route, query)).status).toBe(401)
      for (const key of ["superAdmin", "headOfficeA", "branchAdmin"]) {
        expect((await get(actors[key], route, query)).status, `${route} ${key}`).toBe(403)
      }
    })

    it.each(Object.keys(ROUTES))("%s exports GET alone, so nothing can be written through it", (route) => {
      const { module } = ROUTES[route]
      expect(typeof module.GET).toBe("function")
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(module, `${route} ${method}`).not.toHaveProperty(method)
    })
  })

  describe("the organization fence", () => {
    it("covers only the organizations whose branches the warehouse serves", async () => {
      expect((await get(actors.wh, "organizations")).body).toEqual({ organizations: [{ id: orgA, name: `IT WC A ${suffix}` }] })
      expect((await get(actors.whNone, "organizations")).body).toEqual({ organizations: [] })
    })

    it("shows a served organization's products with base, own and effective price", async () => {
      const { status, body } = await get(actors.wh, "organizationProducts", `?organizationId=${orgA}`)
      expect(status).toBe(200)
      expect(body.items).toEqual([expect.objectContaining({
        productCode: `ITWC-${suffix}`,
        basePriceCents: 50_000,
        customPriceCents: 40_000,
        effectivePriceCents: 40_000,
        active: true,
        category: `IT WC Beverages ${suffix}`,
        subcategory: `IT WC Tea ${suffix}`,
      })])
    })

    it("refuses another organization's products as not found, whoever asks", async () => {
      expect((await get(actors.wh, "organizationProducts", `?organizationId=${orgB}`)).status).toBe(404)
      expect((await get(actors.whNone, "organizationProducts", `?organizationId=${orgA}`)).status).toBe(404)
    })

    it("prices a served group by the ladder, and refuses another tenant's group", async () => {
      const groupsOnly = await get(actors.wh, "groupProducts", `?organizationId=${orgA}`)
      expect(groupsOnly.status).toBe(200)
      expect(groupsOnly.body.groups).toEqual([{ id: groupA, name: `IT WC GA ${suffix}`, branches: [`IT WC A1 ${suffix}`] }])
      expect(groupsOnly.body.items).toEqual([])

      const chosen = await get(actors.wh, "groupProducts", `?organizationId=${orgA}&groupId=${groupA}`)
      expect(chosen.body.items).toEqual([expect.objectContaining({ basePriceCents: 50_000, overridePriceCents: 30_000, effectivePriceCents: 30_000, branchCount: 1 })])

      expect((await get(actors.wh, "groupProducts", `?organizationId=${orgA}&groupId=${groupB}`)).status).toBe(404)
      expect((await get(actors.wh, "groupProducts", `?organizationId=${orgB}&groupId=${groupB}`)).status).toBe(404)
    })

    it("lists only the served organizations' product requests, and names no person", async () => {
      const { status, body } = await get(actors.wh, "productRequests")
      expect(status).toBe(200)
      const names = body.items.map((item: { productName: string }) => item.productName)
      expect(names).toContain(`A-REQ ${suffix}`)
      expect(names).not.toContain(`B-REQ ${suffix}`)
      expect(body.items.find((item: { productName: string }) => item.productName === `A-REQ ${suffix}`).expectedPriceCents).toBe(12_300)
      expect(JSON.stringify(body)).not.toMatch(new RegExp(`Person|it-wc-|requester|reviewedBy`, "i"))

      expect((await get(actors.wh, "productRequests", `?organizationId=${orgB}`)).status).toBe(404)
      expect((await get(actors.whNone, "productRequests")).body.items).toEqual([])
    })

    it("draws price history from the global tier and the served organizations only", async () => {
      const { status, body } = await get(actors.wh, "priceHistory", `?range=all&productId=${productId}`)
      expect(status).toBe(200)
      expect(body.options.organizations.map((organization: { id: number }) => organization.id)).toEqual([orgA])
      expect(body.options.groups.map((group: { id: number }) => group.id)).toEqual([groupA])
      expect(body.options.branches.map((branch: { id: number }) => branch.id)).toEqual([branchA1])
      const organizationIds = new Set(body.points.map((point: { organizationId: number | null }) => point.organizationId))
      expect(organizationIds.has(orgA)).toBe(true)
      expect(organizationIds.has(orgB)).toBe(false)

      expect((await get(actors.wh, "priceHistory", `?organizationId=${orgB}`)).status).toBe(404)
      expect((await get(actors.wh, "priceHistory", `?groupId=${groupB}`)).status).toBe(404)
      expect((await get(actors.wh, "priceHistory", `?branchId=${branchB1}`)).status).toBe(404)
    })
  })

  describe("the taxonomy", () => {
    it("lists categories and subcategories with Super Admin's counts", async () => {
      const top = await get(actors.wh, "categories", `?q=${encodeURIComponent(`IT WC Beverages ${suffix}`)}`)
      expect(top.status).toBe(200)
      expect(top.body.items).toEqual([expect.objectContaining({ id: categoryId, subcategoriesCount: 1, productsCount: 1, parentId: null })])

      const sub = await get(actors.wh, "subcategories", `?categoryId=${categoryId}`)
      expect(sub.body.items).toEqual([expect.objectContaining({ id: subcategoryId, parentName: `IT WC Beverages ${suffix}`, productsCount: 1 })])
    })
  })

  describe("malformed requests", () => {
    it.each([
      ["organizationProducts", ""],
      ["organizationProducts", `?organizationId=${0}`],
      ["organizationProducts", `?organizationId=1&sort=price`],
      ["groupProducts", "?organizationId=abc"],
      ["productRequests", "?status=DONE"],
      ["priceHistory", "?organizationId=1&extra=1"],
      ["priceHistory", "?range=forever"],
      ["categories", "?categoryId=1"],
      ["organizations", "?x=1"],
    ])("%s refuses %s with 400", async (route, query) => {
      expect((await get(actors.wh, route, query)).status).toBe(400)
    })
  })
})
