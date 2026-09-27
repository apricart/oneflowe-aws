import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import { branches, budgets, groups } from "@/db/schema"

import * as itemComparisonRoute from "@/app/api/v1/analytics/executive/budget-burn/item-comparison/route"
import * as budgetBurnRoute from "@/app/api/v1/analytics/executive/budget-burn/route"
import * as compareRoute from "@/app/api/v1/analytics/executive/compare/route"
import * as drillDownRoute from "@/app/api/v1/analytics/executive/drill-down/route"
import * as matrixRoute from "@/app/api/v1/analytics/executive/matrix/route"
import * as optionsRoute from "@/app/api/v1/analytics/executive/options/route"
import * as overviewRoute from "@/app/api/v1/analytics/executive/overview/route"
import { closePool, db } from "@/lib/db"

import {
  NO_DATABASE_REASON,
  WINDOW,
  createExecutiveAnalyticsFixtures,
  destroyExecutiveAnalyticsFixtures,
  hasTestDatabase,
  type ExecutiveAnalyticsFixtures,
} from "./helpers/executive-analytics-fixtures"

/**
 * The Product Performance tab, end to end: the four routes it is built from,
 * driven with HTTP-shaped requests against real rows.
 *
 * Only identity is faked. The role gate, the tenant fence, the registry
 * whitelist, the SQL behind every panel, the unit-of-measure rule, the refund
 * netting and the drill-down all run for real — those are the parts that decide
 * what a Head Office user is shown and what they are not.
 *
 * Every expected figure below is worked out by hand from the order history in
 * `helpers/executive-analytics-fixtures.ts`; the comment there is the oracle.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
// Rate limiting needs Redis; the limit itself is unit-tested elsewhere.
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))

const { getServerSession } = mockedNextAuth

type Actor = { id: string; role: string }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(actor === null ? null : ({ user: actor } as any))
}

type Query = Record<string, string | number | undefined>

function request(path: string, query: Query): NextRequest {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value))
  }
  return new NextRequest(`http://localhost/api/v1/analytics/executive/${path}?${params.toString()}`)
}

async function call(handler: (req: NextRequest) => Promise<Response>, path: string, query: Query) {
  const response = await handler(request(path, query))
  return { status: response.status, body: await response.json() }
}

const compare = (query: Query) => call(compareRoute.GET, "compare", { ...WINDOW, ...query })
const options = (query: Query) => call(optionsRoute.GET, "options", { ...WINDOW, ...query })
const drillDown = (query: Query) => call(drillDownRoute.GET, "drill-down", { ...WINDOW, ...query })
const overview = (query: Query) => call(overviewRoute.GET, "overview", { ...WINDOW, ...query })
const matrix = (query: Query) => call(matrixRoute.GET, "matrix", { ...WINDOW, ...query })
const budgetBurn = (query: Query) => call(budgetBurnRoute.GET, "budget-burn", { month: "2026-08", ...query })
const itemComparison = (query: Query) => call(itemComparisonRoute.GET, "budget-burn/item-comparison", { month: "2026-08", ...query })

/** `[label, value]` pairs, in the order the route ranked them. */
const ranked = (body: any): Array<[string, number]> => body.rows.map((row: any) => [row.label, row.value])
const keysOf = (body: any): string[] => body.rows.map((row: any) => row.key)

