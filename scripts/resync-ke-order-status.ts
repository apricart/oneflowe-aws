#!/usr/bin/env tsx
/**
 * Re-state already-imported K-Electric orders from the legacy platform's
 * current delivery status.
 *
 * `import-ke-orders.ts` never revisits an order it has written, so an order
 * imported mid-flight keeps the status it had that day. This brings those
 * orders forward. The decision of *what* to restate is pure and unit-tested in
 * `lib/legacy-import/ke-status-resync.ts`; this script supplies rows, gates the
 * tenant, and performs the write.
 *
 * Default mode is a read-only preflight. Commit is digest-gated, runs in one
 * transaction under an advisory lock, re-derives the plan from rows read under
 * that lock, and writes an `audit_logs` row. A committed report feeds
 * `--rollback`.
 *
 *   npx tsx scripts/resync-ke-order-status.ts
 *   npx tsx scripts/resync-ke-order-status.ts --commit \
 *     --confirm-organization=10:0001:K-Electric \
 *     --confirm-plan-sha256=<digest> --expected-changes=<n> --operator=you@example.com
 *   npx tsx scripts/resync-ke-order-status.ts --rollback=<committed report>.json \
 *     --confirm-organization=10:0001:K-Electric --confirm-rollback=<printed>
 *
 * What it will not do:
 *   - touch any organization but 10. Every statement carries that predicate.
 *   - change total_cents, order_items, stock, budgets, invoice sequences, or
 *     send any email. This is a ledger correction, not a lifecycle event.
 *   - restate an order that is REFUNDED here, or walk one backwards. Those are
 *     reported for a human (see the module docs for why).
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import {
  KE_LOGISTICS_BASE_URL,
  KE_ORDERS_LIST_PATH,
  monthWindows,
} from "../lib/legacy-import/ke-orders-api"
import {
  planStatusResync,
  summarizeStatusResync,
  type CurrentOrder,
  type LegacyStatusRow,
  type StatusResyncPlan,
} from "../lib/legacy-import/ke-status-resync"
import { invalidateCachePrefixes } from "../lib/cache-cli"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
const ORGANIZATION_CONFIRMATION = "10:0001:K-Electric"
const ADVISORY_LOCK = 700011
const HISTORY_START = "2025-01-01"
const FETCH_ATTEMPTS = 4

type JsonRow = Record<string, any>

interface CommitReport {
  kind: "KE_ORDER_STATUS_RESYNC"
  mode: "COMMITTED"
  organization: typeof ORGANIZATION
  planSha256: string
  auditLogId: number
  changes: StatusResyncPlan["changes"]
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function arg(name: string): string | undefined {
  const flag = `--${name}=`
  const inline = process.argv.find((v) => v.startsWith(flag))
  return inline ? inline.slice(flag.length) : undefined
}

const flag = (name: string) => process.argv.includes(`--${name}`)
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

/** Stable across key order so the digest means "the plan", not "the object". */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonRow).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as JsonRow)[k])}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

const planDigest = (plan: StatusResyncPlan) => sha256(canonical(plan.changes))

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
}

async function rows<T extends JsonRow = JsonRow>(
  client: PoolClient, text: string, params: unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { Accept: "application/json", ...(init?.headers ?? {}) },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as T
    } catch (error) {
      lastError = error
      if (attempt < FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, 2_000 * attempt))
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * One calendar month at a time — a single request for the whole history
 * returns about a megabyte and the legacy platform answers by dropping the
 * connection. Same rule as `import-ke-orders.ts`.
 */
async function fetchLegacyStatuses(): Promise<LegacyStatusRow[]> {
  const url = `${KE_LOGISTICS_BASE_URL}${KE_ORDERS_LIST_PATH}`
  const byId = new Map<number, LegacyStatusRow>()
  const end = new Date().toISOString().slice(0, 10)
  for (const window of monthWindows(HISTORY_START, end)) {
    const batch = await fetchJson<JsonRow[]>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        UserID: 1, StartDate: window.start, EndDate: window.end,
        LocationIDs: null, LocationGroupIDs: null, IsMulti: true,
      }),
    })
    assert(Array.isArray(batch), `Legacy list endpoint did not return an array for ${window.start}..${window.end}`)
    for (const row of batch) {
      byId.set(Number(row.ID), {
        legacyOrderId: Number(row.ID),
        legacyStatusId: Number(row.StatusID),
        deliveryStatus: Number(row.DeliveryStatus),
      })
    }
  }
  return [...byId.values()]
}

