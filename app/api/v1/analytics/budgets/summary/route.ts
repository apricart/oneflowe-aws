import { NextResponse,type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { budgets,orders,orderItems,branches,globalProducts,categories } from "@/db/schema"
import { and,eq,gte,lte,inArray,sql,desc,asc,isNotNull } from "drizzle-orm"
import { redactAnalyticsPrices,shouldHidePricesForRole } from "@/lib/price-visibility"
import { buildAppMonthPeriods,getAppMonthPeriod,parseEndDateParam,parseStartDateParam } from "@/lib/date-range-params"
import { consumedHeldCentsSql,consumedSpentCentsSql,orderBudgetMonthSql,orderBudgetPeriodSql,orderBudgetYearSql } from "@/lib/server/budget-consumption-sql"
import { budgetEnabledBranchSql,budgetTrackedOrderSql,isOrganizationBudgetEnabled } from "@/lib/server/organization-budget-policy"
import { fenceToAssignedBranches } from "@/lib/money-budget-access"
import { resolveScopedBranchIds,usesMultiBranchScope } from "@/lib/server/multi-branch-scope"
import { isGroupUserBudgetAllocationEnabled } from "@/lib/server/group-user-budget-allocation"

const emptyBudgetSummary = {
    summary: { totalAllocated: 0, totalSpent: 0, totalHeld: 0, totalCredited: 0, totalRemaining: 0 },
    chartData: [],
    branchBreakdown: [],
    insights: { spentGrowth: 0, allocationGrowth: 0 },
    categories: []
}

const parseNumberList = (value: string | null) =>
    value
        ? value.split(",").map(Number).filter(id => !Number.isNaN(id) && id > 0)
        : []

function resolveAllowedBudgetOrganization(userRole: string, userOrgId: number | null, requested: string | null) {
    return userRole === "SUPER_ADMIN" && requested ? Number(requested) : userOrgId
}

/** Roles whose budget view is their own branch and nothing else. */
const SINGLE_BRANCH_BUDGET_ROLES = new Set(["BRANCH_ADMIN", "BRANCH_MANAGER", "ORDER_PORTAL"])

async function resolveBudgetBranchIds(context: any) {
    let branchIds: number[] = []
    if (context.branchIdsParam) {
        branchIds = parseNumberList(context.branchIdsParam)
    } else if (context.branchIdParam && context.branchIdParam !== "all") {
        branchIds = [Number(context.branchIdParam)]
    }
    // A single-branch role is pinned to its own branch even when the query
    // string names another: the request states a preference, the session
    // states the right.
    if (SINGLE_BRANCH_BUDGET_ROLES.has(context.userRole)) {
        return context.userBranchId ? [Number(context.userBranchId)] : []
    }
    if (branchIds.length === 0 && context.allowedOrgId) {
        const rows = await db.select({ id: branches.id }).from(branches).where(eq(branches.organizationId, context.allowedOrgId))
        branchIds = rows.map((branch) => branch.id)
    } else if (branchIds.length === 0 && context.userRole === "SUPER_ADMIN") {
        const rows = await db.select({ id: branches.id }).from(branches)
        branchIds = rows.map((branch) => branch.id)
    }
    if (context.groupIds.length === 0) return branchIds
    const conditions = [
        inArray(branches.groupId, context.groupIds),
        branchIds.length > 0 ? inArray(branches.id, branchIds) : undefined,
        context.allowedOrgId ? eq(branches.organizationId, context.allowedOrgId) : undefined,
    ].filter(Boolean) as any
    const scoped = await db.select({ id: branches.id }).from(branches).where(and(...conditions))
    return scoped.map((branch) => branch.id)
}

async function resolveBudgetStartDate(context: any) {
    if (context.startDateParam) return parseStartDateParam(context.startDateParam) || new Date(context.startDateParam)
    const query = db.select({ period: budgets.period }).from(budgets)
    const organizationCondition = context.allowedOrgId
        ? eq(budgets.organizationId, context.allowedOrgId)
        : isNotNull(budgets.organizationId)
    const firstBudget = context.preset === "all"
        ? await query.where(inArray(budgets.branchId, context.branchIds)).orderBy(asc(budgets.period)).limit(1)
        : await query.where(organizationCondition).orderBy(asc(budgets.period)).limit(1)
    if (firstBudget.length > 0) return new Date(`${firstBudget[0].period}-01`)
    const start = new Date()
    start.setDate(1)
    return start
}

async function resolveBudgetDateRange(context: any) {
    const startDate = await resolveBudgetStartDate(context)
    const endDate = parseEndDateParam(context.endDateParam) || new Date()
    if (!context.startDateParam) startDate.setHours(0, 0, 0, 0)
    if (!context.endDateParam) endDate.setHours(23, 59, 59, 999)
    return { startDate, endDate }
}

function buildRecordLookup<T extends { branchId: number; period: string }>(records: T[]) {
    const lookup: Record<number, Record<string, T>> = {}
    records.forEach((record) => {
        lookup[record.branchId] ??= {}
        lookup[record.branchId][record.period] = record
    })
    return lookup
}

function getBudgetSpending(record: any, orderSpending: any, useOrderScopedSpending: boolean) {
    if (useOrderScopedSpending) {
        return { spent: orderSpending?.spentCents || 0, held: orderSpending?.heldCents || 0 }
    }
    return { spent: record?.amountSpentCents || 0, held: record?.amountHeldCents || 0 }
}

function calculateBudgetTotals(branchList: any[], periods: string[], budgetLookup: any, spendingLookup: any = {}, scoped = false) {
    const totals = { allocated: 0, spent: 0, held: 0, credited: 0 }
    branchList.forEach((branch) => periods.forEach((period) => {
        const record = budgetLookup[branch.id]?.[period]
        const spending = getBudgetSpending(record, spendingLookup[branch.id]?.[period], scoped)
        totals.allocated += record?.amountAllocatedCents || 0
        totals.spent += spending.spent
        totals.held += spending.held
        totals.credited += record?.amountCreditedCents || 0
    }))
    return totals
}

function formatBudgetChart(chartDataMap: Record<string, any>, granularity: string) {
    const data = Object.values(chartDataMap).sort((left, right) => left.period.localeCompare(right.period))
    if (granularity !== "yearly") {
        return data.map((period) => ({
            date: period.period,
            branches: Object.entries(period.branches).map(([branchId, values]: [string, any]) => ({ branchId, ...values })),
        }))
    }
    const yearly: Record<string, any> = {}
    data.forEach((period) => {
        const year = period.period.slice(0, 4)
        yearly[year] ??= { date: year, branches: {} }
        Object.entries(period.branches).forEach(([branchId, values]: [string, any]) => {
            const aggregate = yearly[year].branches[branchId]
            yearly[year].branches[branchId] = aggregate
                ? {
                    ...aggregate,
                    baseline: aggregate.baseline + values.baseline,
                    addon: aggregate.addon + values.addon,
                    spent: aggregate.spent + values.spent,
                }
                : { ...values }
        })
    })
    return Object.values(yearly).map((year: any) => ({
        date: year.date,
        branches: Object.entries(year.branches).map(([branchId, values]: [string, any]) => ({ branchId, ...values })),
    }))
}

function buildBudgetChart(branchList: any[], periods: string[], budgetLookup: any, spendingLookup: any, scoped: boolean, granularity: string) {
    const chart: Record<string, any> = Object.fromEntries(periods.map((period) => [period, { period, branches: {} }]))
    branchList.forEach((branch) => periods.forEach((period) => {
        const record = budgetLookup[branch.id]?.[period]
        const spending = getBudgetSpending(record, spendingLookup[branch.id]?.[period], scoped)
        chart[period].branches[branch.id] = {
            branchName: branch.name,
            baseline: record?.amountAllocatedCents || 0,
            addon: record?.amountCreditedCents || 0,
            spent: spending.spent + spending.held,
        }
    }))
    return formatBudgetChart(chart, granularity)
}

function buildBranchBreakdown(branchList: any[], periods: string[], budgetLookup: any, spendingLookup: any, scoped: boolean) {
    return branchList.map((branch) => {
        const totals = calculateBudgetTotals([branch], periods, budgetLookup, spendingLookup, scoped)
        return {
            branchId: branch.id,
            branchName: branch.name,
            allocated: totals.allocated,
            spent: totals.spent + totals.held,
            held: totals.held,
            credited: totals.credited,
            remaining: totals.allocated + totals.credited - totals.spent - totals.held,
            baselineAmount: totals.allocated,
        }
    })
}

/**
 * The branches this response may report on.
 *
 * `branchIds` can reach here straight from the query string, so the tenant
 * predicate is applied here and not left to the caller: a branch outside the
 * caller's organization is dropped rather than refused, which keeps an
 * out-of-scope id indistinguishable from one that does not exist. Every
 * downstream read — the ledger, the order-scoped spending, the category
 * breakdown — is keyed on what this returns, so this is the fence for all of
 * them. `allowedOrgId` is null only for a Super Admin with no organization of
 * their own, which is the one genuinely global caller.
 */
async function loadActiveBudgetBranches(branchIds: number[], allowedOrgId: number | null) {
    const selection = {
        id: branches.id,
        name: branches.name,
        baselineBudgetCents: branches.baselineBudgetCents,
        organizationId: branches.organizationId,
    }
    // A tenant with budget allocation off has no budget to report. Its branches
    // drop out here, which is the fence every read below is keyed on, so a
    // Super Admin's cross-tenant view never adds its kept rows to the totals.
    if (branchIds.length > 0) {
        return db.select(selection).from(branches).where(and(
            inArray(branches.id, branchIds),
            allowedOrgId ? eq(branches.organizationId, allowedOrgId) : undefined,
            budgetEnabledBranchSql(),
        ))
    }
    if (allowedOrgId) {
        return db.select(selection).from(branches).where(and(
            eq(branches.organizationId, allowedOrgId),
            eq(branches.status, "active"),
            budgetEnabledBranchSql(),
        ))
    }
    return []
}

async function loadOrderScopedSpending(context: any) {
    if (!context.enabled) return []
    const conditions = [
        inArray(orders.branchId, context.branchIds),
        // Only orders that took a budget hold, so this path and the ledger path
        // agree: an order placed while budgets were off was never charged.
        budgetTrackedOrderSql(),
        context.hasExplicitRange ? gte(orders.createdAt, context.startDate) : undefined,
        context.hasExplicitRange ? lte(orders.createdAt, context.endDate) : undefined,
        context.months.length > 0 ? sql`${orderBudgetMonthSql()} IN (${sql.join(context.months, sql.raw(", "))})` : undefined,
        context.years.length > 0 ? sql`${orderBudgetYearSql()} IN (${sql.join(context.years, sql.raw(", "))})` : undefined,
    ].filter(Boolean) as any
    // Statuses, refund netting and the period bucket all come from the shared
    // consumption rules, so this sum lands on the same UTC-month rows the order
    // lifecycle wrote its holds against and the ledger path reads.
    return db.select({
        branchId: orders.branchId,
        period: orderBudgetPeriodSql(),
        spentCents: consumedSpentCentsSql(),
        heldCents: consumedHeldCentsSql(),
    }).from(orders).where(and(...conditions)).groupBy(orders.branchId, orderBudgetPeriodSql())
}

/**
 * The assignment fence for the group roles, read from the database by user id
 * and never from the request. `null` means the caller is not fenced by
 * assignment: its tenant predicate is applied in `loadActiveBudgetBranches`.
 */
async function loadAssignedReportBranchIds(userRole: string, userId: unknown): Promise<number[] | null> {
    if (!usesMultiBranchScope(userRole)) return null
    if (typeof userId !== "string" || userId.length === 0) return []
    return resolveScopedBranchIds(db, userId)
}

/**
 * The approver reads budgets only with the same account grant that lets it
 * allocate them, re-read from the database rather than the JWT claim.
 */
async function mayReadBudgetReport(userRole: string, userId: unknown, userOrgId: unknown): Promise<boolean> {
    return userRole !== "GROUP_USER" || isGroupUserBudgetAllocationEnabled(userId, userOrgId)
}

/**
 * The branch set the request resolves to, fenced to the caller's assignments.
 * The group roles see their assigned branches and no others, whatever the
 * query string names; the fence is applied to the fully resolved set so a
 * group filter cannot reach past it either. `isNarrowed` marks a set that may
 * legitimately come out empty, which is answered with an empty report.
 */
async function resolveReportBranchIds(context: any): Promise<{ branchIds: number[]; isNarrowed: boolean }> {
    const assignedBranchIds = await loadAssignedReportBranchIds(context.userRole, context.userId)
    const branchIds = fenceToAssignedBranches(await resolveBudgetBranchIds(context), assignedBranchIds)
    return { branchIds, isNarrowed: context.groupIds.length > 0 || assignedBranchIds !== null }
}

/**
 * Whether the report is for one tenant that has budget allocation off. The
 * page reads the flag this answers to say so, rather than show a report of
 * zeroes as though they were a budget.
 */
async function isBudgetDisabledTenant(allowedOrgId: number | null): Promise<boolean> {
    return Boolean(allowedOrgId) && !await isOrganizationBudgetEnabled(Number(allowedOrgId))
}

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const userRole = ((session.user as any).role || "").toUpperCase().replace(/\s+/g, '_')
        const userOrgId = (session.user as any).organizationId
        const userBranchId = (session.user as any).branchId
        const userId = (session.user as any).id

        if (!await mayReadBudgetReport(userRole, userId, userOrgId)) {
            return NextResponse.json({ error: "Budget allocation is not enabled for this user" }, { status: 403 })
        }

        const url = new URL(req.url)
        const startDateParam = url.searchParams.get("startDate")
        const endDateParam = url.searchParams.get("endDate")
        const branchIdsParam = url.searchParams.get("branchIds")
        const branchIdParam = url.searchParams.get("branchId")
        const organizationIdParam = url.searchParams.get("organizationId")
        const groupIds = parseNumberList(url.searchParams.get("groupIds"))
        const months = parseNumberList(url.searchParams.get("months"))
        const years = parseNumberList(url.searchParams.get("years"))
        const preset = url.searchParams.get("preset") || ""
        const granularity = url.searchParams.get("granularity") || "monthly" // daily, monthly, yearly

        // 1. RBAC Check and Branch/Org Resolution
        const allowedOrgId = resolveAllowedBudgetOrganization(userRole, userOrgId, organizationIdParam)
        const pricesHidden = await shouldHidePricesForRole(userRole, allowedOrgId || userOrgId)
        const respond = (payload: any) => NextResponse.json(
            pricesHidden ? redactAnalyticsPrices({ ...payload, pricesHidden: true }) : payload
        )

        if (await isBudgetDisabledTenant(allowedOrgId)) return respond({ ...emptyBudgetSummary, budgetsEnabled: false })

        const { branchIds, isNarrowed } = await resolveReportBranchIds({
            branchIdsParam, branchIdParam, userRole, userId, userBranchId, allowedOrgId, groupIds,
        })

        if (isNarrowed && branchIds.length === 0) return respond(emptyBudgetSummary)

        if (branchIds.length === 0) {
            return NextResponse.json({ error: "No branches selected" }, { status: 400 })
        }

        // 2. Date/Period parsing
        const { startDate, endDate } = await resolveBudgetDateRange({ startDateParam, endDateParam, preset, branchIds, allowedOrgId })

        // Get unique YYYY-MM periods from the date range to query budgets table
        let periodList = buildAppMonthPeriods(startDate, endDate, months, years)

        if (["today", "3d", "7d", "monthly", "thisMonth"].includes(preset)) {
            periodList = [getAppMonthPeriod(endDate)]
        }

        if (periodList.length === 0) {
            return respond(emptyBudgetSummary)
        }

        // 3. Fetch All Relevant Branches with Baselines
        const activeBranches = await loadActiveBudgetBranches(branchIds, allowedOrgId)

        if (activeBranches.length === 0) {
            return respond(emptyBudgetSummary)
        }

        const actualBranchIds = activeBranches.map(b => b.id)


        // 4. Fetch Budget Allocations for the selected branches and periods
        const budgetRecords = await db
            .select({
                id: budgets.id,
                branchId: budgets.branchId,
                period: budgets.period,
                amountAllocatedCents: budgets.amountAllocatedCents,
                amountSpentCents: budgets.amountSpentCents,
                amountHeldCents: budgets.amountHeldCents,
                amountCreditedCents: budgets.amountCreditedCents,
            })
            .from(budgets)
            .where(
                and(
                    inArray(budgets.branchId, actualBranchIds),
                    inArray(budgets.period, periodList)
                )
            )

        // Create a lookup for budget records: branchId -> period -> record
        const budgetLookup = buildRecordLookup(budgetRecords)

        const useOrderScopedSpending = preset !== "all" && Boolean(
            startDateParam || endDateParam || months.length > 0 || years.length > 0
        )
        const orderScopedSpendingRows = await loadOrderScopedSpending({
            enabled: useOrderScopedSpending,
            branchIds: actualBranchIds,
            hasExplicitRange: Boolean(startDateParam || endDateParam),
            startDate,
            endDate,
            months,
            years,
        })

        const orderSpendingLookup = buildRecordLookup(orderScopedSpendingRows)
        const currentTotals = calculateBudgetTotals(activeBranches, periodList, budgetLookup, orderSpendingLookup, useOrderScopedSpending)
        const {
            allocated: totalAllocated,
            spent: totalSpent,
            held: totalHeld,
            credited: totalCredited,
        } = currentTotals

        const totalRemaining = (totalAllocated + totalCredited) - (totalSpent + totalHeld)

        // 5. Fetch Category Breakdown of Spending
        // We calculate spending based on FULFILLED orders in this date range
        // But we only show it if budget records actually exist for these branches
        const categorySpendingRows = budgetRecords.length > 0 ? await db
            .select({
                categoryId: globalProducts.categoryId,
                categoryName: categories.name,
                spentCents: sql<number>`SUM(ROUND(${orderItems.priceCents} * ${orderItems.quantity}) - COALESCE((SELECT SUM(amount_cents) FROM refund_items WHERE order_item_id = ${orderItems.id}), 0))`.mapWith(Number)
            })
            .from(orderItems)
            .innerJoin(orders, eq(orderItems.orderId, orders.id))
            .innerJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
            .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
                .where(
                    and(
                        inArray(orders.branchId, actualBranchIds),
                        gte(orders.createdAt, startDate),
                        lte(orders.createdAt, endDate),
                        inArray(orders.status, ['PENDING', 'APPROVED', 'FULFILLED']),
                        // Only include branches that have an active budget record in the current result set
                        inArray(orders.branchId, actualBranchIds),
                        budgetTrackedOrderSql(),
                    )
                )
            .groupBy(globalProducts.categoryId, categories.name)
            .orderBy(desc(sql`SUM(ROUND(${orderItems.priceCents} * ${orderItems.quantity}))`))
            : []

        // 5. MoM Insights calculation (Previous Period)
        const rangeDurationMs = endDate.getTime() - startDate.getTime()
        const prevEndDate = new Date(startDate.getTime() - 1)
        const prevStartDate = new Date(prevEndDate.getTime() - rangeDurationMs)

        const prevPeriodList = buildAppMonthPeriods(prevStartDate, prevEndDate)

        const prevBudgetRecords = await db.select().from(budgets).where(
            and(
                inArray(budgets.branchId, branchIds),
                inArray(budgets.period, prevPeriodList)
            )
        )

        const prevBudgetLookup = buildRecordLookup(prevBudgetRecords)
        const previousTotals = calculateBudgetTotals(activeBranches, prevPeriodList, prevBudgetLookup)
        const {
            allocated: prevTotalAllocated,
            spent: prevTotalSpent,
            held: prevTotalHeld,
            credited: prevTotalCredited,
        } = previousTotals

        const prevTotalRemaining = (prevTotalAllocated + prevTotalCredited) - (prevTotalSpent + prevTotalHeld)

        // Calculate deltas
        // Calculate deltas using merged spent values
        const currentTotalExpenditure = totalSpent + totalHeld
        const prevTotalExpenditure = prevTotalSpent + prevTotalHeld
        
        const spentGrowth = prevTotalExpenditure > 0 ? ((currentTotalExpenditure - prevTotalExpenditure) / prevTotalExpenditure) * 100 : 0
        const allocationGrowth = prevTotalAllocated > 0 ? ((totalAllocated - prevTotalAllocated) / prevTotalAllocated) * 100 : 0

        const finalChartData = buildBudgetChart(
            activeBranches, periodList, budgetLookup, orderSpendingLookup, useOrderScopedSpending, granularity,
        )
        const branchBreakdown = buildBranchBreakdown(
            activeBranches, periodList, budgetLookup, orderSpendingLookup, useOrderScopedSpending,
        )
        return respond({
            summary: {
                totalAllocated,
                totalSpent: totalSpent + totalHeld, // Merged for "Purchases" view
                totalHeld,
                totalCredited,
                totalRemaining
            },
            previousSummary: {
                totalAllocated: prevTotalAllocated,
                totalSpent: prevTotalSpent,
                totalHeld: prevTotalHeld,
                totalCredited: prevTotalCredited,
                totalRemaining: prevTotalRemaining
            },
            insights: {
                spentGrowth,
                allocationGrowth
            },
            categories: categorySpendingRows,
            chartData: finalChartData,
            branchBreakdown,
            budgetsEnabled: true,
        })
    } catch (error: any) {
        console.error("Budget Summary API Error:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
