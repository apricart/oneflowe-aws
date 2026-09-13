#!/usr/bin/env tsx
/**
 * Move imported K-Electric orders to the branch their legacy location names.
 *
 * `import-ke-orders.ts` used to key branches by normalised name, and legacy
 * has twins whose names collapse to one string — `Johar |` / `Johar ||`,
 * `society cluster` / `Society Cluster` — so a twin's orders were filed at the
 * other twin. Every import recorded the legacy `LocationID` in
 * `legacy_order_imports.source_payload`, and every synced branch carries it in
 * `external_id`, so the disagreement is detectable after the fact. The decision
 * of what moves, who it is attributed to, and what the affected branch/month
 * budget rows must read is pure and unit-tested in
 * `lib/legacy-import/ke-order-branches.ts`; this script supplies rows, gates the
 * tenant, and performs the write.
 *
 * Default mode is a read-only preflight. Commit is digest-gated, runs in one
 * transaction under an advisory lock, re-derives the plan from rows read under
 * that lock, and writes an `audit_logs` row. A committed report feeds
 * `--rollback`.
 *
 *   npx tsx scripts/repair-ke-order-branches.ts
 *   npx tsx scripts/repair-ke-order-branches.ts --commit \
 *     --confirm-organization=10:0001:K-Electric \
 *     --confirm-plan-sha256=<digest> --expected-moves=<n> --operator=you@example.com
 *   npx tsx scripts/repair-ke-order-branches.ts --rollback=<committed report>.json \
 *     --confirm-organization=10:0001:K-Electric --confirm-rollback=<printed>
 *
 * What it writes, per moved order: `orders.branch_id`, `created_by_user_id`
 * when the attribution changes, the buyer name and address inside
 * `receipt_data`, and `updated_at`; then the recomputed `budgets` rows of the
 * months it left and joined, with the same accounting as
 * `backfill-ke-budget-spend.ts` (allocation raised where the invariant needs
 * it, never lowered).
 *
 * What it will not do:
 *   - touch any organization but 10. Every statement carries that predicate.
 *   - change total_cents, order_items, stock, quantity budgets, invoice
 *     sequences, or send any email.
 *   - move an order by name. A location no branch is pinned to is held for a
 *     human and `sync:ke`.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import { invalidateCachePrefixes } from "../lib/cache-cli"
import {
  planOrderBranchRepair,
  summarizeOrderBranchRepair,
  type BranchAccount,
  type BudgetLedgerRow,
  type CatalogueBranch,
  type OrderBranchRepairPlan,
  type PlacedOrder,
  type RepairInput,
} from "../lib/legacy-import/ke-order-branches"
import { KE_ORDERS_SOURCE as SOURCE_SYSTEM } from "../lib/legacy-import/ke-orders-api"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
const ORGANIZATION_CONFIRMATION = "10:0001:K-Electric"
const ADVISORY_LOCK = 700012

type JsonRow = Record<string, any>

interface CommitReport {
  kind: "KE_ORDER_BRANCH_REPAIR"
  mode: "COMMITTED"
  organization: typeof ORGANIZATION
  planSha256: string
  auditLogId: number
  moves: OrderBranchRepairPlan["moves"]
  budgetChanges: Array<OrderBranchRepairPlan["budgetChanges"][number] & { committedBudgetId: number }>
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

const planDigest = (plan: OrderBranchRepairPlan) =>
  sha256(canonical({ moves: plan.moves, budgetChanges: plan.budgetChanges }))

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
}

async function rows<T extends JsonRow = JsonRow>(
  client: PoolClient, text: string, params: unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

/**
 * Everything the planner needs. All of the organization's orders, not only
 * the imported ones: budget months are recomputed from the whole set.
 */
