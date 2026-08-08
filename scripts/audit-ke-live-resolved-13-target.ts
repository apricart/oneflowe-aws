#!/usr/bin/env tsx

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as dotenv from "dotenv"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const OUTPUT = resolve("updatedReports/ke-live-resolved-13-orders-2026-08-03/target-audit.json")
const IDS = [145, 400, 406, 485, 672, 677, 712, 727, 771, 777, 989, 1018, 1117]

async function main() {
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    await client.query("begin transaction read only")
    const organization = await client.query("select id, code, name, status from organizations where id = 10")
    const products = await client.query(`
      select gp.id as global_product_id, gp.product_code, gp.name, gp.status,
             gp.base_price_cents, gp.deleted_at,
             oi.id as organization_inventory_id, oi.is_active as organization_inventory_active,
             oi.deleted_at as organization_inventory_deleted_at,
             coalesce(json_agg(json_build_object('normalizedName', lpm.normalized_name, 'sourceName', lpm.source_name))
               filter (where lpm.id is not null), '[]'::json) as legacy_mappings
      from global_products gp
      left join organization_inventory oi on oi.global_product_id = gp.id and oi.organization_id = 10
      left join legacy_product_mappings lpm on lpm.global_product_id = gp.id
        and lpm.organization_id = 10 and lpm.source_system = 'KE_LOGISTICS'
      where gp.deleted_at is null
        and (lower(gp.name) like '%tooth%' or lower(gp.name) like '%brush%' or lower(gp.name) like '%colgate%')
      group by gp.id, oi.id
      order by gp.name, gp.id
    `)
    const imports = await client.query(`
      select loi.legacy_order_id, loi.order_id, o.tid, o.organization_id
      from legacy_order_imports loi join orders o on o.id = loi.order_id
      where loi.organization_id = 10 and loi.source_system = 'KE_LOGISTICS'
        and loi.legacy_order_id = any($1::int[])
    `, [IDS])
    const tids = await client.query("select id, organization_id, tid from orders where tid = any($1::text[])", [IDS.map((id) => `KE-LEGACY-${id}`)])
    await client.query("rollback")
    const report = {
      generatedAt: new Date().toISOString(),
      mode: "PRODUCTION_READ_ONLY",
      organization: organization.rows[0] ?? null,
      productCandidates: products.rows,
      existingCandidateImports: imports.rows,
      tidCollisions: tids.rows,
      databaseChanges: 0,
    }
    writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8")
    console.log(JSON.stringify({ output: OUTPUT, ...report }, null, 2))
  } catch (error) {
    try { await client.query("rollback") } catch {}
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
