import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { budgets, branches, auditLogs, budgetAddons, groups, orders, organizationSettings } from "@/db/schema"
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm"
import { handleError } from "@/lib/error-handler"
import { logError } from "@/lib/global-logger"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { buildAppMonthPeriods, getAppMonthPeriod, parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"
import {
  BUDGET_ALLOCATION_MODE_SETTING_KEY,
  DEFAULT_BUDGET_ALLOCATION_MODE,
  parseBudgetAllocationMode,
} from "@/lib/budget-allocation-mode"
import { moneyBudgetUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"

type MoneyBudgetUpdate = ReturnType<typeof moneyBudgetUpdateSchema.parse>

function validateMoneyBudgetUpdate(body: MoneyBudgetUpdate) {
  if (typeof body.branchId !== "number" || body.branchId <= 0) {
    return NextResponse.json({ error: "branchId must be a positive number" }, { status: 400 })
  }
  if (!Number.isFinite(body.amountAllocatedCents) || body.amountAllocatedCents < 0) {
    return NextResponse.json({ error: "Amount must be a non-negative finite number" }, { status: 400 })
  }
  if (body.amountAllocatedCents > Number.MAX_SAFE_INTEGER / 2) {
    return NextResponse.json({ error: "Amount exceeds maximum allowed value" }, { status: 400 })
  }
  return null
}

const canManageMoneyBudgets = (role: string) => role === "HEAD_OFFICE" || role === "SUPER_ADMIN"

/**
 * Validate numeric ID parameter
 */
function validateNumericId(value: string | undefined | null, paramName: string): number | null {
  if (!value) return null

  if (!/^\d+$/.test(value)) {
    console.warn(`[Budgets] Invalid ${paramName}: ${value}`)
    return null
  }

  const num = Number.parseInt(value, 10)
  if (Number.isNaN(num) || num <= 0) {
    console.warn(`[Budgets] ${paramName} out of range: ${num}`)
    return null
  }

  return num
}

const parseNumberList = (value: string | null, min = 1, max = Number.MAX_SAFE_INTEGER) =>
  value
    ? value.split(",").map(Number).filter(id => Number.isInteger(id) && id >= min && id <= max)
    : []

const buildBudgetPeriods = (startDate: Date, endDate: Date, months: number[], years: number[]) => {
  return buildAppMonthPeriods(startDate, endDate, months, years)
}

async function withBudgetAllocationModes<T extends { organizationId: number | null }>(items: T[]) {
  const organizationIds = Array.from(new Set(
    items
      .map((item) => item.organizationId)
      .filter((id): id is number => typeof id === "number")
  ))

  if (organizationIds.length === 0) {
    return items.map((item) => ({
      ...item,
      budgetAllocationMode: DEFAULT_BUDGET_ALLOCATION_MODE,
    }))
  }

  const settings = await db
    .select({
      organizationId: organizationSettings.organizationId,
      value: organizationSettings.value,
    })
    .from(organizationSettings)
    .where(and(
      inArray(organizationSettings.organizationId, organizationIds),
      eq(organizationSettings.key, BUDGET_ALLOCATION_MODE_SETTING_KEY),
    ))

  const modeByOrganizationId = new Map(
    settings.map((setting) => [
      setting.organizationId,
      parseBudgetAllocationMode(setting.value),
    ])
  )

  return items.map((item) => ({
    ...item,
    budgetAllocationMode: item.organizationId
      ? modeByOrganizationId.get(item.organizationId) ?? DEFAULT_BUDGET_ALLOCATION_MODE
      : DEFAULT_BUDGET_ALLOCATION_MODE,
  }))
}

const budgetBranchSelection = {
  branchId: branches.id,
  branchName: branches.name,
  organizationId: branches.organizationId,
  groupId: branches.groupId,
  groupName: groups.name,
  amountAllocatedCents: budgets.amountAllocatedCents,
  amountSpentCents: budgets.amountSpentCents,
  amountHeldCents: budgets.amountHeldCents,
  amountCreditedCents: budgets.amountCreditedCents,
  baselineBudgetCents: branches.baselineBudgetCents,
}

function buildBudgetBranchScope(role: string, organizationId: number | null, groupIds: number[], branchIds: number[]) {
  let organizationCondition
  if (!(role === "SUPER_ADMIN" && !organizationId) && organizationId) {
    organizationCondition = eq(branches.organizationId, organizationId)
  }
  return and(
    eq(branches.status, "active"),
    organizationCondition,
    groupIds.length > 0 ? inArray(branches.groupId, groupIds) : undefined,
    branchIds.length > 0 ? inArray(branches.id, branchIds) : undefined,
  )
}

function resolveRequestedBudgetOrganization(role: string, sessionOrganizationId: any, requested: string | null) {
  if (sessionOrganizationId && !/^\d+$/.test(String(sessionOrganizationId))) return { error: "Invalid session data" }
  if (role !== "SUPER_ADMIN" || !requested) return { organizationId: sessionOrganizationId }
  const parsed = validateNumericId(requested, "organizationId")
  return parsed ? { organizationId: parsed } : { error: "Invalid organization ID" }
}

async function loadSingleBranchBudget(branchId: number, period: string) {
  let [budget] = await db.select({
    id: budgets.id,
    organizationId: budgets.organizationId,
    branchId: budgets.branchId,
    period: budgets.period,
    amountAllocatedCents: budgets.amountAllocatedCents,
    amountSpentCents: budgets.amountSpentCents,
    amountHeldCents: budgets.amountHeldCents,
    amountCreditedCents: budgets.amountCreditedCents,
    createdAt: budgets.createdAt,
    updatedAt: budgets.updatedAt,
    baselineBudgetCents: branches.baselineBudgetCents,
    orgIdFromBranch: branches.organizationId,
  }).from(budgets).rightJoin(branches, and(eq(budgets.branchId, branches.id), eq(budgets.period, period)))
    .where(eq(branches.id, branchId)).limit(1) as any[]
  if (budget?.amountAllocatedCents !== null && budget) return budget
  const [branch] = await db.select().from(branches).where(eq(branches.id, branchId)).limit(1)
  if (!branch) return null
  const values = {
    organizationId: branch.organizationId,
    branchId,
    period,
    amountAllocatedCents: branch.baselineBudgetCents || 0,
    amountSpentCents: 0,
    amountHeldCents: 0,
    amountCreditedCents: 0,
  }
  const [inserted] = await db.insert(budgets).values(values).onConflictDoNothing().returning()
  budget = {
    ...values,
    id: inserted?.id || 0,
    createdAt: inserted?.createdAt || new Date(),
    updatedAt: inserted?.updatedAt || new Date(),
    baselineBudgetCents: branch.baselineBudgetCents,
    orgIdFromBranch: branch.organizationId,
  }
  return budget
}

async function resolveMoneyBudgetRange(context: any) {
  let start = parseStartDateParam(context.startDate)
  const end = parseEndDateParam(context.endDate) || new Date()
  if (context.preset === "all" || !start) {
    const [first] = await db.select({ period: budgets.period }).from(budgets)
      .where(inArray(budgets.branchId, context.branchIds)).orderBy(asc(budgets.period)).limit(1)
    start = new Date(`${first?.period || new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`)
  }
  if (!context.startDate) start.setHours(0, 0, 0, 0)
  if (!context.endDate) end.setHours(23, 59, 59, 999)
  const periods = ["today", "3d", "7d", "monthly", "thisMonth"].includes(context.preset)
    ? [getAppMonthPeriod(end)]
    : buildBudgetPeriods(start, end, context.months, context.years)
  return { start, end, periods }
}

function indexMoneyBudgetRecords(records: any[]) {
  const lookup: Record<number, Record<string, any>> = {}
  records.forEach((record) => {
    lookup[record.branchId] ??= {}
    lookup[record.branchId][record.period] = record
  })
  return lookup
}

function aggregateMoneyBudgets(branchList: any[], periods: string[], records: any, spendingRows: any[], useScopedSpending: boolean) {
  const spending = new Map(spendingRows.map((row) => [row.branchId, row]))
  return branchList.map((branch) => {
    const totals = periods.reduce((aggregate, period) => {
      const record = records[branch.branchId]?.[period]
      aggregate.allocated += record?.amountAllocatedCents || 0
      aggregate.spent += record?.amountSpentCents || 0
      aggregate.held += record?.amountHeldCents || 0
      aggregate.credited += record?.amountCreditedCents || 0
      return aggregate
    }, { allocated: 0, spent: 0, held: 0, credited: 0 })
    if (useScopedSpending) {
      const scoped = spending.get(branch.branchId) as any
      totals.spent = scoped?.spentCents || 0
      totals.held = scoped?.heldCents || 0
    }
    return {
      ...branch,
      amountAllocatedCents: totals.allocated,
      amountSpentCents: totals.spent,
      amountHeldCents: totals.held,
      amountCreditedCents: totals.credited,
      baselineBudgetCents: totals.allocated,
      remainingCents: totals.allocated + totals.credited - totals.spent - totals.held,
    }
  })
}

async function loadAggregatedMoneyBudgets(context: any) {
  const activeBranches = await db.select({
    branchId: branches.id,
    branchName: branches.name,
    organizationId: branches.organizationId,
    groupId: branches.groupId,
    groupName: groups.name,
    baselineBudgetCents: branches.baselineBudgetCents,
  }).from(branches).leftJoin(groups, eq(branches.groupId, groups.id)).where(context.branchScope)
  if (activeBranches.length === 0) return []
  const branchIds = activeBranches.map((branch) => branch.branchId)
  const range = await resolveMoneyBudgetRange({ ...context, branchIds })
  if (range.periods.length === 0) return []
  const records = await db.select({
    branchId: budgets.branchId,
    period: budgets.period,
    amountAllocatedCents: budgets.amountAllocatedCents,
    amountSpentCents: budgets.amountSpentCents,
    amountHeldCents: budgets.amountHeldCents,
    amountCreditedCents: budgets.amountCreditedCents,
  }).from(budgets).where(and(inArray(budgets.branchId, branchIds), inArray(budgets.period, range.periods)))
  const useScopedSpending = context.preset !== "all" && Boolean(
    context.startDate || context.endDate || context.months.length > 0 || context.years.length > 0,
  )
  const spendingConditions = [
    inArray(orders.branchId, branchIds),
    context.startDate || context.endDate ? gte(orders.createdAt, range.start) : undefined,
    context.startDate || context.endDate ? lte(orders.createdAt, range.end) : undefined,
    context.months.length > 0 ? sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(context.months, sql.raw(", "))})` : undefined,
    context.years.length > 0 ? sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(context.years, sql.raw(", "))})` : undefined,
  ].filter(Boolean) as any
  const spendingRows = useScopedSpending ? await db.select({
    branchId: orders.branchId,
    spentCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) IN ('FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED') THEN GREATEST(0, ${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0)) ELSE 0 END), 0)`.mapWith(Number),
    heldCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) IN ('PENDING', 'APPROVED') THEN GREATEST(0, ${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0)) ELSE 0 END), 0)`.mapWith(Number),
  }).from(orders).where(and(...spendingConditions)).groupBy(orders.branchId) : []
  return aggregateMoneyBudgets(activeBranches, range.periods, indexMoneyBudgetRecords(records), spendingRows, useScopedSpending)
}

