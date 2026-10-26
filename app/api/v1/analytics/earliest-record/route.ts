import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { orders } from "@/db/schema"
import { asc, inArray } from "drizzle-orm"
import { requireApiRole } from "@/lib/api"
import { APRICART_SUPPORT_ROLE } from "@/lib/apricart-support-access"
import { FINANCE_ROLE } from "@/lib/finance-access"
import { getCurrentUser } from "@/lib/auth"
import { resolveFinanceReadScope } from "@/lib/server/finance-scope"

// VIEWER reads this to learn which years its month filter may offer. It returns
// one timestamp and no tenant rows. Finance's is the earliest order in the
// organizations assigned to it.
const allowedRoles = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "VIEWER", APRICART_SUPPORT_ROLE, FINANCE_ROLE] as const

export async function GET() {
    const err = await requireApiRole(allowedRoles as any)
    if (err) return err

    try {
        const user = await getCurrentUser()
        const financeScope = await resolveFinanceReadScope({ role: user?.role, userId: user?.id })
        if (financeScope && !financeScope.ok) return NextResponse.json({ error: financeScope.error }, { status: financeScope.status })

        const firstOrder = await db.select({
            createdAt: orders.createdAt
        })
        .from(orders)
        .where(financeScope ? inArray(orders.organizationId, financeScope.organizationIds) : undefined)
        .orderBy(asc(orders.createdAt))
        .limit(1)

        if (firstOrder.length === 0) {
            return NextResponse.json({ earliestDate: new Date().toISOString() })
        }

        return NextResponse.json({ earliestDate: firstOrder[0].createdAt })
    } catch (e) {
        console.error("[EarliestRecord] Error:", e)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
