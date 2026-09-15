#!/usr/bin/env tsx
/**
 * Reverse a committed `sync:ke --budgets=zero` run from its own report.
 *
 *   npm run restore:ke-zeroed-budgets                       # dry run, default report
 *   npm run restore:ke-zeroed-budgets -- --report=<path>    # dry run, another report
 *   npm run restore:ke-zeroed-budgets -- --rollback-test    # apply inside a transaction, roll back
 *   npm run restore:ke-zeroed-budgets -- --commit \
 *     --actor-user-id=<active-super-admin-uuid> \
 *     --confirm-organization=<id:code:name> \
 *     --confirm-plan=<digest printed by the dry run>
 *
 * What it puts back, from the before-values the zero run recorded:
 *
 *   budgets.amount_allocated_cents   for the zeroed period, on every row that
 *                                    still holds the value the zero run wrote
 *   branches.baseline_budget_cents   on every branch whose baseline is still 0,
 *                                    which is what makes the monthly allocation
 *                                    repeat on the first of the next month again
 *
 * The rows the zero run created at 0 are left alone; see the header of
 * `lib/legacy-import/ke-budget-restore.ts` for that and the other rules.
 *
 * Every statement is scoped to the report's organization, checked against the
 * database by id, code and name before anything is read. Every write is pinned
 * to the value the plan saw and must touch exactly one row, so a figure a Head
 * Office user changed since the zero run is reported, never overwritten. The
 * run is recorded in `legacy_import_batches`, and the JSON report it writes
 * holds the values it replaced.
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import * as dotenv from "dotenv"

import { invalidateCachePrefixes } from "../lib/cache-cli"
import {
  parseZeroRunReport,
  planBudgetRestore,
  restorePlanLines,
  summarizeRestore,
  type RestoreBranch,
  type RestorePlan,
  type ZeroRunReport,
} from "../lib/legacy-import/ke-budget-restore"
import type { CurrentBudget } from "../lib/legacy-import/ke-budgets"
import { KE_SYNC_SOURCE as SOURCE_SYSTEM } from "../lib/legacy-import/ke-sync"
import { resolveWorkspacePath } from "./lib/resolve-workspace-path"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const DEFAULT_REPORT = "updatedReports/ke-sync-zero-commit.json"

type Row = Record<string, unknown>

interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>
}

interface Options {
  commit: boolean
  rollbackTest: boolean
  actorUserId?: string
  confirmOrganization?: string
  confirmPlan?: string
  reportPath: string
  outputPath: string
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function parseOptions(): Options {
  return {
    commit: flag("commit"),
    rollbackTest: flag("rollback-test"),
    actorUserId: argument("actor-user-id"),
    confirmOrganization: argument("confirm-organization"),
    confirmPlan: argument("confirm-plan"),
    reportPath: resolveWorkspacePath(argument("report") ?? DEFAULT_REPORT),
    outputPath: resolveWorkspacePath(
      argument("output") ?? `updatedReports/ke-budget-restore-${new Date().toISOString().slice(0, 10)}.json`,
    ),
  }
}

async function rows<T extends Row = Row>(client: QueryClient, text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function planDigest(plan: RestorePlan): string {
  return sha256(restorePlanLines(plan).join("\n"))
}

function organizationConfirmation(org: ZeroRunReport["organization"]): string {
  return `${org.id}:${org.code}:${org.name}`
}

function money(cents: number): string {
  return `PKR ${(cents / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** The report the zero run wrote, validated at the boundary. */
function loadReport(path: string): { report: ZeroRunReport; sha256: string } {
  const buffer = readFileSync(path)
  return { report: parseZeroRunReport(JSON.parse(buffer.toString("utf8"))), sha256: sha256(buffer) }
}

/** The organization exactly as the report names it, or nothing. */
async function assertOrganization(client: QueryClient, expected: ZeroRunReport["organization"]): Promise<void> {
  const [organization] = await rows(client,
    `select id, code, name from organizations where id = $1`, [expected.id])
  assert(organization, `organization ${expected.id} does not exist in this database`)
  assert(
    String(organization.code) === expected.code && String(organization.name) === expected.name,
    `organization ${expected.id} is ${String(organization.code)}:${String(organization.name)}, `
      + `not ${expected.code}:${expected.name} as the report says; refusing`,
  )
}