function addMoneyBudgetRemaining(rows: any[]) {
  return rows.map((row) => {
    const allocated = row.amountAllocatedCents ?? row.baselineBudgetCents ?? 0
    const credited = row.amountCreditedCents || 0
    const spent = row.amountSpentCents || 0
    const held = row.amountHeldCents || 0
    return { ...row, amountAllocatedCents: allocated, amountSpentCents: spent, amountHeldCents: held, amountCreditedCents: credited, remainingCents: allocated + credited - spent - held }
  })
}

async function syncCurrentMoneyBudgets(rows: any[], period: string) {
  const missing = rows.filter((row) => row.amountAllocatedCents === null)
  if (missing.length > 0) {
    await db.insert(budgets).values(missing.map((row) => ({
      organizationId: row.organizationId,
      branchId: row.branchId,
      period,
      amountAllocatedCents: row.baselineBudgetCents || 0,
      amountSpentCents: 0,
      amountHeldCents: 0,
      amountCreditedCents: 0,
    }))).onConflictDoNothing()
  }
  const stale = rows.filter((row) => row.amountAllocatedCents !== null && row.amountAllocatedCents === 0
    && (row.baselineBudgetCents || 0) > 0 && (row.amountSpentCents || 0) === 0 && (row.amountCreditedCents || 0) === 0)
  await Promise.all(stale.map((row) => db.update(budgets)
    .set({ amountAllocatedCents: row.baselineBudgetCents || 0, updatedAt: new Date() })
    .where(and(eq(budgets.branchId, row.branchId), eq(budgets.period, period)))))
  return missing.length > 0 || stale.length > 0
}

