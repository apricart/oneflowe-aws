import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, asc, eq, ne } from "drizzle-orm"

import * as moneyBudgetsRoute from "@/app/api/v1/budgets/route"
import * as expiryCronRoute from "@/app/api/v1/budgets/cron/expire-addons/route"
import { auditLogs, budgetAddons, budgets } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import {
  BUDGET_ADDON_EXPIRY_AUDIT_ACTION,
  BUDGET_ADDON_RESET_AUDIT_ACTION,
  settleDueAddonsOnBudget,
} from "@/lib/server/budget-addon-expiry"
import { currentBudgetPeriod } from "@/lib/server/group-branch-budgets"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

const mocks = vi.hoisted(() => ({
  invalidateByPrefix: vi.fn(async () => undefined),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: mocks.invalidateByPrefix,
    // No Redis here: every cached read runs its real fetcher against the test
    // database instead of waiting on a connection that will never open.
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

const { getServerSession } = mockedNextAuth
const { GET: readMoneyBudgets, PUT: allocateMoneyBudget } = moneyBudgetsRoute
const { POST: sweepExpiredAddons } = expiryCronRoute

/**
 * The clock is pinned inside the real UTC month so every date the tests pick
 * sits in the budget period the fixture created, and advanced by hand to
 * walk an add-on past its validity. Only `Date` is faked; the pg driver's
 * timers stay real.
 */
const period = currentBudgetPeriod()
const periodYear = Number(period.slice(0, 4))
const periodMonth = Number(period.slice(5, 7))
const lastDayOfPeriod = new Date(Date.UTC(periodYear, periodMonth, 0)).getUTCDate()
const nextPeriod = new Date(Date.UTC(periodYear, periodMonth, 1)).toISOString().slice(0, 7)
const dayInPeriod = (day: number, hourUtc = 10) => new Date(`${period}-${String(day).padStart(2, "0")}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`)
const dayString = (day: number) => `${period}-${String(day).padStart(2, "0")}`
/** 23:59:59.999 Asia/Karachi on that day, as the route stores it. */
const endOfDay = (day: number) => new Date(`${dayString(day)}T23:59:59.999+05:00`)

const FIXTURE_ROW = {
  amountAllocatedCents: 100_000,
  amountSpentCents: 20_000,
  amountHeldCents: 30_000,
  amountCreditedCents: 5_000,
}

function signIn(actor: { id: string; email: string; role: string; organizationId: number | null } | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

function allocationRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/budgets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function readRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/budgets?${query}`)
}

function cronRequest(body: unknown, bearer: string | null): NextRequest {
  return new NextRequest("http://localhost/api/v1/budgets/cron/expire-addons", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
  })
}

describe.skipIf(!hasTestDatabase)("one-time add-ons carry a validity date", () => {
  let fixtures: GroupRoleFixtures
  let budgetId: number

  const headOffice = () => ({
    id: fixtures.headOfficeId,
    email: `head-${fixtures.suffix}@example.test`,
    role: "HEAD_OFFICE",
    organizationId: fixtures.organizationId,
  })

  const ledger = async () => {
    const [row] = await db
      .select({
        amountAllocatedCents: budgets.amountAllocatedCents,
        amountSpentCents: budgets.amountSpentCents,
        amountHeldCents: budgets.amountHeldCents,
        amountCreditedCents: budgets.amountCreditedCents,
      })
      .from(budgets)
      .where(eq(budgets.id, budgetId))
    return row
  }

  const addonRows = () => db
    .select({
      id: budgetAddons.id,
      amountCents: budgetAddons.amountCents,
      validUntil: budgetAddons.validUntil,
      expiredAt: budgetAddons.expiredAt,
      forfeitedCents: budgetAddons.forfeitedCents,
      createdByUserId: budgetAddons.createdByUserId,
    })
    .from(budgetAddons)
    .where(eq(budgetAddons.budgetId, budgetId))
    .orderBy(asc(budgetAddons.id))

  const auditRows = (action: string) => db
    .select({ userId: auditLogs.userId, branchId: auditLogs.branchId, metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, fixtures.organizationId), eq(auditLogs.action, action)))
    .orderBy(asc(auditLogs.id))

  const grant = async (amountCents: number, validUntil?: string, extra: Record<string, unknown> = {}) => {
    signIn(headOffice())
    const response = await allocateMoneyBudget(allocationRequest({
      branchId: fixtures.alphaNorthId,
      amountAllocatedCents: amountCents,
      type: "addon",
      ...(validUntil === undefined ? {} : { validUntil }),
      ...extra,
    }))
    return { status: response.status, body: await response.json() }
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(dayInPeriod(10))
    fixtures = await createGroupRoleFixtures()
    const [row] = await db
      .select({ id: budgets.id })
      .from(budgets)
      .where(and(eq(budgets.branchId, fixtures.alphaNorthId), eq(budgets.period, period)))
    budgetId = row.id
  })

  afterAll(async () => {
    vi.useRealTimers()
    await destroyGroupRoleFixtures(fixtures)
    await closePool()
  })

  // Every test starts from the fixture's ledger on the 10th with no add-on
  // rows and no audit trail, so none depends on the one before it.
  beforeEach(async () => {
    vi.setSystemTime(dayInPeriod(10))
    await db.delete(budgetAddons).where(eq(budgetAddons.budgetId, budgetId))
    await db.delete(auditLogs).where(eq(auditLogs.organizationId, fixtures.organizationId))
    await db.update(budgets).set(FIXTURE_ROW).where(eq(budgets.id, budgetId))
    // The month-boundary test opens next month's row; nothing else expects it.
    await db.delete(budgets).where(and(eq(budgets.branchId, fixtures.alphaNorthId), ne(budgets.period, period)))
  })

  describe("granting", () => {
    it("refuses an add-on credit without a validity date and leaves the ledger alone", async () => {
      const { status, body } = await grant(10_000)
      expect(status).toBe(400)
      expect(body.error).toBe("validUntil is required for an add-on credit")
      expect(await ledger()).toEqual(FIXTURE_ROW)
      expect(await addonRows()).toEqual([])
    })

    it("refuses a date that has passed, one in another month, and a malformed one", async () => {
      expect(await grant(10_000, dayString(9))).toMatchObject({
        status: 400,
        body: { error: "validUntil must be today or a later date" },
      })
      expect(await grant(10_000, `${nextPeriod}-01`)).toMatchObject({
        status: 400,
        body: { error: "validUntil must fall within the current budget month" },
      })
      expect(await grant(10_000, "25/09/2026")).toMatchObject({ status: 400 })
      expect(await ledger()).toEqual(FIXTURE_ROW)
    })

    it("refuses a validity date on anything that is not an add-on credit", async () => {
      signIn(headOffice())
      const monthly = await allocateMoneyBudget(allocationRequest({
        branchId: fixtures.alphaNorthId,
        amountAllocatedCents: 120_000,
        type: "monthly",
        validUntil: dayString(20),
      }))
      expect(monthly.status).toBe(400)
      expect((await monthly.json()).error).toBe("validUntil applies only to an add-on credit")
      expect(await ledger()).toEqual(FIXTURE_ROW)
    })

    it("credits the add-on, stores its validity on the ledger row, and audits the date", async () => {
      const { status, body } = await grant(10_000, dayString(12), { reason: "Quarter-end top-up" })
      expect(status).toBe(200)
      expect(body.budget).toMatchObject({ newCredited: 150, validUntil: endOfDay(12).toISOString() })

      expect(await ledger()).toEqual({ ...FIXTURE_ROW, amountCreditedCents: 15_000 })
      const rows = await addonRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        amountCents: 10_000,
        validUntil: endOfDay(12),
        expiredAt: null,
        forfeitedCents: 0,
        createdByUserId: fixtures.headOfficeId,
      })
      expect(body.budget.addonId).toBe(rows[0].id)

      const [audit] = await auditRows("ADD_CREDIT")
      expect(audit.metadata).toMatchObject({ addonId: rows[0].id, validUntil: endOfDay(12).toISOString() })
    })

    it("in the first hours of a month, files the add-on on the new month's row rather than refusing it", async () => {
      // 20:00Z on the last day of the period is 01:00 on the 1st in Karachi:
      // the engine still bills this period, the administrator is in the next.
      vi.setSystemTime(dayInPeriod(lastDayOfPeriod, 20))

      // This period's last day has ended in Karachi, so it is refused …
      expect(await grant(10_000, dayString(lastDayOfPeriod))).toMatchObject({
        status: 400,
        body: { error: "validUntil must be today or a later date" },
      })
      // … and a date in the new month is filed on the new month's row.
      const { status, body } = await grant(10_000, `${nextPeriod}-05`)
      expect(status).toBe(200)
      expect(body.budget).toMatchObject({ period: nextPeriod, newCredited: 100 })

      // This period's row is untouched; next month's opened at the baseline
      // with the add-on on it, ready for the moment the engine rolls over.
      expect(await ledger()).toEqual(FIXTURE_ROW)
      const [next] = await db
        .select({
          id: budgets.id,
          amountAllocatedCents: budgets.amountAllocatedCents,
          amountCreditedCents: budgets.amountCreditedCents,
          amountSpentCents: budgets.amountSpentCents,
        })
        .from(budgets)
        .where(and(eq(budgets.branchId, fixtures.alphaNorthId), eq(budgets.period, nextPeriod)))
      expect(next).toMatchObject({ amountAllocatedCents: 100_000, amountCreditedCents: 10_000, amountSpentCents: 0 })
      const [row] = await db
        .select({ budgetId: budgetAddons.budgetId, validUntil: budgetAddons.validUntil })
        .from(budgetAddons)
        .where(eq(budgetAddons.id, body.budget.addonId))
      expect(row).toEqual({ budgetId: next.id, validUntil: new Date(`${nextPeriod}-05T23:59:59.999+05:00`) })
    })

    it("shows the add-on and its date on both budget reads while it is in force", async () => {
      await grant(10_000, dayString(12))
      signIn(headOffice())

      const single = await readMoneyBudgets(readRequest(`branchId=${fixtures.alphaNorthId}`))
      expect(single.status).toBe(200)
      const singleBody = await single.json()
      expect(singleBody).toMatchObject({ amountCreditedCents: 15_000, remainingCents: 65_000 })
      expect(singleBody.addons).toHaveLength(1)
      expect(singleBody.addons[0]).toMatchObject({ amountCents: 10_000, validUntil: endOfDay(12).toISOString() })

      const list = await readMoneyBudgets(readRequest(`all=true&period=${period}&branchIds=${fixtures.alphaNorthId}`))
      expect(list.status).toBe(200)
      const row = (await list.json()).budgets.find((entry: any) => entry.branchId === fixtures.alphaNorthId)
      expect(row).toMatchObject({ amountCreditedCents: 15_000, remainingCents: 65_000 })
      expect(row.addons).toHaveLength(1)
      expect(row.budgetId).toBeUndefined()
    })
  })

  describe("expiry", () => {
    it("withdraws the unspent add-on on the next read after its date, once, with the trail to match", async () => {
      const { body } = await grant(10_000, dayString(12))
      const addonId: number = body.budget.addonId

      // Still the 12th in Karachi: nothing moves.
      vi.setSystemTime(dayInPeriod(12, 18))
      signIn(headOffice())
      let single = await readMoneyBudgets(readRequest(`branchId=${fixtures.alphaNorthId}`))
      expect(await single.json()).toMatchObject({ amountCreditedCents: 15_000, remainingCents: 65_000 })

      // 00:30 on the 13th in Karachi (19:30Z on the 12th): the add-on is due.
      vi.setSystemTime(dayInPeriod(12, 19))
      single = await readMoneyBudgets(readRequest(`branchId=${fixtures.alphaNorthId}`))
      const after = await single.json()
      expect(after).toMatchObject({ amountCreditedCents: 5_000, remainingCents: 55_000, addons: [] })
      expect(await ledger()).toEqual(FIXTURE_ROW)

      const [row] = await addonRows()
      expect(row).toMatchObject({ id: addonId, expiredAt: dayInPeriod(12, 19), forfeitedCents: 10_000 })

      const trail = await auditRows(BUDGET_ADDON_EXPIRY_AUDIT_ACTION)
      expect(trail).toHaveLength(1)
      expect(trail[0]).toMatchObject({ userId: null, branchId: fixtures.alphaNorthId })
      expect(trail[0].metadata).toMatchObject({
        budgetId,
        period,
        withdrawnCents: 10_000,
        creditedBeforeCents: 15_000,
        creditedAfterCents: 5_000,
        addons: [{ addonId, amountCents: 10_000, forfeitedCents: 10_000 }],
      })

      // A second read finds nothing to settle: the row and the trail stand.
      vi.setSystemTime(dayInPeriod(20))
      await readMoneyBudgets(readRequest(`all=true&period=${period}&branchIds=${fixtures.alphaNorthId}`))
      expect(await ledger()).toEqual(FIXTURE_ROW)
      expect(await auditRows(BUDGET_ADDON_EXPIRY_AUDIT_ACTION)).toHaveLength(1)
    })

    it("withdraws only what is still remaining when the branch had reached into the add-on", async () => {
      await grant(10_000, dayString(14))
      // 100k + 15k credited − 82k spent − 30k held = 3k remaining: 7k of the add-on was needed.
      await db.update(budgets).set({ amountSpentCents: 82_000 }).where(eq(budgets.id, budgetId))

      vi.setSystemTime(dayInPeriod(15))
      const settlement = await db.transaction((tx) => settleDueAddonsOnBudget(tx, budgetId, new Date()))
      expect(settlement?.plan).toMatchObject({
        withdrawnCents: 3_000,
        creditedBeforeCents: 15_000,
        creditedAfterCents: 12_000,
        remainingBeforeCents: 3_000,
        remainingAfterCents: 0,
      })
      expect(await ledger()).toEqual({ ...FIXTURE_ROW, amountSpentCents: 82_000, amountCreditedCents: 12_000 })
      const [row] = await addonRows()
      expect(row).toMatchObject({ expiredAt: dayInPeriod(15), forfeitedCents: 3_000 })

      // Nothing left to do under the same lock a hold would take.
      expect(await db.transaction((tx) => settleDueAddonsOnBudget(tx, budgetId, new Date()))).toBeNull()
    })

    it("closes an add-on the branch consumed entirely with nothing withdrawn", async () => {
      await grant(10_000, dayString(14))
      // Everything, add-on included, is committed: 100k + 15k = 85k + 30k.
      await db.update(budgets).set({ amountSpentCents: 85_000 }).where(eq(budgets.id, budgetId))

      vi.setSystemTime(dayInPeriod(15))
      const settlement = await db.transaction((tx) => settleDueAddonsOnBudget(tx, budgetId, new Date()))
      expect(settlement?.plan.withdrawnCents).toBe(0)
      expect((await ledger()).amountCreditedCents).toBe(15_000)
      const [row] = await addonRows()
      expect(row).toMatchObject({ expiredAt: dayInPeriod(15), forfeitedCents: 0 })
    })

    it("never touches an add-on granted before validity existed", async () => {
      await db.insert(budgetAddons).values({ budgetId, amountCents: 5_000, reason: "legacy", validUntil: null })
      vi.setSystemTime(dayInPeriod(28))
      signIn(headOffice())
      const single = await readMoneyBudgets(readRequest(`branchId=${fixtures.alphaNorthId}`))
      const body = await single.json()
      expect(body).toMatchObject({ amountCreditedCents: 5_000, remainingCents: 55_000 })
      expect(body.addons).toHaveLength(1)
      expect(body.addons[0]).toMatchObject({ amountCents: 5_000, validUntil: null })
      expect(await auditRows(BUDGET_ADDON_EXPIRY_AUDIT_ACTION)).toEqual([])
    })

    it("settles what expired before stacking a new add-on on the row", async () => {
      const first = await grant(10_000, dayString(12))
      vi.setSystemTime(dayInPeriod(13))
      const second = await grant(4_000, dayString(20))
      expect(second.status).toBe(200)
      // 15k on the row, less the 10k that expired, plus the 4k just granted.
      expect(second.body.budget.newCredited).toBe(90)
      expect((await ledger()).amountCreditedCents).toBe(9_000)

      const rows = await addonRows()
      expect(rows.find((row) => row.id === first.body.budget.addonId)).toMatchObject({ forfeitedCents: 10_000 })
      expect(rows.find((row) => row.id === second.body.budget.addonId)).toMatchObject({ expiredAt: null, validUntil: endOfDay(20) })
    })
  })

  describe("reset", () => {
    it("closes every open add-on in the ledger when the credit is emptied", async () => {
      const { body } = await grant(10_000, dayString(20))
      signIn(headOffice())
      const reset = await allocateMoneyBudget(allocationRequest({
        branchId: fixtures.alphaNorthId,
        amountAllocatedCents: 0,
        setAbsolute: true,
        resetAddons: true,
      }))
      expect(reset.status).toBe(200)
      expect((await ledger()).amountCreditedCents).toBe(0)

      const [row] = await addonRows()
      expect(row).toMatchObject({ id: body.budget.addonId, expiredAt: dayInPeriod(10), forfeitedCents: 10_000 })
      const trail = await auditRows(BUDGET_ADDON_RESET_AUDIT_ACTION)
      expect(trail).toHaveLength(1)
      expect(trail[0]).toMatchObject({ userId: fixtures.headOfficeId })
    })
  })

  describe("the sweep", () => {
    it("is refused without the cron secret", async () => {
      expect((await sweepExpiredAddons(cronRequest({}, null))).status).toBe(401)
      expect((await sweepExpiredAddons(cronRequest({}, "not-the-secret"))).status).toBe(401)
    })

    it("previews on dry_run and settles the rows nobody has read since their date", async () => {
      const { body } = await grant(10_000, dayString(12))
      vi.setSystemTime(dayInPeriod(13))
      const secret = process.env.CRON_SECRET as string

      const preview = await sweepExpiredAddons(cronRequest({ dry_run: true }, secret))
      expect(preview.status).toBe(200)
      expect((await preview.json()).budgetIds).toContain(budgetId)
      expect((await ledger()).amountCreditedCents).toBe(15_000)

      const run = await sweepExpiredAddons(cronRequest({}, secret))
      expect(run.status).toBe(200)
      const result = await run.json()
      expect(result.budgetIds).toContain(budgetId)
      expect(result.withdrawnCents).toBeGreaterThanOrEqual(10_000)
      expect((await ledger()).amountCreditedCents).toBe(5_000)
      const rows = await addonRows()
      expect(rows.find((row) => row.id === body.budget.addonId)).toMatchObject({ forfeitedCents: 10_000 })
    })
  })
})
