import { NextRequest } from "next/server"
import { eq, and } from "drizzle-orm"
import { requireApiRole, ok, error } from "@/lib/api"
import { db } from "@/lib/db"
import { scheduledReports } from "@/db/schema"
import { getRequestScope } from "@/lib/auth"
import {
    reportScheduleSchema,
    validationMessage,
} from "@/lib/server/mutation-validation"
import { withRateLimit } from "@/lib/rate-limiter"

const allowedRoles = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"] as const

export async function GET(req: NextRequest) {
    try {
        const err = await requireApiRole(allowedRoles as any)
        if (err) return err

        const scope = await getRequestScope()
        if (!scope?.userId) return error("Unauthorized", 401)

        const userSchedules = await db
            .select()
            .from(scheduledReports)
            .where(eq(scheduledReports.userId, scope.userId))
            .limit(100)

        return ok(userSchedules)
    } catch (e: any) {
        console.error("Schedule Fetch Error:", e)
        // If table doesn't exist, return empty array instead of 500ing
        if (e.message?.includes('relation "scheduled_reports" does not exist')) {
            return ok([])
        }
        return error(e.message || "Failed to fetch schedules", 500)
    }
}

export async function POST(req: NextRequest) {
    const err = await requireApiRole(allowedRoles as any)
    if (err) return err

    const scope = await getRequestScope()
    if (!scope?.userId) return error("Unauthorized", 401)

    const rateLimit = await withRateLimit("report", scope.userId)
    if (rateLimit) return rateLimit

    const rawBody = await req.json().catch(() => null)
    const parsedBody = reportScheduleSchema.safeParse(rawBody)
    if (!parsedBody.success) {
        return error(validationMessage(parsedBody.error), 400)
    }
    const { reportName, frequency, format, emails, enabled, id } = parsedBody.data

    try {
        if (id) {
            // Update
            const [updated] = await db
                .update(scheduledReports)
                .set({
                    frequency,
                    format,
                    emails,
                    enabled,
                    updatedAt: new Date(),
                })
                .where(and(eq(scheduledReports.id, Number(id)), eq(scheduledReports.userId, scope.userId)))
                .returning()

            return ok(updated)
        } else {
            // Create
            const [created] = await db
                .insert(scheduledReports)
                .values({
                    organizationId: scope.organizationId,
                    userId: scope.userId,
                    reportName,
                    frequency,
                    format,
                    emails,
                    enabled: true,
                })
                .returning()

            return ok(created)
        }
    } catch (e: any) {
        console.error("Schedule Save Error:", e)
        return error("Failed to save schedule")
    }
}

export async function DELETE(req: NextRequest) {
    const err = await requireApiRole(allowedRoles as any)
    if (err) return err

    const scope = await getRequestScope()
    if (!scope?.userId) return error("Unauthorized", 401)

    const rateLimit = await withRateLimit("report", scope.userId)
    if (rateLimit) return rateLimit

    const { searchParams } = new URL(req.url)
    const id = searchParams.get("id")

    if (!id) return error("Missing ID")

    await db
        .delete(scheduledReports)
        .where(and(eq(scheduledReports.id, Number(id)), eq(scheduledReports.userId, scope.userId)))

    return ok({ success: true })
}
