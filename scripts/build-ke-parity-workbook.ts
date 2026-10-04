#!/usr/bin/env tsx
/**
 * Build the K-Electric parity investigation workbook.
 *
 * One Excel file covering everything the automated workstreams deliberately did
 * not touch, so the outstanding decisions can be taken away from a terminal.
 * Read-only: it queries production and the legacy API and writes a spreadsheet.
 *
 *   npx tsx scripts/build-ke-parity-workbook.ts
 *   npx tsx scripts/build-ke-parity-workbook.ts --output=deliverables/ke-parity.xlsx
 */

import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"
import * as XLSX from "xlsx"

import {
  KE_LOGISTICS_BASE_URL,
  KE_ORDERS_LIST_PATH,
  LEGACY_STATUS_LIVE,
  mapDeliveryStatus,
  monthWindows,
} from "../lib/legacy-import/ke-orders-api"
import { planStatusResync, type CurrentOrder } from "../lib/legacy-import/ke-status-resync"
import { sanitizeSpreadsheetRecords } from "../lib/spreadsheet"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORGANIZATION_ID = 10
const HISTORY_START = "2025-01-01"

type JsonRow = Record<string, any>

function arg(name: string): string | undefined {
  const flag = `--${name}=`
  const inline = process.argv.find((v) => v.startsWith(flag))
  return inline ? inline.slice(flag.length) : undefined
}

async function rows<T extends JsonRow = JsonRow>(
  client: PoolClient, text: string, params: unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const r = await fetch(url, { ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.json() as T
    } catch (error) {
      if (attempt === 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt))
    }
  }
  throw new Error("unreachable")
}

/** Column widths make the difference between a usable sheet and a wall of ###. */
function sheet(records: JsonRow[]): XLSX.WorkSheet {
  const safe = sanitizeSpreadsheetRecords(records.length ? records : [{ note: "nothing in this category" }])
  const worksheet = XLSX.utils.json_to_sheet(safe)
  const headers = Object.keys(safe[0])
  worksheet["!cols"] = headers.map((header) => ({
    wch: Math.min(52, Math.max(header.length + 2,
      ...safe.map((row) => String(row[header] ?? "").length + 2))),
  }))
  worksheet["!autofilter"] = { ref: worksheet["!ref"] as string }
  worksheet["!freeze"] = { xSplit: 0, ySplit: 1 }
  return worksheet
}

const money = (cents: unknown) => Number(cents ?? 0) / 100

