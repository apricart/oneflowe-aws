import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { eq, inArray, or } from "drizzle-orm"

import {
  auditLogs,
  branches,
  globalProducts,
  groupAuditLogs,
  groups,
  orderItems,
  orders,
  organizations,
  roles,
  systemLogs,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { VIEWER_DASHBOARD_ROUTES, VIEWER_READ_ROUTES } from "@/lib/viewer-access"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Does a Viewer ever read data outside its reach, on any GET handler?
 * See plans/OF-VIEWER-head-office-read-only-menu.md.
 *
 * The proxy is skipped (it is never the boundary). Every GET handler under
 * `app/api/v1` is called directly, with each dynamic id and each tenant filter
 * pointed outside the caller's reach, and fails if a successful response
 * carries a marker planted in those rows:
 *
 * ```text
 * Tenant A                                   Tenant B (marker -OUTB)
 *   A1  ← the pinned Viewer's branch           B1, group G-B
 *     order X                                    order Z, its raiser, its Head Office
 *   A2  (marker -OUTA2)
 *     order Y, its raiser
 * ```
 *
 *   * the organization-wide Viewer may read all of tenant A and nothing of B,
 *     and only on `VIEWER_READ_ROUTES` or a handler reviewed below;
 *   * the branch-pinned Viewer may read branch A1 alone, and only on its
 *     dashboard's routes or a handler reviewed below.
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
type GetHandler = (req: NextRequest, ctx: unknown) => Promise<Response>
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
  const [created] = await db.insert(roles).values({ name, description: "Created by the viewer sweep" }).returning({ id: roles.id })
  return created.id
}

/**
 * Handlers that answer any signed-in tenant caller, reviewed for the Viewer:
 * each returns the caller's own record, the shared global catalogue, or rows
 * of the caller's own organization that every role in it already reads.
 */
const ANSWERS_ANY_SIGNED_IN_CALLER = new Set<string>([
  // Public liveness check.
  "app/api/v1/health/route.ts",
  // The caller's own unpaid invoice and own import batches, keyed on its user id.
  "app/api/v1/orders/pending-invoice/route.ts",
  "app/api/v1/inventory/import/route.ts",
  // The caller's own notices: none for this role, which is outside the list.
  "app/api/v1/notifications/route.ts",
])

