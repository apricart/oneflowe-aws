import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { eq, inArray, or } from "drizzle-orm"

import * as dashboardRoute from "@/app/api/v1/delivery-dashboard/route"
import * as timelineRoute from "@/app/api/v1/delivery-dashboard/orders/[id]/timeline/route"
import * as branchesRoute from "@/app/api/v1/branches/route"
import * as branchRoute from "@/app/api/v1/branches/[id]/route"
import * as usersRoute from "@/app/api/v1/users/route"
import {
  auditLogs,
  branchDeliveryAddresses,
  branches,
  legacyImportBatches,
  legacyOrderImports,
  orders,
  organizations,
  roles,
  systemLogs,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { karachiDay } from "@/lib/delivery-sla"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The management delivery dashboard against Postgres.
 * See plans/OF-DELIVERY-management-delivery-dashboard.md.
 *
 * Only identity, request headers, the rate limiter, the cache and outbound
 * email are faked. Orders are written directly with hand-chosen timestamps,
 * because the point is what the dashboard makes of them.
 *
 * The oracle (hours are before "now"; the SLA is 72 hours from approval):
 *
 * ```text
 * Tenant A  (branch A1: Karachi, SOUTH;  branch A2: Lahore, no region)
 *   A-ONTRACK   approved 10h ago, In Process                → ON_TRACK
 *   A-DUESOON   approved 65h ago, Not Started, to Hyderabad  → DUE_SOON  (city from the delivery address)
 *   A-OVERDUE   approved 99h ago, Out for Delivery           → OVERDUE by 27h
 *   A-LATE      approved 110h ago, delivered 30h ago (80h)   → DELIVERED_LATE by 8h, settled FULFILLED
 *   A-ONTIME    approved 50h ago, delivered 2h ago (48h)     → DELIVERED_ON_TIME
 *   A-OLD       approved 2026-08-20, still open              → left out (before the cutoff)
 *   A-IMPORTED  approved 20h ago, but a legacy import        → left out
 *   A-PENDING   not approved                                  → left out
 *   A-REJECTED  rejected                                      → left out
 * Tenant B  (branch B1: Islamabad, NORTH)
 *   B-OVERDUE   approved 80h ago, In Process                 → OVERDUE by 8h
 * ```
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/email", () => ({ sendWelcomeEmail: vi.fn(async () => true) }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: vi.fn(async () => undefined),
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

const { getServerSession } = mockedNextAuth
const HOUR = 60 * 60 * 1000

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor ? ({ user: { ...actor, mustChangePassword: false } } as any) : null,
  )
}

const request = (url: string, method = "GET", body?: unknown) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function read(response: Response) {
  return { status: response.status, body: await response.json() }
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by delivery dashboard tests" })
    .returning({ id: roles.id })
  return created.id
}

