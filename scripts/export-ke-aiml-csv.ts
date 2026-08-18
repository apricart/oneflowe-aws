#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "csv-parse/sync"
import type { PoolClient } from "pg"

import { closePool, pool } from "../lib/db-cli"
import { createCsv } from "../lib/spreadsheet"

const ORGANIZATION = { id: 10, name: "K-Electric" } as const
const APP_TIME_ZONE = "Asia/Karachi"
const HISTORY_START_DATE = "2025-01-01"
const DEFAULT_OUTPUT_DIRECTORY = "deliverables/ke-aiml-csv"

type CsvValue = string | number | null

type ExportClock = {
  as_of_date: string
  exported_at: string
}

type DailySpendRow = {
  organization_id: number
  organization_name: string
  branch_id: number
  branch_name: string
  order_date: string
  orders_count: number
  spend_cents: string
  fulfilled_spend_cents: string
  approved_spend_cents: string
  pending_spend_cents: string
}

type SnapshotRow = {
  organization_id: number
  organization_name: string
  branch_id: number
  branch_name: string
  period: string
  as_of_date: string
  amount_allocated_cents: string
  amount_spent_cents: string
  amount_held_cents: string
  amount_credited_cents: string
  remaining_cents: string
}

type CompleteSnapshotRow = SnapshotRow & {
  snapshot_source: "OBSERVED" | "RECONSTRUCTED"
}

type OrderLineRow = {
  order_id: number
  branch_id: number
  order_date: string
  global_product_id: number
  product_name: string
  category_id: number | null
  category_name: string | null
  quantity: string
  line_total_cents: string
}

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)

  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function rows<T>(client: PoolClient, query: string, parameters: unknown[] = []): Promise<T[]> {
  return (await client.query(query, parameters)).rows as T[]
}

function csvContents(headers: string[], csvRows: CsvValue[][]): string {
  return `${createCsv(headers, csvRows)}\r\n`
}

function writeCsv(path: string, contents: string): string {
  writeFileSync(path, contents, "utf8")
  return createHash("sha256").update(contents).digest("hex")
}

function snapshotKey(row: SnapshotRow): string {
  return `${row.organization_id}:${row.branch_id}:${row.period}:${row.as_of_date}`
}