async function loadCurrentMoneyBudgets(branchScope: any, period: string) {
  const load = () => db.select(budgetBranchSelection).from(branches).leftJoin(groups, eq(branches.groupId, groups.id))
    .leftJoin(budgets, and(eq(budgets.branchId, branches.id), eq(budgets.period, period))).where(branchScope)
  let rows = await load()
  if (await syncCurrentMoneyBudgets(rows, period)) rows = await load()
  return addMoneyBudgetRemaining(rows)
}

async function handleAllMoneyBudgets(context: any) {
  try {
    if (context.role === "HEAD_OFFICE" && !context.organizationId) {
      return NextResponse.json({ error: "Organization context required for HEAD_OFFICE users" }, { status: 400 })
    }
    const branchScope = buildBudgetBranchScope(context.role, context.organizationId, context.groupIds, context.branchIds)
    let rows
    if (context.period) {
      const period = /^\d{4}-\d{2}$/.test(context.period)
        ? context.period
        : new Date().toISOString().slice(0, 7)
      rows = await loadCurrentMoneyBudgets(branchScope, period)
    } else {
      rows = await loadAggregatedMoneyBudgets({ ...context, branchScope })
    }
    return NextResponse.json({ budgets: await withBudgetAllocationModes(rows) })
  } catch (caughtError) {
    logError(caughtError, "BUDGETS_GET_ALL")
    return NextResponse.json({ error: "Failed to fetch budgets" }, { status: 500 })
  }
}

