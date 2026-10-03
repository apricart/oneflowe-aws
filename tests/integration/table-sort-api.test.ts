import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { inArray } from "drizzle-orm"

import * as ordersRoute from "@/app/api/v1/orders/route"
import * as summaryRoute from "@/app/api/v1/analytics/summary/route"
import * as refundsRoute from "@/app/api/v1/analytics/refunds/route"
import { refunds } from "@/db/schema"
import { closePool, db } from "@/lib/db"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * Column sorting on the three paginated tables (plans/OF-TABLE-column-sorting.md),
 * against Postgres through the real GET routes: the sort reaches across pages,
 * stays inside the caller's tenant, and refuses anything outside its allowlist.
 *
 * The fixture tenant holds four orders — 2,500 (Alpha South), 9,000 (Beta
 * Branch), 10,000 and 77,777 (both Alpha North) — and the foreign tenant one at
 * 99,999 that must never appear.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: vi.fn(async () => undefined),
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

const { getServerSession } = mockedNextAuth

describe.skipIf(!hasTestDatabase)("column sorting through the paginated list APIs", () => {
  let f: GroupRoleFixtures

  const signInHeadOffice = () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: f.headOfficeId,
        email: `head-${f.suffix}@example.test`,
        role: "HEAD_OFFICE",
        organizationId: f.organizationId,
        mustChangePassword: false,
      },
    } as any)
  }

  const get = async (handler: (req: NextRequest) => Promise<Response>, path: string) => {
    const response = await handler(new NextRequest(`http://localhost${path}`))
    return { status: response.status, body: await response.json() }
  }

  const listOrders = (query: string) => get(ordersRoute.GET as any, `/api/v1/orders?organizationId=${f.organizationId}&${query}`)
  const orderReport = (query: string) => get(summaryRoute.GET as any, `/api/v1/analytics/summary?organizationId=${f.organizationId}&ordersOnly=true&${query}`)
  const refundReport = (query: string) => get(refundsRoute.GET as any, `/api/v1/analytics/refunds?organizationId=${f.organizationId}&${query}`)

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
    await db.insert(refunds).values([
      { organizationId: f.organizationId, orderId: f.alphaSouthOrderId, amountCents: 500, status: "APPROVED", refundNumber: `RS-${f.suffix}-1` },
      { organizationId: f.organizationId, orderId: f.ordinaryOrderId, amountCents: 3_000, status: "PENDING", refundNumber: `RS-${f.suffix}-2` },
      { organizationId: f.foreignOrganizationId, orderId: f.foreignOrderId, amountCents: 1, status: "APPROVED", refundNumber: `RS-${f.suffix}-3` },
    ])
  })

  afterAll(async () => {
    if (!f) return
    await db.delete(refunds).where(inArray(refunds.organizationId, [f.organizationId, f.foreignOrganizationId]))
    await destroyGroupRoleFixtures(f)
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
    signInHeadOffice()
  })

  describe("GET /api/v1/orders", () => {
    it("sorts the whole filtered list before paging it, inside the caller's tenant", async () => {
      const first = await listOrders("sort=amount&dir=asc&page=1&limit=2")
      const second = await listOrders("sort=amount&dir=asc&page=2&limit=2")

      expect(first.status).toBe(200)
      expect(first.body.items.map((order: any) => order.totalCents)).toEqual([2_500, 9_000])
      expect(second.body.items.map((order: any) => order.totalCents)).toEqual([10_000, 77_777])
    })

    it("reverses with dir=desc and never reaches the foreign tenant's larger order", async () => {
      const { body } = await listOrders("sort=amount&dir=desc&limit=10")
      expect(body.items.map((order: any) => order.totalCents)).toEqual([77_777, 10_000, 9_000, 2_500])
      expect(body.items.some((order: any) => order.id === f.foreignOrderId)).toBe(false)
    })

    it("sorts text by the branch name, breaking ties by newest id", async () => {
      const { body } = await listOrders("sort=branch&dir=asc&limit=10")
      expect(body.items.map((order: any) => order.id)).toEqual([
        f.ordinaryOrderId,
        f.alphaNorthOrderId,
        f.alphaSouthOrderId,
        f.betaOrderId,
      ])
    })

    it("keeps the newest-first order without a sort", async () => {
      const { body } = await listOrders("limit=10")
      const ids = body.items.map((order: any) => order.id)
      expect(ids).toEqual([...ids].sort((a: number, b: number) => b - a))
    })

    it.each([
      ["sort=total_cents", "Invalid sort column"],
      ["sort=amount%3BDROP%20TABLE%20orders", "Invalid sort column"],
      ["sort=amount&dir=up", "Invalid sort direction"],
    ])("refuses %s with 400", async (query, error) => {
      const { status, body } = await listOrders(query)
      expect(status).toBe(400)
      expect(body.error).toBe(error)
    })
  })

  describe("GET /api/v1/analytics/summary (Order Report)", () => {
    it("sorts by net value across pages", async () => {
      const first = await orderReport("sort=netTotalValue&dir=desc&page=1&limit=2")
      const second = await orderReport("sort=netTotalValue&dir=desc&page=2&limit=2")

      expect(first.status).toBe(200)
      expect(first.body.orders.map((order: any) => order.id)).toEqual([f.ordinaryOrderId, f.alphaNorthOrderId])
      // 9,000 net for Beta, 2,000 net for Alpha South (2,500 less its 500 refund).
      expect(second.body.orders.map((order: any) => order.id)).toEqual([f.betaOrderId, f.alphaSouthOrderId])
    })

    it("refuses a key outside its allowlist", async () => {
      const { status } = await orderReport("sort=amount")
      expect(status).toBe(400)
    })
  })

  describe("GET /api/v1/analytics/refunds (Refund Report)", () => {
    it("sorts by refund amount inside the caller's tenant", async () => {
      const ascending = await refundReport("sort=amount&dir=asc")
      const descending = await refundReport("sort=amount&dir=desc")

      expect(ascending.status).toBe(200)
      expect(ascending.body.items.map((refund: any) => refund.orderId)).toEqual([f.alphaSouthOrderId, f.ordinaryOrderId])
      expect(descending.body.items.map((refund: any) => refund.orderId)).toEqual([f.ordinaryOrderId, f.alphaSouthOrderId])
    })

    it("refuses a key outside its allowlist", async () => {
      const { status } = await refundReport("sort=netTotalValue")
      expect(status).toBe(400)
    })
  })
})
