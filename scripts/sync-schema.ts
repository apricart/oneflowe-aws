import { Client } from "pg"
import { loadMigrationEnv } from "../lib/server/migration-env"

const migrationEnv = loadMigrationEnv()

async function syncSchema() {
  try {
    console.log("🔄 Syncing schema with database...")

    const client = new Client({
      connectionString: migrationEnv.MIGRATION_DATABASE_URL,
    })

    await client.connect()

    // Add missing columns to budgets table
    console.log("📝 Updating budgets table...")
    await client.query(`
      ALTER TABLE "budgets"
      ADD COLUMN IF NOT EXISTS "organization_id" integer,
      ADD COLUMN IF NOT EXISTS "amount_held_cents" integer DEFAULT 0 NOT NULL,
      ADD COLUMN IF NOT EXISTS "amount_credited_cents" integer DEFAULT 0 NOT NULL
    `).catch((e) => console.log("ℹ️ Budgets columns:", e.message))

    // Add FK for organization_id
    await client.query(`
      ALTER TABLE "budgets"
      ADD CONSTRAINT "budgets_organization_id_organizations_id_fk" 
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    `).catch((e) => console.log("ℹ️ Budgets org FK:", e.message))

    // Create indexes for budgets
    await client.query(`
      CREATE INDEX IF NOT EXISTS "budgets_org_idx" ON "budgets" USING btree ("organization_id")
    `).catch((e) => console.log("ℹ️ Budgets org index:", e.message))

    await client.query(`
      CREATE INDEX IF NOT EXISTS "budgets_branch_idx" ON "budgets" USING btree ("branch_id")
    `).catch((e) => console.log("ℹ️ Budgets branch index:", e.message))

    // Add missing columns to orders table
    console.log("📝 Updating orders table...")
    await client.query(`
      ALTER TABLE "orders"
      ADD COLUMN IF NOT EXISTS "tid" varchar(26) NOT NULL DEFAULT gen_random_uuid()::text,
      ADD COLUMN IF NOT EXISTS "subtotal_cents" integer DEFAULT 0 NOT NULL,
      ADD COLUMN IF NOT EXISTS "tax_cents" integer DEFAULT 0 NOT NULL,
      ADD COLUMN IF NOT EXISTS "notes" text,
      ADD COLUMN IF NOT EXISTS "fulfillment_status" varchar(32) NOT NULL DEFAULT 'NOT_STARTED',
      ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone
    `).catch((e) => console.log("ℹ️ Orders columns:", e.message))

    await client.query(`
      WITH "delivered_order_dates" AS (
        SELECT
          "order_row"."id",
          COALESCE(
            MIN("audit"."created_at") FILTER (
              WHERE UPPER(COALESCE("audit"."metadata" ->> 'to', '')) = 'DELIVERED'
            ),
            "order_row"."fulfilled_at",
            "order_row"."updated_at"
          ) AS "delivered_at"
        FROM "orders" AS "order_row"
        LEFT JOIN "audit_logs" AS "audit"
          ON "audit"."entity" = 'Order'
          AND "audit"."entity_id" = "order_row"."id"::text
          AND "audit"."action" = 'ORDER_FULFILLMENT_STATUS_UPDATE'
        WHERE UPPER(COALESCE("order_row"."fulfillment_status", 'NOT_STARTED')) = 'DELIVERED'
          AND "order_row"."delivered_at" IS NULL
        GROUP BY "order_row"."id", "order_row"."fulfilled_at", "order_row"."updated_at"
      )
      UPDATE "orders" AS "order_row"
      SET "delivered_at" = "delivery"."delivered_at"
      FROM "delivered_order_dates" AS "delivery"
      WHERE "order_row"."id" = "delivery"."id"
        AND "order_row"."delivered_at" IS NULL
    `).catch((e) => console.log("ℹ️ Orders delivery date backfill:", e.message))

    // Add unique constraint on tid if not exists
    await client.query(`
      ALTER TABLE "orders"
      ADD CONSTRAINT "orders_tid_unique" UNIQUE("tid")
    `).catch((e) => console.log("ℹ️ Orders tid unique constraint:", e.message))

    // Update orderItems table
    console.log("📝 Updating order_items table...")
    
    // Add new columns
    await client.query(`
      ALTER TABLE "order_items"
      ADD COLUMN IF NOT EXISTS "global_product_id" integer,
      ADD COLUMN IF NOT EXISTS "product_name" varchar(255),
      ADD COLUMN IF NOT EXISTS "product_code" varchar(128),
      ADD COLUMN IF NOT EXISTS "unit" varchar(64),
      ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now()
    `).catch((e) => console.log("ℹ️ Order items columns:", e.message))

    // Drop old sku_id constraint if exists
    await client.query(`
      ALTER TABLE "order_items"
      DROP CONSTRAINT IF EXISTS "order_items_sku_id_skus_id_fk"
    `).catch((e) => console.log("ℹ️ Old FK:", e.message))

    // Add foreign key for global_product_id
    await client.query(`
      ALTER TABLE "order_items"
      ADD CONSTRAINT "order_items_global_product_id_global_products_id_fk" 
      FOREIGN KEY ("global_product_id") REFERENCES "global_products"("id")
    `).catch((e) => console.log("ℹ️ New FK:", e.message))

    // Drop sku_id column from order_items if it exists (not in schema)
    console.log("📝 Removing sku_id column from order_items...")
    await client.query(`
      ALTER TABLE "order_items"
      DROP COLUMN IF EXISTS "sku_id"
    `).catch((e) => console.log("ℹ️ Drop sku_id:", e.message))

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS "orders_tid_idx" ON "orders" USING btree ("tid")
    `).catch((e) => console.log("ℹ️ Orders TID index:", e.message))

    await client.query(`
      CREATE INDEX IF NOT EXISTS "orders_fulfillment_status_idx" ON "orders" USING btree ("fulfillment_status")
    `).catch((e) => console.log("ℹ️ Orders fulfillment status index:", e.message))

    await client.query(`
      CREATE INDEX IF NOT EXISTS "order_items_product_idx" ON "order_items" USING btree ("global_product_id")
    `).catch((e) => console.log("ℹ️ Order items product index:", e.message))

    // Create scheduled_reports table
    console.log("📝 Creating scheduled_reports table...")
    await client.query(`
      CREATE TABLE IF NOT EXISTS "scheduled_reports" (
        "id" SERIAL PRIMARY KEY,
        "organization_id" INTEGER REFERENCES "organizations"("id"),
        "user_id" UUID NOT NULL REFERENCES "users"("id"),
        "report_name" VARCHAR(255) NOT NULL,
        "frequency" VARCHAR(32) NOT NULL,
        "format" VARCHAR(16) NOT NULL,
        "emails" JSONB NOT NULL DEFAULT '[]',
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "last_executed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now()
      )
    `).catch((e) => console.log("ℹ️ Scheduled reports table:", e.message))

    // Create indexes for scheduled_reports
    await client.query(`
      CREATE INDEX IF NOT EXISTS "scheduled_reports_user_idx" ON "scheduled_reports" USING btree ("user_id")
    `).catch((e) => console.log("ℹ️ Scheduled reports user index:", e.message))

    await client.query(`
      CREATE INDEX IF NOT EXISTS "scheduled_reports_org_idx" ON "scheduled_reports" USING btree ("organization_id")
    `).catch((e) => console.log("ℹ️ Scheduled reports org index:", e.message))

    await client.end()

    console.log("✅ Schema synced successfully!")
    process.exit(0)
  } catch (error) {
    console.error("❌ Error syncing schema:", error)
    process.exit(1)
  }
}

syncSchema()
