import { NextRequest } from "next/server"
import { eq, and } from "drizzle-orm"
import { db } from "@/lib/db"
import { scheduledReports, orders, branches } from "@/db/schema"
import { sendReportEmail } from "@/lib/email"
import { ok, error, requireApiRole } from "@/lib/api"
import { z } from "zod"
import { timingSafeEqual } from "node:crypto"
import { getRequestScope } from "@/lib/auth"
import { env } from "@/lib/server/env"
import { withRateLimit } from "@/lib/rate-limiter"
import { createCsv } from "@/lib/spreadsheet"

const processScheduleSchema = z.object({
    scheduleId: z.coerce.number().int().positive().optional(),
    isTest: z.boolean().optional().default(false),
}).strict()

function hasCronAuthorization(req: NextRequest): boolean {
    const supplied = req.headers.get("authorization") || ""
    const expected = `Bearer ${env.CRON_SECRET}`
    const suppliedBuffer = Buffer.from(supplied)
    const expectedBuffer = Buffer.from(expected)
    return suppliedBuffer.length === expectedBuffer.length &&
        timingSafeEqual(suppliedBuffer, expectedBuffer)
}

/**
 * Report Processing API
 * Used by a cron job or "Test Now" trigger to send scheduled reports.
 */
export async function POST(req: NextRequest) {
    const parsedBody = processScheduleSchema.safeParse(await req.json().catch(() => null))
    if (!parsedBody.success) return error("Invalid schedule request", 400)

    const cronAuthorized = hasCronAuthorization(req)
    let userId: string | null = null
    let { scheduleId, isTest } = parsedBody.data

    if (!cronAuthorized) {
        const authError = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"])
        if (authError) return authError

        const scope = await getRequestScope()
        if (!scope?.userId) return error("Unauthorized", 401)
        if (!scheduleId) return error("scheduleId is required for manual processing", 400)

        userId = scope.userId
        isTest = true
        const rateLimit = await withRateLimit("report", scope.userId)
        if (rateLimit) return rateLimit
    }

    const conditions = []
    if (scheduleId) {
        conditions.push(eq(scheduledReports.id, Number(scheduleId)))
        if (userId) conditions.push(eq(scheduledReports.userId, userId))
    } else {
        conditions.push(eq(scheduledReports.enabled, true))
        // Batch mode: only process if due (pseudo-logic for demo purposes)
        // In a real system, we'd check frequency vs lastExecutedAt
    }

    const schedules = await db
        .select()
        .from(scheduledReports)
        .where(and(...conditions))
        .limit(50)

    if (!cronAuthorized && schedules.length === 0) {
        return error("Schedule not found", 404)
    }

    const results = []

    for (const schedule of schedules) {
        try {
            // 1. Fetch Data based on report type
            // For this implementation, we fetch recent order data as a generic report
            const reportData = await fetchReportData(schedule.reportName, schedule.organizationId)

            // 2. Convert to CSV
            const csv = convertToCSV(reportData)

            // 3. Send Email
            const safeReportFileName =
                schedule.reportName.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "report"
            const fileName = `${safeReportFileName}_${new Date().toISOString().split('T')[0]}.csv`
            const sent = await sendReportEmail(
                schedule.emails,
                schedule.reportName,
                schedule.frequency,
                csv,
                fileName
            )

            if (sent && !isTest) {
                await db.update(scheduledReports)
                    .set({ lastExecutedAt: new Date(), updatedAt: new Date() })
                    .where(eq(scheduledReports.id, schedule.id))
            }

            results.push({ id: schedule.id, status: sent ? "sent" : "failed" })
        } catch (err) {
            console.error(`Error processing schedule ${schedule.id}:`, err)
            results.push({ id: schedule.id, status: "error" })
        }
    }

    return ok({ processed: results.length, details: results })
}

async function fetchReportData(reportName: string, organizationId: number | null) {
    // Basic implementation: fetch last 30 days of orders for the organization
    const conditions = []
    if (organizationId) conditions.push(eq(orders.organizationId, organizationId))

    const data = await db
        .select({
            id: orders.tid,
            date: orders.createdAt,
            status: orders.status,
            total: orders.totalCents,
            branch: branches.name,
        })
        .from(orders)
        .leftJoin(branches, eq(orders.branchId, branches.id))
        .where(and(...conditions))
        .limit(100)

    return data.map(row => ({
        ...row,
        date: row.date ? new Date(row.date).toLocaleDateString() : 'N/A',
        total: (row.total / 100).toFixed(2)
    }))
}

function convertToCSV(data: any[]) {
    if (data.length === 0) return "No data available"
    const headers = Object.keys(data[0])
    const rows = data.map((row) => Object.values(row))
    return createCsv(headers, rows)
}
