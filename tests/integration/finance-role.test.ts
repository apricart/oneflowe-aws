import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, or } from "drizzle-orm"

import * as kpiRoute from "@/app/api/v1/finance/payment-kpis/route"
import * as ordersRoute from "@/app/api/v1/orders/route"
import * as paymentStatusRoute from "@/app/api/v1/orders/[id]/payment-status/route"
import * as usersRoute from "@/app/api/v1/users/route"
import * as financeOrganizationsRoute from "@/app/api/v1/users/[id]/finance-organizations/route"
import {
  auditLogs,
  branches,
  financeOrganizationAssignments,
  globalProducts,
  groups,
  orderItems,
  orders,
  organizations,
  roles,
  systemLogs,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { FINANCE_API_RULES, FINANCE_ORGANIZATION_AUDIT_ACTION } from "@/lib/finance-access"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The Finance role against Postgres (plans/OF-FINANCE-finance-role.md).
 *
 * ```text
 * Tenant A  ← assigned to the Finance account     Tenant B (marker -FINB)
 *   A1                                              B1, group G-B
 *     approved order X (unpaid, not delivered)        approved order Z
 *     fulfilled order W (paid)
 *     pending order P
 * ```
 *
 * The sweep calls **every GET handler under `app/api/v1`** directly as the
 * Finance user — the proxy skipped — with every dynamic id and tenant filter
 * pointed at tenant B, and fails if any successful response carries the
 * marker. Identity, headers, the rate limiter, the cache, email and S3 are
 * faked; the handlers, their role checks and their SQL are real.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false }),
}))
vi.mock("@/lib/rate-limiter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limiter")>()
  return { ...actual, withRateLimit: vi.fn(async () => null) }
})
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: vi.fn(async () => undefined),
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>()
  return { ...actual, sendWelcomeEmail: vi.fn(async () => undefined) }
})
vi.mock("@/lib/server/image-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/image-storage")>()
  return {
    ...actual,
    isImageStorageConfigured: () => true,
    putImage: vi.fn(async () => undefined),
    getImage: vi.fn(async () => null),
  }
})

const { getServerSession } = mockedNextAuth

type RouteModule = Record<string, unknown>
const ROUTE_MODULES = import.meta.glob("/app/api/v1/**/route.ts") as Record<string, () => Promise<RouteModule>>

const CALL_TIMEOUT_MS = 8000

async function withTimeout<T>(work: Promise<T>): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), CALL_TIMEOUT_MS) })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by the finance tests" }).returning({ id: roles.id })
  return created.id
}

