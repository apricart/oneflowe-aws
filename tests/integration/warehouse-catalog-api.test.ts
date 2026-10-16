import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { eq, inArray, like, or } from "drizzle-orm"

import * as catalogRoute from "@/app/api/v1/warehouse/catalog/route"
import * as categoriesRoute from "@/app/api/v1/warehouse/catalog/categories/route"
import { auditLogs, branches, categories, globalProducts, organizations, roles, systemLogs, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The warehouse's read-only product catalogue, against Postgres.
 * See plans/OF-WAREHOUSE-read-only-product-catalog.md.
 *
 * ```text
 * Beverages (parent)                     Stationery (top level)   Unused (no product)
 *   Tea     ← Tea (active, stored image)    ← Pens (active)
 *           ← Retired (inactive)
 *   Coffee  ← Coffee (active, low, legacy data: image)
 *   Gone    ← Deleted (deleted_at set)
 * ```
 *
 * Every product carries a base price, a tax rate and a discount with values
 * found nowhere else. Since plans/OF-WAREHOUSE-full-read-only-catalog.md the
 * base price is shown, as on Super Admin's Global Products; a leak of the tax
 * rate or the discount is still visible in the payload.
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

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor ? ({ user: { ...actor, mustChangePassword: false } } as any) : null,
  )
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

const PRICE_CENTS = 35_517
const TAX_RATE_BP = 1_731
const DISCOUNT_CENTS = 98_765
const STORED_IMAGE = `/api/v1/images/products/${randomUUID()}.webp`
const ITEM_KEYS = ["basePriceCents", "category", "id", "imageUrl", "low", "name", "productCode", "status", "stockQuantity", "subcategory", "unit"]

