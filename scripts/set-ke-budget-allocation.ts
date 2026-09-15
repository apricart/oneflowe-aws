#!/usr/bin/env tsx
/**
 * Set one K-Electric branch's allocation for one past month.
 *
 *   npm run set:ke-budget-allocation -- --branch-id=133 --period=2026-07 --amount-pkr=900000
 *   npm run set:ke-budget-allocation -- --branch-id=133 --period=2026-07 --amount-pkr=900000 --commit \
 *     --actor-user-id=<active-super-admin-uuid> --confirm-plan=<digest printed by the dry run>
 *
 * Why this exists: `PUT /api/v1/budgets` only ever writes the current month
 * (`currentMonth` in `app/api/v1/budgets/route.ts`), so a historical figure
 * that arrived wrong through the legacy budget-report import cannot be
 * corrected from the Head Office page. This writes exactly one
 * `budgets.amount_allocated_cents`, for organization 10 only, and nothing else:
 * not the baseline (that is the "monthly" allocation and belongs to the current
 * month), not credits, not spend.
 *
 * Dry run by default. The commit must present the digest the dry run printed,
 * the update is pinned to the allocation the plan saw, the invariant
 * `budgets_values_valid_ck` is checked before the write and enforced by the
 * database during it, and an `audit_logs` row records who changed what from
 * what to what.
 */

import { createHash } from "node:crypto"
import * as dotenv from "dotenv"

import { invalidateCachePrefixes } from "../lib/cache-cli"
import { KE_SYNC_ORGANIZATION as ORGANIZATION } from "../lib/legacy-import/ke-sync"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type Row = Record<string, unknown>

interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function integerArgument(name: string): number {
  const raw = argument(name)
  assert(raw !== undefined && /^\d+$/.test(raw), `--${name} must be a whole number`)
  const value = Number(raw)
  assert(Number.isSafeInteger(value), `--${name} is out of range`)
  return value
}

