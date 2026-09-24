import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import * as mockedRateLimiter from "@/lib/rate-limiter"

import { budgets, orderItems, orders } from "@/db/schema"

import * as itemComparisonRoute from "@/app/api/v1/analytics/executive/budget-burn/item-comparison/route"
import * as budgetBurnRoute from "@/app/api/v1/analytics/executive/budget-burn/route"
import * as drillDownRoute from "@/app/api/v1/analytics/executive/drill-down/route"
import { BUDGET_BURN_DEFAULT_ROWS, BUDGET_BURN_MAX_ROWS, BUDGET_BURN_THRESHOLDS } from "@/lib/budget-burn-risk"
import { closePool, db } from "@/lib/db"

import {
  createExecutiveAnalyticsFixtures,
  destroyExecutiveAnalyticsFixtures,
  hasTestDatabase,
  type ExecutiveAnalyticsFixtures,
} from "./helpers/executive-analytics-fixtures"

/**
 * The budget-burn watchlist route, end to end against real rows.
 *
 * Only identity is faked. The role gate, the tenant fence, the month calendar,
 * the SQL behind the aggregate, the refund netting and the scoring all run for
 * real — those are the parts that decide who is listed and who may read it.
 *
 * The shared executive fixtures are in cents so small that no real-world
 * threshold fires on them, which is right for the Center's own tests but
 * leaves the flagged path untested here. This file therefore adds a few rows
 * of its own to tenant A for August 2026 and works the oracle by hand:
 *
 * ```
 *   #    date        branch  creator        status     total     note
 *   X0c  2026-02-28  North   Ahmed          FULFILLED    777 777  before the older run opens — nowhere
 *   X0   2026-04-10  North   Ahmed          FULFILLED    600 000  inside the older run (Mar–May)
 *   X0b  2026-05-31  North   Ahmed          FULFILLED    100 000  its last day
 *   X1   2026-07-20  North   Ahmed          FULFILLED    600 000
 *   X2   2026-08-05  North   Ahmed          FULFILLED    800 000
 *   X3   2026-08-28  North   Ahmed          FULFILLED  1 400 000  inside the last 7 days
 *   R1–3 2026-08-10  North   Ahmed          REJECTED      10 000  ×3 — approver said no
 *   C1   2026-08-13  North   Ahmed          CANCELLED    999 999  must appear nowhere
 *   BA1  2026-08-15  North   Branch Admin   FULFILLED    100 000  counts for the branch, never listed
 *   plus the shared fixtures' O1 (Ahmed, June, 11 000), O5 (Group, APPROVED 2 000),
 *   O6 (Ahmed, PENDING 50 000), O7 (Sana, CANCELLED 15 000), O8 (Sana, FULFILLED 1 500),
 *   and O3 (Ahmed, July, net 2 000).
 *   North's August budget: allocated 3 000 000.
 *   Each extra order carries one Paper line whose price × quantity is its total,
 *   so the drill-down can be checked against the row it was opened from.
 * ```
 *
 * August 2026, tenant A. Every figure but the growth column is August alone;
 * the growth column is the three months ending with it against the three
 * before those (Jun–Aug against Mar–May), which is why the fixture carries
 * rows on both sides of 1 March and 1 June.
 *
 *   North consumed  2 250 000 (Ahmed) + 2 000 (Group) + 100 000 (Branch Admin) = 2 352 000
 *   Ahmed           spend 2 200 000 · pending 50 000 · consumed 2 250 000 · share 95.66 %
 *                   trend Jun–Aug  11 000 (O1) + 602 000 (July) + 2 250 000 (Aug) = 2 863 000
 *                   trend Mar–May  600 000 (X0) + 100 000 (X0b)                    =   700 000
 *                                  → +309.00 %  (never +273.75 %, which is July alone)
 *                   recent (25–31 Aug) 1 400 000 → 62.22 % of consumed
 *                   2 revenue orders · 1 pending · 3 rejected
 *                   reasons: high_share (3) + trend_spike (2) + late_surge (2) + rejected_orders (1) = 8
 *                   above_peers: only one other requester at North → no peer figure
 *                   high_held: 50 000 < 20 % of 3 000 000 → no
 *   Group at North  2 000, nothing flagged
 *   Sana at South   1 500, sole requester, nothing flagged
 *   North remaining 3 000 000 − (spent 2 300 000 + held 52 000) = 648 000
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
// Rate limiting needs Redis; the limit itself is unit-tested elsewhere.
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))

const { getServerSession } = mockedNextAuth
const { withRateLimit } = mockedRateLimiter

type Actor = { id: string; role: string }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(actor === null ? null : ({ user: actor } as any))
}

type Query = Record<string, string | number | undefined>

async function budgetBurn(query: Query) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ month: "2026-08", ...query })) {
    if (value !== undefined && value !== "") params.set(key, String(value))
  }
  const response = await budgetBurnRoute.GET(new NextRequest(`http://localhost/api/v1/analytics/executive/budget-burn?${params.toString()}`))
  return { status: response.status, body: await response.json() }
}

const MISSING_ORDER_VALUE = 999_999
/** An order one day before the older trend run opens; it must reach no figure. */
const BEFORE_TREND_VALUE = 777_777

