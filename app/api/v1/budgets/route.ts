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
import {
  canAllocateToBranch,
  canManageMoneyBudgets,
  managesAssignedBranchesOnly,
  resolveManagedBranchScope,
} from "@/lib/money-budget-access"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"
import { isGroupUserBudgetAllocationEnabled } from "@/lib/server/group-user-budget-allocation"
import { resolveAddonValidUntil } from "@/lib/budget-addon-expiry"
import {
  loadOpenBudgetAddons,
  settleDueAddonsOnBudget,
  settleDueBudgetAddons,
} from "@/lib/server/budget-addon-expiry"
import {
  budgetEnabledBranchSql,
  budgetTrackedOrderSql,
  isOrganizationBudgetEnabled,
} from "@/lib/server/organization-budget-policy"
import { BUDGETS_DISABLED_CODE, BUDGETS_DISABLED_MESSAGE } from "@/lib/organization-budget-policy"

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

/**
 * The approver's allocation reach, read from its own assignment rows and
 * never from the request. `null` for every other role, whose reach is the
 * tenant predicate applied elsewhere in this file; an empty array for an
 * approver with nothing assigned, which every caller must turn into a refusal.
 */
async function loadAssignedBranchIds(role: unknown, userId: unknown): Promise<number[] | null> {
  if (!managesAssignedBranchesOnly(role)) return null
  if (typeof userId !== "string" || userId.length === 0) return []
  return resolveScopedBranchIds(db, userId)
}

/**
 * The tenant fence every branch-keyed request passes: a tenant-pinned role
 * reaches only branches of its own organization, whatever id it sent. The
 * platform role is not pinned. Read and write paths share this so the
 * refusal is the same on both and cannot be told apart.
 */
function tenantFenceError(role: unknown, branch: { organizationId: number | null }, orgId: unknown): NextResponse | null {
  if (role === "SUPER_ADMIN") return null
  if (branch.organizationId !== null && Number(branch.organizationId) === Number(orgId)) return null
  return NextResponse.json({
    error: "Unauthorized: Branch belongs to different organization"
  }, { status: 403 })
}

/**
 * The fence for a branch id that arrived on the query string: the branch
 * must exist and sit inside the caller's tenant, checked before anything
 * that could write. Returns the 404 or 403 to send, or null to proceed.
 */
async function queriedBranchAccessError(role: unknown, branchId: number, orgId: unknown): Promise<NextResponse | null> {
  const [branch] = await db
    .select({ organizationId: branches.organizationId })
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1)
  if (!branch) return NextResponse.json({ error: "Branch not found" }, { status: 404 })
  return tenantFenceError(role, branch, orgId)
}

/**
 * Whether this caller may write an allocation to this branch, as the response
 * to send when it may not. Two fences, in order: every tenant-pinned manager
 * stays inside its own organization, and the approver additionally reaches
 * only the branches its assignments resolve to — the same set it approves
 * orders for, read from its own rows and never from the body.
 */
async function allocationAccessError({ role, userId, orgId, branch }: {
  role: unknown
  userId: unknown
  orgId: unknown
  branch: { id: number; organizationId: number | null }
}): Promise<NextResponse | null> {
  const fence = tenantFenceError(role, branch, orgId)
  if (fence) return fence

  const allowed = canAllocateToBranch({
    role,
    assignedBranchIds: await loadAssignedBranchIds(role, userId),
    branchId: branch.id,
  })
  if (!allowed) {
    return NextResponse.json({
      error: "Unauthorized: Branch is outside your assigned scope"
    }, { status: 403 })
  }

  return null
}

/**
 * The validity an add-on credit is granted with, or the 400 to send. Every
 * add-on that credits money carries the day it stops being available; the
 * reset-to-zero calls and baseline updates carry none.
 */
