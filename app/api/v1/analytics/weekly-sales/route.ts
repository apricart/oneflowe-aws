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

/**
 * Get the start of the current week (Monday) and end of the week (Sunday) in Pakistan timezone
 * Returns UTC timestamps for database comparison
 */
function getCurrentWeekRange() {
  // Get current time in Pakistan (Asia/Karachi is UTC+5)
  // Create a date representing current Pakistan time
  const now = new Date()

  // Convert current UTC time to Pakistan time to determine the day
  // Pakistan is UTC+5, so add 5 hours to get Pakistan time
  const pakistanOffset = 5 * 60 * 60 * 1000 // UTC+5 in milliseconds
  const nowInPakistan = new Date(now.getTime() + pakistanOffset)

  // Get day of week in Pakistan (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
  const dayOfWeek = nowInPakistan.getUTCDay()
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1

  // Calculate Monday 00:00:00 in Pakistan timezone
  const mondayInPakistan = new Date(nowInPakistan)
  mondayInPakistan.setUTCDate(nowInPakistan.getUTCDate() - daysToMonday)
  mondayInPakistan.setUTCHours(0, 0, 0, 0)

  // Convert back to UTC for database comparison
  const mondayUTC = new Date(mondayInPakistan.getTime() - pakistanOffset)

  // Calculate next Monday in UTC
  const nextMondayInPakistan = new Date(mondayInPakistan)
  nextMondayInPakistan.setUTCDate(mondayInPakistan.getUTCDate() + 7)
  const nextMondayUTC = new Date(nextMondayInPakistan.getTime() - pakistanOffset)

  // Calculate Sunday 23:59:59 in Pakistan timezone
  const sundayInPakistan = new Date(mondayInPakistan)
  sundayInPakistan.setUTCDate(mondayInPakistan.getUTCDate() + 6)
  sundayInPakistan.setUTCHours(23, 59, 59, 999)
  const sundayUTC = new Date(sundayInPakistan.getTime() - pakistanOffset)

  return {
    monday: mondayUTC,
    sunday: sundayUTC,
    nextMonday: nextMondayUTC,
    mondayInPakistan // For generating day keys
  }
}

export async function GET(req: NextRequest) {
  const err = await requireApiRole(allowedRoles as any)
  if (err) return err

  const scope = await getRequestScope()
  const role = scope?.role
  const pricesHidden = await shouldHidePricesForRole(role, scope?.organizationId)

  // Get filter parameters from query string (for UI context selection)
  const { searchParams } = new URL(req.url)
  const { organizationId, branchId, groupId } = resolveAnalyticsRequestScope(searchParams, scope)

  const { monday, sunday, nextMonday, mondayInPakistan } = getCurrentWeekRange()

  // Build conditions for weekly sales
  // Count orders when APPROVED (GMV style), not when fulfilled
  // Include APPROVED, FULFILLED, and REFUNDED orders
  // Use COALESCE for historical data
  const dateField = sql`COALESCE(${orders.approvedAt}, ${orders.fulfilledAt}, ${orders.createdAt})`

  const weekConditions: any[] = [
    gte(dateField, monday),
    lt(dateField, nextMonday),
    or(
      eq(orders.status, "APPROVED"),
      eq(orders.status, "approved"),
      eq(orders.status, "FULFILLED"),
      eq(orders.status, "fulfilled"),
      eq(orders.status, "REFUNDED"),
      eq(orders.status, "refunded")
    ),
  ]

  // Apply organization filter (if not SUPER_ADMIN or if explicitly selected)
  if (organizationId) {
    weekConditions.push(eq(orders.organizationId, organizationId))
  }

  // Apply branch filter (if explicitly selected)
  if (branchId) {
    weekConditions.push(eq(orders.branchId, branchId))
  }

  // Apply group filter
  if (groupId) {
    weekConditions.push(eq(branches.groupId, groupId))
  }

  // Query weekly sales broken down by day
  // Convert dateField to Pakistan timezone (Asia/Karachi, UTC+5)
  // This ensures we group by the day it was approved in local time
  const weeklySalesRows = await db
    .select({
      day: sql<string>`TO_CHAR((${dateField} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD')`,
      totalCents: metricExpressions.revenue,
      orderCount: sql<number>`coalesce(count(${orders.id}), 0)`,
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .where(and(...(weekConditions as any)))
    .groupBy(sql`TO_CHAR((${dateField} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD')`)
    .orderBy(sql`TO_CHAR((${dateField} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD')`)
  const salesMap: Record<string, { sales: number; orderCount: number }> = {}
  for (const row of weeklySalesRows) {
    const dateValue = row.day as any
    // PostgreSQL DATE type returns as string in format YYYY-MM-DD
    const dayKey = typeof dateValue === 'string'
      ? dateValue
      : new Date(dateValue).toISOString().slice(0, 10)

    salesMap[dayKey] = {
      sales: (row.totalCents || 0) / 100, // Convert cents to PKR
      orderCount: Number(row.orderCount || 0),
    }
  }

  // Generate all days of the week (Monday to Sunday) in Pakistan timezone
  // Format dates to match the database date format (YYYY-MM-DD)
  const weekDays = []
  for (let i = 0; i < 7; i++) {
    const dayInPakistan = new Date(mondayInPakistan)
    dayInPakistan.setUTCDate(mondayInPakistan.getUTCDate() + i)

    // Format as YYYY-MM-DD from Pakistan timezone to match database grouping
    const year = dayInPakistan.getUTCFullYear()
    const month = String(dayInPakistan.getUTCMonth() + 1).padStart(2, '0')
    const date = String(dayInPakistan.getUTCDate()).padStart(2, '0')
    const dayKey = `${year}-${month}-${date}`

    // Get day name for display (Monday, Tuesday, etc.)
    // dayInPakistan is already in Pakistan timezone (UTC representation)
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    const dayName = dayNames[dayInPakistan.getUTCDay()]

    weekDays.push({
      day: dayName,
      date: dayKey,
      sales: salesMap[dayKey]?.sales || 0,
      orderCount: salesMap[dayKey]?.orderCount || 0,
    })
  }

  const payload = {
    weekStart: monday.toISOString().slice(0, 10),
    weekEnd: sunday.toISOString().slice(0, 10),
    dailySales: weekDays,
    totalSales: weekDays.reduce((sum, day) => sum + day.sales, 0),
    totalOrders: weekDays.reduce((sum, day) => sum + day.orderCount, 0),
    pricesHidden,
  }

  return ok(pricesHidden ? redactAnalyticsPrices(payload) : payload)
}

