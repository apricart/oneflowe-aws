#!/usr/bin/env tsx

import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as dotenv from "dotenv"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const IDS = [250, 520, 765, 1164, 1165, 1177, 1187]
const OUTPUT = resolve("updatedReports/ke-current-missing-safe-candidates-2026-08-04/current-production-identity-and-ledger-check.json")

async function main() {
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    await client.query("begin transaction read only")
    const organization = await client.query("select id, code, name, status from organizations where id = 10")
    const ledger = await client.query("select count(*)::int as imported_orders from legacy_order_imports where organization_id = 10 and source_system = 'KE_LOGISTICS'")
    const candidates = await client.query(`
      select loi.legacy_order_id, loi.order_id, o.tid, o.status, o.fulfillment_status
      from legacy_order_imports loi
      join orders o on o.id = loi.order_id
      where loi.organization_id = 10
        and loi.source_system = 'KE_LOGISTICS'
        and loi.legacy_order_id = any($1::int[])
      order by loi.legacy_order_id
    `, [IDS])
    const tids = await client.query(`
      select id, organization_id, tid, status, fulfillment_status
      from orders
      where tid = any($1::text[])
      order by tid
    `, [IDS.map((id) => `KE-LEGACY-${id}`)])
    await client.query("rollback")
    const org = organization.rows[0] ?? null
    const tenantVerified = Boolean(org && org.id === 10 && org.code === "0001" && org.name === "K-Electric" && String(org.status).toLowerCase() === "active")
    const result = {
      generatedAt: new Date().toISOString(),
      mode: "PRODUCTION_READ_ONLY",
      organization: org,
      tenantVerified,
      totalImportedKELegacyOrders: Number(ledger.rows[0]?.imported_orders ?? 0),
      candidateLegacyOrderIds: IDS,
      existingCandidateImports: candidates.rows,
      candidateTidRows: tids.rows,
      databaseChanges: 0,
    }
    writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8")
    console.log(JSON.stringify({ output: OUTPUT, ...result }, null, 2))
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
