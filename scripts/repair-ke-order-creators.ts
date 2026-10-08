#!/usr/bin/env tsx
/**
 * Give imported K-Electric orders parked on a placeholder account back to the
 * person who placed them.
 *
 * The order importers attributed an order to a synthetic, inactive
 * `legacy_ke_*@historical.invalid` account whenever no real account matched.
 * The Order Portal shows a user only the orders they created at their own
 * branch, so those people cannot see their own history. Which orders move, and
 * which are held and why, is pure and unit-tested in
 * `lib/legacy-import/ke-order-creators.ts`; the rules are argued in
 * `plans/OF-KE-reattribute-placeholder-orders.md`. This script supplies rows,
 * gates the tenant, and performs the write.
 *
 * Default mode is a read-only preflight. Commit is digest-gated, runs in one
 * transaction under an advisory lock, re-derives the plan from rows read under
 * that lock, and writes an `audit_logs` row. A committed report feeds
 * `--rollback`.
 *
 *   npx tsx scripts/repair-ke-order-creators.ts
 *   npx tsx scripts/repair-ke-order-creators.ts --commit \
 *     --confirm-organization=10:0001:K-Electric \
 *     --confirm-plan-sha256=<digest> --expected-moves=<n> --operator=you@example.com
 *   npx tsx scripts/repair-ke-order-creators.ts --rollback=<committed report>.json \
 *     --confirm-organization=10:0001:K-Electric --confirm-rollback=<printed>
 *
 * What it writes: `orders.created_by_user_id` and `updated_at` per moved order;
 * `legacy_user_mappings.user_id` / `is_synthetic` for a placeholder whose every
 * order moved; one audit row.
 *
 * What it will not do:
 *   - touch any organization but 10. Every statement carries that predicate,
 *     and nothing is matched by email (org 2 shares K-Electric's addresses).
 *   - move an order off a retired person's account, change a branch, a total,
 *     an item, a status, a budget, stock, a receipt, or an account; send email.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import { invalidateCachePrefixes } from "../lib/cache-cli"
import { compareCodeUnits } from "../lib/code-unit-order"
import {
  planOrderCreatorRepair,
  summarizeOrderCreatorRepair,
  type CreatorRepairInput,
  type CreatorRepairPlan,
  type ImportedOrder,
  type OrganizationAccount,
  type PinnedBranch,
  type TakerMapping,
} from "../lib/legacy-import/ke-order-creators"
import { KE_ORDERS_SOURCE as SOURCE_SYSTEM } from "../lib/legacy-import/ke-orders-api"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

/** Production renamed the tenant "K-Electric Limited"; the id and code are what pin it. */
const ORGANIZATION = { id: 10, code: "0001", namePrefix: "K-Electric" } as const
const ORGANIZATION_CONFIRMATION = "10:0001:K-Electric"
/** Shared with repair-ke-order-branches and regenerate-usernames: never concurrent with either. */
const ADVISORY_LOCK = 700012
const BRANCH_SOURCE = "KE_LOGISTICS"
const ROLLBACK_TAG = "KE-ORDER-CREATOR-REPAIR"

type JsonRow = Record<string, any>

