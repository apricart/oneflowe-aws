import { NextRequest } from "next/server"
import { and, eq, gte, sql, or, lt } from "drizzle-orm"
import { requireApiRole, ok } from "@/lib/api"
import { db } from "@/lib/db"
import { orders, branches } from "@/db/schema"
import { getRequestScope } from "@/lib/auth"
import { metricExpressions } from "@/lib/metric-utils"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { resolveAnalyticsRequestScope } from "@/lib/analytics-request-scope"

const allowedRoles = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"] as const

type Role = typeof allowedRoles[number]

export async function GET(req: NextRequest) {
  const err = await requireApiRole(allowedRoles as any)
  if (err) return err

  const scope = await getRequestScope()
  const role = scope?.role
  const pricesHidden = await shouldHidePricesForRole(role, scope?.organizationId)

  // Get filter parameters from query string (for UI context selection)
  const { searchParams } = new URL(req.url)
  const yearParam = searchParams.get("year")
  const { organizationId, branchId, groupId } = resolveAnalyticsRequestScope(searchParams, scope)

  // Get year from query param or use current year
  const currentYear = new Date().getFullYear()
  const year = yearParam ? Number(yearParam) : currentYear

  // Calculate start and end of the year in Pakistan timezone (UTC+5)
  // Then convert to UTC for database comparison
  const pakistanOffset = 5 * 60 * 60 * 1000 // UTC+5 in milliseconds

  // Year start in Pakistan timezone (January 1st, 00:00:00 PK time)
  const yearStartPK = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0))
  // Convert to UTC for database (subtract 5 hours)
  const yearStart = new Date(yearStartPK.getTime() - pakistanOffset)

  // Next year start in Pakistan timezone
  const nextYearStartPK = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0))
  const nextYearStart = new Date(nextYearStartPK.getTime() - pakistanOffset)

  // Build conditions for yearly sales
  // Count orders when APPROVED (GMV style), not when fulfilled
  // Include APPROVED, FULFILLED, and REFUNDED orders for the selected year
  // Use COALESCE to handle history where approvedAt is null
  const dateField = sql`COALESCE(${orders.approvedAt}, ${orders.fulfilledAt}, ${orders.createdAt})`

  const yearConditions: any[] = [
    sql`${dateField} IS NOT NULL`,
    gte(dateField, yearStart),
    lt(dateField, nextYearStart),
    or(
      eq(orders.status, "APPROVED"),
      eq(orders.status, "approved"),
      eq(orders.status, "FULFILLED"),
      eq(orders.status, "fulfilled"),
      eq(orders.status, "REFUNDED"),
      eq(orders.status, "refunded")
    ),
  ]

  // Apply organization filter
  if (organizationId) {
    yearConditions.push(eq(orders.organizationId, organizationId))
  }

  // Apply branch filter
  if (branchId) {
    yearConditions.push(eq(orders.branchId, branchId))
  }

  // Apply group filter
  if (groupId) {
    yearConditions.push(eq(branches.groupId, groupId))
  }

  // Query yearly sales broken down by month
  // Convert dateField to Pakistan timezone (Asia/Karachi, UTC+5)
  const monthlySalesRows = await db
    .select({
      monthNum: sql<number>`EXTRACT(MONTH FROM (${dateField} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi')::int`,
      month: sql<string>`TO_CHAR((${dateField} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'Mon')`,
      totalCents: metricExpressions.revenue,
      orderCount: sql<number>`coalesce(count(${orders.id}), 0)`,
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .where(and(...(yearConditions as any)))
    .groupBy(sql`1,2`)
    .orderBy(sql`1`)

  // Create a map of month -> sales
  const salesMap: Record<string, { sales: number; orderCount: number }> = {}
  for (const row of monthlySalesRows) {
    const monthKey = row.month
    salesMap[monthKey] = {
      sales: (row.totalCents || 0) / 100, // Convert cents to PKR
      orderCount: Number(row.orderCount || 0),
    }
  }

  // Generate all months of the year (Jan to Dec)
  const monthsOrder = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const monthlyData = monthsOrder.map(month => ({
    month,
    sales: salesMap[month]?.sales || 0,
    orderCount: salesMap[month]?.orderCount || 0,
  }))

  const payload = {
    year,
    monthlySales: monthlyData,
    totalSales: monthlyData.reduce((sum, month) => sum + month.sales, 0),
    totalOrders: monthlyData.reduce((sum, month) => sum + month.orderCount, 0),
    pricesHidden,
  }

  return ok(pricesHidden ? redactAnalyticsPrices(payload) : payload)
}