function money(cents: number): string {
  return `PKR ${(cents / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

async function main(): Promise<void> {
  const branchId = integerArgument("branch-id")
  const period = argument("period") ?? ""
  assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(period), "--period must be YYYY-MM")
  const currentMonth = new Date().toISOString().slice(0, 7)
  assert(period < currentMonth,
    `--period must be a past month; ${period} is current or future — use Allocate on the budgets page for the current month`)
  // Whole rupees only: the amount is a statement of policy, never a computed figure.
  const amountCents = integerArgument("amount-pkr") * 100
  const commit = process.argv.includes("--commit")
  const reason = argument("reason") ?? "Correction of a historical allocation"

  const { pool, closePool } = await import("../lib/db-cli")
  try {
    const client: QueryClient = pool
    const [organization] = (await client.query(`select id, code, name from organizations where id = $1`, [ORGANIZATION.id])).rows
    assert(organization && organization.code === ORGANIZATION.code && organization.name === ORGANIZATION.name,
      `organization ${ORGANIZATION.id} is not ${ORGANIZATION.code}:${ORGANIZATION.name} in this database; refusing`)

    const [row] = (await client.query(
      `select g.id, b.name as branch_name, b.baseline_budget_cents, g.amount_allocated_cents, g.amount_credited_cents,
              g.amount_spent_cents, g.amount_held_cents
         from budgets g join branches b on b.id = g.branch_id
        where g.organization_id = $1 and g.branch_id = $2 and g.period = $3`,
      [ORGANIZATION.id, branchId, period])).rows
    assert(row, `no ${period} budget row for branch ${branchId} in organization ${ORGANIZATION.id}; nothing to correct`)

    const budgetId = Number(row.id)
    const branchName = String(row.branch_name)
    const current = Number(row.amount_allocated_cents)
    const credited = Number(row.amount_credited_cents)
    const spent = Number(row.amount_spent_cents)
    const held = Number(row.amount_held_cents)
    const committed = spent + held

    console.log(`Branch ............ ${branchName} (${branchId}), organization ${ORGANIZATION.id}:${ORGANIZATION.code}:${ORGANIZATION.name}`)
    console.log(`Period ............ ${period}`)
    console.log(`Allocated ......... ${money(current)} -> ${money(amountCents)}`)
    console.log(`Credited .......... ${money(credited)} (unchanged)`)
    console.log(`Spent + held ...... ${money(spent)} + ${money(held)} = ${money(committed)} (unchanged)`)
    console.log(`Remaining ......... ${money(current + credited - committed)} -> ${money(amountCents + credited - committed)}`)
    console.log(`Baseline .......... ${money(Number(row.baseline_budget_cents))} (unchanged; this is the current month's monthly allocation)`)

    assert(current !== amountCents, `already ${money(amountCents)}; nothing to do`)
    assert(amountCents + credited >= committed,
      `refused: ${money(amountCents)} + ${money(credited)} credited is below the ${money(committed)} already spent or held`)

    const digest = createHash("sha256")
      .update(`ALLOC ${ORGANIZATION.id} ${branchId} ${period} ${current} -> ${amountCents}`)
      .digest("hex")
    console.log(`\nPlan digest: ${digest}`)

    if (!commit) {
      console.log("\nDry run: nothing was written. To apply:")
      console.log(`  npm run set:ke-budget-allocation -- --branch-id=${branchId} --period=${period} --amount-pkr=${amountCents / 100} --commit \\\n    --actor-user-id=<active-super-admin-uuid> \\\n    --confirm-plan=${digest}`)
      return
    }

    const actorUserId = argument("actor-user-id")
    assert(actorUserId, "Commit requires --actor-user-id=<active-super-admin-uuid>")
    assert(argument("confirm-plan") === digest, `Commit requires --confirm-plan=${digest}`)
    const [actor] = (await client.query(
      `select u.id from users u join roles r on r.id = u.role_id
        where u.id = $1 and r.name = 'SUPER_ADMIN' and u.is_active = true and u.deleted_at is null`,
      [actorUserId])).rows
    assert(actor, "--actor-user-id must be an active SUPER_ADMIN")

    const tx = await pool.connect()
    try {
      await tx.query("begin")
      await tx.query(`select pg_advisory_xact_lock(hashtext('oneflowe:ke-sync'))`)
      const updated = await tx.query(
        `update budgets set amount_allocated_cents = $1, updated_at = now()
          where id = $2 and organization_id = $3 and branch_id = $4 and period = $5
            and amount_allocated_cents = $6 and amount_spent_cents = $7 and amount_held_cents = $8 and amount_credited_cents = $9`,
        [amountCents, budgetId, ORGANIZATION.id, branchId, period, current, spent, held, credited])
      assert(updated.rowCount === 1, "the row moved since the plan was built; re-run the dry run")
      const audit = await tx.query(
        `insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
         values ($1, $2, $3, 'KE_BUDGET_ALLOCATION_SET', 'BUDGET', $4, $5::jsonb) returning id`,
        [actorUserId, ORGANIZATION.id, branchId, String(budgetId), JSON.stringify({
          branchName,
          period,
          oldAmount: current / 100,
          newAmount: amountCents / 100,
          oldAmountCents: current,
          newAmountCents: amountCents,
          reason,
          planDigest: digest,
          script: "set-ke-budget-allocation",
        })])
      await tx.query("commit")
      console.log(`\nCommitted. audit_logs id ${String(audit.rows[0].id)}: ${branchName} ${period} ${money(current)} -> ${money(amountCents)}`)
    } catch (error) {
      await tx.query("rollback").catch(() => {})
      throw error
    } finally {
      tx.release()
    }

    const [after] = (await client.query(
      `select amount_allocated_cents from budgets where id = $1`, [budgetId])).rows
    assert(Number(after?.amount_allocated_cents) === amountCents, "post-commit read does not show the new allocation; investigate")
    for (const entry of await invalidateCachePrefixes(["budgets", "analytics", "branches"])) {
      if (entry.error) console.warn(`WARNING: cache prefix "${entry.prefix}" was not cleared: ${entry.error}`)
    }
  } finally {
    await closePool()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
