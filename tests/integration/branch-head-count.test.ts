import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as decideRoute from "@/app/api/v1/branch-head-count-requests/[id]/route"
import * as requestsRoute from "@/app/api/v1/branch-head-count-requests/route"
import * as branchRoute from "@/app/api/v1/branches/[id]/route"
import * as branchesRoute from "@/app/api/v1/branches/route"
import {
  auditLogs,
  branchHeadCountRequests,
  branches,
  organizations,
  roles,
  systemLogs,
  userBranchAssignments,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Branch head count (plans/OF-BRANCH-head-count.md), end to end over the real
 * routes and a real database.
 *
 * ```text
 * home tenant                                   foreign tenant
 *   Head Office          <- decides, sets         Head Office (foreign)
 *   Branch Admin         <- North only
 *   Group User           <- North by assignment
 *   Order Portal         <- North, may not request
 *   Super Admin          <- no tenant; sets directly, never decides
 *   North, South                                  Abroad
 * ```
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limiter")>()
  return { ...actual, withRateLimit: vi.fn(async () => null) }
})
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

type Fixtures = Awaited<ReturnType<typeof createFixtures>>
type ActorKind = "super" | "head" | "foreignHead" | "branchAdmin" | "groupUser" | "orderPortal"

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "head count it" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const [home, foreign] = await db.insert(organizations).values([
    { name: `IT HeadCount Home ${suffix}`, code: `ITHH${suffix}` },
    { name: `IT HeadCount Foreign ${suffix}`, code: `ITHF${suffix}` },
  ]).returning({ id: organizations.id })

  const [north, south, abroad] = await db.insert(branches).values([
    { organizationId: home.id, name: `North ${suffix}`, status: "active", headCount: 10 },
    { organizationId: home.id, name: `South ${suffix}`, status: "active" },
    { organizationId: foreign.id, name: `Abroad ${suffix}`, status: "active", headCount: 5 },
  ]).returning({ id: branches.id })

  const person = async (label: string, role: string, organizationId: number | null, branchId: number | null = null) => {
    const [row] = await db.insert(users).values({
      email: `it-headcount-${label}-${suffix}@example.test`,
      username: `it-headcount-${label}-${suffix}`,
      passwordHash: "x",
      roleId: await roleId(role),
      organizationId,
      branchId,
      firstName: label,
      lastName: suffix,
    }).returning({ id: users.id })
    return row.id
  }

  const ids = {
    super: await person("super", "SUPER_ADMIN", null),
    head: await person("head", "HEAD_OFFICE", home.id),
    foreignHead: await person("foreign-head", "HEAD_OFFICE", foreign.id),
    branchAdmin: await person("ba", "BRANCH_ADMIN", home.id, north.id),
    groupUser: await person("gu", "GROUP_USER", home.id),
    orderPortal: await person("op", "ORDER_PORTAL", home.id, north.id),
  }
  await db.insert(userBranchAssignments).values({
    userId: ids.groupUser,
    branchId: north.id,
    organizationId: home.id,
  })

  return {
    suffix,
    home: home.id,
    foreign: foreign.id,
    north: north.id,
    south: south.id,
    abroad: abroad.id,
    ids,
    roles: {
      super: "SUPER_ADMIN",
      head: "HEAD_OFFICE",
      foreignHead: "HEAD_OFFICE",
      branchAdmin: "BRANCH_ADMIN",
      groupUser: "GROUP_USER",
      orderPortal: "ORDER_PORTAL",
    } as Record<ActorKind, string>,
  }
}

async function destroyFixtures(fixtures: Fixtures): Promise<void> {
  const organizationIds = [fixtures.home, fixtures.foreign]
  const userIds = Object.values(fixtures.ids)
  await db.delete(systemLogs).where(inArray(systemLogs.organizationId, organizationIds))
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, organizationIds))
  await db.delete(branchHeadCountRequests).where(inArray(branchHeadCountRequests.organizationId, organizationIds))
  await db.delete(userBranchAssignments).where(inArray(userBranchAssignments.userId, userIds))
  await db.delete(users).where(inArray(users.id, userIds))
  await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
  await db.delete(organizations).where(inArray(organizations.id, organizationIds))
}

