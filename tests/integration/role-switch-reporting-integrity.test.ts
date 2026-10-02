import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import { budgets, orderItems, orders, roles, systemLogs, users } from "@/db/schema"
import * as budgetBurnRoute from "@/app/api/v1/analytics/executive/budget-burn/route"
import * as budgetSummaryRoute from "@/app/api/v1/analytics/budgets/summary/route"
import * as userPerformanceRoute from "@/app/api/v1/analytics/users/performance/route"
import * as userAccessRoute from "@/app/api/v1/users/[id]/access/route"
import { closePool, db } from "@/lib/db"

import {
  NO_DATABASE_REASON,
  createExecutiveAnalyticsFixtures,
  destroyExecutiveAnalyticsFixtures,
  hasTestDatabase,
  type ExecutiveAnalyticsFixtures,
} from "./helpers/executive-analytics-fixtures"

/**
 * Money integrity across a role change.
 *
 * The role-switch feature must not move a single rupee. Each test here asks a
 * money question, changes somebody's role, and asks it again — the answer has to
 * be identical, because a role lives on `users` and consumption is keyed on
 * `orders.branch_id`.
 *
 * The first block is a regression test for a defect this feature introduced and
 * that only appears once the feature is used: keying the budget-burn aggregate
 * on the **per-row** recorded creator role split a person whose role changed
 * mid-window into two rows, and because the panel keys creators on
 * `userId:branchId` that either listed them twice with their spend divided or
 * dropped one row outright in `unionCreators`. See `aggregatedRequesterRoleSql`.
 */

const mocks = vi.hoisted(() => ({
  invalidateByPrefix: vi.fn(async () => {}),
  invalidateSessionValidationCache: vi.fn(async () => {}),
  withRateLimit: vi.fn(async () => null),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({
  withRateLimit: mocks.withRateLimit,
  getRateLimitHeaders: () => ({}),
}))
vi.mock("@/lib/session-validation-cache", () => ({
  invalidateSessionValidationCache: mocks.invalidateSessionValidationCache,
}))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: mocks.invalidateByPrefix,
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId?: number | null; branchId?: number | null }

function signIn(actor: Actor) {
  vi.mocked(getServerSession).mockResolvedValue(
    { user: { ...actor, mustChangePassword: false } } as any,
  )
}

async function roleIdOf(name: string): Promise<number> {
  const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  return row.id
}

async function roleNameOf(userId: string): Promise<string> {
  const [row] = await db
    .select({ role: roles.name })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId))
    .limit(1)
  return row?.role ?? ""
}

