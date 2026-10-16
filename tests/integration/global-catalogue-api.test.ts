import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { eq, inArray, like } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as importRoute from "@/app/api/v1/admin/global-inventory/import/route"
import * as inventoryRoute from "@/app/api/v1/admin/global-inventory/route"
import * as productRoute from "@/app/api/v1/inventory/global-products/[id]/route"
import { auditLogs, globalProducts, productPriceHistory, roles, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The global catalogue: Super Admin's create / edit / retire / import of the
 * products every tenant buys from, and the single-product read other roles
 * use. Writes are Super Admin's alone (they carry the base price); reads by
 * anyone else must not carry the base price, which is internal cost.
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

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "catalogue it" }).returning({ id: roles.id })
  return created.id
}

function signIn(actor: { id: string; role: string } | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, organizationId: null, email: "a@example.test", mustChangePassword: false } } as any),
  )
}

function req(path: string, method = "GET", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function csvRequest(csv: string): NextRequest {
  const form = new FormData()
  form.set("file", new File([csv], "products.csv", { type: "text/csv" }))
  return new NextRequest("http://localhost/api/v1/admin/global-inventory/import", { method: "POST", body: form })
}

async function json(response: Response) {
  return { status: response.status, body: await response.json() }
}

describe.skipIf(!hasTestDatabase)("global catalogue", () => {
  const suffix = randomUUID().slice(0, 8)
  const code = (label: string) => `ITGC-${label}-${suffix}`
  let superAdminId = ""
  let headOfficeId = ""
  // The create endpoint assigns PRD--<n> codes, so its rows are tracked by id.
  const createdIds: number[] = []

  async function create(body: Record<string, unknown>) {
    const created = await json(await inventoryRoute.POST(req("/x", "POST", body)))
    if (created.body?.product?.id) createdIds.push(created.body.product.id)
    return created
  }

  beforeAll(async () => {
    const [sa, ho] = await db.insert(users).values([
      { email: `it-gc-sa-${suffix}@example.test`, username: `it-gc-sa-${suffix}`, passwordHash: "x", roleId: await roleId("SUPER_ADMIN") },
      { email: `it-gc-ho-${suffix}@example.test`, username: `it-gc-ho-${suffix}`, passwordHash: "x", roleId: await roleId("HEAD_OFFICE") },
    ]).returning({ id: users.id })
    superAdminId = sa.id
    headOfficeId = ho.id
  })

  afterAll(async () => {
    const products = await db.select({ id: globalProducts.id }).from(globalProducts).where(like(globalProducts.productCode, `ITGC-%-${suffix}`))
    const ids = [...products.map((row) => row.id), ...createdIds]
    if (ids.length) {
      await db.delete(productPriceHistory).where(inArray(productPriceHistory.globalProductId, ids))
    }
    await db.delete(auditLogs).where(inArray(auditLogs.userId, [superAdminId, headOfficeId]))
    if (ids.length) await db.delete(globalProducts).where(inArray(globalProducts.id, ids))
    await db.delete(users).where(inArray(users.id, [superAdminId, headOfficeId]))
    await closePool()
  })

  beforeEach(() => {
    signIn({ id: superAdminId, role: "SUPER_ADMIN" })
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  it("is closed to everyone but Super Admin", async () => {
    signIn(null)
    expect((await inventoryRoute.GET(req("/x"))).status).toBe(401)
    signIn({ id: headOfficeId, role: "HEAD_OFFICE" })
    expect((await inventoryRoute.GET(req("/x"))).status).toBe(403)
    expect((await inventoryRoute.POST(req("/x", "POST", { name: "x", basePrice: 1 }))).status).toBe(403)
    expect((await inventoryRoute.DELETE(req("/x?id=1", "DELETE"))).status).toBe(403)
    expect((await importRoute.POST(csvRequest("name,productcode,baseprice\nx,y,1"))).status).toBe(403)
    expect((await productRoute.PUT(req("/x", "PUT", { name: "x" }), { params: Promise.resolve({ id: "1" }) })).status).toBe(403)
  })

  it("creates a product under a code it assigns, edits it, lists and searches it, and retires it", async () => {
    const created = await create({ name: `Alpha ${suffix}`, basePrice: 12.5, unit: "Box", stockQuantity: 10 })
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
    const assignedCode: string = created.body.product.productCode
    expect(assignedCode).toMatch(/^PRD--\d+$/)
    const [row] = await db.select().from(globalProducts).where(eq(globalProducts.id, created.body.product.id))
    expect(row.productCode).toBe(assignedCode)
    expect(row.basePrice).toBe(1_250)

    const named = await create({ productCode: code("A"), name: "named", basePrice: 1 })
    expect(named.status).toBe(400)
    expect(await db.select().from(globalProducts).where(eq(globalProducts.productCode, code("A")))).toHaveLength(0)
    expect((await create({ name: "no price" })).status).toBe(400)
    expect((await create({ name: "neg", basePrice: -1 })).status).toBe(400)

    const edited = await json(await inventoryRoute.PUT(req("/x", "PUT", { id: row.id, name: `Alpha Prime ${suffix}` })))
    expect(edited.status, JSON.stringify(edited.body)).toBeLessThan(300)

    const listed = await json(await inventoryRoute.GET(req(`/x?search=${encodeURIComponent(`Alpha Prime ${suffix}`)}`)))
    expect(JSON.stringify(listed.body)).toContain(assignedCode)
    const one = await json(await inventoryRoute.GET(req(`/x?id=${row.id}`)))
    expect(one.status).toBe(200)
    expect((await inventoryRoute.GET(req("/x?id=abc"))).status).toBe(400)
    expect((await inventoryRoute.GET(req("/x?id=2147483000"))).status).toBe(404)

    const retired = await inventoryRoute.DELETE(req(`/x?id=${row.id}`, "DELETE"))
    expect(retired.status).toBeLessThan(300)
    const [after] = await db.select().from(globalProducts).where(eq(globalProducts.id, row.id))
    expect(after.status).toBe("inactive")
    expect((await inventoryRoute.DELETE(req("/x", "DELETE"))).status).toBe(400)
  })

  it("hides the base price from every reader of a single product but Super Admin", async () => {
    const created = await create({ name: `Priced ${suffix}`, basePrice: 99 })
    const [row] = await db.select().from(globalProducts).where(eq(globalProducts.id, created.body.product.id))

    const asAdmin = await json(await productRoute.GET(req("/x"), { params: Promise.resolve({ id: String(row.id) }) }))
    expect(asAdmin.body.product.basePrice).toBe(9_900)

    for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL"]) {
      signIn({ id: headOfficeId, role })
      const read = await json(await productRoute.GET(req("/x"), { params: Promise.resolve({ id: String(row.id) }) }))
      expect(read.status, role).toBe(200)
      expect(read.body.product.basePrice, role).toBeUndefined()
    }
    signIn(null)
    expect((await productRoute.GET(req("/x"), { params: Promise.resolve({ id: String(row.id) }) })).status).toBe(401)
  })

  it("gives concurrent creates distinct codes", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => create({ name: `Concurrent ${n} ${suffix}`, basePrice: 5 })),
    )
    for (const result of results) expect(result.status, JSON.stringify(result.body)).toBeLessThan(300)
    const codes = results.map((result) => result.body.product.productCode as string)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it("imports a valid CSV and refuses the whole file when any row is invalid", async () => {
    const good = await json(await importRoute.POST(csvRequest(
      `name,productcode,baseprice,unit\nImported One ${suffix},${code("I1")},10,Piece\nImported Two ${suffix},${code("I2")},20.5,Box\n`,
    )))
    expect(good.status, JSON.stringify(good.body)).toBeLessThan(300)
    const imported = await db.select().from(globalProducts).where(inArray(globalProducts.productCode, [code("I1"), code("I2")]))
    expect(imported.map((row) => row.basePrice).sort((a, b) => a - b)).toEqual([1_000, 2_050])

    const bad = await json(await importRoute.POST(csvRequest(
      `name,productcode,baseprice\nFine ${suffix},${code("I3")},5\nBroken ${suffix},${code("I4")},not-a-number\n`,
    )))
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe("CSV validation failed; no products were imported")
    expect(await db.select().from(globalProducts).where(eq(globalProducts.productCode, code("I3")))).toHaveLength(0)

    expect((await importRoute.POST(csvRequest("name,unexpected\nx,y\n"))).status).toBe(400)
  })
})