/**
 * The validity an add-on credit is granted with and the budget month it is
 * filed on, or the 400 to send. Every add-on that credits money carries the
 * day it stops being available and lands on that day's month; the
 * reset-to-zero calls and baseline updates carry no date and stay on the
 * month the engine is billing (`currentPeriod`).
 */
function resolveRequestedAddonValidity({ type, amountAllocatedCents, validUntilInput, now, currentPeriod }: {
  type: "addon" | "monthly"
  amountAllocatedCents: number
  validUntilInput: string | undefined
  now: Date
  currentPeriod: string
}): { creditsAddon: boolean; validUntil: Date | null; period: string } | NextResponse {
  const creditsAddon = type === "addon" && amountAllocatedCents > 0
  if (!creditsAddon) {
    return validUntilInput === undefined
      ? { creditsAddon, validUntil: null, period: currentPeriod }
      : NextResponse.json({ error: "validUntil applies only to an add-on credit" }, { status: 400 })
  }
  if (validUntilInput === undefined) {
    return NextResponse.json({ error: "validUntil is required for an add-on credit" }, { status: 400 })
  }
  const resolved = resolveAddonValidUntil(validUntilInput, now)
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 })
  return { creditsAddon, validUntil: resolved.validUntil, period: resolved.period }
}

/** The add-ons in force on one budget row; a placeholder row (no id yet) has none. */
async function openAddonsForBudget(budgetId: unknown) {
  if (typeof budgetId !== "number" || budgetId <= 0) return []
  return (await loadOpenBudgetAddons(db, [budgetId])).get(budgetId) ?? []
}

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
  budgetId: budgets.id,
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
    // A tenant with budget allocation off has no live budget: its kept rows are
    // neither listed nor topped up from the baseline by this read.
    budgetEnabledBranchSql(),
  )
}

function resolveRequestedBudgetOrganization(role: string, sessionOrganizationId: any, requested: string | null) {
  if (sessionOrganizationId && !/^\d+$/.test(String(sessionOrganizationId))) return { error: "Invalid session data" }
  if (role !== "SUPER_ADMIN" || !requested) return { organizationId: sessionOrganizationId }
  const parsed = validateNumericId(requested, "organizationId")
  return parsed ? { organizationId: parsed } : { error: "Invalid organization ID" }
}