interface CommitReport {
  kind: "KE_ORDER_CREATOR_REPAIR"
  mode: "COMMITTED"
  organization: typeof ORGANIZATION
  planSha256: string
  auditLogId: number
  moves: CreatorRepairPlan["moves"]
  mappingChanges: CreatorRepairPlan["mappingChanges"]
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
    return `{${Object.keys(value as JsonRow).sort(compareCodeUnits)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as JsonRow)[k])}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

const planDigest = (plan: CreatorRepairPlan) =>
  sha256(canonical({ moves: plan.moves, mappingChanges: plan.mappingChanges }))

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
}

async function rows<T extends JsonRow = JsonRow>(
  client: PoolClient, text: string, params: unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

const optionalInt = (value: unknown): number | null =>
  value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value)

/**
 * Every imported order, not only those on an inactive creator: whether a
 * legacy login changed hands is judged across all of them.
 */
async function readState(client: PoolClient): Promise<CreatorRepairInput> {
  const orders = (await rows(client, `
    select o.id, o.tid, o.branch_id, o.created_by_user_id, l.legacy_order_id,
           coalesce(l.source_payload->'sourceHeader', l.source_payload->'header') as header
      from orders o
      join legacy_order_imports l
        on l.order_id = o.id and l.organization_id = o.organization_id and l.source_system = $2
     where o.organization_id = $1
     order by o.id
  `, [ORGANIZATION.id, SOURCE_SYSTEM])).map((row): ImportedOrder => {
    const header = (row.header ?? {}) as JsonRow
    return {
      orderId: Number(row.id),
      tid: String(row.tid),
      branchId: Number(row.branch_id),
      createdByUserId: row.created_by_user_id == null ? null : String(row.created_by_user_id),
      legacyOrderId: Number(row.legacy_order_id),
      legacyTakerId: optionalInt(header.OrderTakerID),
      legacyTakerName: header.UserDetails == null ? null : String(header.UserDetails),
      legacyLocationId: optionalInt(header.LocationID),
    }
  })

  const accounts = (await rows(client, `
    select u.id, u.username, u.email, u.full_name, u.first_name, u.last_name, r.name as role,
           u.branch_id, u.is_active, u.deleted_at is not null as is_deleted,
           u.external_source, u.external_id
      from users u
      left join roles r on r.id = u.role_id
     where u.organization_id = $1
     order by u.id
  `, [ORGANIZATION.id])).map((row): OrganizationAccount => ({
    userId: String(row.id),
    username: String(row.username ?? ""),
    email: String(row.email ?? ""),
    fullName: row.full_name ?? null,
    firstName: row.first_name ?? null,
    lastName: row.last_name ?? null,
    role: row.role ?? null,
    branchId: optionalInt(row.branch_id),
    isActive: row.is_active === true,
    isDeleted: row.is_deleted === true,
    externalSource: row.external_source ?? null,
    externalId: row.external_id == null ? null : String(row.external_id),
  }))

  const branches = (await rows(client, `
    select id, name, external_source, external_id from branches where organization_id = $1 order by id
  `, [ORGANIZATION.id])).map((row): PinnedBranch => ({
    id: Number(row.id),
    name: String(row.name),
    externalSource: row.external_source ?? null,
    externalId: row.external_id == null ? null : String(row.external_id),
  }))

  const mappings = (await rows(client, `
    select id, legacy_order_taker_id, branch_id, user_id, is_synthetic
      from legacy_user_mappings
     where organization_id = $1 and source_system = $2
     order by id
  `, [ORGANIZATION.id, SOURCE_SYSTEM])).map((row): TakerMapping => ({
    id: Number(row.id),
    legacyOrderTakerId: Number(row.legacy_order_taker_id),
    branchId: Number(row.branch_id),
    userId: String(row.user_id),
    isSynthetic: row.is_synthetic === true,
  }))

  return { orders, accounts, branches, mappings, source: BRANCH_SOURCE }
}

/**
 * State that must be identical before and after. Budgets are included whole:
 * they are keyed by branch, so a change of creator must not move a cent.
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
      (select coalesce(string_agg(status || ':' || count::text, ',' order by status), '') from (
         select status, count(*)::int as count from orders where organization_id = $1 group by status
       ) s) as ke_status_mix,
      (select coalesce(string_agg(branch_id::text || ':' || count::text, ',' order by branch_id), '') from (
         select branch_id, count(*)::int as count from orders where organization_id = $1 group by branch_id
       ) b) as ke_branch_mix,
      (select count(*)::int from users where organization_id = $1 and is_active) as ke_active_users,
      (select count(*)::int from budgets) as budgets,
      (select coalesce(sum(amount_allocated_cents + amount_spent_cents + amount_held_cents
         + amount_credited_cents), 0)::text from budgets) as budget_total,
      (select count(*)::int from orders where organization_id <> $1) as other_tenant_orders,
      (select coalesce(sum(total_cents), 0)::text from orders where organization_id <> $1) as other_tenant_order_total,
      (select count(*)::int from legacy_user_mappings where organization_id = $1) as ke_mappings
  `, [ORGANIZATION.id])
  return value
}

const PROTECTED_FINGERPRINTS = ["ke_orders", "ke_order_total", "ke_refund_total", "ke_order_items",
  "ke_status_mix", "ke_branch_mix", "ke_active_users", "budgets", "budget_total",
  "other_tenant_orders", "other_tenant_order_total", "ke_mappings"] as const

/**
 * Prove the write path exists before the dry run claims the commit will work.
 * A preflight runs no UPDATE, so a wrong column name would survive it.
 */
