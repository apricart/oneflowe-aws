import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import * as budgetSummaryRoute from "@/app/api/v1/analytics/budgets/summary/route"
import { auditLogs, branches, budgets, orderItems, orders, roles, users } from "@/db/schema"
import { budgetPeriodOf, summarizeOrderConsumption } from "@/lib/budget-consumption"
import { closePool, db } from "@/lib/db"
import { fulfillApprovedOrder } from "@/lib/server/order-fulfillment"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: vi.fn(async () => undefined),
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

const { getServerSession } = mockedNextAuth
const { GET: readBudgetSummary } = budgetSummaryRoute

/**
 * The two sources of a branch's consumption have to produce the same number.
 *
 * The route reports either the `budgets` ledger's running totals or the
 * `orders` table re-aggregated for a window, chosen by the preset. Everything
 * below pins that the two agree, that both land on the UTC period the order
 * lifecycle wrote its hold against, and that neither can be pointed at another
 * tenant's branch.
 *
 * See `plans/OF-BUDGET-ledger-orders-parity.md`.
 */

const period = budgetPeriodOf(new Date())
const periodYear = Number(period.slice(0, 4))
const periodMonth = Number(period.slice(5, 7))
const lastDayOfPeriod = new Date(Date.UTC(periodYear, periodMonth, 0)).getUTCDate()
/** The UTC month before the current one — where a carried-over order sits. */
const previousPeriod = budgetPeriodOf(new Date(Date.UTC(periodYear, periodMonth - 2, 15)))

const dayInPeriod = (day: number, hourUtc = 10) =>
  new Date(`${period}-${String(day).padStart(2, "0")}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`)

const periodStart = `${period}-01T00:00:00.000Z`
const periodEnd = `${period}-${String(lastDayOfPeriod).padStart(2, "0")}T23:59:59.999Z`

const ALLOCATED_CENTS = 5_000_000

/**
 * The orders this branch's month contains, and what each one is worth.
 *
 * Every figure below is written out by hand rather than derived, so the
 * expectations are an independent oracle and not a restatement of the code
 * under test.
 */
const ORDER_PLAN = [
  { key: "fulfilled-clean", status: "FULFILLED", totalCents: 50_000, refundAmountCents: 0, day: 2, spent: 50_000, held: 0 },
  { key: "fulfilled-part-refund", status: "FULFILLED", totalCents: 30_000, refundAmountCents: 10_000, day: 3, spent: 20_000, held: 0 },
  { key: "partially-fulfilled", status: "PARTIALLY_FULFILLED", totalCents: 12_000, refundAmountCents: 0, day: 4, spent: 12_000, held: 0 },
  { key: "pending", status: "PENDING", totalCents: 8_000, refundAmountCents: 0, day: 5, spent: 0, held: 8_000 },
  { key: "approved-part-refund", status: "APPROVED", totalCents: 5_000, refundAmountCents: 1_000, day: 6, spent: 0, held: 4_000 },
  { key: "rejected", status: "REJECTED", totalCents: 99_000, refundAmountCents: 0, day: 7, spent: 0, held: 0 },
  { key: "cancelled", status: "CANCELLED", totalCents: 77_000, refundAmountCents: 0, day: 8, spent: 0, held: 0 },
  { key: "fully-refunded", status: "REFUNDED", totalCents: 25_000, refundAmountCents: 25_000, day: 9, spent: 0, held: 0 },
] as const

/**
 * 21:00 UTC on the last day of the month is already the 1st in Asia/Karachi.
 * The hold for this order went onto the current period's row, so every reader
 * has to find it there too.
 */
const BOUNDARY_ORDER = {
  key: "utc-month-edge",
  status: "FULFILLED",
  totalCents: 7_000,
  refundAmountCents: 0,
  spent: 7_000,
  held: 0,
} as const

const EXPECTED_SPENT = 50_000 + 20_000 + 12_000 + 7_000
const EXPECTED_HELD = 8_000 + 4_000
const EXPECTED_CONSUMED = EXPECTED_SPENT + EXPECTED_HELD

