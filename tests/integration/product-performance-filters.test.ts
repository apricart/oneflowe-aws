import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import { orderItems, orders, refundItems, refunds } from "@/db/schema"

import * as compareRoute from "@/app/api/v1/analytics/executive/compare/route"
import * as drillDownRoute from "@/app/api/v1/analytics/executive/drill-down/route"
import * as matrixRoute from "@/app/api/v1/analytics/executive/matrix/route"
import * as optionsRoute from "@/app/api/v1/analytics/executive/options/route"
import { closePool, db } from "@/lib/db"

import {
  FILTER_WINDOW,
  NO_DATABASE_REASON,
  createProductPerformanceFilterFixtures,
  destroyProductPerformanceFilterFixtures,
  hasTestDatabase,
  type ProductPerformanceFilterFixtures,
} from "./helpers/product-performance-filter-fixtures"

/**
 * The Product Performance tab under every filter it offers — groups, branches,
 * categories, products, requesters and the date range — alone and stacked.
 *
 * Each request is the one the page sends: the shared filter row as
 * `groupIds` / `branchIds` / `categoryIds` and the dates, the tab's own pickers
 * as `productIds` / `userIds`, Amount as `metric=spend&statuses=consumed` and
 * Quantity as `metric=quantity&statuses=revenue`. Every expected figure is
 * worked out by hand in `helpers/product-performance-filter-fixtures.ts`.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))

const { getServerSession } = mockedNextAuth

type Query = Record<string, string | number | undefined>

async function call(handler: (req: NextRequest) => Promise<Response>, path: string, query: Query) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value))
  }
  const response = await handler(new NextRequest(`http://localhost/api/v1/analytics/executive/${path}?${params}`))
  return { status: response.status, body: await response.json() }
}

const compare = (query: Query) => call(compareRoute.GET, "compare", { ...FILTER_WINDOW, ...query })
const drillDown = (query: Query) => call(drillDownRoute.GET, "drill-down", { ...FILTER_WINDOW, ...query })
const matrix = (query: Query) => call(matrixRoute.GET, "matrix", { ...FILTER_WINDOW, ...query })
const options = (query: Query) => call(optionsRoute.GET, "options", { ...FILTER_WINDOW, ...query })

/** The Amount view, exactly as the page asks for it. */
const AMOUNT = { metric: "spend", statuses: "consumed" } as const
/** The revenue population, which the Overview and Explore use for money. */
const REVENUE = { metric: "spend", statuses: "revenue" } as const
/** The Quantity view, exactly as the page asks for it. */
const QUANTITY = { metric: "quantity", statuses: "revenue" } as const

const ranked = (body: any): Array<[string, number]> => body.rows.map((row: any) => [row.label, row.value])
const byKey = (body: any): Record<string, number> =>
  Object.fromEntries(body.rows.map((row: any) => [row.key, row.value]))
const total = (body: any): number => body.rows.reduce((sum: number, row: any) => sum + row.value, 0)

