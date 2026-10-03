#!/usr/bin/env tsx
/**
 * Fill `orders.created_by_role` for rows written before the column existed.
 *
 * The column records the role an order's creator held when they raised it, so
 * that changing a user's role later cannot rewrite months of attribution
 * reporting. New orders populate it at insert; this fills the history.
 *
 * The value backfilled is each creator's **current** role, which is the same
 * answer every one of those reports gives today — this makes the stored column
 * agree with the live join at the moment it runs, and from then on the stored
 * value stops moving while the live one may. Until a row is filled, readers
 * fall back to the live join (`lib/server/order-creator-role-sql.ts`), so the
 * reports return identical numbers before, during and after this run.
 *
 * Known imprecision, recorded rather than special-cased: a user whose role was
 * already changed before this ran has their *earlier* orders stamped with the
 * role they hold now. Exactly one account is known to be in that position (a KE
 * account moved to GROUP_ORDER_PORTAL on 2026-09-18). Both its roles are
 * requester roles, so no report changes; only the orders list `createdByRole`
 * tab would file those rows under the newer role.
 *
 * Default mode is a read-only preflight that prints a plan and its digest.
 * Commit mode requires that digest and refuses if the plan moved underneath it.
 * Only NULL rows are ever written — a filled value is never overwritten, so the
 * script is re-runnable and cannot clobber a role recorded at insert time.
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ADVISORY_LOCK = 700042
/** Rows per UPDATE, so a large orders table is not locked in one statement. */
const BATCH_SIZE = 5_000

function arg(name: string): string | undefined {
  const withEquals = process.argv.find((value) => value.startsWith(`${name}=`))
  if (withEquals) return withEquals.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

type PlanRow = {
  roleName: string
  organizationId: number | null
  orderCount: number
}

type Plan = {
  totalUnfilled: number
  totalAlreadyFilled: number
  orphanedOrders: number
  rows: PlanRow[]
}

async function buildPlan(client: PoolClient, organizationId: number | null): Promise<Plan> {
  const tenantFilter = organizationId === null ? "" : "and o.organization_id = $1"
  const params = organizationId === null ? [] : [organizationId]

  const { rows } = await client.query(
    `select r.name as role_name, o.organization_id, count(*)::bigint as order_count
       from orders o
       join users u on u.id = o.created_by_user_id
       join roles r on r.id = u.role_id
      where o.created_by_role is null ${tenantFilter}
      group by r.name, o.organization_id
      order by r.name, o.organization_id`,
    params,
  )

  const [{ filled }] = (await client.query(
    `select count(*)::bigint as filled from orders o
      where o.created_by_role is not null ${tenantFilter}`,
    params,
  )).rows

  // An order whose creator row is gone cannot be attributed. Reported, never
  // guessed at: writing a role for it would invent history.
  const [{ orphaned }] = (await client.query(
    `select count(*)::bigint as orphaned from orders o
      where o.created_by_role is null
        and not exists (select 1 from users u where u.id = o.created_by_user_id)
        ${tenantFilter}`,
    params,
  )).rows

  const planRows: PlanRow[] = rows.map((row) => ({
    roleName: String(row.role_name),
    organizationId: row.organization_id === null ? null : Number(row.organization_id),
    orderCount: Number(row.order_count),
  }))

  return {
    totalUnfilled: planRows.reduce((sum, row) => sum + row.orderCount, 0),
    totalAlreadyFilled: Number(filled),
    orphanedOrders: Number(orphaned),
    rows: planRows,
  }
}

function planDigest(plan: Plan): string {
  return sha256(JSON.stringify(plan.rows.map((row) => [
    row.roleName,
    row.organizationId,
    row.orderCount,
  ])))
}

function describe(plan: Plan, digest: string, organizationId: number | null): string[] {
  const lines: string[] = []
  lines.push("")
  lines.push("Backfill orders.created_by_role")
  lines.push(`  scope .................. ${organizationId === null ? "every organization" : `organization ${organizationId}`}`)
  lines.push(`  already recorded ....... ${plan.totalAlreadyFilled}`)
  lines.push(`  to fill ................ ${plan.totalUnfilled}`)
  if (plan.orphanedOrders > 0) {
    lines.push(`  creator row missing .... ${plan.orphanedOrders} (left NULL; cannot be attributed)`)
  }
  lines.push("")
  for (const row of plan.rows) {
    lines.push(`  ${row.roleName.padEnd(20)} org ${String(row.organizationId ?? "-").padEnd(6)} ${row.orderCount}`)
  }
  lines.push("")
  lines.push(`  plan digest ............ ${digest}`)
  return lines
}

function writeReport(plan: Plan, digest: string, committed: boolean, outputPath?: string): void {
  if (!outputPath) return
  const target = resolve(outputPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify({
    generatedAt: new Date().toISOString(),
    committed,
    planSha256: digest,
    plan,
  }, null, 2))
  console.log(`  report ................. ${target}`)
}

async function preflight(client: PoolClient, organizationId: number | null): Promise<void> {
  const plan = await buildPlan(client, organizationId)
  const digest = planDigest(plan)
  console.log(describe(plan, digest, organizationId).join("\n"))
  console.log("")
  console.log("  Dry run. Nothing was written. To apply:")
  console.log(`    npm run backfill:order-creator-roles -- --commit --confirm-plan-sha256=${digest}`)
  console.log("")
  writeReport(plan, digest, false, arg("--output"))
}

async function commit(client: PoolClient, organizationId: number | null): Promise<void> {
  const plan = await buildPlan(client, organizationId)
  const digest = planDigest(plan)
  assert(
    arg("--confirm-plan-sha256") === digest,
    "--confirm-plan-sha256 does not match the current plan; re-run the preflight",
  )

  console.log(describe(plan, digest, organizationId).join("\n"))

  await client.query("begin")
  try {
    // Serialises concurrent runs of this script. It does not block the
    // application: each batch takes its own row locks and commits with the
    // transaction below.
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])

    const tenantFilter = organizationId === null ? "" : "and o.organization_id = $2"
    const params: unknown[] = organizationId === null ? [BATCH_SIZE] : [BATCH_SIZE, organizationId]

    let written = 0
    for (;;) {
      const { rowCount } = await client.query(
        `update orders o
            set created_by_role = r.name
           from users u
           join roles r on r.id = u.role_id
          where u.id = o.created_by_user_id
            and o.created_by_role is null
            ${tenantFilter}
            and o.id in (
              select id from orders
               where created_by_role is null
               order by id
               limit $1
            )`,
        params,
      )
      if (!rowCount) break
      written += rowCount
      console.log(`  filled ................. ${written}/${plan.totalUnfilled}`)
    }

    await client.query("commit")
    console.log("")
    console.log(`  Committed. ${written} order(s) now record the role they were raised under.`)
    if (plan.orphanedOrders > 0) {
      console.log(`  ${plan.orphanedOrders} left NULL: the creator row no longer exists.`)
    }
    console.log("")
    writeReport(plan, digest, true, arg("--output"))
  } catch (error) {
    await client.query("rollback")
    throw error
  }
}

async function main(): Promise<void> {
  const organizationIdArg = arg("--organization-id")
  const organizationId = organizationIdArg ? Number(organizationIdArg) : null
  assert(
    organizationId === null || Number.isInteger(organizationId),
    "--organization-id must be an integer",
  )

  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    if (process.argv.includes("--commit")) await commit(client, organizationId)
    else await preflight(client, organizationId)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
