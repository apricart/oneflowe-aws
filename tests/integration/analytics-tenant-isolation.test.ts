import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as branchesPerformance from "@/app/api/v1/analytics/branches/performance/route"
import * as budgetsSummary from "@/app/api/v1/analytics/budgets/summary/route"
import * as dashboard from "@/app/api/v1/analytics/dashboard/route"
import * as drillDown from "@/app/api/v1/analytics/drill-down/route"
import * as earliestRecord from "@/app/api/v1/analytics/earliest-record/route"
import * as groupsAnalytics from "@/app/api/v1/analytics/groups/route"
import * as lifetimeStats from "@/app/api/v1/analytics/lifetime-stats/route"
import * as monthlySales from "@/app/api/v1/analytics/monthly-sales/route"
import * as itemized from "@/app/api/v1/analytics/orders/itemized/route"
import * as organizationStats from "@/app/api/v1/analytics/organization-stats/route"
import * as catalogPerformance from "@/app/api/v1/analytics/products/catalog-performance/route"
import * as consumptionTrend from "@/app/api/v1/analytics/products/consumption-trend/route"
import * as productDetails from "@/app/api/v1/analytics/products/details/route"
import * as productList from "@/app/api/v1/analytics/products/list/route"
import * as productPerformance from "@/app/api/v1/analytics/products/performance/route"
import * as productSummary from "@/app/api/v1/analytics/products/summary/route"
import * as refundsAnalytics from "@/app/api/v1/analytics/refunds/route"
import * as salesPerformance from "@/app/api/v1/analytics/sales-performance/route"
import * as summary from "@/app/api/v1/analytics/summary/route"
import * as usersPerformance from "@/app/api/v1/analytics/users/performance/route"
import * as usersProducts from "@/app/api/v1/analytics/users/products/route"
import * as weeklySales from "@/app/api/v1/analytics/weekly-sales/route"
import * as yearlySales from "@/app/api/v1/analytics/yearly-sales/route"
import { closePool } from "@/lib/db"

import {
  WINDOW,
  createExecutiveAnalyticsFixtures,
  destroyExecutiveAnalyticsFixtures,
  hasTestDatabase,
  type ExecutiveAnalyticsFixtures,
} from "./helpers/executive-analytics-fixtures"