function parseSnapshotCsv(path: string): SnapshotRow[] {
  if (!existsSync(path)) throw new Error(`Snapshot seed does not exist: ${path}`)

  const parsed = parse(readFileSync(path, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Array<Record<string, string>>

  return parsed
    .filter((row) => Number(row.organization_id) === ORGANIZATION.id)
    .map((row) => ({
      organization_id: Number(row.organization_id),
      organization_name: row.organization_name,
      branch_id: Number(row.branch_id),
      branch_name: row.branch_name,
      period: row.period,
      as_of_date: row.as_of_date,
      amount_allocated_cents: row.amount_allocated_cents,
      amount_spent_cents: row.amount_spent_cents,
      amount_held_cents: row.amount_held_cents,
      amount_credited_cents: row.amount_credited_cents,
      remaining_cents: row.remaining_cents,
    }))
}

function validateSnapshot(row: SnapshotRow): void {
  if (row.organization_id !== ORGANIZATION.id || row.organization_name !== ORGANIZATION.name) {
    throw new Error(`Unexpected snapshot tenant: ${row.organization_id}:${row.organization_name}`)
  }

  const allocated = BigInt(row.amount_allocated_cents)
  const spent = BigInt(row.amount_spent_cents)
  const held = BigInt(row.amount_held_cents)
  const credited = BigInt(row.amount_credited_cents)
  const remaining = BigInt(row.remaining_cents)

  if ([allocated, spent, held, credited].some((value) => value < BigInt(0))) {
    throw new Error(`Negative budget input in snapshot ${snapshotKey(row)}`)
  }
  if (remaining !== allocated + credited - spent - held) {
    throw new Error(`Remaining-budget formula mismatch in snapshot ${snapshotKey(row)}`)
  }
}

async function run(): Promise<void> {
  const outputDirectory = resolve(argument("--output-dir") || DEFAULT_OUTPUT_DIRECTORY)
  const dailySpendPath = resolve(outputDirectory, "CSV_1_daily_order_spend.csv")
  const snapshotsPath = resolve(outputDirectory, "CSV_2_budget_remaining_snapshots.csv")
  const observedSnapshotsPath = resolve(outputDirectory, "supporting_observed_budget_snapshots.csv")
  const orderLinesPath = resolve(outputDirectory, "CSV_3_order_lines.csv")
  const explicitSeedPath = argument("--seed-snapshot")
  const snapshotSeedPath = explicitSeedPath ? resolve(explicitSeedPath) : undefined
  const client = await pool.connect()

  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")

    const [clock] = await rows<ExportClock>(client, `
      select
        (transaction_timestamp() at time zone '${APP_TIME_ZONE}')::date::text as as_of_date,
        transaction_timestamp()::text as exported_at
    `)

    const [tenant] = await rows<{ id: number; name: string }>(client, `
      select id, name
      from organizations
      where id = $1
    `, [ORGANIZATION.id])
    if (tenant?.id !== ORGANIZATION.id || tenant.name !== ORGANIZATION.name) {
      throw new Error(`K-Electric tenant identity check failed: ${JSON.stringify(tenant)}`)
    }

    const dailySpend = await rows<DailySpendRow>(client, `
      select
        organization.id as organization_id,
        organization.name as organization_name,
        branch.id as branch_id,
        branch.name as branch_name,
        (orders.created_at at time zone '${APP_TIME_ZONE}')::date::text as order_date,
        count(*)::int as orders_count,
        coalesce(sum(orders.total_cents), 0)::text as spend_cents,
        coalesce(sum(orders.total_cents) filter (
          where upper(orders.status) = 'FULFILLED'
        ), 0)::text as fulfilled_spend_cents,
        coalesce(sum(orders.total_cents) filter (
          where upper(orders.status) in ('APPROVED', 'FULFILLED')
        ), 0)::text as approved_spend_cents,
        coalesce(sum(orders.total_cents) filter (
          where upper(orders.status) = 'PENDING'
        ), 0)::text as pending_spend_cents
      from orders
      join branches branch on branch.id = orders.branch_id
      join organizations organization on organization.id = branch.organization_id
      where branch.organization_id = $1
        and (orders.created_at at time zone '${APP_TIME_ZONE}')::date >= $2::date
        and (orders.created_at at time zone '${APP_TIME_ZONE}')::date <= $3::date
      group by
        organization.id,
        organization.name,
        branch.id,
        branch.name,
        (orders.created_at at time zone '${APP_TIME_ZONE}')::date
      order by order_date, branch.id
    `, [ORGANIZATION.id, HISTORY_START_DATE, clock.as_of_date])

    const currentSnapshots = await rows<SnapshotRow>(client, `
      select
        organization.id as organization_id,
        organization.name as organization_name,
        branch.id as branch_id,
        branch.name as branch_name,
        budget.period,
        $2::date::text as as_of_date,
        budget.amount_allocated_cents::text,
        budget.amount_spent_cents::text,
        budget.amount_held_cents::text,
        budget.amount_credited_cents::text,
        (
          budget.amount_allocated_cents
          + budget.amount_credited_cents
          - budget.amount_spent_cents
          - budget.amount_held_cents
        )::text as remaining_cents
      from budgets budget
      join branches branch
        on branch.id = budget.branch_id
       and branch.organization_id = budget.organization_id
      join organizations organization on organization.id = budget.organization_id
      where budget.organization_id = $1
      order by branch.id, budget.period
    `, [ORGANIZATION.id, clock.as_of_date])

    const reconstructedSnapshots = await rows<SnapshotRow>(client, `
      with budget_days as (
        select
          budget.id as budget_id,
          organization.id as organization_id,
          organization.name as organization_name,
          branch.id as branch_id,
          branch.name as branch_name,
          budget.period,
          day.value::date as as_of_date,
          budget.amount_allocated_cents,
          budget.amount_credited_cents
        from budgets budget
        join branches branch
          on branch.id = budget.branch_id
         and branch.organization_id = budget.organization_id
        join organizations organization on organization.id = budget.organization_id
        cross join lateral generate_series(
          greatest(to_date(budget.period || '-01', 'YYYY-MM-DD'), $2::date),
          least(
            (to_date(budget.period || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date,
            $3::date
          ),
          interval '1 day'
        ) as day(value)
        where budget.organization_id = $1
          and budget.period >= to_char($2::date, 'YYYY-MM')
          and budget.period <= to_char($3::date, 'YYYY-MM')
      ),
      daily_consumption as (
        select
          orders.branch_id,
          (orders.created_at at time zone '${APP_TIME_ZONE}')::date as order_date,
          coalesce(sum(case
            when upper(orders.status) in ('FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED')
              then greatest(0, orders.total_cents - coalesce(orders.refund_amount_cents, 0))
            else 0
          end), 0)::bigint as spent_delta,
          coalesce(sum(case
            when upper(orders.status) in ('PENDING', 'APPROVED')
              then greatest(0, orders.total_cents - coalesce(orders.refund_amount_cents, 0))
            else 0
          end), 0)::bigint as held_delta
        from orders
        join branches branch on branch.id = orders.branch_id
        where branch.organization_id = $1
          and (orders.created_at at time zone '${APP_TIME_ZONE}')::date between $2::date and $3::date
        group by orders.branch_id, (orders.created_at at time zone '${APP_TIME_ZONE}')::date
      ),
      running_balances as (
        select
          budget_day.*,
          coalesce(sum(daily.spent_delta) over (
            partition by budget_day.budget_id
            order by budget_day.as_of_date
            rows between unbounded preceding and current row
          ), 0)::bigint as amount_spent_cents,
          coalesce(sum(daily.held_delta) over (
            partition by budget_day.budget_id
            order by budget_day.as_of_date
            rows between unbounded preceding and current row
          ), 0)::bigint as amount_held_cents
        from budget_days budget_day
        left join daily_consumption daily
          on daily.branch_id = budget_day.branch_id
         and daily.order_date = budget_day.as_of_date
      )
      select
        organization_id,
        organization_name,
        branch_id,
        branch_name,
        period,
        as_of_date::text,
        amount_allocated_cents::text,
        amount_spent_cents::text,
        amount_held_cents::text,
        amount_credited_cents::text,
        (
          amount_allocated_cents
          + amount_credited_cents
          - amount_spent_cents
          - amount_held_cents
        )::text as remaining_cents
      from running_balances
      order by as_of_date, branch_id, period
    `, [ORGANIZATION.id, HISTORY_START_DATE, clock.as_of_date])

    const orderLines = await rows<OrderLineRow>(client, `
      select
        orders.id as order_id,
        orders.branch_id,
        (orders.created_at at time zone '${APP_TIME_ZONE}')::date::text as order_date,
        order_item.global_product_id,
        order_item.product_name,
        category.id as category_id,
        category.name as category_name,
        order_item.quantity::text,
        round(order_item.quantity * order_item.price_cents)::bigint::text as line_total_cents
      from orders
      join branches branch on branch.id = orders.branch_id
      join order_items order_item on order_item.order_id = orders.id
      left join global_products global_product on global_product.id = order_item.global_product_id
      left join categories category on category.id = global_product.category_id
      where branch.organization_id = $1
        and (orders.created_at at time zone '${APP_TIME_ZONE}')::date >= $2::date
        and (orders.created_at at time zone '${APP_TIME_ZONE}')::date <= $3::date
      order by order_date, orders.id, order_item.id
    `, [ORGANIZATION.id, HISTORY_START_DATE, clock.as_of_date])

    await client.query("COMMIT")

    mkdirSync(outputDirectory, { recursive: true })

    const observedSnapshots = new Map<string, SnapshotRow>()
    if (existsSync(observedSnapshotsPath)) {
      for (const row of parseSnapshotCsv(observedSnapshotsPath)) observedSnapshots.set(snapshotKey(row), row)
    }
    if (snapshotSeedPath) {
      for (const row of parseSnapshotCsv(snapshotSeedPath)) observedSnapshots.set(snapshotKey(row), row)
    }
    for (const row of currentSnapshots) observedSnapshots.set(snapshotKey(row), row)

    const observed = [...observedSnapshots.values()].sort((left, right) => (
      left.as_of_date.localeCompare(right.as_of_date)
      || left.branch_id - right.branch_id
      || left.period.localeCompare(right.period)
    ))
    for (const snapshot of observed) validateSnapshot(snapshot)

    const completeSnapshotMap = new Map<string, CompleteSnapshotRow>()
    for (const row of reconstructedSnapshots) {
      completeSnapshotMap.set(snapshotKey(row), { ...row, snapshot_source: "RECONSTRUCTED" })
    }
    for (const row of observed) {
      if (row.period !== row.as_of_date.slice(0, 7)) continue
      if (row.as_of_date < HISTORY_START_DATE || row.as_of_date > clock.as_of_date) continue
      completeSnapshotMap.set(snapshotKey(row), { ...row, snapshot_source: "OBSERVED" })
    }
    const snapshots = [...completeSnapshotMap.values()].sort((left, right) => (
      left.as_of_date.localeCompare(right.as_of_date)
      || left.branch_id - right.branch_id
      || left.period.localeCompare(right.period)
    ))
    for (const snapshot of snapshots) validateSnapshot(snapshot)

    const dailySpendCsv = csvContents([
      "organization_id",
      "organization_name",
      "branch_id",
      "branch_name",
      "order_date",
      "orders_count",
      "spend_cents",
      "fulfilled_spend_cents",
      "approved_spend_cents",
      "pending_spend_cents",
    ], dailySpend.map((row) => [
      row.organization_id,
      row.organization_name,
      row.branch_id,
      row.branch_name,
      row.order_date,
      row.orders_count,
      row.spend_cents,
      row.fulfilled_spend_cents,
      row.approved_spend_cents,
      row.pending_spend_cents,
    ]))

    const snapshotsCsv = csvContents([
      "organization_id",
      "organization_name",
      "branch_id",
      "branch_name",
      "period",
      "as_of_date",
      "amount_allocated_cents",
      "amount_spent_cents",
      "amount_held_cents",
      "amount_credited_cents",
      "remaining_cents",
      "snapshot_source",
    ], snapshots.map((row) => [
      row.organization_id,
      row.organization_name,
      row.branch_id,
      row.branch_name,
      row.period,
      row.as_of_date,
      row.amount_allocated_cents,
      row.amount_spent_cents,
      row.amount_held_cents,
      row.amount_credited_cents,
      row.remaining_cents,
      row.snapshot_source,
    ]))

    const observedSnapshotsCsv = csvContents([
      "organization_id",
      "organization_name",
      "branch_id",
      "branch_name",
      "period",
      "as_of_date",
      "amount_allocated_cents",
      "amount_spent_cents",
      "amount_held_cents",
      "amount_credited_cents",
      "remaining_cents",
    ], observed.map((row) => [
      row.organization_id,
      row.organization_name,
      row.branch_id,
      row.branch_name,
      row.period,
      row.as_of_date,
      row.amount_allocated_cents,
      row.amount_spent_cents,
      row.amount_held_cents,
      row.amount_credited_cents,
      row.remaining_cents,
    ]))

    const orderLinesCsv = csvContents([
      "order_id",
      "branch_id",
      "order_date",
      "global_product_id",
      "product_name",
      "category_id",
      "category_name",
      "quantity",
      "line_total_cents",
    ], orderLines.map((row) => [
      row.order_id,
      row.branch_id,
      row.order_date,
      row.global_product_id,
      row.product_name,
      row.category_id,
      row.category_name,
      row.quantity,
      row.line_total_cents,
    ]))

    const dailySpendSha256 = writeCsv(dailySpendPath, dailySpendCsv)
    const snapshotsSha256 = writeCsv(snapshotsPath, snapshotsCsv)
    const observedSnapshotsSha256 = writeCsv(observedSnapshotsPath, observedSnapshotsCsv)
    const orderLinesSha256 = writeCsv(orderLinesPath, orderLinesCsv)
    const snapshotDates = [...new Set(snapshots.map((row) => row.as_of_date))]
    const observedSnapshotCount = snapshots.filter((row) => row.snapshot_source === "OBSERVED").length
    const reconstructedSnapshotCount = snapshots.length - observedSnapshotCount
    const zeroQuantityLineCount = orderLines.filter((row) => Number(row.quantity) === 0).length
    const uncategorizedLineCount = orderLines.filter((row) => row.category_id === null).length

    const manifest = {
      requirementsSource: "CSVS information description.docx",
      organization: ORGANIZATION,
      exportedAt: clock.exported_at,
      businessTimeZone: APP_TIME_ZONE,
      historyStartDate: HISTORY_START_DATE,
      files: {
        "CSV_1_daily_order_spend.csv": {
          rows: dailySpend.length,
          sha256: dailySpendSha256,
          firstOrderDate: dailySpend[0]?.order_date ?? null,
          lastOrderDate: dailySpend.at(-1)?.order_date ?? null,
          grain: "One row per K-Electric branch and order creation date; zero-order dates omitted",
        },
        "CSV_2_budget_remaining_snapshots.csv": {
          rows: snapshots.length,
          sha256: snapshotsSha256,
          firstSnapshotDate: snapshotDates[0] ?? null,
          lastSnapshotDate: snapshotDates.at(-1) ?? null,
          observedRows: observedSnapshotCount,
          reconstructedRows: reconstructedSnapshotCount,
          grain: "One row per K-Electric branch and day for that day's budget period",
        },
        "supporting_observed_budget_snapshots.csv": {
          rows: observed.length,
          sha256: observedSnapshotsSha256,
          grain: "Only budget observations captured from the live ledger on their actual export date",
        },
        "CSV_3_order_lines.csv": {
          rows: orderLines.length,
          sha256: orderLinesSha256,
          firstOrderDate: orderLines[0]?.order_date ?? null,
          lastOrderDate: orderLines.at(-1)?.order_date ?? null,
          grain: "One row per K-Electric order line",
          dataQuality: {
            zeroQuantityLegacyLines: zeroQuantityLineCount,
            uncategorizedLines: uncategorizedLineCount,
          },
        },
      },
    }
    writeFileSync(resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

    const readme = `# K-Electric AIML CSV export

This export implements the requirements in \`CSVS information description.docx\`.

## CSV 1 — Daily order spend

- Organization: K-Electric (ID 10)
- Range: ${HISTORY_START_DATE} through ${clock.as_of_date}
- Grain: one row per branch per order creation date; dates with no orders are omitted
- \`spend_cents\`: all current recorded \`orders.total_cents\` for orders created that day
- \`fulfilled_spend_cents\`: orders whose current status is \`FULFILLED\`
- \`approved_spend_cents\`: orders whose current status is \`APPROVED\` or \`FULFILLED\`
- \`pending_spend_cents\`: orders whose current status is \`PENDING\`

This is branch/day aggregation, exactly as requested. It is not one row per individual order.

## CSV 2 — Budget remaining snapshots

- Remaining is validated as allocated + credited - spent - held.
- Range: ${snapshotDates[0] ?? HISTORY_START_DATE} through ${snapshotDates.at(-1) ?? clock.as_of_date}.
- \`snapshot_source=OBSERVED\` identifies balances actually captured from the live ledger on that date.
- \`snapshot_source=RECONSTRUCTED\` identifies historical daily balances derived from the imported monthly allocation and cumulative order totals grouped by order creation date and final ledger status.
- Reconstruction uses the same fulfilled/held/refund classification as the committed K-Electric budget-spend backfill. Its final branch/month values reconcile exactly to the current budget ledger.
- Historical allocation is assumed to apply from the start of its budget month because the 2025–2026 budget rows were imported in August 2026 and no earlier allocation-change ledger exists.
- \`supporting_observed_budget_snapshots.csv\` preserves only real exported observations without reconstruction.

## CSV 3 — Order lines

- Grain: one row per K-Electric order line.
- \`product_name\`, quantity, and price are the snapshots stored on the order line.
- \`line_total_cents\` is quantity multiplied by the stored unit price, rounded to cents using the same arithmetic shape as checkout.
- \`line_total_cents\` is pre-tax. Order-level tax is not allocated across product lines.
- Category fields use the product's current category mapping because category name is not snapshotted on the order line. They are blank for uncategorized products.
- This export contains ${zeroQuantityLineCount} legacy zero-quantity lines and ${uncategorizedLineCount} uncategorized lines; both are retained rather than silently removing source records.
`
    writeFileSync(resolve(outputDirectory, "README.md"), readme, "utf8")

    console.log(JSON.stringify({ outputDirectory, ...manifest }, null, 2))
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

run()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool()
  })