describe.skipIf(!hasTestDatabase)("money integrity across a role change", () => {
  let f: ExecutiveAnalyticsFixtures
  let headOffice: Actor
  let superAdmin: Actor
  const extraOrderIds: number[] = []
  const budgetIds: number[] = []
  const createdUserIds: string[] = []

  const AT_AUGUST = new Date("2026-08-12T12:00:00.000Z")

  async function budgetBurn(query: Record<string, string> = {}) {
    const params = new URLSearchParams({ month: "2026-08", ...query })
    const response = await budgetBurnRoute.GET(
      new NextRequest(`http://localhost/api/v1/analytics/executive/budget-burn?${params}`),
    )
    return { status: response.status, body: await response.json() }
  }

  async function userPerformance() {
    const params = new URLSearchParams({
      branchIds: String(f.northBranchId),
      startDate: "2026-08-01",
      endDate: "2026-08-31",
    })
    const response = await userPerformanceRoute.GET(
      new NextRequest(`http://localhost/api/v1/analytics/users/performance?${params}`),
    )
    return { status: response.status, body: await response.json() }
  }

  async function budgetSummary() {
    const params = new URLSearchParams({ branchIds: String(f.northBranchId) })
    const response = await budgetSummaryRoute.GET(
      new NextRequest(`http://localhost/api/v1/analytics/budgets/summary?${params}`),
    )
    return { status: response.status, body: await response.json() }
  }

  async function changeRole(targetUserId: string, body: unknown) {
    const response = await userAccessRoute.PATCH(
      new Request("http://localhost/api/v1/users/x/access", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }) as any,
      { params: Promise.resolve({ id: targetUserId }) },
    )
    return { status: response.status, payload: await response.json() }
  }

  /** An order with an explicitly recorded creator role. */
  async function addOrder(input: {
    key: string
    createdByUserId: string
    createdByRole: string | null
    totalCents: number
    status?: string
    createdAt?: Date
    branchId?: number
  }) {
    const [row] = await db
      .insert(orders)
      .values({
        tid: `ITRI-${f.suffix}-${input.key}`.slice(0, 26),
        organizationId: f.organizationId,
        branchId: input.branchId ?? f.northBranchId,
        createdByUserId: input.createdByUserId,
        createdByRole: input.createdByRole,
        status: input.status ?? "FULFILLED",
        subtotalCents: input.totalCents,
        taxCents: 0,
        totalCents: input.totalCents,
        createdAt: input.createdAt ?? AT_AUGUST,
      })
      .returning({ id: orders.id, totalCents: orders.totalCents, createdAt: orders.createdAt })
    extraOrderIds.push(row.id)
    await db.insert(orderItems).values({
      organizationId: f.organizationId,
      orderId: row.id,
      globalProductId: f.paperProductId,
      productName: f.names.paper,
      unit: "Ream",
      quantity: 1,
      priceCents: row.totalCents,
      taxCents: 0,
      createdAt: row.createdAt,
    })
    return row.id
  }

  beforeAll(async () => {
    f = await createExecutiveAnalyticsFixtures()
    headOffice = {
      id: f.headOfficeId,
      email: "ho@example.test",
      role: "HEAD_OFFICE",
      organizationId: f.organizationId,
    }
    superAdmin = {
      id: f.superAdminId,
      email: "sa@example.test",
      role: "SUPER_ADMIN",
      organizationId: null,
    }

    const [northBudget] = await db
      .insert(budgets)
      .values({
        organizationId: f.organizationId,
        branchId: f.northBranchId,
        period: "2026-08",
        amountAllocatedCents: 10_000_000,
      })
      .returning({ id: budgets.id })
    budgetIds.push(northBudget.id)
  })

  afterAll(async () => {
    if (f) {
      if (budgetIds.length > 0) await db.delete(budgets).where(inArray(budgets.id, budgetIds))
      if (extraOrderIds.length > 0) {
        await db.delete(orderItems).where(inArray(orderItems.orderId, extraOrderIds))
        await db.delete(orders).where(inArray(orders.id, extraOrderIds))
      }
      // A role change writes an audit row referencing the tenant, and the
      // fixture teardown knows nothing about it — so it goes first, or the
      // organization delete below fails on the foreign key.
      if (createdUserIds.length > 0) {
        await db.delete(systemLogs).where(inArray(systemLogs.resourceId, createdUserIds))
      }
      // After the orders, never before: `orders.created_by_user_id` is a foreign
      // key and refuses the delete while any of their orders survives.
      if (createdUserIds.length > 0) {
        await db.delete(users).where(inArray(users.id, createdUserIds))
      }
      await destroyExecutiveAnalyticsFixtures(f)
    }
    await closePool()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    signIn(headOffice)
  })

  /**
   * The regression. A person whose role changed mid-window has orders carrying
   * two different recorded roles; the aggregate must still emit exactly one row
   * for them, carrying all of it.
   */
  describe("a creator whose role changed mid-window stays one row", () => {
    let mixedUserId: string
    const AS_REQUESTER = 700_000
    const AS_ADMIN = 300_000

    beforeAll(async () => {
      const [row] = await db
        .insert(users)
        .values({
          email: `itri-mixed-${f.suffix}@example.test`,
          username: `itri-mixed-${f.suffix}`,
          fullName: "Mixed Role Creator",
          passwordHash: "integration-test-hash",
          roleId: await roleIdOf("BRANCH_ADMIN"),
          organizationId: f.organizationId,
          branchId: f.northBranchId,
          isActive: true,
        })
        .returning({ id: users.id })
      mixedUserId = row.id
      createdUserIds.push(row.id)

      // Raised as a requester, before the promotion.
      await addOrder({
        key: "mixA",
        createdByUserId: mixedUserId,
        createdByRole: "ORDER_PORTAL",
        totalCents: AS_REQUESTER,
      })
      // Raised after it, as a Branch Admin. Same person, same branch, same month.
      await addOrder({
        key: "mixB",
        createdByUserId: mixedUserId,
        createdByRole: "BRANCH_ADMIN",
        totalCents: AS_ADMIN,
      })
    })

    it("emits exactly one watchlist row for the person, not one per recorded role", async () => {
      const { status, body } = await budgetBurn()
      expect(status).toBe(200)

      const theirRows = body.rows.filter((row: any) => row.userId === mixedUserId)
      // One row is necessary but not sufficient, and this assertion alone would
      // not have caught the defect: `unionCreators` dedupes on `userId:branchId`
      // and silently dropped the second row, so the count stayed 1 while the
      // money went missing. The consumption assertion below is the real control.
      expect(theirRows).toHaveLength(1)
    })

    it("carries their whole consumption on that row, losing nothing to the split", async () => {
      const { body } = await budgetBurn()
      const [theirRow] = body.rows.filter((row: any) => row.userId === mixedUserId)

      expect(theirRow.metrics.consumedCents).toBe(AS_REQUESTER + AS_ADMIN)
      expect(theirRow.metrics.months.at(-1).consumedCents).toBe(AS_REQUESTER + AS_ADMIN)
    })

    it("lists them under the requester role they actually raised orders with", async () => {
      const { body } = await budgetBurn()
      const [theirRow] = body.rows.filter((row: any) => row.userId === mixedUserId)
      // A requester role if any order in the window was raised under one — which
      // is what makes them appear on a panel that lists requesters at all.
      expect(theirRow.role).toBe("ORDER_PORTAL")
    })

    it("counts the same money once in the branch total", async () => {
      const { body } = await budgetBurn()
      const branch = body.branches.find((row: any) => row.branchId === f.northBranchId)
      const rowsForBranch = body.rows.filter((row: any) => row.branchId === f.northBranchId)
      const listedSum = rowsForBranch.reduce(
        (sum: number, row: any) => sum + row.metrics.consumedCents,
        0,
      )
      // The branch denominator sums every creator's row. A duplicated creator
      // row would have inflated it past the sum of the rows beneath it.
      expect(branch.consumedCents).toBeGreaterThanOrEqual(listedSum)
    })
  })

  /**
   * The headline promise: changing a role moves no money.
   */
  describe("a role change leaves every money figure identical", () => {
    let switchUserId: string
    const SPEND = 450_000
    const HELD = 120_000

    beforeAll(async () => {
      const [row] = await db
        .insert(users)
        .values({
          email: `itri-switch-${f.suffix}@example.test`,
          username: `itri-switch-${f.suffix}`,
          fullName: "Switching Requester",
          passwordHash: "integration-test-hash",
          roleId: await roleIdOf("ORDER_PORTAL"),
          organizationId: f.organizationId,
          branchId: f.northBranchId,
          isActive: true,
        })
        .returning({ id: users.id })
      switchUserId = row.id
      createdUserIds.push(row.id)

      await addOrder({
        key: "swA",
        createdByUserId: switchUserId,
        createdByRole: "ORDER_PORTAL",
        totalCents: SPEND,
      })
      // An approved-not-fulfilled order is a *hold*, and it also blocks the
      // switch — so it is settled below before the role is changed.
      await addOrder({
        key: "swB",
        createdByUserId: switchUserId,
        createdByRole: "ORDER_PORTAL",
        totalCents: HELD,
        status: "APPROVED",
      })
    })

    it("reports the same branch spend, hold and remaining before and after", async () => {
      const before = await budgetSummary()
      expect(before.status).toBe(200)

      // The held order has to settle before the role may change — that is the
      // lifecycle rule. Fulfilling it moves money from held to spent, so the
      // comparison is taken again after settling and before switching.
      await db
        .update(orders)
        .set({ status: "FULFILLED" })
        .where(and(eq(orders.createdByUserId, switchUserId), eq(orders.status, "APPROVED")))

      const settled = await budgetSummary()

      signIn(headOffice)
      const { status, payload } = await changeRole(switchUserId, {
        role: "BRANCH_ADMIN",
        branchId: f.northBranchId,
      })
      expect(status, JSON.stringify(payload)).toBe(200)
      expect(await roleNameOf(switchUserId)).toBe("BRANCH_ADMIN")

      const after = await budgetSummary()
      // Byte-identical: consumption is keyed on `orders.branch_id`, which a role
      // change does not touch.
      expect(after.body).toEqual(settled.body)
      expect(before.status).toBe(settled.status)
    })

    it("keeps the person's orders in the branch's user-performance figures", async () => {
      signIn(headOffice)
      const { status, body } = await userPerformance()
      expect(status).toBe(200)

      const rows: any[] = body.data ?? []
      const theirRow = rows.find((row: any) => row.id === switchUserId || row.userId === switchUserId)
      // They are a Branch Admin now — a role that raises nothing — but the
      // orders they raised as a requester are still theirs and still reported.
      expect(theirRow, "the promoted requester must not vanish from user performance").toBeTruthy()
    })
  })
})

describe.skipIf(hasTestDatabase)("role-switch reporting integrity suite", () => {
  it(NO_DATABASE_REASON, () => {})
})