/** Every budget row of the organization for the zeroed period. */
async function readBudgets(client: QueryClient, organizationId: number, period: string): Promise<CurrentBudget[]> {
  return (await rows(client,
    `select branch_id, period, amount_allocated_cents, amount_credited_cents,
            amount_spent_cents, amount_held_cents
       from budgets where organization_id = $1 and period = $2`, [organizationId, period]))
    .map((row): CurrentBudget => ({
      branchId: Number(row.branch_id),
      period: String(row.period),
      amountAllocatedCents: Number(row.amount_allocated_cents ?? 0),
      amountCreditedCents: Number(row.amount_credited_cents ?? 0),
      amountSpentCents: Number(row.amount_spent_cents ?? 0),
      amountHeldCents: Number(row.amount_held_cents ?? 0),
    }))
}

/** Every branch of the organization, whatever its status. */
async function readBranches(client: QueryClient, organizationId: number): Promise<RestoreBranch[]> {
  return (await rows(client,
    `select id, name, status, baseline_budget_cents from branches
      where organization_id = $1 order by id`, [organizationId]))
    .map((row): RestoreBranch => ({
      branchId: Number(row.id),
      name: String(row.name),
      status: String(row.status),
      baselineBudgetCents: Number(row.baseline_budget_cents ?? 0),
    }))
}

async function buildPlan(client: QueryClient, report: ZeroRunReport): Promise<RestorePlan> {
  return planBudgetRestore(
    report,
    await readBudgets(client, report.organization.id, report.options.zeroPeriod),
    await readBranches(client, report.organization.id),
  )
}

/**
 * Proof that nothing outside the target moved: every other tenant's budgets
 * and baselines, and the target's own budget rows for every other period.
 */
async function fingerprints(client: QueryClient, organizationId: number, period: string): Promise<Row> {
  const [row] = await rows(client, `
    select
      (select count(*) from budgets where organization_id <> $1)::bigint                                  as other_budget_rows,
      (select coalesce(sum(amount_allocated_cents), 0) from budgets where organization_id <> $1)::bigint   as other_budget_allocated,
      (select count(*) from branches where organization_id <> $1)::bigint                                  as other_branch_rows,
      (select coalesce(sum(baseline_budget_cents), 0) from branches where organization_id <> $1)::bigint   as other_branch_baseline,
      (select count(*) from budgets where organization_id = $1 and period <> $2)::bigint                   as own_other_period_rows,
      (select coalesce(sum(amount_allocated_cents), 0) from budgets where organization_id = $1 and period <> $2)::bigint
                                                                                                           as own_other_period_allocated,
      (select coalesce(sum(amount_spent_cents + amount_held_cents + amount_credited_cents), 0)
         from budgets where organization_id = $1 and period = $2)::bigint                                  as own_period_activity
  `, [organizationId, period])
  return row
}