async function readCurrentOrders(client: PoolClient): Promise<CurrentOrder[]> {
  return (await rows(client, `
    select o.id, l.legacy_order_id, o.status, o.fulfillment_status, o.refund_amount_cents
      from legacy_order_imports l
      join orders o on o.id = l.order_id
     where l.organization_id = $1 and o.organization_id = $1
     order by l.legacy_order_id
  `, [ORGANIZATION.id])).map((row): CurrentOrder => ({
    orderId: Number(row.id),
    legacyOrderId: Number(row.legacy_order_id),
    status: String(row.status),
    fulfillmentStatus: row.fulfillment_status == null ? null : String(row.fulfillment_status),
    refundAmountCents: row.refund_amount_cents == null ? null : Number(row.refund_amount_cents),
  }))
}

/**
 * State that must be identical before and after. Other tenants appear here
 * because "K-Electric only" is a claim this script has to be able to prove.
 */
async function fingerprints(client: PoolClient): Promise<JsonRow> {
  const [value] = await rows(client, `
    select
      (select count(*)::int from orders where organization_id = $1) as ke_orders,
      (select coalesce(sum(total_cents), 0)::text from orders where organization_id = $1) as ke_order_total,
      (select coalesce(sum(coalesce(refund_amount_cents, 0)), 0)::text
         from orders where organization_id = $1) as ke_refund_total,
      (select count(*)::int from order_items oi join orders o on o.id = oi.order_id
        where o.organization_id = $1) as ke_order_items,
      (select coalesce(sum(amount_spent_cents + amount_held_cents), 0)::text
         from budgets where organization_id = $1) as ke_budget_consumption,
      (select count(*)::int from orders where organization_id <> $1) as other_tenant_orders,
      (select coalesce(sum(total_cents), 0)::text from orders where organization_id <> $1) as other_tenant_order_total,
      (select coalesce(string_agg(status || ':' || count::text, ',' order by status), '') from (
         select status, count(*)::int as count from orders where organization_id <> $1 group by status
       ) s) as other_tenant_status_mix
  `, [ORGANIZATION.id])
  return value
}

/**
 * Prove the write path exists before the dry run claims the commit will work.
 * A preflight runs no UPDATE, so a wrong column name survives it and fails only
 * at commit time.
 */
async function assertWritableColumns(client: PoolClient): Promise<void> {
  const required = ["id", "organization_id", "status", "fulfillment_status", "updated_at"] as const
  const present = new Set((await rows(client, `
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'orders'
  `)).map((row) => String(row.column_name)))
  const missing = required.filter((column) => !present.has(column))
  assert(missing.length === 0,
    `orders is missing column(s) this script writes or filters on: ${missing.join(", ")}`)
}

async function assertTenant(client: PoolClient): Promise<void> {
  const [org] = await rows(client,
    "select id, code, name from organizations where id = $1", [ORGANIZATION.id])
  assert(org && org.code === ORGANIZATION.code && org.name === ORGANIZATION.name,
    `Organization ${ORGANIZATION.id} is not ${ORGANIZATION_CONFIRMATION}; refusing to run`)
}

function buildReport(plan: StatusResyncPlan, digest: string) {
  return {
    kind: "KE_ORDER_STATUS_RESYNC" as const,
    mode: "DRY_RUN" as const,
    generatedAt: new Date().toISOString(),
    organization: ORGANIZATION,
    policy: {
      source: "legacy DeliveryStatus, mapped by mapDeliveryStatus() in ke-orders-api.ts",
      neverRestated: [
        "an order that is REFUNDED in OneFlowe (legacy has no refund we trust)",
        "a transition that moves the order earlier in its lifecycle",
        "an order whose legacy row is cancelled, draft or a test order",
      ],
      untouched: ["total_cents", "order_items", "stock", "budgets", "invoice sequences", "email"],
    },
    summary: summarizeStatusResync(plan),
    planSha256: digest,
    requiredCommitArguments: {
      confirmOrganization: ORGANIZATION_CONFIRMATION,
      confirmPlanSha256: digest,
      expectedChanges: plan.changes.length,
    },
    changes: plan.changes,
    holds: plan.holds,
    missingFromLegacy: plan.missingFromLegacy,
  }
}

