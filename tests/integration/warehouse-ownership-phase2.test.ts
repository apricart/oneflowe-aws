import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, or } from "drizzle-orm"

import * as collectionRoute from "@/app/api/v1/apricart-warehouses/route"
import * as warehouseRoute from "@/app/api/v1/apricart-warehouses/[id]/route"
import * as membersRoute from "@/app/api/v1/apricart-warehouses/[id]/members/route"
import * as branchesRoute from "@/app/api/v1/apricart-warehouses/[id]/branches/route"
import * as rulesRoute from "@/app/api/v1/apricart-warehouses/[id]/rules/route"
import * as scopeRoute from "@/app/api/v1/apricart-warehouses/[id]/member-scope/route"
import * as checkRoute from "@/app/api/v1/apricart-warehouses/ownership-check/route"
import {
  apricartWarehouseMemberBranches,
  apricartWarehouseMemberships,
  apricartWarehouses,
  auditLogs,
  branches,
  branchFulfillmentRoutes,
  orders,
  organizations,
  roles,
  users,
  warehouseAssignments,
  warehouseCityAssignments,
  warehouseCityOrganizations,
  warehouseRouteRules,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { setApricartWarehouseMember, setWarehouseMemberScope, setWarehouseRouteRule } from "@/lib/server/apricart-warehouses"
import { loadBranchWarehouses } from "@/lib/server/branch-warehouse"
import { runWarehouseOwnershipCheck } from "@/lib/server/warehouse-ownership-check"
import { loadBranchWarehouseRecipients } from "@/lib/server/warehouse-order-notifications"
import { loadWarehouseReach } from "@/lib/server/warehouse-scope"
import { WAREHOUSE_ORDER_OWNERSHIP_MODES, type WarehouseOrderOwnershipMode } from "@/lib/warehouse-ownership-policy"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Phase 2 of plans/OF-WAREHOUSE-order-ownership-and-transfer.md, against Postgres.
 *
 * ```text
 * Org A   AK1 "Karachi " , AK2 "karachi"  ← whK (city Karachi × A, B)     AL1 "Lahore" ← whL (city Lahore × A)
 *         ANC (no city yet)
 * Org B   BK1 "KARACHI"                    ← whK                            BL1 "Lahore" ← whS (by branch)
 *         BX1 "Quetta"                     ← whX (by branch, in no warehouse — the fallback case)
 * Org C   CK1 "Karachi"                    — nobody
 * ```
 *
 * The acceptance test (decision 5): mapped onto warehouses — whK to WK, whL to
 * WL, whS to WS — every account sees exactly the branches it sees today, in
 * both membership modes, including a branch given its city after the rules
 * exist, which is why rules are evaluated live.
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
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b)