async function loadSingleBranchBudget(branchId: number, period: string) {
  await settleDueBudgetAddons(db, { branchIds: [branchId], periods: [period] })
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
  await settleDueBudgetAddons(db, { branchIds, periods: range.periods })
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
    // Only orders that took a hold, so this agrees with the ledger it replaces.
    budgetTrackedOrderSql(),
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

/**
 * The add-ons still in force on each row, for the Budgets page to show next
 * to the credited figure. Rows without a budget row yet carry an empty list.
 */
async function attachOpenAddons(rows: any[]) {
  const budgetIds = rows.map((row) => row.budgetId).filter((id): id is number => typeof id === "number")
  const byBudget = await loadOpenBudgetAddons(db, budgetIds)
  return rows.map(({ budgetId, ...row }) => ({
    ...row,
    addons: (typeof budgetId === "number" ? byBudget.get(budgetId) : undefined) ?? [],
  }))
}

async function loadCurrentMoneyBudgets(branchScope: any, period: string) {
  const load = () => db.select(budgetBranchSelection).from(branches).leftJoin(groups, eq(branches.groupId, groups.id))
    .leftJoin(budgets, and(eq(budgets.branchId, branches.id), eq(budgets.period, period))).where(branchScope)
  let rows = await load()
  // Withdraw whatever expired before the figures are read, so the page never
  // shows money the next order could not spend.
  const settled = await settleDueBudgetAddons(db, { branchIds: rows.map((row) => row.branchId), periods: [period] })
  if (settled.length > 0) rows = await load()
  if (await syncCurrentMoneyBudgets(rows, period)) rows = await load()
  return attachOpenAddons(addMoneyBudgetRemaining(rows))
}

async function handleAllMoneyBudgets(context: any) {
  try {
    // Every tenant-pinned manager needs its tenant: Head Office and the
    // approver alike. Only the platform role may list without one.
    if (context.role !== "SUPER_ADMIN" && !context.organizationId) {
      return NextResponse.json({ error: `Organization context required for ${context.role} users` }, { status: 400 })
    }
    if (context.organizationId && !await isOrganizationBudgetEnabled(Number(context.organizationId))) {
      return NextResponse.json({ budgets: [], budgetsEnabled: false })
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
    return NextResponse.json({ budgets: await withBudgetAllocationModes(rows), budgetsEnabled: true })
  } catch (caughtError) {
    logError(caughtError, "BUDGETS_GET_ALL")
    return NextResponse.json({ error: "Failed to fetch budgets" }, { status: 500 })
  }
}

async function handleSingleMoneyBudget({
  role,
  normalizedRole,
  userBranchId,
  branchIdParam,
  organizationId,
}: {
  role: unknown
  normalizedRole: string
  userBranchId: unknown
  branchIdParam: string | null
  organizationId: number | null
}) {
  const branchFromQuery = (role === "HEAD_OFFICE" || role === "SUPER_ADMIN") && Boolean(branchIdParam)
  const branchId = branchFromQuery
    ? validateNumericId(branchIdParam, "branchId")
    : validateNumericId(String(userBranchId), "branchId")
  if (!branchId) return NextResponse.json({ error: "Valid branch ID required" }, { status: 400 })

  const fence = branchFromQuery ? await queriedBranchAccessError(role, branchId, organizationId) : null
  if (fence) return fence

  // A tenant with budget allocation off has no budget to show and none to
  // open: answer before the load below, which writes a period row when one is
  // missing. The shop reads this flag to stop gating the cart on a budget.
  const [branchTenant] = await db.select({ organizationId: branches.organizationId })
    .from(branches).where(eq(branches.id, branchId)).limit(1)
  if (!branchTenant) return NextResponse.json({ error: "Branch not found" }, { status: 404 })
  if (!await isOrganizationBudgetEnabled(branchTenant.organizationId)) {
    return NextResponse.json({ branchId, budgetsEnabled: false })
  }

  const currentMonth = new Date().toISOString().slice(0, 7)
  const budget = await loadSingleBranchBudget(branchId, currentMonth)
  if (!budget) return NextResponse.json({ error: "Branch not found" }, { status: 404 })

  const allocated = budget.amountAllocatedCents ?? 0
  const spent = budget.amountSpentCents ?? 0
  const held = budget.amountHeldCents ?? 0
  const credited = budget.amountCreditedCents ?? 0
  const budgetPayload = {
    branchId,
    budgetsEnabled: true,
    amountAllocatedCents: allocated,
    amountSpentCents: spent,
    amountHeldCents: held,
    amountCreditedCents: credited,
    remainingCents: (allocated + credited) - (spent + held),
    baselineBudgetCents: budget.baselineBudgetCents || 0,
    period: budget.period || currentMonth,
    addons: await openAddonsForBudget(budget.id),
  }
  const hideBudgetPrices = normalizedRole === "ORDER_PORTAL"
    ? false
    : await shouldHidePricesForRole(normalizedRole, organizationId || budget.orgIdFromBranch || budget.organizationId)

  return NextResponse.json(
    hideBudgetPrices
      ? redactAnalyticsPrices({ ...budgetPayload, pricesHidden: true })
      : budgetPayload,
  )
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
    const userId = (session.user as any).id

    if (role === "GROUP_USER" && !await isGroupUserBudgetAllocationEnabled(userId, sessionOrgId)) {
      return NextResponse.json({ error: "Budget allocation is not enabled for this user" }, { status: 403 })
    }

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
      // The approver's list is its assignments, intersected with whatever the
      // request asked for; the tenant-wide roles keep their request as-is and
      // are fenced by the organization predicate in `buildBudgetBranchScope`.
      // An empty result for the approver is refused here, because that
      // builder drops the branch predicate for an empty list.
      const managed = resolveManagedBranchScope({
        role,
        assignedBranchIds: await loadAssignedBranchIds(role, userId),
        requestedBranchIds: parseNumberList(branchIdsParam),
      })
      if (!managed.ok) return NextResponse.json({ error: managed.error }, { status: managed.status })

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
        branchIds: managed.branchIds ?? [],
      })
    }
    // Single branch budget query - must be for current month period
    return handleSingleMoneyBudget({
      role,
      normalizedRole,
      userBranchId,
      branchIdParam,
      organizationId: orgId,
    })

    // An id from the query string is fenced to the caller's tenant before the
    // load, which opens the period row when it is missing — a refused read
    // must not write into another organization. The session's own branch
    // needs no fence: it is the caller's scope by construction.
  } catch (e: any) {
    logError(e, 'BUDGETS_GET')
    const { status, ...errorBody } = handleError(e, 'BUDGETS_GET')
    return NextResponse.json(errorBody, { status })
  }
}

