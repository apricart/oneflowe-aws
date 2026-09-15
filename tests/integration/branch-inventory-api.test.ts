import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as inventoryRoute from "@/app/api/v1/branch/inventory/route"
import { branchInventory, globalProducts, organizationInventory } from "@/db/schema"
import { closePool, db } from "@/lib/db"

import {
  NO_DATABASE_REASON,
  createPricingFixtures,
  destroyPricingFixtures,
  hasTestDatabase,
  type PricingFixtures,
} from "./helpers/pricing-fixtures"

/**
 * GET /api/v1/branch/inventory, end to end — the query the shop runs.
 *
 * The list is paged, 50 rows by default and 1,000 at most, and reports
 * `total` beside the page. The shop and the branch inventory page search and
 * filter on the client, so they ask for the ceiling; a branch stocking more
 * than one default page used to show its buyers only the first 50 products.
 * The fixture branch therefore carries one product more than a default page.
 *
 * Only the caller's identity is faked. Redis is replaced by pass-throughs so
 * every read hits Postgres: the tenant predicate, the visibility rules, the
 * paging and the count all run for real.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
    coalesceInFlight: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
    invalidateByPrefix: vi.fn(async () => {}),
  }
})

const { getServerSession } = mockedNextAuth
const { GET } = inventoryRoute

/** One more than the endpoint's default page. */
const PRODUCTS_AT_BRANCH = 51
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 1_000

type Actor = { id: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: actor } as any),
  )
}

function getRequest(query: Record<string, string> = {}): NextRequest {
  const params = new URLSearchParams(query)
  return new NextRequest(`http://localhost/api/v1/branch/inventory?${params.toString()}`)
}

type ListResponse = {
  items: Array<{ id: number; organizationInventoryId: number; branchId?: number }>
  total: number
  page: number
  limit: number
}

async function list(query: Record<string, string> = {}): Promise<ListResponse> {
  const response = await GET(getRequest(query))
  expect(response.status).toBe(200)
  return (await response.json()) as ListResponse
}

