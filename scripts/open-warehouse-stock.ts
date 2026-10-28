#!/usr/bin/env tsx
/**
 * Open each named Apricart warehouse's stock from today's global figures.
 * See plans/OF-STOCK-per-warehouse-stock.md.
 *
 * Every named warehouse gets, per product, today's `global_products.stock_quantity`
 * **plus** what open orders (pending, or approved and not yet In Process) hold
 * of it. The global figure is already net of those orders, and they are
 * reserved again once stock is counted per warehouse — so each warehouse's
 * *available* figure opens at exactly today's, and every open order can be
 * packed at whichever warehouse ends up fulfilling it. The planning is pure
 * (`planOpeningBalances` in `lib/warehouse-stock.ts`).
 *
 *   npm run open:warehouse-stock -- --warehouses=KARACHI-001,LAHORE-001
 *   npm run open:warehouse-stock -- --warehouses=... --commit --confirm-plan-sha256=<digest> --operator=<you>
 *   npm run open:warehouse-stock -- --rollback=<committed report>.json --confirm-rollback=<printed>
 *
 * Writes only `warehouse_stock`, `stock_movements` (one OPENING row each, with
 * this run's batch id) and one `audit_logs` row. Never touches an order, a
 * product, a price or the global figure, and never a (warehouse, product) pair
 * that already has a stock row. Changes nothing anyone sees while
 * `STOCK_LEDGER_MODE` is "global".
 *
 * Reads DATABASE_URL (the shell's, else .env.local's). The host is printed first.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"

import {
  apricartWarehouses,
  auditLogs,
  branches,
  globalProducts,
  orderItems,
  orders,
  stockMovements,
  warehouseStock,
} from "../db/schema"
import { planOpeningBalances, stockKey, type OpeningBalancePlan } from "../lib/warehouse-stock"

/** Serializes this script with itself; unique among the repository's script locks. */
const ADVISORY_LOCK = 700041
const AUDIT_ACTION = "OPEN_WAREHOUSE_STOCK"
const ROLLBACK_AUDIT_ACTION = "OPEN_WAREHOUSE_STOCK_ROLLBACK"
const REPORT_KIND = "OPEN_WAREHOUSE_STOCK"