function signIn(actor: Record<string, unknown> | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

function summaryRequest(params: Record<string, string>): NextRequest {
  const query = new URLSearchParams(params).toString()
  return new NextRequest(`http://localhost/api/v1/analytics/budgets/summary?${query}`)
}

async function readSummary(params: Record<string, string>) {
  const response = await readBudgetSummary(summaryRequest(params))
  return { status: response.status, body: await response.json() }
}

/** The ledger path: `preset=all` never switches to order-scoped spending. */
const ledgerParams = (branchId: number, organizationId: number) => ({
  organizationId: String(organizationId),
  branchIds: String(branchId),
  preset: "all",
  startDate: periodStart,
  endDate: periodEnd,
  granularity: "monthly",
})

/** The orders path: any other preset with a range switches to it. */
const orderScopedParams = (branchId: number, organizationId: number) => ({
  organizationId: String(organizationId),
  branchIds: String(branchId),
  preset: "custom",
  startDate: periodStart,
  endDate: periodEnd,
  granularity: "monthly",
})

function branchRow(body: any, branchId: number) {
  return (body.branchBreakdown || []).find((row: any) => row.branchId === branchId)
}

describe.skipIf(!hasTestDatabase)("ledger and order-derived consumption agree", () => {
  let fixtures: GroupRoleFixtures
  let branchAdminId: string
  const orderIds: number[] = []
  let carriedOrderId = 0
  let tidSequence = 0
  /**
   * The suite creates its own branches rather than borrowing the fixtures'.
   * The fixtures raise orders on every branch they make, and an order nobody
   * accounted for would show up in the orders path but not in the ledger this
   * suite writes by hand — hiding the very disagreement being tested for.
   */
  let parityBranchId = 0
  let carriedBranchId = 0

  async function insertOrder(input: {
    key: string
    status: string
    totalCents: number
    refundAmountCents: number
    createdAt: Date
    branchId: number
  }) {
    const [row] = await db
      .insert(orders)
      .values({
        // orders.tid is varchar(26); the sequence keeps it inside that.
        tid: `PTY-${fixtures.suffix}-${++tidSequence}`,
        organizationId: fixtures.organizationId,
        branchId: input.branchId,
        createdByUserId: fixtures.requesterId,
        status: input.status,
        subtotalCents: input.totalCents,
        taxCents: 0,
        totalCents: input.totalCents,
        refundAmountCents: input.refundAmountCents || null,
        statusAtRefund: input.refundAmountCents ? "FULFILLED" : null,
        createdAt: input.createdAt,
      })
      .returning({ id: orders.id })
    orderIds.push(row.id)
    return row.id
  }

  async function upsertBudget(branchId: number, row: {
    period: string
    allocated: number
    spent: number
    held: number
    credited?: number
  }) {
    // The fixtures already open a row for the current period, so this states
    // the ledger rather than assuming it is absent.
    await db.insert(budgets).values({
      organizationId: fixtures.organizationId,
      branchId,
      period: row.period,
      amountAllocatedCents: row.allocated,
      amountSpentCents: row.spent,
      amountHeldCents: row.held,
      amountCreditedCents: row.credited ?? 0,
    }).onConflictDoUpdate({
      target: [budgets.branchId, budgets.period],
      set: {
        amountAllocatedCents: row.allocated,
        amountSpentCents: row.spent,
        amountHeldCents: row.held,
        amountCreditedCents: row.credited ?? 0,
      },
    })
  }

  async function ledgerRow(branchId: number, forPeriod: string) {
    const [row] = await db
      .select({
        spent: budgets.amountSpentCents,
        held: budgets.amountHeldCents,
      })
      .from(budgets)
      .where(and(eq(budgets.branchId, branchId), eq(budgets.period, forPeriod)))
      .limit(1)
    return row
  }

  beforeAll(async () => {
    fixtures = await createGroupRoleFixtures()

    const createdBranches = await db
      .insert(branches)
      .values([
        {
          organizationId: fixtures.organizationId,
          groupId: fixtures.alphaGroupId,
          name: `Parity Main ${fixtures.suffix}`,
          costCenterId: `PM-${fixtures.suffix}`,
          status: "active",
          baselineBudgetCents: 100_000,
        },
        {
          organizationId: fixtures.organizationId,
          groupId: fixtures.alphaGroupId,
          name: `Parity Carried ${fixtures.suffix}`,
          costCenterId: `PC-${fixtures.suffix}`,
          status: "active",
          baselineBudgetCents: 100_000,
        },
      ])
      .returning({ id: branches.id })
    parityBranchId = createdBranches[0].id
    carriedBranchId = createdBranches[1].id

    const [branchAdminRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.name, "BRANCH_ADMIN"))
      .limit(1)
    const [branchAdmin] = await db
      .insert(users)
      .values({
        email: `parity-branch-admin-${fixtures.suffix}@example.test`,
        username: `parity-branch-admin-${fixtures.suffix}`,
        passwordHash: "not-a-real-hash",
        roleId: branchAdminRole.id,
        organizationId: fixtures.organizationId,
        branchId: parityBranchId,
        firstName: "Parity",
        lastName: "Admin",
        fullName: `Parity Admin ${fixtures.suffix}`,
      })
      .returning({ id: users.id })
    branchAdminId = branchAdmin.id

    for (const plan of ORDER_PLAN) {
      await insertOrder({
        key: plan.key,
        status: plan.status,
        totalCents: plan.totalCents,
        refundAmountCents: plan.refundAmountCents,
        createdAt: dayInPeriod(plan.day),
        branchId: parityBranchId,
      })
    }
    await insertOrder({
      key: BOUNDARY_ORDER.key,
      status: BOUNDARY_ORDER.status,
      totalCents: BOUNDARY_ORDER.totalCents,
      refundAmountCents: BOUNDARY_ORDER.refundAmountCents,
      createdAt: dayInPeriod(lastDayOfPeriod, 21),
      branchId: parityBranchId,
    })

    // The ledger the lifecycle would be carrying for exactly those orders.
    await upsertBudget(parityBranchId, {
      period,
      allocated: ALLOCATED_CENTS,
      spent: EXPECTED_SPENT,
      held: EXPECTED_HELD,
    })

    // An order raised last month and still held there, with its own row. It is
    // fulfilled during the tests to prove the money moves on the order's period
    // and not on today's.
    carriedOrderId = await insertOrder({
      key: "carried-over",
      status: "APPROVED",
      totalCents: 40_000,
      refundAmountCents: 0,
      createdAt: new Date(`${previousPeriod}-15T10:00:00.000Z`),
      branchId: carriedBranchId,
    })
    await upsertBudget(carriedBranchId, {
      period: previousPeriod,
      allocated: ALLOCATED_CENTS,
      spent: 0,
      held: 40_000,
    })
    await upsertBudget(carriedBranchId, {
      period,
      allocated: ALLOCATED_CENTS,
      spent: 0,
      held: 0,
    })
  })

  afterAll(async () => {
    if (orderIds.length > 0) {
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
      await db.delete(orders).where(inArray(orders.id, orderIds))
    }
    await db.delete(budgets).where(
      inArray(budgets.branchId, [parityBranchId, carriedBranchId]),
    )
    // `fulfillApprovedOrder` now records an ORDER_FULFILLED row, and
    // `audit_logs` carries foreign keys to `users` and `branches`. Release the
    // trail before the identities it names.
    await db.delete(auditLogs).where(
      inArray(auditLogs.branchId, [parityBranchId, carriedBranchId]),
    )
    if (branchAdminId) {
      await db.delete(auditLogs).where(eq(auditLogs.userId, branchAdminId))
      await db.delete(users).where(eq(users.id, branchAdminId))
    }
    await db.delete(branches).where(inArray(branches.id, [parityBranchId, carriedBranchId]))
    await destroyGroupRoleFixtures(fixtures)
    await closePool()
  })

  describe("the two paths report the same consumption", () => {
    beforeEach(() => {
      signIn({
        id: fixtures.headOfficeId,
        email: "head-office@example.test",
        role: "HEAD_OFFICE",
        organizationId: fixtures.organizationId,
      })
    })

    it("the ledger path reports the hand-computed total", async () => {
      const { status, body } = await readSummary(ledgerParams(parityBranchId, fixtures.organizationId))

      expect(status).toBe(200)
      expect(body.summary.totalSpent).toBe(EXPECTED_CONSUMED)
      expect(body.summary.totalHeld).toBe(EXPECTED_HELD)
    })

    it("the orders path reports the same total from the orders themselves", async () => {
      const { status, body } = await readSummary(orderScopedParams(parityBranchId, fixtures.organizationId))

      expect(status).toBe(200)
      expect(body.summary.totalSpent).toBe(EXPECTED_CONSUMED)
      expect(body.summary.totalHeld).toBe(EXPECTED_HELD)
    })

    it("agrees branch by branch, not merely in the total", async () => {
      const ledger = await readSummary(ledgerParams(parityBranchId, fixtures.organizationId))
      const scoped = await readSummary(orderScopedParams(parityBranchId, fixtures.organizationId))

      const ledgerBranch = branchRow(ledger.body, parityBranchId)
      const scopedBranch = branchRow(scoped.body, parityBranchId)

      expect(ledgerBranch.spent).toBe(EXPECTED_CONSUMED)
      expect(scopedBranch.spent).toBe(ledgerBranch.spent)
      expect(scopedBranch.remaining).toBe(ledgerBranch.remaining)
    })

    it("agrees on the chart series the graph draws", async () => {
      const ledger = await readSummary(ledgerParams(parityBranchId, fixtures.organizationId))
      const scoped = await readSummary(orderScopedParams(parityBranchId, fixtures.organizationId))

      const ledgerPoint = ledger.body.chartData.find((point: any) => point.date === period)
      const scopedPoint = scoped.body.chartData.find((point: any) => point.date === period)
      const branchOf = (point: any) =>
        point.branches.find((row: any) => Number(row.branchId) === parityBranchId)

      expect(branchOf(ledgerPoint).spent).toBe(EXPECTED_CONSUMED)
      expect(branchOf(scopedPoint).spent).toBe(EXPECTED_CONSUMED)
    })

    it("matches the pure oracle the rest of the app computes with", async () => {
      const rows = await db
        .select({
          status: orders.status,
          totalCents: orders.totalCents,
          refundAmountCents: orders.refundAmountCents,
        })
        .from(orders)
        .where(and(eq(orders.branchId, parityBranchId), inArray(orders.id, orderIds)))

      const oracle = summarizeOrderConsumption(rows)
      expect(oracle.spentCents).toBe(EXPECTED_SPENT)
      expect(oracle.heldCents).toBe(EXPECTED_HELD)
      expect(oracle.consumedCents).toBe(EXPECTED_CONSUMED)
    })

    it("counts an order raised at 21:00 UTC on the last of the month in that month", async () => {
      // Asia/Karachi calls that instant the 1st of the next month. The ledger
      // does not, so neither may the orders path.
      const { body } = await readSummary({
        ...orderScopedParams(parityBranchId, fixtures.organizationId),
        months: String(periodMonth),
        years: String(periodYear),
      })

      expect(body.summary.totalSpent).toBe(EXPECTED_CONSUMED)
    })

    it("excludes rejected, cancelled and fully refunded orders from both paths", async () => {
      const { body } = await readSummary(orderScopedParams(parityBranchId, fixtures.organizationId))

      // 99,000 + 77,000 + 25,000 of noise sits in the same month.
      expect(body.summary.totalSpent).toBe(EXPECTED_CONSUMED)
      expect(body.summary.totalSpent).toBeLessThan(EXPECTED_CONSUMED + 99_000)
    })
  })

  describe("the lifecycle keeps the ledger on the order's own period", () => {
    beforeEach(() => {
      signIn({
        id: fixtures.headOfficeId,
        email: "head-office@example.test",
        role: "HEAD_OFFICE",
        organizationId: fixtures.organizationId,
      })
    })

    it("fulfilment moves held to spent on the month the order was raised in", async () => {
      const outcome = await fulfillApprovedOrder({
        orderId: carriedOrderId,
        organizationId: fixtures.organizationId,
        branchId: carriedBranchId,
        fulfilledByUserId: fixtures.headOfficeId,
      })
      expect(outcome).toBe("fulfilled")

      const carried = await ledgerRow(carriedBranchId, previousPeriod)
      const current = await ledgerRow(carriedBranchId, period)

      // The money left the hold and became spend, on last month's row.
      expect(carried.held).toBe(0)
      expect(carried.spent).toBe(40_000)
      // Today's row is untouched — this is the bug the shared period prevents.
      expect(current.held).toBe(0)
      expect(current.spent).toBe(0)
    })

    it("leaves the branch's consumption unchanged across that transition", async () => {
      const { body } = await readSummary({
        organizationId: String(fixtures.organizationId),
        branchIds: String(carriedBranchId),
        preset: "all",
        startDate: `${previousPeriod}-01T00:00:00.000Z`,
        endDate: periodEnd,
        granularity: "monthly",
      })

      // Held became spent; consumed is the same 40,000 either side of it.
      expect(body.summary.totalSpent).toBe(40_000)
      expect(body.summary.totalHeld).toBe(0)
    })
  })

  describe("authorization", () => {
    it("refuses an unauthenticated caller", async () => {
      signIn(null)
      const { status, body } = await readSummary(ledgerParams(parityBranchId, fixtures.organizationId))

      expect(status).toBe(401)
      expect(body.error).toBe("Unauthorized")
    })

    it("lets this tenant's head office read its own branch", async () => {
      signIn({
        id: fixtures.headOfficeId,
        email: "head-office@example.test",
        role: "HEAD_OFFICE",
        organizationId: fixtures.organizationId,
      })
      const { status, body } = await readSummary(ledgerParams(parityBranchId, fixtures.organizationId))

      expect(status).toBe(200)
      expect(branchRow(body, parityBranchId)).toBeDefined()
    })

    it("refuses another tenant's head office naming this branch outright", async () => {
      signIn({
        id: fixtures.foreignHeadOfficeId,
        email: "foreign-head-office@example.test",
        role: "HEAD_OFFICE",
        organizationId: fixtures.foreignOrganizationId,
      })
      const { status, body } = await readSummary({
        branchIds: String(parityBranchId),
        preset: "all",
        startDate: periodStart,
        endDate: periodEnd,
        granularity: "monthly",
      })

      expect(status).toBe(200)
      expect(branchRow(body, parityBranchId)).toBeUndefined()
      expect(body.summary.totalSpent).toBe(0)
    })

    it("refuses it on the order-scoped path too", async () => {
      signIn({
        id: fixtures.foreignHeadOfficeId,
        email: "foreign-head-office@example.test",
        role: "HEAD_OFFICE",
        organizationId: fixtures.foreignOrganizationId,
      })
      const { body } = await readSummary({
        branchIds: String(parityBranchId),
        preset: "custom",
        startDate: periodStart,
        endDate: periodEnd,
        granularity: "monthly",
      })

      expect(branchRow(body, parityBranchId)).toBeUndefined()
      expect(body.summary.totalSpent).toBe(0)
    })

    it("ignores another tenant's organizationId from a head office", async () => {
      signIn({
        id: fixtures.foreignHeadOfficeId,
        email: "foreign-head-office@example.test",
        role: "HEAD_OFFICE",
        organizationId: fixtures.foreignOrganizationId,
      })
      const { body } = await readSummary({
        organizationId: String(fixtures.organizationId),
        preset: "all",
        startDate: periodStart,
        endDate: periodEnd,
        granularity: "monthly",
      })

      expect(branchRow(body, parityBranchId)).toBeUndefined()
    })

    it("pins a branch admin to its own branch whatever the query string asks for", async () => {
      signIn({
        id: branchAdminId,
        email: "parity-branch-admin@example.test",
        role: "BRANCH_ADMIN",
        organizationId: fixtures.organizationId,
        branchId: parityBranchId,
      })
      const { status, body } = await readSummary({
        organizationId: String(fixtures.organizationId),
        branchIds: String(carriedBranchId),
        preset: "all",
        startDate: periodStart,
        endDate: periodEnd,
        granularity: "monthly",
      })

      expect(status).toBe(200)
      expect(branchRow(body, carriedBranchId)).toBeUndefined()
      expect(branchRow(body, parityBranchId)).toBeDefined()
    })

    it("lets a super admin read across tenants when it names the organization", async () => {
      signIn({
        id: fixtures.superAdminId,
        email: "super@example.test",
        role: "SUPER_ADMIN",
        organizationId: null,
      })
      const { status, body } = await readSummary(ledgerParams(parityBranchId, fixtures.organizationId))

      expect(status).toBe(200)
      expect(branchRow(body, parityBranchId)).toBeDefined()
      expect(body.summary.totalSpent).toBe(EXPECTED_CONSUMED)
    })
  })
})