async function writeMoneyBudgetAllocation({
  branch,
  branchId,
  period,
  amountAllocatedCents,
  resetAddons,
  type,
  reason,
  creditsAddon,
  validUntil,
  now,
  userId,
}: {
  branch: typeof branches.$inferSelect
  branchId: number
  period: string
  amountAllocatedCents: number
  resetAddons?: boolean
  type: "addon" | "monthly"
  reason?: string
  creditsAddon: boolean
  validUntil: Date | null
  now: Date
  userId: string
}) {
  return db.transaction(async (tx) => {
    await tx.insert(budgets).values({
      organizationId: branch.organizationId,
      branchId,
      period,
      amountAllocatedCents: branch.baselineBudgetCents ?? 0,
      amountSpentCents: 0,
      amountHeldCents: 0,
      amountCreditedCents: 0,
    }).onConflictDoNothing()

    const [existingRow] = await tx
      .select({ id: budgets.id })
      .from(budgets)
      .where(and(eq(budgets.branchId, branchId), eq(budgets.period, period)))
      .for('update')
    if (!existingRow) throw new Error("BUDGET_ROW_MISSING")

    await settleDueAddonsOnBudget(tx, existingRow.id, now, {
      actorUserId: userId,
      closeAll: type === "addon" && resetAddons === true,
    })

    const [lockedBudget] = await tx.select().from(budgets)
      .where(eq(budgets.id, existingRow.id)).for('update')
    if (!lockedBudget) throw new Error("BUDGET_ROW_MISSING")

    const oldAmount = lockedBudget.amountAllocatedCents
    const oldCredited = lockedBudget.amountCreditedCents
    const newAllocated = type === "monthly" ? amountAllocatedCents : oldAmount
    const newCredited = type === "addon"
      ? (resetAddons ? 0 : oldCredited) + amountAllocatedCents
      : oldCredited
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
      .set({ amountAllocatedCents: newAllocated, amountCreditedCents: newCredited, updatedAt: new Date() })
      .where(eq(budgets.id, lockedBudget.id))
      .returning()

    let addonId: number | null = null
    if (creditsAddon) {
      const [addon] = await tx.insert(budgetAddons).values({
        budgetId: updatedBudget.id,
        amountCents: amountAllocatedCents,
        reason: reason || "Monthly Add-on Credit",
        createdByUserId: userId,
        validUntil,
      }).returning({ id: budgetAddons.id })
      addonId = addon?.id ?? null
    }

    await tx.insert(auditLogs).values({
      userId,
      organizationId: branch.organizationId,
      action: type === "monthly" ? "UPDATE_BRANCH_BASELINE" : "ADD_CREDIT",
      entity: type === "monthly" ? "BRANCH" : "BUDGET",
      entityId: String(branchId),
      metadata: {
        branchName: branch.name,
        period,
        oldAmount: oldAmount / 100,
        newAmount: newAllocated / 100,
        addedAmount: type === "addon" ? amountAllocatedCents / 100 : undefined,
        addonId: addonId ?? undefined,
        validUntil: validUntil?.toISOString(),
      },
    })

    return { oldAmount, newAllocated, newCredited, addonId }
  })
}

