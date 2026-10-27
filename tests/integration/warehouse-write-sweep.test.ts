import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { eq, inArray, or } from "drizzle-orm"

import {
  auditLogs,
  branches,
  globalProducts,
  mfaCodes,
  groups,
  orderItems,
  orders,
  organizations,
  roles,
  systemLogs,
  users,
  warehouseAssignments,
  warehouseCityAssignments,
  warehouseCityOrganizations,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { RIDER_OPS_API_RULES } from "@/lib/rider-access"
import { WAREHOUSE_API_RULES } from "@/lib/warehouse-access"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Can a warehouse user change anything it must not, by calling a write
 * handler directly? See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 *
 * `warehouse-isolation-sweep.test.ts` proves no GET handler leaks; this is
 * its counterpart for every POST, PUT, PATCH and DELETE under `app/api/v1`.
 * The proxy is skipped (it is never the boundary). Each handler is called as a
 * warehouse session with each dynamic id pointed at a row inside the reach
 * and at rows outside it, once with an empty body and once with a hostile one
 * that names other tenants, privileged fields and every common action. The
 * sweep fails when:
 *
 *   * a handler outside the warehouse's own allowlist answers 2xx — it did
 *     something for a role that should have been refused;
 *   * one of the most sensitive write routes, called with a body that passes
 *     its own schema, answers anything but 401/403/404 — the role check must
 *     come before the work, not depend on the body being wrong; or
 *   * any protected row changed: an order's money, status or branch, a
 *     tenant's or branch's settings, a person's role, access or password, or
 *     the warehouse's own reach (no self-assignment).
 *
 * Identity, headers, the rate limiter, the cache, S3 and SES are faked; the
 * handlers, their role checks and their SQL are real.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
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
vi.mock("@/lib/server/image-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/image-storage")>()
  return {
    ...actual,
    isImageStorageConfigured: () => true,
    putImage: vi.fn(async () => undefined),
    getImage: vi.fn(async () => null),
    deleteImage: vi.fn(async () => undefined),
  }
})
vi.mock("@/lib/email/ses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/ses")>()
  return { ...actual, sendAppEmail: vi.fn(async () => ({ messageId: "sweep" })) }
})

const { getServerSession } = mockedNextAuth

type RouteModule = Record<string, unknown>
type Handler = (req: NextRequest, ctx: unknown) => Promise<Response>
const ROUTE_MODULES = import.meta.glob("/app/api/v1/**/route.ts") as Record<string, () => Promise<RouteModule>>
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const

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
  const [created] = await db.insert(roles).values({ name, description: "Created by the warehouse write sweep" }).returning({ id: roles.id })
  return created.id
}

/**
 * Write handlers that answer any caller, signed in or not, reviewed for the
 * warehouse: each acts only on the caller's own account or on a public flow
 * whose answer is the same for everyone.
 */
const ANSWERS_ANY_CALLER = new Set<string>([
  // Self-service password reset and joining are public by design; each answers
  // every input the same way and never acts on another tenant's data.
  "app/api/v1/auth/password-reset/request/route.ts",
  "app/api/v1/auth/password-reset/verify/route.ts",
  "app/api/v1/auth/password-reset/complete/route.ts",
  "app/api/v1/join/requests/route.ts",
  "app/api/v1/join/email-verification/request/route.ts",
  "app/api/v1/join/email-verification/verify/route.ts",
  // "Mark all read" on the caller's own notices; for a role outside its list —
  // the warehouse among them — it answers { updated: 0 } and runs no update.
  "app/api/v1/notifications/route.ts",
])

