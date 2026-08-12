#!/usr/bin/env tsx

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import * as dotenv from "dotenv"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORG_ID = 10

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
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
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`
}

async function main() {
  const reportPath = resolve(arg("--commit-report") ?? "backups/ke-budget-import-commit-2026-08-05.json")
  assert(existsSync(reportPath), `Commit report not found: ${reportPath}`)
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as any
  assert(report.kind === "KE_BRANCH_BUDGET_IMPORT" && report.mode === "COMMITTED", "Invalid budget import commit report")
  assert(report.organization?.id === 10 && report.organization?.code === "0001" && report.organization?.name === "K-Electric", "Commit report organization mismatch")
  assert(Array.isArray(report.inserts), "Commit report has no inserts")

  const { pool } = await import("../lib/db-cli")
  try {
    const [organization, budgetResult, branchResult, boundaryResult, auditResult] = await Promise.all([
      pool.query("select id, code, name from organizations where id = $1", [ORG_ID]),
      pool.query(`
        select id, organization_id as "organizationId", branch_id as "branchId", period,
               amount_allocated_cents as "amountAllocatedCents",
               amount_credited_cents as "amountCreditedCents",
               amount_spent_cents as "amountSpentCents",
               amount_held_cents as "amountHeldCents"
        from budgets
        where organization_id = $1
        order by branch_id, period
      `, [ORG_ID]),
      pool.query(`
        select b.id, b.name, b.baseline_budget_cents as "baselineBudgetCents",
               current_budget.amount_allocated_cents as "currentAllocatedCents"
        from branches b
        left join budgets current_budget
          on current_budget.branch_id = b.id
         and current_budget.organization_id = b.organization_id
         and current_budget.period = $2
        where b.organization_id = $1
        order by b.id
      `, [ORG_ID, currentKarachiPeriod()]),
      pool.query(`
        select b.id, b.name,
               coalesce(to_char(min(o.created_at) at time zone 'Asia/Karachi', 'YYYY-MM'), $2) as "expectedStartPeriod",
               min(bg.period) as "actualStartPeriod",
               max(bg.period) as "actualEndPeriod",
               count(bg.id)::int as "budgetCount"
        from branches b
        left join orders o on o.branch_id = b.id and o.organization_id = b.organization_id
        left join budgets bg on bg.branch_id = b.id and bg.organization_id = b.organization_id
        where b.organization_id = $1
        group by b.id, b.name
        order by b.id
      `, [ORG_ID, currentKarachiPeriod()]),
      pool.query("select id, organization_id, action, entity, metadata from audit_logs where id = $1", [report.commitResult?.auditLogId]),
    ])

    assert(organization.rows.length === 1 && organization.rows[0].code === "0001" && organization.rows[0].name === "K-Electric", "Live organization mismatch")
    const expected = new Map<string, any>(report.inserts.map((row: any) => [`${row.branchId}:${row.period}`, row]))
    const actual = new Map<string, any>(budgetResult.rows.map((row: any) => [`${row.branchId}:${row.period}`, row]))
    assert(actual.size === expected.size, `Budget row count mismatch: expected ${expected.size}, found ${actual.size}`)

    let amountMismatches = 0
    for (const [key, expectedRow] of expected) {
      const actualRow: any = actual.get(key)
      if (!actualRow ||
          Number(actualRow.amountAllocatedCents) !== Number((expectedRow as any).amountAllocatedCents) ||
          Number(actualRow.amountCreditedCents) !== Number((expectedRow as any).amountCreditedCents) ||
          Number(actualRow.amountSpentCents) !== Number((expectedRow as any).amountSpentCents) ||
          Number(actualRow.amountHeldCents) !== Number((expectedRow as any).amountHeldCents)) {
        amountMismatches += 1
      }
    }
    assert(amountMismatches === 0, `${amountMismatches} budget rows differ from the checksum-locked plan`)

    const baselineMismatches = branchResult.rows.filter((row: any) =>
      row.currentAllocatedCents === null || Number(row.baselineBudgetCents) !== Number(row.currentAllocatedCents),
    )
    assert(branchResult.rows.length === 127, `Expected 127 K-Electric branches, found ${branchResult.rows.length}`)
    assert(baselineMismatches.length === 0, `Current baseline mismatch for: ${baselineMismatches.map((row: any) => row.name).join(", ")}`)

    const boundaryMismatches = boundaryResult.rows.filter((row: any) =>
      row.expectedStartPeriod !== row.actualStartPeriod || row.actualEndPeriod !== currentKarachiPeriod(),
    )
    assert(boundaryMismatches.length === 0, `Budget period boundary mismatch for: ${boundaryMismatches.map((row: any) => row.name).join(", ")}`)

    const audit = auditResult.rows[0]
    assert(audit?.organization_id === ORG_ID && audit.action === "KE_BRANCH_BUDGET_IMPORT" && audit.entity === "budgets", "Import audit log mismatch")
    assert(audit.metadata?.planSha256 === report.planSha256, "Audit plan checksum mismatch")

    console.log(JSON.stringify({
      status: "VALID",
      organization: organization.rows[0],
      budgetRows: actual.size,
      branches: branchResult.rows.length,
      currentPeriod: currentKarachiPeriod(),
      amountMismatches,
      baselineMismatches: baselineMismatches.length,
      boundaryMismatches: boundaryMismatches.length,
      auditLogId: audit.id,
      planSha256: report.planSha256,
    }, null, 2))
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
