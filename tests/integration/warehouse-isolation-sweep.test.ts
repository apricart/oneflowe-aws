import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { eq, inArray, or } from "drizzle-orm"

import {
  auditLogs,
  branches,
  globalProducts,
  groups,
  orderItems,
  orders,
  organizations,
  roles,
  systemLogs,
  users,
  warehouseAssignments,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { WAREHOUSE_API_RULES } from "@/lib/warehouse-access"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Does a warehouse user ever see data outside the branches assigned to it?
 * See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 *
 * `proxy.ts` refuses a warehouse session every API path outside
 * `WAREHOUSE_API_RULES`, but the proxy is a second layer, never the boundary
 * (`.claude/rules/01-architecture.md`). So this sweep skips it: it calls
 * **every GET handler under `app/api/v1`** directly, as a warehouse user,
 * pointing each dynamic id and each tenant filter at rows outside its reach,
 * and fails if any successful response carries a marker planted in those rows.
 *
 * ```text
 * Tenant A                                Tenant B (marker -OUTB)
 *   A1  ← the warehouse's only branch       B1, group G-B
 *     order X                                 order Z, its raiser
 *   A2  (marker -OUTA2)
 *     order Y, its raiser
 * Every person carries the marker -PERSON: the warehouse sees no one.
 * ```
 *
 * Identity, headers, the rate limiter, the cache and S3 are faked; the
 * handlers, their role checks and their SQL are real.
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

/** One call may not hang the sweep on an external service the test does not fake. */
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
  const [created] = await db.insert(roles).values({ name, description: "Created by the warehouse sweep" }).returning({ id: roles.id })
  return created.id
}