function printPlan(report: ZeroRunReport, plan: RestorePlan, reportPath: string): void {
  const counts = summarizeRestore(plan)
  console.log(`Report ............... ${reportPath}`)
  console.log(`  written ............ ${report.generatedAt}`)
  console.log(`  organization ....... ${organizationConfirmation(report.organization)}`)
  console.log(`  period zeroed ...... ${report.options.zeroPeriod}`)
  console.log(`  recorded ........... ${report.budgets.lowers.length} lowered, ${report.budgets.baselineResets.length} baselines cleared, ${report.budgets.creates.length} created at 0`)
  console.log("")
  console.log("RESTORE")
  console.log(`  allocations ........ ${counts.allocationsToRestore} row(s) back to their before-value, ${money(counts.totalRestoredCents)} in total`)
  console.log(`  baselines .......... ${counts.baselinesToRestore} branch(es) back to their before-value, so the month repeats again`)
  if (counts.refundOnNextLoad > 0) {
    console.log(`    of which ......... ${counts.refundOnNextLoad} sit on a 0 row with no activity; the budgets page will fund those to the baseline on its next load`)
  }
  console.log(`  already restored ... ${counts.unchangedAllocations} allocation(s), ${counts.unchangedBaselines} baseline(s)`)
  console.log(`  created at 0 ....... ${counts.createdAtZeroLeftAlone} row(s) left alone (no baseline before; a 0 row is what the shop creates on demand)`)
  console.log(`  skipped ............ ${counts.skipped}`)

  for (const entry of plan.allocationRestores) {
    console.log(`    ALLOC     ${entry.branchName} (${entry.branchId}) ${entry.period}: ${money(entry.currentCents)} -> ${money(entry.amountAllocatedCents)}`)
  }
  for (const entry of plan.baselineRestores) {
    const note = entry.refundsOnNextLoad ? "  [month row re-funded on next page load]" : ""
    console.log(`    BASELINE  ${entry.branchName} (${entry.branchId}): 0 -> ${money(entry.baselineBudgetCents)}${note}`)
  }
  for (const entry of plan.skipped) {
    console.log(`    SKIP      ${entry.kind} ${entry.branchName} (${entry.branchId}) ${entry.reason}: ${entry.detail}`)
  }
}

function writeReport(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
}

/** Apply the plan. Every write is pinned to what the plan saw and must hit one row. */
async function apply(
  client: QueryClient,
  organizationId: number,
  plan: RestorePlan,
): Promise<{ allocationsRestored: number; baselinesRestored: number }> {
  const counts = { allocationsRestored: 0, baselinesRestored: 0 }
  for (const entry of plan.allocationRestores) {
    const result = await client.query(
      `update budgets set amount_allocated_cents = $1, updated_at = now()
        where organization_id = $2 and branch_id = $3 and period = $4 and amount_allocated_cents = $5`,
      [entry.amountAllocatedCents, organizationId, entry.branchId, entry.period, entry.currentCents])
    assert(result.rowCount === 1,
      `budget ${entry.branchName} ${entry.period} moved since the plan was built; re-run the dry run`)
    counts.allocationsRestored += 1
  }
  for (const entry of plan.baselineRestores) {
    const result = await client.query(
      `update branches set baseline_budget_cents = $1, updated_at = now()
        where organization_id = $2 and id = $3 and baseline_budget_cents = 0`,
      [entry.baselineBudgetCents, organizationId, entry.branchId])
    assert(result.rowCount === 1,
      `baseline of branch ${entry.branchName} moved since the plan was built; re-run the dry run`)
    counts.baselinesRestored += 1
  }
  return counts
}

