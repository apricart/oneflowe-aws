#!/usr/bin/env tsx
/**
 * Would any warehouse account's work change if warehouses decided it?
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2, decision 5).
 *
 * Read-only: one transaction marked `READ ONLY` (transaction-scoped — never a
 * session setting, which the production pooler would leak to the app) and
 * always rolled back. It runs the application's own reach loader
 * (`loadWarehouseReach`) for every active warehouse account in each mode —
 * never a copy of its rules — and compares.
 *
 *   npm run check:warehouse-ownership                       # gate: membership-fallback
 *   npm run check:warehouse-ownership -- --target=membership
 *
 * Exits 0 only when the target mode would change nothing for any account (and,
 * for "membership", no open order is left in no warehouse) — the condition for
 * moving `WAREHOUSE_ORDER_OWNERSHIP` to the target. Writes the full report to
 * `updatedReports/` (git-ignored).
 *
 * Reads DATABASE_URL (the shell's, else .env.local's). The host is printed
 * first: check it before reading the result.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { sql } from "drizzle-orm"
import { TransactionRollbackError } from "drizzle-orm/errors"

const TARGETS = ["membership-fallback", "membership"] as const
type Target = (typeof TARGETS)[number]

function arg(name: string): string | undefined {
  const flag = `--${name}=`
  return process.argv.find((value) => value.startsWith(flag))?.slice(flag.length)
}

async function main(): Promise<void> {
  const target = (arg("target") ?? "membership-fallback") as Target
  if (!TARGETS.includes(target)) throw new Error(`--target must be one of ${TARGETS.join(", ")}`)

  const { db, closePool } = await import("../lib/db-cli")
  const { databaseToolEnv } = await import("../lib/server/database-tool-env")
  const { runWarehouseOwnershipCheck } = await import("../lib/server/warehouse-ownership-check")
  console.log(`[check] database: ${new URL(databaseToolEnv.DATABASE_URL).host}`)

  type Report = Awaited<ReturnType<typeof runWarehouseOwnershipCheck>>
  let report: Report | null = null
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`)
      report = await runWarehouseOwnershipCheck(tx)
      tx.rollback()
    }).catch((error: unknown) => {
      if (!(error instanceof TransactionRollbackError)) throw error
    })
  } finally {
    await closePool()
  }
  const result = report as Report | null
  if (!result) throw new Error("The check produced no report")

  const output = resolve(process.cwd(), arg("output")
    ?? `updatedReports/warehouse-ownership-check-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`)
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600 })

  const username = new Map(result.accounts.map((account) => [account.id, account.username ?? account.id]))
  console.log(`[check] active warehouse accounts: ${result.accounts.length}`)
  for (const account of result.accounts) console.log(`          ${account.username ?? account.id}: ${account.branchCount} branches today`)
  for (const mode of TARGETS) {
    const differences = result.differences[mode]
    console.log(`[check] ${mode}: ${result.ready[mode] ? "NO CHANGE" : "CHANGES"}`)
    for (const difference of differences) {
      console.log(`          ${username.get(difference.accountId) ?? difference.accountId}: loses ${difference.lost.length}`
        + `${difference.lost.length ? ` (${difference.lost.slice(0, 20).join(", ")}${difference.lost.length > 20 ? ", …" : ""})` : ""}`
        + `, gains ${difference.gained.length}`
        + `${difference.gained.length ? ` (${difference.gained.slice(0, 20).join(", ")}${difference.gained.length > 20 ? ", …" : ""})` : ""}`)
    }
  }
  console.log(`[check] open orders whose branch is in no warehouse: ${result.unroutedOpenOrders}`)
  for (const stranded of result.strandedBranches) {
    console.log(`[check] ${stranded.code}: ${stranded.branches} active branch(es) no operator works`)
  }
  console.log(`[check] report: ${output}`)

  if (!result.ready[target]) {
    console.log(`\n[check] NOT READY for "${target}". Do not move WAREHOUSE_ORDER_OWNERSHIP.`)
    process.exitCode = 1
    return
  }
  console.log(`\n[check] Ready for "${target}": no warehouse account's branches would change.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
