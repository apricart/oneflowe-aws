#!/usr/bin/env tsx
/**
 * Records the 18% sales tax already contained in the K-Electric legacy order
 * prices, on the orders that were imported with no tax breakdown at all.
 *
 * K-Electric confirmed the legacy export is tax-inclusive: the price on every
 * legacy line is the gross amount the branch paid, tax already inside it. The
 * importer never split that gross into its parts, so 800 orders carry
 * `tax_cents = 0`, all 7,693 legacy order lines carry a null `tax_rate_bp`,
 * and every legacy invoice prints "Tax 0.00" on an amount that demonstrably
 * contains tax.
 *
 * This is a restatement of what the numbers already are, not a repricing. The
 * split runs through `splitInclusiveCents` from lib/tax.ts — the same function
 * the live order path uses — so:
 *
 *   total_cents      NEVER CHANGES. It is the gross, and the gross is what was
 *                    paid. Every budget hold, spend figure and refund ceiling
 *                    derived from it is therefore untouched.
 *   tax_cents        becomes the tax contained in that gross, summed per line.
 *   subtotal_cents   becomes total_cents - tax_cents, i.e. the net.
 *
 * Before the change KE orders record subtotal == total with zero tax, which is
 * the shape an order has when nobody has split it. After it they match what
 * the application writes for a new order today.
 *
 * SCOPE — and one deliberate exclusion.
 *
 * 800 of the 820 KE orders are in scope. The other 20 already carry tax and are
 * left strictly alone, as instructed. Those 20 are worth knowing about though:
 * they were imported tax-EXCLUSIVE. Their tax is 18% ADDED ON TOP of the line
 * prices rather than contained in them, so their `total_cents` sits 18% above
 * the sum of their own lines:
 *
 *     KE-LEGACY-50   lines 35,500   tax 6,390   total 41,890
 *
 * On the tax-inclusive premise that total should be 35,500 with 5,415 of tax
 * inside it. Those 20 orders contradict the premise this script applies to the
 * other 800, and their inflated totals fed the budget spend figures. Correcting
 * them would move real money, so it needs its own decision and its own run.
 *
 * Every order is guarded individually: its line gross must equal both its
 * subtotal and its total before anything is written, so an order that is not a
 * clean untaxed gross aborts the run rather than being restated.
 *
 * Also rewritten: the `receipt_data` snapshot, so invoices print the same split
 * the order now records — per-line tax, netRate, netAmount and taxPercent, the
 * exact fields lib/receipt-generator.ts emits for a live order.
 *
 * Default mode is a read-only dry run.
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"

import { DEFAULT_TAX_RATE_BP, splitInclusiveCents } from "../lib/tax"
import { calculateLineCents } from "../lib/quantity"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const KE = { id: 10, code: "0001", name: "K-Electric" } as const
const CONFIRM_ORGANIZATION = `${KE.id}:${KE.code}:${KE.name}`
const LEGACY_SOURCE = "KE_LOGISTICS"
const ADVISORY_LOCK = 700015
const RATE_BP = DEFAULT_TAX_RATE_BP

interface OrderRow {
  id: number
  tid: string
  subtotalCents: number
  taxCents: number
  totalCents: number
  receiptData: Record<string, unknown> | null
}

interface LineRow {
  id: number
  orderId: number
  globalProductId: number
  priceCents: number
  quantity: number
  taxRateBp: number | null
  taxCents: number
}

/**
 * KE legacy orders with no tax recorded. Pinned to legacy_order_imports so an
 * order placed through the application can never be swept in, whatever its
 * tax happens to be. Orders already split drop out, so re-running is safe.
 */
const ORDER_QUERY = `
  select
    o.id,
    o.tid,
    o.subtotal_cents as "subtotalCents",
    o.tax_cents as "taxCents",
    o.total_cents as "totalCents",
    o.receipt_data as "receiptData"
  from orders o
  join legacy_order_imports li on li.order_id = o.id
  where o.organization_id = $1
    and li.organization_id = $1
    and li.source_system = $2
    and o.tax_cents = 0
  order by o.id
`

