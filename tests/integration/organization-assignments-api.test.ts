import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as assignmentsRoute from "@/app/api/v1/admin/organization-assignments/route"
import { globalProducts, organizationInventory } from "@/db/schema"
import { closePool, db } from "@/lib/db"

import {
  NO_DATABASE_REASON,
  createPricingFixtures,
  destroyPricingFixtures,
  hasTestDatabase,
  type PricingFixtures,
} from "./helpers/pricing-fixtures"

/**
 * GET /api/v1/admin/organization-assignments, end to end.
 *
 * The list is paged — 50 rows by default, 500 at most — and reports `total`
 * beside the page. The assignment page relies on both: it asks for the
 * ceiling and reads `total` for its counter, because a tenant with more than
 * one page of assignments used to be shown with the overflow "not assigned".
 * The fixtures therefore carry more assignments than one default page, so a
 * regression in either the paging or the count is visible here.
 *
 * Only the caller's identity is faked; the role check, the tenant filter,
 * the paging and the count all run for real against Postgres.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/cache-utils", () => ({ invalidateByPrefix: vi.fn(async () => {}) }))

const { getServerSession } = mockedNextAuth
const { GET } = assignmentsRoute

/** One more than the endpoint's default page. */
const ASSIGNMENTS_IN_TENANT = 51
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 500

type Actor = { id: string; role: string; organizationId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: actor } as any),
  )
}

function getRequest(query: Record<string, string>): NextRequest {
  const params = new URLSearchParams(query)
  return new NextRequest(`http://localhost/api/v1/admin/organization-assignments?${params.toString()}`)
}

type ListResponse = {
  items: Array<{ id: number; organizationId: number; globalProductId: number }>
  total: number | string
  page: number
  limit: number
}

async function list(query: Record<string, string>): Promise<ListResponse> {
  const response = await GET(getRequest(query))
  expect(response.status).toBe(200)
  return (await response.json()) as ListResponse
}

