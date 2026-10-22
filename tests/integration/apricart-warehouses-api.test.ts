import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, or } from "drizzle-orm"

import * as collectionRoute from "@/app/api/v1/apricart-warehouses/route"
import * as warehouseRoute from "@/app/api/v1/apricart-warehouses/[id]/route"
import * as membersRoute from "@/app/api/v1/apricart-warehouses/[id]/members/route"
import * as branchesRoute from "@/app/api/v1/apricart-warehouses/[id]/branches/route"
import {
  apricartExecutiveAssignments,
  apricartWarehouseMemberships,
  apricartWarehouses,
  auditLogs,
  branches,
  branchFulfillmentRoutes,
  organizations,
  roles,
  users,
  warehouseAssignments,
  warehouseCityAssignments,
  warehouseCityOrganizations,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { loadExecutiveApprovalReach } from "@/lib/server/apricart-executive-scope"
import { loadWarehouseReach } from "@/lib/server/warehouse-scope"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Apricart warehouses, end to end, against Postgres.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 *
 * ```text
 * Tenant A                                      Tenant B
 *   A1 (Multan)  ← wh1 and wh2 serve directly     B1 ← whLonely serves; in no warehouse
 *   A2 (Multan)  ← wh1 serves directly            B2 — nobody serves
 *   A3 (Sukkur)  ← whCity serves through its city
 * ```
 *
 * The configuration must change nothing: every account's live reach is the
 * same after it as before.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor ? ({ user: { ...actor, mustChangePassword: false } } as any) : null,
  )
}

const request = (url: string, method: string, body?: unknown) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function read(response: Response) {
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by warehouse tests" }).returning({ id: roles.id })
  return created.id
}