describe.skipIf(!hasTestDatabase)("the warehouse's product catalogue through the API", () => {
  const suffix = randomUUID().slice(0, 8)
  const codePrefix = `ITWHC-${suffix}`
  const actors: Record<string, Actor> = {}
  const cat: Record<string, number> = {}
  const product: Record<string, number> = {}
  let orgId: number

  const catalog = async (actor: Actor | null, query = "") => {
    signIn(actor)
    return read(await catalogRoute.GET(new NextRequest(`http://localhost/api/v1/warehouse/catalog${query}`, { method: "GET" })))
  }
  const categoryList = async (actor: Actor | null, query = "") => {
    signIn(actor)
    return read(await categoriesRoute.GET(new NextRequest(`http://localhost/api/v1/warehouse/catalog/categories${query}`, { method: "GET" })))
  }
  /** Only this suite's rows: the test database is shared with other suites. */
  const own = (query = "") => catalog(actors.wh, `?q=${codePrefix}${query}`)
  const names = (body: { items: Array<{ name: string }> }) => body.items.map((item) => item.name.replace(`${suffix} `, ""))

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all([
      "SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "ORDER_DESK", "APRICART_EXECUTIVE", "WAREHOUSE",
    ].map(async (name) => [name, await resolveRoleId(name)] as const)))

    const [org] = await db.insert(organizations).values({ name: `IT WHC ${suffix}`, code: `ITWHC_${suffix}` }).returning({ id: organizations.id })
    orgId = org.id
    const [branch] = await db.insert(branches).values({ organizationId: orgId, name: `IT WHC B ${suffix}`, city: "Lahore", status: "active" })
      .returning({ id: branches.id })

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null) => {
      const email = `it-whc-${label}-${suffix}@example.test`
      const [row] = await db.insert(users).values({
        email, username: `it-whc-${label}-${suffix}`, passwordHash: "x", roleId: roleIds[role], organizationId, branchId, fullName: `${label} ${suffix}`,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }
    await person("superAdmin", "SUPER_ADMIN", null, null)
    await person("headOffice", "HEAD_OFFICE", orgId, null)
    await person("branchAdmin", "BRANCH_ADMIN", orgId, branch.id)
    await person("orderPortal", "ORDER_PORTAL", orgId, branch.id)
    await person("orderDesk", "ORDER_DESK", null, null)
    await person("executive", "APRICART_EXECUTIVE", null, null)
    // No branch assigned: the catalogue is Apricart's own, not a branch's.
    await person("wh", "WAREHOUSE", null, null)

    const category = async (key: string, name: string, parentId: number | null = null, organizationId: number | null = null) => {
      const [row] = await db.insert(categories).values({ name: `IT WHC ${name} ${suffix}`, parentId, organizationId }).returning({ id: categories.id })
      cat[key] = row.id
    }
    await category("beverages", "Beverages")
    await category("stationery", "Stationery")
    // A tenant's own category that no global product carries is never named.
    await category("unused", "Unused", null, orgId)
    await category("tea", "Tea", cat.beverages)
    await category("coffee", "Coffee", cat.beverages)
    await category("gone", "Gone", cat.beverages)

    const priced = { basePrice: PRICE_CENTS, taxRateBp: TAX_RATE_BP, discountType: "flat", discountValue: DISCOUNT_CENTS, discountActive: true }
    const insert = async (key: string, values: Partial<typeof globalProducts.$inferInsert>) => {
      const [row] = await db.insert(globalProducts).values({
        productCode: `${codePrefix}-${key}`, name: `${suffix} ${key}`, unit: "piece", status: "active", stockQuantity: 120, ...priced, ...values,
      }).returning({ id: globalProducts.id })
      product[key] = row.id
    }
    await insert("Tea", { categoryId: cat.tea, unit: "80 gm", imageUrl: STORED_IMAGE })
    await insert("Retired", { categoryId: cat.tea, status: "inactive" })
    await insert("Coffee", { categoryId: cat.coffee, stockQuantity: 5, imageUrl: "data:image/png;base64,iVBORw0KGgo=" })
    await insert("Pens", { categoryId: cat.stationery, unit: "Box" })
    await insert("Deleted", { categoryId: cat.gone, deletedAt: new Date() })
  })

  afterAll(async () => {
    if (!orgId) return
    const actorIds = Object.values(actors).map((actor) => actor.id)
    await db.delete(globalProducts).where(like(globalProducts.productCode, `${codePrefix}-%`))
    await db.delete(categories).where(inArray(categories.id, Object.values(cat)))
    await db.delete(auditLogs).where(or(eq(auditLogs.organizationId, orgId), inArray(auditLogs.userId, actorIds)))
    await db.delete(systemLogs).where(or(eq(systemLogs.organizationId, orgId), inArray(systemLogs.userId, actorIds)))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(branches).where(eq(branches.organizationId, orgId))
    await db.delete(organizations).where(eq(organizations.id, orgId))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("who may read it", () => {
    it("refuses a caller with no session", async () => {
      expect((await catalog(null)).status).toBe(401)
      expect((await categoryList(null)).status).toBe(401)
    })

    it.each(["superAdmin", "headOffice", "branchAdmin", "orderPortal", "orderDesk", "executive"])("refuses %s", async (label) => {
      expect((await catalog(actors[label])).status).toBe(403)
      expect((await categoryList(actors[label])).status).toBe(403)
    })

    it("has no way to write: neither handler exports a write method", () => {
      for (const route of [catalogRoute, categoriesRoute]) {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(route).not.toHaveProperty(method)
      }
    })
  })

  describe("the product list", () => {
    it("lists the active catalogue by name, with category, unit, stock and base price, never tax or discount", async () => {
      const { status, body } = await own()
      expect(status).toBe(200)
      expect(names(body)).toEqual(["Coffee", "Pens", "Tea"])
      expect(body.total).toBe(3)

      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual(ITEM_KEYS)
        expect(item.basePriceCents).toBe(PRICE_CENTS)
      }
      const raw = JSON.stringify(body)
      expect(raw).not.toMatch(/discount|tax/i)
      for (const figure of [TAX_RATE_BP, DISCOUNT_CENTS]) expect(raw).not.toContain(`:${figure}`)

      const byName = Object.fromEntries(body.items.map((item: { name: string }) => [item.name.replace(`${suffix} `, ""), item]))
      expect(byName.Tea).toEqual({
        id: product.Tea, productCode: `${codePrefix}-Tea`, name: `${suffix} Tea`, unit: "80 gm", status: "active",
        stockQuantity: 120, low: false, imageUrl: STORED_IMAGE, basePriceCents: PRICE_CENTS,
        category: `IT WHC Beverages ${suffix}`, subcategory: `IT WHC Tea ${suffix}`,
      })
      // A legacy data: picture is left out rather than sent inline.
      expect(byName.Coffee).toMatchObject({ imageUrl: null, low: true, stockQuantity: 5 })
      // Filed directly under a top-level category: that is its category, with no subcategory.
      expect(byName.Pens).toMatchObject({ category: `IT WHC Stationery ${suffix}`, subcategory: null })
    })

    it("filters by status, and never lists a deleted product", async () => {
      expect(names((await own("&status=inactive")).body)).toEqual(["Retired"])
      expect(names((await own("&status=all")).body)).toEqual(["Coffee", "Pens", "Retired", "Tea"])
    })

    it("filters by category, which includes its subcategories, and by subcategory", async () => {
      expect(names((await own(`&categoryId=${cat.beverages}`)).body)).toEqual(["Coffee", "Tea"])
      expect(names((await own(`&categoryId=${cat.beverages}&status=all`)).body)).toEqual(["Coffee", "Retired", "Tea"])
      expect(names((await own(`&subcategoryId=${cat.tea}`)).body)).toEqual(["Tea"])
      expect(names((await own(`&categoryId=${cat.stationery}`)).body)).toEqual(["Pens"])
      expect(names((await own(`&categoryId=${cat.unused}`)).body)).toEqual([])
    })

    it("pages, with the total of the whole match", async () => {
      const { body } = await own("&limit=1&page=2")
      expect(names(body)).toEqual(["Pens"])
      expect(body).toMatchObject({ total: 3, page: 2, limit: 1 })
    })

    it.each([
      ["a price filter", "?basePrice=1"],
      ["a tenant filter", "?organizationId=1"],
      ["a malformed category", "?categoryId=abc"],
      ["an unknown status", "?status=deleted"],
    ])("refuses %s", async (_label, query) => {
      expect((await catalog(actors.wh, query)).status).toBe(400)
    })
  })

  describe("the category filter list", () => {
    it("names the categories the catalogue uses, with their subcategories, and no others", async () => {
      const { status, body } = await categoryList(actors.wh)
      expect(status).toBe(200)
      const ours = body.categories.filter((entry: { name: string }) => entry.name.endsWith(suffix))
      expect(ours).toEqual([
        {
          id: cat.beverages,
          name: `IT WHC Beverages ${suffix}`,
          subcategories: [{ id: cat.coffee, name: `IT WHC Coffee ${suffix}` }, { id: cat.tea, name: `IT WHC Tea ${suffix}` }],
        },
        { id: cat.stationery, name: `IT WHC Stationery ${suffix}`, subcategories: [] },
      ])
      // Neither the unused tenant category nor the deleted product's subcategory.
      expect(JSON.stringify(body)).not.toContain(`Unused ${suffix}`)
      expect(JSON.stringify(body)).not.toContain(`Gone ${suffix}`)
    })

    it("takes no query", async () => {
      expect((await categoryList(actors.wh, "?organizationId=1")).status).toBe(400)
    })
  })
})