/** The drill-down a watchlist row opens: this requester, at this branch, for the month. */
async function drillDown(query: Query) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ dimension: "user", metric: "spend", startDate: "2026-08-01", endDate: "2026-08-31", ...query })) {
    if (value !== undefined && value !== "") params.set(key, String(value))
  }
  const response = await drillDownRoute.GET(new NextRequest(`http://localhost/api/v1/analytics/executive/drill-down?${params.toString()}`))
  return { status: response.status, body: await response.json() }
}

async function itemComparison(query: Query) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ month: "2026-08", ...query })) {
    if (value !== undefined && value !== "") params.set(key, String(value))
  }
  const response = await itemComparisonRoute.GET(new NextRequest(`http://localhost/api/v1/analytics/executive/budget-burn/item-comparison?${params.toString()}`))
  return { status: response.status, body: await response.json() }
}

describe.skipIf(!hasTestDatabase)("budget-burn watchlist route", () => {
  let f: ExecutiveAnalyticsFixtures
  let headOffice: Actor
  let neighbourHeadOffice: Actor
  let superAdmin: Actor
  let southApprover: Actor
  let extraOrderIds: number[] = []
  let northBudgetId: number

  beforeAll(async () => {
    f = await createExecutiveAnalyticsFixtures()
    headOffice = { id: f.headOfficeId, role: "HEAD_OFFICE" }
    neighbourHeadOffice = { id: f.neighbourHeadOfficeId, role: "HEAD_OFFICE" }
    superAdmin = { id: f.superAdminId, role: "SUPER_ADMIN" }
    southApprover = { id: f.southApproverId, role: "GROUP_USER" }

    const at = (day: string) => new Date(`${day}T12:00:00.000Z`)
    const extra = (key: string, createdByUserId: string, status: string, createdAt: Date, totalCents: number) => ({
      tid: `ITB-${f.suffix}-${key}`,
      organizationId: f.organizationId,
      branchId: f.northBranchId,
      createdByUserId,
      status,
      subtotalCents: totalCents,
      taxCents: 0,
      totalCents,
      createdAt,
    })
    const inserted = await db
      .insert(orders)
      .values([
        // 17:00 Karachi on 28 February — hours before the older run opens at
        // midnight on 1 March, so the run has a floor and not just a ceiling.
        extra("X0c", f.ahmedId, "FULFILLED", at("2026-02-28"), BEFORE_TREND_VALUE),
        extra("X0", f.ahmedId, "FULFILLED", at("2026-04-10"), 600_000),
        extra("X0b", f.ahmedId, "FULFILLED", at("2026-05-31"), 100_000),
        extra("X1", f.ahmedId, "FULFILLED", at("2026-07-20"), 600_000),
        extra("X2", f.ahmedId, "FULFILLED", at("2026-08-05"), 800_000),
        extra("X3", f.ahmedId, "FULFILLED", at("2026-08-28"), 1_400_000),
        extra("R1", f.ahmedId, "REJECTED", at("2026-08-10"), 10_000),
        extra("R2", f.ahmedId, "REJECTED", at("2026-08-11"), 10_000),
        extra("R3", f.ahmedId, "REJECTED", at("2026-08-12"), 10_000),
        extra("C1", f.ahmedId, "CANCELLED", at("2026-08-13"), MISSING_ORDER_VALUE),
        extra("BA1", f.branchAdminId, "FULFILLED", at("2026-08-15"), 100_000),
      ])
      .returning({ id: orders.id, totalCents: orders.totalCents, createdAt: orders.createdAt })
    extraOrderIds = inserted.map((row) => row.id)
    // One line per order, priced so that price × quantity is the order total.
    await db.insert(orderItems).values(inserted.map((row) => ({
      organizationId: f.organizationId,
      orderId: row.id,
      globalProductId: f.paperProductId,
      productName: f.names.paper,
      unit: "Ream",
      quantity: 1,
      priceCents: row.totalCents,
      taxCents: 0,
      createdAt: row.createdAt,
    })))

    const [budget] = await db
      .insert(budgets)
      .values({ organizationId: f.organizationId, branchId: f.northBranchId, period: "2026-08", amountAllocatedCents: 3_000_000 })
      .returning({ id: budgets.id })
    northBudgetId = budget.id
  })

  beforeEach(() => {
    vi.clearAllMocks()
    signIn(headOffice)
  })

  afterAll(async () => {
    if (f) {
      if (northBudgetId) await db.delete(budgets).where(eq(budgets.id, northBudgetId))
      if (extraOrderIds.length > 0) {
        await db.delete(orderItems).where(inArray(orderItems.orderId, extraOrderIds))
        await db.delete(orders).where(inArray(orders.id, extraOrderIds))
      }
      await destroyExecutiveAnalyticsFixtures(f)
    }
    await closePool()
  })

  // ── Access control ─────────────────────────────────────────────────────

  describe("access control", () => {
    it("refuses an unauthenticated caller with 401", async () => {
      signIn(null)
      const { status, body } = await budgetBurn({})
      expect(status).toBe(401)
      expect(body.rows).toBeUndefined()
    })

    it("refuses BRANCH_ADMIN, ORDER_PORTAL and GROUP_ORDER_PORTAL with 403", async () => {
      for (const actor of [
        { id: f.branchAdminId, role: "BRANCH_ADMIN" },
        { id: f.ahmedId, role: "ORDER_PORTAL" },
        { id: f.groupRequesterId, role: "GROUP_ORDER_PORTAL" },
      ]) {
        signIn(actor)
        const { status, body } = await budgetBurn({})
        expect(status, actor.role).toBe(403)
        expect(body.rows, actor.role).toBeUndefined()
      }
    })

    it("refuses the multi-branch approver, although the rest of the Center admits it", async () => {
      signIn(southApprover)
      const { status, body } = await budgetBurn({})
      expect(status).toBe(403)
      expect(body.error).toBe("Forbidden: Insufficient permissions")
      expect(body.rows).toBeUndefined()
    })

    it("believes the user row, not a session that claims a stronger role", async () => {
      signIn({ id: f.branchAdminId, role: "HEAD_OFFICE" })
      expect((await budgetBurn({})).status).toBe(403)
      signIn({ id: f.southApproverId, role: "SUPER_ADMIN" })
      expect((await budgetBurn({})).status).toBe(403)
      signIn({ id: f.ahmedId, role: "SUPER_ADMIN" })
      expect((await budgetBurn({})).status).toBe(403)
    })

    it("answers HEAD_OFFICE and SUPER_ADMIN", async () => {
      signIn(headOffice)
      expect((await budgetBurn({})).status).toBe(200)
      signIn(superAdmin)
      expect((await budgetBurn({})).status).toBe(200)
    })

    it("is rate limited as a listing endpoint", async () => {
      await budgetBurn({})
      expect(withRateLimit).toHaveBeenCalledWith("search", f.headOfficeId)
    })
  })

  // ── The list ───────────────────────────────────────────────────────────

  describe("the watchlist for August 2026", () => {
    it("lists Ahmed at North with every reason the oracle predicts, and nobody else", async () => {
      const { status, body } = await budgetBurn({})
      expect(status).toBe(200)

      expect(body.month).toBe("2026-08")
      expect(body.windows.current.complete).toBe(true)
      expect(body.windows.current.elapsedDays).toBe(31)
      // Jun–Aug against Mar–May, both whole because August is over.
      expect(body.windows.trend.months).toBe(3)
      expect(body.windows.trend.current.startMonth).toBe("2026-06")
      expect(body.windows.trend.current.endMonth).toBe("2026-08")
      expect(body.windows.trend.prior.startMonth).toBe("2026-03")
      expect(body.windows.trend.prior.endMonth).toBe("2026-05")
      expect(body.flaggedCount).toBe(1)
      // Group at North and Sana at South sat below the line.
      expect(body.unflaggedCount).toBe(2)
      expect(body.truncated).toBe(false)
      expect(body.limit).toBe(BUDGET_BURN_DEFAULT_ROWS)

      expect(body.rows).toHaveLength(1)
      const [ahmed] = body.rows
      expect(ahmed.userId).toBe(f.ahmedId)
      expect(ahmed.requesterName).toBe(f.names.ahmed)
      expect(ahmed.role).toBe("ORDER_PORTAL")
      expect(ahmed.accountStatus).toBe("ACTIVE")
      expect(ahmed.branchId).toBe(f.northBranchId)
      expect(ahmed.branchName).toBe(f.names.north)
      expect(ahmed.score).toBe(8)
      expect(ahmed.reasons).toEqual(["high_share", "trend_spike", "late_surge", "rejected_orders"])

      expect(ahmed.metrics.spendCents).toBe(2_200_000)
      expect(ahmed.metrics.pendingCents).toBe(50_000)
      expect(ahmed.metrics.consumedCents).toBe(2_250_000)
      expect(ahmed.metrics.shareOfBranchPct).toBeCloseTo((2_250_000 / 2_352_000) * 100, 3)
      // The growth is the two runs of months, not the month beside it: had it
      // stayed month-over-month these would read 2 250 000 against 602 000.
      expect(ahmed.metrics.trendConsumedCents).toBe(2_863_000)
      expect(ahmed.metrics.priorTrendConsumedCents).toBe(700_000)
      expect(ahmed.metrics.trendPct).toBeCloseTo(((2_863_000 - 700_000) / 700_000) * 100, 3)
      expect(ahmed.metrics.vsPeerPct).toBeNull()
      expect(ahmed.metrics.branchUtilizationPct).toBeCloseTo((2_352_000 / 3_000_000) * 100, 3)
      expect(ahmed.metrics.peerBranchMedianUtilizationPct).toBeNull()
      expect(ahmed.metrics.recentSharePct).toBeCloseTo((1_400_000 / 2_250_000) * 100, 3)
      expect(ahmed.metrics.orderCount).toBe(2)
      expect(ahmed.metrics.pendingOrderCount).toBe(1)
      expect(ahmed.metrics.rejectedOrderCount).toBe(3)
    })

    it("never lets a cancelled order, or one before the older run, into any figure", async () => {
      const { body } = await budgetBurn({})
      const everyNumber = JSON.stringify(body)
      expect(everyNumber).not.toContain(String(MISSING_ORDER_VALUE))
      // X0c sits hours before 1 March: the older run has a floor, so it is a
      // run of three months and not "everything before the newer one".
      expect(everyNumber).not.toContain(String(BEFORE_TREND_VALUE))
      // Sana's CANCELLED O7 (15 000) would have made South 16 500.
      const south = body.branches.find((branch: any) => branch.branchId === f.southBranchId)
      expect(south.consumedCents).toBe(1_500)
    })

    it("counts every creator toward the branch but lists requesters only", async () => {
      const { body } = await budgetBurn({})
      const north = body.branches.find((branch: any) => branch.branchId === f.northBranchId)
      expect(north.branchName).toBe(f.names.north)
      expect(north.consumedCents).toBe(2_352_000)
      expect(north.otherCreatorsConsumedCents).toBe(100_000)
      expect(north.activeRequesterCount).toBe(2)
      expect(north.totalBudgetCents).toBe(3_000_000)
      expect(north.remainingCents).toBe(648_000)
      // The Branch Admin's order is in the denominator and nowhere else.
      expect(body.rows.some((row: any) => row.userId === f.branchAdminId)).toBe(false)
    })

    it("reports the branches largest first and the shared thresholds beside them", async () => {
      const { body } = await budgetBurn({})
      expect(body.branches.map((branch: any) => branch.branchId)).toEqual([f.northBranchId, f.southBranchId])
      expect(body.thresholds).toEqual(BUDGET_BURN_THRESHOLDS)
      expect(body.points.high_share).toBe(3)
      expect(body.reasonLabels.late_surge).toBe("Late surge")
    })

    it("carries no email address for anyone", async () => {
      const { body } = await budgetBurn({})
      expect(JSON.stringify(body)).not.toContain("@example.test")
    })

    it("returns nothing flagged for a quiet month, with the requesters counted below the line", async () => {
      // June: O1 (Ahmed, 11 000) and O2 (Sana, 7 000), each alone at their branch.
      const { status, body } = await budgetBurn({ month: "2026-06" })
      expect(status).toBe(200)
      expect(body.rows).toEqual([])
      expect(body.flaggedCount).toBe(0)
      expect(body.unflaggedCount).toBe(2)
      // June's runs step back with it: Apr–Jun against Jan–Mar. X0 and X0b
      // (711 000 with O1) now sit in the newer run and X0c (777 777) alone in
      // the older one, so June's growth is negative and nothing spikes.
      expect(body.windows.trend.current.startMonth).toBe("2026-04")
      expect(body.windows.trend.current.endMonth).toBe("2026-06")
      expect(body.windows.trend.prior.startMonth).toBe("2026-01")
      expect(body.windows.trend.prior.endMonth).toBe("2026-03")
    })
  })

  // ── The drill-down behind a row ────────────────────────────────────────

  describe("the drill-down behind a row", () => {
    it("adds up to the row's Spend + Pending when asked for consumed lines, and to Spend alone by default", async () => {
      const { body: list } = await budgetBurn({})
      const [ahmed] = list.rows

      const consumed = await drillDown({ key: f.ahmedId, branchIds: f.northBranchId, statuses: "consumed" })
      expect(consumed.status).toBe(200)
      expect(consumed.body.statuses).toBe("consumed")
      expect(consumed.body.totals.valueCents).toBe(ahmed.metrics.consumedCents)
      expect(consumed.body.totals.orderCount).toBe(ahmed.metrics.orderCount + ahmed.metrics.pendingOrderCount)
      const statuses = consumed.body.rows.map((row: any) => row.status).sort()
      expect(statuses).toEqual(["FULFILLED", "FULFILLED", "PENDING"])
      // Rejected and cancelled orders have no place in either listing.
      expect(JSON.stringify(consumed.body)).not.toContain(String(MISSING_ORDER_VALUE))

      const revenue = await drillDown({ key: f.ahmedId, branchIds: f.northBranchId })
      expect(revenue.body.statuses).toBe("revenue")
      expect(revenue.body.totals.valueCents).toBe(ahmed.metrics.spendCents)
      expect(revenue.body.rows.map((row: any) => row.status)).toEqual(["FULFILLED", "FULFILLED"])
    })

    it("refuses a status set that is not on the allowlist", async () => {
      const { status, body } = await drillDown({ key: f.ahmedId, branchIds: f.northBranchId, statuses: "PENDING" })
      expect(status).toBe(400)
      expect(body.error).toBe("Unsupported statuses")
    })
  })

  describe("the item-wise 3-month comparison", () => {
    it("reconciles item quantity and spend with the two runs the growth figure was built from", async () => {
      const { status, body } = await itemComparison({ userId: f.ahmedId, branchIds: f.northBranchId })
      expect(status).toBe(200)
      expect(body.userId).toBe(f.ahmedId)
      expect(body.branchId).toBe(f.northBranchId)
      expect(body.month).toBe("2026-08")
      expect(body.windows.months).toBe(3)
      expect(body.windows.current.startMonth).toBe("2026-06")
      expect(body.windows.current.endMonth).toBe("2026-08")
      expect(body.windows.prior.startMonth).toBe("2026-03")
      expect(body.windows.prior.endMonth).toBe("2026-05")
      // Both totals are the same two figures the row's growth % came from, so
      // the panel that explains a percentage cannot disagree with it.
      expect(body.currentTotalSpendCents).toBe(2_863_000)
      expect(body.priorTotalSpendCents).toBe(700_000)
      expect(body.truncated).toBe(false)

      // Jun–Aug: Paper 10 (O1) + 4 net (O3) + 100 (O6) + 1 + 1 + 1 (X1–X3) = 117
      //             at 5 000 + 2 000 + 50 000 + 600 000 + 800 000 + 1 400 000 = 2 857 000
      // Mar–May: Paper 1 (X0) + 1 (X0b) = 2 at 700 000. Toner is a unit of its own.
      expect(body.items).toHaveLength(2)
      expect(body.items[0]).toMatchObject({
        productId: f.paperProductId,
        productName: f.names.paper,
        unit: "Ream",
        currentQuantity: 117,
        priorQuantity: 2,
        deltaQuantity: 115,
        currentSpendCents: 2_857_000,
        priorSpendCents: 700_000,
        currentOrderCount: 6,
        priorOrderCount: 2,
      })
      expect(body.items[0].deltaPct).toBeCloseTo(5750)
      // O1's toner line is in the newer run only — "new since last quarter".
      expect(body.items[1]).toMatchObject({
        productName: f.names.toner,
        unit: "Piece",
        currentQuantity: 2,
        priorQuantity: 0,
        deltaQuantity: 2,
        currentSpendCents: 6_000,
        priorSpendCents: 0,
        deltaPct: null,
      })
    })

    it("requires one resolved branch and returns no rows for a foreign requester", async () => {
      const broad = await itemComparison({ userId: f.ahmedId, branchIds: `${f.northBranchId},${f.southBranchId}` })
      expect(broad.status).toBe(400)
      expect(broad.body.field).toBe("branchIds")

      const foreign = await itemComparison({ userId: f.foreignUserId, branchIds: f.northBranchId })
      expect(foreign.status).toBe(200)
      expect(foreign.body.items).toEqual([])
      expect(foreign.body.currentTotalSpendCents).toBe(0)
      expect(foreign.body.priorTotalSpendCents).toBe(0)
    })

    it("validates the requester and month", async () => {
      expect((await itemComparison({ branchIds: f.northBranchId })).status).toBe(400)
      const malformed = await itemComparison({ userId: f.ahmedId, branchIds: f.northBranchId, month: "2026-8" })
      expect(malformed.status).toBe(400)
      expect(malformed.body.field).toBe("month")
    })
  })

  // ── Tenant isolation ───────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("shows the neighbour's Head Office nothing of tenant A", async () => {
      signIn(neighbourHeadOffice)
      const { status, body } = await budgetBurn({})
      expect(status).toBe(200)
      expect(body.rows).toEqual([])
      expect(body.branches).toEqual([])
      expect(body.unflaggedCount).toBe(0)
      expect(body.scope.organizationIds).toEqual([f.neighbourOrganizationId])
      expect(body.scope.branchCount).toBe(1)
    })

    it("narrows a foreign branch to nothing instead of reaching it", async () => {
      signIn(neighbourHeadOffice)
      const { status, body } = await budgetBurn({ branchIds: f.northBranchId })
      expect(status).toBe(403)
      expect(body.error).toBe("No branches in scope")
      expect(body.rows).toBeUndefined()
    })

    it("ignores an organizationId pointing at the neighbour", async () => {
      const { body } = await budgetBurn({ organizationId: f.neighbourOrganizationId })
      expect(body.scope.organizationIds).toEqual([f.organizationId])
      expect(body.rows.map((row: any) => row.userId)).toEqual([f.ahmedId])
    })

    it("lets a branch selection narrow the list, budgets included", async () => {
      const { body } = await budgetBurn({ branchIds: f.southBranchId })
      expect(body.rows).toEqual([])
      expect(body.branches.map((branch: any) => branch.branchId)).toEqual([f.southBranchId])
      expect(body.unflaggedCount).toBe(1)
    })

    it("answers SUPER_ADMIN for a selected tenant exactly as its Head Office is answered", async () => {
      signIn(superAdmin)
      const { body } = await budgetBurn({ organizationId: f.organizationId })
      expect(body.scope.organizationIds).toEqual([f.organizationId])
      expect(body.rows.map((row: any) => row.userId)).toEqual([f.ahmedId])
      expect(body.rows[0].score).toBe(8)
    })
  })

  // ── Validation and bounds ──────────────────────────────────────────────

  describe("validation and bounds", () => {
    it("refuses a malformed, future or too-distant month with 400", async () => {
      for (const month of ["2026-13", "2026-8", "202608", "August"]) {
        const { status, body } = await budgetBurn({ month })
        expect(status, month).toBe(400)
        expect(body.field, month).toBe("month")
      }
      const future = await budgetBurn({ month: "2099-01" })
      expect(future.status).toBe(400)
      expect(future.body.error).toBe("month is in the future")
      const distant = await budgetBurn({ month: "2000-01" })
      expect(distant.status).toBe(400)
      expect(distant.body.field).toBe("month")
    })

    it("refuses a limit that is not a whole number and clamps one that is", async () => {
      expect((await budgetBurn({ limit: "abc" })).status).toBe(400)
      expect((await budgetBurn({ limit: "-1" })).status).toBe(400)
      expect((await budgetBurn({ limit: "0" })).body.limit).toBe(BUDGET_BURN_DEFAULT_ROWS)
      expect((await budgetBurn({ limit: "1" })).body.limit).toBe(1)
      expect((await budgetBurn({ limit: "9999" })).body.limit).toBe(BUDGET_BURN_MAX_ROWS)
    })

    it("defaults to the current month when none is named", async () => {
      const { status, body } = await budgetBurn({ month: "" })
      expect(status).toBe(200)
      expect(body.month).toMatch(/^\d{4}-\d{2}$/)
      expect(body.windows.current.complete).toBe(false)
    })
  })
})