/**
 * GET /api/v1/budgets - Fetch budget information
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if ((session.user as any).mustChangePassword === true) {
      return NextResponse.json({ error: "Forbidden", message: "Password change required" }, { status: 403 })
    }

    const role = (session.user as any).role
    const normalizedRole = typeof role === "string" ? role.toUpperCase().replace(/\s+/g, "_") : role
    const sessionOrgId = (session.user as any).organizationId
    const userBranchId = (session.user as any).branchId

    const { searchParams } = new URL(req.url)
    const allParam = searchParams.get("all")
    const branchIdParam = searchParams.get("branchId")
    const orgIdParam = searchParams.get("organizationId")
    const periodParam = searchParams.get("period")
    const startDateParam = searchParams.get("startDate")
    const endDateParam = searchParams.get("endDate")
    const monthsParam = searchParams.get("months")
    const yearsParam = searchParams.get("years")
    const presetParam = searchParams.get("preset") || ""
    const groupIdsParam = searchParams.get("groupIds")
    const branchIdsParam = searchParams.get("branchIds")

    const resolvedOrganization = resolveRequestedBudgetOrganization(role, sessionOrgId, orgIdParam)
    if (resolvedOrganization.error) return NextResponse.json({ error: resolvedOrganization.error }, { status: 400 })
    const orgId = resolvedOrganization.organizationId

    if (allParam && canManageMoneyBudgets(role)) {
      return handleAllMoneyBudgets({
        role,
        organizationId: orgId,
        period: periodParam,
        startDate: startDateParam,
        endDate: endDateParam,
        months: parseNumberList(monthsParam, 1, 12),
        years: parseNumberList(yearsParam, 2000, 2100),
        preset: presetParam,
        groupIds: parseNumberList(groupIdsParam),
        branchIds: parseNumberList(branchIdsParam),
      })
    }
    // Single branch budget query - must be for current month period
    const branchId = (role === "HEAD_OFFICE" || role === "SUPER_ADMIN") && branchIdParam
      ? validateNumericId(branchIdParam, "branchId")
      : validateNumericId(String(userBranchId), "branchId")

    if (!branchId) {
      return NextResponse.json({ error: "Valid branch ID required" }, { status: 400 })
    }

    const currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM format
    const b = await loadSingleBranchBudget(branchId, currentMonth)
    if (!b) return NextResponse.json({ error: "Branch not found" }, { status: 404 })

    const allocated = b.amountAllocatedCents ?? 0
    const spent = b.amountSpentCents ?? 0
    const held = b.amountHeldCents ?? 0
    const credited = b.amountCreditedCents ?? 0

    const remainingCents = (allocated + credited) - (spent + held)

    const budgetPayload = {
      branchId,
      amountAllocatedCents: allocated,
      amountSpentCents: spent,
      amountHeldCents: held,
      amountCreditedCents: credited,
      remainingCents,
      baselineBudgetCents: b.baselineBudgetCents || 0,
      period: b.period || currentMonth,
    }
    // Product prices may be hidden for order portal users, but their own branch
    // budget remains visible so the portal can show the available limit.
    const hideBudgetPrices = normalizedRole === "ORDER_PORTAL"
      ? false
      : await shouldHidePricesForRole(normalizedRole, orgId || b.orgIdFromBranch || b.organizationId)

    return NextResponse.json(
      hideBudgetPrices
        ? redactAnalyticsPrices({ ...budgetPayload, pricesHidden: true })
        : budgetPayload
    )
  } catch (e: any) {
    logError(e, 'BUDGETS_GET')
    logError(e, 'BUDGETS_GET')
    const { status, ...errorBody } = handleError(e, 'BUDGETS_GET')
    return NextResponse.json(errorBody, { status })
  }
}

/**
 * PUT /api/v1/budgets - Update or create budget allocation
 */
