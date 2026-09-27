import { NextRequest,NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { organizationInventory } from "@/db/schema"
import { and,isNull,sql } from "drizzle-orm"
import { auditActorFromSession, recordAuditEvent } from "@/lib/server/activity-audit"

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

        // Clean up customName where it matches globalProducts.name.
        //
        // A bulk write, so the rows it reached are named in the audit entry's
        // metadata rather than in `entity_id`, which holds one id and would
        // overflow. The record commits with the update or neither does.
        const nameResult = await db.transaction(async (tx) => {
            const cleared = await tx
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

            await recordAuditEvent(tx, {
                action: "CLEANUP_ORGANIZATION_INVENTORY_NAMES",
                entity: "organization_inventory",
                entityId: null,
                actor: auditActorFromSession(session),
                context: {
                    clearedNames: cleared.length,
                    clearedInventoryIds: cleared.map((row) => row.id),
                    reason: "customName equalled the global product name",
                },
            })

            return cleared
        })

        const nameCount = nameResult.length

        // Prices are deliberately NOT cleaned up here.
        //
        // This used to clear any organization price that happened to equal the
        // global base price, on the theory that such an override was a copy.
        // An organization's price is its own commercial decision, and two
        // tiers holding the same number is not evidence that one was copied
        // from the other — clearing it silently revoked a price somebody chose
        // and quietly re-subscribed that tenant to every future global change.
        //
        // Prices only ever flow downward, and never past a tier that has set
        // its own. Nothing here may delete an organization or group price.
        //
        // (The removed statement was also inoperative: it selected `base_price`
        // from global_products, where the column is `base_price_cents`, so it
        // raised an undefined-column error rather than clearing anything.)
        const priceCount = 0

        console.log(`✅ Cleanup complete: ${nameCount} names`)

        return NextResponse.json({
            success: true,
            message: "Inventory cleanup completed successfully",
            clearedNames: nameCount,
            // Retained so existing callers keep their response shape; always 0.
            clearedPrices: priceCount,
        })
    } catch (error: any) {
        console.error("❌ Cleanup error:", error)
        return NextResponse.json({ error: "Cleanup failed" }, { status: 500 })
    }
}
