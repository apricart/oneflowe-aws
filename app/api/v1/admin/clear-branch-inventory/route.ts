import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { branchInventory, auditLogs } from "@/db/schema"
import { sql, isNull } from "drizzle-orm"

// POST /api/v1/admin/clear-branch-inventory - Clear all legacy branch inventory data
export async function POST(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const userRole = (session.user as any).role
        if (userRole !== "SUPER_ADMIN") {
            return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
        }

        // Count existing records first
        const countResult = await db.select({ count: sql<number>`cast(count(*) as integer)` })
            .from(branchInventory)
            .where(isNull(branchInventory.deletedAt))

        const existingCount = countResult[0].count

        if (existingCount === 0) {
            return NextResponse.json({
                message: "No records to clear",
                clearedCount: 0
            })
        }

        // Soft-delete all records by setting deletedAt
        const result = await db.update(branchInventory)
            .set({ deletedAt: new Date() })
            .where(isNull(branchInventory.deletedAt))
            .returning({ id: branchInventory.id })

        // Log the action
        await db.insert(auditLogs).values({
            userId: (session.user as any).id,
            action: "BULK_DELETE",
            entity: "BranchInventory",
            entityId: "ALL",
            metadata: {
                clearedCount: result.length,
                reason: "Clear legacy data for new branch assignment flow"
            },
        })

        return NextResponse.json({
            message: `Successfully cleared ${result.length} branch inventory records`,
            clearedCount: result.length
        })
    } catch (error: any) {
        console.error("Error clearing branch inventory:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

// GET /api/v1/admin/clear-branch-inventory - Check status of branch inventory data
export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const userRole = (session.user as any).role
        if (userRole !== "SUPER_ADMIN") {
            return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
        }

        // Count active (not deleted) records
        const activeResult = await db.select({ count: sql<number>`cast(count(*) as integer)` })
            .from(branchInventory)
            .where(isNull(branchInventory.deletedAt))

        // Count deleted records
        const deletedResult = await db.select({ count: sql<number>`cast(count(*) as integer)` })
            .from(branchInventory)
            .where(sql`${branchInventory.deletedAt} IS NOT NULL`)

        // Get sample of active records
        const samples = await db.select({
            id: branchInventory.id,
            branchId: branchInventory.branchId,
            organizationId: branchInventory.organizationId,
            isVisible: branchInventory.isVisible,
            isActive: branchInventory.isActive,
            deletedAt: branchInventory.deletedAt
        })
            .from(branchInventory)
            .where(isNull(branchInventory.deletedAt))
            .limit(5)

        return NextResponse.json({
            activeCount: activeResult[0].count,
            deletedCount: deletedResult[0].count,
            samples: samples
        })
    } catch (error: any) {
        console.error("Error checking branch inventory:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
