#!/usr/bin/env tsx

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as dotenv from "dotenv"

dotenv.config({ path: ".env.local" })
dotenv.config()

const OUTPUT = resolve("updatedReports/ke-live-price-reconciled-19-orders-2026-08-03/target-mapping-audit.json")
const ORGANIZATION_ID = 10
const LEGACY_IDS = [118, 154, 158, 159, 161, 216, 217, 628, 704, 936, 997, 1029, 1032, 1083, 1099, 1102, 1112, 1131, 1156]

async function main() {
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    await client.query("begin transaction read only")
    const organization = await client.query(`
      select id, code, name, status
      from organizations
      where id = $1
    `, [ORGANIZATION_ID])
    const products = await client.query(`
      select gp.id as global_product_id, gp.product_code, gp.name, gp.status,
             gp.base_price_cents, oi.id as organization_inventory_id,
             oi.is_active as organization_inventory_active,
             oi.deleted_at as organization_inventory_deleted_at,
             coalesce(json_agg(json_build_object(
               'normalizedName', lpm.normalized_name,
               'sourceName', lpm.source_name
             )) filter (where lpm.id is not null), '[]'::json) as legacy_mappings
      from global_products gp
      left join organization_inventory oi
        on oi.global_product_id = gp.id and oi.organization_id = $1
      left join legacy_product_mappings lpm
        on lpm.global_product_id = gp.id
       and lpm.organization_id = $1
       and lpm.source_system = 'oneflowe-logistics'
      where gp.deleted_at is null
        and (
          lower(gp.name) like '%toshiba%'
          or (lower(gp.name) like '%nescafe%' and lower(gp.name) like '%gold%')
          or lower(gp.name) like '%spoon%'
        )
      group by gp.id, gp.product_code, gp.name, gp.status, gp.base_price_cents,
               oi.id, oi.is_active, oi.deleted_at
      order by gp.name, gp.id
    `, [ORGANIZATION_ID])
    const users = await client.query(`
      select u.id, u.full_name, u.first_name, u.last_name, u.username,
             u.is_active, u.deleted_at, r.name as role_name,
             b.id as branch_id, b.name as branch_name
      from users u
      join roles r on r.id = u.role_id
      left join branches b on b.id = u.branch_id
      where u.organization_id = $1
        and lower(coalesce(b.name, '')) = 'account payable'
      order by u.deleted_at nulls first, u.is_active desc, u.full_name, u.id
    `, [ORGANIZATION_ID])
    const userMappings = await client.query(`
      select lum.legacy_order_taker_id, lum.branch_id, b.name as branch_name,
             lum.source_name, lum.user_id, lum.is_synthetic,
             u.full_name, u.username, u.is_active, u.deleted_at,
             r.name as role_name
      from legacy_user_mappings lum
      join branches b on b.id = lum.branch_id
      join users u on u.id = lum.user_id
      join roles r on r.id = u.role_id
      where lum.organization_id = $1
        and lum.source_system = 'oneflowe-logistics'
        and lum.legacy_order_taker_id = 10
      order by lum.branch_id
    `, [ORGANIZATION_ID])
    const duplicates = await client.query(`
      select loi.legacy_order_id, loi.order_id, o.tid, o.organization_id
      from legacy_order_imports loi
      join orders o on o.id = loi.order_id
      where loi.organization_id = $1
        and loi.source_system = 'oneflowe-logistics'
        and loi.legacy_order_id = any($2::int[])
      order by loi.legacy_order_id
    `, [ORGANIZATION_ID, LEGACY_IDS])
    const tidCollisions = await client.query(`
      select id, organization_id, tid
      from orders
      where tid = any($1::text[])
      order by tid
    `, [LEGACY_IDS.map((id) => `KE-LEGACY-${id}`)])
    await client.query("rollback")

    const report = {
      generatedAt: new Date().toISOString(),
      mode: "PRODUCTION_READ_ONLY",
      organization: organization.rows[0] ?? null,
      candidateLegacyOrderIds: LEGACY_IDS,
      productCandidates: products.rows,
      accountPayableUsers: users.rows,
      legacyOrderTaker10Mappings: userMappings.rows,
      existingCandidateImports: duplicates.rows,
      candidateTidCollisions: tidCollisions.rows,
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
