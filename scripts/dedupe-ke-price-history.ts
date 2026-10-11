#!/usr/bin/env tsx
/**
 * Remove K-Electric price-history rows that make the Product Price History
 * screen list the same price twice in a row (Distribution 195 on 11 Sept, then
 * Enabling 195 on 12 Sept). The decision is pure and unit-tested in
 * `lib/legacy-import/ke-price-history-dedupe.ts`; this script supplies rows,
 * gates the tenant, and performs the delete.
 *
 * `product_price_history` is display-only: no order, catalogue price, invoice
 * or budget reads it. Only order-derived rows (ORDER_BACKFILL,
 * MIGRATION_BASELINE) of organization 10 are ever deleted; live CATALOG_CHANGE
 * events are never touched.
 *
 * Default mode is a read-only preflight. Commit is digest-gated, saves every
 * row it will delete before writing, runs in one transaction under an advisory
 * lock, re-derives the plan from rows read under that lock, and writes an
 * `audit_logs` row. The committed report feeds `--rollback`, which re-inserts
 * the deleted rows with their original ids.
 *
 *   npx tsx scripts/dedupe-ke-price-history.ts
 *   npx tsx scripts/dedupe-ke-price-history.ts --commit \
 *     --confirm-organization=10:0001:K-Electric \
 *     --confirm-plan-sha256=<digest> --expected-removals=<n> --operator=you@example.com
 *   npx tsx scripts/dedupe-ke-price-history.ts --rollback=<committed report>.json \
 *     --confirm-organization=10:0001:K-Electric --confirm-rollback=<printed>
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import {
  planPriceHistoryDedupe,
  type PriceHistoryDedupePlan,
  type PriceHistoryRow,
  type PriceHistorySource,
} from "../lib/legacy-import/ke-price-history-dedupe"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORGANIZATION = { id: 10, code: "0001", namePrefix: "K-Electric" } as const
const ORGANIZATION_CONFIRMATION = "10:0001:K-Electric"
const ADVISORY_LOCK = 700021
const KIND = "KE_PRICE_HISTORY_DEDUPE"

type JsonRow = Record<string, any>

/** Every column, so a rollback restores the row exactly. */
interface StoredRow {
  id: number
  global_product_id: number
  organization_id: number
  group_id: number | null
  branch_id: number | null
  previous_price_cents: string | null
  price_cents: string
  scope: string
  change_type: string
  source: string
  changed_by_user_id: string | null
  changed_at: string
  source_key: string | null
}

interface CommitReport {
  kind: typeof KIND
  mode: "COMMITTED"
  organizationId: number
  planSha256: string
  auditLogId: number
  deletedRows: StoredRow[]
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  const inline = process.argv.find((v) => v.startsWith(prefix))
  return inline ? inline.slice(prefix.length) : undefined
}

const flag = (name: string) => process.argv.includes(`--${name}`)
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

const planDigest = (plan: PriceHistoryDedupePlan) =>
  sha256(JSON.stringify([...plan.removals].sort((a, b) => a.removedId - b.removedId)
    .map((r) => [r.globalProductId, r.removedId, r.priceCents])))

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
}

