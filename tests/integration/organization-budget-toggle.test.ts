import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, or } from "drizzle-orm"

import * as organizationsRoute from "@/app/api/v1/organizations/route"
import * as organizationRoute from "@/app/api/v1/organizations/[id]/route"
import * as budgetPolicyRoute from "@/app/api/v1/organizations/budget-policy/route"
import * as ordersRoute from "@/app/api/v1/orders/route"
import * as orderRoute from "@/app/api/v1/orders/[id]/route"
import * as orderRefundsRoute from "@/app/api/v1/orders/[id]/refunds/route"
import * as adminRefundsRoute from "@/app/api/v1/admin/refunds/route"
import * as deleteOrderRoute from "@/app/api/v1/admin/delete-order/route"
import * as budgetsRoute from "@/app/api/v1/budgets/route"
import * as budgetSummaryRoute from "@/app/api/v1/analytics/budgets/summary/route"
import * as executiveOverviewRoute from "@/app/api/v1/analytics/executive/overview/route"
import * as groupOrdersRoute from "@/app/api/v1/group-portal/orders/route"
import * as groupBudgetsRoute from "@/app/api/v1/group-portal/budgets/route"
import {
  auditLogs,
  branchInventory,
  branches,
  budgets,
  emailOutbox,
  globalProducts,
  groupAuditLogs,
  groupOrders,
  groups,
  invoiceSequences,
  notifications,
  orderItems,
  orders,
  organizationInventory,
  organizationSettings,
  organizations,
  refundItems,
  refunds,
  roles,
  systemLogs,
  userGroupAssignments,
  users,
} from "@/db/schema"
import { budgetPeriodOf } from "@/lib/budget-consumption"
import { closePool, db } from "@/lib/db"
import { ORGANIZATION_BUDGETS_AUDIT_ACTION } from "@/lib/organization-budget-policy"
import { approveOrder, rejectOrder } from "@/lib/server/order-decision-service"
import { fulfillApprovedOrder } from "@/lib/server/order-fulfillment"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The organization "Budget allocation" switch, end to end, against Postgres.
 *
 * Only identity, request headers, the rate limiter, the cache and outbound
 * email are faked. Every route below is the real handler and every ledger
 * figure is read back from the `budgets` table, so each assertion is about
 * money that was (or was not) actually moved.
 *
 * The oracle. The product costs 500 (PKR 5.00) a unit, tax-inclusive, so an
 * order of n units totals 500·n exactly.
 *
 * ```text
 * OFF tenant (budgets_enabled = false)
 *   Branch A   kept ledger row this month: allocated 1,000  spent 200  held 0
 *              → 800 "remaining", which must never limit or record an order
 *   Branch A2  no ledger row at all; one must never be opened
 * ON tenant (column default: true)
 *   Branch B   ledger row this month: allocated 2,000  spent 0  held 0
 * ```
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

const UNIT_PRICE = 500
const PERIOD = budgetPeriodOf(new Date())

/**
 * A report window from the first of last month to the last of next month.
 * The ledger is keyed on the UTC month and the reports on the Karachi month,
 * which differ for five hours at every month boundary; a window spanning both
 * keeps these assertions about the switch, not about the clock.
 */
function monthOffset(offset: number, day: "first" | "last"): string {
  const date = new Date()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + offset + (day === "last" ? 1 : 0))
  if (day === "last") date.setUTCDate(0)
  return date.toISOString().slice(0, 10)
}
const WINDOW_START = monthOffset(-1, "first")
const WINDOW_END = monthOffset(1, "last")

type Actor = {
  id: string
  email: string
  role: string
  organizationId: number | null
  branchId: number | null
}

function signIn(actor: Actor) {
  vi.mocked(getServerSession).mockResolvedValue({ user: { ...actor, mustChangePassword: false } } as any)
}

const json = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })

async function read(response: Response) {
  return { status: response.status, body: await response.json() }
}

let idempotencyCounter = 0
const idempotencyKey = () => `bt-it-${Date.now().toString(36)}-${(idempotencyCounter += 1)}`

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by budget toggle integration tests" })
    .returning({ id: roles.id })
  return created.id
}

