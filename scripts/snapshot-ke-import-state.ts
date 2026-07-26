import { createHash } from "crypto"
import { mkdirSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import * as dotenv from "dotenv"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORG_ID = 10

async function main() {
  const output = resolve(process.argv[2] || `backups/ke-import-state-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    await client.query("begin transaction isolation level repeatable read read only")
    const queries: Record<string, { text: string; params?: unknown[] }> = {
      database: { text: "select current_database() as database_name, current_user as database_user, current_setting('server_version') as server_version, now() as captured_at" },
      organization: { text: "select id, name, code, status, created_at, updated_at from organizations where id = $1", params: [ORG_ID] },
      branches: { text: "select id, organization_id, name, code, status, group_id, baseline_budget_cents, updated_at from branches where organization_id = $1 order by id", params: [ORG_ID] },
      users: { text: "select u.id, u.organization_id, u.branch_id, u.username, u.full_name, u.employee_id, u.role_id, r.name as role_name, u.is_active, u.deleted_at, u.created_at, u.updated_at from users u join roles r on r.id = u.role_id where u.organization_id = $1 order by u.id", params: [ORG_ID] },
      globalProducts: { text: "select id, product_code, name, category_id, base_price_cents, unit, status, stock_quantity, deleted_at, created_at, updated_at from global_products order by id" },
      organizationInventory: { text: "select * from organization_inventory where organization_id = $1 order by id", params: [ORG_ID] },
      branchInventory: { text: "select * from branch_inventory where organization_id = $1 order by id", params: [ORG_ID] },
      groups: { text: "select * from groups where organization_id = $1 order by id", params: [ORG_ID] },
      orders: { text: "select id, tid, organization_id, branch_id, status, fulfillment_status, payment_status, subtotal_cents, tax_cents, total_cents, created_by_user_id, created_at, fulfilled_at, updated_at from orders where organization_id = $1 order by id", params: [ORG_ID] },
      orderItems: { text: "select id, organization_id, organization_inventory_id, order_id, global_product_id, product_name, product_code, unit, quantity, price_cents, created_at from order_items where organization_id = $1 order by id", params: [ORG_ID] },
      legacyImportBatches: { text: "select * from legacy_import_batches where organization_id = $1 order by created_at, id", params: [ORG_ID] },
      legacyProductMappings: { text: "select * from legacy_product_mappings where organization_id = $1 order by id", params: [ORG_ID] },
      legacyUserMappings: { text: "select * from legacy_user_mappings where organization_id = $1 order by id", params: [ORG_ID] },
      legacyOrderImports: { text: "select * from legacy_order_imports where organization_id = $1 order by id", params: [ORG_ID] },
      budgets: { text: "select * from budgets where organization_id = $1 order by id", params: [ORG_ID] },
      quantityBudgets: { text: "select * from product_quantity_budgets where organization_id = $1 order by id", params: [ORG_ID] },
      invoiceSequence: { text: "select * from invoice_sequences where organization_id = $1", params: [ORG_ID] },
      crossTenantCounts: { text: "select organization_id, count(*)::int as orders, coalesce(sum(total_cents), 0)::text as total_cents from orders where organization_id is distinct from $1 group by organization_id order by organization_id nulls first", params: [ORG_ID] },
      migrations: { text: "select id, hash, created_at from drizzle.__drizzle_migrations order by id" },
    }
    const snapshot: Record<string, unknown> = {
      kind: "KE_IMPORT_PRE_MIGRATION_SAFETY_SNAPSHOT",
      organizationId: ORG_ID,
      generatedAt: new Date().toISOString(),
    }
    for (const [name, query] of Object.entries(queries)) {
      snapshot[name] = (await client.query(query.text, query.params)).rows
    }
    await client.query("commit")

    const json = `${JSON.stringify(snapshot, null, 2)}\n`
    const sha256 = createHash("sha256").update(json).digest("hex")
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, json, { encoding: "utf8", flag: "wx" })
    writeFileSync(`${output}.sha256`, `${sha256}  ${output}\n`, { encoding: "utf8", flag: "wx" })
    console.log(JSON.stringify({ output, sha256, bytes: Buffer.byteLength(json) }, null, 2))
  } catch (error) {
    await client.query("rollback").catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