async function main(): Promise<void> {
  const { closePool, pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    const rollbackPath = arg("rollback")
    if (rollbackPath) { await rollback(client, resolve(process.cwd(), rollbackPath)); return }

    await assertTenant(client)
    await assertWritableColumns(client)
    const output = resolve(process.cwd(),
      arg("output") ?? `deliverables/ke-status-resync-${new Date().toISOString().slice(0, 10)}.json`)

    const legacy = await fetchLegacyStatuses()
    const current = await readCurrentOrders(client)
    const plan = planStatusResync(current, legacy)
    const digest = planDigest(plan)
    const report = buildReport(plan, digest)

    if (!flag("commit")) {
      saveJson(output, report)
      console.log(JSON.stringify({
        mode: "DRY_RUN", output, planSha256: digest, summary: report.summary,
      }, null, 2))
      if (plan.changes.length === 0) {
        console.log("\nNothing to restate: every imported order already agrees with legacy.")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npx tsx scripts/resync-ke-order-status.ts --commit \\
    --confirm-organization=${ORGANIZATION_CONFIRMATION} \\
    --confirm-plan-sha256=${digest} \\
    --expected-changes=${plan.changes.length} \\
    --operator=<you@example.com>`)
      }
      if (plan.holds.length > 0) {
        console.log(`\n${plan.holds.length} order(s) held for review — see "holds" in ${output}.`)
      }
      return
    }

    const operator = arg("operator")
    assert(operator, "Commit requires --operator=<who is running this>")
    assert(arg("confirm-organization") === ORGANIZATION_CONFIRMATION,
      `Commit requires --confirm-organization=${ORGANIZATION_CONFIRMATION}`)
    assert(arg("confirm-plan-sha256") === digest, `Commit requires --confirm-plan-sha256=${digest}`)
    assert(arg("expected-changes") === String(plan.changes.length),
      `Commit requires --expected-changes=${plan.changes.length}`)
    assert(plan.changes.length > 0, "Nothing to restate")

    const before = await fingerprints(client)
    const prechangePath = output.replace(/\.json$/, "") + `-prechange.json`
    saveJson(prechangePath, {
      generatedAt: new Date().toISOString(), organization: ORGANIZATION, planSha256: digest,
      fingerprints: before, orders: current,
    })
    const prechangeSha256 = sha256(readFileSync(prechangePath, "utf8"))

    let auditLogId = 0
    await client.query("begin")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
      await client.query(
        `select o.id from legacy_order_imports l join orders o on o.id = l.order_id
          where l.organization_id = $1 order by o.id for update of o`, [ORGANIZATION.id])

      // Rebuild from rows read under the lock. Anything that moved since the
      // preflight changes the digest and nothing is written.
      const locked = await readCurrentOrders(client)
      const lockedPlan = planStatusResync(locked, legacy)
      assert(planDigest(lockedPlan) === digest,
        "K-Electric orders changed after the preflight; aborting")

      for (const change of lockedPlan.changes) {
        const updated = await rows(client, `
          update orders set status = $1, fulfillment_status = $2, updated_at = now()
           where id = $3 and organization_id = $4 and status = $5
             and coalesce(fulfillment_status, '') = coalesce($6, '')
          returning id
        `, [change.toStatus, change.toFulfillmentStatus, change.orderId, ORGANIZATION.id,
          change.fromStatus, change.fromFulfillmentStatus])
        assert(updated.length === 1, `Concurrent change detected for order ${change.orderId}`)
      }

      const audit = await rows(client, `
        insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
        values (null, $1, null, 'KE_ORDER_STATUS_RESYNC', 'orders', $2, $3::jsonb)
        returning id
      `, [ORGANIZATION.id, digest.slice(0, 128), JSON.stringify({
        planSha256: digest, operator, prechangePath, prechangeSha256,
        changedOrders: lockedPlan.changes.length,
        heldOrders: lockedPlan.holds.length,
        transitions: summarizeStatusResync(lockedPlan).byTransition,
      })])
      auditLogId = Number(audit[0]?.id)
      assert(Number.isSafeInteger(auditLogId), "Failed to write the resync audit row")

      await client.query("commit")
    } catch (error) {
      await client.query("rollback")
      throw error
    }

    const after = await fingerprints(client)
    for (const key of ["ke_orders", "ke_order_total", "ke_refund_total", "ke_order_items",
      "ke_budget_consumption", "other_tenant_orders", "other_tenant_order_total",
      "other_tenant_status_mix"]) {
      assert(canonical(before[key]) === canonical(after[key]),
        `Protected state changed during the resync: ${key}`)
    }

    saveJson(output, {
      ...report,
      mode: "COMMITTED",
      committedAt: new Date().toISOString(),
      operator,
      auditLogId,
      prechange: { path: prechangePath, sha256: prechangeSha256 },
      protectedFingerprints: { before, after },
      rollbackConfirmation: `ROLLBACK:${auditLogId}:KE-STATUS-RESYNC`,
    })

    // Already committed — a cache that will not clear is reported, not thrown.
    const cache = await invalidateCachePrefixes(["orders", "analytics", "dashboard"])

    console.log(JSON.stringify({
      mode: "COMMITTED", output, auditLogId, planSha256: digest,
      changed: plan.changes.length, held: plan.holds.length,
      cacheInvalidation: cache,
      rollbackConfirmation: `ROLLBACK:${auditLogId}:KE-STATUS-RESYNC`,
    }, null, 2))
    const failed = cache.filter((entry) => entry.error)
    if (failed.length > 0) {
      console.warn(`\nWARNING: ${failed.length} cache prefix(es) were not cleared — statuses are`)
      console.warn("written but readers may serve stale values until their TTL expires.")
      for (const entry of failed) console.warn(`  ${entry.prefix}: ${entry.error}`)
    }
  } finally {
    client.release()
    await closePool()
  }
}

async function rollback(client: PoolClient, reportPath: string): Promise<void> {
  assert(existsSync(reportPath), `Commit report not found: ${reportPath}`)
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as CommitReport
  assert(report.kind === "KE_ORDER_STATUS_RESYNC" && report.mode === "COMMITTED",
    "Not a committed status-resync report")
  assert(report.organization?.id === ORGANIZATION.id && report.organization.code === ORGANIZATION.code,
    "Commit report tenant mismatch")
  assert(arg("confirm-organization") === ORGANIZATION_CONFIRMATION,
    `--confirm-organization must equal ${ORGANIZATION_CONFIRMATION}`)
  assert(arg("confirm-rollback") === `ROLLBACK:${report.auditLogId}:KE-STATUS-RESYNC`,
    `--confirm-rollback must equal ROLLBACK:${report.auditLogId}:KE-STATUS-RESYNC`)
  await assertTenant(client)

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    for (const change of report.changes) {
      const restored = await rows(client, `
        update orders set status = $1, fulfillment_status = $2, updated_at = now()
         where id = $3 and organization_id = $4 and status = $5
           and coalesce(fulfillment_status, '') = coalesce($6, '')
        returning id
      `, [change.fromStatus, change.fromFulfillmentStatus, change.orderId, ORGANIZATION.id,
        change.toStatus, change.toFulfillmentStatus])
      assert(restored.length === 1,
        `Order ${change.orderId} changed after the resync; rollback refused`)
    }
    await client.query(`
      insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
      values (null, $1, null, 'KE_ORDER_STATUS_RESYNC_ROLLBACK', 'orders', $2, $3::jsonb)
    `, [ORGANIZATION.id, String(report.auditLogId), JSON.stringify({
      revertedOrders: report.changes.length, planSha256: report.planSha256,
    })])
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }
  console.log(JSON.stringify({ mode: "ROLLED_BACK", reverted: report.changes.length }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