describe.skipIf(!hasTestDatabase)("organization budget allocation switch through the API", () => {
  const suffix = randomUUID().slice(0, 8)
  const createdOrganizationIds: number[] = []

  let offOrgId: number
  let onOrgId: number
  let branchA: number
  let branchA2: number
  let branchB: number
  let groupId: number
  let productId: number
  let inventoryOff: number
  let inventoryOn: number

  const actors: Record<string, Actor> = {}
  let orderItemOf: (orderId: number) => Promise<number>

  const ledger = async (branchId: number) => {
    const rows = await db
      .select({
        allocated: budgets.amountAllocatedCents,
        spent: budgets.amountSpentCents,
        held: budgets.amountHeldCents,
        credited: budgets.amountCreditedCents,
      })
      .from(budgets)
      .where(eq(budgets.branchId, branchId))
    return rows
  }

  const storedOrder = async (orderId: number) => {
    const [row] = await db
      .select({
        status: orders.status,
        totalCents: orders.totalCents,
        budgetTracked: orders.budgetTracked,
        refundAmountCents: orders.refundAmountCents,
        approvalToken: orders.approvalToken,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
    return row
  }

  const stock = async () => {
    const [row] = await db.select({ stock: globalProducts.stockQuantity }).from(globalProducts)
      .where(eq(globalProducts.id, productId))
    return Number(row.stock)
  }

  const placeOrder = async (actor: Actor, quantity: number, branchId?: number) => {
    signIn(actor)
    const inventoryId = actor.organizationId === offOrgId ? inventoryOff : inventoryOn
    return read(await ordersRoute.POST(json(
      "http://localhost/api/v1/orders",
      "POST",
      {
        ...(branchId ? { branchId } : {}),
        items: [{ organizationInventoryId: inventoryId, quantity }],
      },
      { "Idempotency-Key": idempotencyKey() },
    )))
  }

  const patchOrganization = async (actor: Actor, organizationId: number, body: unknown) => {
    signIn(actor)
    return read(await organizationRoute.PATCH(
      json(`http://localhost/api/v1/organizations/${organizationId}`, "PATCH", body),
      params(organizationId),
    ))
  }

  const storedSwitch = async (organizationId: number) => {
    const [row] = await db.select({ budgetsEnabled: organizations.budgetsEnabled }).from(organizations)
      .where(eq(organizations.id, organizationId))
    return row.budgetsEnabled
  }

  const decisionScope = (actor: Actor) => ({
    orderId: 0,
    scope: {
      role: actor.role as any,
      userId: actor.id,
      organizationId: actor.organizationId,
      branchId: actor.branchId,
    },
    user: { id: actor.id, email: actor.email, role: actor.role },
  })

  const approve = async (orderId: number, approver: Actor) => {
    const outcome = await approveOrder({ ...decisionScope(approver), orderId })
    expect(outcome.kind).toBe("approved")
  }

  const reject = async (orderId: number, approver: Actor) => {
    const outcome = await rejectOrder({ ...decisionScope(approver), orderId, reason: "Not needed" })
    expect(outcome.kind).toBe("rejected")
  }

  const fulfil = async (orderId: number, organizationId: number, branchId: number) =>
    fulfillApprovedOrder({ orderId, organizationId, branchId, fulfilledByUserId: actors.superAdmin.id })

  beforeAll(async () => {
    const roleIds = {
      superAdmin: await resolveRoleId("SUPER_ADMIN"),
      headOffice: await resolveRoleId("HEAD_OFFICE"),
      branchAdmin: await resolveRoleId("BRANCH_ADMIN"),
      orderPortal: await resolveRoleId("ORDER_PORTAL"),
      groupOrderPortal: await resolveRoleId("GROUP_ORDER_PORTAL"),
    }

    const [offOrg] = await db.insert(organizations)
      .values({ name: `IT Budget Off ${suffix}`, code: `ITBO_${suffix}`, budgetsEnabled: false })
      .returning({ id: organizations.id })
    // Inserted without the column, as every script and fixture does: the
    // database default has to keep such a tenant budgeted.
    const [onOrg] = await db.insert(organizations)
      .values({ name: `IT Budget On ${suffix}`, code: `ITBN_${suffix}` })
      .returning({ id: organizations.id })
    offOrgId = offOrg.id
    onOrgId = onOrg.id

    const [headOfficeOff] = await db.insert(users).values({
      email: `it-bt-ho-off-${suffix}@example.test`, username: `it-bt-ho-off-${suffix}`, passwordHash: "x",
      roleId: roleIds.headOffice, organizationId: offOrgId,
    }).returning({ id: users.id })

    const [group] = await db.insert(groups)
      .values({ organizationId: offOrgId, name: `IT BT Group ${suffix}`, createdByUserId: headOfficeOff.id })
      .returning({ id: groups.id })
    groupId = group.id

    const [a, a2, b] = await db.insert(branches).values([
      { organizationId: offOrgId, name: `IT BT A ${suffix}` },
      { organizationId: offOrgId, name: `IT BT A2 ${suffix}`, groupId },
      { organizationId: onOrgId, name: `IT BT B ${suffix}` },
    ]).returning({ id: branches.id })
    branchA = a.id
    branchA2 = a2.id
    branchB = b.id

    const person = async (label: string, roleId: number, organizationId: number | null, branchId: number | null) => {
      const [row] = await db.insert(users).values({
        email: `it-bt-${label}-${suffix}@example.test`, username: `it-bt-${label}-${suffix}`, passwordHash: "x",
        roleId, organizationId, branchId, fullName: `${label} ${suffix}`,
      }).returning({ id: users.id })
      return row.id
    }
    const actor = (id: string, label: string, role: string, organizationId: number | null, branchId: number | null): Actor =>
      ({ id, email: `it-bt-${label}-${suffix}@example.test`, role, organizationId, branchId })

    actors.superAdmin = actor(await person("sa", roleIds.superAdmin, null, null), "sa", "SUPER_ADMIN", null, null)
    actors.headOfficeOff = actor(headOfficeOff.id, "ho-off", "HEAD_OFFICE", offOrgId, null)
    actors.headOfficeOn = actor(await person("ho-on", roleIds.headOffice, onOrgId, null), "ho-on", "HEAD_OFFICE", onOrgId, null)
    actors.branchAdminA = actor(await person("ba-a", roleIds.branchAdmin, offOrgId, branchA), "ba-a", "BRANCH_ADMIN", offOrgId, branchA)
    actors.branchAdminB = actor(await person("ba-b", roleIds.branchAdmin, onOrgId, branchB), "ba-b", "BRANCH_ADMIN", onOrgId, branchB)
    actors.orderPortalA = actor(await person("op-a", roleIds.orderPortal, offOrgId, branchA), "op-a", "ORDER_PORTAL", offOrgId, branchA)
    actors.orderPortalB = actor(await person("op-b", roleIds.orderPortal, onOrgId, branchB), "op-b", "ORDER_PORTAL", onOrgId, branchB)
    actors.groupPortal = actor(await person("gop", roleIds.groupOrderPortal, offOrgId, null), "gop", "GROUP_ORDER_PORTAL", offOrgId, null)

    await db.insert(userGroupAssignments).values({
      userId: actors.groupPortal.id, groupId, organizationId: offOrgId, createdByUserId: headOfficeOff.id,
    })

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITBT-${suffix}`, name: `IT Budget Toggle Product ${suffix}`, basePrice: UNIT_PRICE,
      status: "active", unit: "pc", stockQuantity: 1_000,
    }).returning({ id: globalProducts.id })
    productId = product.id

    const [off] = await db.insert(organizationInventory)
      .values({ organizationId: offOrgId, globalProductId: productId, assignedByUserId: headOfficeOff.id, isActive: true })
      .returning({ id: organizationInventory.id })
    const [on] = await db.insert(organizationInventory)
      .values({ organizationId: onOrgId, globalProductId: productId, assignedByUserId: actors.headOfficeOn.id, isActive: true })
      .returning({ id: organizationInventory.id })
    inventoryOff = off.id
    inventoryOn = on.id
    await db.insert(branchInventory).values([
      { branchId: branchA, organizationId: offOrgId, organizationInventoryId: inventoryOff, assignedByUserId: headOfficeOff.id },
      { branchId: branchA2, organizationId: offOrgId, organizationInventoryId: inventoryOff, assignedByUserId: headOfficeOff.id },
      { branchId: branchB, organizationId: onOrgId, organizationInventoryId: inventoryOn, assignedByUserId: actors.headOfficeOn.id },
    ])

    await db.insert(budgets).values([
      { organizationId: offOrgId, branchId: branchA, period: PERIOD, amountAllocatedCents: 1_000, amountSpentCents: 200, amountHeldCents: 0, amountCreditedCents: 0 },
      { organizationId: onOrgId, branchId: branchB, period: PERIOD, amountAllocatedCents: 2_000, amountSpentCents: 0, amountHeldCents: 0, amountCreditedCents: 0 },
    ])

    orderItemOf = async (orderId: number) => {
      const [item] = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId))
      return item.id
    }
  })

  afterAll(async () => {
    if (!offOrgId) return
    const organizationIds = [offOrgId, onOrgId, ...createdOrganizationIds]
    const refundRows = await db.select({ id: refunds.id }).from(refunds).where(inArray(refunds.organizationId, organizationIds))
    if (refundRows.length > 0) await db.delete(refundItems).where(inArray(refundItems.refundId, refundRows.map((row) => row.id)))
    await db.delete(refunds).where(inArray(refunds.organizationId, organizationIds))
    await db.delete(notifications).where(inArray(notifications.organizationId, organizationIds))
    await db.delete(emailOutbox).where(inArray(emailOutbox.organizationId, organizationIds))
    await db.delete(orderItems).where(inArray(orderItems.organizationId, organizationIds))
    await db.delete(orders).where(inArray(orders.organizationId, organizationIds))
    await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.organizationId, organizationIds))
    await db.delete(groupOrders).where(inArray(groupOrders.organizationId, organizationIds))
    await db.delete(invoiceSequences).where(inArray(invoiceSequences.organizationId, organizationIds))
    await db.delete(systemLogs).where(inArray(systemLogs.organizationId, organizationIds))
    const actorIds = Object.values(actors).map((actor) => actor.id)
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, actorIds)))
    await db.delete(budgets).where(inArray(budgets.organizationId, organizationIds))
    await db.delete(branchInventory).where(inArray(branchInventory.organizationId, organizationIds))
    await db.delete(organizationInventory).where(inArray(organizationInventory.organizationId, organizationIds))
    await db.delete(userGroupAssignments).where(inArray(userGroupAssignments.organizationId, organizationIds))
    await db.delete(groups).where(eq(groups.id, groupId))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(globalProducts).where(eq(globalProducts.id, productId))
    await db.delete(organizationSettings).where(inArray(organizationSettings.organizationId, organizationIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("the switch itself", () => {
    const createCompany = async (body: Record<string, unknown>) => {
      signIn(actors.superAdmin)
      return read(await organizationsRoute.POST(json("http://localhost/api/v1/organizations", "POST", body)))
    }

    it("keeps a tenant inserted without the column budgeted (the database default)", async () => {
      expect(await storedSwitch(onOrgId)).toBe(true)
    })

    it("creates a company with budget allocation off when the form says nothing", async () => {
      const { status, body } = await createCompany({ name: `IT BT New ${suffix}`, code: `ITBTNEW${suffix}`.slice(0, 20) })

      expect(status).toBe(201)
      createdOrganizationIds.push(body.item.id)
      expect(body.item.budgetsEnabled).toBe(false)
      expect(await storedSwitch(body.item.id)).toBe(false)
      const [audit] = await db.select({ metadata: auditLogs.metadata }).from(auditLogs)
        .where(and(eq(auditLogs.organizationId, body.item.id), eq(auditLogs.action, "CREATE_ORGANIZATION")))
      expect((audit.metadata as any).budgetsEnabled).toBe(false)
    })

    it("creates a company with budget allocation on when asked", async () => {
      const { status, body } = await createCompany({ name: `IT BT New On ${suffix}`, code: `ITBTON${suffix}`.slice(0, 20), budgetsEnabled: true })

      expect(status).toBe(201)
      createdOrganizationIds.push(body.item.id)
      expect(await storedSwitch(body.item.id)).toBe(true)
    })

    it("refuses a value that is not a boolean, on create and on edit", async () => {
      expect((await createCompany({ name: `IT BT Bad ${suffix}`, code: `ITBTBAD${suffix}`.slice(0, 20), budgetsEnabled: "false" })).status).toBe(400)
      expect((await patchOrganization(actors.superAdmin, offOrgId, { budgetsEnabled: "true" })).status).toBe(400)
      expect(await storedSwitch(offOrgId)).toBe(false)
    })

    it("does not let Head Office change it, even for its own tenant", async () => {
      const { status } = await patchOrganization(actors.headOfficeOff, offOrgId, { budgetsEnabled: true })

      expect(status).toBe(403)
      expect(await storedSwitch(offOrgId)).toBe(false)
    })

    it("does not let Head Office create a company to get it", async () => {
      signIn(actors.headOfficeOff)
      const response = await organizationsRoute.POST(json("http://localhost/api/v1/organizations", "POST", {
        name: `IT BT HO ${suffix}`, code: `ITBTHO${suffix}`.slice(0, 20), budgetsEnabled: true,
      }))
      expect(response.status).toBe(403)
    })
  })

  describe("a tenant with budget allocation off", () => {
    let fulfilledOrderId: number
    let pendingUntrackedOrderId: number

    it("places an order larger than its branch's remaining budget, holds nothing, and leaves the kept row exactly as it was", async () => {
      const stockBefore = await stock()
      // 4 units = 2,000 against 800 "remaining": refused if a budget applied.
      const { status, body } = await placeOrder(actors.orderPortalA, 4)

      expect(status).toBe(200)
      expect(body.order.totalCents).toBe(4 * UNIT_PRICE)
      expect(body.order.budgetTracked).toBe(false)
      expect((await storedOrder(body.order.id)).budgetTracked).toBe(false)
      expect(await ledger(branchA)).toEqual([{ allocated: 1_000, spent: 200, held: 0, credited: 0 }])
      expect(await stock()).toBe(stockBefore - 4)
      fulfilledOrderId = body.order.id
    })

    it("orders for a branch with no budget row at all, and opens none", async () => {
      const { status, body } = await placeOrder(actors.headOfficeOff, 2, branchA2)

      expect(status).toBe(200)
      expect(body.order.budgetTracked).toBe(false)
      expect(await ledger(branchA2)).toEqual([])
    })

    it("places a group order for its branches with no budget, and opens no row", async () => {
      signIn(actors.groupPortal)
      const { status, body } = await read(await groupOrdersRoute.POST(json(
        "http://localhost/api/v1/group-portal/orders",
        "POST",
        { groupId, entries: [{ branchIds: [branchA2], items: [{ organizationInventoryId: inventoryOff, quantity: 3 }] }] },
        { "Idempotency-Key": idempotencyKey() },
      )))

      expect(status).toBe(201)
      expect(body.item.results).toEqual([expect.objectContaining({ status: "created", branchId: branchA2 })])
      const children = await db.select({ budgetTracked: orders.budgetTracked, totalCents: orders.totalCents })
        .from(orders).where(eq(orders.groupOrderId, body.item.id))
      expect(children).toEqual([{ budgetTracked: false, totalCents: 3 * UNIT_PRICE }])
      expect(await ledger(branchA2)).toEqual([])
    })

    it("reports no budget to the group storefront", async () => {
      signIn(actors.groupPortal)
      const { status, body } = await read(await groupBudgetsRoute.GET())

      expect(status).toBe(200)
      expect(body).toMatchObject({ items: [], budgetsEnabled: false })
    })

    it("tells the shop there is no budget, with no figures, and writes nothing", async () => {
      signIn(actors.orderPortalA)
      const { status, body } = await read(await budgetsRoute.GET(json("http://localhost/api/v1/budgets", "GET")))

      expect(status).toBe(200)
      expect(body).toEqual({ branchId: branchA, budgetsEnabled: false })

      signIn(actors.headOfficeOff)
      const queried = await read(await budgetsRoute.GET(json(`http://localhost/api/v1/budgets?branchId=${branchA2}`, "GET")))
      expect(queried.body).toEqual({ branchId: branchA2, budgetsEnabled: false })
      expect(await ledger(branchA2)).toEqual([])
    })

    it("lists no budgets to Head Office and refuses an allocation", async () => {
      signIn(actors.headOfficeOff)
      const list = await read(await budgetsRoute.GET(json("http://localhost/api/v1/budgets?all=true&period=" + PERIOD, "GET")))
      expect(list.body).toEqual({ budgets: [], budgetsEnabled: false })

      const refused = await read(await budgetsRoute.PUT(json("http://localhost/api/v1/budgets", "PUT", {
        branchId: branchA2, amountAllocatedCents: 50_000, type: "monthly",
      })))
      expect(refused.status).toBe(409)
      expect(refused.body.code).toBe("BUDGETS_DISABLED")
      expect(await ledger(branchA2)).toEqual([])
      expect(await ledger(branchA)).toEqual([{ allocated: 1_000, spent: 200, held: 0, credited: 0 }])
    })

    it("answers the sidebar's question for the caller's own tenant only", async () => {
      signIn(actors.headOfficeOff)
      expect((await read(await budgetPolicyRoute.GET())).body).toEqual({ budgetsEnabled: false })
      signIn(actors.headOfficeOn)
      expect((await read(await budgetPolicyRoute.GET())).body).toEqual({ budgetsEnabled: true })
      signIn(actors.superAdmin)
      expect((await read(await budgetPolicyRoute.GET())).body).toEqual({ budgetsEnabled: true })
      signIn(actors.orderPortalA)
      expect((await budgetPolicyRoute.GET()).status).toBe(403)
    })

    it("reports its Budget Report as off, and a Super Admin's cross-tenant report leaves it out", async () => {
      signIn(actors.headOfficeOff)
      const own = await read(await budgetSummaryRoute.GET(json("http://localhost/api/v1/analytics/budgets/summary?preset=thisMonth", "GET")))
      expect(own.body.budgetsEnabled).toBe(false)
      expect(own.body.summary).toEqual({ totalAllocated: 0, totalSpent: 0, totalHeld: 0, totalCredited: 0, totalRemaining: 0 })

      signIn(actors.superAdmin)
      const mixed = await read(await budgetSummaryRoute.GET(json(
        `http://localhost/api/v1/analytics/budgets/summary?startDate=${WINDOW_START}&endDate=${WINDOW_END}&branchIds=${branchA},${branchA2},${branchB}`,
        "GET",
      )))
      expect(mixed.status).toBe(200)
      expect(mixed.body.branchBreakdown.map((row: any) => row.id ?? row.branchId)).toEqual([branchB])
      // Branch B's row alone: its kept allocation, none of A's.
      expect(mixed.body.summary.totalAllocated).toBe(2_000)
    })

    it("shows the executive budget position as off, never a zero budget with a negative remaining", async () => {
      signIn(actors.headOfficeOff)
      const { status, body } = await read(await executiveOverviewRoute.GET(json(
        `http://localhost/api/v1/analytics/executive/overview?startDate=${WINDOW_START}&endDate=${WINDOW_END}`,
        "GET",
      )))

      expect(status).toBe(200)
      expect(body.kpis.budgetTracking).toBe("none")
      expect(body.kpis.totalBudgetCents).toBe(0)
      expect(body.kpis.remainingCents).toBe(0)
      for (const branch of body.branches) {
        expect(branch.budgetTracked).toBe(false)
        expect(branch.health).toBe("unbudgeted")
        expect(branch.remainingCents).toBe(0)
      }
      // Both branches are still on the page — only their budget side is off.
      expect(body.branches.map((branch: any) => branch.branchId).sort((a: number, b: number) => a - b))
        .toEqual([branchA, branchA2].sort((a, b) => a - b))
      expect(body.attention.some((item: any) => /budget/i.test(item.title))).toBe(false)
    })

    it("approves, fulfils and refunds an untracked order without moving a single ledger figure", async () => {
      await approve(fulfilledOrderId, actors.branchAdminA)
      expect(await fulfil(fulfilledOrderId, offOrgId, branchA)).toBe("fulfilled")
      expect(await ledger(branchA)).toEqual([{ allocated: 1_000, spent: 200, held: 0, credited: 0 }])

      signIn(actors.superAdmin)
      const itemId = await orderItemOf(fulfilledOrderId)
      const refund = await read(await orderRefundsRoute.POST(
        json(`http://localhost/api/v1/orders/${fulfilledOrderId}/refunds`, "POST", { items: [{ id: itemId, quantity: 1 }], reason: "Damaged" }),
        params(fulfilledOrderId),
      ))
      expect(refund.status).toBe(200)
      expect((await storedOrder(fulfilledOrderId)).refundAmountCents).toBe(UNIT_PRICE)

      const adminRefund = await read(await adminRefundsRoute.POST(json("http://localhost/api/v1/admin/refunds", "POST", {
        orderId: fulfilledOrderId, items: [{ itemId, quantity: 1 }], reason: "Short delivery",
      })))
      expect(adminRefund.status).toBe(200)
      expect((await storedOrder(fulfilledOrderId)).refundAmountCents).toBe(2 * UNIT_PRICE)
      expect(await ledger(branchA)).toEqual([{ allocated: 1_000, spent: 200, held: 0, credited: 0 }])
    })

    it("rejects an untracked order, restoring stock and no budget", async () => {
      const { body } = await placeOrder(actors.orderPortalA, 1)
      const stockBefore = await stock()
      await reject(body.order.id, actors.branchAdminA)

      expect(await stock()).toBe(stockBefore + 1)
      expect(await ledger(branchA)).toEqual([{ allocated: 1_000, spent: 200, held: 0, credited: 0 }])
    })

    it("edits an untracked order far past any budget, and admin-deletes it, without touching the ledger", async () => {
      const { body } = await placeOrder(actors.orderPortalA, 1)
      signIn(actors.orderPortalA)
      const edited = await read(await orderRoute.PUT(
        json(`http://localhost/api/v1/orders/${body.order.id}`, "PUT", { items: [{ organizationInventoryId: inventoryOff, quantity: 10 }] }),
        params(body.order.id),
      ))
      expect(edited.status).toBe(200)
      expect((await storedOrder(body.order.id)).totalCents).toBe(10 * UNIT_PRICE)

      signIn(actors.superAdmin)
      const deleted = await deleteOrderRoute.DELETE(json(`http://localhost/api/v1/admin/delete-order?id=${body.order.id}`, "DELETE"))
      expect(deleted.status).toBe(200)
      expect(await ledger(branchA)).toEqual([{ allocated: 1_000, spent: 200, held: 0, credited: 0 }])
    })

    it("leaves one untracked order pending for the switch to be turned on under it", async () => {
      const { body } = await placeOrder(actors.orderPortalA, 1)
      pendingUntrackedOrderId = body.order.id
      expect((await storedOrder(pendingUntrackedOrderId)).status).toBe("PENDING")
    })

    describe("switched on by a Super Admin", () => {
      let trackedOrderId: number

      it("is audited with what it replaced", async () => {
        const { status } = await patchOrganization(actors.superAdmin, offOrgId, { budgetsEnabled: true })

        expect(status).toBe(200)
        expect(await storedSwitch(offOrgId)).toBe(true)
        expect(await storedSwitch(onOrgId)).toBe(true)
        const [audit] = await db.select().from(auditLogs).where(and(
          eq(auditLogs.organizationId, offOrgId),
          eq(auditLogs.action, ORGANIZATION_BUDGETS_AUDIT_ACTION),
        ))
        expect(audit.userId).toBe(actors.superAdmin.id)
        expect(audit.metadata).toEqual({ previousBudgetsEnabled: false, budgetsEnabled: true })
      })

      it("checks the budget again: an order past the 800 remaining is refused and moves nothing", async () => {
        const { status, body } = await placeOrder(actors.orderPortalA, 4)

        expect(status).toBe(400)
        expect(body.error).toMatch(/Insufficient budget/)
        expect(await ledger(branchA)).toEqual([{ allocated: 1_000, spent: 200, held: 0, credited: 0 }])
      })

      it("holds a new order's total", async () => {
        const { status, body } = await placeOrder(actors.orderPortalA, 1)

        expect(status).toBe(200)
        expect(body.order.budgetTracked).toBe(true)
        trackedOrderId = body.order.id
        expect(await ledger(branchA)).toEqual([{ allocated: 1_000, spent: 200, held: UNIT_PRICE, credited: 0 }])
      })

      it("rejects the order placed while off without releasing the new order's hold", async () => {
        // Releasing 500 "for" the untracked order would take the held figure to
        // 0 while the tracked order is still pending against it.
        await reject(pendingUntrackedOrderId, actors.branchAdminA)

        expect(await ledger(branchA)).toEqual([{ allocated: 1_000, spent: 200, held: UNIT_PRICE, credited: 0 }])
      })

      it("settles the tracked order against its own hold", async () => {
        await approve(trackedOrderId, actors.branchAdminA)
        expect(await fulfil(trackedOrderId, offOrgId, branchA)).toBe("fulfilled")

        expect(await ledger(branchA)).toEqual([{ allocated: 1_000, spent: 200 + UNIT_PRICE, held: 0, credited: 0 }])
      })

      it("counts only tracked orders in the order-derived Budget Report, so it agrees with the ledger", async () => {
        signIn(actors.headOfficeOff)
        const { body } = await read(await budgetSummaryRoute.GET(json(
          `http://localhost/api/v1/analytics/budgets/summary?startDate=${WINDOW_START}&endDate=${WINDOW_END}&branchIds=${branchA}`,
          "GET",
        )))

        // The one tracked order (500, fulfilled). The untracked fulfilled
        // order (2,000 less 1,000 refunded) was never charged and is excluded.
        expect(body.budgetsEnabled).toBe(true)
        expect(body.summary.totalSpent).toBe(UNIT_PRICE)
        expect(body.summary.totalHeld).toBe(0)
      })
    })
  })

  describe("a budgeted tenant switched off with orders still holding budget", () => {
    let rejectedLaterId: number
    let fulfilledLaterId: number

    it("holds both orders while on", async () => {
      rejectedLaterId = (await placeOrder(actors.orderPortalB, 1)).body.order.id
      fulfilledLaterId = (await placeOrder(actors.orderPortalB, 2)).body.order.id

      expect(await ledger(branchB)).toEqual([{ allocated: 2_000, spent: 0, held: 3 * UNIT_PRICE, credited: 0 }])
    })

    it("still releases a held order's own total when it is rejected after the switch", async () => {
      expect((await patchOrganization(actors.superAdmin, onOrgId, { budgetsEnabled: false })).status).toBe(200)
      await reject(rejectedLaterId, actors.branchAdminB)

      expect(await ledger(branchB)).toEqual([{ allocated: 2_000, spent: 0, held: 2 * UNIT_PRICE, credited: 0 }])
    })

    it("still moves a held order from held to spent when it is fulfilled after the switch", async () => {
      await approve(fulfilledLaterId, actors.branchAdminB)
      expect(await fulfil(fulfilledLaterId, onOrgId, branchB)).toBe("fulfilled")

      expect(await ledger(branchB)).toEqual([{ allocated: 2_000, spent: 2 * UNIT_PRICE, held: 0, credited: 0 }])
    })

    it("takes no hold for an order placed after the switch, however large", async () => {
      const { status, body } = await placeOrder(actors.orderPortalB, 20)

      expect(status).toBe(200)
      expect(body.order.budgetTracked).toBe(false)
      expect(await ledger(branchB)).toEqual([{ allocated: 2_000, spent: 2 * UNIT_PRICE, held: 0, credited: 0 }])
    })
  })

  describe("tenant isolation", () => {
    it("does not let another tenant's Head Office read or write a branch budget", async () => {
      signIn(actors.headOfficeOn)
      const read1 = await budgetsRoute.GET(json(`http://localhost/api/v1/budgets?branchId=${branchA}`, "GET"))
      expect([403, 404]).toContain(read1.status)

      const write = await budgetsRoute.PUT(json("http://localhost/api/v1/budgets", "PUT", {
        branchId: branchA, amountAllocatedCents: 99_000, type: "monthly",
      }))
      expect([403, 404]).toContain(write.status)
      expect((await ledger(branchA))[0].allocated).toBe(1_000)
    })
  })
})
