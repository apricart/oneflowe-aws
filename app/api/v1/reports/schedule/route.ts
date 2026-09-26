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
import { recordAuditEvent } from "@/lib/server/activity-audit"

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
            // The scope predicate on the pre-read is the ownership check: a
            // schedule belonging to someone else is simply not found.
            const [existing] = await db
                .select()
                .from(scheduledReports)
                .where(and(eq(scheduledReports.id, Number(id)), eq(scheduledReports.userId, scope.userId)))
                .limit(1)
            if (!existing) return error("Schedule not found", 404)

            const updated = await db.transaction(async (tx) => {
                const [saved] = await tx
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

                await recordAuditEvent(tx, {
                    action: "UPDATE_REPORT_SCHEDULE",
                    entity: "scheduled_report",
                    entityId: saved.id,
                    actor: { id: scope.userId, role: scope.role },
                    organizationId: saved.organizationId,
                    // The recipient list is the part worth a trail: it is where a
                    // tenant's figures leave the application.
                    before: {
                        frequency: existing.frequency,
                        format: existing.format,
                        emails: existing.emails,
                        enabled: existing.enabled,
                    },
                    after: {
                        frequency: saved.frequency,
                        format: saved.format,
                        emails: saved.emails,
                        enabled: saved.enabled,
                    },
                    context: { reportName: saved.reportName },
                })

                return saved
            })

            return ok(updated)
        } else {
            const created = await db.transaction(async (tx) => {
                const [inserted] = await tx
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

                await recordAuditEvent(tx, {
                    action: "CREATE_REPORT_SCHEDULE",
                    entity: "scheduled_report",
                    entityId: inserted.id,
                    actor: { id: scope.userId, role: scope.role },
                    organizationId: inserted.organizationId,
                    after: {
                        reportName: inserted.reportName,
                        frequency: inserted.frequency,
                        format: inserted.format,
                        emails: inserted.emails,
                    },
                })

                return inserted
            })

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

    // Read it first so the audit entry can carry what was removed. A schedule
    // that is already gone — or was never the caller's — still answers
    // `success`, keeping the delete idempotent, and records nothing.
    const [existing] = await db
        .select()
        .from(scheduledReports)
        .where(and(eq(scheduledReports.id, Number(id)), eq(scheduledReports.userId, scope.userId)))
        .limit(1)
    if (!existing) return ok({ success: true })

    await db.transaction(async (tx) => {
        await tx
            .delete(scheduledReports)
            .where(and(eq(scheduledReports.id, Number(id)), eq(scheduledReports.userId, scope.userId)))

        await recordAuditEvent(tx, {
            action: "DELETE_REPORT_SCHEDULE",
            entity: "scheduled_report",
            entityId: existing.id,
            actor: { id: scope.userId, role: scope.role },
            organizationId: existing.organizationId,
            before: {
                reportName: existing.reportName,
                frequency: existing.frequency,
                format: existing.format,
                emails: existing.emails,
                enabled: existing.enabled,
            },
        })
    })

    return ok({ success: true })
}