describe.skipIf(!hasTestDatabase)("the management delivery dashboard through the API", () => {
  const suffix = randomUUID().slice(0, 8)
  const actors: Record<string, Actor> = {}
  const orderIds: Record<string, number> = {}
  const createdUserIds: string[] = []
  let orgA: number
  let orgB: number
  let branchA1: number
  let branchA2: number
  let branchB1: number
  let batchId: string

  const dashboard = async (actor: Actor | null, query = "") => {
    signIn(actor)
    return read(await dashboardRoute.GET(request(`http://localhost/api/v1/delivery-dashboard${query ? `?${query}` : ""}`)))
  }

  const timeline = async (actor: Actor | null, orderId: number | string) => {
    signIn(actor)
    return read(await timelineRoute.GET(
      request(`http://localhost/api/v1/delivery-dashboard/orders/${orderId}/timeline`),
      { params: Promise.resolve({ id: String(orderId) }) },
    ))
  }

  /** The rows of this suite only: other suites' leftovers never bend the oracle. */
  const tenantA = (query = "") => dashboard(actors.executive, `organizationId=${orgA}${query ? `&${query}` : ""}`)
  const tids = (items: Array<{ tid: string }>) => items.map((item) => item.tid)

  beforeAll(async () => {
    const roleIds = {
      superAdmin: await resolveRoleId("SUPER_ADMIN"),
      executive: await resolveRoleId("APRICART_EXECUTIVE"),
      headOffice: await resolveRoleId("HEAD_OFFICE"),
      branchAdmin: await resolveRoleId("BRANCH_ADMIN"),
      groupUser: await resolveRoleId("GROUP_USER"),
      orderPortal: await resolveRoleId("ORDER_PORTAL"),
      viewer: await resolveRoleId("VIEWER"),
      orderDesk: await resolveRoleId("ORDER_DESK"),
    }

    const [a] = await db.insert(organizations).values({ name: `IT DD A ${suffix}`, code: `ITDDA_${suffix}` }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT DD B ${suffix}`, code: `ITDDB_${suffix}` }).returning({ id: organizations.id })
    orgA = a.id
    orgB = b.id

    const [a1, a2, b1] = await db.insert(branches).values([
      { organizationId: orgA, name: `IT DD A1 ${suffix}`, city: "Karachi", province: "Sindh", region: "SOUTH" },
      { organizationId: orgA, name: `IT DD A2 ${suffix}`, city: "Lahore", province: "Punjab" },
      { organizationId: orgB, name: `IT DD B1 ${suffix}`, city: "Islamabad", region: "NORTH" },
    ]).returning({ id: branches.id })
    branchA1 = a1.id
    branchA2 = a2.id
    branchB1 = b1.id

    const person = async (label: string, roleId: number, role: string, organizationId: number | null, branchId: number | null) => {
      const email = `it-dd-${label}-${suffix}@example.test`
      const [row] = await db.insert(users).values({
        email, username: `it-dd-${label}-${suffix}`, passwordHash: "x", roleId, organizationId, branchId, fullName: `${label} ${suffix}`,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }
    await person("superAdmin", roleIds.superAdmin, "SUPER_ADMIN", null, null)
    await person("executive", roleIds.executive, "APRICART_EXECUTIVE", null, null)
    await person("formerExecutive", roleIds.executive, "APRICART_EXECUTIVE", null, null)
    await person("headOffice", roleIds.headOffice, "HEAD_OFFICE", orgA, null)
    await person("branchAdmin", roleIds.branchAdmin, "BRANCH_ADMIN", orgA, branchA1)
    await person("groupUser", roleIds.groupUser, "GROUP_USER", orgA, null)
    await person("orderPortal", roleIds.orderPortal, "ORDER_PORTAL", orgA, branchA1)
    await person("viewer", roleIds.viewer, "VIEWER", orgA, null)
    await person("orderDesk", roleIds.orderDesk, "ORDER_DESK", null, null)
    await db.update(users).set({ isActive: false }).where(eq(users.id, actors.formerExecutive.id))

    const [hyderabad] = await db.insert(branchDeliveryAddresses).values({
      organizationId: orgA, branchId: branchA1, label: "Site", labelKey: "site", address: "Plot 1", city: "Hyderabad",
      status: "approved", requestedByUserId: actors.orderPortal.id, decidedByUserId: actors.headOffice.id, decidedAt: new Date(),
    }).returning({ id: branchDeliveryAddresses.id })

    const now = Date.now()
    const ago = (hours: number) => new Date(now - hours * HOUR)
    const place = async (key: string, values: {
      organizationId: number
      branchId: number
      status: string
      fulfillmentStatus?: string
      approvedAt?: Date | null
      deliveredAt?: Date | null
      deliveryAddressId?: number
    }) => {
      const [row] = await db.insert(orders).values({
        tid: `DD${suffix}${key}`.slice(0, 26),
        createdByUserId: actors.orderPortal.id,
        createdByRole: "ORDER_PORTAL",
        createdAt: values.approvedAt ? new Date(values.approvedAt.getTime() - HOUR) : new Date(),
        ...values,
      }).returning({ id: orders.id })
      orderIds[key] = row.id
    }

    await place("ONTRACK", { organizationId: orgA, branchId: branchA1, status: "APPROVED", fulfillmentStatus: "IN_PROCESS", approvedAt: ago(10) })
    await place("DUESOON", { organizationId: orgA, branchId: branchA1, status: "APPROVED", fulfillmentStatus: "NOT_STARTED", approvedAt: ago(65), deliveryAddressId: hyderabad.id })
    await place("OVERDUE", { organizationId: orgA, branchId: branchA2, status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY", approvedAt: ago(99) })
    // Delivered 30 hours ago: always an earlier Karachi day than "now".
    await place("LATE", { organizationId: orgA, branchId: branchA1, status: "FULFILLED", fulfillmentStatus: "DELIVERED", approvedAt: ago(110), deliveredAt: ago(30) })
    await place("ONTIME", { organizationId: orgA, branchId: branchA2, status: "APPROVED", fulfillmentStatus: "DELIVERED", approvedAt: ago(50), deliveredAt: ago(2) })
    await place("OLD", { organizationId: orgA, branchId: branchA1, status: "APPROVED", fulfillmentStatus: "IN_PROCESS", approvedAt: new Date("2026-08-20T05:00:00Z") })
    await place("IMPORTED", { organizationId: orgA, branchId: branchA1, status: "APPROVED", fulfillmentStatus: "IN_PROCESS", approvedAt: ago(20) })
    await place("PENDING", { organizationId: orgA, branchId: branchA1, status: "PENDING", approvedAt: null })
    await place("REJECTED", { organizationId: orgA, branchId: branchA1, status: "REJECTED", approvedAt: null })
    await place("BOVERDUE", { organizationId: orgB, branchId: branchB1, status: "APPROVED", fulfillmentStatus: "IN_PROCESS", approvedAt: ago(80) })

    const [batch] = await db.insert(legacyImportBatches).values({
      organizationId: orgA, sourceSystem: "IT_DD", sourceManifest: {}, importedByUserId: actors.superAdmin.id,
    }).returning({ id: legacyImportBatches.id })
    batchId = batch.id
    await db.insert(legacyOrderImports).values({
      batchId, organizationId: orgA, sourceSystem: "IT_DD", legacyOrderId: 1, orderId: orderIds.IMPORTED,
      sourceChecksum: "x", sourcePayload: {},
    })

    // The trail the timeline is rebuilt from: an approval and two stage moves,
    // the second spelled the way the progress route spells it.
    await db.insert(auditLogs).values([
      { userId: actors.branchAdmin.id, organizationId: orgA, branchId: branchA2, action: "ORDER_APPROVED", entity: "order", entityId: String(orderIds.OVERDUE), metadata: {}, createdAt: ago(99) },
      { userId: actors.superAdmin.id, organizationId: orgA, branchId: branchA2, action: "ORDER_FULFILLMENT_STATUS_UPDATE", entity: "Order", entityId: String(orderIds.OVERDUE), metadata: { from: "NOT_STARTED", to: "IN_PROCESS" }, createdAt: ago(90) },
      { userId: actors.superAdmin.id, organizationId: orgA, branchId: branchA2, action: "ORDER_FULFILLMENT_STATUS_UPDATE", entity: "Order", entityId: String(orderIds.OVERDUE), metadata: { from: "IN_PROCESS", to: "OUT_FOR_DELIVERY" }, createdAt: ago(40) },
      // Another tenant's row that happens to name the same order id is ignored.
      { userId: actors.superAdmin.id, organizationId: orgB, action: "ORDER_FULFILLMENT_STATUS_UPDATE", entity: "Order", entityId: String(orderIds.OVERDUE), metadata: { from: "IN_PROCESS", to: "DELIVERED" }, createdAt: ago(30) },
    ])
  })

  afterAll(async () => {
    if (!orgA) return
    const organizationIds = [orgA, orgB]
    const actorIds = [...Object.values(actors).map((actor) => actor.id), ...createdUserIds]
    await db.delete(legacyOrderImports).where(inArray(legacyOrderImports.organizationId, organizationIds))
    if (batchId) await db.delete(legacyImportBatches).where(eq(legacyImportBatches.id, batchId))
    await db.delete(orders).where(inArray(orders.organizationId, organizationIds))
    await db.delete(branchDeliveryAddresses).where(inArray(branchDeliveryAddresses.organizationId, organizationIds))
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, actorIds)))
    await db.delete(systemLogs).where(or(inArray(systemLogs.organizationId, organizationIds), inArray(systemLogs.userId, actorIds)))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("who may read it", () => {
    it("refuses an unauthenticated caller", async () => {
      expect((await dashboard(null)).status).toBe(401)
      expect((await timeline(null, orderIds.OVERDUE)).status).toBe(401)
    })

    it.each(["headOffice", "branchAdmin", "groupUser", "orderPortal", "viewer", "orderDesk"])("refuses %s", async (key) => {
      expect((await dashboard(actors[key])).status).toBe(403)
      expect((await timeline(actors[key], orderIds.OVERDUE)).status).toBe(403)
    })

    it("refuses an executive account that has been deactivated, whatever its session says", async () => {
      expect((await dashboard(actors.formerExecutive)).status).toBe(403)
    })

    it("refuses a session that names a role the account no longer holds", async () => {
      expect((await dashboard({ ...actors.headOffice, role: "APRICART_EXECUTIVE" })).status).toBe(403)
    })

    it("admits the executive and Super Admin, across every tenant", async () => {
      for (const reader of [actors.executive, actors.superAdmin]) {
        const { status, body } = await dashboard(reader)
        expect(status).toBe(200)
        const clients = body.byOrganization.map((group: { key: string }) => group.key)
        expect(clients).toEqual(expect.arrayContaining([String(orgA), String(orgB)]))
      }
    })
  })

  describe("what it counts", () => {
    it("matches the oracle for one tenant", async () => {
      const { status, body } = await tenantA()
      expect(status).toBe(200)
      // A-ONTIME was delivered two hours ago: "today" unless that crossed
      // Karachi midnight. A-LATE never is.
      const deliveredToday = karachiDay(new Date(Date.now() - 2 * HOUR)) === karachiDay(new Date()) ? 1 : 0
      expect(body.kpis).toMatchObject({
        open: 3,
        onTrack: 1,
        dueSoon: 1,
        overdue: 1,
        delivered: 2,
        deliveredOnTime: 1,
        deliveredLate: 1,
        deliveredToday,
        notStarted: 1,
        inProcess: 1,
        outForDelivery: 1,
        awaitingAcknowledgement: 1,
        acknowledged: 1,
        openOutsideRange: 0,
        onTimeRate: 50,
        averageDeliveryHours: 64,
      })
      expect(body.sla).toEqual({ hours: 72, dueSoonHours: 12, countsOrdersApprovedFrom: "2026-09-01" })
    })

    it("leaves out pre-cutoff, imported, pending and rejected orders", async () => {
      const { body } = await tenantA()
      const listed = tids(body.orders.items)
      for (const key of ["OLD", "IMPORTED", "PENDING", "REJECTED"]) {
        expect(listed).not.toContain(`DD${suffix}${key}`.slice(0, 26))
      }
      expect(body.orders.total).toBe(5)
    })

    it("lists the most overdue first, with no money and no people", async () => {
      const { body } = await tenantA()
      expect(body.orders.items[0]).toMatchObject({
        id: orderIds.OVERDUE,
        health: "OVERDUE",
        hoursOverdue: 27,
        stage: "OUT_FOR_DELIVERY",
        city: "Lahore",
        region: "Unknown",
      })
      expect(body.orders.items[1]).toMatchObject({ id: orderIds.DUESOON, health: "DUE_SOON", city: "Hyderabad", region: "South" })
      expect(JSON.stringify(body)).not.toMatch(/cents|price|email|phone|fullName|createdByUserId/i)
    })

    it("breaks down by destination city, region and pipeline", async () => {
      const { body } = await tenantA()
      const cities = Object.fromEntries(body.byCity.map((group: { label: string; open: number }) => [group.label, group.open]))
      expect(cities).toEqual({ Lahore: 1, Hyderabad: 1, Karachi: 1 })
      const regions = Object.fromEntries(body.byRegion.map((group: { key: string; open: number }) => [group.key, group.open]))
      expect(regions).toEqual({ UNKNOWN: 1, SOUTH: 2 })
      expect(body.pipeline.map((entry: { stage: string; count: number }) => [entry.stage, entry.count])).toEqual([
        ["NOT_STARTED", 1],
        ["IN_PROCESS", 1],
        ["OUT_FOR_DELIVERY", 1],
      ])
      expect(body.overdueAge.find((bucket: { key: string }) => bucket.key === "24-48").count).toBe(1)
      expect(body.options.branches.map((branch: { id: number }) => branch.id).sort()).toEqual([branchA1, branchA2].sort())
    })
  })

  describe("filters", () => {
    it("narrows by region, city, branch, stage and list", async () => {
      expect((await tenantA("region=SOUTH")).body.kpis.open).toBe(2)
      expect((await tenantA("region=UNKNOWN")).body.kpis.open).toBe(1)
      expect(tids((await tenantA("city=hyderabad")).body.orders.items)).toEqual([`DD${suffix}DUESOON`.slice(0, 26)])
      expect((await tenantA(`branchId=${branchA2}`)).body.orders.total).toBe(2)
      expect((await tenantA("fulfillmentStatus=OUT_FOR_DELIVERY")).body.kpis.open).toBe(1)
      const overdue = await tenantA("view=OVERDUE")
      expect(overdue.body.orders.items.map((item: { id: number }) => item.id)).toEqual([orderIds.OVERDUE])
      // The cards keep their totals while the list narrows.
      expect(overdue.body.kpis.open).toBe(3)
    })

    it("reads another tenant's branch as empty rather than leaking it", async () => {
      const { status, body } = await dashboard(actors.executive, `organizationId=${orgA}&branchId=${branchB1}`)
      expect(status).toBe(200)
      expect(body.orders.total).toBe(0)
    })

    it("applies the date range to open and delivered orders alike, and counts the open ones it leaves out", async () => {
      const { body } = await tenantA("deliveredFrom=2026-09-01&deliveredTo=2026-09-02")
      expect(body.kpis).toMatchObject({ open: 0, overdue: 0, delivered: 0, acknowledged: 0, openOutsideRange: 3 })
      expect(body.orders.total).toBe(0)
      expect(body.byCity).toEqual([])
    })

    it.each(["status=PENDING", "region=EAST", "branchId=1", "deliveredFrom=bad", "view=NOPE"])("refuses %s", async (query) => {
      expect((await dashboard(actors.executive, query)).status).toBe(400)
    })
  })

  describe("the timeline", () => {
    it("rebuilds the journey from the order and its own tenant's trail", async () => {
      const { status, body } = await timeline(actors.executive, orderIds.OVERDUE)
      expect(status).toBe(200)
      expect(body.delivery).toMatchObject({ health: "OVERDUE", hoursOverdue: 27, deliveredAt: null })
      expect(body.events.map((event: { label: string; by: string | null }) => [event.label, event.by])).toEqual([
        ["Placed", "Order Portal"],
        ["Approved", "Branch Admin"],
        ["In Process", "Super Admin"],
        ["Out for Delivery", "Super Admin"],
      ])
      expect(JSON.stringify(body)).not.toMatch(/email|fullName|cents/i)
    })

    it("reads only orders inside the dashboard", async () => {
      for (const key of ["OLD", "IMPORTED", "PENDING", "REJECTED"]) {
        expect((await timeline(actors.executive, orderIds[key])).status, key).toBe(404)
      }
      expect((await timeline(actors.executive, 2_000_000_000)).status).toBe(404)
      expect((await timeline(actors.executive, "abc")).status).toBe(400)
    })
  })

  describe("branch regions", () => {
    const patch = async (actor: Actor, branchId: number, body: unknown) => {
      signIn(actor)
      return read(await branchRoute.PATCH(
        request(`http://localhost/api/v1/branches/${branchId}`, "PATCH", body),
        { params: Promise.resolve({ id: String(branchId) }) },
      ))
    }

    it("lets Super Admin set and clear a region, and refuses a value outside the list", async () => {
      expect((await patch(actors.superAdmin, branchA2, { region: "CENTRAL" })).status).toBe(200)
      expect((await tenantA("region=CENTRAL")).body.kpis.open).toBe(1)
      expect((await patch(actors.superAdmin, branchA2, { region: "EAST" })).status).toBe(400)
      expect((await patch(actors.superAdmin, branchA2, { region: null })).status).toBe(200)
      const [row] = await db.select({ region: branches.region }).from(branches).where(eq(branches.id, branchA2))
      expect(row.region).toBeNull()
    })

    it("refuses the region to Head Office, even on its own branch, but lets it edit the rest", async () => {
      expect((await patch(actors.headOffice, branchA2, { region: "SOUTH" })).status).toBe(403)
      expect((await patch(actors.headOffice, branchA2, { city: "Lahore" })).status).toBe(200)
      signIn(actors.headOffice)
      const created = await read(await branchesRoute.POST(request("http://localhost/api/v1/branches", "POST", {
        organizationId: orgA, name: `IT DD HO ${suffix}`, province: "Sindh", city: "Karachi", address: "Plot 9 Street", region: "SOUTH",
      })))
      expect(created.status).toBe(403)
    })

    it("is refused by the database outside the list", async () => {
      await expect(db.update(branches).set({ region: "EAST" }).where(eq(branches.id, branchA1))).rejects.toThrow()
    })
  })

  describe("executive accounts", () => {
    const create = async (actor: Actor, overrides: Record<string, unknown>) => {
      signIn(actor)
      const label = randomUUID().slice(0, 6)
      const result = await read(await usersRoute.POST(request("http://localhost/api/v1/users", "POST", {
        firstName: "Exec",
        lastName: label,
        email: `it-dd-new-${label}-${suffix}@example.test`,
        username: `it-dd-new-${label}-${suffix}`,
        password: "Str0ng!Passw0rd#2026",
        role: "APRICART_EXECUTIVE",
        organizationId: null,
        branchId: null,
        ...overrides,
      })))
      if (result.body?.item?.id) createdUserIds.push(result.body.item.id)
      if (result.body?.user?.id) createdUserIds.push(result.body.user.id)
      return result
    }

    it("are created by Super Admin with no organization", async () => {
      const { status } = await create(actors.superAdmin, {})
      expect([200, 201]).toContain(status)
    })

    it("are refused an organization or a branch", async () => {
      expect((await create(actors.superAdmin, { organizationId: orgA })).status).toBe(400)
    })

    it("cannot be created by Head Office", async () => {
      expect((await create(actors.headOffice, { organizationId: orgA })).status).toBe(403)
    })
  })
})