describe.skipIf(!hasTestDatabase)("Product Performance — executive analytics routes", () => {
  let f: ExecutiveAnalyticsFixtures
  let headOffice: Actor
  let neighbourHeadOffice: Actor
  let superAdmin: Actor
  let southApprover: Actor
  let idleApprover: Actor

  beforeAll(async () => {
    f = await createExecutiveAnalyticsFixtures()
    headOffice = { id: f.headOfficeId, role: "HEAD_OFFICE" }
    neighbourHeadOffice = { id: f.neighbourHeadOfficeId, role: "HEAD_OFFICE" }
    superAdmin = { id: f.superAdminId, role: "SUPER_ADMIN" }
    southApprover = { id: f.southApproverId, role: "GROUP_USER" }
    idleApprover = { id: f.idleApproverId, role: "GROUP_USER" }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    signIn(headOffice)
  })

  afterAll(async () => {
    // The normal suite cleans up its disposable fixtures. A non-destructive
    // verification run can preserve them to comply with environments where
    // database DELETEs are forbidden.
    if (f && process.env.INTEGRATION_PRESERVE_FIXTURES !== "1") {
      await destroyExecutiveAnalyticsFixtures(f)
    }
    await closePool()
  })

  // ── Access control ─────────────────────────────────────────────────────

  describe("access control", () => {
    const everyRoute = [
      ["compare", () => compare({ dimension: "branch", metric: "spend" })],
      ["options", () => options({ dimension: "product" })],
      ["drill-down", () => drillDown({ dimension: "branch", key: String(f.northBranchId), metric: "spend" })],
      ["overview", () => overview({})],
      ["matrix", () => matrix({ rows: "user", columns: "product", metric: "spend" })],
      // Narrower than the rest: its own suite pins that GROUP_USER is refused.
      ["budget-burn", () => budgetBurn({})],
      ["budget-burn item comparison", () => itemComparison({ userId: f.ahmedId, branchIds: f.northBranchId })],
    ] as const

    it.each(everyRoute)("%s refuses an unauthenticated caller with 401", async (_name, run) => {
      signIn(null)
      expect((await run()).status).toBe(401)
    })

    it.each(everyRoute)("%s refuses BRANCH_ADMIN, ORDER_PORTAL and GROUP_ORDER_PORTAL with 403", async (_name, run) => {
      for (const actor of [
        { id: f.branchAdminId, role: "BRANCH_ADMIN" },
        { id: f.ahmedId, role: "ORDER_PORTAL" },
        { id: f.groupRequesterId, role: "GROUP_ORDER_PORTAL" },
      ]) {
        signIn(actor)
        const { status, body } = await run()
        expect(status, actor.role).toBe(403)
        expect(body.rows ?? body.options ?? body.kpis).toBeUndefined()
      }
    })

    it.each(everyRoute)("%s believes the user row, not a session that claims HEAD_OFFICE", async (_name, run) => {
      // A stale or forged JWT says HEAD_OFFICE; the row says BRANCH_ADMIN.
      signIn({ id: f.branchAdminId, role: "HEAD_OFFICE" })
      expect((await run()).status).toBe(403)
    })

    it.each(everyRoute)("%s answers HEAD_OFFICE and SUPER_ADMIN", async (_name, run) => {
      signIn(headOffice)
      expect((await run()).status).toBe(200)
      signIn(superAdmin)
      expect((await run()).status).toBe(200)
    })

    it.each(everyRoute)("%s refuses a group requester whose session claims GROUP_USER", async (_name, run) => {
      signIn({ id: f.groupRequesterId, role: "GROUP_USER" })
      expect((await run()).status).toBe(403)
    })

    it.each(everyRoute)("%s refuses a GROUP_USER with no assignments rather than showing it the tenant", async (_name, run) => {
      signIn(idleApprover)
      const { status, body } = await run()
      expect(status).toBe(403)
      expect(body.error).toBe("No branches in scope")
      expect(body.rows ?? body.options ?? body.kpis).toBeUndefined()
    })

    it("keeps the organization comparison to SUPER_ADMIN, on the server", async () => {
      expect((await compare({ dimension: "organization", metric: "spend" })).status).toBe(403)
      expect((await options({ dimension: "organization" })).status).toBe(403)
      expect((await drillDown({ dimension: "organization", key: String(f.organizationId), metric: "spend" })).status).toBe(403)
    })

    it("refuses a question the registry does not list, rather than guessing", async () => {
      expect((await compare({ dimension: "user", metric: "utilization" })).status).toBe(400)
      expect((await compare({ dimension: "pallet", metric: "spend" })).status).toBe(400)
      expect((await compare({ dimension: "branch", metric: "margin" })).status).toBe(400)
      expect((await compare({ dimension: "branch", metric: "spend", chart: "sankey" })).status).toBe(400)
      expect((await options({ dimension: "pallet" })).status).toBe(400)
      expect((await compare({ dimension: "branch", metric: "spend", startDate: "2026-09-01", endDate: "2026-08-01" })).status).toBe(400)
    })
  })

  // ── Tenant isolation ───────────────────────────────────────────────────

  describe("tenant isolation", () => {
    it("shows Head Office its own branches and nothing of the neighbour's", async () => {
      const { body } = await compare({ dimension: "branch", metric: "spend" })
      expect(ranked(body)).toEqual([[f.names.south, 16500], [f.names.north, 15000]])
    })

    it("ignores an organizationIds pointing at the neighbour", async () => {
      const { body } = await compare({ dimension: "branch", metric: "spend", organizationIds: f.neighbourOrganizationId })
      expect(ranked(body)).toEqual([[f.names.south, 16500], [f.names.north, 15000]])
    })

    it("narrows a foreign branch to nothing instead of reaching it", async () => {
      expect((await compare({ dimension: "branch", metric: "spend", branchIds: f.foreignBranchId })).status).toBe(403)
      expect((await compare({ dimension: "branch", metric: "spend", keys: f.foreignBranchId })).status).toBe(403)
      expect((await drillDown({ dimension: "branch", key: String(f.foreignBranchId), metric: "spend" })).status).toBe(403)
    })

    it("matches nothing for a foreign person or product named directly", async () => {
      const people = await compare({ dimension: "user", metric: "spend", keys: f.foreignUserId })
      expect(people.body.rows).toEqual([])
      const product = await compare({ dimension: "branch", metric: "spend", productIds: f.foreignProductId })
      expect(product.body.rows).toEqual([])
      const lines = await drillDown({ dimension: "user", key: f.foreignUserId, metric: "spend" })
      expect(lines.body.rows).toEqual([])
      expect(lines.body.totals.lineCount).toBe(0)
    })

    it("never names the neighbour's people or products in a picker", async () => {
      const people = await options({ dimension: "user" })
      expect(people.body.options.map((o: any) => o.key)).not.toContain(f.foreignUserId)
      const products = await options({ dimension: "product" })
      expect(products.body.options.map((o: any) => o.key)).not.toContain(String(f.foreignProductId))
      const branches = await options({ dimension: "branch" })
      expect(branches.body.options.map((o: any) => o.key)).toEqual(
        expect.arrayContaining([String(f.northBranchId), String(f.southBranchId)]),
      )
      expect(branches.body.options.map((o: any) => o.key)).not.toContain(String(f.foreignBranchId))
    })

    it("shows the neighbour's Head Office only the neighbour's rows", async () => {
      signIn(neighbourHeadOffice)
      const { body } = await compare({ dimension: "branch", metric: "spend" })
      expect(ranked(body)).toEqual([[f.names.foreign, 7000]])
    })

    it("lets Super Admin see both tenants, or narrow to one", async () => {
      signIn(superAdmin)
      const all = await compare({ dimension: "branch", metric: "spend", limit: 50 })
      expect(ranked(all.body)).toEqual(expect.arrayContaining([
        [f.names.south, 16500], [f.names.north, 15000], [f.names.foreign, 7000],
      ]))
      const narrowed = await compare({ dimension: "branch", metric: "spend", organizationIds: f.neighbourOrganizationId })
      expect(ranked(narrowed.body)).toEqual([[f.names.foreign, 7000]])
      const tenants = await compare({ dimension: "organization", metric: "spend", keys: `${f.organizationId},${f.neighbourOrganizationId}` })
      expect(ranked(tenants.body)).toEqual([[`IT Exec Org ${f.suffix}`, 31500], [`IT Exec Neighbour ${f.suffix}`, 7000]])
    })
  })

  // ── The multi-branch approver ──────────────────────────────────────────

  describe("a Group User sees its assigned branches and nothing else", () => {
    beforeEach(() => signIn(southApprover))

    it("answers every route, fenced to the one assigned branch", async () => {
      const { status, body } = await overview({})
      expect(status).toBe(200)
      expect(body.scope.role).toBe("GROUP_USER")
      expect(body.scope.organizationIds).toEqual([f.organizationId])
      expect(body.scope.branchCount).toBe(1)
      expect(body.scope.branches).toEqual([{ id: f.southBranchId, name: f.names.south }])
      expect(body.kpis.spendCents).toBe(16500)
      expect(body.kpis.orderCount).toBe(3)
      expect(body.quantityUnit).toEqual({ selected: null, conflict: false, available: [] })
      expect(body.branches.map((row: any) => row.branchName)).toEqual([f.names.south])
    })

    it("ranks South alone, and the people, months and products behind South alone", async () => {
      const byBranch = await compare({ dimension: "branch", metric: "spend" })
      expect(ranked(byBranch.body)).toEqual([[f.names.south, 16500]])

      const byRequester = await compare({ dimension: "user", metric: "spend" })
      expect(ranked(byRequester.body)).toEqual([[f.names.sana, 8500], [f.names.group, 8000]])
      expect(keysOf(byRequester.body)).not.toContain(f.ahmedId)

      const byMonth = await compare({ dimension: "month", metric: "spend", chart: "column" })
      expect(ranked(byMonth.body)).toEqual([["2026-06", 7000], ["2026-07", 8000], ["2026-08", 1500]])

      const byProduct = await compare({ dimension: "product", metric: "spend" })
      expect(ranked(byProduct.body)).toEqual([[f.names.paper, 8500], [f.names.diesel, 5000], [f.names.toner, 3000]])
    })

    it("narrows a branch it is not assigned to — in its own tenant or another — to nothing", async () => {
      for (const branchId of [f.northBranchId, f.foreignBranchId]) {
        expect((await compare({ dimension: "branch", metric: "spend", branchIds: branchId })).status).toBe(403)
        expect((await compare({ dimension: "branch", metric: "spend", keys: branchId })).status).toBe(403)
        expect((await drillDown({ dimension: "branch", key: String(branchId), metric: "spend" })).status).toBe(403)
        expect((await overview({ branchIds: branchId })).status).toBe(403)
      }
      // Naming the assigned branch alongside an unassigned one keeps only the
      // assigned one, rather than either failing or widening.
      const mixed = await compare({ dimension: "branch", metric: "spend", branchIds: `${f.southBranchId},${f.northBranchId}` })
      expect(ranked(mixed.body)).toEqual([[f.names.south, 16500]])
    })

    it("ignores an organizationIds pointing anywhere, its own tenant included", async () => {
      const foreign = await compare({ dimension: "branch", metric: "spend", organizationIds: f.neighbourOrganizationId })
      expect(ranked(foreign.body)).toEqual([[f.names.south, 16500]])
      const own = await compare({ dimension: "branch", metric: "spend", organizationIds: f.organizationId })
      expect(ranked(own.body)).toEqual([[f.names.south, 16500]])
    })

    it("matches nothing for an unassigned branch's person named directly", async () => {
      const ahmed = await compare({ dimension: "user", metric: "spend", keys: f.ahmedId })
      expect(ahmed.body.rows).toEqual([])
      const lines = await drillDown({ dimension: "user", key: f.ahmedId, metric: "spend" })
      expect(lines.body.rows).toEqual([])
      expect(lines.body.totals.lineCount).toBe(0)
    })

    it("offers only South's branch, people and products in every picker", async () => {
      const branches = await options({ dimension: "branch" })
      expect(branches.body.options.map((o: any) => o.key)).toEqual([String(f.southBranchId)])

      const people = await options({ dimension: "user" })
      expect(people.body.options.map((o: any) => o.key).sort()).toEqual([f.groupRequesterId, f.sanaId].sort())

      const products = await options({ dimension: "product" })
      expect(products.body.options.map((o: any) => o.key)).not.toContain(String(f.foreignProductId))
      expect(products.body.options.map((o: any) => o.label).sort()).toEqual([f.names.diesel, f.names.paper, f.names.toner].sort())

      // The menu of dimensions is Head Office's: no tenant comparison.
      const menu = await options({})
      expect(menu.body.role).toBe("GROUP_USER")
      expect(menu.body.dimensions.map((d: any) => d.id)).not.toContain("organization")
    })

    it("keeps the organization comparison closed on the server", async () => {
      expect((await compare({ dimension: "organization", metric: "spend" })).status).toBe(403)
      expect((await options({ dimension: "organization" })).status).toBe(403)
      expect((await drillDown({ dimension: "organization", key: String(f.organizationId), metric: "spend" })).status).toBe(403)
    })

    it("lists the lines behind its own bar and reconciles with it", async () => {
      const { body } = await drillDown({ dimension: "branch", key: String(f.southBranchId), metric: "spend" })
      expect(body.totals).toMatchObject({ orderCount: 3, lineCount: 5, valueCents: 16500 })
      for (const row of body.rows) expect(row.branchName).toBe(f.names.south)
      expect(body.rows.map((row: any) => row.status)).not.toContain("CANCELLED")
      // Prices are not redacted for this role: it approves orders at these prices.
      for (const row of body.rows) expect(row.unitPriceCents).toBeGreaterThan(0)
    })

    it("rolls the group view up over its own branches only", async () => {
      // No group in this tenant, so the assigned set is one ungrouped row — of
      // South's money, not the tenant's 31500.
      const { body } = await compare({ dimension: "group", metric: "spend" })
      expect(ranked(body)).toEqual([["No group", 16500]])
    })
  })

  // ── The panels ─────────────────────────────────────────────────────────

  describe("every panel on the screen, under Amount", () => {
    it("By product — ranks products by their own lines", async () => {
      const { body } = await compare({ dimension: "product", metric: "spend", chart: "bar", limit: 12 })
      expect(body.mode).toBe("rank")
      expect(body.format).toBe("currency")
      expect(body.label).toBe("Procurement Value")
      expect(ranked(body)).toEqual([[f.names.paper, 15500], [f.names.toner, 9000], [f.names.diesel, 7000]])
      expect(body.concentrationEligible).toBe(true)
      expect(body.rows[0].share).toBeCloseTo((15500 / 31500) * 100, 5)
      expect(body.rows[2].cumulativeShare).toBeCloseTo(100, 5)
      expect(body.rows[0].orderCount).toBe(5)
    })

    it("By requester — ranks people by the orders they raised", async () => {
      const { body } = await compare({ dimension: "user", metric: "spend", chart: "bar", limit: 12 })
      expect(ranked(body)).toEqual([[f.names.ahmed, 13000], [f.names.group, 10000], [f.names.sana, 8500]])
      expect(keysOf(body)).toEqual([f.ahmedId, f.groupRequesterId, f.sanaId])
    })

    it("By branch — a group requester's order counts for the branch it was placed at", async () => {
      const { body } = await compare({ dimension: "branch", metric: "spend", chart: "bar" })
      expect(ranked(body)).toEqual([[f.names.south, 16500], [f.names.north, 15000]])
      expect(body.rows[0].orderCount).toBe(3)
    })

    it("By month — chronological columns with no prior-period figure", async () => {
      const { body } = await compare({ dimension: "month", metric: "spend", chart: "column" })
      expect(ranked(body)).toEqual([["2026-06", 18000], ["2026-07", 10000], ["2026-08", 3500]])
      for (const row of body.rows) {
        expect(row.previousValue).toBe(0)
        expect(row.changePct).toBeNull()
      }
    })

    it("Requesters over months — one line per person, zero where they bought nothing", async () => {
      const { body } = await compare({ dimension: "user", metric: "spend", chart: "line", limit: 6 })
      expect(body.mode).toBe("series")
      expect(body.periods).toEqual(["2026-06", "2026-07", "2026-08"])
      const byLabel = Object.fromEntries(body.series.map((s: any) => [s.label, s.points.map((p: any) => p.value)]))
      expect(byLabel).toEqual({
        [f.names.ahmed]: [11000, 2000, 0],
        [f.names.group]: [0, 8000, 2000],
        [f.names.sana]: [7000, 0, 1500],
      })
      // Lines are drawn in ranked order, so the legend reads largest first.
      expect(body.series.map((s: any) => s.label)).toEqual([f.names.ahmed, f.names.group, f.names.sana])
    })

    it("Products over months — one line per product", async () => {
      const { body } = await compare({ dimension: "product", metric: "spend", chart: "line", limit: 6 })
      const byLabel = Object.fromEntries(body.series.map((s: any) => [s.label, s.points.map((p: any) => p.value)]))
      expect(byLabel).toEqual({
        [f.names.paper]: [7000, 7000, 1500],
        [f.names.toner]: [6000, 3000, 0],
        [f.names.diesel]: [5000, 0, 2000],
      })
    })

    it("Day-by-day — one point per day the focused product was bought", async () => {
      const { body } = await compare({ dimension: "day", metric: "spend", chart: "line", productIds: f.paperProductId })
      expect(body.mode).toBe("series")
      expect(body.periods).toEqual(["2026-06-10", "2026-06-20", "2026-07-05", "2026-07-15", "2026-08-20"])
      expect(body.series).toHaveLength(1)
      expect(body.series[0].points.map((p: any) => p.value)).toEqual([5000, 2000, 2000, 5000, 1500])
    })

    it("By group — a tenant with no groups reports one ungrouped row rather than nothing", async () => {
      const { body } = await compare({ dimension: "group", metric: "spend" })
      expect(ranked(body)).toEqual([["No group", 31500]])
    })

    it("By category — subcategory purchases roll up to the parent", async () => {
      const { body } = await compare({ dimension: "category", metric: "spend" })
      expect(ranked(body)).toEqual([[`Stationery ${f.suffix}`, 24500], [`Fuel ${f.suffix}`, 7000]])
    })

    it("compares each bar against the equally long window before it", async () => {
      // July–August (62 days) is compared with the 62 days ending 30 June,
      // which holds both June orders.
      const { body } = await compare({ dimension: "branch", metric: "spend", startDate: "2026-07-01", endDate: "2026-08-31" })
      const south = body.rows.find((row: any) => row.label === f.names.south)
      const north = body.rows.find((row: any) => row.label === f.names.north)
      expect(south.value).toBe(9500)
      expect(south.previousValue).toBe(7000)
      expect(south.changePct).toBeCloseTo(((9500 - 7000) / 7000) * 100, 5)
      expect(north.value).toBe(4000)
      expect(north.previousValue).toBe(11000)
      expect(north.changePct).toBeCloseTo(((4000 - 11000) / 11000) * 100, 5)
    })

    it("bounds the row count it returns", async () => {
      expect((await compare({ dimension: "product", metric: "spend", limit: 2 })).body.rows).toHaveLength(2)
      // A limit past the ceiling is clamped, not honoured.
      expect((await compare({ dimension: "product", metric: "spend", limit: 100000 })).status).toBe(200)
    })
  })

  describe("Product Performance Amount as Consumed", () => {
    const consumedCompare = (query: Query) => compare({ ...query, statuses: "consumed" })

    it("includes pending and excludes cancelled/refunded orders across every panel", async () => {
      const product = await consumedCompare({ dimension: "product", metric: "spend", chart: "column" })
      expect(product.body.label).toBe("Consumed")
      expect(product.body.formula).toContain("including pending")
      expect(ranked(product.body)).toEqual([
        [f.names.paper, 65_500], [f.names.toner, 9_000], [f.names.diesel, 7_000],
      ])
      expect(product.body.rows[0].orderCount).toBe(6)
      expect(product.body.rows[0].share).toBeCloseTo((65_500 / 81_500) * 100, 5)

      const requester = await consumedCompare({ dimension: "user", metric: "spend", chart: "column" })
      expect(ranked(requester.body)).toEqual([
        [f.names.ahmed, 63_000], [f.names.group, 10_000], [f.names.sana, 8_500],
      ])

      const branch = await consumedCompare({ dimension: "branch", metric: "spend", chart: "column" })
      expect(ranked(branch.body)).toEqual([[f.names.north, 65_000], [f.names.south, 16_500]])

      const month = await consumedCompare({ dimension: "month", metric: "spend", chart: "column" })
      expect(ranked(month.body)).toEqual([["2026-06", 18_000], ["2026-07", 10_000], ["2026-08", 53_500]])

      const requesterTrend = await consumedCompare({ dimension: "user", metric: "spend", chart: "line" })
      const requesterSeries = Object.fromEntries(
        requesterTrend.body.series.map((series: any) => [series.label, series.points.map((point: any) => point.value)]),
      )
      expect(requesterSeries[f.names.ahmed]).toEqual([11_000, 2_000, 50_000])

      const productTrend = await consumedCompare({ dimension: "product", metric: "spend", chart: "line" })
      const productSeries = Object.fromEntries(
        productTrend.body.series.map((series: any) => [series.label, series.points.map((point: any) => point.value)]),
      )
      expect(productSeries[f.names.paper]).toEqual([7_000, 7_000, 51_500])

      const day = await consumedCompare({
        dimension: "day", metric: "spend", chart: "line", productIds: f.paperProductId,
      })
      expect(day.body.series[0].label).toBe("Consumed")
      expect(day.body.periods).toEqual([
        "2026-06-10", "2026-06-20", "2026-07-05", "2026-07-15", "2026-08-12", "2026-08-20",
      ])
      expect(day.body.series[0].points.map((point: any) => point.value))
        .toEqual([5_000, 2_000, 2_000, 5_000, 50_000, 1_500])

      const category = await consumedCompare({ dimension: "category", metric: "spend", chart: "column" })
      expect(ranked(category.body)).toEqual([
        [`Stationery ${f.suffix}`, 74_500], [`Fuel ${f.suffix}`, 7_000],
      ])
    })

    it("keeps branch, category, requester, and exact date boundaries on the consumed population", async () => {
      const beforePending = await consumedCompare({
        dimension: "product", metric: "spend", branchIds: f.northBranchId,
        startDate: "2026-08-01", endDate: "2026-08-11",
      })
      expect(ranked(beforePending.body)).toEqual([[f.names.diesel, 2_000]])

      const throughPending = await consumedCompare({
        dimension: "product", metric: "spend", branchIds: f.northBranchId,
        startDate: "2026-08-01", endDate: "2026-08-12",
      })
      expect(ranked(throughPending.body)).toEqual([[f.names.paper, 50_000], [f.names.diesel, 2_000]])

      const filtered = await consumedCompare({
        dimension: "month",
        metric: "spend",
        categoryIds: f.stationeryCategoryId,
        userIds: f.ahmedId,
        branchIds: f.northBranchId,
      })
      expect(ranked(filtered.body)).toEqual([["2026-06", 11_000], ["2026-07", 2_000], ["2026-08", 50_000]])
    })

    it("keeps the requester-product grid and its drill-down on the same consumed total", async () => {
      const grid = await matrix({ rows: "user", columns: "product", metric: "spend", statuses: "consumed" })
      expect(grid.body.label).toBe("Consumed")
      expect(grid.body.rows.map((row: any) => [row.label, row.total])).toEqual([
        [f.names.ahmed, 63_000], [f.names.group, 10_000], [f.names.sana, 8_500],
      ])
      const ahmedRow = grid.body.rows.find((row: any) => row.label === f.names.ahmed)
      const paperColumn = grid.body.columns.find((column: any) => column.label === f.names.paper)
      expect(grid.body.cells.find((cell: any) => cell.row === ahmedRow.key && cell.column === paperColumn.key)?.value)
        .toBe(57_000)

      const detail = await drillDown({
        dimension: "user",
        key: f.ahmedId,
        metric: "spend",
        productIds: f.paperProductId,
        statuses: "consumed",
      })
      expect(detail.body.metricLabel).toBe("Consumed")
      expect(detail.body.totals).toMatchObject({ valueCents: 57_000, orderCount: 3, lineCount: 3 })
      expect(detail.body.rows.map((row: any) => row.status)).toContain("PENDING")
      expect(detail.body.rows.map((row: any) => row.status)).not.toContain("REFUNDED")
    })

    it("rejects a raw status name instead of treating it as a query predicate", async () => {
      expect((await compare({ dimension: "branch", metric: "spend", statuses: "PENDING" })).status).toBe(400)
    })
  })

  // ── Counting rules ─────────────────────────────────────────────────────

  describe("what is counted", () => {
    it("excludes pending and cancelled orders from every figure", async () => {
      // August holds a 50000 PENDING and a 15000 CANCELLED order; neither counts.
      const { body } = await compare({ dimension: "month", metric: "spend", chart: "column" })
      expect(body.rows.find((row: any) => row.label === "2026-08").value).toBe(3500)
    })

    it("deducts an approved refund from money and from quantity", async () => {
      const money = await compare({ dimension: "user", metric: "spend" })
      expect(money.body.rows.find((row: any) => row.label === f.names.ahmed).value).toBe(13000)
      const units = await compare({ dimension: "user", metric: "quantity", productIds: f.paperProductId })
      // Ahmed: 10 + (6 − 2 refunded) = 14 reams.
      expect(units.body.rows.find((row: any) => row.label === f.names.ahmed).value).toBe(14)
    })

    it("counts whole orders with no focus, and only the focused product's lines with one", async () => {
      const whole = await compare({ dimension: "branch", metric: "spend" })
      expect(ranked(whole.body)).toEqual([[f.names.south, 16500], [f.names.north, 15000]])

      const focused = await compare({ dimension: "branch", metric: "spend", productIds: f.paperProductId })
      expect(ranked(focused.body)).toEqual([[f.names.south, 8500], [f.names.north, 7000]])
      // Money is addable across units, so unit labels neither block nor narrow Amount.
      expect(focused.body.blocked).toBeUndefined()
      expect(focused.body.quantityUnit).toEqual({ selected: null, conflict: false, available: [] })
    })

    it("narrows every panel to the selected requesters", async () => {
      const branches = await compare({ dimension: "branch", metric: "spend", userIds: f.ahmedId })
      expect(ranked(branches.body)).toEqual([[f.names.north, 13000]])
      const months = await compare({ dimension: "month", metric: "spend", chart: "column", userIds: f.ahmedId })
      expect(ranked(months.body)).toEqual([["2026-06", 11000], ["2026-07", 2000]])
      const people = await compare({ dimension: "user", metric: "spend", keys: `${f.sanaId},${f.groupRequesterId}` })
      expect(ranked(people.body)).toEqual([[f.names.group, 10000], [f.names.sana, 8500]])
    })

    it("honours the branch and category filters, categories through their subcategories", async () => {
      const north = await compare({ dimension: "user", metric: "spend", branchIds: f.northBranchId })
      expect(ranked(north.body)).toEqual([[f.names.ahmed, 13000], [f.names.group, 2000]])

      // Stationery includes its Paper subcategory, so both Paper and Toner
      // lines count — line by line, since a category is a line-level filter.
      const stationery = await compare({ dimension: "branch", metric: "spend", categoryIds: f.stationeryCategoryId })
      expect(ranked(stationery.body)).toEqual([[f.names.north, 13000], [f.names.south, 11500]])
    })
  })

  describe("Quantity as ordered item counts", () => {
    it("compares raw quantities across different product unit labels", async () => {
      const { status, body } = await compare({ dimension: "branch", metric: "quantity", productIds: f.paperProductId })
      expect(status).toBe(200)
      expect(body.blocked).toBeUndefined()
      expect(body.quantityUnit).toEqual({ selected: null, conflict: false, available: [] })
      expect(ranked(body)).toEqual([[f.names.north, 14], [f.names.south, 9]])
    })

    it("adds each ordered count without converting kg, litres, pieces, boxes, or reams", async () => {
      const { body } = await compare({ dimension: "branch", metric: "quantity" })
      expect(body.blocked).toBeUndefined()
      expect(ranked(body)).toEqual([[f.names.south, 60], [f.names.north, 36]])
    })

    it("ignores the retired unit parameter for quantity comparisons", async () => {
      const result = await compare({ dimension: "branch", metric: "quantity", productIds: f.paperProductId, unit: "Ream" })
      expect(result.body.format).toBe("quantity")
      expect(result.body.quantityUnit).toEqual({ selected: null, conflict: false, available: [] })
      expect(ranked(result.body)).toEqual([[f.names.north, 14], [f.names.south, 9]])
    })

    it("does not attach a unit even when the selected product has only one", async () => {
      const { body } = await compare({ dimension: "branch", metric: "quantity", productIds: f.dieselProductId })
      expect(body.blocked).toBeUndefined()
      expect(body.quantityUnit).toEqual({ selected: null, conflict: false, available: [] })
      expect(ranked(body)).toEqual([[f.names.south, 50], [f.names.north, 20]])
    })

    it("ignores the retired unit parameter for money at both order and line grain", async () => {
      const whole = await compare({ dimension: "branch", metric: "spend", unit: "Ream" })
      expect(ranked(whole.body)).toEqual([[f.names.south, 16500], [f.names.north, 15000]])
      expect(whole.body.quantityUnit.selected).toBeNull()

      const focused = await compare({ dimension: "branch", metric: "spend", productIds: f.paperProductId, unit: "Ream" })
      expect(ranked(focused.body)).toEqual([[f.names.south, 8500], [f.names.north, 7000]])
      expect(focused.body.quantityUnit.selected).toBeNull()
    })

    it("ignores an out-of-scope unit for quantity instead of filtering item counts", async () => {
      const { body } = await compare({ dimension: "branch", metric: "quantity", productIds: f.dieselProductId, unit: "Gallon" })
      expect(body.quantityUnit.selected).toBeNull()
      expect(ranked(body)).toEqual([[f.names.south, 50], [f.names.north, 20]])
    })
  })

  // ── Pickers ────────────────────────────────────────────────────────────

  describe("the Product and Requesters pickers", () => {
    it("lists a product once, naming every unit it was sold in", async () => {
      const { body } = await options({ dimension: "product" })
      expect(body.selectable).toBe(true)
      const keys = body.options.map((o: any) => o.key)
      expect(new Set(keys).size).toBe(keys.length)
      expect(body.options[0]).toEqual({ key: String(f.paperProductId), label: f.names.paper, hint: "per Box, Ream · 5 orders" })
      expect(body.options.map((o: any) => o.label).sort()).toEqual([f.names.diesel, f.names.paper, f.names.toner].sort())
    })

    it("lists a person once, naming every branch they ordered for, counting every order", async () => {
      const { body } = await options({ dimension: "user" })
      const byKey = Object.fromEntries(body.options.map((o: any) => [o.key, o]))
      expect(Object.keys(byKey)).toHaveLength(3)
      expect(byKey[f.groupRequesterId].hint).toBe(`${f.names.north}, ${f.names.south} · 2 orders`)
      // Pending, cancelled, and refunded orders count here: the picker lists
      // all activity, not only orders that contribute to a value metric.
      expect(byKey[f.ahmedId].hint).toBe(`${f.names.north} · 3 orders`)
      expect(byKey[f.sanaId].hint).toBe(`${f.names.south} · 4 orders`)
    })

    it("narrows each picker by the other's selection, never by its own", async () => {
      const products = await options({ dimension: "product", userIds: f.sanaId })
      expect(products.body.options.map((o: any) => o.label).sort()).toEqual([f.names.diesel, f.names.paper].sort())

      const people = await options({ dimension: "user", productIds: f.dieselProductId })
      expect(people.body.options.map((o: any) => o.key).sort()).toEqual([f.groupRequesterId, f.sanaId].sort())

      // Its own selection is ignored, so a list can always be changed.
      const own = await options({ dimension: "product", productIds: f.dieselProductId })
      expect(own.body.options).toHaveLength(3)
    })

    it("lists what exists regardless of the unit being measured", async () => {
      const { body } = await options({ dimension: "user", unit: "Box" })
      expect(body.options).toHaveLength(3)
    })

    it("offers the branch list from the tenant, activity or not, until a product is in focus", async () => {
      const all = await options({ dimension: "branch" })
      expect(all.body.options.map((o: any) => o.label)).toEqual(expect.arrayContaining([f.names.north, f.names.south]))
      const buyers = await options({ dimension: "branch", productIds: f.dieselProductId })
      expect(buyers.body.options.map((o: any) => o.label).sort()).toEqual([f.names.north, f.names.south].sort())
      expect(buyers.body.options.find((o: any) => o.label === f.names.south).hint).toBe("1 order")
    })

    it("hands out the dimension menu for the role, and nothing to pick for a time axis", async () => {
      const menu = await options({})
      expect(menu.body.dimensions.map((d: any) => d.id)).not.toContain("organization")
      signIn(superAdmin)
      const adminMenu = await options({})
      expect(adminMenu.body.dimensions.map((d: any) => d.id)).toContain("organization")
      const months = await options({ dimension: "month" })
      expect(months.body).toEqual({ dimension: "month", options: [], selectable: false })
    })
  })

  // ── Drill-down ─────────────────────────────────────────────────────────

  describe("the drill-down behind a bar", () => {
    it("lists the lines behind a branch bar and reconciles with it", async () => {
      const bar = await compare({ dimension: "branch", metric: "spend" })
      const north = bar.body.rows.find((row: any) => row.label === f.names.north)

      const { body } = await drillDown({ dimension: "branch", key: String(f.northBranchId), metric: "spend" })
      expect(body.dimensionLabel).toBe("Branch")
      expect(body.totals).toEqual({
        orderCount: 3,
        lineCount: 4,
        valueCents: north.value,
        quantity: 36,
        // Largest first, the order the totals strip prints them in.
        quantityByUnit: [{ unit: "Litre", quantity: 20 }, { unit: "Ream", quantity: 14 }, { unit: "Piece", quantity: 2 }],
      })
      expect(body.rows).toHaveLength(4)
      expect(body.hasMore).toBe(false)
      for (const row of body.rows) expect(row.branchName).toBe(f.names.north)
      // Newest first by default; the pending August order is not among them.
      expect(body.rows[0].productName).toBe(f.names.diesel)
      expect(body.rows.map((row: any) => row.status)).not.toContain("PENDING")
      // Every row has its own identity.
      const lineIds = body.rows.map((row: any) => row.lineId)
      expect(new Set(lineIds).size).toBe(4)
      expect(f.lineIds).toEqual(expect.arrayContaining(lineIds))
    })

    it("carries the refund into the line it was against", async () => {
      const { body } = await drillDown({ dimension: "user", key: f.ahmedId, metric: "spend", period: "2026-07" })
      expect(body.rows).toHaveLength(1)
      expect(body.rows[0]).toMatchObject({ productName: f.names.paper, quantity: 4, unitPriceCents: 500, valueCents: 2000, status: "PARTIAL" })
    })

    it("clips a month click to that month, inside the selected range", async () => {
      const { body } = await drillDown({ dimension: "month", key: "2026-07", metric: "spend" })
      expect(body.totals.valueCents).toBe(10000)
      expect(body.totals.orderCount).toBe(2)
      expect(body.totals.lineCount).toBe(3)
      expect(new Date(body.period.startDate).getUTCMonth()).toBe(5) // 30 June 19:00Z is 1 July in Karachi
      expect(new Date(body.period.endDate) < new Date("2026-08-01T00:00:00Z")).toBe(true)

      // A day click narrows to the day.
      const day = await drillDown({ dimension: "day", key: "2026-08-20", metric: "spend" })
      expect(day.body.rows.map((row: any) => row.tid)).toEqual([`ITE-${f.suffix}-O8-8`])
    })

    it("narrows a point on a trend to the person and the month", async () => {
      const { body } = await drillDown({ dimension: "user", key: f.ahmedId, metric: "spend", period: "2026-06" })
      expect(body.totals).toMatchObject({ orderCount: 1, lineCount: 2, valueCents: 11000 })
      for (const row of body.rows) expect(row.requesterName).toBe(f.names.ahmed)
    })

    it("reconciles a quantity bar across unit labels and ignores the retired unit parameter", async () => {
      const chosen = await drillDown({ dimension: "product", key: String(f.paperProductId), metric: "quantity", unit: "Ream" })
      expect(chosen.body.totals.quantity).toBe(23)
      expect(chosen.body.totals.quantityByUnit).toEqual([{ unit: "Ream", quantity: 21 }, { unit: "Box", quantity: 2 }])
      expect(chosen.body.totals.lineCount).toBe(5)

      const mixed = await drillDown({ dimension: "product", key: String(f.paperProductId), metric: "quantity" })
      expect(mixed.body.totals.lineCount).toBe(5)
      expect(mixed.body.totals.quantityByUnit).toEqual([{ unit: "Ream", quantity: 21 }, { unit: "Box", quantity: 2 }])
      expect(mixed.body.totals.valueCents).toBe(15500)
      expect(chosen.body.totals).toEqual(mixed.body.totals)
    })

    it("sorts only by an allowlisted column, and pages deterministically", async () => {
      const dearest = await drillDown({ dimension: "branch", key: String(f.northBranchId), metric: "spend", sort: "unitPrice", direction: "desc" })
      expect(dearest.body.rows[0].productName).toBe(f.names.toner)
      const most = await drillDown({ dimension: "branch", key: String(f.northBranchId), metric: "spend", sort: "quantity", direction: "desc" })
      expect(most.body.rows[0]).toMatchObject({ productName: f.names.diesel, quantity: 20 })
      // An unknown sort key falls back to the default rather than reaching SQL.
      expect((await drillDown({ dimension: "branch", key: String(f.northBranchId), metric: "spend", sort: "1; drop table" })).status).toBe(200)

      const first = await drillDown({ dimension: "branch", key: String(f.northBranchId), metric: "spend", limit: 2 })
      expect(first.body.rows).toHaveLength(2)
      expect(first.body.hasMore).toBe(true)
      expect(first.body.totals.lineCount).toBe(4)
      const second = await drillDown({ dimension: "branch", key: String(f.northBranchId), metric: "spend", limit: 2, offset: 2 })
      expect(second.body.rows).toHaveLength(2)
      expect(second.body.hasMore).toBe(false)
      const seen = [...first.body.rows, ...second.body.rows].map((row: any) => row.lineId)
      expect(new Set(seen).size).toBe(4)
    })

    it("refuses a malformed or out-of-range bucket", async () => {
      expect((await drillDown({ dimension: "month", key: "2026-13", metric: "spend" })).status).toBe(400)
      expect((await drillDown({ dimension: "month", key: "2026-03", metric: "spend" })).status).toBe(400)
      expect((await drillDown({ dimension: "user", key: f.ahmedId, metric: "spend", period: "not-a-period" })).status).toBe(400)
      expect((await drillDown({ dimension: "branch", key: "../../etc", metric: "spend" })).status).toBe(400)
    })
  })

  // ── Overview without the retired unit filter ───────────────────────────

  describe("the overview without a unit filter", () => {
    it("does not expose or apply unit selection", async () => {
      const mixed = await overview({})
      expect(mixed.body.quantityUnit).toEqual({ selected: null, conflict: false, available: [] })
      expect(mixed.body.scope.branches.map((b: any) => b.name).sort()).toEqual([f.names.north, f.names.south].sort())

      const chosen = await overview({ unit: "Ream" })
      expect(chosen.body.quantityUnit).toEqual({ selected: null, conflict: false, available: [] })
      expect(chosen.body.categories).toEqual(mixed.body.categories)
    })
  })

  // ── The group filter ───────────────────────────────────────────────────

  /**
   * A group is a set of branches, and the scope resolver turns a `groupIds`
   * request into one. These put North into a group of its own — and Foreign
   * into one of tenant B's — for the duration of the block, and give South a
   * budget so the budget side of the answer can be checked as well as the
   * order side: an order-level filter would have left South's allocation in
   * the KPI total while removing South's spend from it.
   */
  // ── Requester × product ────────────────────────────────────────────────

  describe("the requester × product grid", () => {
    /** `{ "<row label>|<column label>": value }` for every cell the route returned. */
    const cellsOf = (body: any): Record<string, number> => {
      const rowLabel = new Map(body.rows.map((row: any) => [row.key, row.label]))
      const columnLabel = new Map(body.columns.map((column: any) => [column.key, column.label]))
      return Object.fromEntries(
        body.cells.map((cell: any) => [`${rowLabel.get(cell.row)}|${columnLabel.get(cell.column)}`, cell.value]),
      )
    }
    const margins = (entities: any[]): Array<[string, number]> => entities.map((entity) => [entity.label, entity.total])

    it("gives one figure per (requester, product) pair, never combined, with margins that are the panels' own bars", async () => {
      const { status, body } = await matrix({ rows: "user", columns: "product", metric: "spend" })
      expect(status).toBe(200)
      expect(body).toMatchObject({
        rowDimension: "user", columnDimension: "product", rowLabel: "Requester", columnLabel: "Product",
        metric: "spend", grain: "line", format: "currency", limits: { rows: 8, columns: 8 },
      })
      expect(body.blocked).toBeUndefined()

      // The oracle in the fixture comment, cell by cell.
      expect(cellsOf(body)).toEqual({
        [`${f.names.ahmed}|${f.names.paper}`]: 7000,
        [`${f.names.ahmed}|${f.names.toner}`]: 6000,
        [`${f.names.group}|${f.names.paper}`]: 5000,
        [`${f.names.group}|${f.names.toner}`]: 3000,
        [`${f.names.group}|${f.names.diesel}`]: 2000,
        [`${f.names.sana}|${f.names.paper}`]: 3500,
        [`${f.names.sana}|${f.names.diesel}`]: 5000,
      })
      // No pair that never happened is invented as a zero cell.
      expect(body.cells).toHaveLength(7)

      // The margins are exactly "By requester" and "By product", ranked.
      expect(margins(body.rows)).toEqual([[f.names.ahmed, 13000], [f.names.group, 10000], [f.names.sana, 8500]])
      expect(margins(body.columns)).toEqual([[f.names.paper, 15500], [f.names.toner, 9000], [f.names.diesel, 7000]])
      expect(ranked((await compare({ dimension: "user", metric: "spend" })).body)).toEqual(margins(body.rows))
      expect(ranked((await compare({ dimension: "product", metric: "spend" })).body)).toEqual(margins(body.columns))

      // And every cell carries what it was made of.
      const ahmedPaper = body.cells.find((cell: any) => cell.row === f.ahmedId && cell.column === String(f.paperProductId))
      expect(ahmedPaper).toMatchObject({ value: 7000, spendCents: 7000, quantity: 14, orderCount: 2 })
    })

    it("narrows to the chosen requesters and products, exactly as the panels beside it do", async () => {
      const { body } = await matrix({
        rows: "user", columns: "product", metric: "spend",
        userIds: [f.ahmedId, f.sanaId].join(","),
        productIds: [f.paperProductId, f.dieselProductId].join(","),
      })
      expect(cellsOf(body)).toEqual({
        [`${f.names.ahmed}|${f.names.paper}`]: 7000,
        [`${f.names.sana}|${f.names.paper}`]: 3500,
        [`${f.names.sana}|${f.names.diesel}`]: 5000,
      })
      // The margins narrow with the grid: Ahmed's row is his Paper alone now.
      expect(margins(body.rows)).toEqual([[f.names.sana, 8500], [f.names.ahmed, 7000]])
      expect(margins(body.columns)).toEqual([[f.names.paper, 10500], [f.names.diesel, 5000]])
    })

    it("lays the grid the other way round, and by other pairs of axes", async () => {
      const transposed = await matrix({ rows: "product", columns: "user", metric: "spend" })
      expect(margins(transposed.body.rows)).toEqual([[f.names.paper, 15500], [f.names.toner, 9000], [f.names.diesel, 7000]])
      expect(cellsOf(transposed.body)[`${f.names.paper}|${f.names.ahmed}`]).toBe(7000)

      // Requester against branch in money stays at order grain: whole orders.
      const byBranch = await matrix({ rows: "user", columns: "branch", metric: "spend" })
      expect(byBranch.body.grain).toBe("order")
      expect(cellsOf(byBranch.body)).toEqual({
        [`${f.names.ahmed}|${f.names.north}`]: 13000,
        [`${f.names.group}|${f.names.north}`]: 2000,
        [`${f.names.group}|${f.names.south}`]: 8000,
        [`${f.names.sana}|${f.names.south}`]: 8500,
      })

      // Category against branch rolls the Paper subcategory up to Stationery.
      const byCategory = await matrix({ rows: "category", columns: "branch", metric: "spend" })
      expect(cellsOf(byCategory.body)).toEqual({
        [`Stationery ${f.suffix}|${f.names.north}`]: 13000,
        [`Stationery ${f.suffix}|${f.names.south}`]: 11500,
        [`Fuel ${f.suffix}|${f.names.north}`]: 2000,
        [`Fuel ${f.suffix}|${f.names.south}`]: 5000,
      })
    })

    it("counts orders per pair without pretending they add up to the row", async () => {
      const { body } = await matrix({ rows: "user", columns: "product", metric: "orders" })
      // O1 holds Paper and Toner: one order in each cell, one order in the row.
      const cells = cellsOf(body)
      expect(cells[`${f.names.ahmed}|${f.names.paper}`]).toBe(2)
      expect(cells[`${f.names.ahmed}|${f.names.toner}`]).toBe(1)
      expect(margins(body.rows).find(([label]) => label === f.names.ahmed)?.[1]).toBe(2)
    })

    it("compares every requester's raw item count regardless of the product unit label", async () => {
      const result = await matrix({ rows: "user", columns: "product", metric: "quantity", productIds: f.paperProductId })
      expect(result.status).toBe(200)
      expect(result.body.blocked).toBeUndefined()
      expect(result.body.quantityUnit).toEqual({ selected: null, conflict: false, available: [] })
      expect(cellsOf(result.body)).toEqual({
        [`${f.names.ahmed}|${f.names.paper}`]: 14,
        [`${f.names.sana}|${f.names.paper}`]: 7,
        [`${f.names.group}|${f.names.paper}`]: 2,
      })
      expect(margins(result.body.rows)).toEqual([[f.names.ahmed, 14], [f.names.sana, 7], [f.names.group, 2]])

      const legacyUnit = await matrix({ rows: "user", columns: "product", metric: "quantity", productIds: f.paperProductId, unit: "Ream" })
      expect(cellsOf(legacyUnit.body)).toEqual(cellsOf(result.body))
    })

    it("bounds each axis to the limit, keeping the largest", async () => {
      const { body } = await matrix({ rows: "user", columns: "product", metric: "spend", limit: 1 })
      expect(body.limits).toEqual({ rows: 1, columns: 1 })
      expect(margins(body.rows)).toEqual([[f.names.ahmed, 13000]])
      expect(margins(body.columns)).toEqual([[f.names.paper, 15500]])
      expect(cellsOf(body)).toEqual({ [`${f.names.ahmed}|${f.names.paper}`]: 7000 })
      expect((await matrix({ rows: "user", columns: "product", metric: "spend", limit: 9999 })).body.limits.rows).toBe(12)
    })

    it("refuses a grid the registry does not list, rather than guessing", async () => {
      for (const query of [
        { rows: "user", columns: "user", metric: "spend" },
        { rows: "user", columns: "product", metric: "utilization" },
        { rows: "user", columns: "product", metric: "avgOrderValue" },
        { rows: "month", columns: "product", metric: "spend" },
        { rows: "group", columns: "product", metric: "spend" },
        { rows: "user", columns: "organization", metric: "spend" },
        { rows: "user", columns: "product" },
        { columns: "product", metric: "spend" },
      ]) {
        const { status, body } = await matrix(query)
        expect(status, JSON.stringify(query)).toBe(400)
        expect(body.cells).toBeUndefined()
      }
    })

    it("shows the neighbour's Head Office its own pair and nothing of tenant A's", async () => {
      signIn(neighbourHeadOffice)
      const { body } = await matrix({ rows: "user", columns: "product", metric: "spend" })
      expect(margins(body.rows)).toEqual([[`Foreign User ${f.suffix}`, 7000]])
      expect(margins(body.columns)).toEqual([[`Foreign Product ${f.suffix}`, 7000]])
      expect(body.cells).toHaveLength(1)

      // Naming tenant A's people and products from tenant B matches nothing.
      const reaching = await matrix({
        rows: "user", columns: "product", metric: "spend",
        userIds: f.ahmedId, productIds: f.paperProductId,
      })
      expect(reaching.status).toBe(200)
      expect(reaching.body.rows).toEqual([])
      expect(reaching.body.cells).toEqual([])
      // And so does its organizationIds, which is discarded for Head Office.
      expect((await matrix({ rows: "user", columns: "product", metric: "spend", organizationIds: f.organizationId })).body.cells).toHaveLength(1)
    })

    it("shows the South approver only South's pairs, and nothing for North's requester named directly", async () => {
      signIn(southApprover)
      const { body } = await matrix({ rows: "user", columns: "product", metric: "spend" })
      expect(cellsOf(body)).toEqual({
        [`${f.names.sana}|${f.names.paper}`]: 3500,
        [`${f.names.sana}|${f.names.diesel}`]: 5000,
        [`${f.names.group}|${f.names.paper}`]: 5000,
        [`${f.names.group}|${f.names.toner}`]: 3000,
      })
      expect(margins(body.rows)).toEqual([[f.names.sana, 8500], [f.names.group, 8000]])

      expect((await matrix({ rows: "user", columns: "product", metric: "spend", userIds: f.ahmedId })).body.cells).toEqual([])
      expect((await matrix({ rows: "user", columns: "product", metric: "spend", branchIds: f.northBranchId })).status).toBe(403)
    })

    it("lets Super Admin see both tenants in one grid, or narrow to one", async () => {
      signIn(superAdmin)
      const everyone = await matrix({ rows: "user", columns: "product", metric: "spend" })
      expect(margins(everyone.body.rows)).toContainEqual([`Foreign User ${f.suffix}`, 7000])
      expect(margins(everyone.body.rows)).toContainEqual([f.names.ahmed, 13000])

      const tenantA = await matrix({ rows: "user", columns: "product", metric: "spend", organizationIds: f.organizationId })
      expect(margins(tenantA.body.rows)).toEqual([[f.names.ahmed, 13000], [f.names.group, 10000], [f.names.sana, 8500]])
    })

    it("opens the order lines behind one cell, and they reconcile with it", async () => {
      // The screen asks for the cell (Ahmed, Paper) as "requester Ahmed,
      // narrowed to Paper" — the same drill-down every other panel uses.
      const { body } = await drillDown({ dimension: "user", key: f.ahmedId, metric: "spend", productIds: f.paperProductId })
      expect(body.totals.valueCents).toBe(7000)
      expect(body.totals.orderCount).toBe(2)
      expect(body.totals.lineCount).toBe(2)
      expect(body.totals.quantityByUnit).toEqual([{ unit: "Ream", quantity: 14 }])
      for (const row of body.rows) {
        expect(row.requesterName).toBe(f.names.ahmed)
        expect(row.productName).toBe(f.names.paper)
      }
    })
  })

  // ── Total Budget beside the bars ─────────────────────────────────────────

  describe("the budget beside By branch and By month", () => {
    /**
     * A ledger for the window, all in cents. Every figure below is worked by
     * hand from these rows and the order history in the fixture:
     *
     *   North  2026-06  allocated 20,000            → 20,000
     *   North  2026-07  allocated 30,000 + 5,000 add-on → 35,000
     *   South  2026-08  allocated  5,000            →  5,000
     *   Foreign (tenant B) 2026-07 allocated 99,000 — must never appear
     *
     *   By branch over Jun–Aug:  North 55,000 · South 5,000
     *   By month over Jun–Aug:   2026-06 20,000 · 2026-07 35,000 · 2026-08 5,000
     *   May 2026 has no orders; with a budget row of 7,000 for North it is a
     *   filled month: value 0, budget 7,000.
     */
    const ledgerIds: number[] = []

    beforeAll(async () => {
      const rows = await db
        .insert(budgets)
        .values([
          { organizationId: f.organizationId, branchId: f.northBranchId, period: "2026-05", amountAllocatedCents: 7_000 },
          { organizationId: f.organizationId, branchId: f.northBranchId, period: "2026-06", amountAllocatedCents: 20_000 },
          { organizationId: f.organizationId, branchId: f.northBranchId, period: "2026-07", amountAllocatedCents: 30_000, amountCreditedCents: 5_000 },
          { organizationId: f.organizationId, branchId: f.southBranchId, period: "2026-08", amountAllocatedCents: 5_000 },
          { organizationId: f.neighbourOrganizationId, branchId: f.foreignBranchId, period: "2026-07", amountAllocatedCents: 99_000 },
        ])
        .returning({ id: budgets.id })
      ledgerIds.push(...rows.map((row) => row.id))
    })

    afterAll(async () => {
      await db.delete(budgets).where(inArray(budgets.id, ledgerIds))
    })

    const budgetsOf = (body: any): Array<[string, number, number]> =>
      body.rows.map((row: any) => [row.label, row.value, row.totalBudgetCents])

    it("sets each branch's Total Budget beside Consumed, including pending in both", async () => {
      const { status, body } = await compare({
        dimension: "branch", metric: "spend", chart: "column", budget: 1, statuses: "consumed",
      })
      expect(status).toBe(200)
      expect(body.budgetBeside).toBe(true)
      expect(body.label).toBe("Consumed")
      expect(budgetsOf(body)).toEqual([[f.names.north, 65_000, 55_000], [f.names.south, 16_500, 5_000]])
      const overviewRows = (await overview({})).body.branches
      for (const row of body.rows) {
        const overviewRow = overviewRows.find((entry: any) => entry.branchName === row.label)
        expect(overviewRow?.totalBudgetCents).toBe(row.totalBudgetCents)
        expect(overviewRow?.consumedCents).toBe(row.value)
      }
    })

    it("sets each month's Total Budget beside it, summed over the fenced branches, and fills a budgeted month nobody ordered in", async () => {
      const { body } = await compare({
        dimension: "month", metric: "spend", chart: "column", budget: 1, statuses: "consumed",
      })
      expect(body.budgetBeside).toBe(true)
      expect(budgetsOf(body)).toEqual([["2026-06", 18000, 20_000], ["2026-07", 10000, 35_000], ["2026-08", 53500, 5_000]])

      // Widen to May: no orders, a 7,000 budget — a zero column with a budget
      // beside it, in its place at the start of the axis, not a missing month.
      const widened = await compare({
        dimension: "month", metric: "spend", chart: "column", budget: 1,
        startDate: "2026-05-01", statuses: "consumed",
      })
      expect(budgetsOf(widened.body)).toEqual([
        ["2026-05", 0, 7_000], ["2026-06", 18000, 20_000], ["2026-07", 10000, 35_000], ["2026-08", 53500, 5_000],
      ])
      expect(widened.body.rows[0]).toMatchObject({ key: "2026-05", orderCount: 0, previousValue: 0, changePct: null, share: 0 })
      // The filled month is not there when the budget was not asked for.
      const plain = await compare({
        dimension: "month", metric: "spend", chart: "column", startDate: "2026-05-01", statuses: "consumed",
      })
      expect(keysOf(plain.body)).toEqual(["2026-06", "2026-07", "2026-08"])
    })

    it("attaches nothing without the flag, and the response is otherwise identical", async () => {
      const plain = await compare({ dimension: "branch", metric: "spend", chart: "column" })
      expect(plain.body.budgetBeside).toBe(false)
      for (const row of plain.body.rows) expect(row.totalBudgetCents).toBeUndefined()
      const withBudget = await compare({ dimension: "branch", metric: "spend", chart: "column", budget: 1 })
      expect(ranked(withBudget.body)).toEqual(ranked(plain.body))
    })

    it("withholds the budget under a product focus, a requester narrowing, a category, or Quantity — asked or not", async () => {
      const refused = [
        { productIds: f.paperProductId },
        { userIds: f.ahmedId },
        { categoryIds: f.stationeryCategoryId },
        { metric: "quantity", unit: "Ream" },
      ]
      for (const narrowing of refused) {
        const { status, body } = await compare({ dimension: "branch", metric: "spend", chart: "column", budget: 1, ...narrowing })
        expect(status, JSON.stringify(narrowing)).toBe(200)
        expect(body.budgetBeside, JSON.stringify(narrowing)).toBe(false)
        for (const row of body.rows) expect(row.totalBudgetCents, JSON.stringify(narrowing)).toBeUndefined()
      }
      // Nor beside a dimension that holds no budget.
      const byPerson = await compare({ dimension: "user", metric: "spend", chart: "column", budget: 1 })
      expect(byPerson.body.budgetBeside).toBe(false)
    })

    it("stands beside a group and a tenant as the sum of their branches", async () => {
      // No groups exist here, so the one ungrouped row is the whole tenant.
      const byGroup = await compare({ dimension: "group", metric: "spend", chart: "column", budget: 1 })
      expect(budgetsOf(byGroup.body)).toEqual([["No group", 31500, 60_000]])
      signIn(superAdmin)
      const byTenant = await compare({ dimension: "organization", metric: "spend", chart: "column", budget: 1, organizationIds: f.organizationId })
      expect(budgetsOf(byTenant.body)).toHaveLength(1)
      expect(byTenant.body.rows[0].totalBudgetCents).toBe(60_000)
    })

    it("never shows the neighbour's budget, and shows an approver only its own branch's", async () => {
      // Head Office A: the neighbour's 99,000 is in no month and no branch.
      const months = await compare({ dimension: "month", metric: "spend", chart: "column", budget: 1 })
      expect(months.body.rows.find((row: any) => row.key === "2026-07").totalBudgetCents).toBe(35_000)

      // The neighbour's Head Office sees its own 99,000 and nothing of tenant A's.
      signIn(neighbourHeadOffice)
      const theirs = await compare({ dimension: "branch", metric: "spend", chart: "column", budget: 1 })
      expect(budgetsOf(theirs.body)).toEqual([[f.names.foreign, 7000, 99_000]])

      // The South approver: South's 5,000 for August, and July — North's
      // month — carries no budget at all, because North is outside its reach.
      signIn(southApprover)
      const south = await compare({ dimension: "branch", metric: "spend", chart: "column", budget: 1 })
      expect(budgetsOf(south.body)).toEqual([[f.names.south, 16500, 5_000]])
      const southMonths = await compare({ dimension: "month", metric: "spend", chart: "column", budget: 1 })
      expect(budgetsOf(southMonths.body)).toEqual([["2026-06", 7000, 0], ["2026-07", 8000, 0], ["2026-08", 1500, 5_000]])
      // Naming North's branch directly is refused at the fence, before any budget is read.
      const reach = await compare({ dimension: "branch", metric: "spend", chart: "column", budget: 1, branchIds: f.northBranchId })
      expect(reach.status).toBe(403)
    })
  })

  describe("the group filter", () => {
    let northGroupId: number
    let foreignGroupId: number
    let southBudgetId: number
    const northGroupName = () => `North Region ${f.suffix}`

    beforeAll(async () => {
      const [northGroup] = await db
        .insert(groups)
        .values({ organizationId: f.organizationId, name: northGroupName(), createdByUserId: f.headOfficeId })
        .returning({ id: groups.id })
      const [foreignGroup] = await db
        .insert(groups)
        .values({ organizationId: f.neighbourOrganizationId, name: `Coast ${f.suffix}`, createdByUserId: f.neighbourHeadOfficeId })
        .returning({ id: groups.id })
      northGroupId = northGroup.id
      foreignGroupId = foreignGroup.id
      await db.update(branches).set({ groupId: northGroupId }).where(eq(branches.id, f.northBranchId))
      await db.update(branches).set({ groupId: foreignGroupId }).where(eq(branches.id, f.foreignBranchId))
      const [southBudget] = await db
        .insert(budgets)
        .values({ organizationId: f.organizationId, branchId: f.southBranchId, period: "2026-07", amountAllocatedCents: 100_000 })
        .returning({ id: budgets.id })
      southBudgetId = southBudget.id
    })

    afterAll(async () => {
      await db.delete(budgets).where(eq(budgets.id, southBudgetId))
      await db.update(branches).set({ groupId: null }).where(inArray(branches.id, [f.northBranchId, f.foreignBranchId]))
      await db.delete(groups).where(inArray(groups.id, [northGroupId, foreignGroupId]))
    })

    it("fences every route to the group's branches, budgets included", async () => {
      const groupIds = String(northGroupId)

      // Overview: the branch list, the budget rows and the KPIs are North's
      // alone. South's 100,000 allocation is outside the group and so outside
      // the total — the figure an order-level filter would have got wrong.
      const { body: summary } = await overview({ groupIds })
      expect(summary.scope.branches).toEqual([{ id: f.northBranchId, name: f.names.north }])
      expect(summary.branches.map((row: any) => row.branchName)).toEqual([f.names.north])
      expect(summary.kpis.spendCents).toBe(15000)
      expect(summary.kpis.orderCount).toBe(3)
      expect(summary.kpis.totalBudgetCents).toBe(0)
      // Without the group, South's allocation is in the total.
      expect((await overview({})).body.kpis.totalBudgetCents).toBe(100_000)

      // Compare: by branch, by requester, and the group dimension itself.
      expect(ranked((await compare({ dimension: "branch", metric: "spend", groupIds })).body)).toEqual([[f.names.north, 15000]])
      expect(ranked((await compare({ dimension: "user", metric: "spend", groupIds })).body))
        .toEqual([[f.names.ahmed, 13000], [f.names.group, 2000]])
      expect(ranked((await compare({ dimension: "group", metric: "spend", groupIds })).body)).toEqual([[northGroupName(), 15000]])

      // Picking the group as an entity travels the same path as the filter.
      expect(ranked((await compare({ dimension: "group", metric: "spend", keys: groupIds })).body)).toEqual([[northGroupName(), 15000]])

      // Options: only the people who ordered at North are offered.
      const people = await options({ dimension: "user", groupIds })
      expect(people.body.options.map((o: any) => o.key).sort()).toEqual([f.ahmedId, f.groupRequesterId].sort())

      // Drill-down on the group: North's lines and nothing else.
      const { body: lines } = await drillDown({ dimension: "group", key: groupIds, metric: "spend" })
      expect(lines.totals.orderCount).toBe(3)
      expect(lines.totals.lineCount).toBe(4)
      for (const row of lines.rows) expect(row.branchName).toBe(f.names.north)
    })

    it("intersects with a branch selection instead of adding to it", async () => {
      const inside = await compare({ dimension: "branch", metric: "spend", groupIds: northGroupId, branchIds: f.northBranchId })
      expect(ranked(inside.body)).toEqual([[f.names.north, 15000]])

      // South is in the tenant but not in the group: nothing survives, and
      // nothing is a refusal rather than the tenant.
      const outside = await overview({ groupIds: northGroupId, branchIds: f.southBranchId })
      expect(outside.status).toBe(403)
      expect(outside.body.kpis).toBeUndefined()
    })

    it("refuses another tenant's group and a group outside the approver's assignments", async () => {
      // Head Office A naming tenant B's group reaches nothing of B's.
      for (const run of [
        () => overview({ groupIds: foreignGroupId }),
        () => compare({ dimension: "branch", metric: "spend", groupIds: foreignGroupId }),
        () => options({ dimension: "product", groupIds: foreignGroupId }),
        () => drillDown({ dimension: "group", key: String(foreignGroupId), metric: "spend" }),
      ]) {
        const { status, body } = await run()
        expect(status).toBe(403)
        expect(body.rows ?? body.options ?? body.kpis).toBeUndefined()
      }

      // The South approver is assigned South; North's group holds nothing it
      // may see, and the assignment wins over the group.
      signIn(southApprover)
      expect((await overview({ groupIds: northGroupId })).status).toBe(403)
      expect((await compare({ dimension: "group", metric: "spend", keys: String(northGroupId) })).status).toBe(403)
      // Its own reach, unnarrowed, is unchanged by the block's setup.
      expect(ranked((await compare({ dimension: "branch", metric: "spend" })).body)).toEqual([[f.names.south, 16500]])
    })

    it("offers the group to the picker, and lists ungrouped branches under 'No group' beside it", async () => {
      const picker = await options({ dimension: "group" })
      expect(picker.body.options).toEqual([{ key: String(northGroupId), label: northGroupName() }])

      const byGroup = await compare({ dimension: "group", metric: "spend" })
      expect(ranked(byGroup.body)).toEqual([["No group", 16500], [northGroupName(), 15000]])
    })
  })
})

if (!hasTestDatabase) {
  it.skip(NO_DATABASE_REASON, () => {})
}
