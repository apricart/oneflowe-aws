import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as priceHistoryRoute from "@/app/api/v1/admin/product-price-history/route"
import { productPriceHistory } from "@/db/schema"
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
  let headOffice: Actor
  let superAdmin: Actor

  beforeAll(async () => {
    fixtures = await createPricingFixtures()
    headOffice = { id: fixtures.userId, role: "HEAD_OFFICE", organizationId: fixtures.organizationId }
    superAdmin = { id: fixtures.userId, role: "SUPER_ADMIN", organizationId: null }

    // Fixture creation is itself captured by the database triggers. Replace
    // those rows with a small, deterministic ledger for endpoint assertions.
    await db.delete(productPriceHistory)
      .where(eq(productPriceHistory.globalProductId, fixtures.globalProductId))

    const now = Date.now()
    const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1_000)
    await db.insert(productPriceHistory).values([
      {
        globalProductId: fixtures.globalProductId,
        organizationId: fixtures.organizationId,
        groupId: fixtures.groupId,
        branchId: fixtures.groupedBranchId,
        previousPriceCents: null,
        priceCents: 9_000,
        scope: "BRANCH",
        changeType: "BACKFILLED_ORDER_PRICE",
        source: "ORDER_BACKFILL",
        changedAt: daysAgo(400),
        sourceKey: `integration-history:${fixtures.suffix}:old`,
      },
      {
        globalProductId: fixtures.globalProductId,
        organizationId: fixtures.organizationId,
        previousPriceCents: 10_000,
        priceCents: 15_000,
        scope: "ORGANIZATION",
        changeType: "PRICE_CHANGED",
        source: "CATALOG_CHANGE",
        changedAt: daysAgo(30),
      },
      {
        globalProductId: fixtures.globalProductId,
        organizationId: fixtures.organizationId,
        previousPriceCents: 15_000,
        priceCents: 0,
        scope: "ORGANIZATION",
        changeType: "PRICE_CHANGED",
        source: "CATALOG_CHANGE",
        changedAt: daysAgo(25),
      },
      {
        globalProductId: fixtures.globalProductId,
        organizationId: fixtures.organizationId,
        groupId: fixtures.groupId,
        branchId: fixtures.groupedBranchId,
        previousPriceCents: 9_000,
        priceCents: 11_000,
        scope: "BRANCH",
        changeType: "BACKFILLED_ORDER_PRICE",
        source: "ORDER_BACKFILL",
        changedAt: daysAgo(20),
        sourceKey: `integration-history:${fixtures.suffix}:grouped`,
      },
      {
        globalProductId: fixtures.globalProductId,
        organizationId: fixtures.organizationId,
        groupId: fixtures.groupId,
        branchId: fixtures.groupedBranchId,
        previousPriceCents: 11_000,
        priceCents: 11_000,
        scope: "BRANCH",
        changeType: "BACKFILLED_ORDER_PRICE",
        source: "ORDER_BACKFILL",
        changedAt: daysAgo(15),
        sourceKey: `integration-history:${fixtures.suffix}:grouped-duplicate`,
      },
      {
        globalProductId: fixtures.globalProductId,
        organizationId: fixtures.organizationId,
        branchId: fixtures.looseBranchId,
        previousPriceCents: 11_000,
        priceCents: 13_000,
        scope: "BRANCH",
        changeType: "BACKFILLED_ORDER_PRICE",
        source: "ORDER_BACKFILL",
        changedAt: daysAgo(10),
        sourceKey: `integration-history:${fixtures.suffix}:loose`,
      },
      {
        globalProductId: fixtures.globalProductId,
        organizationId: fixtures.neighbourOrganizationId,
        groupId: fixtures.neighbourGroupId,
        branchId: fixtures.foreignBranchId,
        previousPriceCents: null,
        priceCents: 22_000,
        scope: "BRANCH",
        changeType: "BACKFILLED_ORDER_PRICE",
        source: "ORDER_BACKFILL",
        changedAt: daysAgo(5),
        sourceKey: `integration-history:${fixtures.suffix}:foreign`,
      },
      {
        globalProductId: fixtures.globalProductId,
        organizationId: fixtures.neighbourOrganizationId,
        groupId: fixtures.neighbourGroupId,
        branchId: fixtures.foreignBranchId,
        previousPriceCents: 22_000,
        priceCents: 24_000,
        scope: "BRANCH",
        changeType: "BACKFILLED_ORDER_PRICE",
        source: "ORDER_BACKFILL",
        changedAt: daysAgo(3),
        sourceKey: `integration-history:${fixtures.suffix}:foreign-change`,
      },
      {
        globalProductId: fixtures.globalProductId,
        previousPriceCents: 40_000,
        priceCents: 50_000,
        scope: "GLOBAL",
        changeType: "PRICE_CHANGED",
        source: "CATALOG_CHANGE",
        changedAt: daysAgo(1),
      },
    ])
  })

  beforeEach(() => {
    vi.clearAllMocks()
    signIn(headOffice)
  })

  afterAll(async () => {
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

    it("hard-scopes Head Office to its organization and never exposes the global tier", async () => {
      const body = await read()

      expect(body.role).toBe("HEAD_OFFICE")
      expect(body.selection.organizationId).toBe(fixtures.organizationId)
      expect(body.options.organizations).toEqual([
        expect.objectContaining({ id: fixtures.organizationId }),
      ])
      expect(body.points.every((point) => point.organizationId === fixtures.organizationId)).toBe(true)
      expect(body.points.some((point) => point.scope === "GLOBAL")).toBe(false)

      const crossTenant = await GET(request({ organizationId: String(fixtures.neighbourOrganizationId) }))
      expect(crossTenant.status).toBe(403)
    })

    it("lets Super Admin select another organization without leaking other tenants", async () => {
      signIn(superAdmin)
      const body = await read({ organizationId: String(fixtures.neighbourOrganizationId), range: "all" })

      expect(body.points.map((point) => point.priceCents)).toEqual([24_000])
      expect(body.points.every((point) => point.organizationId === fixtures.neighbourOrganizationId)).toBe(true)
    })
  })

  describe("ledger records and filters", () => {
    it("returns price changes from the ledger, not order-line fields", async () => {
      const body = await read({ range: "1y" })

      expect(body.points.map((point) => point.priceCents)).toEqual([15_000, 11_000, 13_000])
      expect(body.points.map((point) => point.source)).toEqual([
        "CATALOG_CHANGE", "ORDER_BACKFILL", "ORDER_BACKFILL",
      ])
      expect(body.points.every((point) => point.priceCents > 0)).toBe(true)
      expect(body.selectedProduct?.recordCount).toBe(3)
      expect(body).not.toHaveProperty("stats")
      for (const point of body.points) {
        expect(point).not.toHaveProperty("orderId")
        expect(point).not.toHaveProperty("quantity")
        expect(point).not.toHaveProperty("orderReference")
      }
    })

    it("retains parent-tier changes when filtering by group or branch", async () => {
      const grouped = await read({ groupId: String(fixtures.groupId), range: "1y" })
      expect(grouped.points.map((point) => point.priceCents)).toEqual([15_000, 11_000])

      const branch = await read({ branchId: String(fixtures.looseBranchId), range: "1y" })
      expect(branch.points.map((point) => point.priceCents)).toEqual([15_000, 13_000])
      expect(branch.points.at(-1)?.branchId).toBe(fixtures.looseBranchId)
    })

    it("applies the date range to products and their price-change records", async () => {
      const year = await read({ range: "1y" })
      expect(year.points.map((point) => point.priceCents)).toEqual([15_000, 11_000, 13_000])

      const allTime = await read({ range: "all" })
      expect(allTime.points.map((point) => point.priceCents)).toEqual([15_000, 11_000, 13_000])
      expect(allTime.points.some((point) => point.previousPriceCents === null)).toBe(false)
    })
  })
})

describe.skipIf(hasTestDatabase)("product price history endpoint integration suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})
