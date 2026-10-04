#!/usr/bin/env tsx
/**
 * Removes specific imported K-Electric orders, named by their legacy order id.
 *
 * For orders the legacy platform no longer counts — rows its list endpoint has
 * stopped returning, or orders it has since downgraded to drafts — where the
 * decision has been taken that OneFlowe should not count them either. The
 * operational delete routes are deliberately not used: they would adjust
 * today's stock and budget ledgers as if a live order were being cancelled.
 *
 * Deletion order follows `rollback-ke-legacy-import.ts`: refund items, refunds,
 * order items, the import ledger row, then the order. `notifications` and
 * `email_outbox` cascade; support threads keep their history with the order
 * reference nulled. Budget spend is NOT recomputed here — run
 * `backfill:ke-budget-spend` afterwards, exactly as after an import.
 *
 * Scope is organization 10 only, asserted by name. Default mode is a read-only
 * preflight. Commit is digest-gated, runs in one transaction, re-reads every
 * order under lock, snapshots every deleted row to a JSON file so the removal
 * can be reconstructed, and writes one `audit_logs` row.
 *
 *   npx tsx scripts/remove-ke-orders.ts --legacy-order-ids=41,44,51
 *   npx tsx scripts/remove-ke-orders.ts --legacy-order-ids=41,44,51 --commit \
 *     --confirm-plan-sha256=<digest> --actor-user-id=<super admin uuid> --operator=you@example.com
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import { KE_SYNC_ORGANIZATION, normalizeName } from "../lib/legacy-import/ke-sync"
import { canonicalJson } from "../lib/user-name-correction"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ADVISORY_LOCK = 700022
const AUDIT_ACTION = "KE_ORDERS_REMOVED"

type JsonRow = Record<string, unknown>

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function rows<T = JsonRow>(client: PoolClient, query: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(query, params)).rows as T[]
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const money = (cents: unknown) => (Number(cents ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })

interface Target {
  legacyOrderId: number
  orderId: number
  createdAt: string
  branch: string
  createdBy: string
  status: string
  paymentStatus: string
  totalCents: number
  refundAmountCents: number | null
  items: number
  refunds: number
  notifications: number
  supportThreads: number
  budgetPeriod: string
}

async function readOrganization(client: PoolClient) {
  const [org] = await rows(client, `select id, code, name from organizations where id = $1`, [KE_SYNC_ORGANIZATION.id])
  assert(org && normalizeName(org.name) === normalizeName(KE_SYNC_ORGANIZATION.name),
    `Organization ${KE_SYNC_ORGANIZATION.id} is not ${KE_SYNC_ORGANIZATION.name} in this database; refusing.`)
  return { id: Number(org.id), code: String(org.code), name: String(org.name) }
}

async function readTargets(client: PoolClient, organizationId: number, legacyIds: number[]): Promise<Target[]> {
  const found = await rows(client, `
    select l.legacy_order_id, o.id, o.created_at, b.name as branch, u.username as created_by, o.status,
           o.payment_status, o.total_cents, o.refund_amount_cents,
           to_char(o.created_at at time zone 'Asia/Karachi', 'YYYY-MM') as budget_period,
           (select count(*)::int from order_items i where i.order_id = o.id) as items,
           (select count(*)::int from refunds r where r.order_id = o.id) as refunds,
           (select count(*)::int from notifications n where n.order_id = o.id) as notifications,
           (select count(*)::int from support_threads s where s.order_id = o.id) as support_threads
      from legacy_order_imports l
      join orders o on o.id = l.order_id
      left join branches b on b.id = o.branch_id
      left join users u on u.id = o.created_by_user_id
     where l.organization_id = $1 and o.organization_id = $1 and l.legacy_order_id = any($2::int[])
     order by l.legacy_order_id`, [organizationId, legacyIds])
  const missing = legacyIds.filter((id) => !found.some((row) => Number(row.legacy_order_id) === id))
  assert(missing.length === 0, `No imported K-Electric order for legacy id(s): ${missing.join(", ")}`)
  return found.map((row): Target => ({
    legacyOrderId: Number(row.legacy_order_id),
    orderId: Number(row.id),
    createdAt: new Date(String(row.created_at)).toISOString(),
    branch: String(row.branch ?? ""),
    createdBy: String(row.created_by ?? ""),
    status: String(row.status),
    paymentStatus: String(row.payment_status),
    totalCents: Number(row.total_cents),
    refundAmountCents: row.refund_amount_cents == null ? null : Number(row.refund_amount_cents),
    items: Number(row.items),
    refunds: Number(row.refunds),
    notifications: Number(row.notifications),
    supportThreads: Number(row.support_threads),
    budgetPeriod: String(row.budget_period),
  }))
}

function digestOf(organizationId: number, targets: Target[]): string {
  return sha256(canonicalJson({
    organization: organizationId,
    orders: targets.map((t) => [t.legacyOrderId, t.orderId, t.status, t.totalCents, t.items]),
  }))
}

function print(targets: Target[]): void {
  for (const t of targets) {
    console.log(`  legacy ${String(t.legacyOrderId).padStart(5)}  order ${String(t.orderId).padStart(5)}  ${t.createdAt.slice(0, 10)}  `
      + `${t.status.padEnd(9)} ${t.paymentStatus.padEnd(6)} ${money(t.totalCents).padStart(12)}  ${String(t.items).padStart(3)} items  `
      + `${t.refunds} refunds  ${t.notifications} notif  ${t.supportThreads} threads  ${t.branch}  by ${t.createdBy}`)
  }
  console.log(`  total ${money(targets.reduce((s, t) => s + t.totalCents, 0))} across ${targets.length} order(s)`)
}

async function main(): Promise<void> {
  const legacyIds = [...new Set((arg("--legacy-order-ids") ?? "").split(",").map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v > 0))]
  assert(legacyIds.length > 0, "--legacy-order-ids=<id,id,...> is required")
  const { pool, closePool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    if (!process.argv.includes("--commit")) {
      await client.query("begin transaction read only")
      const org = await readOrganization(client)
      const targets = await readTargets(client, org.id, legacyIds)
      await client.query("commit")
      print(targets)
      const digest = digestOf(org.id, targets)
      console.log(`\nDry run: nothing was written. To remove these orders:\n  npx tsx scripts/remove-ke-orders.ts --legacy-order-ids=${legacyIds.join(",")} --commit \\\n`
        + `    --confirm-plan-sha256=${digest} --actor-user-id=<active super admin uuid> --operator=<your email>`)
      return
    }

    const operator = arg("--operator")
    assert(operator && /.@./.test(operator), "--operator=<your email> is required so the audit trail names a person")
    const actorUserId = arg("--actor-user-id")
    assert(actorUserId, "--actor-user-id=<uuid> is required")

    await client.query("begin")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
      const org = await readOrganization(client)
      const [actor] = await rows(client, `
        select u.id from users u join roles r on r.id = u.role_id
         where u.id = $1 and r.name = 'SUPER_ADMIN' and u.is_active and u.deleted_at is null`, [actorUserId])
      assert(actor, "--actor-user-id must be an active SUPER_ADMIN")

      const targets = await readTargets(client, org.id, legacyIds)
      const digest = digestOf(org.id, targets)
      assert(arg("--confirm-plan-sha256") === digest,
        `--confirm-plan-sha256 does not match the current plan (${digest}). Re-run the preflight.`)
      const orderIds = targets.map((t) => t.orderId)
      const locked = await rows(client,
        `select id from orders where organization_id = $1 and id = any($2::int[]) for update`, [org.id, orderIds])
      assert(locked.length === orderIds.length, "Tenant/ownership verification failed under lock")

      // Snapshot everything that is about to go, so the removal can be
      // reconstructed row for row if the decision is reversed.
      const snapshot = {
        organization: org,
        operator,
        removedAt: new Date().toISOString(),
        planSha256: digest,
        orders: await rows(client, `select * from orders where organization_id = $1 and id = any($2::int[])`, [org.id, orderIds]),
        orderItems: await rows(client, `select * from order_items where order_id = any($1::int[])`, [orderIds]),
        legacyOrderImports: await rows(client, `select * from legacy_order_imports where organization_id = $1 and order_id = any($2::int[])`, [org.id, orderIds]),
        refunds: await rows(client, `select * from refunds where organization_id = $1 and order_id = any($2::int[])`, [org.id, orderIds]),
        refundItems: [] as JsonRow[],
        notifications: await rows(client, `select * from notifications where order_id = any($1::int[])`, [orderIds]),
      }
      const refundIds = snapshot.refunds.map((r) => r.id)
      if (refundIds.length) {
        snapshot.refundItems = await rows(client, `select * from refund_items where refund_id = any($1::int[])`, [refundIds])
        await client.query(`delete from refund_items where refund_id = any($1::int[])`, [refundIds])
        await client.query(`delete from refunds where organization_id = $1 and id = any($2::int[])`, [org.id, refundIds])
      }
      await client.query(`delete from order_items where order_id = any($1::int[])`, [orderIds])
      await client.query(`delete from legacy_order_imports where organization_id = $1 and order_id = any($2::int[])`, [org.id, orderIds])
      const deleted = await client.query(`delete from orders where organization_id = $1 and id = any($2::int[])`, [org.id, orderIds])
      assert(deleted.rowCount === orderIds.length, `Expected to delete ${orderIds.length} orders, deleted ${deleted.rowCount}`)

      const output = resolve(arg("--output") ?? `deliverables/ke-orders-removed-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}.json`)
      await client.query(`
        insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata)
        values ($1, $2, $3, 'orders', $4, $5::jsonb)`,
        [actorUserId, org.id, AUDIT_ACTION, legacyIds.join(","), JSON.stringify({
          operator, planSha256: digest, snapshot: output,
          orders: targets.map((t) => ({ legacyOrderId: t.legacyOrderId, orderId: t.orderId, status: t.status, totalCents: t.totalCents, budgetPeriod: t.budgetPeriod })),
          reason: "legacy platform no longer counts these orders (delisted or downgraded to draft); removed by decision so the two systems agree",
          stockOrBudgetChanged: false,
          followUp: "backfill:ke-budget-spend",
        })])
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
      await client.query("commit")
      print(targets)
      console.log(`\nRemoved ${targets.length} order(s). Snapshot: ${output}\nNext: npx tsx scripts/backfill-ke-budget-spend.ts (dry run, then commit) to recompute spend for periods ${[...new Set(targets.map((t) => t.budgetPeriod))].join(", ")}.`)
    } catch (error) {
      await client.query("rollback")
      throw error
    }
  } finally {
    client.release()
    await closePool()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
