import { NextRequest } from "next/server"
import { and,eq,gte,lte,sql,or,inArray,desc } from "drizzle-orm"
import { requireApiRole,ok,error } from "@/lib/api"
import { db } from "@/lib/db"
import { orders,branches,organizations,orderItems,refunds,refundItems } from "@/db/schema"
import { getRequestScope } from "@/lib/auth"
import { getCached,generateCacheKey,CACHE_TTL } from "@/lib/cache-utils"
import { metricExpressions } from "@/lib/metric-utils"
import { redactAnalyticsPrices,shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam,parseStartDateParam } from "@/lib/date-range-params"

const allowedRoles = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"] as const
type Role = typeof allowedRoles[number]

export async function GET(req: NextRequest) {
    const err = await requireApiRole(allowedRoles as any)
    if (err) return err

    const scope = await getRequestScope()
    const role = scope?.role as Role | undefined

    const { searchParams } = new URL(req.url)
    const orgIdParam = searchParams.get("organizationId")
    const branchIdParam = searchParams.get("branchId")
    const branchIdsParam = searchParams.get("branchIds") // comma-separated
    const organizationIdsParam = searchParams.get("organizationIds") // comma-separated
    const groupIdParam = searchParams.get("groupId")
    const groupIdsParam = searchParams.get("groupIds")
    const statusParam = searchParams.get("status") // PENDING | FULFILLED | REFUNDED | all
    const startDateParam = searchParams.get("startDate")
    const endDateParam = searchParams.get("endDate")
    const compareStartDateParam = searchParams.get("compareStartDate")
    const compareEndDateParam = searchParams.get("compareEndDate")

    const monthsRaw = searchParams.get("months")
    const yearsRaw = searchParams.get("years")
    const compareMonthsRaw = searchParams.get("compareMonths")
    const compareYearsRaw = searchParams.get("compareYears")

    const parsedMonths = monthsRaw ? monthsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n >= 1 && n <= 12) : []
    const parsedYears = yearsRaw ? yearsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 2000) : []
    const parsedCompMonths = compareMonthsRaw ? compareMonthsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n >= 1 && n <= 12) : []
    const parsedCompYears = compareYearsRaw ? compareYearsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 2000) : []
    const includeStatusCounts = searchParams.get("includeStatusCounts") === "true"

    let organizationId: number | null = null
    let branchId: number | null = null
    let groupId: number | null = null
    let groupIds: number[] = []
    let branchIds: number[] = []
    let organizationIds: number[] = []

    // SECURITY: Enforce strict data isolation based on user role
    if (role === "BRANCH_ADMIN") {
        // Branch Admin can only see their own branch
        organizationId = scope?.organizationId ?? null
        branchId = scope?.branchId ?? null
        // IGNORE URL PARAMETERS for security
    } else if (role === "HEAD_OFFICE") {
        // Head Office can see all branches in their organization, but not other organizations
        organizationId = scope?.organizationId ?? null
        // Only allow branch filtering within their organization
        if (branchIdParam && branchIdParam !== "null" && branchIdParam !== "0") {
            const requestedBranchId = Number(branchIdParam)
            // Verify this branch belongs to their organization
            if (organizationId && requestedBranchId) {
                try {
                    const [branchCheck] = await db
                        .select({ id: branches.id })
                        .from(branches)
                        .where(and(eq(branches.id, requestedBranchId), eq(branches.organizationId, organizationId)))
                        .limit(1)
                    
                    if (branchCheck) {
                        branchId = requestedBranchId
                    } else {
                        console.warn(`[Security] Head Office user tried to access branch ${requestedBranchId} outside their org ${organizationId}`)
                        return error("Access denied: Branch not found in your organization")
                    }
                } catch (err) {
                    console.error("[Security] Error verifying branch access for Head Office:", err)
                    return error("Access verification failed")
                }
            }
        }
        // IGNORE organizationId parameter for security
    } else if (role === "SUPER_ADMIN") {
        // Super Admin can see everything (intended)
        if (orgIdParam && orgIdParam !== "null" && orgIdParam !== "0") {
            organizationId = Number(orgIdParam)
        }
        if (branchIdParam && branchIdParam !== "null" && branchIdParam !== "0") {
            branchId = Number(branchIdParam)
        }
    } else {
        // Unknown role - deny access
        console.warn(`[Security] Unknown role ${role} attempting to access sales-performance API`)
        return error("Access denied: Invalid user role")
    }
    const pricesHidden = await shouldHidePricesForRole(role, scope?.organizationId)

    if (branchIdsParam) {
        branchIds = branchIdsParam.split(",").map(Number).filter(n => !Number.isNaN(n) && n > 0)
    }

    if (organizationIdsParam) {
        organizationIds = organizationIdsParam.split(",").map(Number).filter(n => !Number.isNaN(n) && n > 0)
    }

    if (groupIdParam && groupIdParam !== "null" && groupIdParam !== "0") {
        groupId = Number(groupIdParam)
    }

    if (groupIdsParam) {
        groupIds = groupIdsParam.split(",").map(Number).filter(n => !Number.isNaN(n) && n > 0)
    } else if (groupId) {
        groupIds = [groupId]
    }

    // Date range - default to today
    const now = new Date()
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date(now)
    todayEnd.setHours(23, 59, 59, 999)

    const startDate = parseStartDateParam(startDateParam) || todayStart
    const endDate = parseEndDateParam(endDateParam) || todayEnd

    // Determine granularity for series: hourly for 1 day, daily for ≤32 days, monthly for ≤400 days, yearly for more
    const diffMs = endDate.getTime() - startDate.getTime()
    const diffDays = diffMs / (1000 * 60 * 60 * 24)
    
    const forcedGranularity = searchParams.get("granularity") as "hourly" | "daily" | "monthly" | "yearly" | null
    const isValidGranularity = ["hourly", "daily", "monthly", "yearly"].includes(forcedGranularity || "")

    let granularity: "hourly" | "daily" | "monthly" | "yearly"
    if (isValidGranularity) {
        granularity = forcedGranularity!
    } else if (parsedMonths.length > 0) {
        // Multi-select months: if multiple months or years, use monthly, otherwise daily for that specific month
        granularity = (parsedMonths.length > 1 || parsedYears.length > 1) ? "monthly" : "daily"
    } else if (parsedYears.length > 0) {
        // Multi-select years: if multiple years, use yearly, otherwise monthly for that specific year
        granularity = parsedYears.length > 1 ? "yearly" : "monthly"
    } else {
        granularity = (() => {
          if (diffDays <= 1) {
            return "hourly"
          }
          if (diffDays <= 32) {
            return "daily"
          }
          if (diffDays <= 400) {
            return "monthly"
          }
          return "yearly"
        })()
    }

    const cacheKey = generateCacheKey("sales-perf", {
        role, organizationId, branchId,
        branchIds: branchIds.join(","),
        organizationIds: organizationIds.join(","),
        groupIds: groupIds.join(","),
        status: statusParam,
        start: startDate.toISOString().slice(0, 16),
        end: endDate.toISOString().slice(0, 16),
        compareStart: compareStartDateParam || "",
        compareEnd: compareEndDateParam || "",
        months: parsedMonths.join(","),
        years: parsedYears.join(","),
        compareMonths: parsedCompMonths.join(","),
        compareYears: parsedCompYears.join(","),
        granularity,
        includeStatusCounts: includeStatusCounts ? "1" : "0",
        pricesHidden,
    })

    const fetchData = async () => {
        const dashboardCreatedAt = sql`(${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi'`

        // Build base conditions
        const conditions: any[] = []

        // Primary Date filter logic (Fallback to bounds only if exact disjoint sets not sent)
        if (!monthsRaw && !yearsRaw) {
            conditions.push(gte(orders.createdAt, startDate), lte(orders.createdAt, endDate))
        }

        // Advanced Multi-Select Date Filtering (Months / Years arrays)
        if (parsedMonths.length > 0) {
            conditions.push(sql`EXTRACT(MONTH FROM ${dashboardCreatedAt}) IN (${sql.join(parsedMonths, sql.raw(", "))})`)
        }
        if (parsedYears.length > 0) {
            conditions.push(sql`EXTRACT(YEAR FROM ${dashboardCreatedAt}) IN (${sql.join(parsedYears, sql.raw(", "))})`)
        }

        // Status filter: normalize to uppercase for comparison
        const upperStatus = statusParam?.toUpperCase()
        if (upperStatus && upperStatus !== "ALL") {
            if (upperStatus === "REJECTED") {
                conditions.push(or(eq(sql`UPPER(${orders.status})`, "REJECTED"), eq(sql`UPPER(${orders.status})`, "CANCELLED")))
            } else if (upperStatus === "FULFILLED") {
                // FULFILLED = all fulfilled orders including partially refunded ones
                conditions.push(
                    inArray(sql`UPPER(${orders.status})`, ["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"])
                )
            } else if (upperStatus === "DELIVERED") {
                conditions.push(
                    eq(sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED'))`, "DELIVERED")
                )
            } else if (upperStatus === "NOT_DELIVERED") {
                conditions.push(
                    sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) <> 'DELIVERED'`
                )
            } else {
                conditions.push(eq(sql`UPPER(${orders.status})`, upperStatus))
            }
        }

        // Scope filters
        if (organizationIds.length > 0) {
            conditions.push(inArray(orders.organizationId, organizationIds))
        } else if (organizationId) {
            conditions.push(eq(orders.organizationId, organizationId))
        }

        if (branchIds.length > 0) {
            conditions.push(inArray(orders.branchId, branchIds))
        } else if (branchId) {
            conditions.push(eq(orders.branchId, branchId))
        }

        if (groupIds.length > 0) {
            conditions.push(inArray(branches.groupId, groupIds))
        } else if (groupId) {
            conditions.push(eq(branches.groupId, groupId))
        }

        const whereClause = and(...conditions)
        const revenueEligibleStatus = sql`UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`

        // ── Series data ──
        let dateExpr: any
        let labelExpr: any

        if (granularity === "hourly") {
            dateExpr = sql`date_trunc('hour', (${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi')`
            labelExpr = sql<string>`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'HH12:MI AM')`
        } else if (granularity === "daily") {
            dateExpr = sql`date_trunc('day', (${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi')`
            labelExpr = sql<string>`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'DD Mon')`
        } else if (granularity === "monthly") {
            dateExpr = sql`date_trunc('month', (${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi')`
            labelExpr = sql<string>`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'Mon YYYY')`
        } else {
            dateExpr = sql`date_trunc('year', (${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi')`
            labelExpr = sql<string>`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY')`
        }

        const seriesRows = await db
            .select({
                bucket: dateExpr,
                label: labelExpr,
                totalSales: metricExpressions.revenue,
                netSales: metricExpressions.revenue,
                orderCount: sql<number>`COALESCE(COUNT(1), 0)`.mapWith(Number),
            })
            .from(orders)
            .leftJoin(branches, eq(orders.branchId, branches.id))
            .where(whereClause)
            .groupBy(dateExpr, labelExpr)
            .orderBy(dateExpr)

        const seriesQuantityRows = await db
            .select({
                bucket: dateExpr,
                label: labelExpr,
                grossQuantity: sql<number>`COALESCE(SUM(CASE WHEN ${revenueEligibleStatus} THEN COALESCE(${orderItems.quantity}, 0) ELSE 0 END), 0)`.mapWith(Number),
            })
            .from(orders)
            .leftJoin(branches, eq(orders.branchId, branches.id))
            .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
            .where(whereClause)
            .groupBy(dateExpr, labelExpr)
            .orderBy(dateExpr)

        const seriesRefundQuantityRows = await db
            .select({
                bucket: dateExpr,
                label: labelExpr,
                refundedQuantity: sql<number>`COALESCE(SUM(CASE WHEN ${revenueEligibleStatus} THEN COALESCE(${refundItems.quantity}, 0) ELSE 0 END), 0)`.mapWith(Number),
            })
            .from(orders)
            .leftJoin(branches, eq(orders.branchId, branches.id))
            .leftJoin(refunds, and(eq(refunds.orderId, orders.id), eq(sql`UPPER(${refunds.status})`, "APPROVED")))
            .leftJoin(refundItems, eq(refundItems.refundId, refunds.id))
            .where(whereClause)
            .groupBy(dateExpr, labelExpr)
            .orderBy(dateExpr)

        const grossQuantityByLabel = new Map(seriesQuantityRows.map((r) => [String(r.label), Number(r.grossQuantity || 0)]))
        const refundedQuantityByLabel = new Map(seriesRefundQuantityRows.map((r) => [String(r.label), Number(r.refundedQuantity || 0)]))

        const seriesData = seriesRows.map(r => ({
            label: r.label,
            sales: (r.totalSales || 0) / 100,
            netSales: (r.netSales || 0) / 100,
            orders: Number(r.orderCount || 0),
            itemQuantity: Math.max(0, (grossQuantityByLabel.get(String(r.label)) || 0) - (refundedQuantityByLabel.get(String(r.label)) || 0)),
        }))

        // ── Aggregates ──
        const totalSales = seriesData.reduce((s, r) => s + r.sales, 0)
        const totalNetSales = seriesData.reduce((s, r) => s + r.netSales, 0)
        const totalOrders = seriesData.reduce((s, r) => s + r.orders, 0)
        const totalItemsSold = seriesData.reduce((s, r) => s + r.itemQuantity, 0)
        const activePeriods = seriesData.filter(r => r.sales > 0)
        const activeQuantityPeriods = seriesData.filter(r => r.itemQuantity > 0)
        const avgSales = activePeriods.length > 0 ? totalSales / activePeriods.length : 0
        const avgItemsSold = activeQuantityPeriods.length > 0 ? totalItemsSold / activeQuantityPeriods.length : 0

        const peakPeriod = (() => {
          if (seriesData.length > 0) {
            return seriesData.reduce((max, r) => r.sales > max.sales ? r : max, seriesData[0])
          }
          return null
        })()
        const peakQuantityPeriod = (() => {
          if (seriesData.length > 0) {
            return seriesData.reduce((max, r) => r.itemQuantity > max.itemQuantity ? r : max, seriesData[0])
          }
          return null
        })()

        // ── Branch breakdown ──
        const branchConditions: any[] = [...conditions] // Apply primary date matrices 
        
        if (statusParam && statusParam !== "all") {
            branchConditions.push(sql`UPPER(${orders.status}) = ${statusParam.toUpperCase()}`)
        } else {
            branchConditions.push(
                sql`UPPER(${orders.status}) IN ('APPROVED', 'FULFILLED', 'REFUNDED', 'PENDING', 'REJECTED', 'CANCELLED')`
            )
        }
        
        if (organizationIds.length > 0) {
            branchConditions.push(inArray(orders.organizationId, organizationIds))
        } else if (organizationId) {
            branchConditions.push(eq(orders.organizationId, organizationId))
        }
        if (branchIds.length > 0) {
            branchConditions.push(inArray(orders.branchId, branchIds))
        } else if (branchId) {
            branchConditions.push(eq(orders.branchId, branchId))
        }
        if (groupIds.length > 0) {
            branchConditions.push(inArray(branches.groupId, groupIds))
        } else if (groupId) {
            branchConditions.push(eq(branches.groupId, groupId))
        }

        let branchQuery = db
            .select({
                branchId: branches.id,
                branchName: branches.name,
                totalSales: metricExpressions.revenue,
                totalNetSales: metricExpressions.revenue,
                orderCount: sql<number>`COALESCE(COUNT(${orders.id}), 0)`.mapWith(Number),
            })
            .from(branches)
            .leftJoin(orders, and(eq(orders.branchId, branches.id), and(...branchConditions)))

        if (organizationIds.length > 0) {
            branchQuery = branchQuery.where(inArray(branches.organizationId, organizationIds)) as any
        } else if (organizationId) {
            branchQuery = branchQuery.where(eq(branches.organizationId, organizationId)) as any
        }

        const branchRows = await branchQuery
            .groupBy(branches.id, branches.name)
            .orderBy(desc(metricExpressions.revenue))
            .limit(20)

        const branchSales = branchRows.map(r => ({
            branchId: r.branchId,
            branchName: r.branchName || "Unnamed",
            sales: (r.totalSales || 0) / 100,
            netSales: (r.totalNetSales || 0) / 100,
            orders: Number(r.orderCount || 0),
        }))

        // ── Organization breakdown (Super Admin only, when no org is selected) ──
        let organizationSales: any[] = []
        if (role === "SUPER_ADMIN" && !organizationId) {
            const orgRows = await db
                .select({
                    organizationId: organizations.id,
                    organizationName: organizations.name,
                    totalSales: metricExpressions.revenue,
                    totalNetSales: metricExpressions.revenue,
                    orderCount: sql<number>`COALESCE(COUNT(${orders.id}), 0)`.mapWith(Number),
                })
                .from(organizations)
                .leftJoin(orders, and(eq(orders.organizationId, organizations.id), whereClause))
                .groupBy(organizations.id, organizations.name)
                .orderBy(desc(metricExpressions.revenue))
                .limit(20)

            organizationSales = orgRows.map(r => ({
                organizationId: r.organizationId,
                organizationName: r.organizationName || "Unnamed",
                sales: (r.totalSales || 0) / 100,
                netSales: (r.totalNetSales || 0) / 100,
                orders: Number(r.orderCount || 0),
            }))
        }

        // ── Comparison Logic ──
        let comparison: any = null
        const hasCompareArrays = parsedCompMonths.length > 0 || parsedCompYears.length > 0
        const hasPrimaryDates = startDate && endDate

        if (searchParams.get("compare") === "true" && (hasPrimaryDates || compareStartDateParam || hasCompareArrays)) {
            const compConditions: any[] = []

            if (parsedCompMonths.length > 0) {
                compConditions.push(sql`EXTRACT(MONTH FROM ${dashboardCreatedAt}) IN (${sql.join(parsedCompMonths, sql.raw(", "))})`)
            }
            if (parsedCompYears.length > 0) {
                compConditions.push(sql`EXTRACT(YEAR FROM ${dashboardCreatedAt}) IN (${sql.join(parsedCompYears, sql.raw(", "))})`)
            }

            if (!hasCompareArrays) {
                let prevStart: Date
                let prevEnd: Date
                if (compareStartDateParam && compareEndDateParam) {
                    prevStart = parseStartDateParam(compareStartDateParam) || new Date(compareStartDateParam)
                    prevEnd = parseEndDateParam(compareEndDateParam) || new Date(compareEndDateParam)
                } else if (startDate && endDate && parsedMonths.length === 0 && parsedYears.length === 0) {
                    const start = startDate
                    const end = endDate
                    const duration = end.getTime() - start.getTime()
                    prevStart = new Date(start.getTime() - duration - 1)
                    prevEnd = new Date(start.getTime() - 1)
                } else {
                    prevStart = new Date(0)
                    prevEnd = new Date(0)
                }

                if (prevStart.getTime() !== 0) {
                    compConditions.push(gte(orders.createdAt, prevStart), lte(orders.createdAt, prevEnd))
                }
            }

            const compAllStatusConditions: any[] = [...compConditions]

            if (upperStatus && upperStatus !== "ALL") {
                if (upperStatus === "REJECTED") {
                    compConditions.push(or(eq(sql`UPPER(${orders.status})`, "REJECTED"), eq(sql`UPPER(${orders.status})`, "CANCELLED")))
                } else if (upperStatus === "DELIVERED") {
                    compConditions.push(
                        eq(sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED'))`, "DELIVERED")
                    )
                } else if (upperStatus === "NOT_DELIVERED") {
                    compConditions.push(
                        sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) <> 'DELIVERED'`
                    )
                } else {
                    compConditions.push(eq(sql`UPPER(${orders.status})`, upperStatus))
                }
            }

            if (organizationIds.length > 0) {
                compConditions.push(inArray(orders.organizationId, organizationIds))
                compAllStatusConditions.push(inArray(orders.organizationId, organizationIds))
            } else if (organizationId) {
                compConditions.push(eq(orders.organizationId, organizationId))
                compAllStatusConditions.push(eq(orders.organizationId, organizationId))
            }
            if (branchIds.length > 0) {
                compConditions.push(inArray(orders.branchId, branchIds))
                compAllStatusConditions.push(inArray(orders.branchId, branchIds))
            } else if (branchId) {
                compConditions.push(eq(orders.branchId, branchId))
                compAllStatusConditions.push(eq(orders.branchId, branchId))
            }
            if (groupIds.length > 0) {
                compConditions.push(inArray(branches.groupId, groupIds))
                compAllStatusConditions.push(inArray(branches.groupId, groupIds))
            } else if (groupId) {
                compConditions.push(eq(branches.groupId, groupId))
                compAllStatusConditions.push(eq(branches.groupId, groupId))
            }

            const compWhere = compConditions.length > 0 ? and(...compConditions) : undefined

            // Series for comparison
            const compSeriesRows = await db
                .select({
                    bucket: dateExpr,
                    label: labelExpr,
                    totalSales: metricExpressions.revenue,
                    totalNetSales: metricExpressions.revenue,
                    orderCount: sql<number>`COALESCE(COUNT(1), 0)`.mapWith(Number),
                })
                .from(orders)
                .leftJoin(branches, eq(orders.branchId, branches.id))
                .where(compWhere)
                .groupBy(dateExpr, labelExpr)
                .orderBy(dateExpr)

            const compSeriesQuantityRows = await db
                .select({
                    bucket: dateExpr,
                    label: labelExpr,
                    grossQuantity: sql<number>`COALESCE(SUM(CASE WHEN ${revenueEligibleStatus} THEN COALESCE(${orderItems.quantity}, 0) ELSE 0 END), 0)`.mapWith(Number),
                })
                .from(orders)
                .leftJoin(branches, eq(orders.branchId, branches.id))
                .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
                .where(compWhere)
                .groupBy(dateExpr, labelExpr)
                .orderBy(dateExpr)

            const compSeriesRefundQuantityRows = await db
                .select({
                    bucket: dateExpr,
                    label: labelExpr,
                    refundedQuantity: sql<number>`COALESCE(SUM(CASE WHEN ${revenueEligibleStatus} THEN COALESCE(${refundItems.quantity}, 0) ELSE 0 END), 0)`.mapWith(Number),
                })
                .from(orders)
                .leftJoin(branches, eq(orders.branchId, branches.id))
                .leftJoin(refunds, and(eq(refunds.orderId, orders.id), eq(sql`UPPER(${refunds.status})`, "APPROVED")))
                .leftJoin(refundItems, eq(refundItems.refundId, refunds.id))
                .where(compWhere)
                .groupBy(dateExpr, labelExpr)
                .orderBy(dateExpr)

            const compGrossQuantityByLabel = new Map(compSeriesQuantityRows.map((r) => [String(r.label), Number(r.grossQuantity || 0)]))
            const compRefundedQuantityByLabel = new Map(compSeriesRefundQuantityRows.map((r) => [String(r.label), Number(r.refundedQuantity || 0)]))

            const compSeriesData = compSeriesRows.map(r => ({
                label: r.label,
                sales: (r.totalSales || 0) / 100,
                netSales: (r.totalNetSales || 0) / 100,
                orders: Number(r.orderCount || 0),
                itemQuantity: Math.max(0, (compGrossQuantityByLabel.get(String(r.label)) || 0) - (compRefundedQuantityByLabel.get(String(r.label)) || 0)),
            }))

            const compTotalSales = compSeriesData.reduce((s, r) => s + r.sales, 0)
            const compTotalNetSales = compSeriesData.reduce((s, r) => s + r.netSales, 0)
            const compTotalOrders = compSeriesData.reduce((s, r) => s + r.orders, 0)
            const compTotalItemsSold = compSeriesData.reduce((s, r) => s + r.itemQuantity, 0)

            // Aggregated counts for all statuses (for KPI comparison)
            const compAllWhere = compAllStatusConditions.length > 0 ? and(...compAllStatusConditions) : undefined
            const compStatusCounts = await db.select({
                fulfilledCount: metricExpressions.fulfilledCount,
                partialCount: metricExpressions.partialCount,
                fulfilledNetSales: metricExpressions.revenue,
                refundedCount: metricExpressions.refundedCount,
                rejectedCount: metricExpressions.rejectedCount,
                approvedCount: metricExpressions.approvedCount,
                pendingCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'PENDING' THEN 1 END), 0)`.mapWith(Number),
                deliveredCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'APPROVED' AND UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) = 'DELIVERED' THEN 1 END), 0)`.mapWith(Number),
                notDeliveredCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'APPROVED' AND UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) <> 'DELIVERED' THEN 1 END), 0)`.mapWith(Number),
            })
                .from(orders)
                .leftJoin(branches, eq(orders.branchId, branches.id))
                .where(compAllWhere)

            comparison = {
                totalSales: compTotalSales,
                totalNetSales: compTotalNetSales,
                totalOrders: compTotalOrders,
                totalItemsSold: compTotalItemsSold,
                fulfilledCount: compStatusCounts[0]?.fulfilledCount || 0,
                partialCount: compStatusCounts[0]?.partialCount || 0,
                fulfilledNetSales: (compStatusCounts[0]?.fulfilledNetSales || 0) / 100,
                refundedCount: compStatusCounts[0]?.refundedCount || 0,
                rejectedCount: compStatusCounts[0]?.rejectedCount || 0,
                approvedCount: compStatusCounts[0]?.approvedCount || 0,
                pendingCount: compStatusCounts[0]?.pendingCount || 0,
                deliveredCount: compStatusCounts[0]?.deliveredCount || 0,
                notDeliveredCount: compStatusCounts[0]?.notDeliveredCount || 0,
                seriesData: compSeriesData
            }
        }

        // ── Status counts (single query, replaces 6 separate per-status API calls) ──
        let statusCounts: {
            pendingCount: number
            approvedCount: number
            fulfilledCount: number
            partialCount: number
            refundedCount: number
            rejectedCount: number
            deliveredCount: number
            notDeliveredCount: number
        } | null = null

        if (includeStatusCounts && (!statusParam || statusParam.toUpperCase() === "ALL")) {
            const [counts] = await db.select({
                pendingCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'PENDING' THEN 1 END), 0)`.mapWith(Number),
                approvedCount: metricExpressions.approvedCount,
                fulfilledCount: metricExpressions.fulfilledCount,
                partialCount: metricExpressions.partialCount,
                refundedCount: metricExpressions.refundedCount,
                rejectedCount: metricExpressions.rejectedCount,
                deliveredCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'APPROVED' AND UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) = 'DELIVERED' THEN 1 END), 0)`.mapWith(Number),
                notDeliveredCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'APPROVED' AND UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) <> 'DELIVERED' THEN 1 END), 0)`.mapWith(Number),
            })
            .from(orders)
            .leftJoin(branches, eq(orders.branchId, branches.id))
            .where(whereClause)

            if (counts) {
                statusCounts = {
                    pendingCount: counts.pendingCount,
                    approvedCount: counts.approvedCount,
                    fulfilledCount: counts.fulfilledCount,
                    partialCount: counts.partialCount,
                    refundedCount: counts.refundedCount,
                    rejectedCount: counts.rejectedCount,
                    deliveredCount: counts.deliveredCount,
                    notDeliveredCount: counts.notDeliveredCount,
                }
            }
        }

        return {
            granularity,
            seriesData,
            totalSales,
            totalNetSales,
            totalOrders,
            totalItemsSold,
            avgItemsSold,
            avgSales,
            peakPeriod,
            peakQuantityPeriod,
            branchSales,
            organizationSales,
            comparison,
            statusCounts,
        }
    }

    const data = await getCached(cacheKey, fetchData, CACHE_TTL.ANALYTICS)
    return ok(pricesHidden ? redactAnalyticsPrices({ ...data, pricesHidden }) : { ...data, pricesHidden })
}
