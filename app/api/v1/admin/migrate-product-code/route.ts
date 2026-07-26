import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { sql } from "drizzle-orm"

// Temporary migration endpoint - DELETE THIS FILE AFTER RUNNING
export async function POST() {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user || (session.user as any).role !== "SUPER_ADMIN") {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        // Create partial unique index that only applies to non-deleted products
        await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS global_products_code_unique_active 
      ON global_products (product_code) 
      WHERE deleted_at IS NULL
    `)

        return NextResponse.json({ message: "Migration completed successfully - partial unique index created" })
    } catch (error: any) {
        console.error("Migration error:", error)
        return NextResponse.json({ error: "Migration failed" }, { status: 500 })
    }
}
