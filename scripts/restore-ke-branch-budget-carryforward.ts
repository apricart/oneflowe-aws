#!/usr/bin/env tsx
/**
 * Restores the monthly budget of K-Electric branches that were funded historically but
 * dropped to Rs 0, and makes that figure repeat every month from now on.
 *
 * The legacy budget import wrote one `budgets` row per branch/month but propagated only
 * its final period into `branches.baseline_budget_cents`. Every month the application
 * seeds from that baseline, so branches whose legacy tenure for the import month carried
 * a zero monthly budget show Rs 0 and would keep doing so indefinitely.
 *
 * This script sets `branches.baseline_budget_cents` to each branch's last funded
 * allocation and repairs the current period's row to match. Future months then reuse the
 * same figure automatically until a Head Office or Super Admin user changes it in the
 * application through Allocate -> Monthly, which rewrites the baseline.
 *
 * Scope guarantees:
 * - only organization 10 (K-Electric) is read or written;
 * - only the current period's budget row is written, so history is never modified;
 * - branches already funded, and branches that never held a budget, are skipped;
 * - a current-period row with any allocation, spend, hold or credit is skipped.
 *
 * Default mode is a read-only preflight. Committing requires the exact organization,
 * plan checksum and row count printed by that preflight.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import {
  buildCarryForwardPlan,
  carryForwardPlanLines,
  type CarryForwardCandidate,
  type CarryForwardPlanRow,
} from "../lib/server/ke-budget-carryforward-rules"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const KE = { id: 10, code: "0001", name: "K-Electric" } as const
const CONFIRM_ORGANIZATION = `${KE.id}:${KE.code}:${KE.name}`
const ADVISORY_LOCK_KEY = 700011
const DEFAULT_SNAPSHOT = "backups/ke-budget-spend-backfill-prechange-2026-08-13T08-50-38-061Z.json"

/** Active branches joined to the current period and to their last funded period. */
const CANDIDATE_QUERY = `
  select
    b.id                                            as "branchId",
    b.code                                          as "branchCode",
    b.name                                          as "branchName",
    coalesce(b.baseline_budget_cents, 0)::bigint    as "baselineBudgetCents",
    cur.id                                          as "currentBudgetId",
    coalesce(cur.amount_allocated_cents, 0)::bigint as "currentAllocatedCents",
    coalesce(cur.amount_spent_cents, 0)::bigint     as "currentSpentCents",
    coalesce(cur.amount_held_cents, 0)::bigint      as "currentHeldCents",
    coalesce(cur.amount_credited_cents, 0)::bigint  as "currentCreditedCents",
    src.period                                      as "sourcePeriod",
    src.amount_allocated_cents::bigint              as "sourceAllocatedCents"
  from branches b
  left join budgets cur
    on cur.branch_id = b.id
   and cur.organization_id = b.organization_id
   and cur.period = $2
  left join lateral (
    select x.period, x.amount_allocated_cents
    from budgets x
    where x.branch_id = b.id
      and x.organization_id = b.organization_id
      and x.period < $2
      and x.amount_allocated_cents > 0
    order by x.period desc
    limit 1
  ) src on true
  where b.organization_id = $1
    and b.status = 'active'
  order by b.id
`

/** Proves no other tenant's budgets or baselines moved. */
const OTHER_TENANT_FINGERPRINT = `
  select
    (select count(*) from budgets where organization_id <> $1)::bigint                                 as "budgetRows",
    (select coalesce(sum(amount_allocated_cents), 0) from budgets where organization_id <> $1)::bigint  as "budgetAllocated",
    (select coalesce(sum(amount_spent_cents), 0) from budgets where organization_id <> $1)::bigint      as "budgetSpent",
    (select coalesce(sum(amount_held_cents), 0) from budgets where organization_id <> $1)::bigint       as "budgetHeld",
    (select coalesce(sum(amount_credited_cents), 0) from budgets where organization_id <> $1)::bigint   as "budgetCredited",
    (select count(*) from branches where organization_id <> $1)::bigint                                 as "branchRows",
    (select coalesce(sum(baseline_budget_cents), 0) from branches where organization_id <> $1)::bigint  as "branchBaseline"
`

/** Proves K-Electric's own budget history outside the current period is untouched. */
const KE_HISTORY_FINGERPRINT = `
  select
    count(*)::bigint                                 as "rows",
    coalesce(sum(amount_allocated_cents), 0)::bigint as "allocated",
    coalesce(sum(amount_spent_cents), 0)::bigint     as "spent",
    coalesce(sum(amount_held_cents), 0)::bigint      as "held",
    coalesce(sum(amount_credited_cents), 0)::bigint  as "credited"
  from budgets
  where organization_id = $1 and period <> $2
`