function jsonRequest(path: string, method: string, payload?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
}

describe.skipIf(!hasTestDatabase)("branch head count, end to end", () => {
  let fixtures: Fixtures

  function signIn(kind: ActorKind | null) {
    vi.mocked(getServerSession).mockResolvedValue(kind === null ? null : ({
      user: {
        id: fixtures.ids[kind],
        email: `it-headcount-${kind}-${fixtures.suffix}@example.test`,
        role: fixtures.roles[kind],
        mustChangePassword: false,
      },
    } as any))
  }

  async function raise(kind: ActorKind | null, payload: unknown) {
    signIn(kind)
    const response = await requestsRoute.POST(jsonRequest("/api/v1/branch-head-count-requests", "POST", payload))
    return { status: response.status, body: await response.json() }
  }

  async function decideAs(kind: ActorKind | null, id: number | string, payload: unknown) {
    signIn(kind)
    const response = await decideRoute.PATCH(
      jsonRequest(`/api/v1/branch-head-count-requests/${id}`, "PATCH", payload),
      { params: Promise.resolve({ id: String(id) }) },
    )
    return { status: response.status, body: await response.json() }
  }

  async function listAs(kind: ActorKind | null, query = "") {
    signIn(kind)
    const response = await requestsRoute.GET(
      new NextRequest(`http://localhost/api/v1/branch-head-count-requests${query}`),
    )
    return { status: response.status, body: await response.json() }
  }

  async function patchBranchAs(kind: ActorKind, branchId: number, payload: unknown) {
    signIn(kind)
    const response = await branchRoute.PATCH(
      new Request(`http://localhost/api/v1/branches/${branchId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ id: String(branchId) }) },
    )
    return { status: response.status, body: await response.json() }
  }

  async function headCountOf(branchId: number): Promise<number | null> {
    const [row] = await db.select({ headCount: branches.headCount }).from(branches).where(eq(branches.id, branchId))
    return row.headCount
  }

  beforeAll(async () => {
    fixtures = await createFixtures()
  })

  afterAll(async () => {
    if (fixtures) await destroyFixtures(fixtures)
    await closePool()
  })

  beforeEach(async () => {
    await db.delete(branchHeadCountRequests)
      .where(inArray(branchHeadCountRequests.organizationId, [fixtures.home, fixtures.foreign]))
    await db.update(branches).set({ headCount: 10 }).where(eq(branches.id, fixtures.north))
    await db.update(branches).set({ headCount: null }).where(eq(branches.id, fixtures.south))
  })

  describe("the lifecycle", () => {
    it("is raised pending and does not touch the branch", async () => {
      const created = await raise("branchAdmin", { branchId: fixtures.north, headCount: 25, reason: "New shift" })

      expect(created.status).toBe(201)
      expect(created.body.request).toMatchObject({
        status: "pending",
        requestedHeadCount: 25,
        currentHeadCount: 10,
      })
      expect(await headCountOf(fixtures.north)).toBe(10)

      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "REQUEST_BRANCH_HEAD_COUNT"),
        eq(auditLogs.entityId, String(created.body.request.id)),
      ))
      expect(audit?.organizationId).toBe(fixtures.home)
      expect(audit?.userId).toBe(fixtures.ids.branchAdmin)
    })

    it("reaches the branch only when Head Office approves it", async () => {
      const created = await raise("groupUser", { branchId: fixtures.north, headCount: 40 })
      expect(created.status).toBe(201)

      const decided = await decideAs("head", created.body.request.id, { decision: "approve", reason: "Confirmed" })
      expect(decided.status).toBe(200)
      expect(decided.body).toMatchObject({ status: "approved", headCount: 40, branchId: fixtures.north })
      expect(await headCountOf(fixtures.north)).toBe(40)

      const [stored] = await db.select().from(branchHeadCountRequests)
        .where(eq(branchHeadCountRequests.id, created.body.request.id))
      expect(stored).toMatchObject({
        status: "approved",
        appliedPreviousHeadCount: 10,
        decidedByUserId: fixtures.ids.head,
        decisionReason: "Confirmed",
      })

      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "APPROVE_BRANCH_HEAD_COUNT"),
        eq(auditLogs.entityId, String(created.body.request.id)),
      ))
      expect(audit?.userId).toBe(fixtures.ids.head)
    })

    it("leaves the branch alone when rejected", async () => {
      const created = await raise("branchAdmin", { branchId: fixtures.north, headCount: 99 })
      const decided = await decideAs("head", created.body.request.id, { decision: "reject" })

      expect(decided.status).toBe(200)
      expect(decided.body.status).toBe("rejected")
      expect(await headCountOf(fixtures.north)).toBe(10)
    })

    it("records what an approval actually overwrote when the figure moved in between", async () => {
      const created = await raise("branchAdmin", { branchId: fixtures.north, headCount: 30 })
      expect((await patchBranchAs("head", fixtures.north, { headCount: 12 })).status).toBe(200)

      await decideAs("head", created.body.request.id, { decision: "approve" })
      const [stored] = await db.select().from(branchHeadCountRequests)
        .where(eq(branchHeadCountRequests.id, created.body.request.id))
      expect(stored.currentHeadCount).toBe(10)
      expect(stored.appliedPreviousHeadCount).toBe(12)
      expect(await headCountOf(fixtures.north)).toBe(30)
    })
  })

  describe("who may raise one", () => {
    it("refuses an unauthenticated caller", async () => {
      expect((await raise(null, { branchId: fixtures.north, headCount: 3 })).status).toBe(401)
    })

    it.each(["head", "super", "orderPortal"] as const)("refuses %s", async (kind) => {
      expect((await raise(kind, { branchId: fixtures.north, headCount: 3 })).status).toBe(403)
    })

    it("refuses a branch in the requester's own tenant that is not theirs", async () => {
      expect((await raise("branchAdmin", { branchId: fixtures.south, headCount: 3 })).status).toBe(403)
      expect((await raise("groupUser", { branchId: fixtures.south, headCount: 3 })).status).toBe(403)
    })

    it("refuses another tenant's branch", async () => {
      expect((await raise("branchAdmin", { branchId: fixtures.abroad, headCount: 3 })).status).toBe(403)
    })

    it("refuses a second request while one is waiting", async () => {
      expect((await raise("branchAdmin", { branchId: fixtures.north, headCount: 3 })).status).toBe(201)
      const second = await raise("groupUser", { branchId: fixtures.north, headCount: 4 })
      expect(second.status).toBe(409)
    })

    it("accepts a new request once the last one is decided", async () => {
      const first = await raise("branchAdmin", { branchId: fixtures.north, headCount: 3 })
      await decideAs("head", first.body.request.id, { decision: "reject" })
      expect((await raise("branchAdmin", { branchId: fixtures.north, headCount: 4 })).status).toBe(201)
    })

    it.each([
      ["a status", { status: "approved" }],
      ["an organization", { organizationId: 1 }],
      ["a decider", { decidedByUserId: randomUUID() }],
    ])("rejects a body carrying %s rather than applying it", async (_label, extra) => {
      const result = await raise("branchAdmin", { branchId: fixtures.north, headCount: 5, ...extra })
      expect(result.status).toBe(400)
      expect(await db.select().from(branchHeadCountRequests)
        .where(eq(branchHeadCountRequests.branchId, fixtures.north))).toHaveLength(0)
    })

    it.each([-1, 1.5, 1_000_001, "12"])("rejects a head count of %s", async (headCount) => {
      expect((await raise("branchAdmin", { branchId: fixtures.north, headCount })).status).toBe(400)
    })
  })

  describe("who may decide one", () => {
    it.each(["branchAdmin", "groupUser", "super", "orderPortal"] as const)("refuses %s", async (kind) => {
      const created = await raise("branchAdmin", { branchId: fixtures.north, headCount: 50 })
      expect((await decideAs(kind, created.body.request.id, { decision: "approve" })).status).toBe(403)
      expect(await headCountOf(fixtures.north)).toBe(10)
    })

    it("answers another tenant's Head Office exactly as a missing id", async () => {
      const created = await raise("branchAdmin", { branchId: fixtures.north, headCount: 50 })
      const foreign = await decideAs("foreignHead", created.body.request.id, { decision: "approve" })
      const missing = await decideAs("foreignHead", 2_000_000_000, { decision: "approve" })

      expect(foreign.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(foreign.body).toEqual(missing.body)
      expect(await headCountOf(fixtures.north)).toBe(10)
    })

    it("decides once: a replayed approval is a conflict", async () => {
      const created = await raise("branchAdmin", { branchId: fixtures.north, headCount: 50 })
      expect((await decideAs("head", created.body.request.id, { decision: "approve" })).status).toBe(200)
      expect((await decideAs("head", created.body.request.id, { decision: "approve" })).status).toBe(409)
      expect((await decideAs("head", created.body.request.id, { decision: "reject" })).status).toBe(409)
      expect(await headCountOf(fixtures.north)).toBe(50)
    })

    it("produces one decision when two arrive together", async () => {
      const created = await raise("branchAdmin", { branchId: fixtures.north, headCount: 60 })
      const results = await Promise.all([
        decideAs("head", created.body.request.id, { decision: "approve" }),
        decideAs("head", created.body.request.id, { decision: "reject" }),
      ])
      expect(results.map((result) => result.status).sort()).toEqual([200, 409])
    })

    it.each(["1abc", "1.5", "-1", "0"])("refuses the id %s", async (id) => {
      expect((await decideAs("head", id, { decision: "approve" })).status).toBe(400)
    })

    it("refuses a decision body that tries to change the figure", async () => {
      const created = await raise("branchAdmin", { branchId: fixtures.north, headCount: 50 })
      const result = await decideAs("head", created.body.request.id, { decision: "approve", headCount: 999 })
      expect(result.status).toBe(400)
      expect(await headCountOf(fixtures.north)).toBe(10)
    })
  })

  describe("the list", () => {
    it("shows a requester only its own branches, and a branch filter never widens it", async () => {
      await raise("branchAdmin", { branchId: fixtures.north, headCount: 7 })
      await db.insert(branchHeadCountRequests).values({
        organizationId: fixtures.home,
        branchId: fixtures.south,
        requestedHeadCount: 8,
        requestedByUserId: fixtures.ids.head,
      })

      const own = await listAs("branchAdmin")
      expect(own.status).toBe(200)
      expect(own.body.items.map((item: any) => item.branchId)).toEqual([fixtures.north])
      expect(own.body.canDecide).toBe(false)
      expect(own.body.requestableBranches.map((branch: any) => branch.id)).toEqual([fixtures.north])

      const widened = await listAs("branchAdmin", `?branchId=${fixtures.south}`)
      expect(widened.body.items).toEqual([])
    })

    it("shows Head Office its whole tenant and nothing of another", async () => {
      await raise("branchAdmin", { branchId: fixtures.north, headCount: 7 })
      const mine = await listAs("head")
      expect(mine.body.canDecide).toBe(true)
      expect(mine.body.pendingCount).toBe(1)
      expect(mine.body.items).toHaveLength(1)

      const theirs = await listAs("foreignHead")
      expect(theirs.body.items).toEqual([])
      expect(theirs.body.pendingCount).toBe(0)
    })

    it.each(["super", "orderPortal"] as const)("refuses %s", async (kind) => {
      expect((await listAs(kind)).status).toBe(403)
    })

    it("refuses an unknown status filter", async () => {
      expect((await listAs("head", "?status=cancelled")).status).toBe(400)
    })
  })

  describe("setting it directly on the branch", () => {
    it("lets Super Admin set and clear it on any tenant's branch", async () => {
      expect((await patchBranchAs("super", fixtures.abroad, { headCount: 77 })).status).toBe(200)
      expect(await headCountOf(fixtures.abroad)).toBe(77)
      expect((await patchBranchAs("super", fixtures.abroad, { headCount: null })).status).toBe(200)
      expect(await headCountOf(fixtures.abroad)).toBeNull()
      await db.update(branches).set({ headCount: 5 }).where(eq(branches.id, fixtures.abroad))
    })

    it("lets Head Office set it on its own branch, audited", async () => {
      expect((await patchBranchAs("head", fixtures.south, { headCount: 18 })).status).toBe(200)
      expect(await headCountOf(fixtures.south)).toBe(18)

      const trail = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "UPDATE_BRANCH"),
        eq(auditLogs.entityId, String(fixtures.south)),
      ))
      expect(trail.some((row) => JSON.stringify(row.metadata).includes("headCount"))).toBe(true)
    })

    it("refuses Head Office on another tenant's branch", async () => {
      expect((await patchBranchAs("head", fixtures.abroad, { headCount: 1 })).status).toBe(403)
      expect(await headCountOf(fixtures.abroad)).toBe(5)
    })

    it.each(["branchAdmin", "groupUser"] as const)("refuses %s, which must ask instead", async (kind) => {
      expect((await patchBranchAs(kind, fixtures.north, { headCount: 1 })).status).toBe(403)
      expect(await headCountOf(fixtures.north)).toBe(10)
    })

    it("refuses a malformed head count", async () => {
      expect((await patchBranchAs("head", fixtures.north, { headCount: -4 })).status).toBe(400)
      expect((await patchBranchAs("head", fixtures.north, { headCount: "12" })).status).toBe(400)
    })

    it("takes it when a branch is created, and reads it back", async () => {
      signIn("head")
      const response = await branchesRoute.POST(new Request("http://localhost/api/v1/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: fixtures.home,
          name: `Created ${fixtures.suffix}`,
          province: "Sindh",
          city: "Karachi",
          address: "9 Created Road",
          headCount: 33,
        }),
      }))
      expect(response.status).toBe(201)
      const created = (await response.json()).item
      expect(created.headCount).toBe(33)

      const read = await branchRoute.GET(
        new Request(`http://localhost/api/v1/branches/${created.id}`),
        { params: Promise.resolve({ id: String(created.id) }) },
      )
      expect((await read.json()).item.headCount).toBe(33)
    })
  })

  describe("the database", () => {
    it("refuses a head count outside its bounds", async () => {
      await expect(db.update(branches).set({ headCount: -1 }).where(eq(branches.id, fixtures.north)))
        .rejects.toThrow()
    })

    it("refuses a request whose branch belongs to another organization", async () => {
      await expect(db.insert(branchHeadCountRequests).values({
        organizationId: fixtures.home,
        branchId: fixtures.abroad,
        requestedHeadCount: 1,
        requestedByUserId: fixtures.ids.head,
      })).rejects.toThrow()
    })

    it("refuses a decided request with no decider", async () => {
      await expect(db.insert(branchHeadCountRequests).values({
        organizationId: fixtures.home,
        branchId: fixtures.north,
        requestedHeadCount: 1,
        requestedByUserId: fixtures.ids.head,
        status: "approved",
      })).rejects.toThrow()
    })
  })
})
