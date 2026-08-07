#!/usr/bin/env tsx
/**
 * Imports K-Electric money budgets from a credential-free legacy budget report.
 *
 * Default mode is a read-only preflight. A commit requires the exact organization,
 * source checksum, plan checksum, and insert count printed by that preflight.
 *
 * Historical policy:
 * - one budget row per database branch/month from its first local order month;
 * - branches without orders start in the current month;
 * - source rows resolve by exact case-preserving branch name first; explicitly
 *   approved aliases may still aggregate (for example 1. GSO + GSO);
 * - periods earlier than a branch's first source budget use that earliest source
 *   allocation, as explicitly requested for pre-budget order months;
 * - only allocation/additional values are imported. Legacy UsedBudget is retained
 *   in the report for review but does not mutate this application's spend ledger.
 */

import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import * as dotenv from "dotenv"
import { and, asc, eq, sql } from "drizzle-orm"
import {
  normalizeBranchExact,
  resolveKeLegacyBranch,
  toCents,
} from "../lib/legacy-import/ke-electric"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const KE_ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
const CONFIRM_ORGANIZATION = `${KE_ORGANIZATION.id}:${KE_ORGANIZATION.code}:${KE_ORGANIZATION.name}`
const SOURCE_ALIAS_RECORD: Record<string, string> = {
  "baldia ibc": "baldia",
  "johar technical": "technical",
  "lyari i": "liyari i",
}

interface SourceRow {
  Location: string
  TenureFrom: string
  TenureTo: string
  MonthlyBudget: number
  RemainingBudget: number
  UsedBudget: number
  AdditionalBudget: number
}

interface SourceFile {
  metadata?: Record<string, unknown>
  request?: Record<string, unknown>
  rows: SourceRow[]
}

interface Options {
  commit: boolean
  sourcePath: string
  outputPath: string
  confirmOrganization?: string
  confirmSourceSha256?: string
  confirmPlanSha256?: string
  expectedInserts?: number
}

interface AggregatedSource {
  targetKey: string
  period: string
  sourceNames: string[]
  sourceRowCount: number
  monthlyBudget: number
  additionalBudget: number
  usedBudget: number
  remainingBudget: number
}

