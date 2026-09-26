import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { sql } from "drizzle-orm"
import { auditActorFromSession, recordAuditEvent } from "@/lib/server/activity-audit"

// Temporary migration endpoint - DELETE THIS FILE AFTER RUNNING
export async function POST() {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user || (session.user as any).role !== "SUPER_ADMIN") {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        // A schema change over HTTP, which rule 06 says must reach production
        // through a migration in CI rather than a console session — and which
        // this file's own header says to delete once it has run. Until it is
        // deleted, it is at least recorded: `CREATE INDEX` is not transactional
        // in the way the row writes elsewhere are, so the audit entry is written
        // after the statement succeeds and its failure propagates.
        await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS global_products_code_unique_active
      ON global_products (product_code)
      WHERE deleted_at IS NULL
    `)

        await recordAuditEvent(db, {
            action: "MIGRATE_SCHEMA",
            entity: "global_products",
            entityId: "global_products_code_unique_active",
            actor: auditActorFromSession(session),
            context: {
                statement: "CREATE UNIQUE INDEX IF NOT EXISTS global_products_code_unique_active",
                target: "global_products (product_code) WHERE deleted_at IS NULL",
                appliedOverHttp: true,
            },
        })

        return NextResponse.json({ message: "Migration completed successfully - partial unique index created" })
    } catch (error: any) {
        console.error("Migration error:", error)
        return NextResponse.json({ error: "Migration failed" }, { status: 500 })
    }
}