async function readState(client: PoolClient): Promise<RepairInput> {
  const orders = (await rows(client, `
    select o.id, o.tid, o.branch_id, o.status, o.total_cents, o.refund_amount_cents,
           o.created_by_user_id,
           to_char(o.created_at at time zone 'Asia/Karachi', 'YYYY-MM') as period,
           l.legacy_order_id,
           l.source_payload->'sourceHeader'->>'LocationID' as legacy_location_id,
           l.source_payload->'sourceHeader'->>'LocationName' as legacy_location_name
      from orders o
      left join legacy_order_imports l
        on l.order_id = o.id and l.organization_id = o.organization_id and l.source_system = $2
     where o.organization_id = $1
     order by o.id
  `, [ORGANIZATION.id, SOURCE_SYSTEM])).map((row): PlacedOrder => ({
    orderId: Number(row.id),
    tid: String(row.tid),
    branchId: Number(row.branch_id),
    status: String(row.status),
    totalCents: Number(row.total_cents),
    refundAmountCents: row.refund_amount_cents == null ? null : Number(row.refund_amount_cents),
    period: String(row.period),
    createdByUserId: row.created_by_user_id == null ? null : String(row.created_by_user_id),
    legacyOrderId: row.legacy_order_id == null ? null : Number(row.legacy_order_id),
    legacyLocationId: row.legacy_location_id == null || row.legacy_location_id === ""
      ? null : Number(row.legacy_location_id),
    legacyLocationName: row.legacy_location_name == null ? null : String(row.legacy_location_name),
  }))

  const branches = (await rows(client, `
    select id, name, address, external_source, external_id
      from branches where organization_id = $1 order by id
  `, [ORGANIZATION.id])).map((row): CatalogueBranch => ({
    id: Number(row.id),
    name: String(row.name),
    address: row.address ?? null,
    externalSource: row.external_source ?? null,
    externalId: row.external_id == null ? null : String(row.external_id),
  }))

  // Inactive accounts are eligible on purpose, as in the importer: a moved
  // order may belong to a person who has since been retired.
  const accounts = (await rows(client, `
    select u.id, u.username, u.branch_id, u.is_active, u.external_source, u.external_id
      from users u
      join roles r on r.id = u.role_id
     where u.organization_id = $1 and u.deleted_at is null and u.branch_id is not null
       and r.name = 'ORDER_PORTAL'
     order by u.username
  `, [ORGANIZATION.id])).map((row): BranchAccount => ({
    userId: String(row.id),
    username: String(row.username ?? ""),
    branchId: Number(row.branch_id),
    isActive: row.is_active === true,
    externalSource: row.external_source ?? null,
    externalId: row.external_id == null ? null : String(row.external_id),
  }))

  const budgets = (await rows(client, `
    select id, branch_id, period, amount_allocated_cents, amount_spent_cents,
           amount_held_cents, amount_credited_cents
      from budgets where organization_id = $1 order by branch_id, period
  `, [ORGANIZATION.id])).map((row): BudgetLedgerRow => ({
    id: Number(row.id),
    branchId: Number(row.branch_id),
    period: String(row.period),
    amountAllocatedCents: Number(row.amount_allocated_cents),
    amountSpentCents: Number(row.amount_spent_cents),
    amountHeldCents: Number(row.amount_held_cents),
    amountCreditedCents: Number(row.amount_credited_cents),
  }))

  return { orders, branches, accounts, budgets, source: SOURCE_SYSTEM }
}

/**
 * State that must be identical before and after. Other tenants appear here
 * because "K-Electric only" is a claim this script has to be able to prove.
 * Budget consumption is deliberately absent — it moves between branches, and
 * the plan says by how much.
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
      (select count(*)::int from orders where organization_id <> $1) as other_tenant_orders,
      (select coalesce(sum(total_cents), 0)::text from orders where organization_id <> $1) as other_tenant_order_total,
      (select count(*)::int from budgets where organization_id <> $1) as other_tenant_budgets,
      (select coalesce(sum(amount_allocated_cents + amount_spent_cents + amount_held_cents), 0)::text
         from budgets where organization_id <> $1) as other_tenant_budget_total
  `, [ORGANIZATION.id])
  return value
}

const PROTECTED_FINGERPRINTS = ["ke_orders", "ke_order_total", "ke_refund_total", "ke_order_items",
  "ke_status_mix", "other_tenant_orders", "other_tenant_order_total", "other_tenant_budgets",
  "other_tenant_budget_total"] as const

/**
 * Prove the write path exists before the dry run claims the commit will work.
 * A preflight runs no UPDATE, so a wrong column name survives it and fails only
 * at commit time.
 */
