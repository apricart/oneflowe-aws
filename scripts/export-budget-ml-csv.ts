#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { PoolClient } from "pg"

import { closePool, pool } from "../lib/db-cli"
import { createCsv } from "../lib/spreadsheet"

const APP_TIME_ZONE = "Asia/Karachi"

type CsvValue = string | number | boolean | null

type ExportClock = {
  as_of_date: string
  exported_at: string
}

type BudgetObservation = {
  organization_id: number
  organization_name: string
  branch_id: number
  branch_name: string
  period: string
  amount_allocated_cents: string
  amount_spent_cents: string
  amount_held_cents: string
  amount_credited_cents: string
  remaining_cents: string
  budget_updated_at: string | null
}

type DailyOrderActivity = {
  organization_id: number
  organization_name: string
  branch_id: number
  branch_name: string
  period: string
  as_of_date: string
  daily_order_count: number
  daily_ordered_cents: string
  daily_fulfilled_order_count: number
  daily_spend_cents: string
  daily_approved_refund_count: number
  daily_approved_refund_cents: string
}

type CombinedDailyRow = {
  organization_id: number
  organization_name: string
  branch_id: number
  branch_name: string
  period: string
  as_of_date: string
  amount_allocated_cents: string | null
  amount_spent_cents: string | null
  amount_held_cents: string | null
  amount_credited_cents: string | null
  remaining_cents: string | null
  daily_order_count: number
  daily_ordered_cents: string
  daily_fulfilled_order_count: number
  daily_spend_cents: string
  daily_approved_refund_count: number
  daily_approved_refund_cents: string
  budget_snapshot_available: boolean
  daily_activity_recorded: boolean
  row_type: "budget_snapshot" | "daily_activity" | "budget_snapshot_and_daily_activity"
}

