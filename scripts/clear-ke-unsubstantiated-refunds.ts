#!/usr/bin/env tsx
/**
 * Clear refund amounts this importer should never have written.
 *
 * WHY
 * ---
 * `import-ke-orders.ts` briefly recorded `refund_amount_cents` from the legacy
 * refund record's `RefundPrice`. That field reconstructs the *billed line*
 * reliably — `Price + RefundPrice` reconciles to the checkout subtotal on every
 * order examined — but it is not a trustworthy per-order refund figure:
 *
 *   - at Business Finance Capex the same product carries the same `RefundPrice`
 *     on four different orders, and summing it there exceeds the order's own
 *     total, which no real refund can;
 *   - at another branch it is genuinely per-order.
 *
 * The two cases are indistinguishable from the API, so the amount is not
 * substantiated and is removed. The order totals and line items are unaffected:
 * those come from the checkout and reconcile exactly.
 *
 * SCOPE — read this before running
 * --------------------------------
 * Touches exactly one organization, resolved by `--organization-code`, and
 * within it only orders that `import-ke-orders` itself created: each row must
 * be linked through `legacy_order_imports` to a batch whose manifest names that
 * importer. Refunds written by `import-ke-legacy-refunded-orders.ts` came from a
 * reconciled source and are deliberately left alone.
 *
 *   npx tsx scripts/clear-ke-unsubstantiated-refunds.ts --organization-code=0001
 *   npx tsx scripts/clear-ke-unsubstantiated-refunds.ts --organization-code=0001 \
 *     --commit --confirm-organization=10:0001:K-Electric --expected-orders=<n>
 */

import * as dotenv from "dotenv"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type Row = Record<string, any>

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const commit = process.argv.includes("--commit")
  const organizationCode = argument("organization-code") ?? "0001"
  const confirmOrganization = argument("confirm-organization")
  const expectedOrders = argument("expected-orders")

  const { pool } = await import("../lib/db-cli")
  try {
    const { rows: orgs } = await pool.query(
      `select id, code, name from organizations where code = $1`, [organizationCode])
    assert(orgs.length === 1, `No organization with code "${organizationCode}"`)
    const organization = orgs[0]
    const confirmation = `${organization.id}:${organization.code}:${organization.name}`
    console.log(`Organization: ${confirmation}`)

    // Only orders this importer created, in this organization. The join is the
    // scope guard: an order with no `legacy_order_imports` row, or one written
    // by a different importer, is never considered.
    const selection = `
      from orders o
      join legacy_order_imports li
        on li.order_id = o.id and li.organization_id = o.organization_id
      join legacy_import_batches b on b.id = li.batch_id
     where o.organization_id = $1
       and li.source_system = 'KE_LOGISTICS'
       and b.source_manifest->>'importer' = 'import-ke-orders'
       and coalesce(o.refund_amount_cents, 0) > 0`

    const { rows: affected } = await pool.query<Row>(
      `select o.id, o.tid, o.total_cents, o.refund_amount_cents ${selection} order by o.tid`,
      [organization.id])

    console.log(`\nOrders whose refund amount would be cleared: ${affected.length}`)
    for (const row of affected.slice(0, 30)) {
      console.log(`  ${String(row.tid).padEnd(20)} total=${row.total_cents} refund=${row.refund_amount_cents}`)
    }
    if (affected.length > 30) console.log(`  ... and ${affected.length - 30} more`)
    const totalCleared = affected.reduce((sum, row) => sum + Number(row.refund_amount_cents ?? 0), 0)
    console.log(`Total refund value being removed: ${totalCleared} cents`)

    // Proof the blast radius is one organization: nobody else is in the set.
    const { rows: elsewhere } = await pool.query<Row>(
      `select o.organization_id, count(*)::int n
         from orders o
        where coalesce(o.refund_amount_cents, 0) > 0 and o.organization_id <> $1
        group by 1 order by 1`, [organization.id])
    console.log(`\nOrders with a refund amount in OTHER organizations (left untouched): `
      + `${elsewhere.map((row) => `org ${row.organization_id}: ${row.n}`).join(", ") || "none"}`)

    if (!commit) {
      console.log("\nDry run: nothing was written. To apply:")
      console.log(`  npx tsx scripts/clear-ke-unsubstantiated-refunds.ts --organization-code=${organizationCode} \\`)
      console.log(`    --commit --confirm-organization=${confirmation} --expected-orders=${affected.length}`)
      return
    }

    assert(confirmOrganization === confirmation, `Commit requires --confirm-organization=${confirmation}`)
    assert(Number(expectedOrders) === affected.length,
      `Commit requires --expected-orders=${affected.length}`)

    const client = await (pool as any).connect()
    try {
      await client.query("begin")
      const { rowCount } = await client.query(
        `update orders o
            set refund_amount_cents = 0, refunded_at = null, status_at_refund = null,
                updated_at = now()
          where o.id in (select o2.id ${selection.replace(/\bo\./g, "o2.").replace("from orders o", "from orders o2")})`,
        [organization.id])
      assert(rowCount === affected.length,
        `Expected to clear ${affected.length} orders, updated ${rowCount}; rolled back`)
      await client.query("commit")
      console.log(`\nCleared ${rowCount} order(s) in ${organization.name} only.`)
    } catch (error) {
      await client.query("rollback").catch(() => {})
      throw error
    } finally {
      client.release()
    }
  } finally {
    const { closePool } = await import("../lib/db-cli")
    await closePool()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