interface PlannedBudget {
  organizationId: number
  branchId: number
  branchCode: string | null
  branchName: string
  period: string
  amountAllocatedCents: number
  amountCreditedCents: number
  amountSpentCents: number
  amountHeldCents: number
  sourcePeriod: string
  sourceMethod: "exact" | "backfill-earliest" | "carry-forward"
  sourceNames: string[]
  sourceRowCount: number
  sourceUsedCents: number
  sourceRemainingCents: number
}

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function parseOptions(): Options {
  const commit = process.argv.includes("--commit")
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const expected = arg("--expected-inserts")
  return {
    commit,
    sourcePath: resolve(arg("--source") ?? "deliverables/ke-electric-budget-source-history-through-2026-08-05.json"),
    outputPath: resolve(arg("--output") ?? (commit
      ? `backups/ke-budget-import-commit-${timestamp}.json`
      : "deliverables/ke-budget-import-preflight.json")),
    confirmOrganization: arg("--confirm-organization"),
    confirmSourceSha256: arg("--confirm-source-sha256"),
    confirmPlanSha256: arg("--confirm-plan-sha256"),
    expectedInserts: expected === undefined ? undefined : Number(expected),
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function currentKarachiPeriod(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date())
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  assert(year && month, "Unable to determine current Asia/Karachi month")
  return `${year}-${month}`
}

function sourcePeriod(row: SourceRow): string {
  const match = /^(\d{4}-\d{2})-\d{2}/.exec(String(row.TenureFrom))
  assert(match, `Invalid source TenureFrom: ${String(row.TenureFrom)}`)
  return match[1]
}

function periodRange(start: string, end: string): string[] {
  assert(/^\d{4}-\d{2}$/.test(start) && /^\d{4}-\d{2}$/.test(end), `Invalid period range ${start}..${end}`)
  assert(start <= end, `Period start ${start} is after ${end}`)
  const [startYear, startMonth] = start.split("-").map(Number)
  const [endYear, endMonth] = end.split("-").map(Number)
  const result: string[] = []
  for (let year = startYear, month = startMonth; year < endYear || (year === endYear && month <= endMonth);) {
    result.push(`${year}-${String(month).padStart(2, "0")}`)
    month += 1
    if (month === 13) {
      year += 1
      month = 1
    }
  }
  return result
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function stablePlanDigest(rows: PlannedBudget[], baselines: Array<{ branchId: number; amountCents: number }>): string {
  const lines = [
    ...rows.map((row) => [
      row.organizationId,
      row.branchId,
      row.period,
      row.amountAllocatedCents,
      row.amountCreditedCents,
      row.amountSpentCents,
      row.amountHeldCents,
      row.sourcePeriod,
      row.sourceMethod,
      row.sourceNames.join("|"),
    ].join(":")),
    ...baselines.map((row) => `baseline:${row.branchId}:${row.amountCents}`),
  ]
  return sha256(lines.join("\n"))
}

function chooseSource(periods: AggregatedSource[], targetPeriod: string): {
  row: AggregatedSource
  method: PlannedBudget["sourceMethod"]
} {
  const exact = periods.find((row) => row.period === targetPeriod)
  if (exact) return { row: exact, method: "exact" }
  const prior = periods.filter((row) => row.period < targetPeriod).at(-1)
  if (prior) return { row: prior, method: "carry-forward" }
  return { row: periods[0], method: "backfill-earliest" }
}

function writeReport(path: string, report: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

async function main() {
  const options = parseOptions()
  assert(existsSync(options.sourcePath), `Source file not found: ${options.sourcePath}`)
  const sourceBuffer = readFileSync(options.sourcePath)
  const sourceSha256 = sha256(sourceBuffer)
  const source = JSON.parse(sourceBuffer.toString("utf8")) as SourceFile
  assert(Array.isArray(source.rows) && source.rows.length > 0, "Source file has no rows")

  const [{ db, pool }, schema] = await Promise.all([
    import("../lib/db-cli"),
    import("../db/schema"),
  ])
  const { organizations, branches, budgets, auditLogs } = schema

  try {
    const [organization] = await db
      .select({ id: organizations.id, code: organizations.code, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, KE_ORGANIZATION.id))
    assert(organization, "K-Electric organization was not found")
    assert(
      organization.id === KE_ORGANIZATION.id && organization.code === KE_ORGANIZATION.code && organization.name === KE_ORGANIZATION.name,
      `Organization identity mismatch: ${JSON.stringify(organization)}`,
    )

    const dbBranches = await db
      .select({
        id: branches.id,
        code: branches.code,
        name: branches.name,
        status: branches.status,
        baselineBudgetCents: branches.baselineBudgetCents,
        externalSource: branches.externalSource,
        externalId: branches.externalId,
      })
      .from(branches)
      .where(eq(branches.organizationId, KE_ORGANIZATION.id))
      .orderBy(asc(branches.id))
    assert(dbBranches.length > 0, "K-Electric has no database branches")

    const sourceGroups = new Map<string, AggregatedSource>()
    const sourceOnly = new Map<string, { names: Set<string>; periods: Set<string>; rowCount: number }>()
    for (const row of source.rows) {
      const resolution = resolveKeLegacyBranch(dbBranches, { name: row.Location }, SOURCE_ALIAS_RECORD)
      const targetBranch = resolution.branch
      const targetKey = targetBranch ? String(targetBranch.id) : normalizeBranchExact(row.Location)
      const period = sourcePeriod(row)
      const monthlyBudget = Number(row.MonthlyBudget ?? 0)
      const additionalBudget = Number(row.AdditionalBudget ?? 0)
      const usedBudget = Number(row.UsedBudget ?? 0)
      const remainingBudget = Number(row.RemainingBudget ?? 0)
      assert([monthlyBudget, additionalBudget, usedBudget, remainingBudget].every(Number.isFinite), `Invalid source money row: ${JSON.stringify(row)}`)
      assert(monthlyBudget >= 0 && additionalBudget >= 0 && usedBudget >= 0, `Negative source budget value: ${JSON.stringify(row)}`)

      if (!targetBranch) {
        const current = sourceOnly.get(targetKey) ?? { names: new Set<string>(), periods: new Set<string>(), rowCount: 0 }
        current.names.add(normalizeBranchExact(row.Location))
        current.periods.add(period)
        current.rowCount += 1
        sourceOnly.set(targetKey, current)
        continue
      }

      const groupKey = `${targetKey}\u0000${period}`
      const current = sourceGroups.get(groupKey) ?? {
        targetKey,
        period,
        sourceNames: [],
        sourceRowCount: 0,
        monthlyBudget: 0,
        additionalBudget: 0,
        usedBudget: 0,
        remainingBudget: 0,
      }
      current.sourceNames.push(String(row.Location).trim())
      current.sourceRowCount += 1
      current.monthlyBudget += monthlyBudget
      current.additionalBudget += additionalBudget
      current.usedBudget += usedBudget
      current.remainingBudget += remainingBudget
      sourceGroups.set(groupKey, current)
    }

    const sourceByTarget = new Map<string, AggregatedSource[]>()
    const sourceOverspentGroups: Array<{
      targetKey: string
      period: string
      sourceNames: string[]
      overspentCents: number
    }> = []
    for (const group of sourceGroups.values()) {
      const expectedRemaining = group.monthlyBudget + group.additionalBudget - group.usedBudget
      assert(Math.abs(expectedRemaining - group.remainingBudget) < 0.01, `Source budget equation mismatch for ${group.targetKey} ${group.period}`)
      if (expectedRemaining < 0) {
        sourceOverspentGroups.push({
          targetKey: group.targetKey,
          period: group.period,
          sourceNames: [...new Set(group.sourceNames)].sort((a, b) => a.localeCompare(b)),
          overspentCents: toCents(Math.abs(expectedRemaining)),
        })
      }
      assert(group.additionalBudget === 0, `Nonzero source AdditionalBudget requires an addon-ledger import design: ${group.targetKey} ${group.period}`)
      group.sourceNames = [...new Set(group.sourceNames)].sort((a, b) => a.localeCompare(b))
      sourceByTarget.set(group.targetKey, [...(sourceByTarget.get(group.targetKey) ?? []), group])
    }
    for (const rows of sourceByTarget.values()) rows.sort((a, b) => a.period.localeCompare(b.period))

    const missingSourceBranches = dbBranches.filter((branch) => !sourceByTarget.has(String(branch.id)))
    assert(missingSourceBranches.length === 0, `Database branches without source budget mapping: ${missingSourceBranches.map((branch) => branch.name).join(", ")}`)

    const orderStartsResult = await pool.query<{
      branchId: number
      earliestOrderPeriod: string | null
      orderCount: number
    }>(`
      select
        b.id as "branchId",
        to_char(min(o.created_at) at time zone 'Asia/Karachi', 'YYYY-MM') as "earliestOrderPeriod",
        count(o.id)::int as "orderCount"
      from branches b
      left join orders o
        on o.branch_id = b.id
       and o.organization_id = b.organization_id
      where b.organization_id = $1
      group by b.id
      order by b.id
    `, [KE_ORGANIZATION.id])
    const orderStarts = new Map(orderStartsResult.rows.map((row) => [row.branchId, row]))
    const currentPeriod = currentKarachiPeriod()
    const sourcePeriods = [...new Set([...sourceGroups.values()].map((row) => row.period))].sort()
    assert(sourcePeriods.at(-1) === currentPeriod, `Source latest period ${sourcePeriods.at(-1)} does not match current period ${currentPeriod}`)

    const existingBudgets = await db
      .select({
        id: budgets.id,
        branchId: budgets.branchId,
        period: budgets.period,
        amountAllocatedCents: budgets.amountAllocatedCents,
        amountCreditedCents: budgets.amountCreditedCents,
        amountSpentCents: budgets.amountSpentCents,
        amountHeldCents: budgets.amountHeldCents,
      })
      .from(budgets)
      .where(eq(budgets.organizationId, KE_ORGANIZATION.id))
      .orderBy(asc(budgets.branchId), asc(budgets.period))
    const existingByKey = new Map(existingBudgets.map((row) => [`${row.branchId}:${row.period}`, row]))

    const allPlannedRows: PlannedBudget[] = []
    const branchPlans: Array<Record<string, unknown>> = []
    const baselines: Array<{ branchId: number; branchName: string; previousAmountCents: number; amountCents: number }> = []
    for (const branch of dbBranches) {
      const targetKey = String(branch.id)
      const available = sourceByTarget.get(targetKey)!
      const orderStart = orderStarts.get(branch.id)
      assert(orderStart, `Missing order aggregate for branch ${branch.id}`)
      const startPeriod = orderStart.earliestOrderPeriod ?? currentPeriod
      const plannedForBranch: PlannedBudget[] = []
      for (const period of periodRange(startPeriod, currentPeriod)) {
        const selected = chooseSource(available, period)
        plannedForBranch.push({
          organizationId: KE_ORGANIZATION.id,
          branchId: branch.id,
          branchCode: branch.code,
          branchName: branch.name,
          period,
          amountAllocatedCents: toCents(selected.row.monthlyBudget),
          amountCreditedCents: toCents(selected.row.additionalBudget),
          amountSpentCents: 0,
          amountHeldCents: 0,
          sourcePeriod: selected.row.period,
          sourceMethod: selected.method,
          sourceNames: selected.row.sourceNames,
          sourceRowCount: selected.row.sourceRowCount,
          sourceUsedCents: toCents(selected.row.usedBudget),
          sourceRemainingCents: toCents(selected.row.remainingBudget),
        })
      }
      allPlannedRows.push(...plannedForBranch)
      const current = plannedForBranch.at(-1)!
      baselines.push({
        branchId: branch.id,
        branchName: branch.name,
        previousAmountCents: Number(branch.baselineBudgetCents),
        amountCents: current.amountAllocatedCents,
      })
      branchPlans.push({
        branchId: branch.id,
        branchCode: branch.code,
        branchName: branch.name,
        orderCount: orderStart.orderCount,
        startPeriod,
        endPeriod: currentPeriod,
        plannedPeriodCount: plannedForBranch.length,
        exactSourcePeriods: plannedForBranch.filter((row) => row.sourceMethod === "exact").length,
        backfilledPeriods: plannedForBranch.filter((row) => row.sourceMethod === "backfill-earliest").length,
        carriedPeriods: plannedForBranch.filter((row) => row.sourceMethod === "carry-forward").length,
        currentAllocatedCents: current.amountAllocatedCents,
      })
    }

    allPlannedRows.sort((a, b) => a.branchId - b.branchId || a.period.localeCompare(b.period))
    const inserts = allPlannedRows.filter((row) => !existingByKey.has(`${row.branchId}:${row.period}`))
    const skippedExisting = allPlannedRows.filter((row) => existingByKey.has(`${row.branchId}:${row.period}`))
    const baselineChanges = baselines.filter((row) => row.previousAmountCents !== row.amountCents)
    const digest = stablePlanDigest(inserts, baselines.map((row) => ({ branchId: row.branchId, amountCents: row.amountCents })))
    const duplicateSourceGroups = [...sourceGroups.values()]
      .filter((group) => group.sourceRowCount > 1)
      .map((group) => ({
        targetKey: group.targetKey,
        period: group.period,
        sourceNames: group.sourceNames,
        collapsedRowCount: group.sourceRowCount,
        monthlyBudgetCents: toCents(group.monthlyBudget),
      }))
    const sourceOnlySummary = [...sourceOnly.entries()].map(([targetKey, value]) => ({
      targetKey,
      sourceNames: [...value.names].sort(),
      periods: [...value.periods].sort(),
      rowCount: value.rowCount,
    }))

    const preflightReport: Record<string, unknown> = {
      kind: "KE_BRANCH_BUDGET_IMPORT",
      mode: options.commit ? "COMMIT_REQUESTED" : "DRY_RUN",
      generatedAt: new Date().toISOString(),
      organization,
      source: {
        path: options.sourcePath,
        sha256: sourceSha256,
        rowCount: source.rows.length,
        periods: sourcePeriods,
        metadata: source.metadata,
        request: source.request,
      },
      policy: {
        currentPeriod,
        firstPeriod: "earliest local order month per branch",
        branchWithoutOrders: "current month only",
        missingEarlierSourcePeriod: "backfill the earliest available source allocation",
        duplicateSourceRows: "aggregate only when exact identity or an explicit alias resolves to one database branch/month",
        existingDatabaseBudget: "skip; never overwrite",
        importedFields: ["amountAllocatedCents", "amountCreditedCents"],
        preservedOperationalFields: { amountSpentCents: 0, amountHeldCents: 0 },
        currentBaseline: "set branches.baselineBudgetCents to the current source monthly allocation",
      },
      summary: {
        databaseBranchCount: dbBranches.length,
        branchesWithOrders: branchPlans.filter((row) => Number(row.orderCount) > 0).length,
        branchesWithoutOrders: branchPlans.filter((row) => Number(row.orderCount) === 0).length,
        plannedBudgetRows: allPlannedRows.length,
        insertBudgetRows: inserts.length,
        skippedExistingBudgetRows: skippedExisting.length,
        baselineChanges: baselineChanges.length,
        duplicateSourceGroupsCollapsed: duplicateSourceGroups.length,
        duplicateSourceRowsRemoved: duplicateSourceGroups.reduce((total, row) => total + row.collapsedRowCount - 1, 0),
        sourceOnlyLocationGroupsSkipped: sourceOnlySummary.length,
        sourceOverspentGroupsNotImported: sourceOverspentGroups.length,
        exactSourceRows: inserts.filter((row) => row.sourceMethod === "exact").length,
        backfilledRows: inserts.filter((row) => row.sourceMethod === "backfill-earliest").length,
        carriedRows: inserts.filter((row) => row.sourceMethod === "carry-forward").length,
        insertedAllocationCents: inserts.reduce((total, row) => total + row.amountAllocatedCents, 0),
        currentBaselineCents: baselines.reduce((total, row) => total + row.amountCents, 0),
      },
      planSha256: digest,
      requiredCommitArguments: {
        confirmOrganization: CONFIRM_ORGANIZATION,
        confirmSourceSha256: sourceSha256,
        confirmPlanSha256: digest,
        expectedInserts: inserts.length,
      },
      sourceOnlyLocationGroupsSkipped: sourceOnlySummary,
      sourceOverspentGroupsNotImported: sourceOverspentGroups,
      duplicateSourceGroups,
      baselineChanges,
      skippedExisting,
      branchPlans,
      inserts,
    }

    if (!options.commit) {
      writeReport(options.outputPath, preflightReport)
      console.log(JSON.stringify({
        mode: "DRY_RUN",
        output: options.outputPath,
        organization: CONFIRM_ORGANIZATION,
        sourceSha256,
        planSha256: digest,
        summary: preflightReport.summary,
        requiredCommitArguments: preflightReport.requiredCommitArguments,
      }, null, 2))
      return
    }

    assert(options.confirmOrganization === CONFIRM_ORGANIZATION, `--confirm-organization must equal ${CONFIRM_ORGANIZATION}`)
    assert(options.confirmSourceSha256 === sourceSha256, "--confirm-source-sha256 does not match the source file")
    assert(options.confirmPlanSha256 === digest, "--confirm-plan-sha256 does not match the current plan")
    assert(Number.isSafeInteger(options.expectedInserts) && options.expectedInserts === inserts.length, `--expected-inserts must equal ${inserts.length}`)

    const commitResult = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(700010)`)
      const currentExisting = await tx
        .select({ branchId: budgets.branchId, period: budgets.period })
        .from(budgets)
        .where(eq(budgets.organizationId, KE_ORGANIZATION.id))
      const currentKeys = currentExisting.map((row) => `${row.branchId}:${row.period}`).sort()
      const preflightKeys = existingBudgets.map((row) => `${row.branchId}:${row.period}`).sort()
      assert(JSON.stringify(currentKeys) === JSON.stringify(preflightKeys), "K-Electric budgets changed after preflight; aborting")

      const insertedIds: number[] = []
      for (let index = 0; index < inserts.length; index += 250) {
        const chunk = inserts.slice(index, index + 250).map((row) => ({
          organizationId: row.organizationId,
          branchId: row.branchId,
          period: row.period,
          amountAllocatedCents: row.amountAllocatedCents,
          amountSpentCents: row.amountSpentCents,
          amountHeldCents: row.amountHeldCents,
          amountCreditedCents: row.amountCreditedCents,
        }))
        if (chunk.length === 0) continue
        const inserted = await tx.insert(budgets).values(chunk).onConflictDoNothing().returning({ id: budgets.id })
        insertedIds.push(...inserted.map((row) => row.id))
      }
      assert(insertedIds.length === inserts.length, `Expected ${inserts.length} inserts but database returned ${insertedIds.length}`)

      for (const baseline of baselineChanges) {
        const updated = await tx
          .update(branches)
          .set({ baselineBudgetCents: baseline.amountCents, updatedAt: new Date() })
          .where(and(eq(branches.id, baseline.branchId), eq(branches.organizationId, KE_ORGANIZATION.id)))
          .returning({ id: branches.id })
        assert(updated.length === 1, `Failed to update baseline for branch ${baseline.branchId}`)
      }

      const [audit] = await tx.insert(auditLogs).values({
        userId: null,
        organizationId: KE_ORGANIZATION.id,
        branchId: null,
        action: "KE_BRANCH_BUDGET_IMPORT",
        entity: "budgets",
        entityId: digest.slice(0, 128),
        metadata: {
          sourceSha256,
          planSha256: digest,
          insertedBudgetRows: insertedIds.length,
          baselineChanges: baselineChanges.length,
          currentPeriod,
          operationalSpendingImported: false,
        },
      }).returning({ id: auditLogs.id })
      return { insertedIds, auditLogId: audit.id }
    })

    const validation = await pool.query<{
      budgetCount: number
      branchCount: number
      minPeriod: string | null
      maxPeriod: string | null
      allocatedCents: string
      spentCents: string
      heldCents: string
      creditedCents: string
    }>(`
      select
        count(*)::int as "budgetCount",
        count(distinct branch_id)::int as "branchCount",
        min(period) as "minPeriod",
        max(period) as "maxPeriod",
        coalesce(sum(amount_allocated_cents), 0)::text as "allocatedCents",
        coalesce(sum(amount_spent_cents), 0)::text as "spentCents",
        coalesce(sum(amount_held_cents), 0)::text as "heldCents",
        coalesce(sum(amount_credited_cents), 0)::text as "creditedCents"
      from budgets
      where organization_id = $1
    `, [KE_ORGANIZATION.id])

    const commitReport = {
      ...preflightReport,
      mode: "COMMITTED",
      committedAt: new Date().toISOString(),
      commitResult,
      validation: validation.rows[0],
    }
    writeReport(options.outputPath, commitReport)
    console.log(JSON.stringify({
      mode: "COMMITTED",
      output: options.outputPath,
      planSha256: digest,
      insertedBudgetRows: commitResult.insertedIds.length,
      baselineChanges: baselineChanges.length,
      auditLogId: commitResult.auditLogId,
      validation: validation.rows[0],
    }, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