describe.skipIf(!hasTestDatabase)("Product Performance — filters, alone and combined", () => {
  let f: ProductPerformanceFilterFixtures

  beforeAll(async () => {
    f = await createProductPerformanceFilterFixtures()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: f.headOfficeId, role: "HEAD_OFFICE" } } as any)
  })

  afterAll(async () => {
    if (f) await destroyProductPerformanceFilterFixtures(f)
    await closePool()
  })

  // ── Every panel adds up to the same figure, under every filter mix ──────

  /**
   * One row per filter combination, with the figure every panel must add up
   * to under each population. A panel that drops or double-counts a row under
   * one combination shows up here as a total that disagrees with the others.
   */
  const combinations = () => [
    { name: "no filters", query: {}, revenue: 40200, consumed: 45200 },
    { name: "Group One", query: { groupIds: f.groupOneId }, revenue: 29500, consumed: 34500 },
    { name: "Group Two", query: { groupIds: f.groupTwoId }, revenue: 6700, consumed: 6700 },
    { name: "Group One + Paper", query: { groupIds: f.groupOneId, productIds: f.paperProductId }, revenue: 8500, consumed: 8500 },
    {
      name: "Group One + Paper, Toner",
      query: { groupIds: f.groupOneId, productIds: `${f.paperProductId},${f.tonerProductId}` },
      revenue: 26500,
      consumed: 26500,
    },
    {
      name: "Group One + Stationery + Bilal",
      query: { groupIds: f.groupOneId, categoryIds: f.stationeryCategoryId, userIds: f.bilalId },
      revenue: 15000,
      consumed: 15000,
    },
    {
      name: "Group One + East + Toner",
      query: { groupIds: f.groupOneId, branchIds: f.eastBranchId, productIds: f.tonerProductId },
      revenue: 12000,
      consumed: 12000,
    },
    {
      name: "Group One, Group Two + Diesel",
      query: { groupIds: `${f.groupOneId},${f.groupTwoId}`, productIds: f.dieselProductId },
      revenue: 3700,
      consumed: 8700,
    },
    { name: "Group Two + Fuel", query: { groupIds: f.groupTwoId, categoryIds: f.fuelCategoryId }, revenue: 700, consumed: 700 },
  ]

  const totalPanels = ["product", "category", "user", "branch", "group", "month"] as const

  it("adds up to the same total on every panel and in the drill-down, for every combination", async () => {
    for (const combination of combinations()) {
      for (const [population, expected] of [[REVENUE, combination.revenue], [AMOUNT, combination.consumed]] as const) {
        const label = `${combination.name} (${population.statuses})`
        for (const dimension of totalPanels) {
          const { status, body } = await compare({ ...combination.query, ...population, dimension, chart: "column", limit: 50 })
          expect(status, `${label} by ${dimension}`).toBe(200)
          expect(total(body), `${label} by ${dimension}`).toBe(expected)
        }
        // The drill-down behind a whole panel (no clicked key) lists the lines
        // behind every bar of it.
        const { body: lines } = await drillDown({ ...combination.query, ...population, dimension: "product" })
        expect(lines.totals.valueCents, `${label} drill-down`).toBe(expected)
      }
    }
  })

  // ── The worked answers, panel by panel ─────────────────────────────────

  describe("with no filters", () => {
    it("ranks every branch, group, requester, product and category", async () => {
      expect(ranked((await compare({ ...REVENUE, dimension: "branch" })).body)).toEqual([
        [f.names.east, 18000], [f.names.north, 11500], [f.names.south, 6700], [f.names.west, 4000],
      ])
      expect(ranked((await compare({ ...REVENUE, dimension: "group" })).body)).toEqual([
        [f.names.groupOne, 29500], [f.names.groupTwo, 6700], ["No group", 4000],
      ])
      expect(ranked((await compare({ ...REVENUE, dimension: "user" })).body)).toEqual([
        [f.names.bilal, 18000], [f.names.ahmed, 11500], [f.names.sana, 6700], [f.names.wali, 4000],
      ])
      expect(ranked((await compare({ ...REVENUE, dimension: "product" })).body)).toEqual([
        [f.names.toner, 21000], [f.names.paper, 15500], [f.names.diesel, 3700],
      ])
      expect(ranked((await compare({ ...REVENUE, dimension: "category" })).body)).toEqual([
        [f.names.stationery, 36500], [f.names.fuel, 3700],
      ])
      expect(byKey((await compare({ ...QUANTITY, dimension: "product" })).body)).toEqual({
        [f.paperProductId]: 31, [f.dieselProductId]: 37, [f.tonerProductId]: 7,
      })
    })
  })

  describe("a group with products", () => {
    const groupOnePaper = () => ({ groupIds: f.groupOneId, productIds: f.paperProductId })

    it("counts only the products' own lines at the group's branches", async () => {
      expect(ranked((await compare({ ...AMOUNT, ...groupOnePaper(), dimension: "branch" })).body)).toEqual([
        [f.names.north, 5500], [f.names.east, 3000],
      ])
      expect(ranked((await compare({ ...AMOUNT, ...groupOnePaper(), dimension: "user" })).body)).toEqual([
        [f.names.ahmed, 5500], [f.names.bilal, 3000],
      ])
      expect(ranked((await compare({ ...AMOUNT, ...groupOnePaper(), dimension: "product" })).body)).toEqual([
        [f.names.paper, 8500],
      ])
      expect(byKey((await compare({ ...QUANTITY, ...groupOnePaper(), dimension: "branch" })).body)).toEqual({
        [f.northBranchId]: 11, [f.eastBranchId]: 6,
      })
    })

    it("ranks several focused products against each other inside the group", async () => {
      const query = { ...AMOUNT, groupIds: f.groupOneId, productIds: `${f.paperProductId},${f.tonerProductId}` }
      expect(ranked((await compare({ ...query, dimension: "product" })).body)).toEqual([
        [f.names.toner, 18000], [f.names.paper, 8500],
      ])
      expect(ranked((await compare({ ...query, dimension: "branch" })).body)).toEqual([
        [f.names.east, 15000], [f.names.north, 11500],
      ])
    })

    it("lays the requester × product grid out pair by pair", async () => {
      const { status, body } = await matrix({
        ...AMOUNT,
        groupIds: f.groupOneId,
        productIds: `${f.paperProductId},${f.tonerProductId}`,
        userIds: `${f.ahmedId},${f.bilalId}`,
        rows: "user",
        columns: "product",
      })
      expect(status).toBe(200)
      const cell = (userId: string, productId: number) =>
        body.cells.find((entry: any) => entry.row === userId && entry.column === String(productId))?.value
      expect(cell(f.ahmedId, f.paperProductId)).toBe(5500)
      expect(cell(f.ahmedId, f.tonerProductId)).toBe(6000)
      expect(cell(f.bilalId, f.paperProductId)).toBe(3000)
      expect(cell(f.bilalId, f.tonerProductId)).toBe(12000)
      expect(Object.fromEntries(body.rows.map((row: any) => [row.key, row.total]))).toEqual({
        [f.ahmedId]: 11500, [f.bilalId]: 15000,
      })
    })

    it("stacks a category and a requester on top of the group", async () => {
      const { body } = await compare({
        ...AMOUNT, groupIds: f.groupOneId, categoryIds: f.stationeryCategoryId, userIds: f.bilalId, dimension: "product",
      })
      expect(ranked(body)).toEqual([[f.names.toner, 12000], [f.names.paper, 3000]])
    })

    it("intersects a branch with the group, and the product with both", async () => {
      const { body } = await compare({
        ...AMOUNT, groupIds: f.groupOneId, branchIds: f.eastBranchId, productIds: f.tonerProductId, dimension: "month",
      })
      expect(ranked(body)).toEqual([["2026-09", 3000], ["2026-10", 9000]])
    })

    it("splits a product across several groups by group", async () => {
      const query = { groupIds: `${f.groupOneId},${f.groupTwoId}`, productIds: f.dieselProductId, dimension: "group" }
      expect(ranked((await compare({ ...REVENUE, ...query })).body)).toEqual([[f.names.groupOne, 3000], [f.names.groupTwo, 700]])
      // Amount adds North's pending diesel order to Group One.
      expect(ranked((await compare({ ...AMOUNT, ...query })).body)).toEqual([[f.names.groupOne, 8000], [f.names.groupTwo, 700]])
    })

    it("answers an empty combination with empty rows, not an error", async () => {
      const { status, body } = await compare({
        ...AMOUNT, groupIds: f.groupTwoId, productIds: f.tonerProductId, startDate: "2026-10-01", endDate: "2026-10-31", dimension: "branch",
      })
      expect(status).toBe(200)
      expect(body.rows).toEqual([])
    })

    it("offers the pickers only what the group and the other picker leave", async () => {
      const products = await options({ statuses: "consumed", dimension: "product", groupIds: f.groupOneId, categoryIds: f.fuelCategoryId })
      expect(products.body.options.map((option: any) => option.key)).toEqual([String(f.dieselProductId)])

      const people = await options({ statuses: "consumed", dimension: "user", groupIds: f.groupTwoId, productIds: f.paperProductId })
      expect(people.body.options.map((option: any) => option.key)).toEqual([f.sanaId])
    })
  })

  // ── The date range at its Karachi edges ─────────────────────────────────

  describe("the date range", () => {
    it("includes an order placed at 00:30 Karachi on the first day and excludes one at 23:30 the night before", async () => {
      expect(ranked((await compare({ ...REVENUE, dimension: "branch", startDate: "2026-10-01", endDate: "2026-10-01" })).body))
        .toEqual([[f.names.north, 500]])
      expect(ranked((await compare({ ...REVENUE, dimension: "branch", startDate: "2026-08-31", endDate: "2026-08-31" })).body))
        .toEqual([[f.names.north, 900]])
    })

    it("includes an order at 23:59:59 Karachi on the last day and excludes one a second later", async () => {
      expect(ranked((await compare({ ...REVENUE, dimension: "product", startDate: "2026-10-31", endDate: "2026-10-31" })).body))
        .toEqual([[f.names.diesel, 700]])
    })

    it("files each order in the Karachi month it was placed in", async () => {
      expect(ranked((await compare({ ...REVENUE, dimension: "month" })).body)).toEqual([["2026-09", 25000], ["2026-10", 15200]])
      expect(ranked((await compare({ ...AMOUNT, dimension: "month" })).body)).toEqual([["2026-09", 25000], ["2026-10", 20200]])
    })

    it("never draws a month or a day outside the selected range", async () => {
      for (const [startDate, endDate] of [
        ["2026-09-01", "2026-09-01"],
        ["2026-10-01", "2026-10-01"],
        ["2026-10-31", "2026-10-31"],
        ["2026-09-01", "2026-10-31"],
      ]) {
        const months = (await compare({ ...REVENUE, dimension: "month", startDate, endDate })).body.rows.map((row: any) => row.key)
        for (const month of months) {
          expect(month >= startDate.slice(0, 7) && month <= endDate.slice(0, 7), `${month} in ${startDate}–${endDate}`).toBe(true)
        }
        const days = (await compare({ ...REVENUE, dimension: "day", startDate, endDate })).body.rows.map((row: any) => row.key)
        for (const day of days) {
          expect(day >= startDate && day <= endDate, `${day} in ${startDate}–${endDate}`).toBe(true)
        }
      }
    })

    it("puts an order on the Karachi day it was placed, in the day-by-day panel", async () => {
      const { body } = await compare({
        ...AMOUNT, groupIds: f.groupOneId, productIds: f.paperProductId, dimension: "day", chart: "line", limit: 6,
      })
      expect(body.periods).toEqual(["2026-09-10", "2026-09-15", "2026-10-01", "2026-10-12"])
      expect(body.series[0].points.map((point: any) => point.value)).toEqual([5000, 2000, 500, 1000])

      const firstOfSeptember = await compare({ ...REVENUE, dimension: "day", startDate: "2026-09-01", endDate: "2026-09-01" })
      expect(ranked(firstOfSeptember.body)).toEqual([["2026-09-01", 3000]])
    })

    it("compares each bar with the equally long window before it", async () => {
      const { body } = await compare({ ...REVENUE, dimension: "branch", startDate: "2026-10-01", endDate: "2026-10-31" })
      const row = (branchId: number) => body.rows.find((entry: any) => entry.key === String(branchId))
      expect(row(f.northBranchId)).toMatchObject({ value: 500, previousValue: 11900 })
      expect(row(f.eastBranchId)).toMatchObject({ value: 10000, previousValue: 8000 })
    })
  })

  // ── A clicked bar opens exactly the rows behind it ──────────────────────

  describe("the drill-down under combined filters", () => {
    it("reconciles with every bar of every panel under a group and a product", async () => {
      const filters = { ...AMOUNT, groupIds: f.groupOneId, productIds: f.paperProductId }
      for (const dimension of ["branch", "user", "month", "day", "product"] as const) {
        const { body } = await compare({ ...filters, dimension })
        expect(body.rows.length, dimension).toBeGreaterThan(0)
        for (const bar of body.rows) {
          const { body: lines } = await drillDown({ ...filters, dimension, key: bar.key })
          expect(lines.totals.valueCents, `${dimension} ${bar.key}`).toBe(bar.value)
        }
      }
    })

    it("reconciles with a month bar that holds an order placed just after Karachi midnight", async () => {
      const { body } = await compare({ ...REVENUE, dimension: "month" })
      for (const bar of body.rows) {
        const { body: lines } = await drillDown({ ...REVENUE, dimension: "month", key: bar.key })
        expect(lines.totals.valueCents, bar.key).toBe(bar.value)
      }
    })
  })

  // ── A refund recorded on the order without its lines ───────────────────

  describe("an order refunded without itemised refund lines", () => {
    let refundId: number

    // A refund on West's only order, recorded the way legacy refunds were: on
    // the order and the refund header, with no `refund_items`.
    beforeAll(async () => {
      await db.update(orders).set({ refundAmountCents: 1000 }).where(eq(orders.id, f.orderIds.P5))
      const [refund] = await db
        .insert(refunds)
        .values({
          organizationId: f.organizationId,
          orderId: f.orderIds.P5,
          amountCents: 1000,
          taxRefundCents: 0,
          status: "APPROVED",
          refundNumber: `RF-ITPF-${f.suffix}`,
          requestedByUserId: f.waliId,
          processedByUserId: f.headOfficeId,
        })
        .returning({ id: refunds.id })
      refundId = refund.id
    })

    afterAll(async () => {
      await db.delete(refunds).where(eq(refunds.id, refundId))
      await db.update(orders).set({ refundAmountCents: null }).where(eq(orders.id, f.orderIds.P5))
    })

    it("nets it out of the branch bar, and the drill-down behind that bar agrees", async () => {
      const { body } = await compare({ ...AMOUNT, dimension: "branch", branchIds: f.westBranchId })
      expect(ranked(body)).toEqual([[f.names.west, 3000]])
      const { body: lines } = await drillDown({ ...AMOUNT, dimension: "branch", key: String(f.westBranchId) })
      expect(lines.totals.valueCents).toBe(3000)
    })

    it("gives the same branch total whether or not a product is in focus", async () => {
      const unfocused = byKey((await compare({ ...AMOUNT, dimension: "branch" })).body)[f.westBranchId]
      const paperOnly = byKey((await compare({ ...AMOUNT, dimension: "branch", productIds: f.paperProductId })).body)[f.westBranchId]
      expect(paperOnly).toBe(unfocused)
    })
  })

  // A refund partly itemised and partly not, on a two-line order, at amounts
  // that do not divide evenly. P6 (East) is Toner 9000 + Paper 1000. Its order
  // refund is 833: 500 named on the Paper line and 333 named on no line. The
  // 333 is shared over what the lines still charge (Toner 9000, Paper 500):
  // 333 × 9000 / 9500 = 315.47 → Toner 315, Paper the remaining 18. So P6
  // reads Toner 8685 + Paper 482 = 9167 = 10000 − 833, and East (Amount)
  // reads B4 3000 + P2 5000 + 9167 = 17167.
  describe("a refund partly itemised, shared across lines to the paisa", () => {
    let refundIds: number[] = []

    beforeAll(async () => {
      const [paperLine] = await db
        .select({ id: orderItems.id })
        .from(orderItems)
        .where(and(eq(orderItems.orderId, f.orderIds.P6), eq(orderItems.globalProductId, f.paperProductId)))
      await db.update(orders).set({ refundAmountCents: 833 }).where(eq(orders.id, f.orderIds.P6))
      const inserted = await db
        .insert(refunds)
        .values([
          {
            organizationId: f.organizationId,
            orderId: f.orderIds.P6,
            amountCents: 500,
            taxRefundCents: 0,
            status: "APPROVED",
            refundNumber: `RF-ITPF-${f.suffix}-A`,
            requestedByUserId: f.bilalId,
            processedByUserId: f.headOfficeId,
          },
          {
            organizationId: f.organizationId,
            orderId: f.orderIds.P6,
            amountCents: 333,
            taxRefundCents: 0,
            status: "APPROVED",
            refundNumber: `RF-ITPF-${f.suffix}-B`,
            requestedByUserId: f.bilalId,
            processedByUserId: f.headOfficeId,
          },
        ])
        .returning({ id: refunds.id })
      refundIds = inserted.map((row) => row.id)
      await db.insert(refundItems).values({ refundId: refundIds[0], orderItemId: paperLine.id, quantity: 1, amountCents: 500 })
    })

    afterAll(async () => {
      await db.delete(refunds).where(inArray(refunds.id, refundIds))
      await db.update(orders).set({ refundAmountCents: null }).where(eq(orders.id, f.orderIds.P6))
    })

    it("nets the whole refund out of the branch bar, and its drill-down agrees", async () => {
      const { body } = await compare({ ...AMOUNT, dimension: "branch", branchIds: f.eastBranchId })
      expect(ranked(body)).toEqual([[f.names.east, 17167]])
      const { body: lines } = await drillDown({ ...AMOUNT, dimension: "branch", key: String(f.eastBranchId) })
      expect(lines.totals.valueCents).toBe(17167)
    })

    it("splits the un-itemised part across the products so they add up to the branch", async () => {
      const products = byKey((await compare({ ...AMOUNT, dimension: "product", branchIds: f.eastBranchId })).body)
      expect(products).toEqual({
        [f.tonerProductId]: 3000 + 8685,
        [f.paperProductId]: 2000 + 482,
        [f.dieselProductId]: 3000,
      })
      const focused = byKey((await compare({
        ...AMOUNT, dimension: "branch", productIds: `${f.paperProductId},${f.tonerProductId},${f.dieselProductId}`,
      })).body)[f.eastBranchId]
      expect(focused).toBe(17167)
    })
  })
})

describe.skipIf(hasTestDatabase)("Product Performance filter suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})