async function main(): Promise<void> {
  const options = parseOptions()
  const { report, sha256: reportSha256 } = loadReport(options.reportPath)
  const { pool } = await import("../lib/db-cli")

  try {
    await assertOrganization(pool, report.organization)
    const plan = await buildPlan(pool, report)
    const digest = planDigest(plan)
    const counts = summarizeRestore(plan)
    const nothingToDo = plan.allocationRestores.length + plan.baselineRestores.length === 0

    printPlan(report, plan, options.reportPath)
    console.log(`\nPlan digest: ${digest}`)

    const payload: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      mode: options.commit ? "COMMIT" : options.rollbackTest ? "ROLLBACK_TEST" : "DRY_RUN",
      organization: report.organization,
      source: { report: options.reportPath, sha256: reportSha256, planDigest: report.planDigest, generatedAt: report.generatedAt },
      period: plan.period,
      planDigest: digest,
      counts,
      plan,
    }
    writeReport(options.outputPath, payload)
    console.log(`Report written to ${options.outputPath}`)

    if (!options.commit && !options.rollbackTest) {
      if (nothingToDo) {
        console.log("\nNothing to restore: every row the zero run touched is already back, or has been changed since (see SKIP lines).")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npm run restore:ke-zeroed-budgets -- --commit \\\n    --actor-user-id=<active-super-admin-uuid> \\\n    --confirm-organization=${organizationConfirmation(report.organization)} \\\n    --confirm-plan=${digest}`)
      }
      return
    }

    assert(!nothingToDo, "Nothing to restore")
    if (options.commit) {
      assert(options.actorUserId, "Commit requires --actor-user-id=<active-super-admin-uuid>")
      assert(options.confirmOrganization === organizationConfirmation(report.organization),
        `Commit requires --confirm-organization=${organizationConfirmation(report.organization)}`)
      assert(options.confirmPlan === digest, `Commit requires --confirm-plan=${digest}`)
      const [actor] = await rows(pool,
        `select u.id from users u join roles r on r.id = u.role_id
          where u.id = $1 and r.name = 'SUPER_ADMIN' and u.is_active = true and u.deleted_at is null`,
        [options.actorUserId])
      assert(actor, "--actor-user-id must be an active SUPER_ADMIN")
    }

    const before = await fingerprints(pool, report.organization.id, plan.period)
    const client = await pool.connect()
    try {
      await client.query("begin")
      // The same lock the sync takes, so the two can never interleave.
      await client.query(`select pg_advisory_xact_lock(hashtext('oneflowe:ke-sync'))`)

      // Rebuilt under the lock from rows read there. Anything that moved
      // between the dry run and now changes the digest, and nothing is written.
      const lockedPlan = await buildPlan(client, report)
      assert(planDigest(lockedPlan) === digest, "Plan changed between confirmation and commit; re-run the dry run")

      let batchId: string | null = null
      if (options.commit) {
        const [batch] = await rows(client,
          `insert into legacy_import_batches
             (organization_id, source_system, source_manifest, status, imported_by_user_id)
           values ($1, $2, $3::jsonb, 'RUNNING', $4)
           returning id`,
          [
            report.organization.id,
            SOURCE_SYSTEM,
            JSON.stringify({
              importer: "restore-ke-zeroed-budgets",
              planDigest: digest,
              period: plan.period,
              reverses: { report: options.reportPath, sha256: reportSha256, planDigest: report.planDigest, generatedAt: report.generatedAt },
              generatedAt: new Date().toISOString(),
            }),
            options.actorUserId,
          ])
        batchId = String(batch.id)
      }

      const applied = await apply(client, report.organization.id, lockedPlan)

      if (batchId) {
        await client.query(
          `update legacy_import_batches set status = 'COMPLETED', counts = $1::jsonb, completed_at = now() where id = $2`,
          [JSON.stringify(applied), batchId])
      }

      if (options.rollbackTest) {
        await client.query("rollback")
        console.log(`\nRollback test: applied and rolled back. Counts: ${JSON.stringify(applied)}`)
        return
      }

      await client.query("commit")
      console.log(`\nCommitted batch ${batchId}. Counts: ${JSON.stringify(applied)}`)
    } catch (error) {
      await client.query("rollback").catch(() => {})
      throw error
    } finally {
      client.release()
    }

    // Committed. Prove nothing else moved and nothing remains, then clear the
    // caches the budgets page reads through — a cache that will not clear is
    // reported, not thrown, because the write already happened.
    const after = await fingerprints(pool, report.organization.id, plan.period)
    assert(JSON.stringify(after) === JSON.stringify(before),
      `Fingerprints changed outside the plan; investigate immediately:\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`)
    const remaining = await buildPlan(pool, report)
    assert(remaining.allocationRestores.length + remaining.baselineRestores.length === 0,
      `${remaining.allocationRestores.length + remaining.baselineRestores.length} restore(s) still pending after commit; investigate immediately`)
    console.log(`Verified: other tenants and other periods untouched; a further run plans nothing.`)

    writeReport(options.outputPath, { ...payload, committedAt: new Date().toISOString(), applied: summarizeRestore(plan) })
    for (const entry of await invalidateCachePrefixes(["budgets", "analytics", "branches"])) {
      if (entry.error) console.warn(`WARNING: cache prefix "${entry.prefix}" was not cleared: ${entry.error}`)
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