describe.skipIf(!hasTestDatabase)("a Viewer, calling every GET handler directly", () => {
  const suffix = randomUUID().slice(0, 8)
  const OUT_A2 = `${suffix}-OUTA2`
  const OUT_B = `${suffix}-OUTB`

  const ids = {
    orgA: 0, orgB: 0, branchA1: 0, branchA2: 0, branchB1: 0, groupB: 0,
    orderX: 0, orderY: 0, orderZ: 0, productId: 0,
    viewer: "", pinnedViewer: "", raiserA1: "", raiserA2: "", raiserB: "", headOfficeB: "",
  }
  const userIds: string[] = []

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all(
      ["VIEWER", "ORDER_PORTAL", "HEAD_OFFICE"].map(async (name) => [name, await resolveRoleId(name)] as const),
    ))

    const [a] = await db.insert(organizations).values({ name: `IT VSWEEP ORG A ${suffix}`, code: `ITVSA_${suffix}` }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT VSWEEP ${OUT_B} org`, code: `ITVSB_${suffix}` }).returning({ id: organizations.id })
    ids.orgA = a.id
    ids.orgB = b.id

    const [a1, a2, b1] = await db.insert(branches).values([
      { organizationId: ids.orgA, name: `IT VSWEEP A1 ${suffix}`, city: "Lahore", status: "active" },
      { organizationId: ids.orgA, name: `IT VSWEEP ${OUT_A2} branch`, city: `${OUT_A2} city`, address: `${OUT_A2} address`, status: "active" },
      { organizationId: ids.orgB, name: `IT VSWEEP ${OUT_B} branch`, city: `${OUT_B} city`, address: `${OUT_B} address`, status: "active" },
    ]).returning({ id: branches.id })
    ids.branchA1 = a1.id
    ids.branchA2 = a2.id
    ids.branchB1 = b1.id

    const person = async (label: string, role: string, organizationId: number, branchId: number | null, marker: string) => {
      const [row] = await db.insert(users).values({
        email: `it-vsweep-${label}-${marker}@example.test`,
        username: `it-vsweep-${label}-${suffix}`,
        passwordHash: "x",
        roleId: roleIds[role],
        organizationId,
        branchId,
        fullName: `${label} ${marker}`,
        phone: "+920000000000",
      }).returning({ id: users.id })
      userIds.push(row.id)
      return row.id
    }
    ids.viewer = await person("viewer", "VIEWER", ids.orgA, null, suffix)
    ids.pinnedViewer = await person("pinned", "VIEWER", ids.orgA, ids.branchA1, suffix)
    ids.raiserA1 = await person("raiserA1", "ORDER_PORTAL", ids.orgA, ids.branchA1, suffix)
    ids.raiserA2 = await person("raiserA2", "ORDER_PORTAL", ids.orgA, ids.branchA2, OUT_A2)
    ids.raiserB = await person("raiserB", "ORDER_PORTAL", ids.orgB, ids.branchB1, OUT_B)
    ids.headOfficeB = await person("headOfficeB", "HEAD_OFFICE", ids.orgB, null, OUT_B)

    const [g] = await db.insert(groups).values({ organizationId: ids.orgB, name: `IT VSWEEP ${OUT_B} group`, createdByUserId: ids.headOfficeB })
      .returning({ id: groups.id })
    ids.groupB = g.id

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITVS-${suffix}`, name: `IT viewer sweep product ${suffix}`, basePrice: 1000, status: "active", unit: "piece", stockQuantity: 10,
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
        receiptData: { invoiceNumber: `INV-${tid}` } as any,
      }).returning({ id: orders.id })
      await db.insert(orderItems).values({
        orderId: row.id, organizationId, globalProductId: ids.productId, productName: "Sweep item", productCode: `ITVS-${suffix}`, unit: "piece", quantity: 1, priceCents: 1000,
      })
      return row.id
    }
    ids.orderX = await place(`VS${suffix}A1X`, ids.orgA, ids.branchA1, ids.raiserA1, null)
    ids.orderY = await place(`${OUT_A2}Y`, ids.orgA, ids.branchA2, ids.raiserA2, `${OUT_A2} note`)
    ids.orderZ = await place(`${OUT_B}Z`, ids.orgB, ids.branchB1, ids.raiserB, `${OUT_B} note`)
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
    await db.delete(groupAuditLogs).where(or(
      inArray(groupAuditLogs.organizationId, organizationIds),
      eq(groupAuditLogs.groupId, ids.groupB),
      inArray(groupAuditLogs.performedByUserId, userIds),
    ))
    await db.delete(groups).where(eq(groups.id, ids.groupB))
    await db.delete(globalProducts).where(eq(globalProducts.id, ids.productId))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(users).where(inArray(users.id, userIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  function signInAs(userId: string, branchId: number | null) {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: userId,
        email: `it-vsweep-${userId}@example.test`,
        role: "VIEWER",
        organizationId: ids.orgA,
        branchId,
        mustChangePassword: false,
      },
    } as any)
  }

  /** For one dynamic segment, the ids worth probing with: one in reach, the rest outside it. */
  function probesFor(path: string, param: string): string[] {
    const before = path.slice(0, path.indexOf(`[${param}]`))
    if (param === "userId") return [ids.raiserB, ids.raiserA2]
    if (param === "orderId") return [String(ids.orderX), String(ids.orderY), String(ids.orderZ)]
    if (param === "id") {
      if (/\/orders\/$/.test(before) || /\/approvals\/$/.test(before)) return [String(ids.orderX), String(ids.orderY), String(ids.orderZ)]
      if (/\/branches\/$/.test(before)) return [String(ids.branchA1), String(ids.branchA2), String(ids.branchB1)]
      if (/\/organizations\/$/.test(before)) return [String(ids.orgA), String(ids.orgB)]
      if (/\/groups\/$/.test(before)) return [String(ids.groupB)]
      if (/\/users\/$/.test(before)) return [ids.raiserB, ids.raiserA2]
      return [String(ids.orderY), String(ids.orderZ), String(ids.branchB1)]
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

  /** Every GET handler, as the signed-in Viewer: the leaks found and the routes that answered. */
  async function sweep(markers: string[], outOfReach: { branchIds: string; branchId: number }) {
    const query = `organizationId=${ids.orgB}&branchId=${outOfReach.branchId}&orgId=${ids.orgB}&branchIds=${outOfReach.branchIds}&organizationIds=${ids.orgB}&groupId=${ids.groupB}&groupIds=${ids.groupB}&orderId=${ids.orderZ}&all=true&q=${suffix}&search=${suffix}`
    const leaks: string[] = []
    const admitted = new Set<string>()
    let calls = 0
    for (const [file, load] of Object.entries(ROUTE_MODULES)) {
      const handler = (await load()).GET
      if (typeof handler !== "function") continue
      for (const path of concretePaths(file)) {
        for (const search of ["", `?${query}`]) {
          calls += 1
          const { status, body } = await callOnce(handler as GetHandler, file, path, search)
          if (body === null) continue
          admitted.add(file.replace(/^\/app\//, "app/"))
          const found = markers.filter((marker) => body.includes(marker))
          if (found.length > 0) leaks.push(`${path}${search} → ${status} carries ${found.join(", ")}`)
        }
      }
    }
    return { leaks, admitted: [...admitted], calls }
  }

  it("never shows an organization-wide Viewer another tenant, on any GET handler", async () => {
    signInAs(ids.viewer, null)
    const { leaks, admitted, calls } = await sweep([OUT_B], { branchIds: `${ids.branchB1}`, branchId: ids.branchB1 })

    expect(calls).toBeGreaterThan(200)
    expect(leaks, `Another tenant's data reached the Viewer:\n${leaks.join("\n")}`).toEqual([])

    const allowed = new Set([...VIEWER_READ_ROUTES, ...ANSWERS_ANY_SIGNED_IN_CALLER])
    const unexpected = admitted.filter((route) => !allowed.has(route))
    expect(unexpected, `Handlers outside the Viewer's list answered it:\n${unexpected.join("\n")}`).toEqual([])
    // The menu really works: the main reads answered.
    for (const route of [
      "app/api/v1/orders/route.ts", "app/api/v1/users/route.ts", "app/api/v1/budgets/route.ts",
      "app/api/v1/activity-logs/route.ts", "app/api/v1/support/threads/route.ts", "app/api/v1/analytics/summary/route.ts",
    ]) {
      expect(admitted, route).toContain(route)
    }
  }, 600_000)

  it("keeps a branch-pinned Viewer on its dashboard's routes and its own branch", async () => {
    signInAs(ids.pinnedViewer, ids.branchA1)
    const { leaks, admitted, calls } = await sweep([OUT_B, OUT_A2], { branchIds: `${ids.branchA2},${ids.branchB1}`, branchId: ids.branchA2 })

    expect(calls).toBeGreaterThan(200)
    expect(leaks, `Data outside the pinned Viewer's branch reached it:\n${leaks.join("\n")}`).toEqual([])

    const allowed = new Set([...VIEWER_DASHBOARD_ROUTES, ...ANSWERS_ANY_SIGNED_IN_CALLER])
    const unexpected = admitted.filter((route) => !allowed.has(route))
    expect(unexpected, `Handlers beyond the dashboard answered a pinned Viewer:\n${unexpected.join("\n")}`).toEqual([])
  }, 600_000)
})