type DbCli = typeof import("../lib/db-cli")
type Db = DbCli["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Client = Db | Tx

interface CommitReport {
  kind: typeof REPORT_KIND
  mode: "COMMITTED"
  planSha256: string
  batchId: string
  auditLogId: number
  inserted: Array<{ warehouseId: number; globalProductId: number; onHand: number }>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function arg(name: string): string | undefined {
  const flag = `--${name}=`
  return process.argv.find((value) => value.startsWith(flag))?.slice(flag.length)
}

const flag = (name: string) => process.argv.includes(`--${name}`)
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

const planDigest = (plan: OpeningBalancePlan) =>
  sha256(JSON.stringify(plan.rows.map((row) => [row.warehouseId, row.globalProductId, row.onHand])))

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
}

function parseCodes(): string[] {
  const raw = arg("warehouses")
  assert(raw, "Name the warehouses to open: --warehouses=KARACHI-001,LAHORE-001")
  const codes = [...new Set(raw.split(",").map((code) => code.trim().toUpperCase()).filter(Boolean))]
  assert(codes.length > 0, "Name at least one warehouse code")
  return codes
}

/** Everything the plan depends on, read through `client`. */
async function readState(client: Client, codes: string[]) {
  const warehouses = await client
    .select({ id: apricartWarehouses.id, code: apricartWarehouses.code, status: apricartWarehouses.status })
    .from(apricartWarehouses)
    .where(inArray(apricartWarehouses.code, codes))
    .orderBy(asc(apricartWarehouses.id))
  const missing = codes.filter((code) => !warehouses.some((warehouse) => warehouse.code === code))
  assert(missing.length === 0, `No warehouse with code ${missing.join(", ")}`)

  const products = await client
    .select({ id: globalProducts.id, stockQuantity: globalProducts.stockQuantity })
    .from(globalProducts)
    .where(isNull(globalProducts.deletedAt))
    .orderBy(asc(globalProducts.id))

  const open = await client
    .select({ productId: orderItems.globalProductId, quantity: sql<string>`sum(${orderItems.quantity})` })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(branches, eq(branches.id, orders.branchId))
    .where(sql`(UPPER(${orders.status}) = 'PENDING' OR (UPPER(${orders.status}) = 'APPROVED' AND COALESCE(UPPER(${orders.fulfillmentStatus}), 'NOT_STARTED') = 'NOT_STARTED'))`)
    .groupBy(orderItems.globalProductId)

  const existing = await client
    .select({ warehouseId: warehouseStock.warehouseId, globalProductId: warehouseStock.globalProductId })
    .from(warehouseStock)
    .where(inArray(warehouseStock.warehouseId, warehouses.map((warehouse) => warehouse.id)))

  return {
    warehouses,
    input: {
      warehouses,
      products: products.map((product) => ({ id: product.id, stockQuantity: Number(product.stockQuantity) })),
      openQuantityByProduct: new Map(open.map((row) => [row.productId, Number(row.quantity)])),
      existing: new Set(existing.map((row) => stockKey(row.warehouseId, row.globalProductId))),
    },
    openOrderLines: open.length,
  }
}

async function main(): Promise<void> {
  const { db, closePool } = await import("../lib/db-cli")
  const { databaseToolEnv } = await import("../lib/server/database-tool-env")
  console.log(`[open-warehouse-stock] database: ${new URL(databaseToolEnv.DATABASE_URL).host}`)
  try {
    const rollbackPath = arg("rollback")
    if (rollbackPath) {
      await rollback(db, resolve(process.cwd(), rollbackPath))
      return
    }

    const codes = parseCodes()
    const output = resolve(process.cwd(),
      arg("output") ?? `updatedReports/open-warehouse-stock-${new Date().toISOString().slice(0, 10)}.json`)

    const state = await readState(db, codes)
    const plan = planOpeningBalances(state.input)
    const digest = planDigest(plan)
    const summary = {
      warehouses: state.warehouses.map((warehouse) => ({
        code: warehouse.code,
        rows: plan.rows.filter((row) => row.warehouseId === warehouse.id).length,
        units: plan.rows.filter((row) => row.warehouseId === warehouse.id).reduce((sum, row) => sum + row.onHand, 0),
      })),
      productsRead: state.input.products.length,
      productsWithOpenOrders: state.openOrderLines,
      skippedExisting: plan.skippedExisting,
    }
    const report = { kind: REPORT_KIND, mode: "DRY_RUN" as const, generatedAt: new Date().toISOString(), codes, planSha256: digest, summary, plan }

    if (plan.refusals.length > 0) {
      saveJson(output, report)
      console.log(JSON.stringify({ refusals: plan.refusals, output }, null, 2))
      console.log("\nRefused: nothing can be written until every refusal above is resolved.")
      process.exitCode = 1
      return
    }
    if (plan.rows.length === 0) {
      console.log("Nothing to do: every product of the named warehouses already has a stock row, or none has stock.")
      return
    }
    if (!flag("commit")) {
      saveJson(output, report)
      console.log(JSON.stringify({ mode: "DRY_RUN", output, planSha256: digest, summary }, null, 2))
      console.log("\nDry run: nothing was written. To apply exactly this plan:")
      console.log(`  npm run open:warehouse-stock -- --warehouses=${codes.join(",")} \\`)
      console.log(`    --commit --confirm-plan-sha256=${digest} --operator=<you@example.com>`)
      return
    }

    const operator = arg("operator")
    assert(operator, "Commit requires --operator=<who is running this>")
    assert(arg("confirm-plan-sha256") === digest, `Commit requires --confirm-plan-sha256=${digest}`)
    const batchId = `opening-${digest.slice(0, 40)}`

    const committed = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK})`)
      await tx.select({ id: apricartWarehouses.id }).from(apricartWarehouses)
        .where(inArray(apricartWarehouses.code, codes)).orderBy(asc(apricartWarehouses.id)).for("update")

      // Rebuild under the lock; an order or a figure that moved since the dry
      // run changes the digest and nothing is written.
      const locked = await readState(tx, codes)
      const lockedPlan = planOpeningBalances(locked.input)
      assert(lockedPlan.refusals.length === 0, `Refused under the lock: ${lockedPlan.refusals.join("; ")}`)
      assert(planDigest(lockedPlan) === digest, "Stock or open orders changed after the dry run; run the dry run again")

      const now = new Date()
      for (const row of lockedPlan.rows) {
        const inserted = await tx.insert(warehouseStock)
          .values({ warehouseId: row.warehouseId, globalProductId: row.globalProductId, onHandQuantity: row.onHand, createdAt: now, updatedAt: now })
          .onConflictDoNothing({ target: [warehouseStock.warehouseId, warehouseStock.globalProductId] })
          .returning({ id: warehouseStock.id })
        assert(inserted.length === 1, `A stock row for warehouse ${row.warehouseId}, product ${row.globalProductId} appeared during the run`)
        await tx.insert(stockMovements).values({
          warehouseId: row.warehouseId,
          globalProductId: row.globalProductId,
          movementType: "OPENING",
          quantityDelta: row.onHand,
          balanceAfter: row.onHand,
          reason: "Opening figure from the global stock",
          batchId,
          actorRole: "SCRIPT",
          createdAt: now,
        })
      }

      const [audit] = await tx.insert(auditLogs).values({
        userId: null,
        organizationId: null,
        branchId: null,
        action: AUDIT_ACTION,
        entity: "warehouse_stock",
        entityId: batchId,
        metadata: { planSha256: digest, batchId, operator, codes, summary },
      }).returning({ id: auditLogs.id })
      assert(audit?.id, "Failed to write the audit row")
      return { auditLogId: audit.id, inserted: lockedPlan.rows }
    })

    const rollbackConfirmation = `ROLLBACK:${committed.auditLogId}:${REPORT_KIND}`
    saveJson(output, {
      ...report,
      mode: "COMMITTED",
      committedAt: new Date().toISOString(),
      operator,
      batchId,
      auditLogId: committed.auditLogId,
      inserted: committed.inserted,
      rollbackConfirmation,
    })
    console.log(JSON.stringify({
      mode: "COMMITTED",
      output,
      auditLogId: committed.auditLogId,
      rows: committed.inserted.length,
      rollbackConfirmation,
    }, null, 2))
  } finally {
    await closePool()
  }
}

/**
 * Remove exactly the stock rows a committed run created, if each still holds
 * its opening figure and nothing else has moved it. Otherwise nothing is
 * removed and every pair that moved is named.
 */
async function rollback(db: Db, reportPath: string): Promise<void> {
  assert(existsSync(reportPath), `Commit report not found: ${reportPath}`)
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as CommitReport
  assert(report.kind === REPORT_KIND && report.mode === "COMMITTED", "Not a committed open-warehouse-stock report")
  const expected = `ROLLBACK:${report.auditLogId}:${REPORT_KIND}`
  assert(arg("confirm-rollback") === expected, `--confirm-rollback must equal ${expected}`)

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK})`)
    const moved: string[] = []
    for (const row of report.inserted) {
      const [stock] = await tx
        .select({ onHand: warehouseStock.onHandQuantity })
        .from(warehouseStock)
        .where(and(eq(warehouseStock.warehouseId, row.warehouseId), eq(warehouseStock.globalProductId, row.globalProductId)))
        .for("update")
      const [{ others }] = await tx
        .select({ others: sql<number>`count(*)`.mapWith(Number) })
        .from(stockMovements)
        .where(and(
          eq(stockMovements.warehouseId, row.warehouseId),
          eq(stockMovements.globalProductId, row.globalProductId),
          sql`${stockMovements.batchId} IS DISTINCT FROM ${report.batchId}`,
        ))
      if (!stock || Number(stock.onHand) !== row.onHand || others > 0) moved.push(`${row.warehouseId}:${row.globalProductId}`)
    }
    assert(moved.length === 0, `Stock moved since the opening at ${moved.length} pair(s), so nothing was removed: ${moved.slice(0, 50).join(", ")}`)

    await tx.execute(sql`SELECT set_config('oneflowe.stock_ledger_rollback_batch', ${report.batchId}, true)`)
    await tx.delete(stockMovements).where(eq(stockMovements.batchId, report.batchId))
    for (const row of report.inserted) {
      await tx.delete(warehouseStock)
        .where(and(eq(warehouseStock.warehouseId, row.warehouseId), eq(warehouseStock.globalProductId, row.globalProductId)))
    }
    await tx.insert(auditLogs).values({
      userId: null,
      organizationId: null,
      branchId: null,
      action: ROLLBACK_AUDIT_ACTION,
      entity: "warehouse_stock",
      entityId: String(report.auditLogId),
      metadata: { planSha256: report.planSha256, batchId: report.batchId, removed: report.inserted.length },
    })
  })
  console.log(JSON.stringify({ mode: "ROLLED_BACK", removed: report.inserted.length }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
