#!/usr/bin/env tsx

/**
 * Read-only. Measures how far K-Electric's budget ledger sits from what the
 * order-derived readers now report, and why.
 *
 * The K-Electric dataset is built on the **Asia/Karachi** month: the legacy
 * tenure that produced each allocation (`lib/legacy-import/ke-budgets.ts`), the
 * historical allocation import (`scripts/import-ke-branch-budgets.ts`) and the
 * spend backfill (`scripts/backfill-ke-budget-spend.ts`) all bucket on
 * `created_at at time zone 'Asia/Karachi'`. The ordering engine, and therefore
 * every reader that goes through `lib/budget-consumption.ts`, buckets on the
 * **UTC** month.
 *
 * The two disagree only for an order raised between 19:00 and 23:59:59 UTC on
 * the last day of a UTC month, which Karachi already calls the 1st of the next.
 * This script counts those orders, prices them, and says for each affected
 * branch-month what moving them would do to `budgets_values_valid_ck`.
 *
 * It writes nothing. There is no --commit, by design: see
 * `plans/OF-BUDGET-ledger-orders-parity.md` for why the K-Electric history is
 * reconciled against the customer's own Karachi months and should not be
 * re-bucketed.
 *
 *   npm run audit:ke-budget-periods -- --organization-code 0001
 */

import * as dotenv from "dotenv"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const DEFAULT_ORGANIZATION_CODE = "0001"

const SPENT_STATUSES = ["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"]
const HELD_STATUSES = ["PENDING", "APPROVED"]

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const rupees = (cents: number | string) =>
  `Rs ${(Number(cents) / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The connection's host, so a run against production is never a surprise. */
function describeTarget(): string {
  const url = process.env.DATABASE_URL
  if (!url) return "DATABASE_URL is not set"
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`
  } catch {
    return "unparseable DATABASE_URL"
  }
}

/**
 * Orders whose UTC month and Karachi month disagree: the only rows on which the
 * ledger's bucketing and the readers' bucketing can differ.
 */
const BOUNDARY_ORDERS_QUERY = `
  select
    o.branch_id                                                      as "branchId",
    br.name                                                          as "branchName",
    to_char(o.created_at at time zone 'UTC', 'YYYY-MM')              as "utcPeriod",
    to_char(o.created_at at time zone 'Asia/Karachi', 'YYYY-MM')     as "karachiPeriod",
    count(*)::int                                                    as "orderCount",
    coalesce(sum(case when upper(o.status) = any($2::text[])
      then greatest(0, o.total_cents - coalesce(o.refund_amount_cents, 0)) else 0 end), 0)::text as "spentCents",
    coalesce(sum(case when upper(o.status) = any($3::text[])
      then greatest(0, o.total_cents - coalesce(o.refund_amount_cents, 0)) else 0 end), 0)::text as "heldCents"
  from orders o
  join branches br
    on br.id = o.branch_id
   and br.organization_id = o.organization_id
  where o.organization_id = $1
    and to_char(o.created_at at time zone 'UTC', 'YYYY-MM')
      <> to_char(o.created_at at time zone 'Asia/Karachi', 'YYYY-MM')
  group by o.branch_id, br.name,
    to_char(o.created_at at time zone 'UTC', 'YYYY-MM'),
    to_char(o.created_at at time zone 'Asia/Karachi', 'YYYY-MM')
  order by "karachiPeriod", br.name
`

const LEDGER_QUERY = `
  select
    branch_id                  as "branchId",
    period,
    amount_allocated_cents     as "allocatedCents",
    amount_credited_cents      as "creditedCents",
    amount_spent_cents         as "spentCents",
    amount_held_cents          as "heldCents"
  from budgets
  where organization_id = $1
  order by branch_id, period
`

