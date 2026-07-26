import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { organizationInventory, globalProducts } from "@/db/schema"
import { eq, and, isNull, sql } from "drizzle-orm"

// POST /api/v1/admin/cleanup-inventory - Run cleanup script
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

        console.log("🧹 Starting inventory cleanup...")

        // Clean up customName where it matches globalProducts.name
        const nameResult = await db
            .update(organizationInventory)
            .set({ customName: null, updatedAt: new Date() })
            .where(
                and(
                    isNull(organizationInventory.deletedAt),
                    sql`${organizationInventory.customName} = (
            SELECT name FROM global_products 
            WHERE id = ${organizationInventory.globalProductId}
          )`
                )
            )
            .returning({ id: organizationInventory.id })

        const nameCount = nameResult.length

        // Clean up customPrice where it matches globalProducts.basePrice
        const priceResult = await db
            .update(organizationInventory)
            .set({ customPrice: null, updatedAt: new Date() })
            .where(
                and(
                    isNull(organizationInventory.deletedAt),
                    sql`${organizationInventory.customPrice} = (
            SELECT base_price FROM global_products 
            WHERE id = ${organizationInventory.globalProductId}
          )`
                )
            )
            .returning({ id: organizationInventory.id })

        const priceCount = priceResult.length

        console.log(`✅ Cleanup complete: ${nameCount} names, ${priceCount} prices`)

        return NextResponse.json({
            success: true,
            message: "Inventory cleanup completed successfully",
            clearedNames: nameCount,
            clearedPrices: priceCount,
        })
    } catch (error: any) {
        console.error("❌ Cleanup error:", error)
        return NextResponse.json({ error: "Cleanup failed" }, { status: 500 })
    }
}