async function rows<T extends JsonRow = JsonRow>(
  client: PoolClient, text: string, params: unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

async function assertTenant(client: PoolClient): Promise<void> {
  const [org] = await rows(client, "select id, code, name from organizations where id = $1", [ORGANIZATION.id])
  assert(org && org.code === ORGANIZATION.code && String(org.name).startsWith(ORGANIZATION.namePrefix),
    `Organization ${ORGANIZATION.id} is not ${ORGANIZATION_CONFIRMATION}; refusing to run`)
}

async function readLedger(client: PoolClient, lock = false): Promise<{ stored: StoredRow[]; planRows: PriceHistoryRow[] }> {
  // FOR UPDATE cannot sit beside a window function, so the lock is its own statement.
  if (lock) {
    await client.query("select id from product_price_history where organization_id = $1 order by id for update",
      [ORGANIZATION.id])
  }
  const stored = await rows<StoredRow & { seq: string }>(client, `
    select id, global_product_id, organization_id, group_id, branch_id,
           previous_price_cents::text, price_cents::text, scope, change_type, source,
           changed_by_user_id::text, changed_at::text, source_key,
           row_number() over (partition by global_product_id order by changed_at, id)::text as seq
      from product_price_history
     where organization_id = $1
     order by id
  `, [ORGANIZATION.id])
  const planRows = stored.map((row): PriceHistoryRow => ({
    id: Number(row.id),
    globalProductId: Number(row.global_product_id),
    groupId: row.group_id === null ? null : Number(row.group_id),
    priceCents: Number(row.price_cents),
    previousPriceCents: row.previous_price_cents === null ? null : Number(row.previous_price_cents),
    source: row.source as PriceHistorySource,
    seq: Number(row.seq),
  }))
  return { stored, planRows }
}

async function main(): Promise<void> {
  const { closePool, pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    console.log(`database host: ${new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname}`)
    const rollbackPath = arg("rollback")
    if (rollbackPath) { await rollback(client, resolve(process.cwd(), rollbackPath)); return }

    await assertTenant(client)
    const output = resolve(process.cwd(),
      arg("output") ?? `updatedReports/ke-price-history-dedupe-${new Date().toISOString().slice(0, 10)}.json`)

    const { stored, planRows } = await readLedger(client)
    const plan = planPriceHistoryDedupe(planRows)
    const digest = planDigest(plan)
    const byId = new Map(stored.map((row) => [Number(row.id), row]))
    const products = new Set(plan.removals.map((r) => r.globalProductId))
    const nonDerived = plan.removals.filter((r) => byId.get(r.removedId)?.source === "CATALOG_CHANGE")
    assert(nonDerived.length === 0, "Planner chose a CATALOG_CHANGE row; refusing")

    const summary = {
      ledgerRows: stored.length,
      removals: plan.removals.length,
      productsAffected: products.size,
      unresolvedProducts: plan.unresolvedProductIds.length,
    }

    if (!flag("commit")) {
      saveJson(output, {
        kind: KIND, mode: "DRY_RUN", generatedAt: new Date().toISOString(),
        organizationId: ORGANIZATION.id, planSha256: digest, summary,
        removals: plan.removals.map((r) => ({ ...r, row: byId.get(r.removedId) })),
        unresolvedProductIds: plan.unresolvedProductIds,
      })
      console.log(JSON.stringify({ mode: "DRY_RUN", output, planSha256: digest, summary }, null, 2))
      if (plan.removals.length > 0) {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npx tsx scripts/dedupe-ke-price-history.ts --commit \\
    --confirm-organization=${ORGANIZATION_CONFIRMATION} \\
    --confirm-plan-sha256=${digest} \\
    --expected-removals=${plan.removals.length} \\
    --operator=<you@example.com>`)
      }
      return
    }

    const operator = arg("operator")
    assert(operator, "Commit requires --operator=<who is running this>")
    assert(arg("confirm-organization") === ORGANIZATION_CONFIRMATION,
      `Commit requires --confirm-organization=${ORGANIZATION_CONFIRMATION}`)
    assert(arg("confirm-plan-sha256") === digest, `Commit requires --confirm-plan-sha256=${digest}`)
    assert(arg("expected-removals") === String(plan.removals.length),
      `Commit requires --expected-removals=${plan.removals.length}`)
    assert(plan.removals.length > 0, "Nothing to remove")

    // Saved before any write: this file alone is enough to restore the rows.
    const deletedRows = plan.removals.map((r) => byId.get(r.removedId)).filter((r): r is StoredRow => r !== undefined)
    const prechangePath = output.replace(/\.json$/, "") + "-prechange.json"
    saveJson(prechangePath, { kind: KIND, organizationId: ORGANIZATION.id, planSha256: digest, deletedRows })

    let auditLogId = 0
    await client.query("begin")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
      const locked = await readLedger(client, true)
      assert(planDigest(planPriceHistoryDedupe(locked.planRows)) === digest,
        "K-Electric price history changed after the preflight; aborting")

      const ids = deletedRows.map((row) => Number(row.id))
      const deleted = await rows(client, `
        delete from product_price_history
         where organization_id = $1
           and source in ('ORDER_BACKFILL', 'MIGRATION_BASELINE')
           and id = any($2::int[])
        returning id
      `, [ORGANIZATION.id, ids])
      assert(deleted.length === ids.length, `Expected to delete ${ids.length} rows, deleted ${deleted.length}`)

      const audit = await rows(client, `
        insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
        values (null, $1, null, $2, 'product_price_history', $3, $4::jsonb)
        returning id
      `, [ORGANIZATION.id, KIND, digest.slice(0, 128), JSON.stringify({
        planSha256: digest, operator, prechangePath,
        prechangeSha256: sha256(readFileSync(prechangePath, "utf8")), summary, deletedIds: ids,
      })])
      auditLogId = Number(audit[0]?.id)
      assert(Number.isSafeInteger(auditLogId), "Failed to write the audit row")
      await client.query("commit")
    } catch (error) {
      await client.query("rollback")
      throw error
    }

    const rollbackConfirmation = `ROLLBACK:${auditLogId}:${KIND}`
    const report: CommitReport & JsonRow = {
      kind: KIND, mode: "COMMITTED", committedAt: new Date().toISOString(), operator,
      organizationId: ORGANIZATION.id, planSha256: digest, auditLogId, summary,
      removals: plan.removals, deletedRows, rollbackConfirmation,
    }
    saveJson(output, report)
    console.log(JSON.stringify({ mode: "COMMITTED", output, auditLogId, summary, rollbackConfirmation }, null, 2))
  } finally {
    client.release()
    await closePool()
  }
}

async function rollback(client: PoolClient, reportPath: string): Promise<void> {
  assert(existsSync(reportPath), `Commit report not found: ${reportPath}`)
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as CommitReport
  assert(report.kind === KIND && report.mode === "COMMITTED", "Not a committed price-history dedupe report")
  assert(report.organizationId === ORGANIZATION.id, "Commit report tenant mismatch")
  assert(arg("confirm-organization") === ORGANIZATION_CONFIRMATION,
    `--confirm-organization must equal ${ORGANIZATION_CONFIRMATION}`)
  const expected = `ROLLBACK:${report.auditLogId}:${KIND}`
  assert(arg("confirm-rollback") === expected, `--confirm-rollback must equal ${expected}`)
  await assertTenant(client)

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    for (const row of report.deletedRows) {
      assert(Number(row.organization_id) === ORGANIZATION.id, `Row ${row.id} is not K-Electric's`)
      const inserted = await rows(client, `
        insert into product_price_history (
          id, global_product_id, organization_id, group_id, branch_id, previous_price_cents,
          price_cents, scope, change_type, source, changed_by_user_id, changed_at, source_key
        ) values ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8, $9, $10, $11::uuid, $12::timestamptz, $13)
        on conflict do nothing
        returning id
      `, [row.id, row.global_product_id, row.organization_id, row.group_id, row.branch_id,
        row.previous_price_cents, row.price_cents, row.scope, row.change_type, row.source,
        row.changed_by_user_id, row.changed_at, row.source_key])
      assert(inserted.length === 1, `Row ${row.id} could not be restored (id or source key already taken)`)
    }
    await client.query(`
      insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
      values (null, $1, null, $2, 'product_price_history', $3, $4::jsonb)
    `, [ORGANIZATION.id, `${KIND}_ROLLBACK`, String(report.auditLogId), JSON.stringify({
      restoredRows: report.deletedRows.length, planSha256: report.planSha256,
    })])
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }
  console.log(JSON.stringify({ mode: "ROLLED_BACK", restoredRows: report.deletedRows.length }, null, 2))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
