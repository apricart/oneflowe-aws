import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as consumptionTrendRoute from "@/app/api/v1/analytics/products/consumption-trend/route"
import { CONSUMPTION_TREND_MAX_SERIES, OTHER_SERIES_ID } from "@/lib/product-consumption-trend"
import { closePool } from "@/lib/db"

import {
  createExecutiveAnalyticsFixtures,
  destroyExecutiveAnalyticsFixtures,
  hasTestDatabase,
  type ExecutiveAnalyticsFixtures,
} from "./helpers/executive-analytics-fixtures"

/**
 * The monthly consumption trend route, end to end against real rows.
 *
 * Only identity is faked. The organization resolver, the branch fence, the
 * status filter, the refund netting, the category roll-up and the month
 * bucketing all run for real.
 *
 * The oracle, worked by hand from the shared executive fixtures. Only orders in
 * a fulfilment status count, so O6 (PENDING), O7 (CANCELLED), and O9
 * (REFUNDED) reach nothing at all, and OB belongs to the neighbour tenant:
 *
 * ```
 *   order  month     branch  status     lines                       counted
 *   O1     2026-06   North   FULFILLED  paper ×10, toner ×2         yes
 *   O2     2026-06   South   APPROVED   paper ×4, diesel ×50        yes
 *   O3     2026-07   North   PARTIAL    paper ×6, 2 refunded        yes → 4 consumed
 *   O4     2026-07   South   FULFILLED  toner ×1, paper ×2          yes
 *   O5     2026-08   North   APPROVED   diesel ×20                  yes
 *   O6     2026-08   North   PENDING    paper ×100                  no
 *   O7     2026-08   South   CANCELLED  toner ×5                    no
 *   O9     2026-08   South   REFUNDED   paper ×80                   no
 *   O8     2026-08   South   FULFILLED  paper ×3                    yes
 *   OB     2026-07   Foreign FULFILLED  foreign ×7                  other tenant
 *
 *   tenant A, all branches      Jun   Jul   Aug   total
 *     Diesel                     50     0    20      70
 *     Paper                      14     6     3      23   (Jun = O1's 10 + O2's 4)
 *     Toner                       2     1     0       3
 *
 *   North alone                 Jun   Jul   Aug   total
 *     Diesel                      0     0    20      20
 *     Paper                      10     4     0      14
 *     Toner                       2     0     0       2
 * ```
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
// Rate limiting needs Redis; the limiter itself is tested on its own.
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))

const { getServerSession } = mockedNextAuth

type Actor = {
  id: string
  role: string
  organizationId?: number | null
  branchId?: number | null
}

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(actor === null ? null : ({ user: actor } as any))
}

type Query = Record<string, string | number | undefined>

async function trend(query: Query = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value))
  }
  const response = await consumptionTrendRoute.GET(
    new NextRequest(`http://localhost/api/v1/analytics/products/consumption-trend?${params.toString()}`),
  )
  return { status: response.status, body: await response.json() }
}

describe.skipIf(!hasTestDatabase)("product consumption trend route", () => {
  let f: ExecutiveAnalyticsFixtures
  let headOffice: Actor
  let neighbourHeadOffice: Actor
  let superAdmin: Actor
  let branchAdmin: Actor
  let southApprover: Actor

  /** The consumed figures for one series, keyed by product name. */
  const consumedByName = (body: any) => Object.fromEntries(
    (body.series ?? []).map((entry: any) => [
      entry.productName,
      entry.points.map((point: any) => point.consumed),
    ]),
  )

  beforeAll(async () => {
    f = await createExecutiveAnalyticsFixtures()
    headOffice = { id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.organizationId }
    neighbourHeadOffice = {
      id: f.neighbourHeadOfficeId,
      role: "HEAD_OFFICE",
      organizationId: f.neighbourOrganizationId,
    }
    superAdmin = { id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null }
    branchAdmin = {
      id: f.branchAdminId,
      role: "BRANCH_ADMIN",
      organizationId: f.organizationId,
      branchId: f.northBranchId,
    }
    southApprover = { id: f.southApproverId, role: "GROUP_USER", organizationId: f.organizationId }
  }, 120_000)

  afterAll(async () => {
    if (f && process.env.INTEGRATION_PRESERVE_FIXTURES !== "1") {
      await destroyExecutiveAnalyticsFixtures(f)
    }
    await closePool()
  }, 120_000)

  beforeEach(() => {
    vi.clearAllMocks()
    signIn(headOffice)
  })

  describe("authentication and authorization", () => {
    it("refuses a caller with no session", async () => {
      signIn(null)
      const { status } = await trend()
      expect(status).toBe(401)
    })

    it("refuses an authenticated caller with no organization", async () => {
      signIn({ id: f.ahmedId, role: "HEAD_OFFICE", organizationId: null })
      const { status, body } = await trend()
      expect(status).toBe(403)
      expect(body.error).toBe("Organization not assigned")
    })

    it("pins a branch-scoped role to its own branch, whatever it asks for", async () => {
      signIn(branchAdmin)
      const asked = await trend({ branchIds: String(f.southBranchId) })
      const plain = await trend()

      expect(asked.status).toBe(200)
      // South's paper and toner never appear: the fence replaced the request.
      expect(consumedByName(asked.body)).toEqual(consumedByName(plain.body))
      expect(consumedByName(asked.body)[f.names.diesel]).toEqual([0, 0, 20])
      expect(consumedByName(asked.body)[f.names.paper]).toEqual([10, 4, 0])
    })

    it("holds a multi-branch approver to its assignment set", async () => {
      signIn(southApprover)
      const { status, body } = await trend()
      expect(status).toBe(200)
      // South alone: O2 (Jun) and O4 (Jul) and O8 (Aug), never North's diesel.
      const consumed = consumedByName(body)
      expect(consumed[f.names.diesel]).toEqual([50, 0, 0])
      expect(consumed[f.names.paper]).toEqual([4, 2, 3])
    })
  })

  describe("tenant isolation", () => {
    it("never returns the neighbour's product to tenant A, even when asked by id", async () => {
      const { status, body } = await trend({ organizationId: String(f.neighbourOrganizationId) })
      expect(status).toBe(200)
      const names = body.series.map((entry: any) => entry.productName)
      expect(names).not.toContain(`Foreign Product ${f.suffix}`)
      expect(names).toContain(f.names.diesel)
    })

    it("shows the neighbour only its own rows", async () => {
      signIn(neighbourHeadOffice)
      const { status, body } = await trend()
      expect(status).toBe(200)
      expect(body.series.map((entry: any) => entry.productName)).toEqual([`Foreign Product ${f.suffix}`])
      expect(body.series[0].totalConsumed).toBe(7)
    })

    it("refuses a branch belonging to another tenant rather than reading it", async () => {
      const { status, body } = await trend({ branchIds: String(f.foreignBranchId) })
      // The requested branch intersects the caller's reach to nothing, which is
      // a refusal and never a silent widening to the whole tenant.
      expect(status).toBe(400)
      expect(body.error).toBe("No permitted branches resolved")
    })

    it("lets a Super Admin read one named tenant and only that one", async () => {
      signIn(superAdmin)
      const { status, body } = await trend({ organizationIds: String(f.neighbourOrganizationId) })
      expect(status).toBe(200)
      expect(body.series.map((entry: any) => entry.productName)).toEqual([`Foreign Product ${f.suffix}`])
    })
  })

  describe("the figures", () => {
    it("works the whole-tenant oracle, month by month", async () => {
      const { status, body } = await trend()
      expect(status).toBe(200)
      expect(body.months.map((month: any) => month.month)).toEqual(["2026-06", "2026-07", "2026-08"])
      expect(body.months.map((month: any) => month.label)).toEqual(["Jun 26", "Jul 26", "Aug 26"])

      expect(body.series.map((entry: any) => entry.productName)).toEqual([
        f.names.diesel, f.names.paper, f.names.toner,
      ])
      expect(consumedByName(body)).toEqual({
        [f.names.diesel]: [50, 0, 20],
        [f.names.paper]: [14, 6, 3],
        [f.names.toner]: [2, 1, 0],
      })
    })

    it("nets an approved refund out of the month the order was raised in", async () => {
      const { body } = await trend()
      const paper = body.series.find((entry: any) => entry.productName === f.names.paper)
      // O3 ordered 6 reams in July and 2 were refunded and approved.
      expect(paper.points[1].ordered).toBe(8)
      expect(paper.points[1].consumed).toBe(6)
      expect(paper.totalOrdered).toBe(25)
      expect(paper.totalConsumed).toBe(23)
    })

    it("counts no pending, cancelled, or refunded order", async () => {
      const { body } = await trend()
      const paper = body.series.find((entry: any) => entry.productName === f.names.paper)
      // O6's 100 reams are PENDING, O7's 5 toners are CANCELLED, and O9's 80
      // reams are REFUNDED: none reaches any figure, ordered or consumed.
      expect(paper.points[2].ordered).toBe(3)
      const toner = body.series.find((entry: any) => entry.productName === f.names.toner)
      expect(toner.points[2].consumed).toBe(0)
    })

    it("narrows to a branch", async () => {
      const { body } = await trend({ branchIds: String(f.northBranchId) })
      expect(consumedByName(body)).toEqual({
        [f.names.diesel]: [0, 0, 20],
        [f.names.paper]: [10, 4, 0],
        [f.names.toner]: [2, 0, 0],
      })
    })

    it("narrows to selected months, and draws a requested month that holds nothing", async () => {
      const { body } = await trend({ years: "2026", months: "6,7,9" })
      expect(body.months.map((month: any) => month.month)).toEqual(["2026-06", "2026-07", "2026-09"])
      expect(consumedByName(body)[f.names.paper]).toEqual([14, 6, 0])
    })

    it("walks a date range month by month", async () => {
      const { body } = await trend({ startDate: "2026-07-01", endDate: "2026-08-31" })
      expect(body.months.map((month: any) => month.month)).toEqual(["2026-07", "2026-08"])
      expect(consumedByName(body)[f.names.paper]).toEqual([6, 3])
      expect(consumedByName(body)[f.names.diesel]).toEqual([0, 20])
    })

    it("narrows to one product", async () => {
      const { body } = await trend({ productIds: String(f.dieselProductId) })
      expect(body.series).toHaveLength(1)
      expect(body.series[0].productName).toBe(f.names.diesel)
    })
  })

  describe("the category filter", () => {
    it("rolls a top-level category up over its subcategories", async () => {
      // Paper hangs off a subcategory of Stationery; Toner hangs off Stationery
      // itself. Selecting the parent must find both, which a literal id match
      // would not.
      const { body } = await trend({ categoryIds: String(f.stationeryCategoryId) })
      expect(body.series.map((entry: any) => entry.productName).toSorted()).toEqual(
        [f.names.paper, f.names.toner].toSorted(),
      )
    })

    it("narrows to a subcategory on its own", async () => {
      const { body } = await trend({ categoryIds: String(f.paperCategoryId) })
      expect(body.series.map((entry: any) => entry.productName)).toEqual([f.names.paper])
    })

    it("excludes what the category does not cover", async () => {
      const { body } = await trend({ categoryIds: String(f.fuelCategoryId) })
      expect(body.series.map((entry: any) => entry.productName)).toEqual([f.names.diesel])
    })
  })

  describe("bounds", () => {
    it("folds everything past the line limit into Other rather than dropping it", async () => {
      const { body } = await trend({ limit: "1" })
      expect(body.series).toHaveLength(2)
      expect(body.series[0].productName).toBe(f.names.diesel)

      const other = body.series[1]
      expect(other.productId).toBe(OTHER_SERIES_ID)
      // Paper 23 + Toner 3, month by month.
      expect(other.points.map((point: any) => point.consumed)).toEqual([16, 7, 3])
      expect(other.totalConsumed).toBe(26)
      expect(body.hasOther).toBe(true)
      expect(body.productsInWindow).toBe(3)
    })

    it("caps a request for more lines than the palette has", async () => {
      const { body } = await trend({ limit: "500" })
      expect(body.limits.series).toBe(CONSUMPTION_TREND_MAX_SERIES)
      // Only three products exist here, so nothing is left to fold.
      expect(body.hasOther).toBe(false)
    })

    it("falls back to the default line count on an unusable limit", async () => {
      const { body } = await trend({ limit: "not-a-number" })
      expect(body.limits.series).toBe(5)
    })

    it("returns no price field of any kind", async () => {
      const { body } = await trend()
      const serialized = JSON.stringify(body.series)
      expect(serialized).not.toMatch(/price/i)
      expect(serialized).not.toMatch(/revenue/i)
      expect(serialized).not.toMatch(/cents/i)
    })
  })
})
