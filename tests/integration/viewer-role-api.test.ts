import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { randomUUID } from "node:crypto"
import { eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as drillDownRoute from "@/app/api/v1/analytics/drill-down/route"
import * as salesPerformanceRoute from "@/app/api/v1/analytics/sales-performance/route"
import * as branchesRoute from "@/app/api/v1/branches/route"
import * as usersRoute from "@/app/api/v1/users/route"
import { branches, orders, organizations, roles, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { countViewerStatusBuckets } from "@/lib/order-delivery-status"
import { NO_DATABASE_REASON, hasTestDatabase } from "./helpers/pricing-fixtures"

const mocks = vi.hoisted(() => ({
  hashPassword: vi.fn(async () => "integration-test-password-hash"),
  invalidateByPrefix: vi.fn(async () => {}),
  sendWelcomeEmail: vi.fn(async () => {}),
  withRateLimit: vi.fn(async () => null),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/password", () => ({ hashPassword: mocks.hashPassword }))
vi.mock("@/lib/email", () => ({ sendWelcomeEmail: mocks.sendWelcomeEmail }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: mocks.withRateLimit }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: mocks.invalidateByPrefix,
    // No Redis here: every cached read runs its real fetcher against the test
    // database rather than waiting on a connection that will never open.
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

const { getServerSession } = mockedNextAuth

if (!hasTestDatabase) console.warn(NO_DATABASE_REASON)

/**
 * The read-only Viewer role against its real endpoints.
 *
 * Two branches in one tenant and one in another, with a hand-worked spread of
 * order states so every bucket on the dashboard has a number that can be
 * checked by eye:
 *
 * ```text
 * Branch A   PENDING/NOT_STARTED        1,000
 *            APPROVED/IN_PROCESS        2,000   -> Active, Unfulfilled
 *            APPROVED/DELIVERED         3,000   -> Active, Delivered, pending ack
 *            FULFILLED/DELIVERED        4,000   -> Fulfilled, Delivered
 *            REJECTED/NOT_STARTED       5,000   -> no bucket
 * Branch B   APPROVED/DELIVERED         6,000   -> Active, Delivered, pending ack
 *            PARTIAL/DELIVERED          7,000   -> Fulfilled, Delivered
 * Foreign    APPROVED/DELIVERED        99,000   -> must never appear
 * ```
 */
type Fixtures = {
  suffix: string
  organizationId: number
  foreignOrganizationId: number
  branchAId: number
  branchBId: number
  foreignBranchId: number
  headOfficeId: string
  superAdminId: string
  viewerId: string
  pinnedViewerId: string
  foreignViewerId: string
  orderIds: number[]
  createdUserIds: string[]
}

type Actor = {
  id: string
  email: string
  role: string
  organizationId: number | null
}

const ORDER_SHAPES = [
  { branch: "A", status: "PENDING", fulfillmentStatus: "NOT_STARTED", totalCents: 1_000 },
  { branch: "A", status: "APPROVED", fulfillmentStatus: "IN_PROCESS", totalCents: 2_000 },
  { branch: "A", status: "APPROVED", fulfillmentStatus: "DELIVERED", totalCents: 3_000 },
  { branch: "A", status: "FULFILLED", fulfillmentStatus: "DELIVERED", totalCents: 4_000 },
  { branch: "A", status: "REJECTED", fulfillmentStatus: "NOT_STARTED", totalCents: 5_000 },
  { branch: "B", status: "APPROVED", fulfillmentStatus: "DELIVERED", totalCents: 6_000 },
  { branch: "B", status: "PARTIAL", fulfillmentStatus: "DELIVERED", totalCents: 7_000 },
  { branch: "F", status: "APPROVED", fulfillmentStatus: "DELIVERED", totalCents: 99_000 },
] as const

/** The oracle, computed from the same pure rules the dashboard prints. */
const TENANT_BUCKETS = countViewerStatusBuckets(
  ORDER_SHAPES.filter((shape) => shape.branch !== "F"),
)
const BRANCH_A_BUCKETS = countViewerStatusBuckets(
  ORDER_SHAPES.filter((shape) => shape.branch === "A"),
)

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, name))
    .limit(1)
  if (existing) return existing.id

  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by integration tests" })
    .returning({ id: roles.id })
  return created.id
}

async function createFixtures(): Promise<Fixtures> {
  const suffix = randomUUID().slice(0, 8)
  const headOfficeRoleId = await resolveRoleId("HEAD_OFFICE")
  const superAdminRoleId = await resolveRoleId("SUPER_ADMIN")
  const viewerRoleId = await resolveRoleId("VIEWER")

  const [organization] = await db
    .insert(organizations)
    .values({ name: `IT Viewer Org ${suffix}`, code: `ITV-${suffix}` })
    .returning({ id: organizations.id })

  const [foreignOrganization] = await db
    .insert(organizations)
    .values({ name: `IT Viewer Foreign ${suffix}`, code: `ITVF-${suffix}` })
    .returning({ id: organizations.id })

  const [branchA] = await db.insert(branches).values({
    organizationId: organization.id, name: `Viewer Branch A ${suffix}`, status: "active",
  }).returning({ id: branches.id })

  const [branchB] = await db.insert(branches).values({
    organizationId: organization.id, name: `Viewer Branch B ${suffix}`, status: "active",
  }).returning({ id: branches.id })

  const [foreignBranch] = await db.insert(branches).values({
    organizationId: foreignOrganization.id, name: `Viewer Foreign Branch ${suffix}`, status: "active",
  }).returning({ id: branches.id })

  const insertUser = async (
    label: string,
    roleId: number,
    organizationIdValue: number | null,
    branchId: number | null,
  ) => {
    const [row] = await db.insert(users).values({
      email: `viewer-${label}-${suffix}@example.test`,
      username: `viewer-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      roleId,
      organizationId: organizationIdValue,
      branchId,
      fullName: `Viewer Fixture ${label}`,
    }).returning({ id: users.id })
    return row.id
  }

  const headOfficeId = await insertUser("head", headOfficeRoleId, organization.id, null)
  const superAdminId = await insertUser("super", superAdminRoleId, null, null)
  const viewerId = await insertUser("open", viewerRoleId, organization.id, null)
  const pinnedViewerId = await insertUser("pinned", viewerRoleId, organization.id, branchA.id)
  const foreignViewerId = await insertUser("foreign", viewerRoleId, foreignOrganization.id, null)

  const branchIdFor = { A: branchA.id, B: branchB.id, F: foreignBranch.id }
  const organizationIdFor = {
    A: organization.id,
    B: organization.id,
    F: foreignOrganization.id,
  }

  const orderIds: number[] = []
  for (const shape of ORDER_SHAPES) {
    const [row] = await db.insert(orders).values({
      tid: randomUUID().replace(/-/g, "").slice(0, 26),
      organizationId: organizationIdFor[shape.branch],
      branchId: branchIdFor[shape.branch],
      status: shape.status,
      fulfillmentStatus: shape.fulfillmentStatus,
      totalCents: shape.totalCents,
      subtotalCents: shape.totalCents,
      createdByUserId: headOfficeId,
    }).returning({ id: orders.id })
    orderIds.push(row.id)
  }

  return {
    suffix,
    organizationId: organization.id,
    foreignOrganizationId: foreignOrganization.id,
    branchAId: branchA.id,
    branchBId: branchB.id,
    foreignBranchId: foreignBranch.id,
    headOfficeId,
    superAdminId,
    viewerId,
    pinnedViewerId,
    foreignViewerId,
    orderIds,
    createdUserIds: [],
  }
}

async function destroyFixtures(fixtures: Fixtures) {
  if (fixtures.orderIds.length > 0) {
    await db.delete(orders).where(inArray(orders.id, fixtures.orderIds))
  }
  const userIds = [
    ...fixtures.createdUserIds,
    fixtures.superAdminId,
    fixtures.viewerId,
    fixtures.pinnedViewerId,
    fixtures.foreignViewerId,
    fixtures.headOfficeId,
  ]
  await db.delete(users).where(inArray(users.id, userIds))
  await db.delete(branches).where(inArray(branches.id, [
    fixtures.branchAId, fixtures.branchBId, fixtures.foreignBranchId,
  ]))
  await db.delete(organizations).where(inArray(organizations.id, [
    fixtures.organizationId, fixtures.foreignOrganizationId,
  ]))
}

describe.skipIf(!hasTestDatabase)("the read-only Viewer role through its real API", () => {
  let fixtures: Fixtures
  const year = new Date().getFullYear()

  const signIn = (actor: Actor | null) => {
    vi.mocked(getServerSession).mockResolvedValue(
      actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
    )
  }

  const actor = (kind: "head" | "super" | "viewer" | "pinnedViewer" | "foreignViewer"): Actor => ({
    super: {
      id: fixtures.superAdminId,
      email: `viewer-super-${fixtures.suffix}@example.test`,
      role: "SUPER_ADMIN",
      organizationId: null,
    },
    head: {
      id: fixtures.headOfficeId,
      email: `viewer-head-${fixtures.suffix}@example.test`,
      role: "HEAD_OFFICE",
      organizationId: fixtures.organizationId,
    },
    viewer: {
      id: fixtures.viewerId,
      email: `viewer-open-${fixtures.suffix}@example.test`,
      role: "VIEWER",
      organizationId: fixtures.organizationId,
    },
    pinnedViewer: {
      id: fixtures.pinnedViewerId,
      email: `viewer-pinned-${fixtures.suffix}@example.test`,
      role: "VIEWER",
      organizationId: fixtures.organizationId,
    },
    foreignViewer: {
      id: fixtures.foreignViewerId,
      email: `viewer-foreign-${fixtures.suffix}@example.test`,
      role: "VIEWER",
      organizationId: fixtures.foreignOrganizationId,
    },
  }[kind])

  const kpis = async (query = "") => {
    const response = await salesPerformanceRoute.GET(new NextRequest(
      `http://localhost/api/v1/analytics/sales-performance`
      + `?status=all&includeStatusCounts=true&granularity=monthly&years=${year}${query}`,
    ))
    return { status: response.status, body: await response.json() }
  }

  const drillDown = async (type: string, query = "") => {
    const response = await drillDownRoute.GET(new NextRequest(
      `http://localhost/api/v1/analytics/drill-down?type=${type}&years=${year}${query}`,
    ))
    return { status: response.status, body: await response.json() }
  }

  beforeAll(async () => {
    fixtures = await createFixtures()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.withRateLimit.mockResolvedValue(null)
  })

  afterAll(async () => {
    if (fixtures) await destroyFixtures(fixtures)
    await closePool()
  })

  describe("authentication and authorization", () => {
    it("refuses an unauthenticated caller on every read it admits", async () => {
      signIn(null)

      expect((await kpis()).status).toBe(401)
      expect((await drillDown("PENDING")).status).toBe(401)
      const branchList = await branchesRoute.GET(new NextRequest("http://localhost/api/v1/branches"))
      expect(branchList.status).toBe(401)
    })

    it("refuses a Viewer every mutating endpoint, which it is in no allowlist for", async () => {
      signIn(actor("viewer"))

      const response = await usersRoute.POST(new Request("http://localhost/api/v1/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: "Should", lastName: "Fail",
          username: `nope-${fixtures.suffix}`,
          email: `nope-${fixtures.suffix}@example.test`,
          password: "Str0ng!Passw0rd!x",
          role: "ORDER_PORTAL",
          organizationId: fixtures.organizationId,
          branchId: fixtures.branchAId,
        }),
      }) as any)

      expect(response.status).toBe(403)
    })
  })

  describe("the dashboard's six status buckets", () => {
    it("reports the whole tenant for an unpinned Viewer", async () => {
      signIn(actor("viewer"))

      const { status, body } = await kpis()
      const counts = body.data?.statusCounts ?? body.statusCounts

      expect(status).toBe(200)
      expect(counts.pendingCount).toBe(TENANT_BUCKETS.PENDING)
      expect(counts.approvedCount).toBe(TENANT_BUCKETS.APPROVED)
      expect(counts.fulfilledCount).toBe(TENANT_BUCKETS.FULFILLED)
      expect(counts.deliveredCount).toBe(TENANT_BUCKETS.DELIVERED_UNACKNOWLEDGED)
      expect(counts.notDeliveredCount).toBe(TENANT_BUCKETS.UNFULFILLED)
      expect(counts.deliveredTotalCount).toBe(TENANT_BUCKETS.DELIVERED)
    })

    it("keeps Active equal to pending-acknowledgment plus unfulfilled, on real rows", async () => {
      signIn(actor("viewer"))

      const { body } = await kpis()
      const counts = body.data?.statusCounts ?? body.statusCounts

      expect(counts.deliveredCount + counts.notDeliveredCount).toBe(counts.approvedCount)
    })

    it("reports only its own branch for a pinned Viewer", async () => {
      signIn(actor("pinnedViewer"))

      const { status, body } = await kpis()
      const counts = body.data?.statusCounts ?? body.statusCounts

      expect(status).toBe(200)
      expect(counts.approvedCount).toBe(BRANCH_A_BUCKETS.APPROVED)
      expect(counts.fulfilledCount).toBe(BRANCH_A_BUCKETS.FULFILLED)
      expect(counts.deliveredTotalCount).toBe(BRANCH_A_BUCKETS.DELIVERED)
    })
  })

  describe("tenant and branch isolation", () => {
    it("ignores a sibling branch a pinned Viewer names on the query string", async () => {
      signIn(actor("pinnedViewer"))

      const { body } = await kpis(`&branchId=${fixtures.branchBId}&branchIds=${fixtures.branchBId}`)
      const counts = body.data?.statusCounts ?? body.statusCounts

      // Branch B's two orders are both delivered; branch A's figures must come
      // back unchanged rather than B's or the pair's.
      expect(counts.approvedCount).toBe(BRANCH_A_BUCKETS.APPROVED)
      expect(counts.deliveredTotalCount).toBe(BRANCH_A_BUCKETS.DELIVERED)
    })

    it("ignores an organizationIds list naming another tenant", async () => {
      signIn(actor("viewer"))

      const { body } = await kpis(`&organizationIds=${fixtures.foreignOrganizationId}`)
      const counts = body.data?.statusCounts ?? body.statusCounts

      // The foreign tenant's single 99,000 order must not be counted.
      expect(counts.approvedCount).toBe(TENANT_BUCKETS.APPROVED)
      expect(counts.deliveredTotalCount).toBe(TENANT_BUCKETS.DELIVERED)
    })

    it("shows a foreign Viewer only its own tenant's single order", async () => {
      signIn(actor("foreignViewer"))

      const { body } = await kpis()
      const counts = body.data?.statusCounts ?? body.statusCounts

      expect(counts.approvedCount).toBe(1)
      expect(counts.pendingCount).toBe(0)
    })

    it("lists a pinned Viewer only its own branch", async () => {
      signIn(actor("pinnedViewer"))

      const response = await branchesRoute.GET(new NextRequest("http://localhost/api/v1/branches"))
      const body = await response.json()
      const items = body.data?.items ?? body.items

      expect(response.status).toBe(200)
      expect(items.map((branch: any) => branch.id)).toEqual([fixtures.branchAId])
    })

    it("lists an unpinned Viewer its own tenant's branches and no other's", async () => {
      signIn(actor("viewer"))

      const response = await branchesRoute.GET(new NextRequest("http://localhost/api/v1/branches"))
      const body = await response.json()
      const items = body.data?.items ?? body.items
      const ids = items.map((branch: any) => branch.id).sort()

      expect(ids).toEqual([fixtures.branchAId, fixtures.branchBId].sort())
      expect(ids).not.toContain(fixtures.foreignBranchId)
    })
  })

  describe("the drill-down behind each card", () => {
    it("returns the same population the card counted, for both new buckets", async () => {
      signIn(actor("viewer"))

      const unacknowledged = await drillDown("DELIVERED_UNACKNOWLEDGED")
      const unfulfilled = await drillDown("UNFULFILLED")
      const delivered = await drillDown("DELIVERED")

      const rows = (result: any) => (result.body.data?.items ?? result.body.items ?? []).length

      expect(unacknowledged.status).toBe(200)
      expect(rows(unacknowledged)).toBe(TENANT_BUCKETS.DELIVERED_UNACKNOWLEDGED)
      expect(rows(unfulfilled)).toBe(TENANT_BUCKETS.UNFULFILLED)
      expect(rows(delivered)).toBe(TENANT_BUCKETS.DELIVERED)
    })

    it("keeps a pinned Viewer's drill-down on its own branch", async () => {
      signIn(actor("pinnedViewer"))

      const result = await drillDown("DELIVERED", `&branchIds=${fixtures.branchBId}`)
      const items = result.body.data?.items ?? result.body.items ?? []

      expect(items).toHaveLength(BRANCH_A_BUCKETS.DELIVERED)
    })

    it("refuses a drill-down type nobody defined", async () => {
      signIn(actor("viewer"))

      expect((await drillDown("EVERYTHING")).status).toBe(400)
    })
  })

  describe("creating one", () => {
    it("lets Head Office create a Viewer for its own tenant, with no branch", async () => {
      signIn(actor("head"))

      const response = await usersRoute.POST(new Request("http://localhost/api/v1/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: "New", lastName: "Viewer",
          username: `new-viewer-${fixtures.suffix}`,
          email: `new-viewer-${fixtures.suffix}@example.test`,
          password: "Str0ng!Passw0rd!x",
          role: "VIEWER",
          organizationId: fixtures.organizationId,
          branchId: null,
        }),
      }) as any)

      expect(response.status).toBe(201)
      const [created] = await db
        .select({ id: users.id, branchId: users.branchId })
        .from(users)
        .where(eq(users.username, `new-viewer-${fixtures.suffix}`))
        .limit(1)
      expect(created.branchId).toBeNull()
      fixtures.createdUserIds.push(created.id)
    })

    it("refuses Super Admin a Viewer with no organization at all", async () => {
      // Super Admin is the only actor that reaches the role-shape check with a
      // null organization: for Head Office the cross-tenant guard fires first,
      // which the next test pins.
      signIn(actor("super"))

      const response = await usersRoute.POST(new Request("http://localhost/api/v1/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: "Orphan", lastName: "Viewer",
          username: `orphan-viewer-${fixtures.suffix}`,
          email: `orphan-viewer-${fixtures.suffix}@example.test`,
          password: "Str0ng!Passw0rd!x",
          role: "VIEWER",
          organizationId: null,
          branchId: null,
        }),
      }) as any)

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        error: "organizationId required for VIEWER",
      })
    })

    it("refuses Head Office a Viewer outside its own tenant, null included", async () => {
      signIn(actor("head"))

      const response = await usersRoute.POST(new Request("http://localhost/api/v1/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: "Orphan", lastName: "Viewer",
          username: `orphan-viewer-${fixtures.suffix}`,
          email: `orphan-viewer-${fixtures.suffix}@example.test`,
          password: "Str0ng!Passw0rd!x",
          role: "VIEWER",
          organizationId: null,
          branchId: null,
        }),
      }) as any)

      expect(response.status).toBe(403)
    })

    it("refuses Head Office a Viewer in another tenant", async () => {
      signIn(actor("head"))

      const response = await usersRoute.POST(new Request("http://localhost/api/v1/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: "Cross", lastName: "Tenant",
          username: `cross-viewer-${fixtures.suffix}`,
          email: `cross-viewer-${fixtures.suffix}@example.test`,
          password: "Str0ng!Passw0rd!x",
          role: "VIEWER",
          organizationId: fixtures.foreignOrganizationId,
          branchId: null,
        }),
      }) as any)

      expect(response.status).toBe(403)
    })
  })
})