describe.skipIf(!hasTestDatabase)("the Finance role", () => {
  const suffix = randomUUID().slice(0, 8)
  const OUT_B = `${suffix}-FINB`
  /**
   * Tenant B's order total, far above anything tenant A holds, so an aggregate
   * that folded it in shows up as a number in the leak range whether it is
   * reported in cents or in rupees — a name marker cannot catch a sum.
   */
  const OUT_B_TOTAL_CENTS = 987_654_321
  const isLeakedAmount = (value: number) => value >= 9_000_000 && value < 1e12

  function leakedAmounts(body: string): number[] {
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { return [] }
    const found: number[] = []
    const walk = (value: unknown) => {
      if (typeof value === "number" && isLeakedAmount(value)) found.push(value)
      else if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === "object") Object.values(value).forEach(walk)
    }
    walk(parsed)
    return found
  }

  const ids = {
    orgA: 0, orgB: 0, branchA1: 0, branchB1: 0, groupB: 0, productId: 0,
    orderX: 0, orderW: 0, orderP: 0, orderZ: 0,
    finance: "", emptyFinance: "", superAdmin: "", headOfficeA: "", raiserA: "", raiserB: "",
  }
  const userIds: string[] = []
  const createdUserIds: string[] = []

  type Actor = { id: string; role: string; organizationId: number | null }
  const actors: Record<string, Actor> = {}

  function signIn(actor: Actor | null) {
    vi.mocked(getServerSession).mockResolvedValue(actor === null ? null : ({
      user: {
        id: actor.id,
        email: `it-fin-${actor.role.toLowerCase()}-${suffix}@example.test`,
        role: actor.role,
        organizationId: actor.organizationId,
        branchId: null,
        mustChangePassword: false,
      },
    } as any))
  }

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all(
      ["FINANCE", "ORDER_PORTAL", "HEAD_OFFICE", "SUPER_ADMIN"].map(async (name) => [name, await resolveRoleId(name)] as const),
    ))

    const [a] = await db.insert(organizations).values({ name: `IT FIN ORG A ${suffix}`, code: `ITFNA_${suffix}` }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT FIN ${OUT_B} org`, code: `ITFNB_${suffix}` }).returning({ id: organizations.id })
    ids.orgA = a.id
    ids.orgB = b.id

    const [a1, b1] = await db.insert(branches).values([
      { organizationId: ids.orgA, name: `IT FIN A1 ${suffix}`, city: "Lahore", status: "active" },
      { organizationId: ids.orgB, name: `IT FIN ${OUT_B} branch`, city: `${OUT_B} city`, address: `${OUT_B} address`, status: "active" },
    ]).returning({ id: branches.id })
    ids.branchA1 = a1.id
    ids.branchB1 = b1.id

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null, marked = false) => {
      const [row] = await db.insert(users).values({
        email: `it-fin-${label}-${marked ? OUT_B : suffix}@example.test`,
        username: `it-fin-${label}-${suffix}`,
        passwordHash: "x",
        roleId: roleIds[role],
        organizationId,
        branchId,
        fullName: marked ? `${label} ${OUT_B}` : `${label} ${suffix}`,
      }).returning({ id: users.id })
      userIds.push(row.id)
      return row.id
    }
    ids.finance = await person("finance", "FINANCE", null, null)
    ids.emptyFinance = await person("empty-finance", "FINANCE", null, null)
    ids.superAdmin = await person("super-admin", "SUPER_ADMIN", null, null)
    ids.headOfficeA = await person("head-office-a", "HEAD_OFFICE", ids.orgA, null)
    ids.raiserA = await person("raiser-a", "ORDER_PORTAL", ids.orgA, ids.branchA1)
    ids.raiserB = await person("raiser-b", "ORDER_PORTAL", ids.orgB, ids.branchB1, true)

    actors.finance = { id: ids.finance, role: "FINANCE", organizationId: null }
    actors.emptyFinance = { id: ids.emptyFinance, role: "FINANCE", organizationId: null }
    actors.superAdmin = { id: ids.superAdmin, role: "SUPER_ADMIN", organizationId: null }
    actors.headOfficeA = { id: ids.headOfficeA, role: "HEAD_OFFICE", organizationId: ids.orgA }

    await db.insert(financeOrganizationAssignments).values({ userId: ids.finance, organizationId: ids.orgA })

    const [g] = await db.insert(groups).values({ organizationId: ids.orgB, name: `IT FIN ${OUT_B} group`, createdByUserId: ids.raiserB })
      .returning({ id: groups.id })
    ids.groupB = g.id

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITFN-${suffix}`, name: `IT finance product ${suffix}`, basePrice: 1000, status: "active", unit: "piece", stockQuantity: 10,
    }).returning({ id: globalProducts.id })
    ids.productId = product.id

    const place = async (tid: string, organizationId: number, branchId: number, createdByUserId: string, values: Partial<typeof orders.$inferInsert>) => {
      const [row] = await db.insert(orders).values({
        tid,
        organizationId,
        branchId,
        createdByUserId,
        createdByRole: "ORDER_PORTAL",
        status: "APPROVED",
        fulfillmentStatus: "NOT_STARTED",
        approvedAt: new Date(),
        approvedByUserId: createdByUserId,
        subtotalCents: 1000,
        totalCents: 1000,
        budgetTracked: false,
        receiptData: { invoiceNumber: `INV-${tid}` } as any,
        ...values,
      }).returning({ id: orders.id })
      await db.insert(orderItems).values({
        orderId: row.id, organizationId, globalProductId: ids.productId, productName: `Finance item ${suffix}`, productCode: `ITFN-${suffix}`, unit: "piece", quantity: 1, priceCents: Number(values.totalCents ?? 1000),
      })
      return row.id
    }
    ids.orderX = await place(`FN${suffix}AX`, ids.orgA, ids.branchA1, ids.raiserA, { totalCents: 40_000, subtotalCents: 40_000 })
    ids.orderW = await place(`FN${suffix}AW`, ids.orgA, ids.branchA1, ids.raiserA, {
      status: "FULFILLED", fulfillmentStatus: "DELIVERED", deliveredAt: new Date(), paymentStatus: "PAID", totalCents: 60_000, subtotalCents: 60_000,
    })
    ids.orderP = await place(`FN${suffix}AP`, ids.orgA, ids.branchA1, ids.raiserA, { status: "PENDING", approvedAt: null, approvedByUserId: null })
    ids.orderZ = await place(`${OUT_B}Z`, ids.orgB, ids.branchB1, ids.raiserB, {
      status: "FULFILLED", fulfillmentStatus: "DELIVERED", deliveredAt: new Date(), totalCents: OUT_B_TOTAL_CENTS, subtotalCents: OUT_B_TOTAL_CENTS, notes: `${OUT_B} note`,
    })
  })

  afterAll(async () => {
    if (!ids.orgA) return
    const organizationIds = [ids.orgA, ids.orgB]
    const everyone = [...userIds, ...createdUserIds]
    const orderRows = await db.select({ id: orders.id }).from(orders).where(inArray(orders.organizationId, organizationIds))
    const orderIds = orderRows.map((row) => row.id)
    if (orderIds.length > 0) {
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
      await db.delete(orders).where(inArray(orders.id, orderIds))
    }
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, everyone)))
    await db.delete(systemLogs).where(or(inArray(systemLogs.organizationId, organizationIds), inArray(systemLogs.userId, everyone)))
    await db.delete(financeOrganizationAssignments).where(inArray(financeOrganizationAssignments.userId, everyone))
    await db.delete(groups).where(eq(groups.id, ids.groupB))
    await db.delete(globalProducts).where(eq(globalProducts.id, ids.productId))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(users).where(inArray(users.id, everyone))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  // ---------------------------------------------------------------------------
  // The sweep
  // ---------------------------------------------------------------------------

  function probesFor(path: string, param: string): string[] {
    const before = path.slice(0, path.indexOf(`[${param}]`))
    if (param === "userId") return [ids.raiserB]
    if (param === "orderId") return [String(ids.orderZ)]
    if (param === "id") {
      if (/\/orders\/$/.test(before) || /\/approvals\/$/.test(before)) return [String(ids.orderZ)]
      if (/\/branches\/$/.test(before)) return [String(ids.branchB1)]
      if (/\/organizations\/$/.test(before)) return [String(ids.orgB)]
      if (/\/groups\/$/.test(before)) return [String(ids.groupB)]
      if (/\/users\/$/.test(before)) return [ids.raiserB]
      return [String(ids.orderZ), String(ids.branchB1)]
    }
    return ["1"]
  }

  function concretePaths(file: string): string[] {
    const template = file.replace(/^\/app/, "").replace(/\/route\.ts$/, "")
    const params = [...template.matchAll(/\[(?:\.\.\.)?([a-zA-Z]+)\]/g)].map((match) => match[1])
    let paths = [template]
    for (const param of params) {
      paths = paths.flatMap((path) => probesFor(path, param).map((value) => path.replace(new RegExp(String.raw`\[(?:\.\.\.)?${param}\]`), value)))
    }
    return paths
  }

  function paramsOf(file: string, concrete: string): Record<string, string | string[]> {
    const templateParts = file.replace(/^\/app/, "").replace(/\/route\.ts$/, "").split("/")
    const concreteParts = concrete.split("/")
    const result: Record<string, string | string[]> = {}
    templateParts.forEach((part, index) => {
      const match = /^\[(\.\.\.)?([a-zA-Z]+)\]$/.exec(part)
      if (match) result[match[2]] = match[1] ? [concreteParts[index]] : concreteParts[index]
    })
    return result
  }

  type GetHandler = (req: NextRequest, ctx: unknown) => Promise<Response>

  async function callOnce(handler: GetHandler, file: string, path: string, query: string) {
    const response = await withTimeout((async () => {
      try {
        return await handler(
          new NextRequest(`http://localhost${path}${query}`, { method: "GET" }),
          { params: Promise.resolve(paramsOf(file, path)) },
        )
      } catch {
        return new Response(null, { status: 599 })
      }
    })())
    if (response === "timeout") return { status: "timeout", body: null }
    const ok = response.status >= 200 && response.status < 300
    return {
      status: String(response.status),
      body: ok ? Buffer.from(await response.arrayBuffer()).toString("latin1") : null,
    }
  }

  it("never returns a row or a name from an unassigned organization, on any GET handler", async () => {
    signIn(actors.finance)
    const outOfReach = `organizationId=${ids.orgB}&organizationIds=${ids.orgB}&branchId=${ids.branchB1}&branchIds=${ids.branchB1}&groupId=${ids.groupB}&groupIds=${ids.groupB}&orgId=${ids.orgB}&orderId=${ids.orderZ}&q=${suffix}&search=${suffix}`
    // Named alongside an assigned organization, the unassigned one must still not widen the read.
    const mixed = `organizationIds=${ids.orgA},${ids.orgB}&branchIds=${ids.branchA1},${ids.branchB1}`
    const leaks: string[] = []
    const admitted = new Set<string>()
    let calls = 0

    for (const [file, load] of Object.entries(ROUTE_MODULES)) {
      const handler = (await load()).GET
      if (typeof handler !== "function") continue
      for (const path of concretePaths(file)) {
        for (const query of ["", `?${outOfReach}`, `?${mixed}`]) {
          calls += 1
          const { status, body } = await callOnce(handler as GetHandler, file, path, query)
          if (body === null) continue
          admitted.add(file.replace(/^\/app\//, "app/"))
          if (body.includes(OUT_B)) leaks.push(`${path}${query} → ${status} carries the marker`)
          const amounts = leakedAmounts(body)
          if (amounts.length > 0) leaks.push(`${path}${query} → ${status} carries tenant B's amount (${amounts.join(", ")})`)
        }
      }
    }

    expect(calls).toBeGreaterThan(200)
    expect(leaks, `An unassigned organization's data reached Finance:\n${leaks.join("\n")}`).toEqual([])

    // The reads its pages depend on really answered it.
    for (const route of [
      "app/api/v1/orders/route.ts",
      "app/api/v1/finance/payment-kpis/route.ts",
      "app/api/v1/analytics/summary/route.ts",
      "app/api/v1/organizations/route.ts",
    ]) expect(admitted.has(route), route).toBe(true)
    expect(FINANCE_API_RULES.length).toBeGreaterThan(30)
  }, 600_000)

  // ---------------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------------

  async function listOrders(query = "") {
    const response = await ordersRoute.GET(new NextRequest(`http://localhost/api/v1/orders${query}`))
    return { status: response.status, body: await response.json() }
  }

  it("lists every order of its assigned organizations, prices included, and nothing else", async () => {
    signIn(actors.finance)
    const { status, body } = await listOrders()
    expect(status).toBe(200)
    const listed = body.items.map((item: any) => item.id)
    expect(listed).toEqual(expect.arrayContaining([ids.orderX, ids.orderW, ids.orderP]))
    expect(listed).not.toContain(ids.orderZ)
    expect(body.pricesHidden).toBe(false)
    expect(body.capabilities.canApproveOrders).toBe(false)
  })

  it("is refused an unassigned organization rather than shown a narrower list", async () => {
    signIn(actors.finance)
    expect((await listOrders(`?organizationId=${ids.orgB}`)).status).toBe(403)
    expect((await listOrders(`?organizationIds=${ids.orgA},${ids.orgB}`)).status).toBe(403)
  })

  it("reads nothing at all with no organizations assigned", async () => {
    signIn(actors.emptyFinance)
    expect((await listOrders()).status).toBe(403)
    const kpis = await kpiRoute.GET(new Request("http://localhost/api/v1/finance/payment-kpis"))
    expect(kpis.status).toBe(403)
  })

  // ---------------------------------------------------------------------------
  // Paid / Unpaid
  // ---------------------------------------------------------------------------

  async function setPayment(orderId: number, paymentStatus: string) {
    const response = await paymentStatusRoute.POST(
      new Request(`http://localhost/api/v1/orders/${orderId}/payment-status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentStatus }),
      }),
      { params: Promise.resolve({ id: String(orderId) }) },
    )
    return { status: response.status, body: await response.json() }
  }

  async function paymentOf(orderId: number) {
    const [row] = await db.select({ paymentStatus: orders.paymentStatus, paidByUserId: orders.paidByUserId }).from(orders).where(eq(orders.id, orderId))
    return row
  }

  it("marks an approved, not yet delivered order paid, audits it, and marks it unpaid again", async () => {
    signIn(actors.finance)
    expect((await setPayment(ids.orderX, "PAID")).status).toBe(200)
    expect(await paymentOf(ids.orderX)).toEqual({ paymentStatus: "PAID", paidByUserId: ids.finance })

    const [audit] = await db.select({ metadata: auditLogs.metadata }).from(auditLogs).where(and(
      eq(auditLogs.action, "ORDER_PAYMENT_STATUS_UPDATE"),
      eq(auditLogs.entityId, String(ids.orderX)),
      eq(auditLogs.userId, ids.finance),
    ))
    expect(audit?.metadata).toMatchObject({ from: "UNPAID", to: "PAID", actorRole: "FINANCE" })

    expect((await setPayment(ids.orderX, "PAID")).status).toBe(400)
    expect((await setPayment(ids.orderX, "UNPAID")).status).toBe(200)
    expect(await paymentOf(ids.orderX)).toEqual({ paymentStatus: "UNPAID", paidByUserId: null })
  })

  it("refuses a pending order", async () => {
    signIn(actors.finance)
    expect((await setPayment(ids.orderP, "PAID")).status).toBe(400)
    expect((await paymentOf(ids.orderP)).paymentStatus).toBe("UNPAID")
  })

  it("answers an order of an unassigned organization as not found, and changes nothing", async () => {
    signIn(actors.finance)
    const result = await setPayment(ids.orderZ, "PAID")
    expect(result.status).toBe(404)
    expect((await paymentOf(ids.orderZ)).paymentStatus).toBe("UNPAID")
  })

  it("is refused to every other tenant role, and still open to Super Admin", async () => {
    signIn(actors.headOfficeA)
    expect((await setPayment(ids.orderX, "PAID")).status).toBe(403)
    signIn(null)
    expect((await setPayment(ids.orderX, "PAID")).status).toBe(401)
    signIn(actors.superAdmin)
    expect((await setPayment(ids.orderZ, "PAID")).status).toBe(200)
    expect((await setPayment(ids.orderZ, "UNPAID")).status).toBe(200)
  })

  // ---------------------------------------------------------------------------
  // Payment KPIs
  // ---------------------------------------------------------------------------

  async function kpis(query = "") {
    const response = await kpiRoute.GET(new Request(`http://localhost/api/v1/finance/payment-kpis${query}`))
    return { status: response.status, body: await response.json() }
  }

  it("counts only its assigned organizations, net of nothing pending", async () => {
    signIn(actors.finance)
    const { status, body } = await kpis()
    expect(status).toBe(200)
    expect(body.organizations.map((row: any) => row.organizationId)).toEqual([ids.orgA])
    expect(body.paid).toEqual({ count: 1, amountCents: 60_000 })
    expect(body.unpaid).toEqual({ count: 1, amountCents: 40_000 })
    expect(body.collectionRatePct).toBe(60)
    expect(body.aging.find((row: any) => row.bucket === "0-30")).toMatchObject({ count: 1, amountCents: 40_000 })
  })

  it("refuses an unassigned organization, and lets Super Admin read any", async () => {
    signIn(actors.finance)
    expect((await kpis(`?organizationIds=${ids.orgB}`)).status).toBe(403)
    signIn(actors.headOfficeA)
    expect((await kpis()).status).toBe(403)
    signIn(actors.superAdmin)
    const { status, body } = await kpis(`?organizationIds=${ids.orgA},${ids.orgB}`)
    expect(status).toBe(200)
    expect(body.organizations.map((row: any) => row.organizationId).sort()).toEqual([ids.orgA, ids.orgB].sort())
  })

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  async function createUser(body: Record<string, unknown>) {
    const response = await usersRoute.POST(new Request("http://localhost/api/v1/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }

  const newFinance = (label: string, extra: Record<string, unknown> = {}) => ({
    firstName: "Fin",
    lastName: label,
    email: `it-fin-new-${label}-${suffix}@example.test`,
    username: `itfin${label}${suffix}`,
    password: "Correct-Horse-Battery-9!",
    role: "FINANCE",
    organizationId: null,
    branchId: null,
    ...extra,
  })

  it("is created by Super Admin with its organizations, in one transaction, audited", async () => {
    signIn(actors.superAdmin)
    const { status, body } = await createUser(newFinance("one", { financeOrganizationIds: [ids.orgA, ids.orgB] }))
    expect(status).toBe(201)
    createdUserIds.push(body.item.id)
    const rows = await db.select({ organizationId: financeOrganizationAssignments.organizationId })
      .from(financeOrganizationAssignments).where(eq(financeOrganizationAssignments.userId, body.item.id))
    expect(rows.map((row) => row.organizationId).sort()).toEqual([ids.orgA, ids.orgB].sort())
    const [audit] = await db.select({ id: auditLogs.id }).from(auditLogs)
      .where(and(eq(auditLogs.action, FINANCE_ORGANIZATION_AUDIT_ACTION), eq(auditLogs.entityId, body.item.id)))
    expect(audit).toBeDefined()
  })

  it("is refused without organizations, with an organization of its own, or by Head Office", async () => {
    signIn(actors.superAdmin)
    expect((await createUser(newFinance("two"))).status).toBe(400)
    expect((await createUser(newFinance("three", { financeOrganizationIds: [ids.orgA], organizationId: ids.orgA }))).status).toBe(400)
    expect((await createUser(newFinance("four", { financeOrganizationIds: [999_999_999] }))).status).toBe(400)
    signIn(actors.headOfficeA)
    expect((await createUser(newFinance("five", { financeOrganizationIds: [ids.orgA] }))).status).toBe(403)
    const stray = await db.select({ id: users.id }).from(users).where(inArray(users.username, [
      `itfintwo${suffix}`, `itfinthree${suffix}`, `itfinfour${suffix}`, `itfinfive${suffix}`,
    ]))
    expect(stray).toEqual([])
  })

  async function replaceOrganizations(userId: string, organizationIds: number[]) {
    const response = await financeOrganizationsRoute.PUT(
      new Request(`http://localhost/api/v1/users/${userId}/finance-organizations`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationIds }),
      }),
      { params: Promise.resolve({ id: userId }) },
    )
    return { status: response.status, body: await response.json() }
  }

  it("has its organizations replaced by Super Admin alone, and only a Finance account's", async () => {
    signIn(actors.superAdmin)
    const result = await replaceOrganizations(ids.emptyFinance, [ids.orgB])
    expect(result.status).toBe(200)
    expect(result.body.item.organizationIds).toEqual([ids.orgB])

    signIn(actors.emptyFinance)
    const listed = await listOrders()
    expect(listed.status).toBe(200)
    expect(listed.body.items.map((item: any) => item.id)).toEqual([ids.orderZ])

    signIn(actors.superAdmin)
    expect((await replaceOrganizations(ids.emptyFinance, [])).status).toBe(200)
    expect((await replaceOrganizations(ids.headOfficeA, [ids.orgA])).status).toBe(404)
    signIn(actors.headOfficeA)
    expect((await replaceOrganizations(ids.emptyFinance, [ids.orgA])).status).toBe(403)
    signIn(actors.finance)
    expect((await replaceOrganizations(ids.finance, [ids.orgA, ids.orgB])).status).toBe(403)
  })
})