describe.skipIf(!hasTestDatabase)("Warehouses own branches (phase 2)", () => {
  const suffix = randomUUID().slice(0, 8).toUpperCase()
  const karachi = `Karachi ${suffix}`
  const lahore = `Lahore ${suffix}`
  const actors: Record<string, Actor> = {}
  const branch: Record<string, number> = {}
  let orgA: number
  let orgB: number
  let orgC: number
  let wK: number
  let wL: number
  let wS: number
  let wEmpty: number
  let openOrderC: number

  const as = (key: string | null) => signIn(key === null ? null : actors[key])
  const rule = async (key: string | null, warehouseId: number | string, body: unknown) => {
    as(key)
    return read(await rulesRoute.PUT(request(`${BASE}/${warehouseId}/rules`, "PUT", body), params(warehouseId)))
  }
  const scope = async (key: string | null, warehouseId: number | string, body: unknown) => {
    as(key)
    return read(await scopeRoute.PUT(request(`${BASE}/${warehouseId}/member-scope`, "PUT", body), params(warehouseId)))
  }
  const member = async (warehouseId: number, userKey: string, assigned: boolean) => {
    as("superAdmin")
    return read(await membersRoute.PUT(request(`${BASE}/${warehouseId}/members`, "PUT", { userId: actors[userKey].id, assigned }), params(warehouseId)))
  }
  const reach = (key: string, mode: WarehouseOrderOwnershipMode) => loadWarehouseReach(db, actors[key].id, { mode })
  /** Our accounts only: the shared test database may hold other suites' warehouse accounts. */
  const ourDifferences = async () => {
    const ours = new Set(["whK", "whL", "whS", "whX"].map((key) => actors[key].id))
    const check = await runWarehouseOwnershipCheck(db)
    return {
      fallback: check.differences["membership-fallback"].filter((entry) => ours.has(entry.accountId)),
      membership: check.differences.membership.filter((entry) => ours.has(entry.accountId)),
      check,
    }
  }

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all(
      ["SUPER_ADMIN", "HEAD_OFFICE", "APRICART_EXECUTIVE", "WAREHOUSE"].map(async (name) => [name, await resolveRoleId(name)] as const),
    ))
    const org = async (label: string) => (await db.insert(organizations)
      .values({ name: `IT WO ${label} ${suffix}`, code: `ITWO${label}_${suffix}` })
      .returning({ id: organizations.id }))[0].id
    orgA = await org("A")
    orgB = await org("B")
    orgC = await org("C")

    const place = async (key: string, organizationId: number, city: string | null) => {
      const [row] = await db.insert(branches)
        .values({ organizationId, name: `IT WO ${key} ${suffix}`, city, status: "active" })
        .returning({ id: branches.id })
      branch[key] = row.id
    }
    await place("AK1", orgA, `${karachi} `)
    await place("AK2", orgA, karachi.toLowerCase())
    await place("AL1", orgA, lahore)
    await place("ANC", orgA, null)
    await place("BK1", orgB, karachi.toUpperCase())
    await place("BL1", orgB, lahore)
    await place("BX1", orgB, `Quetta ${suffix}`)
    await place("CK1", orgC, karachi)

    const person = async (key: string, role: string, organizationId: number | null = null) => {
      const email = `it-wo-${key}-${suffix}@example.test`.toLowerCase()
      const [row] = await db.insert(users).values({
        email, username: `it-wo-${key}-${suffix}`.toLowerCase(), passwordHash: "x", roleId: roleIds[role],
        organizationId, branchId: null, fullName: `${key} ${suffix}`, isActive: true,
      }).returning({ id: users.id })
      actors[key] = { id: row.id, email, role, organizationId, branchId: null }
    }
    await person("superAdmin", "SUPER_ADMIN")
    await person("headOffice", "HEAD_OFFICE", orgA)
    await person("executive", "APRICART_EXECUTIVE")
    await person("whK", "WAREHOUSE")
    await person("whL", "WAREHOUSE")
    await person("whS", "WAREHOUSE")
    await person("whX", "WAREHOUSE")

    // Today's model: each account's own assignments.
    await db.insert(warehouseCityAssignments).values([
      { userId: actors.whK.id, cityKey: karachi.toLowerCase() },
      { userId: actors.whL.id, cityKey: lahore.toLowerCase() },
    ])
    await db.insert(warehouseCityOrganizations).values([
      { userId: actors.whK.id, organizationId: orgA },
      { userId: actors.whK.id, organizationId: orgB },
      { userId: actors.whL.id, organizationId: orgA },
    ])
    await db.insert(warehouseAssignments).values([
      { userId: actors.whS.id, branchId: branch.BL1 },
      { userId: actors.whX.id, branchId: branch.BX1 },
    ])

    const warehouse = async (code: string) => (await db.insert(apricartWarehouses)
      .values({ code: `${code}-${suffix}`, name: `IT WO ${code}`, createdByUserId: actors.superAdmin.id })
      .returning({ id: apricartWarehouses.id }))[0].id
    wK = await warehouse("WK")
    wL = await warehouse("WL")
    wS = await warehouse("WS")
    wEmpty = await warehouse("WE")

    const [order] = await db.insert(orders).values({
      tid: `WO${suffix}C`.slice(0, 26),
      organizationId: orgC,
      branchId: branch.CK1,
      createdByUserId: actors.headOffice.id,
      createdByRole: "ORDER_PORTAL",
      status: "PENDING",
      subtotalCents: 1_000,
      taxCents: 0,
      totalCents: 1_000,
      budgetTracked: false,
    }).returning({ id: orders.id })
    openOrderC = order.id
  })

  afterAll(async () => {
    if (!orgA) return
    const actorIds = Object.values(actors).map((actor) => actor.id)
    const warehouseIds = [wK, wL, wS, wEmpty].filter((id) => id !== undefined)
    await db.delete(orders).where(inArray(orders.organizationId, [orgA, orgB, orgC]))
    if (warehouseIds.length > 0) {
      await db.delete(warehouseRouteRules).where(inArray(warehouseRouteRules.warehouseId, warehouseIds))
      await db.delete(branchFulfillmentRoutes).where(inArray(branchFulfillmentRoutes.warehouseId, warehouseIds))
      await db.delete(apricartWarehouseMemberships).where(inArray(apricartWarehouseMemberships.warehouseId, warehouseIds))
      await db.delete(apricartWarehouses).where(inArray(apricartWarehouses.id, warehouseIds))
    }
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, [orgA, orgB, orgC]), inArray(auditLogs.userId, actorIds)))
    await db.delete(warehouseAssignments).where(inArray(warehouseAssignments.userId, actorIds))
    await db.delete(warehouseCityAssignments).where(inArray(warehouseCityAssignments.userId, actorIds))
    await db.delete(warehouseCityOrganizations).where(inArray(warehouseCityOrganizations.userId, actorIds))
    await db.delete(branches).where(inArray(branches.organizationId, [orgA, orgB, orgC]))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(organizations).where(inArray(organizations.id, [orgA, orgB, orgC]))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("who may call", () => {
    it("refuses an unauthenticated caller", async () => {
      expect((await rule(null, wK, { organizationId: orgA, city: karachi, assigned: true })).status).toBe(401)
      expect((await scope(null, wK, { userId: actors.whK.id, scope: "ALL" })).status).toBe(401)
      signIn(null)
      expect((await read(await checkRoute.GET())).status).toBe(401)
    })

    it.each(["headOffice", "executive", "whK"])("refuses %s and writes nothing", async (key) => {
      expect((await rule(key, wK, { organizationId: orgA, city: karachi, assigned: true })).status).toBe(403)
      expect((await scope(key, wK, { userId: actors.whK.id, scope: "ALL" })).status).toBe(403)
      as(key)
      expect((await read(await checkRoute.GET())).status).toBe(403)
      expect(await db.select().from(warehouseRouteRules).where(eq(warehouseRouteRules.warehouseId, wK))).toHaveLength(0)
    })

    it("answers an unknown warehouse 404 and a malformed body or unknown organization 400", async () => {
      expect((await rule("superAdmin", 2_000_000_000, { organizationId: orgA, city: karachi, assigned: true })).status).toBe(404)
      expect((await rule("superAdmin", "abc", { organizationId: orgA, city: karachi, assigned: true })).status).toBe(404)
      expect((await rule("superAdmin", wK, { organizationId: orgA, city: karachi, assigned: true, warehouseId: wL })).status).toBe(400)
      expect((await rule("superAdmin", wK, { organizationId: 2_000_000_000, city: karachi, assigned: true })).status).toBe(400)
      expect((await scope("superAdmin", wK, { userId: actors.whL.id, scope: "ALL" })).status).toBe(404)
    })
  })

  describe("in the 'branch' mode production runs", () => {
    it("changes nothing anyone sees, whatever the warehouses are configured to", async () => {
      const before = await Promise.all(["whK", "whL", "whS", "whX"].map((key) => reach(key, "branch")))
      expect(sorted(before[0])).toEqual(sorted([branch.AK1, branch.AK2, branch.BK1]))
      expect(before[1]).toEqual([branch.AL1])
      expect(before[2]).toEqual([branch.BL1])
      expect(before[3]).toEqual([branch.BX1])

      // A rule and a membership that would, in a membership mode, change whK's work.
      expect((await rule("superAdmin", wEmpty, { organizationId: orgC, city: karachi, assigned: true })).status).toBe(200)
      expect((await member(wEmpty, "whK", true)).status).toBe(200)
      // The default mode — the shipped constant — still reads the assignments alone.
      expect(sorted(await loadWarehouseReach(db, actors.whK.id))).toEqual(sorted(before[0]))
      expect((await loadBranchWarehouseRecipients(db, branch.CK1)).map((row) => row.id)).toEqual([])

      expect((await member(wEmpty, "whK", false)).status).toBe(200)
      expect((await rule("superAdmin", wEmpty, { organizationId: orgC, city: karachi, assigned: false })).status).toBe(200)
    })
  })

  describe("moving today's accounts onto warehouses", () => {
    it("reproduces every account's branches exactly, in both membership modes", async () => {
      for (const [warehouseId, organizationId, city] of [[wK, orgA, karachi], [wK, orgB, karachi], [wL, orgA, lahore]] as const) {
        const response = await rule("superAdmin", warehouseId, { organizationId, city, assigned: true })
        expect(response.status).toBe(200)
        expect(response.body.item).toMatchObject({ warehouseId, organizationId, cityKey: city.toLowerCase(), changed: true })
      }
      as("superAdmin")
      expect((await read(await branchesRoute.PUT(request(`${BASE}/${wS}/branches`, "PUT", { organizationId: orgB, branchIds: [branch.BL1] }), params(wS)))).status).toBe(200)
      for (const [warehouseId, key] of [[wK, "whK"], [wL, "whL"], [wS, "whS"]] as const) {
        expect((await member(warehouseId, key, true)).status).toBe(200)
      }

      for (const mode of WAREHOUSE_ORDER_OWNERSHIP_MODES) {
        expect(sorted(await reach("whK", mode)), mode).toEqual(sorted([branch.AK1, branch.AK2, branch.BK1]))
        expect(await reach("whL", mode), mode).toEqual([branch.AL1])
        expect(await reach("whS", mode), mode).toEqual([branch.BL1])
      }
      // whX's branch is in no warehouse: kept in the fallback mode, gone in "membership".
      expect(await reach("whX", "membership-fallback")).toEqual([branch.BX1])
      expect(await reach("whX", "membership")).toEqual([])

      const { fallback, membership } = await ourDifferences()
      expect(fallback).toEqual([])
      expect(membership).toEqual([{ accountId: actors.whX.id, lost: [branch.BX1], gained: [] }])
    })

    it("puts a branch given its city later into its warehouse at once — the reason rules are live", async () => {
      // A branch created with no city, as the K-Electric sync creates them.
      expect((await loadBranchWarehouses(db, [branch.ANC])).get(branch.ANC)).toBeNull()
      expect(await reach("whK", "membership")).not.toContain(branch.ANC)

      await db.update(branches).set({ city: karachi }).where(eq(branches.id, branch.ANC))
      expect((await loadBranchWarehouses(db, [branch.ANC])).get(branch.ANC)).toBe(wK)
      for (const mode of WAREHOUSE_ORDER_OWNERSHIP_MODES) expect(await reach("whK", mode), mode).toContain(branch.ANC)
      expect((await ourDifferences()).fallback).toEqual([])

      await db.update(branches).set({ city: null }).where(eq(branches.id, branch.ANC))
    })

    it("lets a branch put in another warehouse by hand override its rule — and the check says who would change", async () => {
      as("superAdmin")
      expect((await read(await branchesRoute.PUT(request(`${BASE}/${wL}/branches`, "PUT", { organizationId: orgA, branchIds: [branch.AK2] }), params(wL)))).status).toBe(200)
      expect((await loadBranchWarehouses(db, [branch.AK2])).get(branch.AK2)).toBe(wL)
      const { fallback } = await ourDifferences()
      expect(fallback).toEqual(expect.arrayContaining([
        { accountId: actors.whK.id, lost: [branch.AK2], gained: [] },
        { accountId: actors.whL.id, lost: [], gained: [branch.AK2] },
      ]))
      as("superAdmin")
      expect((await read(await branchesRoute.PUT(request(`${BASE}/${wL}/branches`, "PUT", { organizationId: orgA, branchIds: [] }), params(wL)))).status).toBe(200)
      expect((await ourDifferences()).fallback).toEqual([])
    })

    it("tells the same people in each mode", async () => {
      for (const mode of WAREHOUSE_ORDER_OWNERSHIP_MODES) {
        expect((await loadBranchWarehouseRecipients(db, branch.AK1, mode)).map((row) => row.id), mode).toEqual([actors.whK.id])
      }
      expect((await loadBranchWarehouseRecipients(db, branch.BX1, "membership-fallback")).map((row) => row.id)).toEqual([actors.whX.id])
      // Nobody, never everybody, for a branch nobody works.
      expect(await loadBranchWarehouseRecipients(db, branch.CK1, "membership")).toEqual([])
      expect(await loadBranchWarehouseRecipients(db, branch.BX1, "membership")).toEqual([])
    })

    it("lists the open order whose branch is in no warehouse", async () => {
      as("superAdmin")
      const configuration = await read(await collectionRoute.GET())
      expect(configuration.status).toBe(200)
      expect(configuration.body.unrouted.orders.map((order: { id: number }) => order.id)).toContain(openOrderC)
      expect(configuration.body.ownershipMode).toBe("branch")
      const warehouse = configuration.body.warehouses.find((entry: { id: number }) => entry.id === wK)
      expect(warehouse).toMatchObject({ ruleCount: 2, branchCount: 3 })
      expect(configuration.body.rules.filter((entry: { warehouseId: number }) => entry.warehouseId === wK)).toHaveLength(2)

      as("superAdmin")
      const check = await read(await checkRoute.GET())
      expect(check.status).toBe(200)
      expect(check.body.unroutedOpenOrders).toBeGreaterThanOrEqual(1)
    })
  })

  describe("rules", () => {
    it("move from one warehouse to another, audited with where from; removing only removes this warehouse's own", async () => {
      const moved = await rule("superAdmin", wL, { organizationId: orgB, city: karachi, assigned: true })
      expect(moved.status).toBe(200)
      expect(moved.body.item.movedFromWarehouseId).toBe(wK)
      expect((await loadBranchWarehouses(db, [branch.BK1])).get(branch.BK1)).toBe(wL)
      const [audit] = await db.select({ metadata: auditLogs.metadata }).from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE_WAREHOUSE_ROUTE_RULES"), eq(auditLogs.entityId, String(wL)), eq(auditLogs.organizationId, orgB)))
      expect(JSON.stringify(audit.metadata)).toContain(`"movedFromWarehouseId":${wK}`)

      // wK no longer holds it, so wK removing it changes nothing.
      const noop = await rule("superAdmin", wK, { organizationId: orgB, city: karachi, assigned: false })
      expect(noop.body.item.changed).toBe(false)
      expect((await loadBranchWarehouses(db, [branch.BK1])).get(branch.BK1)).toBe(wL)

      expect((await rule("superAdmin", wK, { organizationId: orgB, city: karachi.toUpperCase(), assigned: true })).body.item.movedFromWarehouseId).toBe(wL)
    })

    it("are idempotent and match any spelling of the city", async () => {
      const again = await rule("superAdmin", wK, { organizationId: orgA, city: `  ${karachi.toUpperCase()} `, assigned: true })
      expect(again.status).toBe(200)
      expect(again.body.item.changed).toBe(false)
    })

    it("keep an inactive warehouse from taking branches, and a warehouse with rules from going inactive", async () => {
      as("superAdmin")
      expect((await read(await warehouseRoute.PATCH(request(`${BASE}/${wK}`, "PATCH", { status: "INACTIVE" }), params(wK)))).status).toBe(409)
      as("superAdmin")
      expect((await read(await warehouseRoute.PATCH(request(`${BASE}/${wEmpty}`, "PATCH", { status: "INACTIVE" }), params(wEmpty)))).status).toBe(200)
      expect((await rule("superAdmin", wEmpty, { organizationId: orgC, city: null, assigned: true })).status).toBe(409)
      as("superAdmin")
      await warehouseRoute.PATCH(request(`${BASE}/${wEmpty}`, "PATCH", { status: "ACTIVE" }), params(wEmpty))
    })
  })

  describe("an operator's scope", () => {
    it("narrows the operator to selected branches of the warehouse, and back to all", async () => {
      const narrowed = await scope("superAdmin", wK, { userId: actors.whK.id, scope: "SELECTED", organizationId: orgA, branchIds: [branch.AK1] })
      expect(narrowed.status).toBe(200)
      expect(narrowed.body.item).toMatchObject({ branchScope: "SELECTED", selectedBranchIds: [branch.AK1] })
      expect(await reach("whK", "membership")).toEqual([branch.AK1])
      // Its own assignments still decide today.
      expect(sorted(await reach("whK", "branch"))).toEqual(sorted([branch.AK1, branch.AK2, branch.BK1]))

      const widened = await scope("superAdmin", wK, { userId: actors.whK.id, scope: "ALL" })
      expect(widened.body.item).toMatchObject({ branchScope: "ALL", selectedBranchIds: [] })
      expect(await db.select().from(apricartWarehouseMemberBranches)).not.toContainEqual(expect.objectContaining({ branchId: branch.AK1 }))
      expect(sorted(await reach("whK", "membership"))).toEqual(sorted([branch.AK1, branch.AK2, branch.BK1]))
    })

    it("refuses a branch that is not in the warehouse, and an executive", async () => {
      expect((await scope("superAdmin", wK, { userId: actors.whK.id, scope: "SELECTED", organizationId: orgA, branchIds: [branch.AL1] })).status).toBe(400)
      expect((await scope("superAdmin", wK, { userId: actors.whK.id, scope: "SELECTED", organizationId: orgB, branchIds: [branch.AK1] })).status).toBe(400)
      expect((await member(wK, "executive", true)).status).toBe(200)
      expect((await scope("superAdmin", wK, { userId: actors.executive.id, scope: "SELECTED", organizationId: orgA, branchIds: [branch.AK1] })).status).toBe(400)
      expect((await member(wK, "executive", false)).status).toBe(200)
    })
  })

  describe("the strand guard, once membership decides", () => {
    const actor = () => ({ id: actors.superAdmin.id, role: "SUPER_ADMIN", email: actors.superAdmin.email })

    it("refuses to remove the only operator of a warehouse with branches, or narrow it to nothing", async () => {
      expect(await setApricartWarehouseMember({ warehouseId: wL, userId: actors.whL.id, assigned: false, actor: actor(), mode: "membership" }))
        .toMatchObject({ kind: "conflict" })
      expect(await setWarehouseMemberScope({ warehouseId: wL, userId: actors.whL.id, scope: "SELECTED", organizationId: orgA, branchIds: [], actor: actor(), mode: "membership" }))
        .toMatchObject({ kind: "conflict" })
      // Nothing was written.
      const [membership] = await db.select({ branchScope: apricartWarehouseMemberships.branchScope }).from(apricartWarehouseMemberships)
        .where(and(eq(apricartWarehouseMemberships.warehouseId, wL), eq(apricartWarehouseMemberships.userId, actors.whL.id)))
      expect(membership.branchScope).toBe("ALL")
    })

    it("refuses a rule that puts branches in a warehouse nobody works", async () => {
      expect(await setWarehouseRouteRule({ warehouseId: wEmpty, organizationId: orgC, city: karachi, assigned: true, actor: actor(), mode: "membership" }))
        .toMatchObject({ kind: "conflict" })
      expect(await db.select().from(warehouseRouteRules).where(eq(warehouseRouteRules.warehouseId, wEmpty))).toHaveLength(0)
    })

    it("checks nothing in the 'branch' mode, where membership decides nothing", async () => {
      const outcome = await setWarehouseRouteRule({ warehouseId: wEmpty, organizationId: orgC, city: karachi, assigned: true, actor: actor(), mode: "branch" })
      expect(outcome).toMatchObject({ kind: "updated", changed: true })
      await setWarehouseRouteRule({ warehouseId: wEmpty, organizationId: orgC, city: karachi, assigned: false, actor: actor(), mode: "branch" })
    })
  })
})