/** KE legacy orders that already carry tax — reported, never modified. */
const EXCLUDED_QUERY = `
  select
    o.id,
    o.tid,
    o.subtotal_cents as "subtotalCents",
    o.tax_cents as "taxCents",
    o.total_cents as "totalCents",
    (select coalesce(sum(round(oi.price_cents * oi.quantity)), 0)
       from order_items oi where oi.order_id = o.id) as "lineGrossCents"
  from orders o
  join legacy_order_imports li on li.order_id = o.id
  where o.organization_id = $1
    and li.organization_id = $1
    and li.source_system = $2
    and o.tax_cents > 0
  order by o.id
`

const LINE_QUERY = `
  select
    oi.id,
    oi.order_id as "orderId",
    oi.global_product_id as "globalProductId",
    oi.price_cents as "priceCents",
    oi.quantity,
    oi.tax_rate_bp as "taxRateBp",
    oi.tax_cents as "taxCents"
  from order_items oi
  where oi.order_id = any($1::int[])
  order by oi.order_id, oi.id
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

/** Money equality on the receipt's two-decimal rupee figures. */
function sameMoney(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005
}

interface PlannedLine {
  id: number
  globalProductId: number
  grossCents: number
  netCents: number
  taxCents: number
  /**
   * False for the 24 legacy lines that already violate
   * `order_items_values_valid_ck` (quantity 0). Postgres re-validates any row
   * an UPDATE touches, so writing a rate onto them is impossible — the whole
   * statement would be rejected. Every one of them is asserted to have zero
   * gross, so skipping the write costs nothing: their tax is zero regardless,
   * and the order total they contribute to is unaffected.
   */
  writable: boolean
}

/** The `order_items_values_valid_ck` predicate, evaluated before we touch a row. */
function satisfiesLineCheck(priceCents: number, quantity: number): boolean {
  return quantity > 0 && quantity <= 1_000_000 && priceCents >= 0
}

interface PlannedOrder {
  id: number
  tid: string
  totalCents: number
  previousSubtotalCents: number
  subtotalCents: number
  taxCents: number
  lines: PlannedLine[]
}

/**
 * Splits one order. Every guard here is a reason to abort rather than to skip:
 * an order whose lines do not reconstruct its own totals is not an untaxed
 * gross order, and restating it would move money.
 */
function planOrder(order: OrderRow, lines: LineRow[]): PlannedOrder {
  // bigint columns arrive from node-postgres as strings, so every money value
  // read off a row is coerced before it is compared or summed.
  assert(lines.length > 0, `Order ${order.id} (${order.tid}) has no lines`)
  assert(Number(order.taxCents) === 0, `Order ${order.id} already carries tax`)

  const planned: PlannedLine[] = lines.map((line) => {
    const priceCents = Number(line.priceCents)
    const quantity = Number(line.quantity)
    const grossCents = calculateLineCents(priceCents, quantity)
    const split = splitInclusiveCents(grossCents, RATE_BP)
    const writable = satisfiesLineCheck(priceCents, quantity)
    // A line we cannot write must carry no tax, or the order would record a
    // total whose components we are unable to store.
    assert(
      writable || grossCents === 0,
      `Order ${order.id} line ${line.id} violates order_items_values_valid_ck but has gross ${grossCents}`,
    )
    return {
      id: line.id,
      globalProductId: line.globalProductId,
      grossCents,
      netCents: split.netCents,
      taxCents: split.taxCents,
      writable,
    }
  })

  const lineGross = planned.reduce((sum, line) => sum + line.grossCents, 0)
  assert(
    lineGross === Number(order.subtotalCents),
    `Order ${order.id} (${order.tid}): line gross ${lineGross} != subtotal ${order.subtotalCents}`,
  )
  assert(
    lineGross === Number(order.totalCents),
    `Order ${order.id} (${order.tid}): line gross ${lineGross} != total ${order.totalCents}`,
  )

  const taxCents = planned.reduce((sum, line) => sum + line.taxCents, 0)
  const netCents = planned.reduce((sum, line) => sum + line.netCents, 0)
  assert(
    netCents + taxCents === Number(order.totalCents),
    `Order ${order.id} (${order.tid}): net + tax != total`,
  )

  return {
    id: order.id,
    tid: order.tid,
    totalCents: Number(order.totalCents),
    previousSubtotalCents: Number(order.subtotalCents),
    subtotalCents: netCents,
    taxCents,
    lines: planned,
  }
}

/**
 * Restates the receipt snapshot to print the split.
 *
 * Item gross is taken from the item's own `total`, not from the order line, so
 * the printed figures always reconcile against the printed total. The two are
 * asserted equal per product anyway before anything is written.
 *
 * `netRate` is left unrounded, matching `groupItemsHierarchically` in
 * lib/receipt-generator.ts, which divides the net line value by the quantity
 * without rounding.
 */
function restateReceipt(
  receipt: Record<string, unknown>,
  order: PlannedOrder,
): { receipt: Record<string, unknown>; itemTaxCents: number } {
  const byProduct = new Map(order.lines.map((line) => [line.globalProductId, line]))
  let itemTaxCents = 0

  const items = (receipt.items as Array<Record<string, unknown>>).map((group) => ({
    ...group,
    subCategories: (group.subCategories as Array<Record<string, unknown>>).map((sub) => ({
      ...sub,
      items: (sub.items as Array<Record<string, unknown>>).map((item) => {
        const grossCents = Math.round(Number(item.total ?? 0) * 100)
        const line = byProduct.get(Number(item.id))
        assert(line !== undefined, `Order ${order.id}: receipt item ${item.id} has no order line`)
        assert(
          line.grossCents === grossCents,
          `Order ${order.id}: receipt item ${item.id} gross ${grossCents} != line gross ${line.grossCents}`,
        )
        // The printed rate mirrors what the line row will actually hold, so an
        // unwritable zero-quantity line prints 0% rather than claiming a rate
        // its row does not carry. Its gross is zero, so the money is identical.
        const rateBp = line.writable ? RATE_BP : 0
        const split = splitInclusiveCents(grossCents, rateBp)
        itemTaxCents += split.taxCents
        const quantity = Number(item.quantity ?? 0)
        return {
          ...item,
          tax: split.taxCents / 100,
          netRate: quantity > 0 ? split.netCents / 100 / quantity : 0,
          netAmount: split.netCents / 100,
          taxPercent: rateBp / 100,
        }
      }),
    })),
  }))

  return {
    receipt: {
      ...receipt,
      items,
      subtotal: order.subtotalCents / 100,
      tax: order.taxCents / 100,
    },
    itemTaxCents,
  }
}

function planDigest(orders: PlannedOrder[]): string {
  const canonical = orders.map((order) =>
    [order.id, order.tid, order.totalCents, order.subtotalCents, order.taxCents, order.lines.length].join("|"))
  return createHash("sha256").update(canonical.join("\n")).digest("hex")
}

function reportPath(commit: boolean): string {
  const requested = arg("--output")
  if (requested) return resolve(requested)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return resolve(commit
    ? `backups/ke-legacy-order-tax-commit-${stamp}.json`
    : "deliverables/ke-legacy-order-tax-preflight.json")
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
    const organization = (await client.query(
      "select id, code, name from organizations where id = $1", [KE.id])).rows[0]
    assert(
      organization?.id === KE.id && organization.code === KE.code && organization.name === KE.name,
      "K-Electric organization identity mismatch",
    )

    const orders = (await client.query<OrderRow>(ORDER_QUERY, [KE.id, LEGACY_SOURCE])).rows
    const excluded = (await client.query(EXCLUDED_QUERY, [KE.id, LEGACY_SOURCE])).rows
    assert(orders.length > 0, "No K-Electric legacy order is missing its tax split; nothing to do")

    const lines = (await client.query<LineRow>(LINE_QUERY, [orders.map((o) => o.id)])).rows
    const linesByOrder = new Map<number, LineRow[]>()
    for (const line of lines) {
      if (!linesByOrder.has(line.orderId)) linesByOrder.set(line.orderId, [])
      linesByOrder.get(line.orderId)!.push(line)
    }

    const planned = orders.map((order) => planOrder(order, linesByOrder.get(order.id) ?? []))
    const digest = planDigest(planned)

    // Receipts are restated in the same pass so the dry run reports what the
    // commit will actually write rather than a promise about it.
    let receiptsToRewrite = 0
    for (const order of planned) {
      const source = orders.find((row) => row.id === order.id)!
      if (!source.receiptData || !Array.isArray(source.receiptData.items)) continue
      const { receipt, itemTaxCents } = restateReceipt(source.receiptData, order)
      assert(
        itemTaxCents === order.taxCents,
        `Order ${order.id}: receipt item tax ${itemTaxCents} != order tax ${order.taxCents}`,
      )
      assert(
        sameMoney(Number(receipt.totalAmount), order.totalCents / 100),
        `Order ${order.id}: receipt totalAmount would move`,
      )
      assert(
        sameMoney(Number(receipt.subtotal) + Number(receipt.tax), order.totalCents / 100),
        `Order ${order.id}: receipt subtotal + tax != totalAmount`,
      )
      receiptsToRewrite += 1
    }

    const totalGross = planned.reduce((sum, order) => sum + order.totalCents, 0)
    const totalTax = planned.reduce((sum, order) => sum + order.taxCents, 0)
    const totalNet = planned.reduce((sum, order) => sum + order.subtotalCents, 0)

    const unwritableLines = planned.flatMap((order) =>
      order.lines.filter((line) => !line.writable).map((line) => ({
        orderId: order.id, tid: order.tid, lineId: line.id, grossCents: line.grossCents,
      })))

    const summary = {
      organizationId: KE.id,
      taxRateBp: RATE_BP,
      ordersToSplit: planned.length,
      orderLinesToSplit: planned.reduce(
        (sum, order) => sum + order.lines.filter((line) => line.writable).length, 0),
      orderLinesSkippedAsZeroQuantity: unwritableLines.length,
      receiptsToRewrite,
      grossCentsUnchanged: totalGross,
      netCents: totalNet,
      taxCents: totalTax,
      ordersExcludedBecauseTheyAlreadyCarryTax: excluded.length,
    }

    const baseReport: Record<string, unknown> = {
      kind: "KE_LEGACY_ORDER_TAX_SPLIT",
      mode: commit ? "COMMIT_REQUESTED" : "DRY_RUN",
      generatedAt: new Date().toISOString(),
      organization,
      policy: {
        premise: "K-Electric legacy prices are tax-inclusive; the gross already contains 18% sales tax",
        scope: "K-Electric legacy orders (organization 10 + KE_LOGISTICS, pinned via legacy_order_imports) recording no tax",
        totalsUnchanged: "total_cents is the gross and is never written; budget holds, spend and refund ceilings derived from it are untouched",
        orderChange: "tax_cents := tax contained in the gross, summed per line; subtotal_cents := total_cents - tax_cents",
        lineChange: "tax_rate_bp := 1800 and tax_cents := the tax inside that line's gross",
        receiptChange: "receipt subtotal/tax restated and each line given tax, netRate, netAmount and taxPercent, matching lib/receipt-generator.ts",
        arithmetic: "splitInclusiveCents from lib/tax.ts — the same function the live order path uses; tax is derived by subtraction so net + tax === gross exactly",
        guard: "an order whose line gross does not equal both its subtotal and its total aborts the run rather than being restated",
        exclusion: "the 20 legacy orders that already carry tax are left untouched — they were imported tax-EXCLUSIVE, with tax added on top of their lines, and correcting that would move real money",
        zeroQuantityLines: "24 legacy lines already violate order_items_values_valid_ck (quantity 0); Postgres re-validates any row an UPDATE touches, so their rate is left null — each is asserted to have zero gross, so no tax goes unrecorded",
        notDone: "refunds keep tax_refund_cents = 0; a refund's tax breakdown is a separate decision on a separate table",
      },
      summary,
      excludedOrders: excluded,
      linesSkippedAsZeroQuantity: unwritableLines,
      planSha256: digest,
      requiredCommitArguments: {
        confirmOrganization: CONFIRM_ORGANIZATION,
        confirmPlanSha256: digest,
        expectedOrders: planned.length,
      },
      orders: planned.map((order) => ({
        id: order.id,
        tid: order.tid,
        totalCentsUnchanged: order.totalCents,
        subtotalCentsBefore: order.previousSubtotalCents,
        subtotalCentsAfter: order.subtotalCents,
        taxCentsAfter: order.taxCents,
        lines: order.lines.length,
      })),
    }

    if (!commit) {
      saveReport(output, baseReport)
      console.log(JSON.stringify({
        mode: "DRY_RUN", output, summary, planSha256: digest,
        requiredCommitArguments: baseReport.requiredCommitArguments,
      }, null, 2))
      return
    }

    assert(arg("--confirm-organization") === CONFIRM_ORGANIZATION, `--confirm-organization must equal ${CONFIRM_ORGANIZATION}`)
    assert(arg("--confirm-plan-sha256") === digest, "--confirm-plan-sha256 does not match")
    const expectedOrders = Number(arg("--expected-orders"))
    assert(
      Number.isSafeInteger(expectedOrders) && expectedOrders === planned.length,
      `--expected-orders must equal ${planned.length}`,
    )

    await client.query("begin")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
      const lockedOrders = (await client.query<OrderRow>(ORDER_QUERY, [KE.id, LEGACY_SOURCE])).rows
      const lockedLines = (await client.query<LineRow>(LINE_QUERY, [lockedOrders.map((o) => o.id)])).rows
      const lockedByOrder = new Map<number, LineRow[]>()
      for (const line of lockedLines) {
        if (!lockedByOrder.has(line.orderId)) lockedByOrder.set(line.orderId, [])
        lockedByOrder.get(line.orderId)!.push(line)
      }
      const lockedPlan = lockedOrders.map((order) => planOrder(order, lockedByOrder.get(order.id) ?? []))
      assert(planDigest(lockedPlan) === digest, "Order state changed after preflight; aborting")

      // The writes are batched rather than issued row by row: 7,583 lines plus
      // 800 orders plus 800 receipts is ~9,200 round trips to a remote database,
      // all inside one transaction holding an advisory lock. Every per-row guard
      // survives the batching — it moves into the join predicate, and a row that
      // fails it simply does not come back, which the row-count assert catches.

      // 1. The lines, guarded on the untouched price, quantity and null rate.
      const allLines = lockedPlan.flatMap((order) => order.lines).filter((line) => line.writable)
      const linesUpdated = await client.query(`
        update order_items oi
        set tax_rate_bp = $1, tax_cents = v.tax_cents
        from unnest($2::int[], $3::bigint[], $4::bigint[]) as v(id, tax_cents, gross_cents)
        where oi.id = v.id
          and oi.tax_rate_bp is null
          and oi.tax_cents = 0
          and round(oi.price_cents * oi.quantity) = v.gross_cents
        returning oi.id
      `, [
        RATE_BP,
        allLines.map((line) => line.id),
        allLines.map((line) => line.taxCents),
        allLines.map((line) => line.grossCents),
      ])
      assert(
        linesUpdated.rows.length === allLines.length,
        `Concurrent change: ${allLines.length - linesUpdated.rows.length} order line(s) did not match their guard`,
      )
      const linesWritten = linesUpdated.rows.length

      // 2. The orders. total_cents is deliberately absent from the SET list and
      //    asserted afterwards — the gross is what was paid and must not move.
      //    updated_at is left out too, so the restatement does not masquerade as
      //    an edit to the order.
      const ordersUpdated = await client.query(`
        update orders o
        set tax_cents = v.tax_cents, subtotal_cents = v.subtotal_cents
        from unnest($1::int[], $2::bigint[], $3::bigint[], $4::bigint[], $5::bigint[])
          as v(id, tax_cents, subtotal_cents, total_cents, prev_subtotal_cents)
        where o.id = v.id
          and o.organization_id = $6
          and o.tax_cents = 0
          and o.total_cents = v.total_cents
          and o.subtotal_cents = v.prev_subtotal_cents
        returning o.id, o.subtotal_cents as "subtotalCents", o.tax_cents as "taxCents", o.total_cents as "totalCents"
      `, [
        lockedPlan.map((order) => order.id),
        lockedPlan.map((order) => order.taxCents),
        lockedPlan.map((order) => order.subtotalCents),
        lockedPlan.map((order) => order.totalCents),
        lockedPlan.map((order) => order.previousSubtotalCents),
        KE.id,
      ])
      assert(
        ordersUpdated.rows.length === lockedPlan.length,
        `Concurrent change: ${lockedPlan.length - ordersUpdated.rows.length} order(s) did not match their guard`,
      )
      for (const row of ordersUpdated.rows) {
        const order = lockedPlan.find((candidate) => candidate.id === row.id)!
        assert(Number(row.totalCents) === order.totalCents, `Total moved on order ${order.id}`)
        assert(
          Number(row.subtotalCents) + Number(row.taxCents) === order.totalCents,
          `Order ${order.id} no longer reconciles`,
        )
      }

      // 3. The receipt snapshots, in chunks so no single statement carries all
      //    800 JSON documents.
      const restated: Array<{ id: number; json: string }> = []
      for (const order of lockedPlan) {
        const source = lockedOrders.find((row) => row.id === order.id)!
        if (!source.receiptData || !Array.isArray(source.receiptData.items)) continue
        const { receipt, itemTaxCents } = restateReceipt(source.receiptData, order)
        assert(itemTaxCents === order.taxCents, `Receipt item tax != order tax on ${order.id}`)
        restated.push({ id: order.id, json: JSON.stringify(receipt) })
      }

      let receiptsWritten = 0
      const CHUNK = 100
      for (let offset = 0; offset < restated.length; offset += CHUNK) {
        const chunk = restated.slice(offset, offset + CHUNK)
        const updated = await client.query(`
          update orders o
          set receipt_data = v.receipt::jsonb
          from unnest($1::int[], $2::text[]) as v(id, receipt)
          where o.id = v.id and o.organization_id = $3
          returning o.id
        `, [chunk.map((row) => row.id), chunk.map((row) => row.json), KE.id])
        assert(updated.rows.length === chunk.length, "Receipt update missed an order")
        receiptsWritten += updated.rows.length
      }

      const audit = await client.query(`
        insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
        values (null, $1, null, 'KE_LEGACY_ORDER_TAX_SPLIT', 'orders', $2, $3::jsonb)
        returning id
      `, [KE.id, digest.slice(0, 128), JSON.stringify({
        planSha256: digest,
        taxRateBp: RATE_BP,
        ordersSplit: lockedPlan.length,
        orderIds: lockedPlan.map((order) => order.id),
        linesSplit: linesWritten,
        linesSkippedAsZeroQuantity: unwritableLines.length,
        receiptsRewritten: receiptsWritten,
        grossCentsUnchanged: lockedPlan.reduce((sum, order) => sum + order.totalCents, 0),
        taxCentsRecorded: lockedPlan.reduce((sum, order) => sum + order.taxCents, 0),
        excludedOrderIds: excluded.map((row: Record<string, unknown>) => row.id),
        totalsModified: 0,
      })])
      await client.query("commit")

      // Post-commit verification on a fresh read.
      const verify = (await client.query(`
        select
          count(*)::int as "keOrders",
          count(*) filter (where o.tax_cents = 0)::int as "stillUntaxed",
          count(*) filter (where o.subtotal_cents + o.tax_cents <> o.total_cents)::int as "notReconciling",
          count(*) filter (where o.total_cents <> (
            select coalesce(sum(round(oi.price_cents * oi.quantity)), 0)
            from order_items oi where oi.order_id = o.id))::int as "totalNotEqualLineGross"
        from orders o where o.organization_id = $1
      `, [KE.id])).rows[0]
      const lineVerify = (await client.query(`
        select
          count(*)::int as "lines",
          count(*) filter (where oi.tax_rate_bp is null)::int as "withoutRate",
          count(*) filter (where oi.tax_cents = 0 and round(oi.price_cents * oi.quantity) > 0)::int as "untaxedNonZeroLines"
        from order_items oi where oi.organization_id = $1
      `, [KE.id])).rows[0]
      const receiptVerify = (await client.query(`
        select count(*)::int as "count" from orders o
        where o.organization_id = $1
          and abs(((o.receipt_data->>'subtotal')::numeric + (o.receipt_data->>'tax')::numeric)
                  - (o.receipt_data->>'totalAmount')::numeric) > 0.005
      `, [KE.id])).rows[0].count

      assert(Number(verify.notReconciling) === 0, "Some KE orders no longer reconcile")
      assert(Number(receiptVerify) === 0, "Some KE receipts no longer reconcile")

      const commitReport = {
        ...baseReport,
        mode: "COMMITTED",
        committedAt: new Date().toISOString(),
        auditLogId: audit.rows[0].id,
        validation: {
          ...verify,
          ...lineVerify,
          receiptsNotReconciling: Number(receiptVerify),
          linesSplit: linesWritten,
          receiptsRewritten: receiptsWritten,
        },
      }
      saveReport(output, commitReport)
      console.log(JSON.stringify({
        mode: "COMMITTED", output, summary,
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
