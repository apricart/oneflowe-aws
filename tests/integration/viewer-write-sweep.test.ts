import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { eq, inArray, or } from "drizzle-orm"

import {
  auditLogs,
  branches,
  budgets,
  globalProducts,
  groups,
  mfaCodes,
  orderItems,
  orders,
  organizationJoinCodes,
  organizations,
  roles,
  systemLogs,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { VIEWER_OWN_ACCOUNT_WRITES } from "@/lib/viewer-access"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Can a Viewer change anything, by calling a write handler directly?
 * See plans/OF-VIEWER-head-office-read-only-menu.md.
 *
 * `viewer-isolation-sweep.test.ts` proves no GET handler leaks to it; this is
 * its counterpart for every POST, PUT, PATCH and DELETE under `app/api/v1`.
 * The proxy — which refuses a Viewer every write but its own password change —
 * is skipped, because it is never the boundary. Each handler is called as an
 * organization-wide and as a branch-pinned Viewer, with every dynamic id
 * pointed at rows **inside its own tenant** as well as outside it, once with an
 * empty body and once with a hostile one naming privileged fields and every
 * common action. The sweep fails when:
 *
 *   * a handler outside the account's own password change answers 2xx;
 *   * one of the most sensitive write routes, given a body its own schema
 *     accepts, answers anything but 401/403/404 — the role check must come
 *     before the work, not depend on the body being wrong; or
 *   * any protected row changed: an order, its lines, an organization, a
 *     branch, a group, a person, a price or stock, a budget, the join code.
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
  const [created] = await db.insert(roles).values({ name, description: "Created by the viewer write sweep" }).returning({ id: roles.id })
  return created.id
}

/**
 * Write handlers that answer any caller, signed in or not, reviewed for the
 * Viewer: each acts only on the caller's own account, or on a public flow
 * whose answer is the same for everyone.
 */
const ANSWERS_ANY_CALLER = new Set<string>([
  // Self-service password reset and joining are public by design; each answers
  // every input the same way and never acts on a tenant's data.
  "app/api/v1/auth/password-reset/request/route.ts",
  "app/api/v1/auth/password-reset/verify/route.ts",
  "app/api/v1/auth/password-reset/complete/route.ts",
  "app/api/v1/join/requests/route.ts",
  // "Mark all read" on the caller's own notices; for a role outside its list —
  // the Viewer among them — it answers { updated: 0 } and runs no update.
  "app/api/v1/notifications/route.ts",
  // The account's own password change and its email check: the only writes
  // the proxy lets a Viewer send (`VIEWER_OWN_ACCOUNT_WRITES`).
  ...VIEWER_OWN_ACCOUNT_WRITES.map((path) => `app${path}/route.ts`),
])