describe.skipIf(!hasTestDatabase)("branch inventory endpoint", () => {
  let fixtures: PricingFixtures
  let orderPortal: Actor
  let neighbourBranchAdmin: Actor
  let superAdmin: Actor
  let extraProductIds: number[] = []
  let extraInventoryIds: number[] = []
  let branchRowIds: number[] = []

  beforeAll(async () => {
    fixtures = await createPricingFixtures()
    orderPortal = {
      id: fixtures.userId,
      role: "ORDER_PORTAL",
      organizationId: fixtures.organizationId,
      branchId: fixtures.looseBranchId,
    }
    // A neighbour whose session names our branch: the tenant predicate, not
    // the branch id alone, decides what comes back.
    neighbourBranchAdmin = {
      id: fixtures.userId,
      role: "BRANCH_ADMIN",
      organizationId: fixtures.neighbourOrganizationId,
      branchId: fixtures.looseBranchId,
    }
    superAdmin = { id: fixtures.userId, role: "SUPER_ADMIN", organizationId: null, branchId: null }

    // The fixtures assign one product to the tenant; top it up past one page
    // and stock every one of them at the loose branch.
    const extraCount = PRODUCTS_AT_BRANCH - 1
    const products = await db
      .insert(globalProducts)
      .values(Array.from({ length: extraCount }, (_, index) => ({
        productCode: `ITB-${fixtures.suffix}-${index}`,
        name: `Integration Branch Product ${fixtures.suffix} ${index}`,
        basePrice: 1_000,
        status: "active",
        unit: "unit",
        stockQuantity: 10,
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

    const branchRows = await db
      .insert(branchInventory)
      .values([fixtures.organizationInventoryId, ...extraInventoryIds].map((organizationInventoryId) => ({
        branchId: fixtures.looseBranchId,
        organizationId: fixtures.organizationId,
        organizationInventoryId,
        assignedByUserId: fixtures.userId,
        isVisible: true,
        isActive: true,
      })))
      .returning({ id: branchInventory.id })
    branchRowIds = branchRows.map((row) => row.id)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    signIn(orderPortal)
  })

  afterAll(async () => {
    if (branchRowIds.length > 0) {
      await db.delete(branchInventory).where(inArray(branchInventory.id, branchRowIds))
    }
    if (extraInventoryIds.length > 0) {
      await db.delete(organizationInventory).where(inArray(organizationInventory.id, extraInventoryIds))
    }
    if (extraProductIds.length > 0) {
      await db.delete(globalProducts).where(inArray(globalProducts.id, extraProductIds))
    }
    if (fixtures) await destroyPricingFixtures(fixtures)
    await closePool()
  })

  describe("access control", () => {
    it("refuses a caller with no session", async () => {
      signIn(null)
      const response = await GET(getRequest())
      expect(response.status).toBe(401)
    })

    it("refuses an administrator who names no branch", async () => {
      signIn(superAdmin)
      const response = await GET(getRequest())
      expect(response.status).toBe(400)
    })

    it("scopes an Order Portal user to the branch in the session, whatever the query says", async () => {
      const body = await list({
        branchId: String(fixtures.foreignBranchId),
        organizationId: String(fixtures.neighbourOrganizationId),
        limit: String(MAX_PAGE_SIZE),
      })

      expect(body.total).toBe(PRODUCTS_AT_BRANCH)
    })
  })

  describe("the shop's query", () => {
    it("returns every product the branch stocks when asked for the ceiling", async () => {
      const body = await list({
        visibility: "visible",
        includeQuantityBudget: "true",
        limit: String(MAX_PAGE_SIZE),
      })

      expect(body.limit).toBe(MAX_PAGE_SIZE)
      expect(body.total).toBe(PRODUCTS_AT_BRANCH)
      expect(body.items).toHaveLength(PRODUCTS_AT_BRANCH)

      const returned = new Set(body.items.map((item) => item.organizationInventoryId))
      expect(returned.has(fixtures.organizationInventoryId)).toBe(true)
      for (const id of extraInventoryIds) expect(returned.has(id)).toBe(true)
    })

    it("reports every product in `total` while returning one default page without a limit", async () => {
      const body = await list({ visibility: "visible", includeQuantityBudget: "true" })

      expect(body.total).toBe(PRODUCTS_AT_BRANCH)
      expect(body.items).toHaveLength(DEFAULT_PAGE_SIZE)
      expect(body.limit).toBe(DEFAULT_PAGE_SIZE)
    })
  })

  describe("paging bounds", () => {
    it("hands out the second page where the first left off", async () => {
      const first = await list({ page: "1" })
      const second = await list({ page: "2" })

      expect(second.page).toBe(2)
      expect(second.items).toHaveLength(PRODUCTS_AT_BRANCH - DEFAULT_PAGE_SIZE)
      const firstIds = new Set(first.items.map((item) => item.id))
      for (const item of second.items) expect(firstIds.has(item.id)).toBe(false)
    })

    it.each([
      ["an oversized limit", "100000", MAX_PAGE_SIZE],
      ["a negative limit", "-5", 1],
    ])("pins %s to the nearest bound", async (_label, limit, expected) => {
      const body = await list({ limit })

      expect(body.limit).toBe(expected)
      expect(body.items).toHaveLength(Math.min(expected, PRODUCTS_AT_BRANCH))
    })

    it.each([
      ["a word", "fifty"],
      ["zero", "0"],
      ["a fraction below one", "0.4"],
    ])("falls back to the default page size when limit is %s", async (_label, limit) => {
      const body = await list({ limit })

      expect(body.limit).toBe(DEFAULT_PAGE_SIZE)
      expect(body.items).toHaveLength(DEFAULT_PAGE_SIZE)
    })

    it.each([
      ["a word", "first"],
      ["zero", "0"],
      ["a negative", "-1"],
    ])("falls back to the first page when page is %s", async (_label, page) => {
      const body = await list({ page })

      expect(body.page).toBe(1)
      expect(body.items).toHaveLength(DEFAULT_PAGE_SIZE)
    })
  })

  describe("tenant isolation", () => {
    it("shows a neighbouring tenant nothing at this branch, even with the branch in its session", async () => {
      signIn(neighbourBranchAdmin)
      const body = await list({ limit: String(MAX_PAGE_SIZE) })

      expect(body.total).toBe(0)
      expect(body.items).toHaveLength(0)
    })

    it("shows a branch of the same tenant only its own rows", async () => {
      signIn({ ...orderPortal, branchId: fixtures.groupedBranchId })
      const body = await list({ limit: String(MAX_PAGE_SIZE) })

      expect(body.total).toBe(0)
      expect(body.items).toHaveLength(0)
    })
  })
})

describe.skipIf(hasTestDatabase)("branch inventory endpoint integration suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})