describe.skipIf(!hasTestDatabase)("organization assignments endpoint", () => {
  let fixtures: PricingFixtures
  let superAdmin: Actor
  let headOffice: Actor
  let extraProductIds: number[] = []
  let extraInventoryIds: number[] = []

  beforeAll(async () => {
    fixtures = await createPricingFixtures()
    superAdmin = { id: fixtures.userId, role: "SUPER_ADMIN", organizationId: null }
    headOffice = { id: fixtures.userId, role: "HEAD_OFFICE", organizationId: fixtures.organizationId }

    // The fixtures assign one product to the tenant; top it up past one page.
    const extraCount = ASSIGNMENTS_IN_TENANT - 1
    const products = await db
      .insert(globalProducts)
      .values(Array.from({ length: extraCount }, (_, index) => ({
        productCode: `ITA-${fixtures.suffix}-${index}`,
        name: `Integration Assignment Product ${fixtures.suffix} ${index}`,
        basePrice: 1_000,
        status: "active",
        unit: "unit",
      })))
      .returning({ id: globalProducts.id })
    extraProductIds = products.map((row) => row.id)

    const inventory = await db
      .insert(organizationInventory)
      .values(extraProductIds.map((globalProductId) => ({
        organizationId: fixtures.organizationId,
        globalProductId,
        assignedByUserId: fixtures.userId,
        isActive: true,
      })))
      .returning({ id: organizationInventory.id })
    extraInventoryIds = inventory.map((row) => row.id)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    signIn(superAdmin)
  })

  afterAll(async () => {
    if (extraInventoryIds.length > 0) {
      await db.delete(organizationInventory).where(inArray(organizationInventory.id, extraInventoryIds))
    }
    if (extraProductIds.length > 0) {
      await db.delete(globalProducts).where(inArray(globalProducts.id, extraProductIds))
    }
    if (fixtures) await destroyPricingFixtures(fixtures)
    await closePool()
  })

  function tenantQuery(extra: Record<string, string> = {}): Record<string, string> {
    return { organizationId: String(fixtures.organizationId), ...extra }
  }

  describe("access control", () => {
    it("refuses a caller with no session", async () => {
      signIn(null)
      const response = await GET(getRequest(tenantQuery()))
      expect(response.status).toBe(401)
    })

    it("refuses Head Office, even for its own organization", async () => {
      signIn(headOffice)
      const response = await GET(getRequest(tenantQuery()))
      expect(response.status).toBe(403)
    })

    it("answers Super Admin", async () => {
      const response = await GET(getRequest(tenantQuery()))
      expect(response.status).toBe(200)
    })
  })

  describe("paging and the count", () => {
    it("reports every assignment in `total` while returning one default page", async () => {
      const body = await list(tenantQuery())

      expect(Number(body.total)).toBe(ASSIGNMENTS_IN_TENANT)
      expect(body.items).toHaveLength(DEFAULT_PAGE_SIZE)
      expect(body.page).toBe(1)
      expect(body.limit).toBe(DEFAULT_PAGE_SIZE)
    })

    it("returns the whole list when asked for the ceiling", async () => {
      const body = await list(tenantQuery({ limit: String(MAX_PAGE_SIZE) }))

      expect(body.limit).toBe(MAX_PAGE_SIZE)
      expect(body.items).toHaveLength(ASSIGNMENTS_IN_TENANT)
      expect(Number(body.total)).toBe(ASSIGNMENTS_IN_TENANT)

      const returned = new Set(body.items.map((item) => item.id))
      expect(returned.has(fixtures.organizationInventoryId)).toBe(true)
      for (const id of extraInventoryIds) expect(returned.has(id)).toBe(true)
    })

    it("hands out the second page where the first left off", async () => {
      const first = await list(tenantQuery({ page: "1" }))
      const second = await list(tenantQuery({ page: "2" }))

      expect(second.page).toBe(2)
      expect(second.items).toHaveLength(ASSIGNMENTS_IN_TENANT - DEFAULT_PAGE_SIZE)
      const firstIds = new Set(first.items.map((item) => item.id))
      for (const item of second.items) expect(firstIds.has(item.id)).toBe(false)
    })

    it.each([
      ["an oversized limit", "100000", MAX_PAGE_SIZE],
      ["a negative limit", "-5", 1],
    ])("pins %s to the nearest bound", async (_label, limit, expected) => {
      const body = await list(tenantQuery({ limit }))

      expect(body.limit).toBe(expected)
      expect(body.items).toHaveLength(Math.min(expected, ASSIGNMENTS_IN_TENANT))
    })

    it.each([
      ["a word", "fifty"],
      ["zero", "0"],
      ["a fraction below one", "0.4"],
    ])("falls back to the default page size when limit is %s", async (_label, limit) => {
      const body = await list(tenantQuery({ limit }))

      expect(body.limit).toBe(DEFAULT_PAGE_SIZE)
      expect(body.items).toHaveLength(DEFAULT_PAGE_SIZE)
    })

    it.each([
      ["a word", "first"],
      ["zero", "0"],
      ["a negative", "-1"],
    ])("falls back to the first page when page is %s", async (_label, page) => {
      const body = await list(tenantQuery({ page }))

      expect(body.page).toBe(1)
      expect(body.items).toHaveLength(DEFAULT_PAGE_SIZE)
    })
  })

  describe("tenant filter", () => {
    it("returns only the named organization's assignments", async () => {
      const body = await list({ organizationId: String(fixtures.neighbourOrganizationId), limit: String(MAX_PAGE_SIZE) })

      expect(Number(body.total)).toBe(1)
      expect(body.items).toHaveLength(1)
      expect(body.items[0].id).toBe(fixtures.neighbourOrganizationInventoryId)
      expect(body.items[0].organizationId).toBe(fixtures.neighbourOrganizationId)
    })

    it("never mixes the neighbour's rows into the tenant's list", async () => {
      const body = await list(tenantQuery({ limit: String(MAX_PAGE_SIZE) }))

      for (const item of body.items) expect(item.organizationId).toBe(fixtures.organizationId)
      expect(body.items.some((item) => item.id === fixtures.neighbourOrganizationInventoryId)).toBe(false)
    })

    it("leaves a soft-deleted assignment out of both the items and the count", async () => {
      const [victim] = extraInventoryIds
      await db
        .update(organizationInventory)
        .set({ deletedAt: new Date() })
        .where(eq(organizationInventory.id, victim))
      try {
        const body = await list(tenantQuery({ limit: String(MAX_PAGE_SIZE) }))

        expect(Number(body.total)).toBe(ASSIGNMENTS_IN_TENANT - 1)
        expect(body.items.some((item) => item.id === victim)).toBe(false)
      } finally {
        await db
          .update(organizationInventory)
          .set({ deletedAt: null })
          .where(eq(organizationInventory.id, victim))
      }
    })
  })
})

describe.skipIf(hasTestDatabase)("organization assignments endpoint integration suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})