describe.skipIf(!hasTestDatabase)("a Viewer, calling every write handler directly", () => {
  const suffix = randomUUID().slice(0, 8)
  const ids = {
    orgA: 0, orgB: 0, branchA1: 0, branchA2: 0, branchB1: 0, groupA: 0, groupB: 0, productId: 0,
    orderX: 0, orderY: 0, orderZ: 0, itemY: 0,
    viewer: "", pinnedViewer: "", raiserA1: "", raiserB: "", headOfficeA: "", headOfficeB: "",
  }
  const userIds: string[] = []

  /** Everything a Viewer must never change, as one comparable value. */
  async function protectedState() {
    const orgIds = [ids.orgA, ids.orgB]
    const orderRows = await db.select({
      id: orders.id,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      paymentStatus: orders.paymentStatus,
      totalCents: orders.totalCents,
      refundAmountCents: orders.refundAmountCents,
      notes: orders.notes,
      branchId: orders.branchId,
      approvedByUserId: orders.approvedByUserId,
      deliveredAt: orders.deliveredAt,
      fulfilledAt: orders.fulfilledAt,
    }).from(orders).where(inArray(orders.organizationId, orgIds)).orderBy(orders.id)
    const lineRows = await db.select({ id: orderItems.id, quantity: orderItems.quantity, priceCents: orderItems.priceCents })
      .from(orderItems).where(inArray(orderItems.orderId, [ids.orderX, ids.orderY, ids.orderZ])).orderBy(orderItems.id)
    const organizationRows = await db.select().from(organizations).where(inArray(organizations.id, orgIds)).orderBy(organizations.id)
    const branchRows = await db.select().from(branches).where(inArray(branches.organizationId, orgIds)).orderBy(branches.id)
    const groupRows = await db.select().from(groups).where(inArray(groups.organizationId, orgIds)).orderBy(groups.id)
    const userRows = await db.select({
      id: users.id, roleId: users.roleId, isActive: users.isActive, organizationId: users.organizationId,
      branchId: users.branchId, passwordHash: users.passwordHash, sessionVersion: users.sessionVersion,
      email: users.email, deletedAt: users.deletedAt, mfaEnabled: users.mfaEnabled, fullName: users.fullName,
    }).from(users).where(or(inArray(users.organizationId, orgIds), inArray(users.id, userIds))).orderBy(users.id)
    const productRows = await db.select({ id: globalProducts.id, basePrice: globalProducts.basePrice, stockQuantity: globalProducts.stockQuantity, status: globalProducts.status })
      .from(globalProducts).where(eq(globalProducts.id, ids.productId))
    const budgetRows = await db.select().from(budgets).where(inArray(budgets.organizationId, orgIds)).orderBy(budgets.id)
    const joinCodeRows = await db.select().from(organizationJoinCodes).where(inArray(organizationJoinCodes.organizationId, orgIds))
    return { orderRows, lineRows, organizationRows, branchRows, groupRows, userRows, productRows, budgetRows, joinCodeRows }
  }

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all(
      ["VIEWER", "ORDER_PORTAL", "HEAD_OFFICE"].map(async (name) => [name, await resolveRoleId(name)] as const),
    ))

    const [a] = await db.insert(organizations).values({ name: `IT VWSWEEP A ${suffix}`, code: `ITVWA_${suffix}` }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT VWSWEEP B ${suffix}`, code: `ITVWB_${suffix}` }).returning({ id: organizations.id })
    ids.orgA = a.id
    ids.orgB = b.id

    const [a1, a2, b1] = await db.insert(branches).values([
      { organizationId: ids.orgA, name: `IT VWSWEEP A1 ${suffix}`, city: `Vwsweep ${suffix}`, status: "active" },
      { organizationId: ids.orgA, name: `IT VWSWEEP A2 ${suffix}`, city: `Vwsweep other ${suffix}`, status: "active" },
      { organizationId: ids.orgB, name: `IT VWSWEEP B1 ${suffix}`, city: `Vwsweep b ${suffix}`, status: "active" },
    ]).returning({ id: branches.id })
    ids.branchA1 = a1.id
    ids.branchA2 = a2.id
    ids.branchB1 = b1.id

    const person = async (label: string, role: string, organizationId: number, branchId: number | null) => {
      const [row] = await db.insert(users).values({
        email: `it-vwsweep-${label}-${suffix}@example.test`,
        username: `it-vwsweep-${label}-${suffix}`,
        passwordHash: `hash-${label}`,
        roleId: roleIds[role],
        organizationId,
        branchId,
        fullName: `${label} ${suffix}`,
      }).returning({ id: users.id })
      userIds.push(row.id)
      return row.id
    }
    ids.viewer = await person("viewer", "VIEWER", ids.orgA, null)
    ids.pinnedViewer = await person("pinned", "VIEWER", ids.orgA, ids.branchA1)
    ids.raiserA1 = await person("raiserA1", "ORDER_PORTAL", ids.orgA, ids.branchA1)
    ids.raiserB = await person("raiserB", "ORDER_PORTAL", ids.orgB, ids.branchB1)
    ids.headOfficeA = await person("headOfficeA", "HEAD_OFFICE", ids.orgA, null)
    ids.headOfficeB = await person("headOfficeB", "HEAD_OFFICE", ids.orgB, null)

    const [gA, gB] = await db.insert(groups).values([
      { organizationId: ids.orgA, name: `IT VWSWEEP group A ${suffix}`, createdByUserId: ids.headOfficeA },
      { organizationId: ids.orgB, name: `IT VWSWEEP group B ${suffix}`, createdByUserId: ids.headOfficeB },
    ]).returning({ id: groups.id })
    ids.groupA = gA.id
    ids.groupB = gB.id

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITVW-${suffix}`, name: `IT viewer write sweep product ${suffix}`, basePrice: 1000, status: "active", unit: "piece", stockQuantity: 10,
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
        orderId: row.id, organizationId, globalProductId: ids.productId, productName: "Sweep item", productCode: `ITVW-${suffix}`, unit: "piece", quantity: 1, priceCents: 1000,
      })
      return row.id
    }
    // X and Y sit inside the Viewer's own tenant — the rows it reads, and the
    // ones a role check that confused reading with writing would let it touch.
    ids.orderX = await place(`VW${suffix}X`, ids.orgA, ids.branchA1, ids.raiserA1, "PENDING")
    ids.orderY = await place(`VW${suffix}Y`, ids.orgA, ids.branchA2, ids.raiserA1, "APPROVED")
    ids.orderZ = await place(`VW${suffix}Z`, ids.orgB, ids.branchB1, ids.raiserB, "PENDING")
    const [itemY] = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, ids.orderY)).limit(1)
    ids.itemY = itemY.id
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
    await db.delete(budgets).where(inArray(budgets.organizationId, organizationIds))
    await db.delete(organizationJoinCodes).where(inArray(organizationJoinCodes.organizationId, organizationIds))
    await db.delete(groups).where(inArray(groups.organizationId, organizationIds))
    await db.delete(globalProducts).where(eq(globalProducts.id, ids.productId))
    await db.delete(mfaCodes).where(inArray(mfaCodes.userId, userIds))
    await db.delete(users).where(inArray(users.id, userIds))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  function signInAs(userId: string, branchId: number | null) {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: userId,
        email: `it-vwsweep-${userId}@example.test`,
        role: "VIEWER",
        organizationId: ids.orgA,
        branchId,
        mustChangePassword: false,
      },
    } as any)
  }

  /** A body naming its own tenant's rows, privileged fields and every common action. */
  const hostileBody = () => ({
    organizationId: ids.orgA,
    branchId: ids.branchA1,
    branchIds: [ids.branchA1, ids.branchA2],
    groupId: ids.groupA,
    groupIds: [ids.groupA],
    orderId: ids.orderX,
    orderIds: [ids.orderX, ids.orderY],
    userId: ids.raiserA1,
    role: "HEAD_OFFICE",
    roleId: 1,
    isActive: false,
    status: "APPROVED",
    fulfillmentStatus: "DELIVERED",
    paymentStatus: "PAID",
    amountCents: 1,
    allocatedCents: 999_999,
    refundAmountCents: 1000,
    basePrice: 1,
    customPrice: 1,
    stockQuantity: 0,
    reason: "viewer write sweep",
    notes: "tampered",
    code: `VWSWEEP-${suffix}`.toUpperCase(),
    email: `it-vwsweep-new-${suffix}@example.test`,
    password: "Sweep-Password-123!",
    name: `IT VWSWEEP created ${suffix}`,
  })

  function probesFor(path: string, param: string): string[] {
    const before = path.slice(0, path.indexOf(`[${param}]`))
    if (param === "userId") return [ids.raiserA1, ids.viewer]
    if (param === "orderId") return [String(ids.orderX), String(ids.orderY)]
    if (param === "id") {
      if (/\/orders\/$/.test(before) || /\/approvals\/$/.test(before)) return [String(ids.orderX), String(ids.orderY), String(ids.orderZ)]
      if (/\/branches\/$/.test(before)) return [String(ids.branchA1), String(ids.branchB1)]
      if (/\/organizations\/$/.test(before)) return [String(ids.orgA)]
      if (/\/groups\/$/.test(before)) return [String(ids.groupA)]
      if (/\/users\/$/.test(before)) return [ids.raiserA1, ids.viewer]
      if (/\/inventory\/$|\/global-products\/$|\/products\/$/.test(before)) return [String(ids.productId)]
      return [String(ids.orderX), String(ids.branchA1)]
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
          new NextRequest(`http://localhost${path}?organizationId=${ids.orgA}&branchId=${ids.branchA1}`, {
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

  async function sweepAs(label: string) {
    const admitted: string[] = []
    let calls = 0
    for (const [file, load] of Object.entries(ROUTE_MODULES)) {
      const routeModule = await load()
      const route = file.replace(/^\/app\//, "app/")
      for (const method of WRITE_METHODS) {
        const handler = routeModule[method]
        if (typeof handler !== "function") continue
        for (const path of concretePaths(file)) {
          for (const body of [{}, hostileBody()]) {
            calls += 1
            const status = await callOnce(handler as Handler, method, file, path, body)
            if (/^2\d\d$/.test(status) && !ANSWERS_ANY_CALLER.has(route)) admitted.push(`${label}: ${method} ${path} → ${status}`)
          }
        }
      }
    }
    return { admitted, calls }
  }

  it("is refused by every write handler, organization-wide or pinned, and changes nothing", async () => {
    const before = await protectedState()

    signInAs(ids.viewer, null)
    const wide = await sweepAs("organization-wide")
    signInAs(ids.pinnedViewer, ids.branchA1)
    const pinned = await sweepAs("pinned")

    // The sweep really ran across the write API, twice.
    expect(wide.calls).toBeGreaterThan(150)
    expect(pinned.calls).toBe(wide.calls)
    const admitted = [...wide.admitted, ...pinned.admitted]
    expect(admitted, `Write handlers acted for a Viewer:\n${admitted.join("\n")}`).toEqual([])

    // Second pass: the routes that matter most, each with a body its own schema
    // accepts and aimed at the Viewer's own tenant. A body that is merely wrong
    // is refused with 400 whoever calls; only a valid one shows the role is
    // refused before the work.
    const valid: Array<[string, string, string, unknown]> = [
      ["POST", "app/api/v1/orders/[id]/approve/route.ts", `/api/v1/orders/${ids.orderX}/approve`, {}],
      ["POST", "app/api/v1/orders/[id]/reject/route.ts", `/api/v1/orders/${ids.orderX}/reject`, { reason: "sweep" }],
      ["POST", "app/api/v1/orders/[id]/return-for-correction/route.ts", `/api/v1/orders/${ids.orderX}/return-for-correction`, { comment: "sweep" }],
      ["POST", "app/api/v1/orders/[id]/payment-status/route.ts", `/api/v1/orders/${ids.orderY}/payment-status`, { paymentStatus: "PAID" }],
      ["POST", "app/api/v1/orders/[id]/fulfillment-status/route.ts", `/api/v1/orders/${ids.orderY}/fulfillment-status`, { fulfillmentStatus: "IN_PROCESS" }],
      ["POST", "app/api/v1/orders/[id]/refunds/route.ts", `/api/v1/orders/${ids.orderY}/refunds`, { items: [{ id: ids.itemY, quantity: 1 }], reason: "sweep" }],
      ["PATCH", "app/api/v1/branches/[id]/route.ts", `/api/v1/branches/${ids.branchA1}`, { name: `Hijacked ${suffix}` }],
      ["PATCH", "app/api/v1/users/[id]/access/route.ts", `/api/v1/users/${ids.raiserA1}/access`, { isActive: false }],
      ["PATCH", "app/api/v1/users/[id]/access/route.ts", `/api/v1/users/${ids.viewer}/access`, { role: "HEAD_OFFICE" }],
      ["PUT", "app/api/v1/organizations/join-code/route.ts", "/api/v1/organizations/join-code", { code: `VIEWER-${suffix}` }],
      ["POST", "app/api/v1/groups/route.ts", "/api/v1/groups", { name: `IT VWSWEEP new group ${suffix}`, organizationId: ids.orgA }],
    ]
    const notRefused: string[] = []
    for (const [userId, branchId] of [[ids.viewer, null], [ids.pinnedViewer, ids.branchA1]] as const) {
      signInAs(userId, branchId)
      for (const [method, route, path, body] of valid) {
        const routeModule = await ROUTE_MODULES[`/${route}`]()
        const handler = routeModule[method]
        expect(typeof handler, `${method} ${route}`).toBe("function")
        const status = await callOnce(handler as Handler, method, `/${route}`, path, body)
        if (!["401", "403", "404"].includes(status)) notRefused.push(`${method} ${path} → ${status}`)
      }
    }
    expect(notRefused, `Sensitive routes did not refuse a Viewer up front:\n${notRefused.join("\n")}`).toEqual([])

    const after = await protectedState()
    expect(after.orderRows, "an order changed, or one was created").toEqual(before.orderRows)
    expect(after.lineRows, "an order line changed").toEqual(before.lineRows)
    expect(after.userRows, "a person changed, or one was created").toEqual(before.userRows)
    expect(after.organizationRows, "an organization changed").toEqual(before.organizationRows)
    expect(after.branchRows, "a branch changed, or one was created").toEqual(before.branchRows)
    expect(after.groupRows, "a group changed, or one was created").toEqual(before.groupRows)
    expect(after.productRows, "a price or stock changed").toEqual(before.productRows)
    expect(after.budgetRows, "a budget changed, or one was created").toEqual(before.budgetRows)
    expect(after.joinCodeRows, "the join code changed").toEqual(before.joinCodeRows)
  }, 1_200_000)
})