async function assertWritableColumns(client: PoolClient): Promise<void> {
  const required: Record<string, readonly string[]> = {
    orders: ["id", "tid", "organization_id", "branch_id", "created_by_user_id", "updated_at"],
    legacy_user_mappings: ["id", "organization_id", "source_system", "legacy_order_taker_id", "branch_id",
      "user_id", "is_synthetic", "updated_at"],
    audit_logs: ["user_id", "organization_id", "branch_id", "action", "entity", "entity_id", "metadata"],
  }
  for (const [table, columns] of Object.entries(required)) {
    const present = new Set((await rows(client, `
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = $1
    `, [table])).map((row) => String(row.column_name)))
    const missing = columns.filter((column) => !present.has(column))
    assert(missing.length === 0,
      `${table} is missing column(s) this script writes or filters on: ${missing.join(", ")}`)
  }
}

async function assertTenant(client: PoolClient): Promise<void> {
  const [org] = await rows(client,
    "select id, code, name from organizations where id = $1", [ORGANIZATION.id])
  assert(org && org.code === ORGANIZATION.code && String(org.name).startsWith(ORGANIZATION.namePrefix),
    `Organization ${ORGANIZATION.id} is not ${ORGANIZATION_CONFIRMATION}; refusing to run`)
}

function buildReport(plan: CreatorRepairPlan, digest: string) {
  return {
    kind: "KE_ORDER_CREATOR_REPAIR" as const,
    mode: "DRY_RUN" as const,
    generatedAt: new Date().toISOString(),
    organization: ORGANIZATION,
    policy: {
      plan: "plans/OF-KE-reattribute-placeholder-orders.md",
      moves: "placeholder creator only; branch pinned to the legacy LocationID; one name per legacy login; "
        + "exactly one active ORDER_PORTAL KE_LOGISTICS account of that name at the order's branch",
      untouched: ["branch", "totals", "items", "status", "budgets", "stock", "receipts", "accounts", "email"],
    },
    summary: summarizeOrderCreatorRepair(plan),
    planSha256: digest,
    requiredCommitArguments: {
      confirmOrganization: ORGANIZATION_CONFIRMATION,
      confirmPlanSha256: digest,
      expectedMoves: plan.moves.length,
    },
    moves: plan.moves,
    mappingChanges: plan.mappingChanges,
    holds: plan.holds,
  }
}

/** The rows a commit or rollback writes, locked before the plan is rebuilt. */
async function lockTargets(client: PoolClient, plan: Pick<CreatorRepairPlan, "moves" | "mappingChanges">): Promise<void> {
  const orderIds = plan.moves.map((move) => move.orderId)
  const userIds = [...new Set(plan.moves.flatMap((move) => [move.from.userId, move.to.userId]))]
  const mappingIds = plan.mappingChanges.map((change) => change.mappingId)
  await client.query(
    `select id from orders where organization_id = $1 and id = any($2::int[]) order by id for update`,
    [ORGANIZATION.id, orderIds])
  await client.query(
    `select id from users where organization_id = $1 and id = any($2::uuid[]) order by id for share`,
    [ORGANIZATION.id, userIds])
  await client.query(
    `select id from legacy_user_mappings where organization_id = $1 and id = any($2::int[]) order by id for update`,
    [ORGANIZATION.id, mappingIds])
}

