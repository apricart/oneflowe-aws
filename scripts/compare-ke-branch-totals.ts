#!/usr/bin/env tsx
/**
 * Branch-by-branch order count and value: legacy K-Electric platform vs OneFlowe.
 *
 * Read-only. Fetches the legacy order list one month at a time (the same
 * endpoint and windows the importer uses), reads production inside a
 * `read only` transaction, joins the two on `branches.external_id` =
 * legacy `LocationID`, and prints one row per branch.
 *
 * Two legacy figures are shown because legacy itself uses two:
 *   - "dashboard" = live orders (StatusID 2) at gross, refunds ignored — what
 *     the legacy Dashboard tile shows for a branch;
 *   - the same net of the header `RefundAmount` — what its Sales Summary shows.
 * Our "revenue" column is the Dashboard tile formula in lib/metric-utils.ts:
 * gross of non-refunded, non-rejected orders minus partial refunds.
 *
 *   npx tsx scripts/compare-ke-branch-totals.ts
 *   npx tsx scripts/compare-ke-branch-totals.ts --output=deliverables/ke-branch-totals.json
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import {
  KE_LOGISTICS_BASE_URL,
  KE_ORDERS_LIST_PATH,
  LEGACY_STATUS_LIVE,
  LEGACY_STATUS_TEST,
  monthWindows,
} from "../lib/legacy-import/ke-orders-api"
import type { LegacyOrderListRow } from "../lib/legacy-import/ke-post-cutoff"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
const HISTORY_START = "2025-01-01"
const FETCH_ATTEMPTS = 4

type JsonRow = Record<string, any>

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function arg(name: string): string | undefined {
  const flag = `--${name}=`
  const inline = process.argv.find((v) => v.startsWith(flag))
  return inline ? inline.slice(flag.length) : undefined
}

const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100)
const rupees = (value: number) => (value / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as T
    } catch (error) {
      lastError = error
      if (attempt < FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, 2_000 * attempt))
    }
  }
  throw lastError
}

async function fetchLegacyOrders(): Promise<LegacyOrderListRow[]> {
  const url = `${KE_LOGISTICS_BASE_URL}${KE_ORDERS_LIST_PATH}`
  const today = new Date().toISOString().slice(0, 10)
  const byId = new Map<number, LegacyOrderListRow>()
  for (const window of monthWindows(HISTORY_START, today)) {
    const rows = await fetchJson<LegacyOrderListRow[]>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        UserID: 1, StartDate: window.start, EndDate: window.end,
        LocationIDs: null, LocationGroupIDs: null, IsMulti: true,
      }),
    })
    assert(Array.isArray(rows), `Legacy list endpoint did not return an array for ${window.start}..${window.end}`)
    for (const row of rows) byId.set(Number(row.ID), row)
  }
  return [...byId.values()]
}

interface LegacySide {
  locationId: number
  locationName: string
  liveOrders: number
  liveGrossCents: number
  liveRefundCents: number
  fullyRefundedOrders: number
  fullyRefundedGrossCents: number
}

function summarizeLegacy(rows: readonly LegacyOrderListRow[]): Map<number, LegacySide> {
  const byLocation = new Map<number, LegacySide>()
  for (const row of rows) {
    const status = Number(row.StatusID)
    if (status !== LEGACY_STATUS_LIVE && status !== LEGACY_STATUS_TEST) continue
    const id = Number(row.LocationID)
    const side = byLocation.get(id) ?? {
      locationId: id, locationName: String(row.LocationName ?? "").trim(),
      liveOrders: 0, liveGrossCents: 0, liveRefundCents: 0, fullyRefundedOrders: 0, fullyRefundedGrossCents: 0,
    }
    if (status === LEGACY_STATUS_LIVE) {
      side.liveOrders += 1
      side.liveGrossCents += cents(row.GrandTotal)
      side.liveRefundCents += cents(row.RefundAmount)
    } else {
      side.fullyRefundedOrders += 1
      side.fullyRefundedGrossCents += cents(row.GrandTotal)
    }
    byLocation.set(id, side)
  }
  return byLocation
}

interface OurSide {
  branchId: number
  branchName: string
  externalId: string | null
  orders: number
  liveOrders: number
  liveGrossCents: number
  partialRefundCents: number
  refundedOrders: number
  refundedGrossCents: number
  rejectedOrders: number
  revenueCents: number
}

async function readOurs(client: PoolClient): Promise<OurSide[]> {
  const { rows } = await client.query(`
    select b.id as branch_id, b.name as branch_name, b.external_id,
           count(o.id)::int as orders,
           count(o.id) filter (where upper(o.status) not in ('REFUNDED', 'REJECTED'))::int as live_orders,
           coalesce(sum(o.total_cents) filter (where upper(o.status) not in ('REFUNDED', 'REJECTED')), 0)::text as live_gross_cents,
           coalesce(sum(coalesce(o.refund_amount_cents, 0)) filter (where upper(o.status) not in ('REFUNDED', 'REJECTED')), 0)::text as partial_refund_cents,
           count(o.id) filter (where upper(o.status) = 'REFUNDED')::int as refunded_orders,
           coalesce(sum(o.total_cents) filter (where upper(o.status) = 'REFUNDED'), 0)::text as refunded_gross_cents,
           count(o.id) filter (where upper(o.status) = 'REJECTED')::int as rejected_orders,
           coalesce(sum(o.total_cents - coalesce(o.refund_amount_cents, 0))
             filter (where upper(o.status) in ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')), 0)::text as revenue_cents
      from branches b
      left join orders o on o.branch_id = b.id and o.organization_id = b.organization_id
     where b.organization_id = $1
     group by b.id, b.name, b.external_id
     order by b.name
  `, [ORGANIZATION.id])
  return rows.map((row: JsonRow): OurSide => ({
    branchId: Number(row.branch_id),
    branchName: String(row.branch_name),
    externalId: row.external_id == null ? null : String(row.external_id),
    orders: Number(row.orders),
    liveOrders: Number(row.live_orders),
    liveGrossCents: Number(row.live_gross_cents),
    partialRefundCents: Number(row.partial_refund_cents),
    refundedOrders: Number(row.refunded_orders),
    refundedGrossCents: Number(row.refunded_gross_cents),
    rejectedOrders: Number(row.rejected_orders),
    revenueCents: Number(row.revenue_cents),
  }))
}

interface Comparison {
  branch: string
  legacyLocationId: number | null
  legacyLiveOrders: number | null
  legacyDashboardCents: number | null
  legacySalesSummaryCents: number | null
  ourOrders: number | null
  ourLiveOrders: number | null
  ourLiveGrossCents: number | null
  ourRevenueCents: number | null
  ourRefundedOrders: number | null
  countDelta: number | null
  grossDelta: number | null
  verdict: "MATCH" | "REFUNDS_ONLY" | "MISMATCH" | "LEGACY_ONLY" | "OURS_ONLY"
  note: string
}

function compare(legacy: Map<number, LegacySide>, ours: OurSide[]): Comparison[] {
  const seen = new Set<number>()
  const out: Comparison[] = []
  for (const side of ours) {
    const id = side.externalId == null ? null : Number(side.externalId)
    const l = id == null ? undefined : legacy.get(id)
    if (l) seen.add(id!)
    if (!l && side.orders === 0) continue
    const countDelta = l ? side.liveOrders - l.liveOrders : null
    const grossDelta = l ? side.liveGrossCents - l.liveGrossCents : null
    const notes: string[] = []
    let verdict: Comparison["verdict"]
    if (!l) {
      verdict = "OURS_ONLY"
      notes.push(id == null ? "branch is not pinned to a legacy location" : `legacy has no live orders at location ${id}`)
    } else if (countDelta === 0 && grossDelta === 0) {
      verdict = side.partialRefundCents > 0 ? "REFUNDS_ONLY" : "MATCH"
      if (side.partialRefundCents > 0) {
        notes.push(`revenue tile is ${rupees(side.partialRefundCents)} below the legacy dashboard: partial refunds deducted`)
      }
    } else {
      verdict = "MISMATCH"
      if (countDelta !== 0) notes.push(`${countDelta! > 0 ? "+" : ""}${countDelta} orders vs legacy live`)
      if (grossDelta !== 0) notes.push(`${grossDelta! > 0 ? "+" : ""}${rupees(grossDelta!)} gross vs legacy live`)
      if (side.refundedOrders > 0 && l.liveOrders - side.liveOrders === side.refundedOrders) {
        notes.push(`${side.refundedOrders} order(s) REFUNDED here are still live in legacy`)
      }
    }
    if (l && side.refundedOrders > 0 && verdict !== "MISMATCH") {
      notes.push(`${side.refundedOrders} fully refunded order(s) excluded on both sides`)
    }
    out.push({
      branch: side.branchName,
      legacyLocationId: id,
      legacyLiveOrders: l?.liveOrders ?? null,
      legacyDashboardCents: l?.liveGrossCents ?? null,
      legacySalesSummaryCents: l ? l.liveGrossCents - l.liveRefundCents + l.fullyRefundedGrossCents : null,
      ourOrders: side.orders,
      ourLiveOrders: side.liveOrders,
      ourLiveGrossCents: side.liveGrossCents,
      ourRevenueCents: side.revenueCents,
      ourRefundedOrders: side.refundedOrders,
      countDelta, grossDelta, verdict, note: notes.join("; "),
    })
  }
  for (const [id, l] of legacy) {
    if (seen.has(id)) continue
    out.push({
      branch: l.locationName || `(legacy ${id})`,
      legacyLocationId: id,
      legacyLiveOrders: l.liveOrders,
      legacyDashboardCents: l.liveGrossCents,
      legacySalesSummaryCents: l.liveGrossCents - l.liveRefundCents + l.fullyRefundedGrossCents,
      ourOrders: null, ourLiveOrders: null, ourLiveGrossCents: null, ourRevenueCents: null, ourRefundedOrders: null,
      countDelta: null, grossDelta: null,
      verdict: "LEGACY_ONLY",
      note: "no OneFlowe branch is pinned to this legacy location",
    })
  }
  return out.sort((a, b) => a.branch.localeCompare(b.branch))
}

async function main(): Promise<void> {
  const { closePool, pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    const [org] = (await client.query("select code, name from organizations where id = $1", [ORGANIZATION.id])).rows
    assert(org && org.code === ORGANIZATION.code && org.name === ORGANIZATION.name,
      `Organization ${ORGANIZATION.id} is not ${ORGANIZATION.code}:${ORGANIZATION.name}`)

    console.error("Fetching legacy order list…")
    const legacyRows = await fetchLegacyOrders()
    const legacy = summarizeLegacy(legacyRows)

    await client.query("begin read only")
    const ours = await readOurs(client)
    await client.query("rollback")

    const comparison = compare(legacy, ours)
    const totals = {
      legacyLiveOrders: [...legacy.values()].reduce((s, l) => s + l.liveOrders, 0),
      legacyDashboardCents: [...legacy.values()].reduce((s, l) => s + l.liveGrossCents, 0),
      ourLiveOrders: ours.reduce((s, o) => s + o.liveOrders, 0),
      ourLiveGrossCents: ours.reduce((s, o) => s + o.liveGrossCents, 0),
      ourRevenueCents: ours.reduce((s, o) => s + o.revenueCents, 0),
      byVerdict: comparison.reduce<Record<string, number>>((acc, row) => {
        acc[row.verdict] = (acc[row.verdict] ?? 0) + 1
        return acc
      }, {}),
    }

    console.table(comparison.map((row) => ({
      branch: row.branch,
      legacyId: row.legacyLocationId,
      "legacy live #": row.legacyLiveOrders,
      "legacy dashboard": row.legacyDashboardCents == null ? null : rupees(row.legacyDashboardCents),
      "our live #": row.ourLiveOrders,
      "our gross": row.ourLiveGrossCents == null ? null : rupees(row.ourLiveGrossCents),
      "our revenue": row.ourRevenueCents == null ? null : rupees(row.ourRevenueCents),
      "Δ#": row.countDelta,
      "Δ gross": row.grossDelta == null ? null : rupees(row.grossDelta),
      verdict: row.verdict,
    })))
    console.log(JSON.stringify(totals, null, 2))
    for (const row of comparison.filter((r) => r.note)) console.log(`${row.branch}: ${row.note}`)

    const output = arg("output")
    if (output) {
      const path = resolve(process.cwd(), output)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), totals, comparison }, null, 2), "utf8")
      console.log(`\nWritten to ${path}`)
    }
  } finally {
    client.release()
    await closePool()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
