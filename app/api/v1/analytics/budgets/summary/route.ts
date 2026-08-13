import { NextResponse,type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { budgets,orders,orderItems,branches,globalProducts,categories } from "@/db/schema"
import { and,eq,gte,lte,inArray,sql,desc,asc,isNotNull } from "drizzle-orm"
import { redactAnalyticsPrices,shouldHidePricesForRole } from "@/lib/price-visibility"
import { buildAppMonthPeriods,getAppMonthPeriod,parseEndDateParam,parseStartDateParam } from "@/lib/date-range-params"

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

async function resolveBudgetBranchIds(context: any) {
    let branchIds = context.branchIdsParam
        ? parseNumberList(context.branchIdsParam)
        : context.branchIdParam && context.branchIdParam !== "all"
            ? [Number(context.branchIdParam)]
            : []
    if (branchIds.length === 0 && ["BRANCH_ADMIN", "BRANCH_MANAGER", "ORDER_PORTAL"].includes(context.userRole)) {
        branchIds = [context.userBranchId]
    } else if (branchIds.length === 0 && context.allowedOrgId) {
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
    const firstBudget = context.preset === "all"
        ? await query.where(inArray(budgets.branchId, context.branchIds)).orderBy(asc(budgets.period)).limit(1)
        : await query.where(context.allowedOrgId
            ? eq(budgets.organizationId, context.allowedOrgId)
            : isNotNull(budgets.organizationId)).orderBy(asc(budgets.period)).limit(1)
    if (firstBudget.length > 0) return new Date(`${firstBudget[0].period}-01`)
    const start = new Date()
    start.setDate(1)
    return start
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

async function loadActiveBudgetBranches(branchIds: number[], allowedOrgId: number | null) {
    const selection = {
        id: branches.id,
        name: branches.name,
        baselineBudgetCents: branches.baselineBudgetCents,
        organizationId: branches.organizationId,
    }
    if (branchIds.length > 0) {
        return db.select(selection).from(branches).where(inArray(branches.id, branchIds))
    }
    if (allowedOrgId) {
        return db.select(selection).from(branches).where(and(
            eq(branches.organizationId, allowedOrgId),
            eq(branches.status, "active"),
        ))
    }
    return []
}

async function loadOrderScopedSpending(context: any) {
    if (!context.enabled) return []
    const conditions = [
        inArray(orders.branchId, context.branchIds),
        context.hasExplicitRange ? gte(orders.createdAt, context.startDate) : undefined,
        context.hasExplicitRange ? lte(orders.createdAt, context.endDate) : undefined,
        context.months.length > 0 ? sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(context.months, sql.raw(", "))})` : undefined,
        context.years.length > 0 ? sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(context.years, sql.raw(", "))})` : undefined,
    ].filter(Boolean) as any
    return db.select({
        branchId: orders.branchId,
        period: sql<string>`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`,
        spentCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) IN ('FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED') THEN GREATEST(0, ${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0)) ELSE 0 END), 0)`.mapWith(Number),
        heldCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) IN ('PENDING', 'APPROVED') THEN GREATEST(0, ${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0)) ELSE 0 END), 0)`.mapWith(Number),
    }).from(orders).where(and(...conditions)).groupBy(orders.branchId, sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)
}

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const userRole = ((session.user as any).role || "").toUpperCase().replace(/\s+/g, '_')
        const userOrgId = (session.user as any).organizationId
        const userBranchId = (session.user as any).branchId

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

        const branchIds = await resolveBudgetBranchIds({
            branchIdsParam, branchIdParam, userRole, userBranchId, allowedOrgId, groupIds,
        })

        if (groupIds.length > 0 && branchIds.length === 0) return respond(emptyBudgetSummary)

        if (branchIds.length === 0) {
            return NextResponse.json({ error: "No branches selected" }, { status: 400 })
        }

        // 2. Date/Period parsing
        const startDate = await resolveBudgetStartDate({ startDateParam, preset, branchIds, allowedOrgId })
        const endDate = parseEndDateParam(endDateParam) || new Date()

        if (!startDateParam) startDate.setHours(0, 0, 0, 0)
        if (!endDateParam) endDate.setHours(23, 59, 59, 999)

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
                        inArray(orders.branchId, actualBranchIds)
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
            branchBreakdown
        })
    } catch (error: any) {
        console.error("Budget Summary API Error:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