/**
 * Every analytics endpoint outside the Executive Center, held to one rule:
 * **a caller in tenant A never receives anything of tenant B's** — not its
 * branch, its product, its organization or its people — not by default, and
 * not when the query string names tenant B.
 *
 * The fixture (see executive-analytics-fixtures.ts) gives tenant B
 * distinctive names, so the check is a plain search of each response body.
 * The same endpoints are also checked to refuse an anonymous caller and to
 * answer every valid request without a server error, and Super Admin is
 * checked to actually reach tenant B, so a passing leak check cannot be
 * explained by an endpoint that returns nothing at all.
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
    coalesceInFlight: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

const { getServerSession } = mockedNextAuth

type Handler = (req: NextRequest) => Promise<Response>
type Endpoint = { name: string; handler: Handler; query?: Record<string, string> }

const ENDPOINTS: Endpoint[] = [
  { name: "branches/performance", handler: branchesPerformance.GET },
  { name: "budgets/summary", handler: budgetsSummary.GET, query: { preset: "all" } },
  { name: "dashboard", handler: dashboard.GET },
  { name: "drill-down REVENUE", handler: drillDown.GET, query: { type: "REVENUE" } },
  { name: "drill-down ORDERS", handler: drillDown.GET, query: { type: "ORDERS" } },
  { name: "drill-down REFUNDED", handler: drillDown.GET, query: { type: "REFUNDED" } },
  { name: "earliest-record", handler: earliestRecord.GET },
  { name: "groups", handler: groupsAnalytics.GET },
  { name: "lifetime-stats", handler: lifetimeStats.GET },
  { name: "monthly-sales", handler: monthlySales.GET, query: { year: "2026" } },
  { name: "orders/itemized", handler: itemized.GET },
  { name: "organization-stats", handler: organizationStats.GET },
  { name: "products/catalog-performance", handler: catalogPerformance.GET },
  { name: "products/consumption-trend", handler: consumptionTrend.GET },
  { name: "products/details", handler: productDetails.GET },
  { name: "products/list", handler: productList.GET },
  { name: "products/performance", handler: productPerformance.GET },
  { name: "products/summary", handler: productSummary.GET },
  { name: "refunds", handler: refundsAnalytics.GET },
  { name: "sales-performance", handler: salesPerformance.GET },
  { name: "summary", handler: summary.GET },
  { name: "users/performance", handler: usersPerformance.GET },
  { name: "users/products", handler: usersProducts.GET },
  { name: "weekly-sales", handler: weeklySales.GET },
  { name: "yearly-sales", handler: yearlySales.GET, query: { year: "2026" } },
]

const GLOBAL_CATALOGUE_LISTINGS = new Set(["products/catalog-performance", "products/list"])

type Actor = { id: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, email: "a@example.test", mustChangePassword: false } } as any),
  )
}

async function call(endpoint: Endpoint, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ ...WINDOW, ...endpoint.query, ...extra })
  const response = await endpoint.handler(
    new NextRequest(`http://localhost/api/v1/analytics/${endpoint.name.split(" ")[0]}?${params.toString()}`),
  )
  const text = await response.text()
  return { status: response.status, text }
}

describe.skipIf(!hasTestDatabase)("analytics endpoints keep each tenant to itself", () => {
  let f: ExecutiveAnalyticsFixtures
  let foreignMarkers: string[]

  const headOffice = (): Actor => ({ id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.organizationId, branchId: null })
  const branchAdmin = (): Actor => ({ id: f.branchAdminId, role: "BRANCH_ADMIN", organizationId: f.organizationId, branchId: f.northBranchId })
  const superAdmin = (): Actor => ({ id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null, branchId: null })

  function leaked(text: string, markers = foreignMarkers): string[] {
    return markers.filter((marker) => text.includes(marker))
  }

  beforeAll(async () => {
    f = await createExecutiveAnalyticsFixtures()
    foreignMarkers = [
      f.names.foreign,
      `Foreign Product ${f.suffix}`,
      `IT Exec Neighbour ${f.suffix}`,
      `ITX-${f.suffix}`,
    ]
  })

  afterAll(async () => {
    if (f) await destroyExecutiveAnalyticsFixtures(f)
    await closePool()
  })

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it.each(ENDPOINTS.map((endpoint) => [endpoint.name, endpoint] as const))(
    "%s refuses an anonymous caller",
    async (_name, endpoint) => {
      signIn(null)
      expect([401, 403]).toContain((await call(endpoint)).status)
    },
  )

  it.each(ENDPOINTS.map((endpoint) => [endpoint.name, endpoint] as const))(
    "%s gives Head Office of tenant A nothing of tenant B, even when asked for it",
    async (_name, endpoint) => {
      signIn(headOffice())
      const own = await call(endpoint)
      expect(own.status, own.text.slice(0, 300)).toBeLessThan(500)
      // The two catalogue pickers list the shared global catalogue when no
      // filter is named, so a global product's name is expected there — but
      // never another tenant's branch, organization, prices or sales.
      const markers = GLOBAL_CATALOGUE_LISTINGS.has(endpoint.name)
        ? foreignMarkers.filter((marker) => !marker.startsWith("Foreign Product"))
        : foreignMarkers
      expect(leaked(own.text, markers)).toEqual([])

      const asked = await call(endpoint, {
        organizationId: String(f.neighbourOrganizationId),
        organizationIds: String(f.neighbourOrganizationId),
        branchIds: String(f.foreignBranchId),
        branchId: String(f.foreignBranchId),
      })
      expect(asked.status, asked.text.slice(0, 300)).toBeLessThan(500)
      expect(leaked(asked.text)).toEqual([])
    },
  )

  it.each(ENDPOINTS.map((endpoint) => [endpoint.name, endpoint] as const))(
    "%s keeps a Branch Admin away from tenant B and from its sibling branch",
    async (_name, endpoint) => {
      signIn(branchAdmin())
      const asked = await call(endpoint, {
        organizationId: String(f.neighbourOrganizationId),
        branchIds: `${f.foreignBranchId},${f.southBranchId}`,
        branchId: String(f.foreignBranchId),
      })
      expect(asked.status, asked.text.slice(0, 300)).toBeLessThan(500)
      expect(leaked(asked.text)).toEqual([])
    },
  )

  it("refuses Head Office a catalogue read naming only tenant B's branch, rather than reading it as 'no filter'", async () => {
    signIn(headOffice())
    const catalogue = ENDPOINTS.find((endpoint) => endpoint.name === "products/catalog-performance")!
    expect((await call(catalogue, { branchIds: String(f.foreignBranchId) })).status).toBe(403)
    const list = ENDPOINTS.find((endpoint) => endpoint.name === "products/list")!
    expect(JSON.parse((await call(list, { branchIds: String(f.foreignBranchId) })).text)).toEqual({ items: [] })
  })

  it("still lets Head Office narrow the per-user reports to one of its own branches", async () => {
    signIn(headOffice())
    const performance = ENDPOINTS.find((endpoint) => endpoint.name === "users/performance")!
    const result = await call(performance, { branchIds: String(f.northBranchId) })
    expect(result.status).toBe(200)
    expect(result.text).toContain(f.names.ahmed)
    expect(result.text).not.toContain(f.names.sana)
  })

  it("lets Super Admin reach tenant B, so the checks above are not passing on empty answers", async () => {
    signIn(superAdmin())
    const reached: string[] = []
    for (const endpoint of ENDPOINTS) {
      const result = await call(endpoint, { organizationId: String(f.neighbourOrganizationId) })
      expect(result.status, `${endpoint.name}: ${result.text.slice(0, 300)}`).toBeLessThan(500)
      if (leaked(result.text).length > 0) reached.push(endpoint.name)
    }
    // Not every endpoint names branches or products, but the order-level ones must.
    expect(reached).toEqual(expect.arrayContaining(["orders/itemized", "branches/performance"]))
  })
})
