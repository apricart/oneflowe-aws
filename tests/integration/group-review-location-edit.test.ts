import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray } from "drizzle-orm"

import * as catalogRoute from "@/app/api/v1/group-portal/catalog/route"
import * as groupOrdersRoute from "@/app/api/v1/group-portal/orders/route"
import {
  branchInventory,
  budgets,
  emailOutbox,
  globalProducts,
  groupAuditLogs,
  groupOrders,
  invoiceSequences,
  notifications,
  orderItems,
  orders,
  organizationInventory,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { currentBudgetPeriod } from "@/lib/server/group-branch-budgets"
import {
  branchPlansToEntries,
  mergeEntriesIntoBranchPlans,
  replaceBranchPlanLines,
  toRequestEntries,
} from "@/components/group-portal/group-order-plan"
import type { BranchPlan, SelectedLine } from "@/components/group-portal/types"

import {
  NO_DATABASE_REASON,
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * Editing one location on the group order review screen, end to end.
 *
 * The editor is client-side: it reads the group catalogue narrowed to one
 * location, edits that location's lines, and the review screen rebuilds the
 * submission from the edited per-location plans. Every assumption it makes is
 * the server's to keep, so this drives the real catalogue and group order
 * routes against Postgres with payloads built by the real client plan code:
 *
 *  - the one-location catalogue offers a product the multi-location one hides,
 *    and is fenced to the requester's scope;
 *  - a product added to (or removed from) one location reaches that location's
 *    order and no other;
 *  - a line for a product the location does not stock fails that location
 *    alone, which is the backstop behind the editor only offering its own
 *    catalogue.
 *
 * Only the session, request headers, rate limiter, cache and outbound email are
 * faked.
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
vi.mock("@/lib/server/order-notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/order-notifications")>()
  return { ...actual, attemptImmediateOrderEmailDelivery: vi.fn(async () => undefined) }
})

const { getServerSession } = mockedNextAuth
const { GET: getCatalog } = catalogRoute
const { POST: createGroupOrder } = groupOrdersRoute

type CatalogBody = {
  items: Array<{ organizationInventoryId: number; name: string; priceCents: number; unit: string }>
  total: number
  excludedProductCount: number
}

type BranchResult = {
  status: "created" | "failed"
  branchId: number
  orderId?: number
  reason?: string
}

let idempotencyCounter = 0
const idempotencyKey = () => `rle-it-${Date.now().toString(36)}-${(idempotencyCounter += 1)}`