async function parseMoneyBudgetUpdate(req: NextRequest): Promise<MoneyBudgetUpdate | NextResponse> {
  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 })
  }
  const parsedBody = moneyBudgetUpdateSchema.safeParse(rawBody)
  if (!parsedBody.success) {
    return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
  }
  return validateMoneyBudgetUpdate(parsedBody.data) ?? parsedBody.data
}

/**
 * Why this tenant takes no money allocation, or null when it does.
 *
 * Budgets off comes first: allocating money a tenant's orders are never
 * checked against would only mislead whoever reads the figure later.
 */
async function moneyAllocationRefusal(organizationId: number): Promise<NextResponse | null> {
  if (!await isOrganizationBudgetEnabled(organizationId)) {
    return NextResponse.json({ error: BUDGETS_DISABLED_MESSAGE, code: BUDGETS_DISABLED_CODE }, { status: 409 })
  }
  if (await getBudgetAllocationModeForOrganization(organizationId) === "quantity") {
    return NextResponse.json({
      error: "This organization uses quantity-based budgeting. Allocate budgets from Budget by Quantity."
    }, { status: 403 })
  }
  return null
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

    // Super Admin, Head Office, and the multi-branch approver may allocate;
    // which branches each may reach is checked below, after the branch is read.
    if (!canManageMoneyBudgets(role)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
    }
    if (role === "GROUP_USER" && !await isGroupUserBudgetAllocationEnabled(userId, orgId)) {
      return NextResponse.json({ error: "Budget allocation is not enabled for this user" }, { status: 403 })
    }

    const parsedBody = await parseMoneyBudgetUpdate(req)
    if (parsedBody instanceof NextResponse) return parsedBody
    const { branchId, amountAllocatedCents, resetAddons, type, reason, validUntil: validUntilInput } = parsedBody

    // Update or create the budget row for the period this write belongs to:
    // the month the engine is billing, or — for an add-on — the month its
    // validity date is in (see resolveRequestedAddonValidity).
    const now = new Date()
    const currentMonth = now.toISOString().slice(0, 7) // YYYY-MM format

    const validity = resolveRequestedAddonValidity({ type, amountAllocatedCents, validUntilInput, now, currentPeriod: currentMonth })
    if (validity instanceof NextResponse) return validity
    const { creditsAddon, validUntil, period } = validity

    // Verify branch exists and belongs to org
    const [branch] = await db
      .select()
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1)

    if (!branch) {
      return NextResponse.json({ error: "Branch not found" }, { status: 404 })
    }

    const accessError = await allocationAccessError({ role, userId, orgId, branch })
    if (accessError) return accessError

    const refusal = await moneyAllocationRefusal(branch.organizationId)
    if (refusal) return refusal

    try {
      const allocation = await writeMoneyBudgetAllocation({
        branch,
        branchId,
        period,
        amountAllocatedCents,
        resetAddons,
        type,
        reason,
        creditsAddon,
        validUntil,
        now,
        userId,
      })

      return NextResponse.json(type === "monthly" ? {
        message: "Baseline budget updated successfully",
        baseline: allocation.newAllocated / 100,
      } : {
        message: "Add-on credited successfully",
        budget: {
          branchId,
          branchName: branch.name,
          period,
          oldAmount: allocation.oldAmount / 100,
          newAmount: allocation.newAllocated / 100,
          newCredited: allocation.newCredited / 100,
          wasReset: allocation.newAllocated === 0,
          addonId: allocation.addonId,
          validUntil: validUntil?.toISOString() ?? null,
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