export async function PUT(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if ((session.user as any).mustChangePassword === true) {
      return NextResponse.json({ error: "Forbidden", message: "Password change required" }, { status: 403 })
    }

    const role = (session.user as any).role
    const userId = (session.user as any).id
    const orgId = (session.user as any).organizationId

    // Only Head Office and Super Admin can update budgets
    if (!canManageMoneyBudgets(role)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
    }

    let rawBody
    try {
      rawBody = await req.json()
    } catch (jsonError) {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 })
    }

    const parsedBody = moneyBudgetUpdateSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
    }
    const { branchId, amountAllocatedCents, resetAddons, type, reason } = parsedBody.data

    const validationError = validateMoneyBudgetUpdate(parsedBody.data)
    if (validationError) return validationError

    // Verify branch exists and belongs to org
    const [branch] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1)

    if (!branch) {
      return NextResponse.json({ error: "Branch not found" }, { status: 404 })
    }

    // HEAD_OFFICE users can only update budgets for their own organization
    if (role === "HEAD_OFFICE" && branch.organizationId !== orgId) {
      return NextResponse.json({
        error: "Unauthorized: Branch belongs to different organization"
      }, { status: 403 })
    }

    const budgetAllocationMode = await getBudgetAllocationModeForOrganization(branch.organizationId)
    if (budgetAllocationMode === "quantity") {
      return NextResponse.json({
        error: "This organization uses quantity-based budgeting. Allocate budgets from Budget by Quantity."
      }, { status: 403 })
    }

    // Update or create budget for current period
    const currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM format
    try {
      const allocation = await db.transaction(async (tx) => {
        await tx.insert(budgets).values({
          organizationId: branch.organizationId,
          branchId,
          period: currentMonth,
          amountAllocatedCents: branch.baselineBudgetCents ?? 0,
          amountSpentCents: 0,
          amountHeldCents: 0,
          amountCreditedCents: 0,
        }).onConflictDoNothing()

        const [lockedBudget] = await tx
          .select()
          .from(budgets)
          .where(and(eq(budgets.branchId, branchId), eq(budgets.period, currentMonth)))
          .for('update')
        if (!lockedBudget) throw new Error("BUDGET_ROW_MISSING")

        const oldAmount = lockedBudget.amountAllocatedCents
        const oldCredited = lockedBudget.amountCreditedCents
        const newAllocated = type === "monthly" ? amountAllocatedCents : oldAmount
        const newCredited = (() => {
          if (type === "addon") {
            return (resetAddons ? 0 : oldCredited) + amountAllocatedCents
          }
          return oldCredited
        })()
        const committed = lockedBudget.amountSpentCents + lockedBudget.amountHeldCents
        if (newAllocated + newCredited < committed) {
          throw new Error(`BUDGET_BELOW_COMMITTED:${newAllocated + newCredited}:${committed}`)
        }

        if (type === "monthly") {
          await tx.update(branches)
            .set({ baselineBudgetCents: newAllocated, updatedAt: new Date() })
            .where(eq(branches.id, branchId))
        }

        const [updatedBudget] = await tx.update(budgets)
          .set({
            amountAllocatedCents: newAllocated,
            amountCreditedCents: newCredited,
            updatedAt: new Date(),
          })
          .where(eq(budgets.id, lockedBudget.id))
          .returning()

        if (type === "addon") {
          await tx.insert(budgetAddons).values({
            budgetId: updatedBudget.id,
            amountCents: amountAllocatedCents,
            reason: reason || "Monthly Add-on Credit",
            createdByUserId: userId,
          })
        }

        await tx.insert(auditLogs).values({
          userId,
          organizationId: branch.organizationId,
          action: type === "monthly" ? "UPDATE_BRANCH_BASELINE" : "ADD_CREDIT",
          entity: type === "monthly" ? "BRANCH" : "BUDGET",
          entityId: String(branchId),
          metadata: {
            branchName: branch.name,
            period: currentMonth,
            oldAmount: oldAmount / 100,
            newAmount: newAllocated / 100,
            addedAmount: type === "addon" ? amountAllocatedCents / 100 : undefined,
          },
        })

        return { oldAmount, newAllocated, newCredited }
      })

      return NextResponse.json(type === "monthly" ? {
        message: "Baseline budget updated successfully",
        baseline: allocation.newAllocated / 100,
      } : {
        message: "Add-on credited successfully",
        budget: {
          branchId,
          branchName: branch.name,
          period: currentMonth,
          oldAmount: allocation.oldAmount / 100,
          newAmount: allocation.newAllocated / 100,
          newCredited: allocation.newCredited / 100,
          wasReset: allocation.newAllocated === 0,
        },
      })
    } catch (allocationError: any) {
      if (String(allocationError?.message || "").startsWith("BUDGET_BELOW_COMMITTED:")) {
        const [, proposed, committed] = String(allocationError.message).split(":").map(Number)
        return NextResponse.json({
          error: `Validation Failed: Total budget (PKR ${(proposed / 100).toFixed(2)}) cannot be less than spent and held commitments (PKR ${(committed / 100).toFixed(2)}).`,
        }, { status: 400 })
      }
      throw allocationError
    }

  } catch (e: any) {
    logError(e, 'BUDGETS_PUT')
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

