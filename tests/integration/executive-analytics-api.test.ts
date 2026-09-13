import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as compareRoute from "@/app/api/v1/analytics/executive/compare/route"
import * as drillDownRoute from "@/app/api/v1/analytics/executive/drill-down/route"
import * as optionsRoute from "@/app/api/v1/analytics/executive/options/route"
import * as overviewRoute from "@/app/api/v1/analytics/executive/overview/route"
import { closePool } from "@/lib/db"

import {
  NO_DATABASE_REASON,
  WINDOW,
  createExecutiveAnalyticsFixtures,
  destroyExecutiveAnalyticsFixtures,
  hasTestDatabase,
  type ExecutiveAnalyticsFixtures,
} from "./helpers/executive-analytics-fixtures"

/**
 * The Compare Side by Side tab, end to end: the four routes it is built from,
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

/** `[label, value]` pairs, in the order the route ranked them. */
const ranked = (body: any): Array<[string, number]> => body.rows.map((row: any) => [row.label, row.value])
const keysOf = (body: any): string[] => body.rows.map((row: any) => row.key)

describe.skipIf(!hasTestDatabase)("Compare Side by Side — executive analytics routes", () => {
  let f: ExecutiveAnalyticsFixtures
  let headOffice: Actor
  let neighbourHeadOffice: Actor
  let superAdmin: Actor

  beforeAll(async () => {
    f = await createExecutiveAnalyticsFixtures()
    headOffice = { id: f.headOfficeId, role: "HEAD_OFFICE" }
    neighbourHeadOffice = { id: f.neighbourHeadOfficeId, role: "HEAD_OFFICE" }
    superAdmin = { id: f.superAdminId, role: "SUPER_ADMIN" }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    signIn(headOffice)
  })

  afterAll(async () => {
    if (f) await destroyExecutiveAnalyticsFixtures(f)
    await closePool()
  })

  // ── Access control ─────────────────────────────────────────────────────

  describe("access control", () => {
    const everyRoute = [
      ["compare", () => compare({ dimension: "branch", metric: "spend" })],
      ["options", () => options({ dimension: "product" })],
      ["drill-down", () => drillDown({ dimension: "branch", key: String(f.northBranchId), metric: "spend" })],
      ["overview", () => overview({})],
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
      const units = await compare({ dimension: "user", metric: "quantity", productIds: f.paperProductId, unit: "Ream" })
      // Ahmed: 10 + (6 − 2 refunded) = 14 reams.
      expect(units.body.rows.find((row: any) => row.label === f.names.ahmed).value).toBe(14)
    })

    it("counts whole orders with no focus, and only the focused product's lines with one", async () => {
      const whole = await compare({ dimension: "branch", metric: "spend" })
      expect(ranked(whole.body)).toEqual([[f.names.south, 16500], [f.names.north, 15000]])

      const focused = await compare({ dimension: "branch", metric: "spend", productIds: f.paperProductId })
      expect(ranked(focused.body)).toEqual([[f.names.south, 8500], [f.names.north, 7000]])
      // Money is addable across units, so the mixed units do not block Amount…
      expect(focused.body.blocked).toBeUndefined()
      // …but the conflict is still reported, so the Unit control can appear.
      expect(focused.body.quantityUnit).toEqual({ selected: null, conflict: true, available: ["Box", "Ream"] })
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

  describe("Quantity and the unit of measure", () => {
    it("refuses to total quantity across units until one is chosen", async () => {
      const { status, body } = await compare({ dimension: "branch", metric: "quantity", productIds: f.paperProductId })
      expect(status).toBe(200)
      expect(body.rows).toEqual([])
      expect(body.blocked.reason).toBe("unit-conflict")
      expect(body.blocked.message).toContain("Box, Ream")
      expect(body.quantityUnit).toEqual({ selected: null, conflict: true, available: ["Box", "Ream"] })
    })

    it("blocks with every unit in scope when nothing is focused", async () => {
      const { body } = await compare({ dimension: "branch", metric: "quantity" })
      expect(body.blocked.reason).toBe("unit-conflict")
      expect(body.quantityUnit.available).toEqual(["Box", "Litre", "Piece", "Ream"])
    })

    it("counts only the chosen unit once one is picked", async () => {
      const reams = await compare({ dimension: "branch", metric: "quantity", productIds: f.paperProductId, unit: "Ream" })
      expect(reams.body.format).toBe("quantity")
      expect(reams.body.quantityUnit.selected).toBe("Ream")
      expect(ranked(reams.body)).toEqual([[f.names.north, 14], [f.names.south, 7]])

      const boxes = await compare({ dimension: "branch", metric: "quantity", productIds: f.paperProductId, unit: "Box" })
      expect(ranked(boxes.body)).toEqual([[f.names.south, 2]])
    })

    it("resolves the unit itself when only one is in scope", async () => {
      const { body } = await compare({ dimension: "branch", metric: "quantity", productIds: f.dieselProductId })
      expect(body.blocked).toBeUndefined()
      expect(body.quantityUnit).toEqual({ selected: "Litre", conflict: false, available: ["Litre"] })
      expect(ranked(body)).toEqual([[f.names.south, 50], [f.names.north, 20]])
    })

    it("ignores a unit for whole-order money, and applies it once money is counted line by line", async () => {
      const whole = await compare({ dimension: "branch", metric: "spend", unit: "Ream" })
      expect(ranked(whole.body)).toEqual([[f.names.south, 16500], [f.names.north, 15000]])
      expect(whole.body.quantityUnit.selected).toBeNull()

      const focused = await compare({ dimension: "branch", metric: "spend", productIds: f.paperProductId, unit: "Ream" })
      // The Box line at South (5000) is excluded.
      expect(ranked(focused.body)).toEqual([[f.names.north, 7000], [f.names.south, 3500]])
      expect(focused.body.quantityUnit.selected).toBe("Ream")
    })

    it("drops a unit that is not in scope rather than matching nothing", async () => {
      const { body } = await compare({ dimension: "branch", metric: "quantity", productIds: f.dieselProductId, unit: "Gallon" })
      expect(body.quantityUnit.selected).toBe("Litre")
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
      // The pending order counts here: the picker lists activity, not revenue.
      expect(byKey[f.ahmedId].hint).toBe(`${f.names.north} · 3 orders`)
      expect(byKey[f.sanaId].hint).toBe(`${f.names.south} · 3 orders`)
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

    it("reconciles a quantity bar, per unit, and only applies a unit the reader chose", async () => {
      const chosen = await drillDown({ dimension: "product", key: String(f.paperProductId), metric: "quantity", unit: "Ream" })
      expect(chosen.body.totals.quantityByUnit).toEqual([{ unit: "Ream", quantity: 21 }])
      expect(chosen.body.totals.lineCount).toBe(4)

      const mixed = await drillDown({ dimension: "product", key: String(f.paperProductId), metric: "quantity" })
      expect(mixed.body.totals.lineCount).toBe(5)
      expect(mixed.body.totals.quantityByUnit).toEqual([{ unit: "Ream", quantity: 21 }, { unit: "Box", quantity: 2 }])
      expect(mixed.body.totals.valueCents).toBe(15500)
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

  // ── Overview: the unit list the filter bar is built from ───────────────

  describe("the overview the filter bar reads its Unit list from", () => {
    it("reports every unit in scope, and which one is selected", async () => {
      const mixed = await overview({})
      expect(mixed.body.quantityUnit).toEqual({ selected: null, conflict: true, available: ["Box", "Litre", "Piece", "Ream"] })
      expect(mixed.body.scope.branches.map((b: any) => b.name).sort()).toEqual([f.names.north, f.names.south].sort())

      const chosen = await overview({ unit: "Ream" })
      expect(chosen.body.quantityUnit).toEqual({ selected: "Ream", conflict: false, available: ["Box", "Litre", "Piece", "Ream"] })
    })
  })
})

if (!hasTestDatabase) {
  it.skip(NO_DATABASE_REASON, () => {})
}
