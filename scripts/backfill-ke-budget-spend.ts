#!/usr/bin/env tsx
/**
 * Reconciles K-Electric's money-budget ledger from its imported order history.
 *
 * Default mode is a read-only preflight. Commit mode is checksum-gated and:
 * - counts fulfilled/partially fulfilled order value, net of refunds, as spent;
 * - keeps pending/approved order value, net of refunds, as held;
 * - excludes fully refunded/cancelled/rejected orders from consumption;
 * - creates missing branch/month budget rows at the minimum required allocation;
 * - raises (never lowers) allocation when required by the budget invariant;
 * - never changes orders, stock, quantity budgets, invoice sequences, or tenants.
 *
 * A committed report contains before/after values and can be supplied to the
 * guarded --rollback mode. Rollback refuses to run if a target budget changed
 * after this backfill.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
const ORGANIZATION_CONFIRMATION = "10:0001:K-Electric"
const ADVISORY_LOCK = 700010
const SPENT_STATUSES = ["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"] as const
const HELD_STATUSES = ["PENDING", "APPROVED"] as const

type JsonRow = Record<string, unknown>

interface BudgetRow {
  id: number
  organization_id: number
  branch_id: number
  branch_name: string
  period: string
  amount_allocated_cents: string
  amount_spent_cents: string
  amount_held_cents: string
  amount_credited_cents: string
  created_at: string | null
  updated_at: string | null
}

interface ConsumptionRow {
  branch_id: number
  branch_name: string
  period: string
  order_count: number
  spent_order_count: number
  held_order_count: number
  fully_refunded_order_count: number
  gross_order_cents: string
  refund_cents: string
  spent_cents: string
  held_cents: string
}

interface PlanRow {
  operation: "UPDATE" | "INSERT"
  budgetId: number | null
  organizationId: number
  branchId: number
  branchName: string
  period: string
  orderCount: number
  spentOrderCount: number
  heldOrderCount: number
  fullyRefundedOrderCount: number
  grossOrderCents: number
  refundCents: number
  previousAllocatedCents: number
  previousSpentCents: number
  previousHeldCents: number
  previousCreditedCents: number
  targetAllocatedCents: number
  targetSpentCents: number
  targetHeldCents: number
  targetCreditedCents: number
  allocationIncreaseCents: number
}

interface CommitReport {
  kind: "KE_BUDGET_SPEND_BACKFILL"
  mode: "COMMITTED"
  organization: typeof ORGANIZATION
  planSha256: string
  auditLogId: number
  changes: Array<PlanRow & { committedBudgetId: number }>
}

const CONSUMPTION_QUERY = `
  select
    o.branch_id,
    br.name as branch_name,
    to_char(o.created_at at time zone 'Asia/Karachi', 'YYYY-MM') as period,
    count(*)::int as order_count,
    count(*) filter (where upper(o.status) = any($2::text[]))::int as spent_order_count,
    count(*) filter (where upper(o.status) = any($3::text[]))::int as held_order_count,
    count(*) filter (
      where upper(o.status) = 'REFUNDED'
         or (coalesce(o.refund_amount_cents, 0) >= o.total_cents and o.total_cents > 0)
    )::int as fully_refunded_order_count,
    coalesce(sum(o.total_cents), 0)::text as gross_order_cents,
    coalesce(sum(coalesce(o.refund_amount_cents, 0)), 0)::text as refund_cents,
    coalesce(sum(case
      when upper(o.status) = any($2::text[])
        then greatest(0, o.total_cents - coalesce(o.refund_amount_cents, 0))
      else 0
    end), 0)::text as spent_cents,
    coalesce(sum(case
      when upper(o.status) = any($3::text[])
        then greatest(0, o.total_cents - coalesce(o.refund_amount_cents, 0))
      else 0
    end), 0)::text as held_cents
  from orders o
  join branches br
    on br.id = o.branch_id
   and br.organization_id = o.organization_id
  where o.organization_id = $1
  group by o.branch_id, br.name,
    to_char(o.created_at at time zone 'Asia/Karachi', 'YYYY-MM')
  order by period, br.name, o.branch_id
`

const BUDGET_QUERY = `
  select
    bg.id,
    bg.organization_id,
    bg.branch_id,
    br.name as branch_name,
    bg.period,
    bg.amount_allocated_cents::text,
    bg.amount_spent_cents::text,
    bg.amount_held_cents::text,
    bg.amount_credited_cents::text,
    bg.created_at::text,
    bg.updated_at::text
  from budgets bg
  join branches br
    on br.id = bg.branch_id
   and br.organization_id = bg.organization_id
  where bg.organization_id = $1
  order by bg.branch_id, bg.period, bg.id
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

function integer(value: unknown, label: string): number {
  const parsed = Number(value)
  assert(Number.isSafeInteger(parsed) && parsed >= 0, `${label} is not a safe nonnegative integer`)
  return parsed
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort((a, b) => a.localeCompare(b))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

async function rows<T>(client: PoolClient, query: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(query, params)).rows as T[]
}

async function organization(client: PoolClient): Promise<typeof ORGANIZATION> {
  const [row] = await rows<JsonRow>(client,
    "select id, code, name, status from organizations where id = $1", [ORGANIZATION.id])
  assert(row?.id === ORGANIZATION.id && row.code === ORGANIZATION.code && row.name === ORGANIZATION.name,
    `K-Electric tenant identity gate failed: ${JSON.stringify(row)}`)
  assert(String(row.status).toLowerCase() === "active", "K-Electric organization is not active")
  return ORGANIZATION
}

async function readState(client: PoolClient): Promise<{ budgets: BudgetRow[]; consumption: ConsumptionRow[] }> {
  const [budgets, consumption] = await Promise.all([
    rows<BudgetRow>(client, BUDGET_QUERY, [ORGANIZATION.id]),
    rows<ConsumptionRow>(client, CONSUMPTION_QUERY,
      [ORGANIZATION.id, [...SPENT_STATUSES], [...HELD_STATUSES]]),
  ])
  return { budgets, consumption }
}

function buildPlan(state: { budgets: BudgetRow[]; consumption: ConsumptionRow[] }): PlanRow[] {
  const budgetByKey = new Map(state.budgets.map((row) => [`${row.branch_id}:${row.period}`, row]))
  assert(budgetByKey.size === state.budgets.length, "Duplicate K-Electric branch/month budget rows found")

  const plan: PlanRow[] = []
  for (const consumption of state.consumption) {
    const key = `${consumption.branch_id}:${consumption.period}`
    const budget = budgetByKey.get(key)
    const targetSpentCents = integer(consumption.spent_cents, `${key} spent`)
    const targetHeldCents = integer(consumption.held_cents, `${key} held`)
    const previousAllocatedCents = budget ? integer(budget.amount_allocated_cents, `${key} allocated`) : 0
    const previousSpentCents = budget ? integer(budget.amount_spent_cents, `${key} previous spent`) : 0
    const previousHeldCents = budget ? integer(budget.amount_held_cents, `${key} previous held`) : 0
    const previousCreditedCents = budget ? integer(budget.amount_credited_cents, `${key} credited`) : 0
    const requiredAllocation = Math.max(0, targetSpentCents + targetHeldCents - previousCreditedCents)
    const targetAllocatedCents = Math.max(previousAllocatedCents, requiredAllocation)

    if (budget && previousSpentCents === targetSpentCents
      && previousHeldCents === targetHeldCents
      && previousAllocatedCents === targetAllocatedCents) continue

    plan.push({
      operation: budget ? "UPDATE" : "INSERT",
      budgetId: budget?.id ?? null,
      organizationId: ORGANIZATION.id,
      branchId: consumption.branch_id,
      branchName: consumption.branch_name,
      period: consumption.period,
      orderCount: integer(consumption.order_count, `${key} order count`),
      spentOrderCount: integer(consumption.spent_order_count, `${key} spent order count`),
      heldOrderCount: integer(consumption.held_order_count, `${key} held order count`),
      fullyRefundedOrderCount: integer(consumption.fully_refunded_order_count, `${key} refunded order count`),
      grossOrderCents: integer(consumption.gross_order_cents, `${key} gross orders`),
      refundCents: integer(consumption.refund_cents, `${key} refunds`),
      previousAllocatedCents,
      previousSpentCents,
      previousHeldCents,
      previousCreditedCents,
      targetAllocatedCents,
      targetSpentCents,
      targetHeldCents,
      targetCreditedCents: previousCreditedCents,
      allocationIncreaseCents: targetAllocatedCents - previousAllocatedCents,
    })
  }
  return plan.sort((a, b) => a.period.localeCompare(b.period)
    || a.branchName.localeCompare(b.branchName) || a.branchId - b.branchId)
}

function planDigest(plan: PlanRow[]): string {
  return sha256(canonicalJson(plan))
}

function summary(state: { budgets: BudgetRow[]; consumption: ConsumptionRow[] }, plan: PlanRow[]) {
  return {
    existingBudgetRows: state.budgets.length,
    orderBranchPeriods: state.consumption.length,
    existingRowsUpdated: plan.filter((row) => row.operation === "UPDATE").length,
    missingRowsInserted: plan.filter((row) => row.operation === "INSERT").length,
    allocationRowsRaised: plan.filter((row) => row.allocationIncreaseCents > 0).length,
    affectedBranches: new Set(plan.map((row) => row.branchId)).size,
    targetSpentCents: state.consumption.reduce((total, row) => total + integer(row.spent_cents, "summary spent"), 0),
    targetHeldCents: state.consumption.reduce((total, row) => total + integer(row.held_cents, "summary held"), 0),
    grossOrderCents: state.consumption.reduce((total, row) => total + integer(row.gross_order_cents, "summary gross"), 0),
    refundCents: state.consumption.reduce((total, row) => total + integer(row.refund_cents, "summary refund"), 0),
    allocationIncreaseCents: plan.reduce((total, row) => total + row.allocationIncreaseCents, 0),
    spentOrders: state.consumption.reduce((total, row) => total + integer(row.spent_order_count, "summary spent orders"), 0),
    heldOrders: state.consumption.reduce((total, row) => total + integer(row.held_order_count, "summary held orders"), 0),
    fullyRefundedOrders: state.consumption.reduce((total, row) => total + integer(row.fully_refunded_order_count, "summary refunded orders"), 0),
    minPeriod: state.consumption[0]?.period ?? null,
    maxPeriod: state.consumption.at(-1)?.period ?? null,
  }
}

async function fingerprints(client: PoolClient): Promise<JsonRow> {
  const [value] = await rows<JsonRow>(client, `
    select
      (select count(*)::int from orders where organization_id = $1) as ke_orders,
      (select coalesce(sum(total_cents), 0)::text from orders where organization_id = $1) as ke_order_total,
      (select count(*)::int from product_quantity_budgets where organization_id = $1) as ke_quantity_budgets,
      (select coalesce(sum(held_quantity + used_quantity), 0)::text
         from product_quantity_budgets where organization_id = $1) as ke_quantity_consumption,
      (select coalesce(sum(stock_quantity), 0)::text from global_products where deleted_at is null) as global_stock,
      (select coalesce(sum(amount_spent_cents + amount_held_cents), 0)::text
         from budgets where organization_id <> $1) as other_tenant_budget_consumption,
      (select count(*)::int from budgets where organization_id <> $1) as other_tenant_budget_rows
  `, [ORGANIZATION.id])
  return value
}

function baseReport(state: { budgets: BudgetRow[]; consumption: ConsumptionRow[] }, plan: PlanRow[]) {
  const digest = planDigest(plan)
  return {
    kind: "KE_BUDGET_SPEND_BACKFILL" as const,
    mode: "DRY_RUN" as const,
    generatedAt: new Date().toISOString(),
    organization: ORGANIZATION,
    accountingPolicy: {
      period: "orders.created_at in Asia/Karachi, grouped as YYYY-MM",
      spentStatuses: [...SPENT_STATUSES],
      heldStatuses: [...HELD_STATUSES],
      perOrderNetValue: "greatest(0, total_cents - refund_amount_cents)",
      refundedOrders: "zero consumption",
      allocation: "preserve existing allocation; raise only to spent + held - credited when required",
      missingBudget: "insert with allocation equal to required net consumption",
    },
    summary: summary(state, plan),
    planSha256: digest,
    requiredCommitArguments: {
      confirmOrganization: ORGANIZATION_CONFIRMATION,
      confirmPlanSha256: digest,
      expectedUpdates: plan.filter((row) => row.operation === "UPDATE").length,
      expectedInserts: plan.filter((row) => row.operation === "INSERT").length,
      expectedSpentCents: state.consumption.reduce((total, row) => total + integer(row.spent_cents, "expected spend"), 0),
    },
    changes: plan,
  }
}

async function validateCommittedState(client: PoolClient): Promise<JsonRow> {
  const state = await readState(client)
  const remainingPlan = buildPlan(state)
  const [ledger] = await rows<JsonRow>(client, `
    select
      count(*)::int as budget_rows,
      count(*) filter (where amount_spent_cents > 0)::int as rows_with_spend,
      count(*) filter (where amount_held_cents > 0)::int as rows_with_hold,
      coalesce(sum(amount_spent_cents), 0)::text as spent_cents,
      coalesce(sum(amount_held_cents), 0)::text as held_cents,
      count(*) filter (
        where amount_allocated_cents + amount_credited_cents < amount_spent_cents + amount_held_cents
      )::int as invariant_violations
    from budgets where organization_id = $1
  `, [ORGANIZATION.id])
  const expectedSpent = state.consumption.reduce((total, row) => total + integer(row.spent_cents, "validation spent"), 0)
  const expectedHeld = state.consumption.reduce((total, row) => total + integer(row.held_cents, "validation held"), 0)
  assert(remainingPlan.length === 0, `${remainingPlan.length} K-Electric budget rows still differ from orders`)
  assert(integer(ledger.spent_cents, "ledger spent") === expectedSpent, "Aggregate K-Electric spend differs from orders")
  assert(integer(ledger.held_cents, "ledger held") === expectedHeld, "Aggregate K-Electric holds differ from orders")
  assert(Number(ledger.invariant_violations) === 0, "K-Electric budget invariant violation remains")
  return { ...ledger, expectedSpentCents: expectedSpent, expectedHeldCents: expectedHeld, remainingPlanRows: 0 }
}

async function commit(client: PoolClient): Promise<void> {
  await organization(client)
  const initialState = await readState(client)
  const initialPlan = buildPlan(initialState)
  const report = baseReport(initialState, initialPlan)
  const digest = report.planSha256
  const expectedUpdates = initialPlan.filter((row) => row.operation === "UPDATE").length
  const expectedInserts = initialPlan.filter((row) => row.operation === "INSERT").length
  const expectedSpent = initialState.consumption.reduce((total, row) => total + integer(row.spent_cents, "commit spent"), 0)

  assert(initialPlan.length > 0, "K-Electric budget spending is already reconciled")
  assert(arg("--confirm-organization") === ORGANIZATION_CONFIRMATION,
    `--confirm-organization must equal ${ORGANIZATION_CONFIRMATION}`)
  assert(arg("--confirm-plan-sha256") === digest, "--confirm-plan-sha256 does not match the current plan")
  assert(Number(arg("--expected-updates")) === expectedUpdates, `--expected-updates must equal ${expectedUpdates}`)
  assert(Number(arg("--expected-inserts")) === expectedInserts, `--expected-inserts must equal ${expectedInserts}`)
  assert(Number(arg("--expected-spent-cents")) === expectedSpent, `--expected-spent-cents must equal ${expectedSpent}`)

  const output = resolve(arg("--output") ?? `backups/ke-budget-spend-backfill-commit-${timestamp()}.json`)
  const prechangePath = resolve(arg("--prechange-output")
    ?? `backups/ke-budget-spend-backfill-prechange-${timestamp()}.json`)
  const beforeFingerprint = await fingerprints(client)
  const prechange = {
    kind: "KE_BUDGET_SPEND_BACKFILL_PRECHANGE",
    generatedAt: new Date().toISOString(),
    organization: ORGANIZATION,
    planSha256: digest,
    fingerprints: beforeFingerprint,
    budgets: initialState.budgets,
  }
  saveJson(prechangePath, prechange)
  const prechangeSha256 = sha256(readFileSync(prechangePath, "utf8"))

  let auditLogId: number
  const committedChanges: Array<PlanRow & { committedBudgetId: number }> = []
  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    const lockedOrganization = await rows<JsonRow>(client,
      "select id, code, name from organizations where id = $1 for share", [ORGANIZATION.id])
    assert(lockedOrganization[0]?.code === ORGANIZATION.code && lockedOrganization[0]?.name === ORGANIZATION.name,
      "Locked K-Electric tenant identity gate failed")
    await client.query("select id from orders where organization_id = $1 order by id for share", [ORGANIZATION.id])
    await client.query("select id from budgets where organization_id = $1 order by id for update", [ORGANIZATION.id])

    const lockedState = await readState(client)
    const lockedPlan = buildPlan(lockedState)
    assert(planDigest(lockedPlan) === digest, "K-Electric orders or budgets changed after preflight; aborting")

    for (const row of lockedPlan) {
      if (row.operation === "UPDATE") {
        const updated = await rows<JsonRow>(client, `
          update budgets set
            amount_allocated_cents = $1,
            amount_spent_cents = $2,
            amount_held_cents = $3,
            updated_at = now()
          where id = $4 and organization_id = $5 and branch_id = $6 and period = $7
            and amount_allocated_cents = $8 and amount_spent_cents = $9
            and amount_held_cents = $10 and amount_credited_cents = $11
          returning id
        `, [row.targetAllocatedCents, row.targetSpentCents, row.targetHeldCents,
          row.budgetId, ORGANIZATION.id, row.branchId, row.period,
          row.previousAllocatedCents, row.previousSpentCents, row.previousHeldCents, row.previousCreditedCents])
        assert(updated.length === 1, `Concurrent change detected for budget ${row.budgetId}`)
        committedChanges.push({ ...row, committedBudgetId: Number(updated[0].id) })
      } else {
        const inserted = await rows<JsonRow>(client, `
          insert into budgets (
            organization_id, branch_id, period, amount_allocated_cents,
            amount_spent_cents, amount_held_cents, amount_credited_cents
          ) values ($1, $2, $3, $4, $5, $6, $7)
          returning id
        `, [ORGANIZATION.id, row.branchId, row.period, row.targetAllocatedCents,
          row.targetSpentCents, row.targetHeldCents, row.targetCreditedCents])
        assert(inserted.length === 1, `Failed to insert budget ${row.branchId}:${row.period}`)
        committedChanges.push({ ...row, committedBudgetId: Number(inserted[0].id) })
      }
    }

    const audit = await rows<JsonRow>(client, `
      insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
      values (null, $1, null, 'KE_BUDGET_SPEND_BACKFILL', 'budgets', $2, $3::jsonb)
      returning id
    `, [ORGANIZATION.id, digest.slice(0, 128), JSON.stringify({
      planSha256: digest,
      prechangePath,
      prechangeSha256,
      updatedBudgetRows: expectedUpdates,
      insertedBudgetRows: expectedInserts,
      targetSpentCents: expectedSpent,
      targetHeldCents: report.summary.targetHeldCents,
      allocationIncreaseCents: report.summary.allocationIncreaseCents,
      accountingPolicy: report.accountingPolicy,
    })])
    auditLogId = Number(audit[0]?.id)
    assert(Number.isSafeInteger(auditLogId), "Failed to create K-Electric budget backfill audit")

    await validateCommittedState(client)
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }

  const afterFingerprint = await fingerprints(client)
  assert(canonicalJson(beforeFingerprint) === canonicalJson(afterFingerprint),
    "A protected order, quantity-budget, stock, or other-tenant fingerprint changed")
  const validation = await validateCommittedState(client)
  const commitReport = {
    ...report,
    mode: "COMMITTED" as const,
    committedAt: new Date().toISOString(),
    auditLogId,
    prechange: { path: prechangePath, sha256: prechangeSha256 },
    changes: committedChanges,
    protectedFingerprints: { before: beforeFingerprint, after: afterFingerprint },
    validation,
    rollbackConfirmation: `ROLLBACK:${auditLogId}:KE-BUDGET-SPEND`,
  }
  saveJson(output, commitReport)

  const { invalidateByPrefix } = await import("../lib/cache-utils")
  for (const prefix of ["budgets", "analytics", "branches"]) await invalidateByPrefix(prefix)

  console.log(JSON.stringify({
    mode: "COMMITTED",
    output,
    prechangePath,
    auditLogId,
    planSha256: digest,
    summary: report.summary,
    validation,
  }, null, 2))
}

async function rollback(client: PoolClient, reportPath: string): Promise<void> {
  assert(existsSync(reportPath), `Commit report not found: ${reportPath}`)
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as CommitReport
  assert(report.kind === "KE_BUDGET_SPEND_BACKFILL" && report.mode === "COMMITTED", "Invalid commit report")
  assert(report.organization?.id === ORGANIZATION.id && report.organization.code === ORGANIZATION.code
    && report.organization.name === ORGANIZATION.name, "Commit report tenant mismatch")
  const confirmation = `ROLLBACK:${report.auditLogId}:KE-BUDGET-SPEND`
  assert(arg("--confirm-organization") === ORGANIZATION_CONFIRMATION,
    `--confirm-organization must equal ${ORGANIZATION_CONFIRMATION}`)
  assert(arg("--confirm-rollback") === confirmation, `--confirm-rollback must equal ${confirmation}`)
  await organization(client)

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    await client.query("select id from orders where organization_id = $1 order by id for share", [ORGANIZATION.id])
    await client.query("select id from budgets where organization_id = $1 order by id for update", [ORGANIZATION.id])

    for (const change of report.changes) {
      if (change.operation === "INSERT") {
        const deleted = await rows<JsonRow>(client, `
          delete from budgets
          where id = $1 and organization_id = $2 and branch_id = $3 and period = $4
            and amount_allocated_cents = $5 and amount_spent_cents = $6
            and amount_held_cents = $7 and amount_credited_cents = $8
          returning id
        `, [change.committedBudgetId, ORGANIZATION.id, change.branchId, change.period,
          change.targetAllocatedCents, change.targetSpentCents, change.targetHeldCents, change.targetCreditedCents])
        assert(deleted.length === 1, `Inserted budget ${change.committedBudgetId} changed after backfill; rollback refused`)
      } else {
        const restored = await rows<JsonRow>(client, `
          update budgets set
            amount_allocated_cents = $1, amount_spent_cents = $2,
            amount_held_cents = $3, amount_credited_cents = $4, updated_at = now()
          where id = $5 and organization_id = $6 and branch_id = $7 and period = $8
            and amount_allocated_cents = $9 and amount_spent_cents = $10
            and amount_held_cents = $11 and amount_credited_cents = $12
          returning id
        `, [change.previousAllocatedCents, change.previousSpentCents,
          change.previousHeldCents, change.previousCreditedCents,
          change.committedBudgetId, ORGANIZATION.id, change.branchId, change.period,
          change.targetAllocatedCents, change.targetSpentCents, change.targetHeldCents, change.targetCreditedCents])
        assert(restored.length === 1, `Budget ${change.committedBudgetId} changed after backfill; rollback refused`)
      }
    }

    const rollbackAudit = await rows<JsonRow>(client, `
      insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
      values (null, $1, null, 'KE_BUDGET_SPEND_BACKFILL_ROLLBACK', 'budgets', $2, $3::jsonb)
      returning id
    `, [ORGANIZATION.id, String(report.auditLogId), JSON.stringify({
      originalAuditLogId: report.auditLogId,
      planSha256: report.planSha256,
      restoredUpdates: report.changes.filter((row) => row.operation === "UPDATE").length,
      deletedInserts: report.changes.filter((row) => row.operation === "INSERT").length,
    })])
    await client.query("commit")
    console.log(JSON.stringify({ mode: "ROLLED_BACK", originalAuditLogId: report.auditLogId,
      rollbackAuditLogId: rollbackAudit[0]?.id, restoredRows: report.changes.length }, null, 2))
  } catch (error) {
    await client.query("rollback")
    throw error
  }

  const { invalidateByPrefix } = await import("../lib/cache-utils")
  for (const prefix of ["budgets", "analytics", "branches"]) await invalidateByPrefix(prefix)
}

async function preflight(client: PoolClient): Promise<void> {
  await organization(client)
  const state = await readState(client)
  const plan = buildPlan(state)
  const report = baseReport(state, plan)
  const output = resolve(arg("--output") ?? "deliverables/ke-budget-spend-backfill-preflight.json")
  saveJson(output, report)
  console.log(JSON.stringify({
    mode: "DRY_RUN",
    output,
    organization: ORGANIZATION_CONFIRMATION,
    planSha256: report.planSha256,
    summary: report.summary,
    requiredCommitArguments: report.requiredCommitArguments,
  }, null, 2))
}

async function main(): Promise<void> {
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    const rollbackPath = arg("--rollback")
    if (rollbackPath) await rollback(client, resolve(rollbackPath))
    else if (process.argv.includes("--commit")) await commit(client)
    else await preflight(client)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