describe.skipIf(!hasTestDatabase)("a warehouse user, calling every write handler directly", () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {
    orgA: 0, orgB: 0, branchA1: 0, branchA2: 0, branchB1: 0, groupB: 0, productId: 0,
    orderX: 0, orderY: 0, orderZ: 0, itemY: 0,
    warehouse: "", raiserA1: "", raiserB: "", headOfficeB: "", superAdmin: "",
  }
  const userIds: string[] = []

  /** Everything the warehouse must never change, as one comparable value. */
  async function protectedState() {
    const orderRows = await db.select({
      id: orders.id,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      paymentStatus: orders.paymentStatus,
      totalCents: orders.totalCents,
      subtotalCents: orders.subtotalCents,
      refundAmountCents: orders.refundAmountCents,
      notes: orders.notes,
      branchId: orders.branchId,
      organizationId: orders.organizationId,
      approvedByUserId: orders.approvedByUserId,
      deliveredAt: orders.deliveredAt,
      fulfilledAt: orders.fulfilledAt,
    }).from(orders).where(inArray(orders.id, [ids.orderX, ids.orderY, ids.orderZ])).orderBy(orders.id)
    const lineRows = await db.select({ id: orderItems.id, quantity: orderItems.quantity, priceCents: orderItems.priceCents })
      .from(orderItems).where(inArray(orderItems.orderId, [ids.orderX, ids.orderY, ids.orderZ])).orderBy(orderItems.id)
    const organizationRows = await db.select().from(organizations).where(inArray(organizations.id, [ids.orgA, ids.orgB])).orderBy(organizations.id)
    const branchRows = await db.select().from(branches).where(inArray(branches.organizationId, [ids.orgA, ids.orgB])).orderBy(branches.id)
    const groupRows = await db.select().from(groups).where(eq(groups.id, ids.groupB))
    const userRows = await db.select({
      id: users.id, roleId: users.roleId, isActive: users.isActive, organizationId: users.organizationId,
      branchId: users.branchId, passwordHash: users.passwordHash, sessionVersion: users.sessionVersion,
      email: users.email, deletedAt: users.deletedAt, mfaEnabled: users.mfaEnabled,
    }).from(users).where(inArray(users.id, userIds)).orderBy(users.id)
    const productRows = await db.select({ id: globalProducts.id, basePrice: globalProducts.basePrice, stockQuantity: globalProducts.stockQuantity, status: globalProducts.status })
      .from(globalProducts).where(eq(globalProducts.id, ids.productId))
    const reachRows = await db.select({ branchId: warehouseAssignments.branchId }).from(warehouseAssignments)
      .where(eq(warehouseAssignments.userId, ids.warehouse)).orderBy(warehouseAssignments.branchId)
    const cityRows = await db.select({ cityKey: warehouseCityAssignments.cityKey }).from(warehouseCityAssignments)
      .where(eq(warehouseCityAssignments.userId, ids.warehouse))
    const cityOrganizationRows = await db.select({ organizationId: warehouseCityOrganizations.organizationId })
      .from(warehouseCityOrganizations)
      .where(eq(warehouseCityOrganizations.userId, ids.warehouse))
    return { orderRows, lineRows, organizationRows, branchRows, groupRows, userRows, productRows, reachRows, cityRows, cityOrganizationRows }
  }

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all(
      ["WAREHOUSE", "ORDER_PORTAL", "HEAD_OFFICE", "SUPER_ADMIN"].map(async (name) => [name, await resolveRoleId(name)] as const),
    ))

    const [a] = await db.insert(organizations).values({ name: `IT WSWEEP A ${suffix}`, code: `ITWSA_${suffix}` }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT WSWEEP B ${suffix}`, code: `ITWSB_${suffix}` }).returning({ id: organizations.id })
    ids.orgA = a.id
    ids.orgB = b.id

    const [a1, a2, b1] = await db.insert(branches).values([
      { organizationId: ids.orgA, name: `IT WSWEEP A1 ${suffix}`, city: `Wsweep ${suffix}`, status: "active" },
      { organizationId: ids.orgA, name: `IT WSWEEP A2 ${suffix}`, city: `Wsweep other ${suffix}`, status: "active" },
      { organizationId: ids.orgB, name: `IT WSWEEP B1 ${suffix}`, city: `Wsweep b ${suffix}`, status: "active" },
    ]).returning({ id: branches.id })
    ids.branchA1 = a1.id
    ids.branchA2 = a2.id
    ids.branchB1 = b1.id

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null) => {
      const [row] = await db.insert(users).values({
        email: `it-wsweep-${label}-${suffix}@example.test`,
        username: `it-wsweep-${label}-${suffix}`,
        passwordHash: `hash-${label}`,
        roleId: roleIds[role],
        organizationId,
        branchId,
        fullName: `${label} ${suffix}`,
      }).returning({ id: users.id })
      userIds.push(row.id)
      return row.id
    }
    ids.warehouse = await person("warehouse", "WAREHOUSE", null, null)
    ids.superAdmin = await person("superAdmin", "SUPER_ADMIN", null, null)
    ids.raiserA1 = await person("raiserA1", "ORDER_PORTAL", ids.orgA, ids.branchA1)
    ids.raiserB = await person("raiserB", "ORDER_PORTAL", ids.orgB, ids.branchB1)
    ids.headOfficeB = await person("headOfficeB", "HEAD_OFFICE", ids.orgB, null)

    const [g] = await db.insert(groups).values({ organizationId: ids.orgB, name: `IT WSWEEP group ${suffix}`, createdByUserId: ids.headOfficeB })
      .returning({ id: groups.id })
    ids.groupB = g.id

    await db.insert(warehouseAssignments).values({ userId: ids.warehouse, branchId: ids.branchA1 })

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITWS-${suffix}`, name: `IT write sweep product ${suffix}`, basePrice: 1000, status: "active", unit: "piece", stockQuantity: 10,
    }).returning({ id: globalProducts.id })
    ids.productId = product.id

    const place = async (tid: string, organizationId: number, branchId: number, createdByUserId: string, status: string) => {
      const [row] = await db.insert(orders).values({
        tid, organizationId, branchId, createdByUserId, createdByRole: "ORDER_PORTAL",
        status, fulfillmentStatus: "NOT_STARTED", approvedAt: status === "APPROVED" ? new Date() : null,
        subtotalCents: 1000, totalCents: 1000, budgetTracked: false, notes: "original",
        receiptData: { invoiceNumber: `INV-${tid}` } as any,
      }).returning({ id: orders.id })
      await db.insert(orderItems).values({
        orderId: row.id, organizationId, globalProductId: ids.productId, productName: "Sweep item", productCode: `ITWS-${suffix}`, unit: "piece", quantity: 1, priceCents: 1000,
      })
      return row.id
    }
    // X is inside the reach but pending, so even an in-reach id offers the warehouse nothing to approve.
    ids.orderX = await place(`WS${suffix}X`, ids.orgA, ids.branchA1, ids.raiserA1, "PENDING")
    ids.orderY = await place(`WS${suffix}Y`, ids.orgA, ids.branchA2, ids.raiserA1, "APPROVED")
    ids.orderZ = await place(`WS${suffix}Z`, ids.orgB, ids.branchB1, ids.raiserB, "PENDING")
    const [itemY] = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, ids.orderY)).limit(1)
    ids.itemY = itemY.id

    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: ids.warehouse,
        email: `it-wsweep-warehouse-${suffix}@example.test`,
        role: "WAREHOUSE",
        organizationId: null,
        branchId: null,
        mustChangePassword: false,
      },
    } as any)
  })

  afterAll(async () => {
    if (!ids.orgA) return
    const organizationIds = [ids.orgA, ids.orgB]
    const orderRows = await db.select({ id: orders.id }).from(orders).where(inArray(orders.organizationId, organizationIds))
    const orderIds = orderRows.map((row) => row.id)
    if (orderIds.length > 0) {
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
      await db.delete(orders).where(inArray(orders.id, orderIds))
    }
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, userIds)))
    await db.delete(systemLogs).where(or(inArray(systemLogs.organizationId, organizationIds), inArray(systemLogs.userId, userIds)))
    await db.delete(warehouseAssignments).where(inArray(warehouseAssignments.userId, userIds))
    await db.delete(warehouseCityAssignments).where(inArray(warehouseCityAssignments.userId, userIds))
    await db.delete(warehouseCityOrganizations).where(inArray(warehouseCityOrganizations.userId, userIds))
    await db.delete(groups).where(eq(groups.id, ids.groupB))
    await db.delete(globalProducts).where(eq(globalProducts.id, ids.productId))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    // The warehouse's own email-verification endpoint (allowlisted) issues it a code.
    await db.delete(mfaCodes).where(inArray(mfaCodes.userId, userIds))
    await db.delete(users).where(inArray(users.id, userIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  /** A body naming other tenants, privileged fields and every common action. */
  const hostileBody = () => ({
    organizationId: ids.orgB,
    branchId: ids.branchB1,
    branchIds: [ids.branchA2, ids.branchB1],
    groupId: ids.groupB,
    groupIds: [ids.groupB],
    orderId: ids.orderZ,
    orderIds: [ids.orderY, ids.orderZ],
    userId: ids.raiserB,
    city: `Wsweep b ${suffix}`,
    assigned: true,
    role: "SUPER_ADMIN",
    roleId: 1,
    isActive: false,
    status: "APPROVED",
    fulfillmentStatus: "DELIVERED",
    paymentStatus: "PAID",
    amountCents: 1,
    refundAmountCents: 1000,
    basePrice: 1,
    customPrice: 1,
    stockQuantity: 0,
    reason: "warehouse write sweep",
    notes: "tampered",
    email: `it-wsweep-new-${suffix}@example.test`,
    password: "Sweep-Password-123!",
    name: `IT WSWEEP created ${suffix}`,
  })

  function probesFor(path: string, param: string): string[] {
    const before = path.slice(0, path.indexOf(`[${param}]`))
    if (param === "userId") return [ids.raiserB, ids.warehouse]
    if (param === "orderId") return [String(ids.orderX), String(ids.orderZ)]
    if (param === "id") {
      if (/\/orders\/$/.test(before) || /\/approvals\/$/.test(before)) return [String(ids.orderX), String(ids.orderY), String(ids.orderZ)]
      if (/\/branches\/$/.test(before)) return [String(ids.branchA1), String(ids.branchB1)]
      if (/\/organizations\/$/.test(before)) return [String(ids.orgA), String(ids.orgB)]
      if (/\/groups\/$/.test(before)) return [String(ids.groupB)]
      if (/\/users\/$/.test(before)) return [ids.raiserB, ids.warehouse]
      if (/\/inventory\/$|\/global-products\/$|\/products\/$/.test(before)) return [String(ids.productId)]
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

  async function callOnce(handler: Handler, method: string, file: string, path: string, body: unknown): Promise<string> {
    const response = await withTimeout((async () => {
      try {
        return await handler(
          new NextRequest(`http://localhost${path}?organizationId=${ids.orgB}&branchId=${ids.branchB1}`, {
            method,
            headers: { "Content-Type": "application/json" },
            ...(method === "DELETE" && body === undefined ? {} : { body: JSON.stringify(body ?? {}) }),
          }),
          { params: Promise.resolve(paramsOf(file, path)) },
        )
      } catch {
        return new Response(null, { status: 599 })
      }
    })())
    return response === "timeout" ? "timeout" : String(response.status)
  }

  it("is refused by every write handler outside its own, and changes nothing it must not", async () => {
    const before = await protectedState()
    const ownRoutes = new Set([
      ...WAREHOUSE_API_RULES.map((rule) => rule.route),
      ...RIDER_OPS_API_RULES.map((rule) => rule.route),
    ])
    const admitted: string[] = []
    let calls = 0

    const sweepHandler = async (file: string, method: string, handler: Handler) => {
      const route = file.replace(/^\/app\//, "app/")
      const reviewed = ownRoutes.has(route) || ANSWERS_ANY_CALLER.has(route)
      for (const path of concretePaths(file)) {
        for (const body of [{}, hostileBody()]) {
          calls += 1
          const status = await callOnce(handler, method, file, path, body)
          if (/^2\d\d$/.test(status) && !reviewed) admitted.push(`${method} ${path} → ${status}`)
        }
      }
    }
    for (const [file, load] of Object.entries(ROUTE_MODULES)) {
      const routeModule = await load()
      for (const method of WRITE_METHODS) {
        const handler = routeModule[method]
        if (typeof handler === "function") await sweepHandler(file, method, handler as Handler)
      }
    }

    // The sweep really ran across the write API, as the warehouse.
    expect(calls).toBeGreaterThan(150)
    expect(admitted, `Write handlers outside the warehouse's allowlist acted for it:\n${admitted.join("\n")}`).toEqual([])

    // Second pass: the routes that matter most, each with a body its own schema
    // accepts. A body that is merely wrong is refused with 400 whoever calls;
    // only a valid one shows whether the role is refused before the work.
    const valid: Array<[string, string, string, unknown]> = [
      ["PUT", "app/api/v1/warehouse-team/[userId]/branches/route.ts", `/api/v1/warehouse-team/${ids.warehouse}/branches`, { organizationId: ids.orgA, branchIds: [ids.branchA1, ids.branchA2] }],
      ["PUT", "app/api/v1/warehouse-team/[userId]/cities/route.ts", `/api/v1/warehouse-team/${ids.warehouse}/cities`, { city: `Wsweep other ${suffix}`, assigned: true }],
      ["PUT", "app/api/v1/warehouse-team/[userId]/city-organizations/route.ts", `/api/v1/warehouse-team/${ids.warehouse}/city-organizations`, { organizationId: ids.orgB, assigned: true }],
      ["POST", "app/api/v1/orders/[id]/approve/route.ts", `/api/v1/orders/${ids.orderX}/approve`, {}],
      ["POST", "app/api/v1/orders/[id]/approve/route.ts", `/api/v1/orders/${ids.orderZ}/approve`, {}],
      ["POST", "app/api/v1/orders/[id]/reject/route.ts", `/api/v1/orders/${ids.orderX}/reject`, { reason: "sweep" }],
      ["POST", "app/api/v1/orders/[id]/return-for-correction/route.ts", `/api/v1/orders/${ids.orderX}/return-for-correction`, { comment: "sweep" }],
      ["POST", "app/api/v1/orders/[id]/payment-status/route.ts", `/api/v1/orders/${ids.orderY}/payment-status`, { paymentStatus: "PAID" }],
      ["POST", "app/api/v1/orders/[id]/fulfillment-status/route.ts", `/api/v1/orders/${ids.orderY}/fulfillment-status`, { fulfillmentStatus: "IN_PROCESS" }],
      ["POST", "app/api/v1/orders/[id]/fulfill/route.ts", `/api/v1/orders/${ids.orderY}/fulfill`, { approvalToken: "sweep-token" }],
      ["POST", "app/api/v1/orders/[id]/refunds/route.ts", `/api/v1/orders/${ids.orderY}/refunds`, { items: [{ id: ids.itemY, quantity: 1 }], reason: "sweep" }],
      ["PATCH", "app/api/v1/branches/[id]/route.ts", `/api/v1/branches/${ids.branchB1}`, { name: `Hijacked ${suffix}` }],
      ["PATCH", "app/api/v1/organizations/[id]/route.ts", `/api/v1/organizations/${ids.orgB}`, { name: `Hijacked ${suffix}` }],
      ["PATCH", "app/api/v1/users/[id]/access/route.ts", `/api/v1/users/${ids.raiserB}/access`, { isActive: false }],
      ["PATCH", "app/api/v1/users/[id]/access/route.ts", `/api/v1/users/${ids.warehouse}/access`, { role: "SUPER_ADMIN" }],
    ]
    const notRefused: string[] = []
    for (const [method, route, path, body] of valid) {
      const routeModule = await ROUTE_MODULES[`/${route}`]()
      const handler = routeModule[method]
      expect(typeof handler, `${method} ${route}`).toBe("function")
      const status = await callOnce(handler as Handler, method, `/${route}`, path, body)
      if (!["401", "403", "404"].includes(status)) notRefused.push(`${method} ${path} → ${status}`)
    }
    expect(notRefused, `Sensitive routes did not refuse the warehouse up front:\n${notRefused.join("\n")}`).toEqual([])

    const after = await protectedState()
    expect(after.reachRows, "the warehouse changed its own reach").toEqual(before.reachRows)
    expect(after.cityRows, "the warehouse assigned itself a city").toEqual(before.cityRows)
    expect(after.orderRows, "an order changed").toEqual(before.orderRows)
    expect(after.lineRows, "an order line changed").toEqual(before.lineRows)
    expect(after.userRows, "a person's access changed").toEqual(before.userRows)
    expect(after.organizationRows, "an organization changed").toEqual(before.organizationRows)
    expect(after.branchRows, "a branch changed, or one was created").toEqual(before.branchRows)
    expect(after.groupRows, "a group changed").toEqual(before.groupRows)
    expect(after.productRows, "a price or stock changed").toEqual(before.productRows)

    // Nothing was created in either tenant's name either.
    const created = await db.select({ id: orders.id }).from(orders).where(inArray(orders.organizationId, [ids.orgA, ids.orgB]))
    expect(created.map((row) => row.id).sort()).toEqual([ids.orderX, ids.orderY, ids.orderZ].sort())
  }, 900_000)
})