function outputDirectoryArgument(): string | undefined {
  const inline = process.argv.find((argument) => argument.startsWith("--output-dir="))
  if (inline) return inline.slice("--output-dir=".length)

  const index = process.argv.indexOf("--output-dir")
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function rows<T>(client: PoolClient, query: string): Promise<T[]> {
  return (await client.query(query)).rows as T[]
}

function writeCsv(path: string, headers: string[], rowsToWrite: CsvValue[][]): string {
  const contents = `${createCsv(headers, rowsToWrite)}\r\n`
  writeFileSync(path, contents, "utf8")
  return createHash("sha256").update(contents).digest("hex")
}

function combinedKey(row: {
  organization_id: number
  branch_id: number
  period: string
  as_of_date: string
}): string {
  return `${row.organization_id}:${row.branch_id}:${row.period}:${row.as_of_date}`
}

function combineBudgetAndActivity(
  budgetObservations: BudgetObservation[],
  dailyOrderActivity: DailyOrderActivity[],
  asOfDate: string,
): CombinedDailyRow[] {
  const combined = new Map<string, CombinedDailyRow>()

  for (const activity of dailyOrderActivity) {
    combined.set(combinedKey(activity), {
      ...activity,
      amount_allocated_cents: null,
      amount_spent_cents: null,
      amount_held_cents: null,
      amount_credited_cents: null,
      remaining_cents: null,
      budget_snapshot_available: false,
      daily_activity_recorded: true,
      row_type: "daily_activity",
    })
  }

  for (const budget of budgetObservations) {
    const key = combinedKey({ ...budget, as_of_date: asOfDate })
    const activity = combined.get(key)

    combined.set(key, {
      organization_id: budget.organization_id,
      organization_name: budget.organization_name,
      branch_id: budget.branch_id,
      branch_name: budget.branch_name,
      period: budget.period,
      as_of_date: asOfDate,
      amount_allocated_cents: budget.amount_allocated_cents,
      amount_spent_cents: budget.amount_spent_cents,
      amount_held_cents: budget.amount_held_cents,
      amount_credited_cents: budget.amount_credited_cents,
      remaining_cents: budget.remaining_cents,
      daily_order_count: activity?.daily_order_count ?? 0,
      daily_ordered_cents: activity?.daily_ordered_cents ?? "0",
      daily_fulfilled_order_count: activity?.daily_fulfilled_order_count ?? 0,
      daily_spend_cents: activity?.daily_spend_cents ?? "0",
      daily_approved_refund_count: activity?.daily_approved_refund_count ?? 0,
      daily_approved_refund_cents: activity?.daily_approved_refund_cents ?? "0",
      budget_snapshot_available: true,
      daily_activity_recorded: activity !== undefined,
      row_type: activity ? "budget_snapshot_and_daily_activity" : "budget_snapshot",
    })
  }

  return [...combined.values()].sort((left, right) => (
    left.organization_id - right.organization_id
    || left.branch_id - right.branch_id
    || left.as_of_date.localeCompare(right.as_of_date)
    || left.period.localeCompare(right.period)
  ))
}

async function exportBudgetMlCsv(): Promise<void> {
  const client = await pool.connect()

  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")

    const [clock] = await rows<ExportClock>(client, `
      select
        (transaction_timestamp() at time zone '${APP_TIME_ZONE}')::date::text as as_of_date,
        transaction_timestamp()::text as exported_at
    `)

    const budgetObservations = await rows<BudgetObservation>(client, `
      select
        organization.id as organization_id,
        organization.name as organization_name,
        branch.id as branch_id,
        branch.name as branch_name,
        budget.period,
        budget.amount_allocated_cents::text,
        budget.amount_spent_cents::text,
        budget.amount_held_cents::text,
        budget.amount_credited_cents::text,
        (
          budget.amount_allocated_cents
          + budget.amount_credited_cents
          - budget.amount_spent_cents
          - budget.amount_held_cents
        )::text as remaining_cents,
        budget.updated_at::text as budget_updated_at
      from budgets budget
      join organizations organization
        on organization.id = budget.organization_id
      join branches branch
        on branch.id = budget.branch_id
       and branch.organization_id = budget.organization_id
      order by organization.id, branch.id, budget.period
    `)

    const dailyOrderActivity = await rows<DailyOrderActivity>(client, `
      with created_activity as (
        select
          branch.organization_id,
          orders.branch_id,
          (orders.created_at at time zone '${APP_TIME_ZONE}')::date as activity_date,
          count(*)::int as daily_order_count,
          coalesce(sum(orders.total_cents), 0)::text as daily_ordered_cents
        from orders
        join branches branch on branch.id = orders.branch_id
        group by
          branch.organization_id,
          orders.branch_id,
          (orders.created_at at time zone '${APP_TIME_ZONE}')::date
      ),
      fulfilled_activity as (
        select
          branch.organization_id,
          orders.branch_id,
          (orders.fulfilled_at at time zone '${APP_TIME_ZONE}')::date as activity_date,
          count(*)::int as daily_fulfilled_order_count,
          coalesce(sum(orders.total_cents), 0)::text as daily_spend_cents
        from orders
        join branches branch on branch.id = orders.branch_id
        where orders.fulfilled_at is not null
        group by
          branch.organization_id,
          orders.branch_id,
          (orders.fulfilled_at at time zone '${APP_TIME_ZONE}')::date
      ),
      refund_activity as (
        select
          branch.organization_id,
          orders.branch_id,
          (refunds.updated_at at time zone '${APP_TIME_ZONE}')::date as activity_date,
          count(*)::int as daily_approved_refund_count,
          coalesce(sum(refunds.amount_cents), 0)::text as daily_approved_refund_cents
        from refunds
        join orders on orders.id = refunds.order_id
        join branches branch on branch.id = orders.branch_id
        where upper(refunds.status) = 'APPROVED'
        group by
          branch.organization_id,
          orders.branch_id,
          (refunds.updated_at at time zone '${APP_TIME_ZONE}')::date
      ),
      activity_keys as (
        select organization_id, branch_id, activity_date from created_activity
        union
        select organization_id, branch_id, activity_date from fulfilled_activity
        union
        select organization_id, branch_id, activity_date from refund_activity
      )
      select
        organization.id as organization_id,
        organization.name as organization_name,
        branch.id as branch_id,
        branch.name as branch_name,
        to_char(activity.activity_date, 'YYYY-MM') as period,
        activity.activity_date::text as as_of_date,
        coalesce(created.daily_order_count, 0)::int as daily_order_count,
        coalesce(created.daily_ordered_cents, '0')::text as daily_ordered_cents,
        coalesce(fulfilled.daily_fulfilled_order_count, 0)::int as daily_fulfilled_order_count,
        coalesce(fulfilled.daily_spend_cents, '0')::text as daily_spend_cents,
        coalesce(refunded.daily_approved_refund_count, 0)::int as daily_approved_refund_count,
        coalesce(refunded.daily_approved_refund_cents, '0')::text as daily_approved_refund_cents
      from activity_keys activity
      join organizations organization on organization.id = activity.organization_id
      join branches branch
        on branch.id = activity.branch_id
       and branch.organization_id = activity.organization_id
      left join created_activity created
        on created.organization_id = activity.organization_id
       and created.branch_id = activity.branch_id
       and created.activity_date = activity.activity_date
      left join fulfilled_activity fulfilled
        on fulfilled.organization_id = activity.organization_id
       and fulfilled.branch_id = activity.branch_id
       and fulfilled.activity_date = activity.activity_date
      left join refund_activity refunded
        on refunded.organization_id = activity.organization_id
       and refunded.branch_id = activity.branch_id
       and refunded.activity_date = activity.activity_date
      order by organization.id, branch.id, activity.activity_date
    `)

    await client.query("COMMIT")

    const outputDirectory = resolve(
      outputDirectoryArgument() || `deliverables/budget-ml-export-${clock.as_of_date}`,
    )
    mkdirSync(outputDirectory, { recursive: true })

    const budgetCsvPath = resolve(outputDirectory, "budget_current_observations.csv")
    const activityCsvPath = resolve(outputDirectory, "branch_daily_order_activity.csv")
    const combinedCsvPath = resolve(outputDirectory, "branch_daily_budget_and_activity.csv")

    const budgetSha256 = writeCsv(
      budgetCsvPath,
      [
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
        "budget_updated_at",
      ],
      budgetObservations.map((row) => [
        row.organization_id,
        row.organization_name,
        row.branch_id,
        row.branch_name,
        row.period,
        clock.as_of_date,
        row.amount_allocated_cents,
        row.amount_spent_cents,
        row.amount_held_cents,
        row.amount_credited_cents,
        row.remaining_cents,
        row.budget_updated_at,
      ]),
    )

    const activitySha256 = writeCsv(
      activityCsvPath,
      [
        "organization_id",
        "organization_name",
        "branch_id",
        "branch_name",
        "period",
        "as_of_date",
        "daily_order_count",
        "daily_ordered_cents",
        "daily_fulfilled_order_count",
        "daily_spend_cents",
        "daily_approved_refund_count",
        "daily_approved_refund_cents",
      ],
      dailyOrderActivity.map((row) => [
        row.organization_id,
        row.organization_name,
        row.branch_id,
        row.branch_name,
        row.period,
        row.as_of_date,
        row.daily_order_count,
        row.daily_ordered_cents,
        row.daily_fulfilled_order_count,
        row.daily_spend_cents,
        row.daily_approved_refund_count,
        row.daily_approved_refund_cents,
      ]),
    )

    const combinedRows = combineBudgetAndActivity(
      budgetObservations,
      dailyOrderActivity,
      clock.as_of_date,
    )
    const combinedSha256 = writeCsv(
      combinedCsvPath,
      [
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
        "daily_order_count",
        "daily_ordered_cents",
        "daily_fulfilled_order_count",
        "daily_spend_cents",
        "daily_approved_refund_count",
        "daily_approved_refund_cents",
        "budget_snapshot_available",
        "daily_activity_recorded",
        "row_type",
      ],
      combinedRows.map((row) => [
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
        row.daily_order_count,
        row.daily_ordered_cents,
        row.daily_fulfilled_order_count,
        row.daily_spend_cents,
        row.daily_approved_refund_count,
        row.daily_approved_refund_cents,
        row.budget_snapshot_available,
        row.daily_activity_recorded,
        row.row_type,
      ]),
    )

    const manifest = {
      exportedAt: clock.exported_at,
      asOfDate: clock.as_of_date,
      businessTimeZone: APP_TIME_ZONE,
      files: {
        "budget_current_observations.csv": {
          rows: budgetObservations.length,
          sha256: budgetSha256,
          grain: "One current observation per stored branch and budget period",
        },
        "branch_daily_order_activity.csv": {
          rows: dailyOrderActivity.length,
          sha256: activitySha256,
          grain: "One row per branch and date on which an order, fulfilment, or approved refund event exists",
        },
        "branch_daily_budget_and_activity.csv": {
          rows: combinedRows.length,
          sha256: combinedSha256,
          grain: "One row per organization, branch, period, and as-of date across available budget observations and daily activity",
        },
      },
    }
    writeFileSync(resolve(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

    const readme = `# Budget ML starter export

Exported at: ${clock.exported_at}  
Business timezone: ${APP_TIME_ZONE}

## budget_current_observations.csv

This file contains exact values read from the current budget ledger at export time. The grain is one row per organization, branch, and budget period. \`as_of_date\` is the date on which this export observed the row; it is not a historical month-end snapshot.

\`remaining_cents\` is calculated as:

\`amount_allocated_cents + amount_credited_cents - amount_spent_cents - amount_held_cents\`

Older periods may have been imported or backfilled after the period ended. Do not interpret their current values or \`budget_updated_at\` as proof of what the balance was on each historical day.

## branch_daily_order_activity.csv

This is historical event activity, not historical budget balances. It contains one row for each branch/date that has at least one created order, fulfilled order, or approved refund.

- \`daily_ordered_cents\`: current recorded order totals grouped by order creation date.
- \`daily_spend_cents\`: gross order totals grouped by fulfilment date. This matches the event that moves money from held to spent, but moving held to spent does not itself change remaining budget.
- \`daily_approved_refund_cents\`: approved refunds grouped by the refund row's last update date. Refund workflows can affect the budget in different ways, so this is supplied as a separate feature and must not automatically be subtracted from \`daily_spend_cents\`.
- Dates with no recorded event are omitted and can be zero-filled by the consumer if needed.

Exact daily remaining-budget history does not exist before daily snapshots begin. Do not join the current budget observation onto every historical order date and label it as that day's remaining balance.

## branch_daily_budget_and_activity.csv

This is the single-file form of both exports. Every row has the complete set of budget and daily-activity columns.

- \`budget_snapshot_available=true\` means the five budget fields are an exact observation made on that row's \`as_of_date\`.
- Historical daily-activity rows have \`budget_snapshot_available=false\` and blank budget fields because no historical daily budget snapshot exists. Blank means unknown, not zero.
- \`daily_activity_recorded=true\` means at least one order, fulfilment, or approved-refund event was recorded for that branch/date. Daily activity values are zero on snapshot-only rows.
- \`row_type\` explicitly identifies \`budget_snapshot\`, \`daily_activity\`, or \`budget_snapshot_and_daily_activity\` rows.

As future daily exports are accumulated, their exact snapshot rows can be appended to this file and joined to activity on organization, branch, period, and date.
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

exportBudgetMlCsv()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool()
  })