async function main(): Promise<void> {
  const output = resolve(process.cwd(),
    arg("output") ?? `deliverables/ke-parity-open-items-${new Date().toISOString().slice(0, 10)}.xlsx`)
  const { closePool, pool } = await import("../lib/db-cli")
  const client = await pool.connect()

  try {
    await client.query("begin transaction read only")

    const subusers = await getJson<JsonRow[]>(`${KE_LOGISTICS_BASE_URL}/api/SubUser/0/1`)
    const listRows: JsonRow[] = []
    const seen = new Set<number>()
    for (const window of monthWindows(HISTORY_START, new Date().toISOString().slice(0, 10))) {
      const batch = await getJson<JsonRow[]>(`${KE_LOGISTICS_BASE_URL}${KE_ORDERS_LIST_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          UserID: 1, StartDate: window.start, EndDate: window.end,
          LocationIDs: null, LocationGroupIDs: null, IsMulti: true,
        }),
      })
      for (const row of batch) {
        if (!seen.has(Number(row.ID))) { seen.add(Number(row.ID)); listRows.push(row) }
      }
    }
    const legacyById = new Map<number, JsonRow>(listRows.map((r) => [Number(r.ID), r]))
    const legacyByEmail = new Map<string, JsonRow[]>()
    const legacyByPasscode = new Map<string, JsonRow>()
    for (const s of subusers) {
      const email = String(s.Email ?? "").toLowerCase().trim()
      if (email) legacyByEmail.set(email, [...(legacyByEmail.get(email) ?? []), s])
      const code = String(s.Passcode ?? "").trim()
      if (code) legacyByPasscode.set(code, s)
    }

    const book = XLSX.utils.book_new()
    const index: JsonRow[] = []
    const add = (name: string, records: JsonRow[], question: string) => {
      XLSX.utils.book_append_sheet(book, sheet(records), name)
      index.push({ sheet: name, rows: records.length, "what to decide": question })
    }

    // ---- 1. recycled passcodes: the blocker ----
    const mirrored = await rows(client, `
      select u.id, u.external_id, u.username, u.email, u.full_name, r.name as role,
             b.name as branch, u.is_active, (u.deleted_at is not null) as soft_deleted,
             (select count(*)::int from orders o where o.created_by_user_id = u.id) as orders_created,
             (select coalesce(sum(o.total_cents),0)::bigint from orders o where o.created_by_user_id = u.id) as order_cents
        from users u join roles r on r.id = u.role_id
        left join branches b on b.id = u.branch_id
       where u.organization_id = $1 and u.external_source = 'KE_LOGISTICS'
       order by u.external_id, r.name
    `, [ORGANIZATION_ID])

    const SYNTHETIC = ["ke75", "ke103", "ke113", "ke118", "ke147", "ke148", "ke157"]
    const recycled: JsonRow[] = []
    for (const code of SYNTHETIC) {
      const holder = mirrored.find((m) => String(m.external_id) === code && m.role === "ORDER_PORTAL")
      if (!holder) continue
      const legacyPerson = (legacyByEmail.get(String(holder.email).toLowerCase()) ?? [])[0]
      const targetCode = String(legacyPerson?.Passcode ?? "").trim()
      const displaced = mirrored.filter((m) => String(m.external_id) === targetCode)
      const displacedOp = displaced.find((m) => m.role === "ORDER_PORTAL")
      const displacedEmail = String(displacedOp?.email ?? "").toLowerCase()
      const displacedInLegacy = legacyByEmail.get(displacedEmail) ?? []
      recycled.push({
        synthetic_account: holder.username,
        person: holder.full_name,
        email: holder.email,
        branch: holder.branch,
        synthetic_orders: holder.orders_created,
        synthetic_order_value: money(holder.order_cents),
        legacy_passcode_for_this_person: targetCode,
        "-- currently held by --": displacedOp ? displacedOp.full_name : "(free)",
        displaced_username: displacedOp?.username ?? "",
        displaced_email: displacedOp?.email ?? "",
        displaced_orders: displaced.reduce((t, d) => t + Number(d.orders_created), 0),
        displaced_order_value: money(displaced.reduce((t, d) => t + Number(d.order_cents), 0)),
        displaced_still_in_legacy: displacedInLegacy.length > 0 ? "YES" : "NO — likely departed",
        displaced_new_legacy_passcode: displacedInLegacy.map((s) => String(s.Passcode).trim()).join(" | "),
        QUESTION: "Has the displaced person left K-Electric? If yes, may their account be de-mirrored (keeping its orders) so the passcode frees up?",
      })
    }
    add("1-recycled passcodes", recycled,
      "BLOCKER. Confirm each departure before WS1/WS2/WS5 can run.")

    // ---- 2. same person, different code ----
    const sameperson: JsonRow[] = []
    for (const m of mirrored.filter((x) => x.role === "ORDER_PORTAL")) {
      const hits = legacyByEmail.get(String(m.email).toLowerCase()) ?? []
      if (!hits.length) continue
      const codes = hits.map((s) => String(s.Passcode).trim())
      if (codes.includes(String(m.external_id))) continue
      if (SYNTHETIC.includes(String(m.external_id))) continue
      sameperson.push({
        production_username: m.username,
        person: m.full_name,
        email: m.email,
        branch: m.branch,
        production_external_id: m.external_id,
        legacy_passcode: codes.join(" | "),
        production_orders: m.orders_created,
        production_order_value: money(m.order_cents),
        is_active: m.is_active,
        soft_deleted: m.soft_deleted,
        QUESTION: "Same person under two codes. Confirm the legacy code is current, then merge the orders onto it.",
      })
    }
    add("2-same person diff code", sameperson,
      "Confirm which code is current for each person.")

    // ---- 3. soft-deleted accounts legacy still lists ----
    const deleted = await rows(client, `
      select u.username, u.external_id, u.email, u.full_name, r.name as role,
             b.name as branch, u.deleted_at::date::text as deleted_on,
             (select count(*)::int from orders o where o.created_by_user_id = u.id) as orders_created
        from users u join roles r on r.id = u.role_id
        left join branches b on b.id = u.branch_id
       where u.organization_id = $1 and u.deleted_at is not null
       order by u.username
    `, [ORGANIZATION_ID])
    add("3-deleted but in legacy", deleted.map((d) => ({
      ...d,
      still_in_legacy: legacyByPasscode.has(String(d.external_id)) ? "YES" : "no",
      QUESTION: "Legacy still lists these. Restore them, or was the 2026-09-05 deletion correct?",
    })), "Restore or keep deleted? Blocks the sync either way.")

    // ---- 4. orders the status resync held back ----
    const current = (await rows(client, `
      select o.id, l.legacy_order_id, o.status, o.fulfillment_status, o.refund_amount_cents
        from legacy_order_imports l join orders o on o.id = l.order_id
       where l.organization_id = $1 order by l.legacy_order_id
    `, [ORGANIZATION_ID])).map((row): CurrentOrder => ({
      orderId: Number(row.id),
      legacyOrderId: Number(row.legacy_order_id),
      status: String(row.status),
      fulfillmentStatus: row.fulfillment_status == null ? null : String(row.fulfillment_status),
      refundAmountCents: row.refund_amount_cents == null ? null : Number(row.refund_amount_cents),
    }))
    const resync = planStatusResync(current, listRows.map((r) => ({
      legacyOrderId: Number(r.ID),
      legacyStatusId: Number(r.StatusID),
      deliveryStatus: Number(r.DeliveryStatus),
    })))

    const orderDetail = new Map<number, JsonRow>()
    for (const row of await rows(client, `
      select l.legacy_order_id, o.id, o.total_cents, o.created_at::date::text as order_date,
             b.name as branch, u.username as created_by
        from legacy_order_imports l join orders o on o.id = l.order_id
        left join branches b on b.id = o.branch_id
        left join users u on u.id = o.created_by_user_id
       where l.organization_id = $1
    `, [ORGANIZATION_ID])) orderDetail.set(Number(row.legacy_order_id), row)

    add("4-status held for review", resync.holds.map((h) => {
      const d = orderDetail.get(h.legacyOrderId)
      const legacyRow = legacyById.get(h.legacyOrderId)
      return {
        legacy_order_id: h.legacyOrderId,
        oneflowe_order_id: h.orderId,
        order_date: d?.order_date ?? "",
        branch: d?.branch ?? "",
        value: money(d?.total_cents),
        production_status: `${h.currentStatus}/${h.currentFulfillmentStatus ?? "-"}`,
        legacy_says: h.legacyMeans ?? "(no mapping)",
        legacy_status_id: h.legacyStatusId,
        legacy_delivery_status: h.deliveryStatus,
        legacy_grand_total: legacyRow ? Number(legacyRow.GrandTotal) : "",
        reason_held: h.reason,
        QUESTION: h.reason === "REFUNDED_LOCALLY"
          ? "Refunded here, not in legacy. Keep the refund (recommended) or accept legacy's view?"
          : h.reason === "BACKWARD_TRANSITION"
            ? "Legacy moves this order backwards. Which is right?"
            : "Legacy row is cancelled/draft/test but we hold a real order. Keep or void?",
      }
    }), "9 orders the resync refused to touch.")

    // ---- 5. orders with no legacy row ----
    add("5-orders not in legacy", resync.missingFromLegacy.map((legacyOrderId) => {
      const d = orderDetail.get(legacyOrderId)
      return {
        legacy_order_id: legacyOrderId,
        oneflowe_order_id: d?.id ?? "",
        order_date: d?.order_date ?? "",
        branch: d?.branch ?? "",
        value: money(d?.total_cents),
        created_by: d?.created_by ?? "",
        QUESTION: "Legacy's list endpoint no longer returns this order. Keep it (recommended — real historical spend) or remove?",
      }
    }), "6 orders legacy no longer lists.")

    // ---- 6. legacy live orders not imported ----
    const importedIds = new Set(current.map((o) => o.legacyOrderId))
    add("6-legacy orders not imported", listRows
      .filter((r) => Number(r.StatusID) === LEGACY_STATUS_LIVE && !importedIds.has(Number(r.ID)))
      .map((r) => ({
        legacy_order_id: r.ID,
        order_date: String(r.CreatedOn).slice(0, 10),
        location: r.LocationName,
        location_group: r.LocationGroup,
        user: r.UserDetails,
        grand_total: r.GrandTotal,
        legacy_delivery_status: r.DeliveryStatus,
        would_import_as: mapDeliveryStatus(Number(r.DeliveryStatus))
          ? `${mapDeliveryStatus(Number(r.DeliveryStatus))!.status}/${mapDeliveryStatus(Number(r.DeliveryStatus))!.fulfillmentStatus}`
          : "(no mapping)",
        QUESTION: "Ready to import via import:ke-orders once the sync is unblocked.",
      })), "14 orders waiting on the sync.")

    // ---- 7. products the price sync skipped ----
    const orgInventory = await rows(client, `
      select oi.id, gp.name, gp.product_code, oi.custom_price_cents, gp.base_price_cents,
             oi.is_active,
             (select count(*)::int from organization_inventory o2
               where o2.global_product_id = gp.id and o2.organization_id <> $1
                 and o2.deleted_at is null) as other_tenants_using
        from organization_inventory oi
        join global_products gp on gp.id = oi.global_product_id
       where oi.organization_id = $1 and oi.deleted_at is null
       order by gp.name
    `, [ORGANIZATION_ID])
    try {
      // The price script names its report by run date, so pick the newest
      // rather than pinning a filename — a stale report makes this workbook
      // claim prices are pending that have already been applied.
      const fs = await import("node:fs")
      const reportDir = resolve(process.cwd(), "deliverables")
      const candidates = fs.readdirSync(reportDir)
        .filter((name) => /^ke-organization-prices-\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .map((name) => ({ name, mtime: fs.statSync(resolve(reportDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      if (candidates.length === 0) throw new Error("no organization-price report found")
      const report = JSON.parse(fs.readFileSync(resolve(reportDir, candidates[0].name), "utf8"))
      add("7-prices skipped", (report.skipped ?? []).map((s: JsonRow) => {
        const row = orgInventory.find((r) => Number(r.id) === Number(s.organizationInventoryId))
        return {
          product: s.productName,
          product_code: row?.product_code ?? "",
          organization_inventory_id: s.organizationInventoryId,
          current_org_price: money(row?.custom_price_cents),
          global_base_price: money(row?.base_price_cents),
          other_tenants_using_this_product: row?.other_tenants_using ?? "",
          reason: s.reason,
          detail: s.detail,
          QUESTION: s.reason === "LEGACY_HAS_NO_PRICE"
            ? "Legacy prices this at zero. Leave the current price, or deactivate the product?"
            : s.reason === "AMBIGUOUS_LEGACY_PRICE"
              ? "Legacy's item list and price history disagree. Which price is right?"
              : "No legacy product maps here. Is this product still sold?",
        }
      }), "9 products the price sync would not touch.")

      // After the price set has been committed this is empty, which is correct:
      // the sheet lists what is still pending, and the audit trail on the index
      // sheet records what was applied.
      add("8-prices pending", (report.changes ?? []).map((cgh: JsonRow) => {
        const row = orgInventory.find((r) => Number(r.id) === Number(cgh.organizationInventoryId))
        return {
          product: cgh.productName,
          product_code: row?.product_code ?? "",
          current_org_price: cgh.fromCents === null ? "(inherits global)" : money(cgh.fromCents),
          branch_pays_today: money(cgh.effectiveBeforeCents),
          legacy_price: money(cgh.toCents),
          change: money(cgh.toCents) - money(cgh.effectiveBeforeCents),
          direction: cgh.toCents > cgh.effectiveBeforeCents ? "INCREASE" : "decrease",
          global_base_price_unchanged: money(row?.base_price_cents),
          other_tenants_using_this_product: row?.other_tenants_using ?? "",
        }
      }), "58 price changes, for review before the commit.")
    } catch {
      add("7-prices skipped", [], "Run set-ke-organization-prices.ts dry run first.")
    }

    // ---- 9. placeholder-attributed orders ----
    add("9-placeholder orders", await rows(client, `
      select u.username as placeholder_account, u.full_name, b.name as branch,
             o.id as order_id, o.created_at::date::text as order_date,
             (o.total_cents/100.0) as value, o.status
        from users u join orders o on o.created_by_user_id = u.id
        left join branches b on b.id = o.branch_id
       where u.organization_id = $1 and u.external_source is null
         and u.username like 'legacy!_%' escape '!'
       order by u.username, o.created_at
    `, [ORGANIZATION_ID]), "35 orders with no real owner — resolve or accept.")

    // ---- 10. branch not in legacy ----
    add("10-branch not in legacy", await rows(client, `
      select b.id, b.name, b.external_id,
             (select count(*)::int from users u where u.branch_id = b.id and u.deleted_at is null) as users,
             (select count(*)::int from orders o where o.branch_id = b.id) as orders,
             (select count(*)::int from budgets x where x.branch_id = b.id) as budgets
        from branches b
       where b.organization_id = $1 and b.external_id is null
    `, [ORGANIZATION_ID]), "Deactivate once its 2 users move?")

    // What has actually been applied, read from the audit trail rather than
    // asserted — the workbook should never claim work is pending that is done,
    // nor done that is pending.
    const applied = await rows(client, `
      select action, id, created_at::date::text as applied_on,
             coalesce(metadata->>'changedRows', metadata->>'changedOrders') as rows_changed
        from audit_logs
       where organization_id = $1
         and action in ('KE_ORGANIZATION_PRICE_SET', 'KE_ORDER_STATUS_RESYNC')
       order by id
    `, [ORGANIZATION_ID])
    const appliedRows = applied.length
      ? applied.map((a) => ({
        item: `APPLIED — ${a.action}`,
        value: `${a.rows_changed} rows on ${a.applied_on} (audit id ${a.id})`,
      }))
      : [{ item: "APPLIED", value: "nothing yet" }]

    XLSX.utils.book_append_sheet(book, sheet([
      { item: "Generated", value: new Date().toISOString() },
      { item: "Organization", value: "10 / 0001 / K-Electric (production)" },
      { item: "Legacy source", value: KE_LOGISTICS_BASE_URL },
      { item: "", value: "" },
      ...appliedRows,
      { item: "", value: "" },
      { item: "STILL OPEN — see the sheets below", value: "" },
      ...index.map((r) => ({ item: `${r.sheet} (${r.rows} rows)`, value: r["what to decide"] })),
    ]), "0-index")
    // Move the index to the front.
    book.SheetNames = ["0-index", ...book.SheetNames.filter((n) => n !== "0-index")]

    await client.query("commit")
    mkdirSync(dirname(output), { recursive: true })
    XLSX.writeFile(book, output)
    console.log(`Workbook: ${output}`)
    for (const row of index) console.log(`  ${row.sheet.padEnd(28)} ${String(row.rows).padStart(4)} rows`)
  } finally {
    client.release()
    await closePool()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
