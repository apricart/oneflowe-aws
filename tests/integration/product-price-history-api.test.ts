import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as priceHistoryRoute from "@/app/api/v1/admin/product-price-history/route"
import { orderItems, orders } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import type { ProductPriceHistoryResponse } from "@/lib/product-price-history"

import {
  NO_DATABASE_REASON,
  createPricingFixtures,
  destroyPricingFixtures,
  hasTestDatabase,
  type PricingFixtures,
} from "./helpers/pricing-fixtures"

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))

const { getServerSession } = mockedNextAuth
const { GET } = priceHistoryRoute

type Actor = { id: string; role: string; organizationId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(actor === null ? null : ({ user: actor } as never))
}

function request(query: Record<string, string> = {}) {
  const params = new URLSearchParams(query)
  return new NextRequest(`http://localhost/api/v1/admin/product-price-history?${params.toString()}`)
}

async function read(query: Record<string, string> = {}) {
  const response = await GET(request(query))
  expect(response.status).toBe(200)
  return (await response.json()) as ProductPriceHistoryResponse
}

describe.skipIf(!hasTestDatabase)("product price history endpoint", () => {
  let fixtures: PricingFixtures
  const orderIds: number[] = []
  let headOffice: Actor
  let superAdmin: Actor

  beforeAll(async () => {
    fixtures = await createPricingFixtures()
    headOffice = { id: fixtures.userId, role: "HEAD_OFFICE", organizationId: fixtures.organizationId }
    superAdmin = { id: fixtures.userId, role: "SUPER_ADMIN", organizationId: null }

    const now = Date.now()
    const orderSpecs = [
      { suffix: "grouped", organizationId: fixtures.organizationId, branchId: fixtures.groupedBranchId, status: "APPROVED", price: 11_000, daysAgo: 20, inventoryId: fixtures.organizationInventoryId },
      { suffix: "loose", organizationId: fixtures.organizationId, branchId: fixtures.looseBranchId, status: "FULFILLED", price: 13_000, daysAgo: 10, inventoryId: fixtures.organizationInventoryId },
      { suffix: "foreign", organizationId: fixtures.neighbourOrganizationId, branchId: fixtures.foreignBranchId, status: "APPROVED", price: 22_000, daysAgo: 5, inventoryId: fixtures.neighbourOrganizationInventoryId },
      { suffix: "rejected", organizationId: fixtures.organizationId, branchId: fixtures.groupedBranchId, status: "REJECTED", price: 99_000, daysAgo: 2, inventoryId: fixtures.organizationInventoryId },
      { suffix: "old", organizationId: fixtures.organizationId, branchId: fixtures.groupedBranchId, status: "APPROVED", price: 9_000, daysAgo: 400, inventoryId: fixtures.organizationInventoryId },
    ]

    for (const spec of orderSpecs) {
      const createdAt = new Date(now - spec.daysAgo * 24 * 60 * 60 * 1_000)
      const [order] = await db.insert(orders).values({
        tid: `PH-${fixtures.suffix}-${spec.suffix}`.slice(0, 26),
        organizationId: spec.organizationId,
        branchId: spec.branchId,
        status: spec.status,
        subtotalCents: spec.price,
        taxCents: 0,
        totalCents: spec.price,
        createdByUserId: fixtures.userId,
        createdAt,
      }).returning({ id: orders.id })
      orderIds.push(order.id)

      await db.insert(orderItems).values({
        organizationId: spec.organizationId,
        organizationInventoryId: spec.inventoryId,
        orderId: order.id,
        globalProductId: fixtures.globalProductId,
        productName: `Integration Pricing Product ${fixtures.suffix}`,
        productCode: `ITP-${fixtures.suffix}`,
        unit: "unit",
        quantity: 1,
        priceCents: spec.price,
        createdAt,
      })
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    signIn(headOffice)
  })

  afterAll(async () => {
    if (orderIds.length > 0) {
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
      await db.delete(orders).where(inArray(orders.id, orderIds))
    }
    if (fixtures) await destroyPricingFixtures(fixtures)
    await closePool()
  })

  describe("role and tenant access", () => {
    it("rejects unauthenticated and unrelated roles", async () => {
      signIn(null)
      expect((await GET(request())).status).toBe(401)

      signIn({ ...headOffice, role: "BRANCH_ADMIN" })
      expect((await GET(request())).status).toBe(403)
    })

    it("hard-scopes Head Office to its session organization", async () => {
      const body = await read()

      expect(body.role).toBe("HEAD_OFFICE")
      expect(body.selection.organizationId).toBe(fixtures.organizationId)
      expect(body.options.organizations).toEqual([
        expect.objectContaining({ id: fixtures.organizationId }),
      ])
      expect(body.points.every((point) => point.organizationId === fixtures.organizationId)).toBe(true)

      const crossTenant = await GET(request({ organizationId: String(fixtures.neighbourOrganizationId) }))
      expect(crossTenant.status).toBe(403)
    })

    it("lets Super Admin select another organization without leaking other tenants into the result", async () => {
      signIn(superAdmin)
      const body = await read({ organizationId: String(fixtures.neighbourOrganizationId), range: "all" })

      expect(body.points.map((point) => point.chargedPriceCents)).toEqual([22_000])
      expect(body.points.every((point) => point.organizationId === fixtures.neighbourOrganizationId)).toBe(true)
    })
  })

  describe("exact charged prices and filters", () => {
    it("returns raw order-line prices without aggregate or KPI fields", async () => {
      const body = await read({ range: "1y" })

      expect(body.points.map((point) => point.chargedPriceCents)).toEqual([11_000, 13_000])
      expect(body.points.some((point) => point.chargedPriceCents === 99_000)).toBe(false)
      expect(body).not.toHaveProperty("stats")
      for (const point of body.points) {
        expect(point).not.toHaveProperty("averagePriceCents")
        expect(point).not.toHaveProperty("minimumPriceCents")
        expect(point).not.toHaveProperty("maximumPriceCents")
      }
    })

    it("filters by group and branch", async () => {
      const grouped = await read({ groupId: String(fixtures.groupId), range: "1y" })
      expect(grouped.points.map((point) => point.chargedPriceCents)).toEqual([11_000])
      expect(grouped.points[0].groupId).toBe(fixtures.groupId)

      const branch = await read({ branchId: String(fixtures.looseBranchId), range: "1y" })
      expect(branch.points.map((point) => point.chargedPriceCents)).toEqual([13_000])
      expect(branch.points[0].branchId).toBe(fixtures.looseBranchId)
    })

    it("applies the date range to the product and its exact records", async () => {
      const year = await read({ range: "1y" })
      expect(year.points.map((point) => point.chargedPriceCents)).toEqual([11_000, 13_000])

      const allTime = await read({ range: "all" })
      expect(allTime.points.map((point) => point.chargedPriceCents)).toEqual([9_000, 11_000, 13_000])
    })
  })
})

describe.skipIf(hasTestDatabase)("product price history endpoint integration suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})