async function applyPlan(client: PoolClient, plan: CreatorRepairPlan): Promise<void> {
  for (const move of plan.moves) {
    const updated = await rows(client, `
      update orders
         set created_by_user_id = $1::uuid, updated_at = now()
       where id = $2 and organization_id = $3 and tid = $4
         and branch_id = $5 and created_by_user_id = $6::uuid
      returning id
    `, [move.to.userId, move.orderId, ORGANIZATION.id, move.tid, move.branchId, move.from.userId])
    assert(updated.length === 1, `Concurrent change detected for order ${move.orderId} (${move.tid})`)
  }
  for (const change of plan.mappingChanges) {
    const updated = await rows(client, `
      update legacy_user_mappings
         set user_id = $1::uuid, is_synthetic = $2, updated_at = now()
       where id = $3 and organization_id = $4 and source_system = $5
         and legacy_order_taker_id = $6 and branch_id = $7
         and user_id = $8::uuid and is_synthetic = $9
      returning id
    `, [change.to.userId, change.to.isSynthetic, change.mappingId, ORGANIZATION.id, SOURCE_SYSTEM,
      change.legacyOrderTakerId, change.branchId, change.from.userId, change.from.isSynthetic])
    assert(updated.length === 1, `Concurrent change detected for legacy user mapping ${change.mappingId}`)
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
      arg("output") ?? `updatedReports/ke-order-creator-repair-${new Date().toISOString().slice(0, 10)}.json`)

    const state = await readState(client)
    const plan = planOrderCreatorRepair(state)
    const digest = planDigest(plan)
    const report = buildReport(plan, digest)

    if (!flag("commit")) {
      saveJson(output, report)
      console.log(JSON.stringify({
        mode: "DRY_RUN", output, planSha256: digest, summary: report.summary,
        moves: plan.moves.map((move) =>
          `${move.tid} @ ${move.branchName}: ${move.from.username} -> ${move.to.username}`),
        mappingChanges: plan.mappingChanges.map((change) =>
          `mapping ${change.mappingId} (taker ${change.legacyOrderTakerId}, branch ${change.branchId}) -> ${change.to.userId}`),
        holds: plan.holds.map((hold) => `${hold.tid} [${hold.reason}] ${hold.detail}`),
      }, null, 2))
      if (plan.moves.length === 0) {
        console.log("\nNothing to move: no placeholder order can be proven to belong to a current account.")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npx tsx scripts/repair-ke-order-creators.ts --commit \\
    --confirm-organization=${ORGANIZATION_CONFIRMATION} \\
    --confirm-plan-sha256=${digest} \\
    --expected-moves=${plan.moves.length} \\
    --operator=<you@example.com>`)
      }
      return
    }

    const operator = arg("operator")
    assert(operator, "Commit requires --operator=<who is running this>")
    assert(arg("confirm-organization") === ORGANIZATION_CONFIRMATION,
      `Commit requires --confirm-organization=${ORGANIZATION_CONFIRMATION}`)
    assert(arg("confirm-plan-sha256") === digest, `Commit requires --confirm-plan-sha256=${digest}`)
    assert(arg("expected-moves") === String(plan.moves.length),
      `Commit requires --expected-moves=${plan.moves.length}`)
    assert(plan.moves.length > 0, "Nothing to move")

    const before = await fingerprints(client)
    const prechangePath = output.replace(/\.json$/, "") + "-prechange.json"
    saveJson(prechangePath, {
      generatedAt: new Date().toISOString(), organization: ORGANIZATION, planSha256: digest,
      fingerprints: before,
      orders: state.orders.filter((order) => plan.moves.some((move) => move.orderId === order.orderId)),
      mappings: state.mappings.filter((mapping) =>
        plan.mappingChanges.some((change) => change.mappingId === mapping.id)),
    })
    const prechangeSha256 = sha256(readFileSync(prechangePath, "utf8"))

    let auditLogId = 0
    await client.query("begin")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
      await lockTargets(client, plan)

      // Rebuild from rows read under the lock. Anything that moved since the
      // preflight changes the digest and nothing is written.
      const lockedPlan = planOrderCreatorRepair(await readState(client))
      assert(planDigest(lockedPlan) === digest,
        "K-Electric orders, accounts or mappings changed after the preflight; aborting")

      await applyPlan(client, lockedPlan)

      const audit = await rows(client, `
        insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
        values (null, $1, null, 'KE_ORDER_CREATOR_REPAIR', 'orders', $2, $3::jsonb)
        returning id
      `, [ORGANIZATION.id, digest.slice(0, 128), JSON.stringify({
        planSha256: digest, operator, prechangePath, prechangeSha256,
        summary: summarizeOrderCreatorRepair(lockedPlan),
        moves: lockedPlan.moves.map((move) => ({
          orderId: move.orderId, tid: move.tid, legacyOrderId: move.legacyOrderId, branchId: move.branchId,
          creatorFrom: move.from.userId, creatorTo: move.to.userId,
        })),
        mappingChanges: lockedPlan.mappingChanges.map((change) => ({
          mappingId: change.mappingId, userFrom: change.from.userId, userTo: change.to.userId,
        })),
      })])
      auditLogId = Number(audit[0]?.id)
      assert(Number.isSafeInteger(auditLogId) && auditLogId > 0, "Failed to write the repair audit row")

      await client.query("commit")
    } catch (error) {
      await client.query("rollback")
      throw error
    }

    const after = await fingerprints(client)
    for (const key of PROTECTED_FINGERPRINTS) {
      assert(canonical(before[key]) === canonical(after[key]),
        `Protected state changed during the repair: ${key}`)
    }
    const landed = await rows(client, `
      select id, created_by_user_id from orders where organization_id = $1 and id = any($2::int[])
    `, [ORGANIZATION.id, plan.moves.map((move) => move.orderId)])
    const creatorById = new Map(landed.map((row) => [Number(row.id), String(row.created_by_user_id)]))
    for (const move of plan.moves) {
      assert(creatorById.get(move.orderId) === move.to.userId,
        `Order ${move.orderId} does not carry its new creator after commit`)
    }

    const rollbackConfirmation = `ROLLBACK:${auditLogId}:${ROLLBACK_TAG}`
    saveJson(output, {
      ...report,
      mode: "COMMITTED",
      committedAt: new Date().toISOString(),
      operator,
      auditLogId,
      prechange: { path: prechangePath, sha256: prechangeSha256 },
      protectedFingerprints: { before, after },
      rollbackConfirmation,
    })

    // Already committed — a cache that will not clear is reported, not thrown.
    const cache = await invalidateCachePrefixes(["orders", "analytics", "dashboard"])

    console.log(JSON.stringify({
      mode: "COMMITTED", output, auditLogId, planSha256: digest,
      moved: plan.moves.length, mappingChanges: plan.mappingChanges.length, held: plan.holds.length,
      cacheInvalidation: cache,
      rollbackConfirmation,
    }, null, 2))
    const failed = cache.filter((entry) => entry.error)
    if (failed.length > 0) {
      console.warn(`\nWARNING: ${failed.length} cache prefix(es) were not cleared — rows are`)
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
  assert(report.kind === "KE_ORDER_CREATOR_REPAIR" && report.mode === "COMMITTED",
    "Not a committed order-creator-repair report")
  assert(report.organization?.id === ORGANIZATION.id && report.organization.code === ORGANIZATION.code,
    "Commit report tenant mismatch")
  assert(arg("confirm-organization") === ORGANIZATION_CONFIRMATION,
    `--confirm-organization must equal ${ORGANIZATION_CONFIRMATION}`)
  const expected = `ROLLBACK:${report.auditLogId}:${ROLLBACK_TAG}`
  assert(arg("confirm-rollback") === expected, `--confirm-rollback must equal ${expected}`)
  await assertTenant(client)

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    await lockTargets(client, report)
    for (const move of report.moves) {
      const restored = await rows(client, `
        update orders
           set created_by_user_id = $1::uuid, updated_at = now()
         where id = $2 and organization_id = $3 and tid = $4
           and branch_id = $5 and created_by_user_id = $6::uuid
        returning id
      `, [move.from.userId, move.orderId, ORGANIZATION.id, move.tid, move.branchId, move.to.userId])
      assert(restored.length === 1, `Order ${move.orderId} changed after the repair; rollback refused`)
    }
    for (const change of report.mappingChanges) {
      const restored = await rows(client, `
        update legacy_user_mappings
           set user_id = $1::uuid, is_synthetic = $2, updated_at = now()
         where id = $3 and organization_id = $4 and source_system = $5
           and legacy_order_taker_id = $6 and branch_id = $7
           and user_id = $8::uuid and is_synthetic = $9
        returning id
      `, [change.from.userId, change.from.isSynthetic, change.mappingId, ORGANIZATION.id, SOURCE_SYSTEM,
        change.legacyOrderTakerId, change.branchId, change.to.userId, change.to.isSynthetic])
      assert(restored.length === 1, `Legacy user mapping ${change.mappingId} changed after the repair; rollback refused`)
    }
    await client.query(`
      insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
      values (null, $1, null, 'KE_ORDER_CREATOR_REPAIR_ROLLBACK', 'orders', $2, $3::jsonb)
    `, [ORGANIZATION.id, String(report.auditLogId), JSON.stringify({
      revertedOrders: report.moves.length, revertedMappings: report.mappingChanges.length,
      planSha256: report.planSha256,
    })])
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }
  const cache = await invalidateCachePrefixes(["orders", "analytics", "dashboard"])
  console.log(JSON.stringify({
    mode: "ROLLED_BACK", reverted: report.moves.length, mappings: report.mappingChanges.length,
    cacheInvalidation: cache,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