async function main() {
  const organizationCode = arg("--organization-code") ?? DEFAULT_ORGANIZATION_CODE
  console.log(`[audit] target   ${describeTarget()}`)
  console.log(`[audit] read-only — this script issues no INSERT, UPDATE or DELETE`)

  const { pool } = await import("../lib/db-cli")
  try {
    const [{ rows: sessionRows }, { rows: organizationRows }] = await Promise.all([
      pool.query("show timezone"),
      pool.query("select id, code, name from organizations where code = $1", [organizationCode]),
    ])
    const sessionTimeZone = sessionRows[0]?.TimeZone ?? sessionRows[0]?.timezone
    console.log(`[audit] postgres session TimeZone = ${sessionTimeZone}`)

    assert(organizationRows.length === 1, `No organization with code ${organizationCode}`)
    const organization = organizationRows[0]
    console.log(`[audit] organization ${organization.id} ${organization.code} ${organization.name}\n`)

    const [{ rows: boundaryRows }, { rows: ledgerRows }] = await Promise.all([
      pool.query(BOUNDARY_ORDERS_QUERY, [organization.id, SPENT_STATUSES, HELD_STATUSES]),
      pool.query(LEDGER_QUERY, [organization.id]),
    ])

    if (boundaryRows.length === 0) {
      console.log("No order in this tenant falls in a UTC/Karachi month disagreement.")
      console.log("The ledger's buckets and the readers' buckets describe the same months.")
      return
    }

    const ledger = new Map(ledgerRows.map((row: any) => [`${row.branchId}:${row.period}`, row]))

    let totalOrders = 0
    let totalConsumption = 0
    const unsafeMoves: string[] = []

    console.log("Orders whose UTC month and Karachi month disagree")
    console.log("─".repeat(100))
    for (const row of boundaryRows) {
      const consumption = Number(row.spentCents) + Number(row.heldCents)
      totalOrders += row.orderCount
      totalConsumption += consumption

      // The backfill filed this money under the Karachi month. A reader keyed
      // on UTC looks for it under the UTC month instead.
      const target = ledger.get(`${row.branchId}:${row.utcPeriod}`)
      const source = ledger.get(`${row.branchId}:${row.karachiPeriod}`)

      console.log(
        `${row.branchName.padEnd(28).slice(0, 28)} ` +
        `ledger ${row.karachiPeriod} → readers ${row.utcPeriod}  ` +
        `${String(row.orderCount).padStart(4)} orders  ${rupees(consumption).padStart(18)}`,
      )

      if (!target) {
        unsafeMoves.push(
          `${row.branchName} ${row.utcPeriod}: no budget row exists for the UTC month — a move would have to open one`,
        )
        continue
      }
      // Would the receiving month still satisfy allocated + credited - spent - held >= 0?
      const headroom =
        Number(target.allocatedCents) + Number(target.creditedCents) -
        Number(target.spentCents) - Number(target.heldCents)
      if (headroom < consumption) {
        unsafeMoves.push(
          `${row.branchName} ${row.utcPeriod}: only ${rupees(headroom)} of headroom for ${rupees(consumption)} — ` +
          `moving it would violate budgets_values_valid_ck`,
        )
      }
      if (source && Number(source.spentCents) + Number(source.heldCents) < consumption) {
        unsafeMoves.push(
          `${row.branchName} ${row.karachiPeriod}: the ledger holds less than this — the backfill's figure was ` +
          `overwritten since, so a move cannot be derived from the orders alone`,
        )
      }
    }

    console.log("─".repeat(100))
    console.log(`${totalOrders} orders, ${rupees(totalConsumption)} of consumption, across ${boundaryRows.length} branch-months\n`)

    if (unsafeMoves.length > 0) {
      console.log("Re-bucketing would not be safe for:")
      unsafeMoves.forEach((line) => console.log(`  - ${line}`))
      console.log("")
    }

    console.log("Reading of this report:")
    console.log("  The K-Electric ledger is keyed on the Karachi month throughout — allocations from")
    console.log("  legacy's own tenure, and spend from the backfill — and was reconciled to the rupee")
    console.log("  against legacy's remaining figure. The readers are keyed on the UTC month, which is")
    console.log("  the month the ordering engine holds against. For the orders above the two name")
    console.log("  different months. See plans/OF-BUDGET-ledger-orders-parity.md before changing either.")
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