async function assertWritableColumns(client: PoolClient): Promise<void> {
  const required: Record<string, readonly string[]> = {
    orders: ["id", "organization_id", "branch_id", "created_by_user_id", "receipt_data", "updated_at"],
    budgets: ["id", "organization_id", "branch_id", "period", "amount_allocated_cents",
      "amount_spent_cents", "amount_held_cents", "amount_credited_cents", "updated_at"],
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
  assert(org && org.code === ORGANIZATION.code && org.name === ORGANIZATION.name,
    `Organization ${ORGANIZATION.id} is not ${ORGANIZATION_CONFIRMATION}; refusing to run`)
}

function buildReport(plan: OrderBranchRepairPlan, digest: string) {
  return {
    kind: "KE_ORDER_BRANCH_REPAIR" as const,
    mode: "DRY_RUN" as const,
    generatedAt: new Date().toISOString(),
    organization: ORGANIZATION,
    policy: {
      source: "legacy LocationID recorded in legacy_order_imports.source_payload.sourceHeader, "
        + "matched to branches.external_id; never by name",
      creator: "same legacy identity at the new branch, else the personal account is kept; "
        + "a branch placeholder follows the branch",
      budgets: "affected branch/month rows recomputed from the post-move order set with the "
        + "backfill-ke-budget-spend accounting; allocation raised where required, never lowered",
      untouched: ["total_cents", "order_items", "stock", "quantity budgets", "invoice sequences", "email"],
    },
    summary: summarizeOrderBranchRepair(plan),
    planSha256: digest,
    requiredCommitArguments: {
      confirmOrganization: ORGANIZATION_CONFIRMATION,
      confirmPlanSha256: digest,
      expectedMoves: plan.moves.length,
    },
    moves: plan.moves,
    budgetChanges: plan.budgetChanges,
    holds: plan.holds,
    unverifiableLegacyOrderIds: plan.unverifiableLegacyOrderIds,
  }
}

async function applyPlan(client: PoolClient, plan: OrderBranchRepairPlan): Promise<CommitReport["budgetChanges"]> {
  for (const move of plan.moves) {
    const updated = await rows(client, `
      update orders
         set branch_id = $1,
             created_by_user_id = $2::uuid,
             receipt_data = case when receipt_data is null then null else
               jsonb_set(jsonb_set(receipt_data, '{buyerName}', to_jsonb($3::text), true),
                         '{buyerAddress}', to_jsonb($4::text), true) end,
             updated_at = now()
       where id = $5 and organization_id = $6 and tid = $7
         and branch_id = $8 and created_by_user_id is not distinct from $9::uuid
      returning id
    `, [move.to.branchId, move.creator.to, move.to.branchName, move.to.branchAddress ?? "",
      move.orderId, ORGANIZATION.id, move.tid, move.from.branchId, move.creator.from])
    assert(updated.length === 1, `Concurrent change detected for order ${move.orderId} (${move.tid})`)
  }

  const committed: CommitReport["budgetChanges"] = []
  for (const change of plan.budgetChanges) {
    if (change.operation === "UPDATE") {
      const updated = await rows(client, `
        update budgets
           set amount_allocated_cents = $1, amount_spent_cents = $2, amount_held_cents = $3, updated_at = now()
         where id = $4 and organization_id = $5 and branch_id = $6 and period = $7
           and amount_allocated_cents = $8 and amount_spent_cents = $9
           and amount_held_cents = $10 and amount_credited_cents = $11
        returning id
      `, [change.target.allocated, change.target.spent, change.target.held,
        change.budgetId, ORGANIZATION.id, change.branchId, change.period,
        change.previous.allocated, change.previous.spent, change.previous.held, change.previous.credited])
      assert(updated.length === 1, `Concurrent change detected for budget ${change.branchId}/${change.period}`)
      committed.push({ ...change, committedBudgetId: Number(updated[0].id) })
    } else {
      const inserted = await rows(client, `
        insert into budgets (organization_id, branch_id, period, amount_allocated_cents,
                             amount_spent_cents, amount_held_cents, amount_credited_cents)
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id
      `, [ORGANIZATION.id, change.branchId, change.period, change.target.allocated,
        change.target.spent, change.target.held, change.target.credited])
      assert(inserted.length === 1, `Failed to insert budget ${change.branchId}/${change.period}`)
      committed.push({ ...change, committedBudgetId: Number(inserted[0].id) })
    }
  }
  return committed
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
      arg("output") ?? `deliverables/ke-order-branch-repair-${new Date().toISOString().slice(0, 10)}.json`)

    const state = await readState(client)
    const plan = planOrderBranchRepair(state)
    const digest = planDigest(plan)
    const report = buildReport(plan, digest)

    if (!flag("commit")) {
      saveJson(output, report)
      console.log(JSON.stringify({
        mode: "DRY_RUN", output, planSha256: digest, summary: report.summary,
        moves: plan.moves.map((move) => ({
          tid: move.tid, from: move.from.branchName, to: move.to.branchName,
          period: move.period, consumption: move.consumption, creator: move.creator.rule,
        })),
        budgetChanges: plan.budgetChanges.map((change) => ({
          [`${change.branchName} ${change.period}`]: `${change.operation} `
            + `allocated ${change.previous.allocated}→${change.target.allocated}, `
            + `spent ${change.previous.spent}→${change.target.spent}, `
            + `held ${change.previous.held}→${change.target.held}`,
        })),
      }, null, 2))
      if (plan.moves.length === 0) {
        console.log("\nNothing to move: every imported order sits at the branch legacy names.")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npx tsx scripts/repair-ke-order-branches.ts --commit \\
    --confirm-organization=${ORGANIZATION_CONFIRMATION} \\
    --confirm-plan-sha256=${digest} \\
    --expected-moves=${plan.moves.length} \\
    --operator=<you@example.com>`)
      }
      if (plan.holds.length > 0) {
        console.log(`\n${plan.holds.length} order(s) held for review — see "holds" in ${output}.`)
      }
      if (plan.unverifiableLegacyOrderIds.length > 0) {
        console.log(`\n${plan.unverifiableLegacyOrderIds.length} import(s) record no legacy location and were not checked`
          + ` — see "unverifiableLegacyOrderIds" in ${output}.`)
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
    const prechangePath = output.replace(/\.json$/, "") + `-prechange.json`
    saveJson(prechangePath, {
      generatedAt: new Date().toISOString(), organization: ORGANIZATION, planSha256: digest,
      fingerprints: before,
      orders: state.orders.filter((order) => plan.moves.some((move) => move.orderId === order.orderId)),
      budgets: state.budgets.filter((budget) =>
        plan.budgetChanges.some((change) => change.budgetId === budget.id)),
    })
    const prechangeSha256 = sha256(readFileSync(prechangePath, "utf8"))

    let auditLogId = 0
    let committedBudgets: CommitReport["budgetChanges"] = []
    await client.query("begin")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
      await client.query(
        `select id from orders where organization_id = $1 order by id for update`, [ORGANIZATION.id])
      await client.query(
        `select id from budgets where organization_id = $1 order by id for update`, [ORGANIZATION.id])

      // Rebuild from rows read under the lock. Anything that moved since the
      // preflight changes the digest and nothing is written.
      const lockedPlan = planOrderBranchRepair(await readState(client))
      assert(planDigest(lockedPlan) === digest,
        "K-Electric orders or budgets changed after the preflight; aborting")

      committedBudgets = await applyPlan(client, lockedPlan)

      const audit = await rows(client, `
        insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
        values (null, $1, null, 'KE_ORDER_BRANCH_REPAIR', 'orders', $2, $3::jsonb)
        returning id
      `, [ORGANIZATION.id, digest.slice(0, 128), JSON.stringify({
        planSha256: digest, operator, prechangePath, prechangeSha256,
        summary: summarizeOrderBranchRepair(lockedPlan),
        moves: lockedPlan.moves.map((move) => ({
          orderId: move.orderId, tid: move.tid, legacyOrderId: move.legacyOrderId,
          fromBranchId: move.from.branchId, toBranchId: move.to.branchId,
          creatorFrom: move.creator.from, creatorTo: move.creator.to, creatorRule: move.creator.rule,
        })),
      })])
      auditLogId = Number(audit[0]?.id)
      assert(Number.isSafeInteger(auditLogId), "Failed to write the repair audit row")

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

    const rollbackConfirmation = `ROLLBACK:${auditLogId}:KE-ORDER-BRANCH-REPAIR`
    saveJson(output, {
      ...report,
      mode: "COMMITTED",
      committedAt: new Date().toISOString(),
      operator,
      auditLogId,
      budgetChanges: committedBudgets,
      prechange: { path: prechangePath, sha256: prechangeSha256 },
      protectedFingerprints: { before, after },
      rollbackConfirmation,
    })

    // Already committed — a cache that will not clear is reported, not thrown.
    const cache = await invalidateCachePrefixes(["orders", "budgets", "analytics", "dashboard", "branches"])

    console.log(JSON.stringify({
      mode: "COMMITTED", output, auditLogId, planSha256: digest,
      moved: plan.moves.length, budgetRows: committedBudgets.length, held: plan.holds.length,
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
  assert(report.kind === "KE_ORDER_BRANCH_REPAIR" && report.mode === "COMMITTED",
    "Not a committed order-branch-repair report")
  assert(report.organization?.id === ORGANIZATION.id && report.organization.code === ORGANIZATION.code,
    "Commit report tenant mismatch")
  assert(arg("confirm-organization") === ORGANIZATION_CONFIRMATION,
    `--confirm-organization must equal ${ORGANIZATION_CONFIRMATION}`)
  const expected = `ROLLBACK:${report.auditLogId}:KE-ORDER-BRANCH-REPAIR`
  assert(arg("confirm-rollback") === expected, `--confirm-rollback must equal ${expected}`)
  await assertTenant(client)

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    for (const move of report.moves) {
      const restored = await rows(client, `
        update orders
           set branch_id = $1,
               created_by_user_id = $2::uuid,
               receipt_data = case when receipt_data is null then null else
                 jsonb_set(jsonb_set(receipt_data, '{buyerName}', to_jsonb($3::text), true),
                           '{buyerAddress}', to_jsonb($4::text), true) end,
               updated_at = now()
         where id = $5 and organization_id = $6 and tid = $7
           and branch_id = $8 and created_by_user_id = $9
        returning id
      `, [move.from.branchId, move.creator.from, move.from.branchName,
        (await rows(client, `select address from branches where id = $1 and organization_id = $2`,
          [move.from.branchId, ORGANIZATION.id]))[0]?.address ?? "",
        move.orderId, ORGANIZATION.id, move.tid, move.to.branchId, move.creator.to])
      assert(restored.length === 1, `Order ${move.orderId} changed after the repair; rollback refused`)
    }
    for (const change of report.budgetChanges) {
      if (change.operation === "UPDATE") {
        const restored = await rows(client, `
          update budgets
             set amount_allocated_cents = $1, amount_spent_cents = $2, amount_held_cents = $3, updated_at = now()
           where id = $4 and organization_id = $5 and branch_id = $6 and period = $7
             and amount_allocated_cents = $8 and amount_spent_cents = $9
             and amount_held_cents = $10 and amount_credited_cents = $11
          returning id
        `, [change.previous.allocated, change.previous.spent, change.previous.held,
          change.committedBudgetId, ORGANIZATION.id, change.branchId, change.period,
          change.target.allocated, change.target.spent, change.target.held, change.target.credited])
        assert(restored.length === 1,
          `Budget ${change.branchId}/${change.period} changed after the repair; rollback refused`)
      } else {
        const deleted = await rows(client, `
          delete from budgets
           where id = $1 and organization_id = $2 and branch_id = $3 and period = $4
             and amount_allocated_cents = $5 and amount_spent_cents = $6
             and amount_held_cents = $7 and amount_credited_cents = $8
             and not exists (select 1 from budget_addons where budget_id = budgets.id)
          returning id
        `, [change.committedBudgetId, ORGANIZATION.id, change.branchId, change.period,
          change.target.allocated, change.target.spent, change.target.held, change.target.credited])
        assert(deleted.length === 1,
          `Inserted budget ${change.branchId}/${change.period} changed after the repair; rollback refused`)
      }
    }
    await client.query(`
      insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
      values (null, $1, null, 'KE_ORDER_BRANCH_REPAIR_ROLLBACK', 'orders', $2, $3::jsonb)
    `, [ORGANIZATION.id, String(report.auditLogId), JSON.stringify({
      revertedOrders: report.moves.length, revertedBudgets: report.budgetChanges.length,
      planSha256: report.planSha256,
    })])
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }
  const cache = await invalidateCachePrefixes(["orders", "budgets", "analytics", "dashboard", "branches"])
  console.log(JSON.stringify({
    mode: "ROLLED_BACK", reverted: report.moves.length, budgetRows: report.budgetChanges.length,
    cacheInvalidation: cache,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
