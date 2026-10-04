import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { eq } from "drizzle-orm"

import * as ordersRoute from "@/app/api/v1/orders/route"
import { orders } from "@/db/schema"
import { closePool, db } from "@/lib/db"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * A status tab lists exactly the rows its summary card counts. `orders.status`
 * has no check constraint, so a row stored as "pending" was counted by the
 * card (`UPPER(status)`) and dropped by the tab (exact match) — the Pending
 * Approval card read 2 over an empty table.
 *
 * The fixture tenant holds two PENDING orders, one APPROVED and one REJECTED;
 * the foreign tenant one PENDING that must never appear.
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

describe.skipIf(!hasTestDatabase)("order list status tabs agree with their cards", () => {
  let f: GroupRoleFixtures

  const listOrders = async (query: string) => {
    const response = await ordersRoute.GET(
      new NextRequest(`http://localhost/api/v1/orders?organizationId=${f.organizationId}&${query}`),
    )
    return { status: response.status, body: await response.json() }
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
    await db.update(orders).set({ status: "pending" }).where(eq(orders.id, f.ordinaryOrderId))
    await db.update(orders).set({ status: "Approved" }).where(eq(orders.id, f.alphaSouthOrderId))
    await db.update(orders).set({ status: "Pending" }).where(eq(orders.id, f.foreignOrderId))
  })

  afterAll(async () => {
    if (!f) return
    await destroyGroupRoleFixtures(f)
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: f.headOfficeId,
        email: `head-${f.suffix}@example.test`,
        role: "HEAD_OFFICE",
        organizationId: f.organizationId,
        mustChangePassword: false,
      },
    } as any)
  })

  it("lists a pending order whatever the case of its stored status", async () => {
    const { status, body } = await listOrders("status=pending&limit=50")

    expect(status).toBe(200)
    expect(body.items.map((order: any) => order.id).sort((a: number, b: number) => a - b))
      .toEqual([f.alphaNorthOrderId, f.ordinaryOrderId].sort((a, b) => a - b))
    expect(body.summary.pending).toBe(2)
    expect(body.pagination.total).toBe(2)
  })

  it("never reaches the foreign tenant's mixed-case pending order", async () => {
    const { body } = await listOrders("status=pending&limit=50")
    expect(body.items.some((order: any) => order.id === f.foreignOrderId)).toBe(false)
  })

  it.each(["pending", "approved", "rejected"] as const)(
    "the %s tab lists as many rows as its card counts",
    async (tab) => {
      const { body } = await listOrders(`status=${tab}&limit=50`)
      expect(body.items).toHaveLength(body.summary[tab])
      expect(body.pagination.total).toBe(body.summary[tab])
    },
  )
})