interface CandidateRow {
  branchId: number
  branchCode: string | null
  branchName: string
  baselineBudgetCents: string | number
  currentBudgetId: number | null
  currentAllocatedCents: string | number
  currentSpentCents: string | number
  currentHeldCents: string | number
  currentCreditedCents: string | number
  sourcePeriod: string | null
  sourceAllocatedCents: string | number | null
}

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function money(value: string | number | null, label: string): number {
  if (value === null) return 0
  const parsed = Number(value)
  assert(Number.isSafeInteger(parsed) && parsed >= 0, `Unsafe monetary value for ${label}: ${String(value)}`)
  return parsed
}

function karachiPeriod(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date())
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`
}

/**
 * The application derives the current period with `toISOString().slice(0, 7)` (UTC) while
 * the K-Electric imports use Asia/Karachi. Those agree except for the five hours around a
 * month boundary; refusing to run then keeps the repaired row and the row the application
 * would create identical.
 */
function resolveCurrentPeriod(): string {
  const utc = new Date().toISOString().slice(0, 7)
  const karachi = karachiPeriod()
  assert(
    utc === karachi,
    `UTC period ${utc} and Asia/Karachi period ${karachi} disagree; re-run outside the month boundary window`,
  )
  return utc
}

/** Allocation per `branchId:period` as it stood before `KE_BUDGET_SPEND_BACKFILL`. */
function loadPreBackfillSnapshot(): { path: string | null; sha256: string | null; byKey: Map<string, number> } {
  const byKey = new Map<string, number>()
  if (process.argv.includes("--allow-missing-snapshot") && !arg("--pre-backfill-snapshot")) {
    return { path: null, sha256: null, byKey }
  }
  const path = resolve(arg("--pre-backfill-snapshot") ?? DEFAULT_SNAPSHOT)
  assert(
    existsSync(path),
    `Pre-backfill snapshot not found: ${path}. Pass --pre-backfill-snapshot=<path>, or --allow-missing-snapshot to carry forward stored allocations as-is.`,
  )
  const buffer = readFileSync(path)
  const parsed = JSON.parse(buffer.toString("utf8")) as {
    kind?: string
    organization?: { id?: number }
    budgets?: Array<{ branch_id: number; period: string; amount_allocated_cents: string | number }>
  }
  assert(parsed.kind === "KE_BUDGET_SPEND_BACKFILL_PRECHANGE", `Unexpected snapshot kind: ${String(parsed.kind)}`)
  assert(parsed.organization?.id === KE.id, "Snapshot belongs to a different organization")
  assert(Array.isArray(parsed.budgets) && parsed.budgets.length > 0, "Snapshot has no budget rows")
  for (const row of parsed.budgets) {
    byKey.set(
      `${row.branch_id}:${row.period}`,
      money(row.amount_allocated_cents, `snapshot ${row.branch_id}:${row.period}`),
    )
  }
  return { path, sha256: sha256(buffer), byKey }
}

function toCandidates(rows: CandidateRow[], snapshot: Map<string, number>): CarryForwardCandidate[] {
  return rows.map((row) => {
    const sourcePeriod = row.sourcePeriod
    const sourceAllocatedCents = row.sourceAllocatedCents === null
      ? null
      : money(row.sourceAllocatedCents, `branch ${row.branchId} source allocation`)
    return {
      branchId: row.branchId,
      branchName: row.branchName,
      branchCode: row.branchCode,
      baselineBudgetCents: money(row.baselineBudgetCents, `branch ${row.branchId} baseline`),
      currentBudgetId: row.currentBudgetId,
      currentAllocatedCents: money(row.currentAllocatedCents, `branch ${row.branchId} allocated`),
      currentSpentCents: money(row.currentSpentCents, `branch ${row.branchId} spent`),
      currentHeldCents: money(row.currentHeldCents, `branch ${row.branchId} held`),
      currentCreditedCents: money(row.currentCreditedCents, `branch ${row.branchId} credited`),
      sourcePeriod,
      sourceAllocatedCents,
      preBackfillAllocatedCents: sourcePeriod === null
        ? null
        : snapshot.get(`${row.branchId}:${sourcePeriod}`) ?? null,
    }
  })
}

function planDigest(rows: CarryForwardPlanRow[]): string {
  return sha256(carryForwardPlanLines(rows).join("\n"))
}

function reportPath(commit: boolean): string {
  const requested = arg("--output")
  if (requested) return resolve(requested)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return resolve(commit
    ? `backups/ke-budget-carryforward-commit-${stamp}.json`
    : "deliverables/ke-budget-carryforward-preflight.json")
}

function saveReport(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function summarise(plan: ReturnType<typeof buildCarryForwardPlan>, period: string) {
  const skipCounts: Record<string, number> = {}
  for (const skip of plan.skipped) skipCounts[skip.reason] = (skipCounts[skip.reason] ?? 0) + 1
  return {
    period,
    branchesRestored: plan.rows.length,
    branchesSkipped: plan.skipped.length,
    skippedByReason: skipCounts,
    currentPeriodUpdates: plan.rows.filter((row) => row.operation === "update").length,
    currentPeriodInserts: plan.rows.filter((row) => row.operation === "insert").length,
    reconciliationAdjustedRows: plan.rows.filter((row) => row.reconciliationAdjusted).length,
    totalRestoredAllocationCents: plan.rows.reduce((total, row) => total + row.carryForwardCents, 0),
  }
}

interface QueryClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>
}

async function applyPlanRow(client: QueryClient, row: CarryForwardPlanRow): Promise<void> {
  // Every write re-states the expected prior values so a concurrent change aborts the run.
  const baseline = await client.query(`
    update branches
    set baseline_budget_cents = $1, updated_at = now()
    where id = $2 and organization_id = $3 and coalesce(baseline_budget_cents, 0) = $4
    returning id
  `, [row.carryForwardCents, row.branchId, KE.id, row.previousBaselineCents])
  assert(baseline.rows.length === 1, `Concurrent baseline change for branch ${row.branchId}`)

  if (row.operation === "update") {
    const updated = await client.query(`
      update budgets
      set amount_allocated_cents = $1, updated_at = now()
      where id = $2
        and organization_id = $3
        and branch_id = $4
        and period = $5
        and amount_allocated_cents = 0
        and amount_spent_cents = 0
        and amount_held_cents = 0
        and amount_credited_cents = 0
      returning id
    `, [row.carryForwardCents, row.currentBudgetId, KE.id, row.branchId, row.period])
    assert(updated.rows.length === 1, `Concurrent budget change for branch ${row.branchId} ${row.period}`)
    return
  }

  const inserted = await client.query(`
    insert into budgets (organization_id, branch_id, period, amount_allocated_cents, amount_spent_cents, amount_held_cents, amount_credited_cents)
    values ($1, $2, $3, $4, 0, 0, 0)
    on conflict (branch_id, period) do nothing
    returning id
  `, [KE.id, row.branchId, row.period, row.carryForwardCents])
  assert(inserted.rows.length === 1, `Current-period row appeared concurrently for branch ${row.branchId}`)
}

async function main() {
  const commit = process.argv.includes("--commit")
  const output = reportPath(commit)
  const period = resolveCurrentPeriod()
  const snapshot = loadPreBackfillSnapshot()
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()

  try {
    const [organizationResult, candidateResult, otherBefore, historyBefore, timezoneResult] = await Promise.all([
      client.query("select id, code, name from organizations where id = $1", [KE.id]),
      client.query<CandidateRow>(CANDIDATE_QUERY, [KE.id, period]),
      client.query(OTHER_TENANT_FINGERPRINT, [KE.id]),
      client.query(KE_HISTORY_FINGERPRINT, [KE.id, period]),
      client.query("show timezone"),
    ])
    const organization = organizationResult.rows[0]
    assert(
      organization?.id === KE.id && organization.code === KE.code && organization.name === KE.name,
      "K-Electric organization identity mismatch",
    )

    const plan = buildCarryForwardPlan(toCandidates(candidateResult.rows, snapshot.byKey), period)
    const digest = planDigest(plan.rows)
    const summary = summarise(plan, period)

    const baseReport: Record<string, unknown> = {
      kind: "KE_BUDGET_CARRYFORWARD_RESTORE",
      mode: commit ? "COMMIT_REQUESTED" : "DRY_RUN",
      generatedAt: new Date().toISOString(),
      organization,
      databaseTimezone: timezoneResult.rows[0]?.TimeZone ?? timezoneResult.rows[0]?.timezone,
      period,
      preBackfillSnapshot: { path: snapshot.path, sha256: snapshot.sha256, rows: snapshot.byKey.size },
      policy: {
        scope: "organization 10 and its active branches only",
        eligibility: "baseline_budget_cents = 0, a prior period with allocation > 0 exists, and the current period row is absent or entirely zero",
        skipped: "branches already funded, branches that never held an allocation, and any current-period row carrying allocation, spend, hold or credit",
        amount: "allocation of the most recent prior period with a positive allocation",
        reconciliationCorrection: "where the pre-change snapshot shows KE_BUDGET_SPEND_BACKFILL raised that period, the lower pre-change allocation is used instead",
        writes: "branches.baseline_budget_cents and the current period budgets row only; no historical period is modified",
        futureMonths: "the application seeds each new period from baseline_budget_cents, so the figure repeats until changed via Allocate -> Monthly",
      },
      summary,
      planSha256: digest,
      requiredCommitArguments: {
        confirmOrganization: CONFIRM_ORGANIZATION,
        confirmPlanSha256: digest,
        expectedUpdates: plan.rows.length,
      },
      fingerprintsBefore: { otherTenants: otherBefore.rows[0], keHistory: historyBefore.rows[0] },
      restored: plan.rows,
      skipped: plan.skipped,
    }

    if (!commit) {
      saveReport(output, baseReport)
      console.log(JSON.stringify({
        mode: "DRY_RUN",
        output,
        summary,
        planSha256: digest,
        requiredCommitArguments: baseReport.requiredCommitArguments,
      }, null, 2))
      return
    }

    assert(plan.rows.length > 0, "Nothing to restore")
    assert(arg("--confirm-organization") === CONFIRM_ORGANIZATION, `--confirm-organization must equal ${CONFIRM_ORGANIZATION}`)
    assert(arg("--confirm-plan-sha256") === digest, "--confirm-plan-sha256 does not match")
    const expectedUpdates = Number(arg("--expected-updates"))
    assert(
      Number.isSafeInteger(expectedUpdates) && expectedUpdates === plan.rows.length,
      `--expected-updates must equal ${plan.rows.length}`,
    )

    await client.query("begin")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY])
      const locked = await client.query("select id, code, name from organizations where id = $1 for share", [KE.id])
      assert(
        locked.rows[0]?.code === KE.code && locked.rows[0]?.name === KE.name,
        "Locked organization identity mismatch",
      )

      const lockedRows = (await client.query<CandidateRow>(CANDIDATE_QUERY, [KE.id, period])).rows
      const lockedPlan = buildCarryForwardPlan(toCandidates(lockedRows, snapshot.byKey), period)
      assert(planDigest(lockedPlan.rows) === digest, "Carry-forward plan changed after preflight; aborting")

      for (const row of lockedPlan.rows) await applyPlanRow(client, row)

      const audit = await client.query(`
        insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
        values (null, $1, null, 'KE_BUDGET_CARRYFORWARD_RESTORE', 'budgets', $2, $3::jsonb)
        returning id
      `, [KE.id, digest.slice(0, 128), JSON.stringify({
        planSha256: digest,
        period,
        branchesRestored: lockedPlan.rows.length,
        totalRestoredAllocationCents: summary.totalRestoredAllocationCents,
        reconciliationAdjustedRows: summary.reconciliationAdjustedRows,
        preBackfillSnapshotSha256: snapshot.sha256,
      })])

      await client.query("commit")

      const [otherAfter, historyAfter, remaining] = await Promise.all([
        client.query(OTHER_TENANT_FINGERPRINT, [KE.id]),
        client.query(KE_HISTORY_FINGERPRINT, [KE.id, period]),
        client.query<CandidateRow>(CANDIDATE_QUERY, [KE.id, period]),
      ])
      assert(
        JSON.stringify(otherAfter.rows[0]) === JSON.stringify(otherBefore.rows[0]),
        "Other tenants' budgets changed; investigate immediately",
      )
      assert(
        JSON.stringify(historyAfter.rows[0]) === JSON.stringify(historyBefore.rows[0]),
        "K-Electric budget history changed; investigate immediately",
      )
      const remainingPlan = buildCarryForwardPlan(toCandidates(remaining.rows, snapshot.byKey), period)
      assert(remainingPlan.rows.length === 0, `${remainingPlan.rows.length} branches still await carry-forward`)

      const commitReport = {
        ...baseReport,
        mode: "COMMITTED",
        committedAt: new Date().toISOString(),
        auditLogId: (audit.rows[0] as { id: number }).id,
        validation: {
          otherTenantFingerprintUnchanged: true,
          keHistoryFingerprintUnchanged: true,
          remainingBranchesAwaitingCarryForward: remainingPlan.rows.length,
        },
        fingerprintsAfter: { otherTenants: otherAfter.rows[0], keHistory: historyAfter.rows[0] },
      }
      saveReport(output, commitReport)
      console.log(JSON.stringify({
        mode: "COMMITTED",
        output,
        summary,
        auditLogId: commitReport.auditLogId,
        validation: commitReport.validation,
      }, null, 2))
    } catch (error) {
      await client.query("rollback")
      throw error
    }
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