describe.skipIf(!hasTestDatabase)("a warehouse user, calling every API handler directly", () => {
  const suffix = randomUUID().slice(0, 8)
  const OUT_A2 = `${suffix}-OUTA2`
  const OUT_B = `${suffix}-OUTB`
  const PERSON = `${suffix}-PERSON`
  const markers = [OUT_A2, OUT_B, PERSON]

  const ids = {
    orgA: 0, orgB: 0, branchA1: 0, branchA2: 0, branchB1: 0, groupB: 0,
    orderX: 0, orderY: 0, orderZ: 0, productId: 0,
    warehouse: "", raiserA2: "", raiserB: "", raiserA1: "", headOfficeB: "",
  }
  const userIds: string[] = []

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all(
      ["WAREHOUSE", "ORDER_PORTAL", "HEAD_OFFICE"].map(async (name) => [name, await resolveRoleId(name)] as const),
    ))

    const [a] = await db.insert(organizations).values({ name: `IT SWEEP ORG A ${suffix}`, code: `ITSWA_${suffix}` }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT SWEEP ${OUT_B} org`, code: `ITSWB_${suffix}` }).returning({ id: organizations.id })
    ids.orgA = a.id
    ids.orgB = b.id

    const [a1, a2, b1] = await db.insert(branches).values([
      { organizationId: ids.orgA, name: `IT SWEEP A1 ${suffix}`, city: "Lahore", status: "active" },
      { organizationId: ids.orgA, name: `IT SWEEP ${OUT_A2} branch`, city: `${OUT_A2} city`, address: `${OUT_A2} address`, status: "active" },
      { organizationId: ids.orgB, name: `IT SWEEP ${OUT_B} branch`, city: `${OUT_B} city`, address: `${OUT_B} address`, status: "active" },
    ]).returning({ id: branches.id })
    ids.branchA1 = a1.id
    ids.branchA2 = a2.id
    ids.branchB1 = b1.id

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null) => {
      const email = label === "warehouse" ? `it-sweep-wh-${suffix}@example.test` : `it-sweep-${label}-${PERSON}@example.test`
      const [row] = await db.insert(users).values({
        email,
        username: `it-sweep-${label}-${suffix}`,
        passwordHash: "x",
        roleId: roleIds[role],
        organizationId,
        branchId,
        fullName: label === "warehouse" ? `Sweep warehouse ${suffix}` : `${label} ${PERSON}`,
        phone: label === "warehouse" ? null : "+920000000000",
      }).returning({ id: users.id })
      userIds.push(row.id)
      return row.id
    }
    ids.warehouse = await person("warehouse", "WAREHOUSE", null, null)
    ids.raiserA1 = await person("raiserA1", "ORDER_PORTAL", ids.orgA, ids.branchA1)
    ids.raiserA2 = await person("raiserA2", "ORDER_PORTAL", ids.orgA, ids.branchA2)
    ids.raiserB = await person("raiserB", "ORDER_PORTAL", ids.orgB, ids.branchB1)
    ids.headOfficeB = await person("headOfficeB", "HEAD_OFFICE", ids.orgB, null)

    const [g] = await db.insert(groups).values({ organizationId: ids.orgB, name: `IT SWEEP ${OUT_B} group`, createdByUserId: ids.headOfficeB })
      .returning({ id: groups.id })
    ids.groupB = g.id

    await db.insert(warehouseAssignments).values({ userId: ids.warehouse, branchId: ids.branchA1 })

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITSW-${suffix}`, name: `IT sweep product ${suffix}`, basePrice: 1000, status: "active", unit: "piece", stockQuantity: 10,
    }).returning({ id: globalProducts.id })
    ids.productId = product.id

    const place = async (tid: string, organizationId: number, branchId: number, createdByUserId: string, notes: string | null) => {
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
        notes,
        receiptData: { invoiceNumber: `INV-${tid}`, buyerName: `buyer ${PERSON}` } as any,
      }).returning({ id: orders.id })
      await db.insert(orderItems).values({
        orderId: row.id, organizationId, globalProductId: ids.productId, productName: "Sweep item", productCode: `ITSW-${suffix}`, unit: "piece", quantity: 1, priceCents: 1000,
      })
      return row.id
    }
    ids.orderX = await place(`SW${suffix}A1X`, ids.orgA, ids.branchA1, ids.raiserA1, null)
    ids.orderY = await place(`${OUT_A2}Y`, ids.orgA, ids.branchA2, ids.raiserA2, `${OUT_A2} note`)
    ids.orderZ = await place(`${OUT_B}Z`, ids.orgB, ids.branchB1, ids.raiserB, `${OUT_B} note`)

    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: ids.warehouse,
        email: `it-sweep-wh-${suffix}@example.test`,
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
    await db.delete(groups).where(eq(groups.id, ids.groupB))
    await db.delete(globalProducts).where(eq(globalProducts.id, ids.productId))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(users).where(inArray(users.id, userIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  /** For one dynamic segment, the ids outside the reach worth probing with. */
  function probesFor(path: string, param: string): string[] {
    const before = path.slice(0, path.indexOf(`[${param}]`))
    if (param === "userId") return [ids.raiserB, ids.raiserA2]
    if (param === "orderId") return [String(ids.orderY), String(ids.orderZ)]
    if (param === "id") {
      if (/\/orders\/$/.test(before) || /\/approvals\/$/.test(before)) return [String(ids.orderY), String(ids.orderZ)]
      if (/\/branches\/$/.test(before)) return [String(ids.branchA2), String(ids.branchB1)]
      if (/\/organizations\/$/.test(before)) return [String(ids.orgB)]
      if (/\/groups\/$/.test(before)) return [String(ids.groupB)]
      if (/\/users\/$/.test(before)) return [ids.raiserB, ids.raiserA2]
      return [String(ids.orderY), String(ids.branchA2)]
    }
    return ["1"]
  }

  /** Every concrete URL path to try for one route file. */
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

  /** One call, as the warehouse: its status, and the body when it succeeded. */
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

  it("never returns a row, a name or a person from outside its branches, on any GET handler", async () => {
    const outOfReachQuery = `organizationId=${ids.orgB}&branchId=${ids.branchB1}&orgId=${ids.orgB}&branchIds=${ids.branchA2},${ids.branchB1}&organizationIds=${ids.orgB}&groupId=${ids.groupB}&orderId=${ids.orderZ}&q=${suffix}&search=${suffix}`
    const leaks: string[] = []
    const admitted: string[] = []
    let calls = 0

    const attempts = async (file: string, handler: GetHandler) => {
      for (const path of concretePaths(file)) {
        for (const query of ["", `?${outOfReachQuery}`]) {
          calls += 1
          const { status, body } = await callOnce(handler, file, path, query)
          if (body === null) continue
          admitted.push(`${file.replace(/^\/app\//, "app/")} ${status}`)
          const found = markers.filter((marker) => body.includes(marker))
          if (found.length > 0) leaks.push(`${path}${query} → ${status} carries ${found.join(", ")}`)
        }
      }
    }

    for (const [file, load] of Object.entries(ROUTE_MODULES)) {
      const handler = (await load()).GET
      if (typeof handler === "function") await attempts(file, handler as GetHandler)
    }

    // The sweep really ran across the API, as the warehouse.
    expect(calls).toBeGreaterThan(200)
    expect(leaks, `Data outside the warehouse's branches reached it:\n${leaks.join("\n")}`).toEqual([])

    // Defence in depth: the only handlers that answer a warehouse session at
    // all are its own, the account's own password endpoints, and those that
    // answer every signed-in caller with nothing tenant-shaped.
    const ownRoutes = new Set(WAREHOUSE_API_RULES.map((rule) => rule.route))
    const unexpected = [...new Set(admitted.map((entry) => entry.split(" ")[0]))]
      .filter((route) => !ownRoutes.has(route))
      .filter((route) => !ANSWERS_ANY_SIGNED_IN_CALLER.has(route))
    expect(unexpected, `Handlers outside the warehouse's allowlist admitted it:\n${unexpected.join("\n")}`).toEqual([])
  }, 600_000)
})

/**
 * Handlers that answer any signed-in caller, reviewed for the warehouse: each
 * returns only the caller's own record or nothing tenant-specific. The proxy
 * still refuses a warehouse session all of them except its own allowlist.
 */
const ANSWERS_ANY_SIGNED_IN_CALLER = new Set<string>([
  // Public liveness check.
  "app/api/v1/health/route.ts",
  // The caller's own unpaid invoice and own import batches, keyed on its user id.
  "app/api/v1/orders/pending-invoice/route.ts",
  "app/api/v1/inventory/import/route.ts",
  // A role without an organization reads nothing: DENY_ALL_ORDERS, an
  // `organization_id = NULL` filter, and a role list that excludes it.
  "app/api/v1/orders/route.ts",
  "app/api/v1/analytics/users/list/route.ts",
  "app/api/v1/notifications/route.ts",
  // The global product catalogue — names, codes, stock — which the warehouse
  // already reads on its own Stock tab. No tenant's assignment, override or
  // price is joined for a caller with no organization.
  "app/api/v1/analytics/products/list/route.ts",
  "app/api/v1/analytics/products/catalog-performance/route.ts",
])