describe.skipIf(!hasTestDatabase)("editing one location on the group order review screen", () => {
  let f: GroupRoleFixtures
  /** Stocked at both Alpha locations. Decimal, in halves (fixture product). */
  let sharedInventoryId: number
  /** Stocked at Alpha North only — what the editor exists to add. */
  let northOnlyInventoryId: number
  let northOnlyProductId: number

  const signInRequester = () => {
    vi.mocked(getServerSession).mockResolvedValue({
      user: {
        id: f.requesterId,
        email: `rq-${f.suffix}@example.test`,
        role: "GROUP_ORDER_PORTAL",
        organizationId: f.organizationId,
        mustChangePassword: false,
      },
    } as any)
  }

  const catalog = async (branchIds: number[], groupId: number | null = f.alphaGroupId) => {
    const params = new URLSearchParams({ branchIds: branchIds.join(","), sort: "name" })
    if (groupId !== null) params.set("groupId", String(groupId))
    const response = await getCatalog(new NextRequest(`http://localhost/api/v1/group-portal/catalog?${params}`))
    return { status: response.status, body: (await response.json()) as CatalogBody }
  }

  const submit = async (entries: ReturnType<typeof toRequestEntries>) => {
    const response = await createGroupOrder(new NextRequest("http://localhost/api/v1/group-portal/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({ groupId: f.alphaGroupId, entries }),
    }))
    return { status: response.status, body: await response.json() }
  }

  /** What each created order actually holds, as `[inventoryId, quantity]` pairs. */
  const storedItems = async (orderId: number) => {
    const rows = await db
      .select({ id: orderItems.organizationInventoryId, quantity: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
    return rows
      .map((row) => [row.id, Number(row.quantity)] as const)
      .sort(([left], [right]) => (left ?? 0) - (right ?? 0))
  }

  const resultFor = (results: BranchResult[], branchId: number) =>
    results.find((result) => result.branchId === branchId)

  /** The review screen as the storefront opens it: one cart for every ticked location. */
  const reviewPlans = (lines: SelectedLine[]): BranchPlan[] => {
    const branchesById = new Map([f.alphaNorthId, f.alphaSouthId].map((id) => [id, {
      id,
      name: id === f.alphaNorthId ? "North" : "South",
      city: null,
      costCenterId: null,
      groupId: f.alphaGroupId,
    }]))
    return mergeEntriesIntoBranchPlans(
      [{ key: "cart", branchIds: [...branchesById.keys()], lines }],
      branchesById,
    )
  }

  const line = (organizationInventoryId: number, quantity: number, quantityStep = 1): SelectedLine => ({
    organizationInventoryId,
    quantity,
    name: `Product ${organizationInventoryId}`,
    unit: "kg",
    priceCents: 1_000,
    allowDecimalQuantity: quantityStep !== 1,
    quantityStep,
  })

  const linesOf = (plans: BranchPlan[], branchId: number) =>
    plans.find((plan) => plan.branch.id === branchId)?.lines ?? []

  /** The payload the storefront sends for an edited set of plans. */
  const payloadFor = (plans: BranchPlan[]) => {
    let key = 0
    return toRequestEntries(branchPlansToEntries(plans, () => `k${(key += 1)}`))
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()

    const [northOnly] = await db
      .insert(globalProducts)
      .values({
        productCode: `ITGR-RLE-${f.suffix}`,
        name: `Review Location Edit Product ${f.suffix}`,
        basePrice: 2_000,
        status: "active",
        unit: "pcs",
        stockQuantity: 1_000,
      })
      .returning({ id: globalProducts.id })
    northOnlyProductId = northOnly.id
    await db.update(globalProducts).set({ stockQuantity: 1_000 }).where(eq(globalProducts.id, f.productId))

    const inventory = await db
      .insert(organizationInventory)
      .values([
        { organizationId: f.organizationId, globalProductId: f.productId, assignedByUserId: f.headOfficeId, isActive: true },
        { organizationId: f.organizationId, globalProductId: northOnlyProductId, assignedByUserId: f.headOfficeId, isActive: true },
      ])
      .returning({ id: organizationInventory.id, globalProductId: organizationInventory.globalProductId })
    sharedInventoryId = inventory.find((row) => row.globalProductId === f.productId)!.id
    northOnlyInventoryId = inventory.find((row) => row.globalProductId === northOnlyProductId)!.id

    await db.insert(branchInventory).values([
      { branchId: f.alphaNorthId, organizationId: f.organizationId, organizationInventoryId: sharedInventoryId, assignedByUserId: f.headOfficeId },
      { branchId: f.alphaSouthId, organizationId: f.organizationId, organizationInventoryId: sharedInventoryId, assignedByUserId: f.headOfficeId },
      { branchId: f.alphaNorthId, organizationId: f.organizationId, organizationInventoryId: northOnlyInventoryId, assignedByUserId: f.headOfficeId },
    ])

    // Alpha North's fixture row leaves 550 rupees; give both locations ample
    // money so every refusal below is about the catalogue, never the budget.
    await db
      .update(budgets)
      .set({ amountAllocatedCents: 10_000_000 })
      .where(and(eq(budgets.branchId, f.alphaNorthId), eq(budgets.period, currentBudgetPeriod())))
    await db.insert(budgets).values({
      organizationId: f.organizationId,
      branchId: f.alphaSouthId,
      period: currentBudgetPeriod(),
      amountAllocatedCents: 10_000_000,
    })
  })

  afterAll(async () => {
    if (!f) return
    const organizationIds = [f.organizationId, f.foreignOrganizationId]
    await db.delete(notifications).where(inArray(notifications.organizationId, organizationIds))
    await db.delete(emailOutbox).where(inArray(emailOutbox.organizationId, organizationIds))
    await db.delete(orderItems).where(inArray(orderItems.organizationId, organizationIds))
    await db.delete(orders).where(inArray(orders.organizationId, organizationIds))
    await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.organizationId, organizationIds))
    await db.delete(groupOrders).where(inArray(groupOrders.organizationId, organizationIds))
    await db.delete(invoiceSequences).where(inArray(invoiceSequences.organizationId, organizationIds))
    await db.delete(branchInventory).where(inArray(branchInventory.organizationInventoryId, [sharedInventoryId, northOnlyInventoryId]))
    await db.delete(organizationInventory).where(inArray(organizationInventory.id, [sharedInventoryId, northOnlyInventoryId]))
    await destroyGroupRoleFixtures(f)
    await db.delete(globalProducts).where(eq(globalProducts.id, northOnlyProductId))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
    signInRequester()
  })

  describe("the one-location catalogue the editor reads", () => {
    it("hides a product stocked at only one location from the multi-location storefront", async () => {
      const { status, body } = await catalog([f.alphaNorthId, f.alphaSouthId])

      expect(status).toBe(200)
      expect(body.items.map((item) => item.organizationInventoryId)).toEqual([sharedInventoryId])
      expect(body.excludedProductCount).toBe(1)
    })

    it("offers that product when narrowed to the location that stocks it", async () => {
      const { status, body } = await catalog([f.alphaNorthId])

      expect(status).toBe(200)
      expect(body.items.map((item) => item.organizationInventoryId).sort((a, b) => a - b))
        .toEqual([sharedInventoryId, northOnlyInventoryId].sort((a, b) => a - b))
      expect(body.excludedProductCount).toBe(0)
    })

    it("never offers it at a location that does not stock it", async () => {
      const { body } = await catalog([f.alphaSouthId])

      expect(body.items.map((item) => item.organizationInventoryId)).toEqual([sharedInventoryId])
    })

    it("refuses a location outside the requester's scope instead of listing its catalogue", async () => {
      const foreign = await catalog([f.foreignBranchId], f.foreignGroupId)
      expect(foreign.status).toBeGreaterThanOrEqual(400)
      expect(foreign.body.items).toBeUndefined()

      // A location from a group the requester holds, named under the wrong group.
      const wrongGroup = await catalog([f.betaBranchId], f.alphaGroupId)
      expect(wrongGroup.status).toBeGreaterThanOrEqual(400)
      expect(wrongGroup.body.items).toBeUndefined()
    })

    it("refuses an unauthenticated read", async () => {
      vi.mocked(getServerSession).mockResolvedValue(null)
      const { status } = await catalog([f.alphaNorthId])
      expect(status).toBe(401)
    })
  })

  describe("submitting after a one-location edit", () => {
    it("orders a product added to one location for that location only", async () => {
      const plans = reviewPlans([line(sharedInventoryId, 2, 0.5)])
      const edited = replaceBranchPlanLines(plans, f.alphaNorthId, [
        ...linesOf(plans, f.alphaNorthId),
        line(northOnlyInventoryId, 3),
      ])

      const { status, body } = await submit(payloadFor(edited))

      expect(status).toBe(201)
      const results = body.item.results as BranchResult[]
      expect(results).toHaveLength(2)
      const north = resultFor(results, f.alphaNorthId)!
      const south = resultFor(results, f.alphaSouthId)!
      expect(north.status).toBe("created")
      expect(south.status).toBe("created")
      expect(await storedItems(north.orderId!)).toEqual([[sharedInventoryId, 2], [northOnlyInventoryId, 3]])
      expect(await storedItems(south.orderId!)).toEqual([[sharedInventoryId, 2]])

      // Still one group order, carrying both branch orders.
      const created = await db
        .select({ groupOrderId: orders.groupOrderId })
        .from(orders)
        .where(inArray(orders.id, [north.orderId!, south.orderId!]))
      expect(new Set(created.map((row) => row.groupOrderId)).size).toBe(1)
      expect(body.item.createdOrderCount).toBe(2)
    })

    it("removes a product from one location and leaves the other's order intact", async () => {
      const plans = reviewPlans([line(sharedInventoryId, 1, 0.5)])
      const withExtra = replaceBranchPlanLines(plans, f.alphaNorthId, [
        ...linesOf(plans, f.alphaNorthId),
        line(northOnlyInventoryId, 1),
      ])
      // Then the shared product is taken off North in the same editor.
      const edited = replaceBranchPlanLines(withExtra, f.alphaNorthId, [line(northOnlyInventoryId, 1)])

      const { status, body } = await submit(payloadFor(edited))

      expect(status).toBe(201)
      const results = body.item.results as BranchResult[]
      expect(await storedItems(resultFor(results, f.alphaNorthId)!.orderId!)).toEqual([[northOnlyInventoryId, 1]])
      expect(await storedItems(resultFor(results, f.alphaSouthId)!.orderId!)).toEqual([[sharedInventoryId, 1]])
    })

    it("keeps a location's own decimal quantity through the round trip", async () => {
      const plans = reviewPlans([line(sharedInventoryId, 1, 0.5)])
      const edited = replaceBranchPlanLines(plans, f.alphaSouthId, [line(sharedInventoryId, 2.5, 0.5)])

      const { status, body } = await submit(payloadFor(edited))

      expect(status).toBe(201)
      const results = body.item.results as BranchResult[]
      expect(await storedItems(resultFor(results, f.alphaNorthId)!.orderId!)).toEqual([[sharedInventoryId, 1]])
      expect(await storedItems(resultFor(results, f.alphaSouthId)!.orderId!)).toEqual([[sharedInventoryId, 2.5]])
    })

    it("fails only the location given a product it does not stock", async () => {
      // The editor never offers this, but a stale page or a hand-made request
      // could: the server must refuse that location and still serve the other.
      const plans = reviewPlans([line(sharedInventoryId, 1, 0.5)])
      const edited = replaceBranchPlanLines(plans, f.alphaSouthId, [
        ...linesOf(plans, f.alphaSouthId),
        line(northOnlyInventoryId, 1),
      ])

      const { status, body } = await submit(payloadFor(edited))

      expect(status).toBe(201)
      const results = body.item.results as BranchResult[]
      const north = resultFor(results, f.alphaNorthId)!
      const south = resultFor(results, f.alphaSouthId)!
      expect(north.status).toBe("created")
      expect(await storedItems(north.orderId!)).toEqual([[sharedInventoryId, 1]])
      expect(south.status).toBe("failed")
      expect(south.reason).toBeTruthy()

      const southOrders = await db
        .select({ id: orders.id })
        .from(orders)
        .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
        .where(and(eq(orders.branchId, f.alphaSouthId), eq(orderItems.organizationInventoryId, northOnlyInventoryId)))
      expect(southOrders).toHaveLength(0)
    })
  })
})

describe.skipIf(hasTestDatabase)("review location edit integration suite", () => {
  it(NO_DATABASE_REASON, () => {})
})
