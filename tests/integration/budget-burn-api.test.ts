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
 *   X0c  2026-02-28  North   Ahmed          FULFILLED    777 777  before every bucket — nowhere
 *   X0   2026-04-10  North   Ahmed          FULFILLED    600 000  before every bucket — nowhere
 *   X0b  2026-05-31  North   Ahmed          FULFILLED    555 555  hours before June opens — nowhere
 *   X1   2026-07-20  North   Ahmed          FULFILLED    600 000
 *   X2   2026-08-05  North   Ahmed          FULFILLED    800 000
 *   X3   2026-08-28  North   Ahmed          FULFILLED  1 400 000  inside the last 7 days
 *   R1–3 2026-08-10  North   Ahmed          REJECTED      10 000  ×3 — approver said no
 *   C1   2026-08-13  North   Ahmed          CANCELLED    999 999  must appear nowhere
 *   BA1  2026-08-15  North   Branch Admin   FULFILLED    100 000  counts for the branch, never listed
 *   plus the shared fixtures' O1 (Ahmed, June, 11 000), O2 (Sana, June, 7 000),
 *   O3 (Ahmed, July, net 2 000), O4 (Group at South, July, 8 000),
 *   O5 (Group at North, APPROVED 2 000), O6 (Ahmed, PENDING 50 000),
 *   O7 (Sana, CANCELLED 15 000) and O8 (Sana, FULFILLED 1 500).
 *   North's August budget: allocated 3 000 000.
 *   Each extra order carries one Paper line whose price × quantity is its total,
 *   so the drill-down can be checked against the cell it was opened from.
 * ```
 *
 * August 2026, tenant A. The pattern is June, July and August, each on its own;
 * Share, Orders, the late window and the branch denominators are August alone.
 * X0b sits hours before June opens, so the oldest bucket has a floor and the
 * pattern is three months rather than "everything up to August".
 *
 *   North consumed  2 250 000 (Ahmed) + 2 000 (Group) + 100 000 (Branch Admin) = 2 352 000
 *   Ahmed at North  Jun    11 000 (O1)
 *                   Jul   602 000 (O3 net 2 000 + X1 600 000)
 *                   Aug 2 250 000 (X2 800 000 + X3 1 400 000 + O6 pending 50 000)
 *                   → MoM (2 250 000 − 602 000) / 602 000 = +273.75 %, highlighted
 *                     (previous month 602 000 clears the 500 000 baseline)
 *                   share 95.66 % · recent (25–31 Aug) 1 400 000 → 62.22 % of consumed
 *                   2 revenue orders · 1 pending · 3 rejected
 *                   reasons: high_share (3) + mom_spike (2) + late_surge (2) + rejected_orders (1) = 8
 *                   above_peers: South has no budget row → no peer figure
 *                   high_held: 50 000 < 20 % of 3 000 000 → no
 *   Group at North  Jun 0 · Jul 0 · Aug 2 000 — no previous month, so no percentage
 *   Sana at South   Jun 7 000 · Jul 0 · Aug 1 500 — no previous month, so no percentage
 *   Group at South  Jun 0 · Jul 8 000 · Aug 0 — **listed although August is empty**,
 *                   at −100 %, which is the union rule this panel turns on
 *   → 4 requesters, 1 highlighted, 1 still above the retired score line
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
/** An order months before the oldest bucket opens; it must reach no figure. */
const BEFORE_PATTERN_VALUE = 777_777
/** An order hours before the oldest bucket opens — the floor, not just the ceiling. */
const JUST_BEFORE_PATTERN_VALUE = 555_555

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
        extra("X0c", f.ahmedId, "FULFILLED", at("2026-02-28"), BEFORE_PATTERN_VALUE),
        extra("X0", f.ahmedId, "FULFILLED", at("2026-04-10"), 600_000),
        // 17:00 Karachi on 31 May — hours before the oldest bucket opens at
        // midnight on 1 June, so the pattern has a floor and not just a ceiling.
        extra("X0b", f.ahmedId, "FULFILLED", at("2026-05-31"), JUST_BEFORE_PATTERN_VALUE),
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
    it("draws Ahmed's three months, highlights the newest, and reports every signal the oracle predicts", async () => {
      const { status, body } = await budgetBurn({})
      expect(status).toBe(200)

      expect(body.month).toBe("2026-08")
      expect(body.windows.current.complete).toBe(true)
      expect(body.windows.current.elapsedDays).toBe(31)
      // June, July, August — all whole months because August is over.
      expect(body.windows.pattern.map((bucket: any) => bucket.month)).toEqual(["2026-06", "2026-07", "2026-08"])
      expect(body.windows.pattern.every((bucket: any) => bucket.complete)).toBe(true)
      expect(body.windows.pattern.at(-1).startDate).toBe(body.windows.current.startDate)
      expect(body.windows.pattern.at(-1).endDate).toBe(body.windows.current.endDate)
      expect(body.truncated).toBe(false)
      expect(body.limit).toBe(BUDGET_BURN_DEFAULT_ROWS)

      const ahmed = body.rows.find((row: any) => row.userId === f.ahmedId)
      expect(ahmed.requesterName).toBe(f.names.ahmed)
      expect(ahmed.role).toBe("ORDER_PORTAL")
      expect(ahmed.accountStatus).toBe("ACTIVE")
      expect(ahmed.branchId).toBe(f.northBranchId)
      expect(ahmed.branchName).toBe(f.names.north)

      // The three cells the reader sees, and the percentage that is a ratio of
      // the last two of them — checkable on the row, which is the point.
      expect(ahmed.metrics.months).toEqual([
        { month: "2026-06", spendCents: 11_000, pendingCents: 0, consumedCents: 11_000 },
        { month: "2026-07", spendCents: 602_000, pendingCents: 0, consumedCents: 602_000 },
        { month: "2026-08", spendCents: 2_200_000, pendingCents: 50_000, consumedCents: 2_250_000 },
      ])
      expect(ahmed.metrics.momPct).toBeCloseTo(((2_250_000 - 602_000) / 602_000) * 100, 6)
      expect(ahmed.metrics.momFlagged).toBe(true)
      // The newest cell is the row's own month figure; they cannot drift apart.
      expect(ahmed.metrics.months.at(-1).consumedCents).toBe(ahmed.metrics.consumedCents)

      expect(ahmed.metrics.spendCents).toBe(2_200_000)
      expect(ahmed.metrics.pendingCents).toBe(50_000)
      expect(ahmed.metrics.consumedCents).toBe(2_250_000)
      expect(ahmed.metrics.shareOfBranchPct).toBeCloseTo((2_250_000 / 2_352_000) * 100, 3)
      expect(ahmed.metrics.vsPeerPct).toBeNull()
      expect(ahmed.metrics.branchUtilizationPct).toBeCloseTo((2_352_000 / 3_000_000) * 100, 3)
      expect(ahmed.metrics.peerBranchMedianUtilizationPct).toBeNull()
      expect(ahmed.metrics.recentSharePct).toBeCloseTo((1_400_000 / 2_250_000) * 100, 3)
      expect(ahmed.metrics.orderCount).toBe(2)
      expect(ahmed.metrics.pendingOrderCount).toBe(1)
      expect(ahmed.metrics.rejectedOrderCount).toBe(3)

      // The retired multi-signal rule is still computed and still reported —
      // nothing on the panel reads it, and it must not change silently.
      expect(ahmed.score).toBe(8)
      expect(ahmed.reasons).toEqual(["high_share", "mom_spike", "late_surge", "rejected_orders"])
      expect(body.scoreFlaggedCount).toBe(1)
    })

    it("lists every requester of the pattern, highlighted first and then by this month's money", async () => {
      const { body } = await budgetBurn({})
      // Four rows, not one: the list is no longer a shortlist.
      expect(body.requesterCount).toBe(4)
      expect(body.highlightedCount).toBe(1)
      expect(body.rows).toHaveLength(4)
      expect(body.rows.map((row: any) => [row.userId, row.branchId])).toEqual([
        [f.ahmedId, f.northBranchId],          // highlighted
        [f.groupRequesterId, f.northBranchId], // 2 000 in August
        [f.sanaId, f.southBranchId],           // 1 500 in August
        [f.groupRequesterId, f.southBranchId], // nothing in August
      ])
      expect(body.rows.filter((row: any) => row.metrics.momFlagged)).toHaveLength(1)
    })

    it("lists a requester who consumed in an earlier month and nothing in the selected one", async () => {
      // The Group requester ordered at South in July (O4, 8 000) and nowhere in
      // August. Keying the list off the selected month alone would drop them,
      // and with them the only shape this panel exists to show.
      const { body } = await budgetBurn({})
      const lapsed = body.rows.find((row: any) => row.userId === f.groupRequesterId && row.branchId === f.southBranchId)
      expect(lapsed).toBeDefined()
      expect(lapsed.requesterName).toBe(f.names.group)
      expect(lapsed.branchName).toBe(f.names.south)
      expect(lapsed.metrics.months.map((month: any) => month.consumedCents)).toEqual([0, 8_000, 0])
      // No money of July's leaks into the selected month's own figures.
      expect(lapsed.metrics.consumedCents).toBe(0)
      expect(lapsed.metrics.orderCount).toBe(0)
      expect(lapsed.metrics.momPct).toBeCloseTo(-100)
      expect(lapsed.metrics.momFlagged).toBe(false)
    })

    it("calls a first month no baseline rather than no change", async () => {
      const { body } = await budgetBurn({})
      const groupAtNorth = body.rows.find((row: any) => row.userId === f.groupRequesterId && row.branchId === f.northBranchId)
      expect(groupAtNorth.metrics.months.map((month: any) => month.consumedCents)).toEqual([0, 0, 2_000])
      expect(groupAtNorth.metrics.momPct).toBeNull()
      expect(groupAtNorth.metrics.momFlagged).toBe(false)
    })

    it("never lets a cancelled order, or one before the oldest bucket, into any figure", async () => {
      const { body } = await budgetBurn({})
      const everyNumber = JSON.stringify(body)
      expect(everyNumber).not.toContain(String(MISSING_ORDER_VALUE))
      expect(everyNumber).not.toContain(String(BEFORE_PATTERN_VALUE))
      // X0b sits hours before 1 June: the oldest bucket has a floor, so the
      // pattern is three months and not "everything up to the selection".
      expect(everyNumber).not.toContain(String(JUST_BEFORE_PATTERN_VALUE))
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

    it("still lists the quiet requesters of a quiet month, with nothing highlighted", async () => {
      // June: O1 (Ahmed, 11 000) and O2 (Sana, 7 000), each alone at their branch.
      const { status, body } = await budgetBurn({ month: "2026-06" })
      expect(status).toBe(200)
      // The pattern steps back with the selection: April, May, June.
      expect(body.windows.pattern.map((bucket: any) => bucket.month)).toEqual(["2026-04", "2026-05", "2026-06"])
      expect(body.requesterCount).toBe(2)
      expect(body.highlightedCount).toBe(0)
      expect(body.scoreFlaggedCount).toBe(0)
      expect(body.rows).toHaveLength(2)

      // X0 (April, 600 000) and X0b (May, 555 555) now sit inside the pattern;
      // X0c (February) is outside it, so the oldest bucket still has a floor.
      const ahmed = body.rows.find((row: any) => row.userId === f.ahmedId)
      expect(ahmed.metrics.months.map((month: any) => month.consumedCents)).toEqual([600_000, 555_555, 11_000])
      expect(ahmed.metrics.momPct).toBeCloseTo(((11_000 - 555_555) / 555_555) * 100, 6)
      expect(ahmed.metrics.momFlagged).toBe(false)
      expect(JSON.stringify(body)).not.toContain(String(BEFORE_PATTERN_VALUE))
    })
  })

  // ── The drill-down behind a row ────────────────────────────────────────

  describe("the drill-down behind a row", () => {
    it("adds up to the row's Spend + Pending when asked for consumed lines, and to Spend alone by default", async () => {
      const { body: list } = await budgetBurn({})
      const ahmed = list.rows.find((row: any) => row.userId === f.ahmedId)

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

    it("adds up to an older month's cell when that cell is the one clicked", async () => {
      // Each month cell drills into its own month, so a three-column table
      // answers its own question rather than pointing at the newest one.
      const { body: list } = await budgetBurn({})
      const ahmed = list.rows.find((row: any) => row.userId === f.ahmedId)

      for (const cell of ahmed.metrics.months) {
        const [year, month] = cell.month.split("-").map(Number)
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
        const drill = await drillDown({
          key: f.ahmedId,
          branchIds: f.northBranchId,
          statuses: "consumed",
          startDate: `${cell.month}-01`,
          endDate: `${cell.month}-${String(lastDay).padStart(2, "0")}`,
        })
        expect(drill.status, cell.month).toBe(200)
        expect(drill.body.totals.valueCents, cell.month).toBe(cell.consumedCents)
      }
    })

    it("refuses a status set that is not on the allowlist", async () => {
      const { status, body } = await drillDown({ key: f.ahmedId, branchIds: f.northBranchId, statuses: "PENDING" })
      expect(status).toBe(400)
      expect(body.error).toBe("Unsupported statuses")
    })
  })

  describe("the item-wise 3-month consumption", () => {
    it("reads the same buckets as the row, so its totals equal the month cells above it", async () => {
      const { body: list } = await budgetBurn({})
      const ahmed = list.rows.find((row: any) => row.userId === f.ahmedId)

      const { status, body } = await itemComparison({ userId: f.ahmedId, branchIds: f.northBranchId })
      expect(status).toBe(200)
      expect(body.userId).toBe(f.ahmedId)
      expect(body.branchId).toBe(f.northBranchId)
      expect(body.month).toBe("2026-08")
      expect(body.windows.pattern.map((bucket: any) => bucket.month)).toEqual(["2026-06", "2026-07", "2026-08"])
      expect(body.truncated).toBe(false)

      // The panel that explains the months cannot disagree with them.
      expect(body.monthTotals.map((total: any) => total.spendCents)).toEqual([11_000, 602_000, 2_250_000])
      expect(body.monthTotals.map((total: any) => total.spendCents))
        .toEqual(ahmed.metrics.months.map((month: any) => month.consumedCents))

      // Paper per month: 10 (O1) · 4 net (O3) + 1 (X1) · 100 (O6) + 1 + 1 (X2, X3)
      //   at 5 000 · 2 000 + 600 000 · 50 000 + 800 000 + 1 400 000
      // Toner is a unit of its own and was bought in June alone.
      expect(body.items).toHaveLength(2)
      const [paper, toner] = body.items
      expect(paper).toMatchObject({ productId: f.paperProductId, productName: f.names.paper, unit: "Ream", momFlagged: true })
      expect(paper.months).toEqual([
        { month: "2026-06", quantity: 10, spendCents: 5_000, orderCount: 1 },
        { month: "2026-07", quantity: 5, spendCents: 602_000, orderCount: 2 },
        { month: "2026-08", quantity: 102, spendCents: 2_250_000, orderCount: 3 },
      ])
      // The product's own percentage is the same rule as the row's, on the
      // same two months — and here the same figure, because Paper is nearly
      // all of it.
      expect(paper.momPct).toBeCloseTo(((2_250_000 - 602_000) / 602_000) * 100, 6)
      expect(paper.momPct).toBeCloseTo(ahmed.metrics.momPct, 6)

      // Bought in June and never again: no previous month, so no percentage.
      expect(toner).toMatchObject({ productName: f.names.toner, unit: "Piece", momPct: null, momFlagged: false })
      expect(toner.months.map((month: any) => month.spendCents)).toEqual([6_000, 0, 0])
    })

    it("requires one resolved branch and returns no rows for a foreign requester", async () => {
      const broad = await itemComparison({ userId: f.ahmedId, branchIds: `${f.northBranchId},${f.southBranchId}` })
      expect(broad.status).toBe(400)
      expect(broad.body.field).toBe("branchIds")

      const foreign = await itemComparison({ userId: f.foreignUserId, branchIds: f.northBranchId })
      expect(foreign.status).toBe(200)
      expect(foreign.body.items).toEqual([])
      expect(foreign.body.monthTotals.map((total: any) => total.spendCents)).toEqual([0, 0, 0])
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
    it("shows the neighbour's Head Office its own rows and nothing of tenant A", async () => {
      signIn(neighbourHeadOffice)
      const { status, body } = await budgetBurn({})
      expect(status).toBe(200)
      expect(body.scope.organizationIds).toEqual([f.neighbourOrganizationId])
      expect(body.scope.branchCount).toBe(1)

      // OB (July, 7 000) is inside the pattern, so the neighbour's own
      // requester is listed although August is empty for them. August has no
      // tenant-B orders at all, so there is no branch summary.
      expect(body.rows.map((row: any) => row.userId)).toEqual([f.foreignUserId])
      expect(body.rows[0].branchName).toBe(f.names.foreign)
      expect(body.rows[0].metrics.months.map((month: any) => month.consumedCents)).toEqual([0, 7_000, 0])
      expect(body.requesterCount).toBe(1)
      expect(body.branches).toEqual([])

      // Nothing of tenant A reaches them — not a name, not a branch, not a figure.
      const everything = JSON.stringify(body)
      for (const leak of [f.ahmedId, f.sanaId, f.groupRequesterId, f.names.north, f.names.south, f.names.ahmed]) {
        expect(everything, String(leak)).not.toContain(String(leak))
      }
      expect(everything).not.toContain("2352000")
      expect(everything).not.toContain("2250000")
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
      expect(body.rows[0].userId).toBe(f.ahmedId)
      expect(body.rows.some((row: any) => row.userId === f.foreignUserId)).toBe(false)
      expect(JSON.stringify(body)).not.toContain(f.names.foreign)
    })

    it("lets a branch selection narrow the list, budgets included", async () => {
      const { body } = await budgetBurn({ branchIds: f.southBranchId })
      expect(body.branches.map((branch: any) => branch.branchId)).toEqual([f.southBranchId])
      // South's own requesters across the pattern: Sana (June and August) and
      // the Group requester (July only). North's are outside the selection.
      expect(body.requesterCount).toBe(2)
      expect(body.rows.map((row: any) => row.userId).sort()).toEqual([f.groupRequesterId, f.sanaId].sort())
      expect(body.rows.every((row: any) => row.branchId === f.southBranchId)).toBe(true)
      expect(body.highlightedCount).toBe(0)
    })

    it("answers SUPER_ADMIN for a selected tenant exactly as its Head Office is answered", async () => {
      signIn(superAdmin)
      const { body } = await budgetBurn({ organizationId: f.organizationId })
      expect(body.scope.organizationIds).toEqual([f.organizationId])
      expect(body.requesterCount).toBe(4)
      expect(body.rows[0].userId).toBe(f.ahmedId)
      expect(body.rows[0].metrics.momFlagged).toBe(true)
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