const BASE = "http://localhost/api/v1/apricart-warehouses"
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!hasTestDatabase)("Apricart warehouses through the API", () => {
  const suffix = randomUUID().slice(0, 8).toUpperCase()
  const actors: Record<string, Actor> = {}
  let orgA: number
  let orgB: number
  let branchA1: number
  let branchA2: number
  let branchA3: number
  let branchB1: number
  let branchB2: number

  const list = async (actor: Actor | null) => {
    signIn(actor)
    return read(await collectionRoute.GET())
  }
  const create = async (actor: Actor | null, body: unknown) => {
    signIn(actor)
    return read(await collectionRoute.POST(request(BASE, "POST", body)))
  }
  const update = async (actor: Actor | null, id: number | string, body: unknown) => {
    signIn(actor)
    return read(await warehouseRoute.PATCH(request(`${BASE}/${id}`, "PATCH", body), params(id)))
  }
  const member = async (actor: Actor | null, id: number | string, body: unknown) => {
    signIn(actor)
    return read(await membersRoute.PUT(request(`${BASE}/${id}/members`, "PUT", body), params(id)))
  }
  const route = async (actor: Actor | null, id: number | string, body: unknown) => {
    signIn(actor)
    return read(await branchesRoute.PUT(request(`${BASE}/${id}/branches`, "PUT", body), params(id)))
  }
  const newWarehouse = async (code: string, name = `Warehouse ${code}`) => {
    const response = await create(actors.superAdmin, { code: `${code}-${suffix}`, name })
    expect(response.status).toBe(201)
    return response.body.item.id as number
  }
  const auditCount = async (action: string, warehouseId: number) => {
    const rows = await db.select({ id: auditLogs.id }).from(auditLogs)
      .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, String(warehouseId))))
    return rows.length
  }
  const routesOf = async (warehouseId: number) => (await db
    .select({ branchId: branchFulfillmentRoutes.branchId })
    .from(branchFulfillmentRoutes)
    .where(eq(branchFulfillmentRoutes.warehouseId, warehouseId)))
    .map((row) => row.branchId)
    .sort((a, b) => a - b)

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all([
      "SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_DESK", "APRICART_EXECUTIVE", "APRICART_SUPPORT", "WAREHOUSE",
    ].map(async (name) => [name, await resolveRoleId(name)] as const)))

    const [a] = await db.insert(organizations).values({ name: `IT AW A ${suffix}`, code: `ITAWA_${suffix}` }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT AW B ${suffix}`, code: `ITAWB_${suffix}` }).returning({ id: organizations.id })
    orgA = a.id
    orgB = b.id
    const city = `Sukkur ${suffix}`
    const [a1, a2, a3, b1, b2] = await db.insert(branches).values([
      { organizationId: orgA, name: `IT AW A1 ${suffix}`, city: `Multan ${suffix}`, status: "active" },
      { organizationId: orgA, name: `IT AW A2 ${suffix}`, city: `Multan ${suffix}`, status: "active" },
      { organizationId: orgA, name: `IT AW A3 ${suffix}`, city, status: "active" },
      { organizationId: orgB, name: `IT AW B1 ${suffix}`, status: "active" },
      { organizationId: orgB, name: `IT AW B2 ${suffix}`, status: "active" },
    ]).returning({ id: branches.id })
    branchA1 = a1.id
    branchA2 = a2.id
    branchA3 = a3.id
    branchB1 = b1.id
    branchB2 = b2.id

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null, extra: { isActive?: boolean; deleted?: boolean } = {}) => {
      const email = `it-aw-${label}-${suffix}@example.test`.toLowerCase()
      const [row] = await db.insert(users).values({
        email,
        username: `it-aw-${label}-${suffix}`.toLowerCase(),
        passwordHash: "x",
        roleId: roleIds[role],
        organizationId,
        branchId,
        fullName: `${label} ${suffix}`,
        isActive: extra.isActive ?? true,
        deletedAt: extra.deleted ? new Date() : null,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }
    await person("superAdmin", "SUPER_ADMIN", null, null)
    await person("headOffice", "HEAD_OFFICE", orgA, null)
    await person("branchAdmin", "BRANCH_ADMIN", orgA, branchA1)
    await person("orderDesk", "ORDER_DESK", null, null)
    await person("support", "APRICART_SUPPORT", null, null)
    await person("executive", "APRICART_EXECUTIVE", null, null)
    await person("wh1", "WAREHOUSE", null, null)
    await person("wh2", "WAREHOUSE", null, null)
    await person("whCity", "WAREHOUSE", null, null)
    await person("whLonely", "WAREHOUSE", null, null)
    await person("whInactive", "WAREHOUSE", null, null, { isActive: false })
    await person("whDeleted", "WAREHOUSE", null, null, { deleted: true })

    await db.insert(warehouseAssignments).values([
      { userId: actors.wh1.id, branchId: branchA1 },
      { userId: actors.wh1.id, branchId: branchA2 },
      { userId: actors.wh2.id, branchId: branchA1 },
      { userId: actors.whLonely.id, branchId: branchB1 },
      { userId: actors.whInactive.id, branchId: branchB2 },
    ])
    await db.insert(warehouseCityAssignments).values({ userId: actors.whCity.id, cityKey: city.toLowerCase() })
    await db.insert(warehouseCityOrganizations).values({ userId: actors.whCity.id, organizationId: orgA })
    await db.insert(apricartExecutiveAssignments).values({ userId: actors.executive.id, organizationId: orgB })
  })

  afterAll(async () => {
    if (!orgA) return
    const actorIds = Object.values(actors).map((actor) => actor.id)
    const warehouseIds = (await db.select({ id: apricartWarehouses.id }).from(apricartWarehouses)
      .where(inArray(apricartWarehouses.createdByUserId, [actors.superAdmin.id]))).map((row) => row.id)
    if (warehouseIds.length > 0) {
      await db.delete(branchFulfillmentRoutes).where(inArray(branchFulfillmentRoutes.warehouseId, warehouseIds))
      await db.delete(apricartWarehouseMemberships).where(inArray(apricartWarehouseMemberships.warehouseId, warehouseIds))
      await db.delete(apricartWarehouses).where(inArray(apricartWarehouses.id, warehouseIds))
    }
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, [orgA, orgB]), inArray(auditLogs.userId, actorIds)))
    await db.delete(warehouseAssignments).where(inArray(warehouseAssignments.userId, actorIds))
    await db.delete(warehouseCityAssignments).where(inArray(warehouseCityAssignments.userId, actorIds))
    await db.delete(warehouseCityOrganizations).where(inArray(warehouseCityOrganizations.userId, actorIds))
    await db.delete(apricartExecutiveAssignments).where(inArray(apricartExecutiveAssignments.userId, actorIds))
    await db.delete(branches).where(inArray(branches.organizationId, [orgA, orgB]))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(organizations).where(inArray(organizations.id, [orgA, orgB]))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("who may call", () => {
    it("refuses an unauthenticated caller on every handler", async () => {
      expect((await list(null)).status).toBe(401)
      expect((await create(null, { code: `NOPE-${suffix}`, name: "Nope" })).status).toBe(401)
      expect((await update(null, 1, { name: "Nope" })).status).toBe(401)
      expect((await member(null, 1, { userId: actors.wh1.id, assigned: true })).status).toBe(401)
      expect((await route(null, 1, { organizationId: orgA, branchIds: [] })).status).toBe(401)
    })

    it.each(["headOffice", "branchAdmin", "orderDesk", "support", "executive", "wh1"])("refuses %s and writes nothing", async (key) => {
      const warehouseId = await newWarehouse(`R${key.slice(0, 4).toUpperCase()}`)
      expect((await list(actors[key])).status).toBe(403)
      expect((await create(actors[key], { code: `X${key.slice(0, 3).toUpperCase()}-${suffix}`, name: "Escalation" })).status).toBe(403)
      expect((await update(actors[key], warehouseId, { name: "Escalation" })).status).toBe(403)
      expect((await member(actors[key], warehouseId, { userId: actors.wh1.id, assigned: true })).status).toBe(403)
      expect((await route(actors[key], warehouseId, { organizationId: orgA, branchIds: [branchA1] })).status).toBe(403)

      const [row] = await db.select({ name: apricartWarehouses.name }).from(apricartWarehouses).where(eq(apricartWarehouses.id, warehouseId))
      expect(row.name).not.toBe("Escalation")
      expect(await db.select().from(apricartWarehouseMemberships).where(eq(apricartWarehouseMemberships.warehouseId, warehouseId))).toHaveLength(0)
      expect(await routesOf(warehouseId)).toEqual([])
    })
  })

  describe("warehouses", () => {
    it("creates one with a normalised code, audited, and refuses the same code in any case", async () => {
      const created = await create(actors.superAdmin, { code: ` khi-${suffix.toLowerCase()} `, name: "Karachi Central", city: "Karachi" })
      expect(created.status).toBe(201)
      expect(created.body.item).toMatchObject({ code: `KHI-${suffix}`, name: "Karachi Central", city: "Karachi", status: "ACTIVE" })
      expect(await auditCount("CREATE_APRICART_WAREHOUSE", created.body.item.id)).toBe(1)

      expect((await create(actors.superAdmin, { code: `KHI-${suffix}`, name: "Again" })).status).toBe(409)
    })

    it("refuses a malformed body and any field it does not know", async () => {
      expect((await create(actors.superAdmin, { code: "K", name: "Karachi" })).status).toBe(400)
      expect((await create(actors.superAdmin, { code: `ST-${suffix}`, name: "Karachi", status: "INACTIVE" })).status).toBe(400)
      expect((await create(actors.superAdmin, { code: `ST-${suffix}`, name: "Karachi", createdByUserId: actors.headOffice.id })).status).toBe(400)
    })

    it("answers an unknown or malformed id as not found", async () => {
      expect((await update(actors.superAdmin, "abc", { name: "Name" })).status).toBe(404)
      expect((await update(actors.superAdmin, "99999999999", { name: "Name" })).status).toBe(404)
      expect((await update(actors.superAdmin, 2_147_483_000, { name: "Name" })).status).toBe(404)
      expect((await member(actors.superAdmin, 2_147_483_000, { userId: actors.wh1.id, assigned: true })).status).toBe(404)
      expect((await route(actors.superAdmin, 2_147_483_000, { organizationId: orgA, branchIds: [] })).status).toBe(404)
    })

    it("changes details with an audit of only what changed, and keeps the code", async () => {
      const warehouseId = await newWarehouse("EDT")
      const changed = await update(actors.superAdmin, warehouseId, { name: "Renamed", city: "" })
      expect(changed.status).toBe(200)
      expect(changed.body.item).toMatchObject({ code: `EDT-${suffix}`, name: "Renamed", city: null })
      expect(await auditCount("UPDATE_APRICART_WAREHOUSE", warehouseId)).toBe(1)
      expect((await update(actors.superAdmin, warehouseId, { code: "OTHER" })).status).toBe(400)
      // No change, no audit row.
      expect((await update(actors.superAdmin, warehouseId, { name: "Renamed" })).status).toBe(200)
      expect(await auditCount("UPDATE_APRICART_WAREHOUSE", warehouseId)).toBe(1)
    })

    it("refuses to deactivate a warehouse branches route to, and an inactive one takes no new branch", async () => {
      const warehouseId = await newWarehouse("DEA")
      expect((await route(actors.superAdmin, warehouseId, { organizationId: orgB, branchIds: [branchB2] })).status).toBe(200)
      expect((await update(actors.superAdmin, warehouseId, { status: "INACTIVE" })).status).toBe(409)

      expect((await route(actors.superAdmin, warehouseId, { organizationId: orgB, branchIds: [] })).status).toBe(200)
      expect((await update(actors.superAdmin, warehouseId, { status: "INACTIVE" })).status).toBe(200)
      expect((await route(actors.superAdmin, warehouseId, { organizationId: orgB, branchIds: [branchB2] })).status).toBe(409)
      expect(await routesOf(warehouseId)).toEqual([])
    })
  })

  describe("members", () => {
    it("takes the responsibility from the account's role, idempotently, audited once", async () => {
      const warehouseId = await newWarehouse("MEM")
      const operator = await member(actors.superAdmin, warehouseId, { userId: actors.wh1.id, assigned: true })
      expect(operator.status).toBe(200)
      expect(operator.body.item.responsibility).toBe("WAREHOUSE_OPERATOR")
      const executive = await member(actors.superAdmin, warehouseId, { userId: actors.executive.id, assigned: true })
      expect(executive.body.item.responsibility).toBe("EXECUTIVE")

      expect((await member(actors.superAdmin, warehouseId, { userId: actors.wh1.id, assigned: true })).status).toBe(200)
      expect(await auditCount("UPDATE_APRICART_WAREHOUSE_MEMBERS", warehouseId)).toBe(2)

      expect((await member(actors.superAdmin, warehouseId, { userId: actors.wh1.id, assigned: false })).status).toBe(200)
      const rows = await db.select({ userId: apricartWarehouseMemberships.userId, responsibility: apricartWarehouseMemberships.responsibility })
        .from(apricartWarehouseMemberships).where(eq(apricartWarehouseMemberships.warehouseId, warehouseId))
      expect(rows).toEqual([{ userId: actors.executive.id, responsibility: "EXECUTIVE" }])
    })

    it("cannot be used to probe or enrol any other account", async () => {
      const warehouseId = await newWarehouse("PRB")
      for (const key of ["headOffice", "superAdmin", "orderDesk", "support", "whDeleted"]) {
        expect((await member(actors.superAdmin, warehouseId, { userId: actors[key].id, assigned: true })).status, key).toBe(404)
      }
      expect((await member(actors.superAdmin, warehouseId, { userId: randomUUID(), assigned: true })).status).toBe(404)
      expect((await member(actors.superAdmin, warehouseId, { userId: actors.whInactive.id, assigned: true })).status).toBe(400)
      expect((await member(actors.superAdmin, warehouseId, { userId: actors.wh1.id, assigned: true, responsibility: "EXECUTIVE" })).status).toBe(400)
      expect(await db.select().from(apricartWarehouseMemberships).where(eq(apricartWarehouseMemberships.warehouseId, warehouseId))).toHaveLength(0)
    })
  })

  describe("branch routes", () => {
    it("replaces one organization's routes only, and moves a branch from another warehouse with the move audited", async () => {
      const first = await newWarehouse("RTA")
      const second = await newWarehouse("RTB")
      expect((await route(actors.superAdmin, first, { organizationId: orgA, branchIds: [branchA1, branchA2] })).status).toBe(200)
      expect((await route(actors.superAdmin, first, { organizationId: orgB, branchIds: [branchB1] })).status).toBe(200)

      const moved = await route(actors.superAdmin, second, { organizationId: orgA, branchIds: [branchA2] })
      expect(moved.status).toBe(200)
      expect(moved.body.item.moved).toEqual([{ branchId: branchA2, fromWarehouseId: first }])
      expect(await routesOf(first)).toEqual([branchA1, branchB1].sort((a, b) => a - b))
      expect(await routesOf(second)).toEqual([branchA2])

      // Emptying tenant A's routes leaves tenant B's.
      expect((await route(actors.superAdmin, first, { organizationId: orgA, branchIds: [] })).status).toBe(200)
      expect(await routesOf(first)).toEqual([branchB1])

      const [audit] = await db.select({ organizationId: auditLogs.organizationId }).from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE_BRANCH_FULFILLMENT_ROUTES"), eq(auditLogs.entityId, String(second))))
      expect(audit.organizationId).toBe(orgA)

      await route(actors.superAdmin, first, { organizationId: orgB, branchIds: [] })
      await route(actors.superAdmin, second, { organizationId: orgA, branchIds: [] })
    })

    it("refuses another organization's branch, an unknown organization and a string id", async () => {
      const warehouseId = await newWarehouse("RTX")
      expect((await route(actors.superAdmin, warehouseId, { organizationId: orgA, branchIds: [branchB1] })).status).toBe(400)
      expect((await route(actors.superAdmin, warehouseId, { organizationId: 2_147_483_000, branchIds: [] })).status).toBe(400)
      expect((await route(actors.superAdmin, warehouseId, { organizationId: String(orgA), branchIds: [] })).status).toBe(400)
      expect(await routesOf(warehouseId)).toEqual([])
    })
  })

  describe("coverage, and that configuring changes no one's access", () => {
    it("classifies each branch from today's live reach and never chooses among warehouses", async () => {
      const reachBefore = Object.fromEntries(await Promise.all(
        ["wh1", "wh2", "whCity", "whLonely", "whInactive"].map(async (key) => [key, await loadWarehouseReach(db, actors[key].id)] as const),
      ))
      const executiveBefore = await loadExecutiveApprovalReach(db, actors.executive.id)

      const north = await newWarehouse("CVN")
      const south = await newWarehouse("CVS")
      await member(actors.superAdmin, north, { userId: actors.wh1.id, assigned: true })
      await member(actors.superAdmin, south, { userId: actors.wh2.id, assigned: true })
      await member(actors.superAdmin, south, { userId: actors.whCity.id, assigned: true })
      await member(actors.superAdmin, north, { userId: actors.executive.id, assigned: true })
      // A3 is served by whCity (south) but routed north: the owner would change.
      await route(actors.superAdmin, north, { organizationId: orgA, branchIds: [branchA3] })

      const { status, body } = await list(actors.superAdmin)
      expect(status).toBe(200)
      const coverage = new Map<number, any>(body.coverage.branches.map((entry: any) => [entry.branchId, entry]))
      expect(coverage.get(branchA1)).toMatchObject({ kind: "AMBIGUOUS", candidateWarehouseIds: [north, south] })
      expect(coverage.get(branchA2)).toMatchObject({ kind: "SUGGESTED", suggestedWarehouseId: north })
      expect(coverage.get(branchA3)).toMatchObject({ kind: "ROUTED", routeWarehouseId: north, routeMatchesReach: false })
      expect(coverage.get(branchB1)).toMatchObject({ kind: "UNMAPPED", servingAccountIds: [actors.whLonely.id] })
      // whInactive's assignment serves nothing today.
      expect(coverage.get(branchB2)).toMatchObject({ kind: "UNSERVED", servingAccountIds: [] })

      // The executive member approves for tenant B only, and north is routed into tenant A.
      const northRow = body.warehouses.find((warehouse: any) => warehouse.id === north)
      expect(northRow.executiveGapOrganizationIds).toEqual([orgA])
      expect(northRow.routedBranchCount).toBe(1)
      expect(body.accounts.some((account: any) => account.id === actors.whDeleted.id)).toBe(false)
      expect(body.accounts.find((account: any) => account.id === actors.executive.id).responsibility).toBe("EXECUTIVE")

      for (const [key, reach] of Object.entries(reachBefore)) {
        expect(await loadWarehouseReach(db, actors[key].id), key).toEqual(reach)
      }
      expect(await loadExecutiveApprovalReach(db, actors.executive.id)).toEqual(executiveBefore)

      await route(actors.superAdmin, north, { organizationId: orgA, branchIds: [] })
    })
  })
})
