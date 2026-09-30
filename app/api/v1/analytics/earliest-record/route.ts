import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { orders } from "@/db/schema"
import { asc } from "drizzle-orm"
import { requireApiRole } from "@/lib/api"

// VIEWER reads this to learn which years its month filter may offer. It returns
// one timestamp and no tenant rows.
const allowedRoles = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "VIEWER"] as const

export async function GET() {
    const err = await requireApiRole(allowedRoles as any)
    if (err) return err

    try {
        const firstOrder = await db.select({
            createdAt: orders.createdAt
        })
        .from(orders)
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
