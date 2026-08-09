#!/usr/bin/env tsx
/**
 * Raises K-Electric monthly allocations to consumption when order-scoped
 * remaining budget is negative. Default mode is a read-only dry run.
 */

import { createHash } from "crypto"
import { mkdirSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import * as dotenv from "dotenv"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const KE = { id: 10, code: "0001", name: "K-Electric" } as const
const CONFIRM_ORGANIZATION = `${KE.id}:${KE.code}:${KE.name}`

interface NegativeRow {
  budgetId: number
  branchId: number
  branchCode: string | null
  branchName: string
  period: string
  amountAllocatedCents: string | number
  amountCreditedCents: string | number
  consumptionSpentCents: string | number
  consumptionHeldCents: string | number
  remainingCents: string | number
}

interface PlanRow {
  budgetId: number
  branchId: number
  branchCode: string | null
  branchName: string
  period: string
  oldAllocatedCents: number
  creditedCents: number
  spentCents: number
  heldCents: number
  consumptionCents: number
  oldRemainingCents: number
  newAllocatedCents: number
  newTotalBudgetCents: number
  newRemainingCents: number
  increaseCents: number
}

const NEGATIVE_QUERY = `
  with consumption as (
    select
      o.branch_id,
      to_char(o.created_at, 'YYYY-MM') as period,
      coalesce(sum(case
        when upper(o.status) in ('FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED')
          then greatest(0, o.total_cents - coalesce(o.refund_amount_cents, 0))
        else 0
      end), 0)::bigint as spent_cents,
      coalesce(sum(case
        when upper(o.status) in ('PENDING', 'APPROVED')
          then greatest(0, o.total_cents - coalesce(o.refund_amount_cents, 0))
        else 0
      end), 0)::bigint as held_cents
    from orders o
    where o.organization_id = $1
    group by o.branch_id, to_char(o.created_at, 'YYYY-MM')
  )
  select
    bg.id as "budgetId",
    bg.branch_id as "branchId",
    br.code as "branchCode",
    br.name as "branchName",
    bg.period,
    bg.amount_allocated_cents as "amountAllocatedCents",
    bg.amount_credited_cents as "amountCreditedCents",
    coalesce(c.spent_cents, 0) as "consumptionSpentCents",
    coalesce(c.held_cents, 0) as "consumptionHeldCents",
    (bg.amount_allocated_cents + bg.amount_credited_cents - coalesce(c.spent_cents, 0) - coalesce(c.held_cents, 0)) as "remainingCents"
  from budgets bg
  join branches br
    on br.id = bg.branch_id
   and br.organization_id = bg.organization_id
  left join consumption c
    on c.branch_id = bg.branch_id
   and c.period = bg.period
  where bg.organization_id = $1
    and (bg.amount_allocated_cents + bg.amount_credited_cents) < (coalesce(c.spent_cents, 0) + coalesce(c.held_cents, 0))
  order by bg.period, br.name, bg.id
`

const MISSING_BUDGET_QUERY = `
  with consumption as (
    select
      o.branch_id,
      to_char(o.created_at, 'YYYY-MM') as period,
      coalesce(sum(case
        when upper(o.status) in ('FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED')
          then greatest(0, o.total_cents - coalesce(o.refund_amount_cents, 0))
        when upper(o.status) in ('PENDING', 'APPROVED')
          then greatest(0, o.total_cents - coalesce(o.refund_amount_cents, 0))
        else 0
      end), 0)::bigint as consumption_cents
    from orders o
    where o.organization_id = $1
    group by o.branch_id, to_char(o.created_at, 'YYYY-MM')
  )
  select c.branch_id as "branchId", br.name as "branchName", c.period, c.consumption_cents as "consumptionCents"
  from consumption c
  join branches br on br.id = c.branch_id and br.organization_id = $1
  left join budgets bg on bg.branch_id = c.branch_id and bg.organization_id = $1 and bg.period = c.period
  where c.consumption_cents > 0 and bg.id is null
  order by c.period, br.name
`

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function currentKarachiPeriod(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date())
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`
}

function buildPlan(rows: NegativeRow[]): PlanRow[] {
  return rows.map((row) => {
    const oldAllocatedCents = Number(row.amountAllocatedCents)
    const creditedCents = Number(row.amountCreditedCents)
    const spentCents = Number(row.consumptionSpentCents)
    const heldCents = Number(row.consumptionHeldCents)
    const consumptionCents = spentCents + heldCents
    const newAllocatedCents = Math.max(0, consumptionCents - creditedCents)
    const newTotalBudgetCents = newAllocatedCents + creditedCents
    const newRemainingCents = newTotalBudgetCents - consumptionCents
    const values = [oldAllocatedCents, creditedCents, spentCents, heldCents, consumptionCents, newAllocatedCents]
    assert(values.every(Number.isSafeInteger), `Unsafe monetary value for budget ${row.budgetId}`)
    assert(newRemainingCents === 0, `Repair does not produce zero remaining for budget ${row.budgetId}`)
    return {
      budgetId: row.budgetId,
      branchId: row.branchId,
      branchCode: row.branchCode,
      branchName: row.branchName,
      period: row.period,
      oldAllocatedCents,
      creditedCents,
      spentCents,
      heldCents,
      consumptionCents,
      oldRemainingCents: Number(row.remainingCents),
      newAllocatedCents,
      newTotalBudgetCents,
      newRemainingCents,
      increaseCents: newAllocatedCents - oldAllocatedCents,
    }
  })
}

function planDigest(rows: PlanRow[]): string {
  return sha256(rows.map((row) => [
    row.budgetId,
    row.branchId,
    row.period,
    row.oldAllocatedCents,
    row.creditedCents,
    row.spentCents,
    row.heldCents,
    row.newAllocatedCents,
  ].join(":")).join("\n"))
}

function reportPath(commit: boolean): string {
  const requested = arg("--output")
  if (requested) return resolve(requested)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return resolve(commit
    ? `backups/ke-negative-budget-repair-commit-${stamp}.json`
    : "deliverables/ke-negative-budget-repair-preflight.json")
}

function saveReport(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function main() {
  const commit = process.argv.includes("--commit")
  const output = reportPath(commit)
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    const [organizationResult, negativeResult, missingResult, timezoneResult] = await Promise.all([
      client.query("select id, code, name from organizations where id = $1", [KE.id]),
      client.query<NegativeRow>(NEGATIVE_QUERY, [KE.id]),
      client.query(MISSING_BUDGET_QUERY, [KE.id]),
      client.query("show timezone"),
    ])
    const organization = organizationResult.rows[0]
    assert(organization && organization.id === KE.id && organization.code === KE.code && organization.name === KE.name, "K-Electric organization identity mismatch")
    assert(missingResult.rows.length === 0, `Consumption exists without a budget row for ${missingResult.rows.length} branch/months`)

    const plan = buildPlan(negativeResult.rows)
    const digest = planDigest(plan)
    const currentPeriod = currentKarachiPeriod()
    const summary = {
      organizationId: KE.id,
      negativeBranchMonths: plan.length,
      affectedBranches: new Set(plan.map((row) => row.branchId)).size,
      minPeriod: plan[0]?.period ?? null,
      maxPeriod: plan.at(-1)?.period ?? null,
      currentPeriodAdjustments: plan.filter((row) => row.period === currentPeriod).length,
      totalAllocationIncreaseCents: plan.reduce((total, row) => total + row.increaseCents, 0),
      missingBudgetRows: missingResult.rows.length,
    }
    const baseReport: Record<string, unknown> = {
      kind: "KE_NEGATIVE_BUDGET_REPAIR",
      mode: commit ? "COMMIT_REQUESTED" : "DRY_RUN",
      generatedAt: new Date().toISOString(),
      organization,
      databaseTimezone: timezoneResult.rows[0]?.TimeZone ?? timezoneResult.rows[0]?.timezone,
      consumptionPolicy: {
        periodExpression: "to_char(orders.created_at, 'YYYY-MM')",
        spentStatuses: ["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"],
        heldStatuses: ["PENDING", "APPROVED"],
        perOrderConsumption: "greatest(0, total_cents - refund_amount_cents)",
        refundedStatus: "excluded, matching the application budget report",
      },
      repairPolicy: {
        scope: "organization 10 and its branches only",
        condition: "allocated + credited < order-scoped spent + held",
        update: "amountAllocatedCents = consumption - credited; preserve credited/spent/held ledger fields",
        result: "order-scoped remaining equals zero",
        currentMonthBaseline: "updated only when a repaired row is in the current month",
      },
      summary,
      planSha256: digest,
      requiredCommitArguments: {
        confirmOrganization: CONFIRM_ORGANIZATION,
        confirmPlanSha256: digest,
        expectedAdjustments: plan.length,
      },
      missingBudgetRows: missingResult.rows,
      adjustments: plan,
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

    assert(arg("--confirm-organization") === CONFIRM_ORGANIZATION, `--confirm-organization must equal ${CONFIRM_ORGANIZATION}`)
    assert(arg("--confirm-plan-sha256") === digest, "--confirm-plan-sha256 does not match")
    const expectedAdjustments = Number(arg("--expected-adjustments"))
    assert(Number.isSafeInteger(expectedAdjustments) && expectedAdjustments === plan.length, `--expected-adjustments must equal ${plan.length}`)

    await client.query("begin")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [700010])
      const lockedOrganization = await client.query("select id, code, name from organizations where id = $1 for share", [KE.id])
      assert(lockedOrganization.rows[0]?.code === KE.code && lockedOrganization.rows[0]?.name === KE.name, "Locked organization identity mismatch")
      const lockedRows = (await client.query<NegativeRow>(NEGATIVE_QUERY, [KE.id])).rows
      const lockedPlan = buildPlan(lockedRows)
      assert(planDigest(lockedPlan) === digest, "Negative budget plan changed after preflight; aborting")

      for (const row of lockedPlan) {
        const updated = await client.query(`
          update budgets
          set amount_allocated_cents = $1, updated_at = now()
          where id = $2
            and organization_id = $3
            and branch_id = $4
            and period = $5
            and amount_allocated_cents = $6
            and amount_credited_cents = $7
          returning id
        `, [row.newAllocatedCents, row.budgetId, KE.id, row.branchId, row.period, row.oldAllocatedCents, row.creditedCents])
        assert(updated.rows.length === 1, `Concurrent change detected for budget ${row.budgetId}`)

        if (row.period === currentPeriod) {
          const baseline = await client.query(`
            update branches
            set baseline_budget_cents = $1, updated_at = now()
            where id = $2 and organization_id = $3
            returning id
          `, [row.newAllocatedCents, row.branchId, KE.id])
          assert(baseline.rows.length === 1, `Failed to update current baseline for branch ${row.branchId}`)
        }
      }

      const audit = await client.query(`
        insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
        values (null, $1, null, 'KE_NEGATIVE_BUDGET_REPAIR', 'budgets', $2, $3::jsonb)
        returning id
      `, [KE.id, digest.slice(0, 128), JSON.stringify({
        planSha256: digest,
        adjustedBudgetRows: lockedPlan.length,
        affectedBranches: new Set(lockedPlan.map((row) => row.branchId)).size,
        totalAllocationIncreaseCents: lockedPlan.reduce((total, row) => total + row.increaseCents, 0),
        currentPeriod,
      })])
      await client.query("commit")

      const remainingNegatives = await client.query<NegativeRow>(NEGATIVE_QUERY, [KE.id])
      const remainingMissing = await client.query(MISSING_BUDGET_QUERY, [KE.id])
      assert(remainingNegatives.rows.length === 0, `${remainingNegatives.rows.length} negative K-Electric branch/month budgets remain`)
      assert(remainingMissing.rows.length === 0, `${remainingMissing.rows.length} consumed branch/months remain without budgets`)

      const commitReport = {
        ...baseReport,
        mode: "COMMITTED",
        committedAt: new Date().toISOString(),
        auditLogId: audit.rows[0].id,
        validation: {
          remainingNegativeBranchMonths: remainingNegatives.rows.length,
          remainingMissingBudgetRows: remainingMissing.rows.length,
        },
      }
      saveReport(output, commitReport)
      console.log(JSON.stringify({
        mode: "COMMITTED",
        output,
        summary,
        auditLogId: audit.rows[0].id,
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
