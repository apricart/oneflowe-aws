#!/usr/bin/env tsx
/**
 * K-Electric legacy-vs-OneFlowe parity report.
 *
 * Answers one question, entity by entity: what does the legacy logistics
 * platform hold for K-Electric that our database does not, and vice versa?
 * Orders (with their lines), branches, groups, users, products and branch
 * budgets are each compared and written to one workbook.
 *
 * Read-only. It fetches from the legacy API, reads production inside a
 * `read only` transaction, and writes a spreadsheet. It reuses the same pure
 * planners the sync and the order import use (`planBranches`, `planGroups`,
 * `planProducts`, `prepareApiOrders`, ...) so "missing" here means exactly
 * what the import would find missing — not a looser name comparison.
 *
 *   npx tsx scripts/build-ke-legacy-parity-report.ts
 *   npx tsx scripts/build-ke-legacy-parity-report.ts --output=deliverables/ke-parity.xlsx
 */

import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"
import * as XLSX from "xlsx"

import { normalizeProductName } from "../lib/legacy-import/ke-electric"
import { planBranchBudgets, type CurrentBudget } from "../lib/legacy-import/ke-budgets"
import {
  KE_LOGISTICS_BASE_URL,
  KE_ORDERS_LIST_PATH,
  KE_TIME_ZONE,
  LEGACY_STATUS_CANCELLED,
  LEGACY_STATUS_DRAFT,
  LEGACY_STATUS_LIVE,
  LEGACY_STATUS_TEST,
  centsFrom,
  identityKeyForListRow,
  mapDeliveryStatus,
  monthWindows,
  orderIdentityKey,
  prepareApiOrders,
  type LegacyRefund,
  type PreparedApiOrder,
} from "../lib/legacy-import/ke-orders-api"
import {
  legacyStatusText,
  normalizeLegacyText,
  type LegacyOrderDetail,
  type LegacyOrderListRow,
} from "../lib/legacy-import/ke-post-cutoff"
import {
  planProducts,
  priceToCents,
  type CurrentProductMapping,
  type LegacyCategory,
  type LegacyItem,
  type LegacyPriceHistoryRow,
} from "../lib/legacy-import/ke-products"
import {
  contestedIdentityFor,
  employeeCodeOf,
  isSamePerson,
  isSyntheticAccount,
  legacyLocationOf,
  normalizeName,
  planBranches,
  planGroups,
  type CurrentBranch,
  type CurrentGroup,
  type CurrentUser,
  type LegacyLocation,
  type LegacyLocationGroup,
  type LegacySubUser,
} from "../lib/legacy-import/ke-sync"
import { sanitizeSpreadsheetRecords } from "../lib/spreadsheet"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORGANIZATION_ID = 10
const SOURCE_SYSTEM = "KE_LOGISTICS"
const LEGACY_ACCOUNT_ID = 1
const HISTORY_START = "2025-01-01"
const DETAIL_CONCURRENCY = 3
const FETCH_ATTEMPTS = 6

type Row = Record<string, any>

function arg(name: string): string | undefined {
  const flag = `--${name}=`
  const inline = process.argv.find((value) => value.startsWith(flag))
  return inline ? inline.slice(flag.length) : undefined
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

function backoffMs(status: number | null, attempt: number): number {
  const throttled = status === 403 || status === 429 || status === 503
  return throttled ? 5_000 * 3 ** (attempt - 1) : 500 * attempt
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${KE_LOGISTICS_BASE_URL}${path}`
  let lastError: unknown
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    let status: number | null = null
    try {
      const response = await fetch(url, {
        ...init,
        headers: { Accept: "application/json", ...(init?.headers ?? {}) },
      })
      status = response.status
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as T
    } catch (error) {
      lastError = error
      if (attempt < FETCH_ATTEMPTS) await sleep(backoffMs(status, attempt))
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function mapConcurrent<T, R>(
  values: readonly T[], concurrency: number, fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++
      result[index] = await fn(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return result
}

async function fetchOrderList(): Promise<LegacyOrderListRow[]> {
  const byId = new Map<number, LegacyOrderListRow>()
  for (const window of monthWindows(HISTORY_START, new Date().toISOString().slice(0, 10))) {
    const rows = await fetchJson<LegacyOrderListRow[]>(KE_ORDERS_LIST_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        UserID: LEGACY_ACCOUNT_ID, StartDate: window.start, EndDate: window.end,
        LocationIDs: null, LocationGroupIDs: null, IsMulti: true,
      }),
    })
    if (!Array.isArray(rows)) throw new Error(`Order list for ${window.start}..${window.end} is not an array`)
    for (const row of rows) byId.set(Number(row.ID), row)
  }
  return [...byId.values()].sort((a, b) => Number(a.ID) - Number(b.ID))
}

async function fetchPriceHistory(): Promise<LegacyPriceHistoryRow[]> {
  return fetchJson<LegacyPriceHistoryRow[]>("/api/ProductSummary/GetSummaryItemHistory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      UserID: LEGACY_ACCOUNT_ID, LocationIDs: null,
      StartDate: "2020-01-01", EndDate: new Date().toISOString().slice(0, 10),
    }),
  })
}

async function rows<T extends Row = Row>(client: PoolClient, text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

// ---- workbook helpers -------------------------------------------------------

function sheet(records: Row[], emptyNote = "nothing in this category"): XLSX.WorkSheet {
  const safe = sanitizeSpreadsheetRecords(records.length ? records : [{ note: emptyNote }])
  const worksheet = XLSX.utils.json_to_sheet(safe)
  const headers = Object.keys(safe[0])
  worksheet["!cols"] = headers.map((header) => ({
    wch: Math.min(60, Math.max(header.length + 2,
      ...safe.slice(0, 500).map((row) => String(row[header] ?? "").length + 2))),
  }))
  worksheet["!autofilter"] = { ref: worksheet["!ref"] as string }
  worksheet["!freeze"] = { xSplit: 0, ySplit: 1 }
  return worksheet
}

const money = (cents: unknown): number | "" =>
  cents === null || cents === undefined || cents === "" ? "" : Number(cents) / 100

const KARACHI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: KE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
})
function karachiDay(value: unknown): string {
  if (!value) return ""
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? "" : KARACHI_DAY.format(date)
}
function legacyDay(value: unknown): string {
  return String(value ?? "").slice(0, 10)
}
function dayDistance(a: string, b: string): number | null {
  if (!a || !b) return null
  return Math.abs((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000)
}

// ---- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const output = resolve(process.cwd(),
    arg("output") ?? `deliverables/ke-legacy-parity-${new Date().toISOString().slice(0, 10)}.xlsx`)

  console.log("Fetching legacy reference data ...")
  const [legacyLocations, legacyGroups, legacySubUsers, legacyItems, legacyCategories, legacyPriceHistory] =
    await Promise.all([
      fetchJson<LegacyLocation[]>(`/api/Location/GetLocation/${LEGACY_ACCOUNT_ID}`),
      fetchJson<LegacyLocationGroup[]>(`/api/LocationGroup/GetLocationGroups/${LEGACY_ACCOUNT_ID}`),
      fetchJson<LegacySubUser[]>(`/api/SubUser/0/${LEGACY_ACCOUNT_ID}`),
      fetchJson<LegacyItem[]>(`/api/Item/0/null/${LEGACY_ACCOUNT_ID}`),
      fetchJson<LegacyCategory[]>(`/api/Category/0/${LEGACY_ACCOUNT_ID}`),
      fetchPriceHistory(),
    ])
  console.log(`  locations ${legacyLocations.length}, groups ${legacyGroups.length}, users ${legacySubUsers.length}, `
    + `item rows ${legacyItems.length}, categories ${legacyCategories.length}, price history ${legacyPriceHistory.length}`)

  console.log("Fetching legacy order list, one month at a time ...")
  const listRows = await fetchOrderList()
  console.log(`  ${listRows.length} legacy orders`)

  // Details for everything that is not cancelled: live orders are the ones
  // that must exist here, and drafts/tests are fetched too so the register can
  // say what is in them rather than just that they were skipped.
  const detailCandidates = listRows.filter((row) => Number(row.StatusID) !== LEGACY_STATUS_CANCELLED)
  console.log(`Fetching ${detailCandidates.length} order details (concurrency ${DETAIL_CONCURRENCY}) ...`)
  let done = 0
  const detailFailures = new Map<number, string>()
  const details = await mapConcurrent(detailCandidates, DETAIL_CONCURRENCY, async (row) => {
    try {
      return await fetchJson<LegacyOrderDetail>(
        `/api/OrderDetailController/${Number(row.LocationID)}/${Number(row.ID)}`)
    } catch (error) {
      detailFailures.set(Number(row.ID), error instanceof Error ? error.message : String(error))
      return null
    } finally {
      done += 1
      if (done % 100 === 0) console.log(`  ${done}/${detailCandidates.length}`)
    }
  })
  const detailsById = new Map<number, LegacyOrderDetail>()
  details.forEach((detail, index) => {
    if (detail) detailsById.set(Number(detailCandidates[index].ID), detail)
  })
  if (detailFailures.size) console.log(`  ${detailFailures.size} detail fetch(es) failed`)

  const lineSumCents = (detail: LegacyOrderDetail | undefined) =>
    (detail?.OrderDetailsList ?? []).reduce(
      (sum, line) => sum + Math.abs(centsFrom(line.Price, "line")), 0)
  const needRefund = detailCandidates.filter((row) => {
    const detail = detailsById.get(Number(row.ID))
    const checkout = detail?.OrderCheckoutList?.[0]
    if (!detail || !checkout) return false
    return lineSumCents(detail) !== centsFrom(checkout.AmountTotal, "subtotal")
  })
  console.log(`Fetching ${needRefund.length} refund record(s) ...`)
  const refunds = await mapConcurrent(needRefund, DETAIL_CONCURRENCY, (row) =>
    fetchJson<LegacyRefund>(
      `/api/RefundModal/${Number(row.LocationID)}/${encodeURIComponent(String(row.TransactionNo))}`)
      .catch(() => ({} as LegacyRefund)))
  const refundsByOrderId = new Map(needRefund.map((row, index) => [Number(row.ID), refunds[index]]))

  const preparation = prepareApiOrders(listRows, detailsById, undefined, refundsByOrderId)
  const preparedById = new Map(preparation.prepared.map((order) => [order.legacyOrderId, order]))
  const rejectedById = new Map(preparation.rejected.map((order) => [order.legacyOrderId, order]))

  console.log("Reading production (read only) ...")
  const { closePool, pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  const book = XLSX.utils.book_new()
  const index: Row[] = []
  const add = (name: string, records: Row[], meaning: string, emptyNote?: string) => {
    XLSX.utils.book_append_sheet(book, sheet(records, emptyNote), name)
    index.push({ sheet: name, rows: records.length, meaning })
  }

  try {
    await client.query("begin transaction read only")
    const [org] = await rows(client, `select id, code, name from organizations where id = $1`, [ORGANIZATION_ID])
    if (!org || normalizeName(org.name) !== "k electric") {
      throw new Error(`Organization ${ORGANIZATION_ID} is not K-Electric in this database; refusing.`)
    }

    const branchRows = await rows(client, `
      select b.id, b.name, b.external_source, b.external_id, b.group_id, b.status, b.address,
             b.baseline_budget_cents, g.name as group_name
        from branches b left join groups g on g.id = b.group_id
       where b.organization_id = $1 order by b.id`, [ORGANIZATION_ID])
    const currentBranches: CurrentBranch[] = branchRows.map((row) => ({
      id: Number(row.id), name: String(row.name),
      externalSource: row.external_source ?? null, externalId: row.external_id ?? null,
      groupId: row.group_id == null ? null : Number(row.group_id),
    }))
    const branchById = new Map(branchRows.map((row) => [Number(row.id), row]))

    const groupRows = await rows(client,
      `select id, name, status from groups where organization_id = $1 order by id`, [ORGANIZATION_ID])
    const currentGroups: CurrentGroup[] = groupRows.map((row) => ({ id: Number(row.id), name: String(row.name) }))

    const userRows = await rows(client, `
      select u.id, u.username, u.email, u.full_name, u.phone, u.branch_id, u.is_active, u.deleted_at,
             u.external_source, u.external_id, r.name as role_name, b.name as branch_name,
             (select count(*)::int from orders o where o.created_by_user_id = u.id) as orders_created
        from users u join roles r on r.id = u.role_id
        left join branches b on b.id = u.branch_id
       where u.organization_id = $1 order by u.username`, [ORGANIZATION_ID])
    const liveUserRows = userRows.filter((row) => row.deleted_at == null)
    const currentUsers: CurrentUser[] = liveUserRows.map((row) => ({
      id: String(row.id), username: row.username ?? null, email: String(row.email),
      fullName: row.full_name ?? null, roleName: String(row.role_name),
      branchId: row.branch_id == null ? null : Number(row.branch_id),
      isActive: Boolean(row.is_active),
      externalSource: row.external_source ?? null, externalId: row.external_id ?? null,
    }))
    const userById = new Map(userRows.map((row) => [String(row.id), row]))

    const mappingRows = await rows(client, `
      select lpm.normalized_name, lpm.source_name, lpm.global_product_id, lpm.organization_inventory_id,
             gp.name as product_name, gp.product_code, gp.base_price_cents, gp.unit,
             oi.custom_price_cents, oi.is_active as inventory_active, oi.deleted_at as inventory_deleted_at
        from legacy_product_mappings lpm
        join global_products gp on gp.id = lpm.global_product_id
        join organization_inventory oi on oi.id = lpm.organization_inventory_id
       where lpm.organization_id = $1 and lpm.source_system = $2
       order by lpm.normalized_name`, [ORGANIZATION_ID, SOURCE_SYSTEM])
    const currentMappings: CurrentProductMapping[] = mappingRows.map((row) => ({
      normalizedName: String(row.normalized_name),
      globalProductId: Number(row.global_product_id),
      organizationInventoryId: Number(row.organization_inventory_id),
      basePriceCents: Number(row.base_price_cents ?? 0),
    }))
    const mappingByName = new Map(mappingRows.map((row) => [String(row.normalized_name), row]))
    const mappingsByProductId = new Map<number, Row[]>()
    for (const row of mappingRows) {
      const list = mappingsByProductId.get(Number(row.global_product_id)) ?? []
      list.push(row)
      mappingsByProductId.set(Number(row.global_product_id), list)
    }

    const inventoryRows = await rows(client, `
      select oi.id, oi.global_product_id, gp.name, gp.product_code, gp.base_price_cents,
             oi.custom_price_cents, oi.is_active
        from organization_inventory oi join global_products gp on gp.id = oi.global_product_id
       where oi.organization_id = $1 and oi.deleted_at is null order by gp.name`, [ORGANIZATION_ID])

    const budgetRows = await rows(client,
      `select branch_id, period, amount_allocated_cents, amount_credited_cents, amount_spent_cents, amount_held_cents
         from budgets where organization_id = $1`, [ORGANIZATION_ID])
    const currentBudgets: CurrentBudget[] = budgetRows.map((row) => ({
      branchId: Number(row.branch_id), period: String(row.period),
      amountAllocatedCents: Number(row.amount_allocated_cents ?? 0),
      amountCreditedCents: Number(row.amount_credited_cents ?? 0),
      amountSpentCents: Number(row.amount_spent_cents ?? 0),
      amountHeldCents: Number(row.amount_held_cents ?? 0),
    }))

    const orderRows = await rows(client, `
      select o.id, o.status, o.fulfillment_status, o.payment_status, o.subtotal_cents, o.tax_cents,
             o.total_cents, o.refund_amount_cents, o.created_at, o.branch_id, o.created_by_user_id,
             o.group_order_id, l.legacy_order_id, l.source_payload, l.batch_id,
             (select count(*)::int from order_items i where i.order_id = o.id) as item_count
        from orders o left join legacy_order_imports l on l.order_id = o.id
       where o.organization_id = $1 order by o.id`, [ORGANIZATION_ID])
    const itemRows = await rows(client, `
      select i.order_id, i.global_product_id, i.product_name, i.quantity, i.price_cents, i.tax_cents
        from order_items i join orders o on o.id = i.order_id
       where o.organization_id = $1`, [ORGANIZATION_ID])
    const itemsByOrderId = new Map<number, Row[]>()
    for (const row of itemRows) {
      const list = itemsByOrderId.get(Number(row.order_id)) ?? []
      list.push(row)
      itemsByOrderId.set(Number(row.order_id), list)
    }
    await client.query("commit")

    // ================================================================
    // Branches
    // ================================================================
    const branchPlan = planBranches(legacyLocations, currentBranches)
    const pinByLegacyId = new Map(branchPlan.pins.map((pin) => [pin.legacyLocationId, pin]))
    const legacyLocationById = new Map(legacyLocations.map((location) => [Number(location.ID), location]))
    const legacyGroupOfLocation = new Map<number, string>()
    for (const group of legacyGroups) {
      for (const locationId of group.LocationIDs ?? []) legacyGroupOfLocation.set(Number(locationId), group.Name)
    }
    const legacyLiveOrdersByLocation = new Map<number, number>()
    const legacyOrdersByLocation = new Map<number, number>()
    for (const row of listRows) {
      const id = Number(row.LocationID)
      legacyOrdersByLocation.set(id, (legacyOrdersByLocation.get(id) ?? 0) + 1)
      if (Number(row.StatusID) === LEGACY_STATUS_LIVE) {
        legacyLiveOrdersByLocation.set(id, (legacyLiveOrdersByLocation.get(id) ?? 0) + 1)
      }
    }
    const legacyUsersByLocation = new Map<number, number>()
    for (const subUser of legacySubUsers) {
      const id = legacyLocationOf(subUser)
      if (id != null) legacyUsersByLocation.set(id, (legacyUsersByLocation.get(id) ?? 0) + 1)
    }
    const dbOrdersByBranch = new Map<number, number>()
    for (const row of orderRows) {
      const id = Number(row.branch_id)
      dbOrdersByBranch.set(id, (dbOrdersByBranch.get(id) ?? 0) + 1)
    }
    const dbUsersByBranch = new Map<number, number>()
    for (const row of liveUserRows) {
      if (row.branch_id == null) continue
      const id = Number(row.branch_id)
      dbUsersByBranch.set(id, (dbUsersByBranch.get(id) ?? 0) + 1)
    }

    const branchRegister: Row[] = []
    const branchIssues: Row[] = []
    for (const location of [...legacyLocations].sort((a, b) => Number(a.ID) - Number(b.ID))) {
      const pin = pinByLegacyId.get(Number(location.ID))
      const branch = pin ? branchById.get(pin.branchId) : undefined
      const legacyGroup = legacyGroupOfLocation.get(Number(location.ID)) ?? ""
      const issues: string[] = []
      if (!pin) {
        const ambiguous = branchPlan.ambiguous.find((entry) => entry.legacyLocationId === Number(location.ID))
        issues.push(ambiguous
          ? `AMBIGUOUS: name matches DB branches ${ambiguous.candidates.join(", ")}`
          : "MISSING IN DB")
      } else {
        if (pin.needsPin) issues.push("NOT PINNED (matched by name only, external_id not stamped)")
        if (pin.rename) issues.push(`NAME DIFFERS: DB "${pin.rename.from}" vs legacy "${pin.rename.to}"`)
        if (legacyGroup && normalizeName(branch?.group_name) !== normalizeName(legacyGroup)) {
          issues.push(`GROUP DIFFERS: DB "${branch?.group_name ?? "(none)"}" vs legacy "${legacyGroup}"`)
        }
        if (!legacyGroup && branch?.group_name) issues.push(`GROUP: legacy has none, DB has "${branch.group_name}"`)
        if (branch && String(branch.status) !== "active") issues.push(`DB branch status is ${branch.status}`)
      }
      const record = {
        legacy_location_id: Number(location.ID),
        legacy_name: location.Name,
        legacy_status_id: location.StatusID ?? "",
        legacy_group: legacyGroup,
        legacy_monthly_budget: location.MonthlyBudget ?? "",
        legacy_users: legacyUsersByLocation.get(Number(location.ID)) ?? 0,
        legacy_orders_all: legacyOrdersByLocation.get(Number(location.ID)) ?? 0,
        legacy_orders_live: legacyLiveOrdersByLocation.get(Number(location.ID)) ?? 0,
        db_branch_id: branch ? Number(branch.id) : "",
        db_name: branch?.name ?? "",
        db_status: branch?.status ?? "",
        db_group: branch?.group_name ?? "",
        db_external_id: branch?.external_id ?? "",
        matched_via: pin?.via ?? "",
        db_users: branch ? dbUsersByBranch.get(Number(branch.id)) ?? 0 : "",
        db_orders: branch ? dbOrdersByBranch.get(Number(branch.id)) ?? 0 : "",
        result: issues.length ? "ISSUE" : "OK",
        issues: issues.join(" | "),
      }
      branchRegister.push(record)
      if (issues.length) branchIssues.push(record)
    }
    const branchesOnlyInDb = branchPlan.unmatched.map((branch) => {
      const row = branchById.get(branch.id)!
      return {
        db_branch_id: branch.id,
        db_name: branch.name,
        db_status: row.status,
        db_group: row.group_name ?? "",
        db_external_id: row.external_id ?? "",
        db_users: dbUsersByBranch.get(branch.id) ?? 0,
        db_orders: dbOrdersByBranch.get(branch.id) ?? 0,
        note: row.external_id
          ? "Pinned to a legacy id the legacy platform no longer returns"
          : "No legacy location matches this branch",
      }
    })

    // ================================================================
    // Groups
    // ================================================================
    const groupPlan = planGroups(legacyGroups, currentGroups, branchPlan.pins, currentBranches)
    const dbGroupByName = new Map(groupRows.map((row) => [normalizeName(row.name), row]))
    const groupRegister: Row[] = []
    const groupMembership: Row[] = []
    for (const group of legacyGroups) {
      const dbGroup = dbGroupByName.get(normalizeName(group.Name))
      const legacyMembers = (group.LocationIDs ?? []).map(Number)
      const dbMembers = dbGroup
        ? branchRows.filter((row) => Number(row.group_id) === Number(dbGroup.id))
        : []
      const issues: string[] = []
      if (!dbGroup) issues.push("MISSING IN DB")
      const legacyMemberBranchIds = new Set(
        legacyMembers.map((id) => pinByLegacyId.get(id)?.branchId).filter((id): id is number => id != null))
      const dbMemberIds = new Set(dbMembers.map((row) => Number(row.id)))
      let missingMembers = 0
      let extraMembers = 0
      for (const legacyId of legacyMembers) {
        const pin = pinByLegacyId.get(legacyId)
        const location = legacyLocationById.get(legacyId)
        const branch = pin ? branchById.get(pin.branchId) : undefined
        const inDbGroup = branch ? Number(branch.group_id) === Number(dbGroup?.id) : false
        if (!inDbGroup) {
          missingMembers += 1
          groupMembership.push({
            legacy_group: group.Name,
            legacy_location_id: legacyId,
            legacy_location: location?.Name ?? "(location not in legacy list)",
            db_branch_id: branch ? Number(branch.id) : "",
            db_branch: branch?.name ?? "",
            db_group: branch?.group_name ?? "",
            problem: !pin ? "branch missing in DB" : !dbGroup ? "group missing in DB" : "branch is in a different DB group",
          })
        }
      }
      for (const row of dbMembers) {
        if (!legacyMemberBranchIds.has(Number(row.id))) {
          extraMembers += 1
          groupMembership.push({
            legacy_group: group.Name,
            legacy_location_id: row.external_id ?? "",
            legacy_location: "",
            db_branch_id: Number(row.id),
            db_branch: row.name,
            db_group: row.group_name ?? "",
            problem: "in this DB group but not in the legacy group",
          })
        }
      }
      if (missingMembers) issues.push(`${missingMembers} legacy member(s) not in the DB group`)
      if (extraMembers) issues.push(`${extraMembers} DB member(s) not in the legacy group`)
      if (dbGroup && !["active", "connected"].includes(String(dbGroup.status))) issues.push(`DB status ${dbGroup.status}`)
      groupRegister.push({
        legacy_group_id: group.ID,
        legacy_name: group.Name,
        legacy_active: group.IsActive ?? "",
        legacy_members: legacyMembers.length,
        db_group_id: dbGroup ? Number(dbGroup.id) : "",
        db_name: dbGroup?.name ?? "",
        db_status: dbGroup?.status ?? "",
        db_members: dbMembers.length,
        result: issues.length ? "ISSUE" : "OK",
        issues: issues.join(" | "),
      })
    }
    const legacyGroupNames = new Set(legacyGroups.map((group) => normalizeName(group.Name)))
    for (const row of groupRows) {
      if (legacyGroupNames.has(normalizeName(row.name))) continue
      groupRegister.push({
        legacy_group_id: "", legacy_name: "", legacy_active: "", legacy_members: "",
        db_group_id: Number(row.id), db_name: row.name, db_status: row.status,
        db_members: branchRows.filter((branch) => Number(branch.group_id) === Number(row.id)).length,
        result: "ISSUE", issues: "ONLY IN DB",
      })
    }
    for (const row of branchRows) {
      if (row.group_id != null || row.external_id == null) continue
      if (!legacyGroupOfLocation.has(Number(row.external_id))) continue
      // Covered above as a missing member; nothing extra to add.
    }

    // ================================================================
    // Users
    // ================================================================
    //
    // Matched the way the order importer matches an orderer: by `external_id`,
    // which carries the legacy employee code (or `ke<legacy id>` for a person
    // whose code is held by somebody else). Usernames are `<name>-<code>-ba/op`
    // in production and are only a fallback for accounts never stamped.
    const legacyOrdersByTaker = new Map<number, number>()
    const legacyLiveOrdersByTaker = new Map<number, number>()
    for (const row of listRows) {
      const id = Number(row.OrderTakerID)
      legacyOrdersByTaker.set(id, (legacyOrdersByTaker.get(id) ?? 0) + 1)
      if (Number(row.StatusID) === LEGACY_STATUS_LIVE) {
        legacyLiveOrdersByTaker.set(id, (legacyLiveOrdersByTaker.get(id) ?? 0) + 1)
      }
    }
    const currentUserById = new Map(currentUsers.map((user) => [user.id, user]))
    const accountsByExternalId = new Map<string, Row[]>()
    const accountsByCode = new Map<string, Row[]>()
    const isRetired = (row: Row) => /_RETIRED$/.test(String(row.external_source ?? ""))
    for (const row of liveUserRows) {
      if (isSyntheticAccount(String(row.email)) || isRetired(row)) continue
      if (row.external_source === SOURCE_SYSTEM && row.external_id) {
        const key = String(row.external_id).toLowerCase()
        accountsByExternalId.set(key, [...(accountsByExternalId.get(key) ?? []), row])
      }
      const code = employeeCodeOf(row.username)
      if (code) {
        const key = code.toLowerCase()
        accountsByCode.set(key, [...(accountsByCode.get(key) ?? []), row])
      }
    }
    const personName = (subUser: LegacySubUser) =>
      [subUser.FirstName, subUser.LastName].map((part) => String(part ?? "").trim()).filter(Boolean).join(" ")

    const userRegister: Row[] = []
    const userIssues: Row[] = []
    const claimedAccountIds = new Set<string>()
    for (const subUser of [...legacySubUsers].sort((a, b) => Number(a.ID) - Number(b.ID))) {
      const legacyId = Number(subUser.ID)
      const passcode = String(subUser.Passcode ?? "").trim()
      const email = String(subUser.Email ?? "").trim()
      const locationId = legacyLocationOf(subUser)
      const location = locationId == null ? undefined : legacyLocationById.get(locationId)
      const pin = locationId == null ? undefined : pinByLegacyId.get(locationId)
      const expectedBranch = pin ? branchById.get(pin.branchId) : undefined

      const own = accountsByExternalId.get(contestedIdentityFor(legacyId).toLowerCase()) ?? []
      const holders = passcode
        ? [...new Map([
          ...(accountsByExternalId.get(passcode.toLowerCase()) ?? []),
          ...(accountsByCode.get(passcode.toLowerCase()) ?? []),
        ].map((row) => [String(row.id), row])).values()]
        : []
      const same = holders.filter((account) => isSamePerson(subUser, currentUserById.get(String(account.id))!))
      const others = holders.filter((account) => !same.includes(account))
      let accounts = own.length ? own : same
      const issues: string[] = []
      // An account stamped with a damaged code — leading zero lost, or the
      // code truncated — still carries the full code in its username. Found
      // by that, and reported, so the stamp can be repaired.
      if (accounts.length === 0 && passcode) {
        const stripped = passcode.replace(/^0+/, "")
        const byUsername = liveUserRows.filter((row) =>
          !isSyntheticAccount(String(row.email))
          && new RegExp(`-(${passcode}|${stripped})-(ba|op)$`, "i").test(String(row.username ?? ""))
          && isSamePerson(subUser, currentUserById.get(String(row.id))!))
        if (byUsername.length) {
          accounts = byUsername
          issues.push(`EXTERNAL_ID DIFFERS: DB "${[...new Set(byUsername.map((row) => row.external_id ?? ""))].join("/")}" `
            + `vs legacy code "${passcode}" (matched by username)`)
        }
      }
      for (const account of accounts) claimedAccountIds.add(String(account.id))

      if (!passcode) issues.push("legacy record has no employee code")
      if (accounts.length === 0) {
        issues.push(locationId != null && !pin
          ? `MISSING IN DB (branch "${location?.Name ?? locationId}" not in DB either)`
          : "MISSING IN DB")
      }
      if (others.length) {
        issues.push(`${accounts.length ? "code also" : "CODE"} HELD BY SOMEONE ELSE: ${passcode} is on `
          + [...new Set(others.map((account) => `${account.username} "${account.full_name ?? ""}"`))].join(", ")
          + (accounts.length ? "" : ` — sync would create this person as ${contestedIdentityFor(legacyId)}`))
      }
      const roles = new Set(accounts.map((account) => String(account.role_name)))
      if (accounts.length) {
        if (!roles.has("BRANCH_ADMIN")) issues.push("MISSING ROLE ACCOUNT: no BRANCH_ADMIN (-ba)")
        if (!roles.has("ORDER_PORTAL")) issues.push("MISSING ROLE ACCOUNT: no ORDER_PORTAL (-op)")
      }
      // A head-office account is organization-wide and carries no branch.
      const branchAccounts = accounts.filter((account) => String(account.role_name) !== "HEAD_OFFICE")
      if (expectedBranch && branchAccounts.some((account) => Number(account.branch_id) !== Number(expectedBranch.id))) {
        const wrong = branchAccounts.filter((account) => Number(account.branch_id) !== Number(expectedBranch.id))
        issues.push(`BRANCH DIFFERS: ${wrong.map((account) => `${account.username} @ "${account.branch_name}"`).join(", ")} `
          + `vs legacy "${expectedBranch.name}"`)
      }
      if (locationId != null && !pin && accounts.length) issues.push(`legacy location ${locationId} "${location?.Name ?? ""}" not in DB`)
      const legacyActive = subUser.StatusID == null || Number(subUser.StatusID) === 1
      const inactiveAccounts = accounts.filter((account) => !account.is_active)
      if (legacyActive && accounts.length && inactiveAccounts.length === accounts.length) {
        issues.push("active in legacy, all DB accounts inactive")
      }
      if (!legacyActive && accounts.some((account) => account.is_active)) {
        issues.push(`inactive in legacy (StatusID ${subUser.StatusID}), DB account still active`)
      }
      if (email && accounts.length && !accounts.some((account) =>
        normalizeLegacyText(account.email) === normalizeLegacyText(email))) {
        issues.push(`EMAIL DIFFERS: DB ${[...new Set(accounts.map((account) => account.email))].join("/")} vs legacy ${email}`)
      }
      const legacyName = normalizeName(personName(subUser))
      if (legacyName && accounts.length && !accounts.some((account) => {
        const dbName = normalizeName(account.full_name)
        return dbName === legacyName || dbName.includes(legacyName) || legacyName.includes(dbName)
      })) {
        issues.push(`NAME DIFFERS: DB "${[...new Set(accounts.map((account) => account.full_name))].join("/")}" vs legacy "${personName(subUser)}"`)
      }
      const dbOrders = accounts.reduce((sum, account) => sum + Number(account.orders_created ?? 0), 0)
      const legacyLive = legacyLiveOrdersByTaker.get(legacyId) ?? 0
      if (legacyLive > 0 && dbOrders === 0) issues.push(`placed ${legacyLive} live legacy order(s), none attributed to these accounts in DB`)

      const record = {
        legacy_subuser_id: legacyId,
        legacy_passcode: passcode,
        legacy_name: personName(subUser),
        legacy_email: email,
        legacy_username: subUser.UserName ?? "",
        legacy_location_id: locationId ?? "",
        legacy_location: location?.Name ?? "",
        legacy_active: legacyActive ? "yes" : `no (StatusID ${subUser.StatusID})`,
        legacy_orders_all: legacyOrdersByTaker.get(legacyId) ?? 0,
        legacy_orders_live: legacyLive,
        db_accounts: accounts.map((account) => `${account.username} [${account.role_name}]`).join(" | "),
        db_full_name: [...new Set(accounts.map((account) => account.full_name))].join(" | "),
        db_email: [...new Set(accounts.map((account) => account.email))].join(" | "),
        db_branch: [...new Set(accounts.map((account) => account.branch_name))].join(" | "),
        db_active: accounts.map((account) => (account.is_active ? "yes" : "no")).join(" | "),
        db_external_id: [...new Set(accounts.map((account) => account.external_id ?? ""))].join(" | "),
        db_orders_attributed: dbOrders,
        result: issues.length ? "ISSUE" : "OK",
        issues: issues.join(" | "),
      }
      userRegister.push(record)
      if (issues.length) userIssues.push(record)
    }
    const usersOnlyInDb = userRows
      .filter((row) => !claimedAccountIds.has(String(row.id)))
      .map((row) => ({
        db_user_id: row.id,
        username: row.username ?? "",
        full_name: row.full_name ?? "",
        email: row.email,
        role: row.role_name,
        branch: row.branch_name ?? "",
        is_active: row.is_active ? "yes" : "no",
        soft_deleted: row.deleted_at ? karachiDay(row.deleted_at) : "",
        external_source: row.external_source ?? "",
        external_id: row.external_id ?? "",
        orders_attributed: Number(row.orders_created ?? 0),
        kind: isSyntheticAccount(String(row.email))
          ? "synthetic historical placeholder"
          : isRetired(row)
            ? "retired previous holder of a reissued legacy login (orders kept)"
          : row.deleted_at
            ? "soft-deleted"
            : row.external_source === SOURCE_SYSTEM
              ? "mirrored from legacy, but no legacy person matches"
              : `native OneFlowe account (${row.role_name})`,
      }))

    // ================================================================
    // Products
    // ================================================================
    const productPlan = planProducts(legacyItems, legacyCategories, currentMappings, legacyPriceHistory)
    const categoryLocation = new Map(legacyCategories.map((category) => [Number(category.ID), category.LocationID ?? null]))
    const legacyProductStats = new Map<string, { sourceName: string; prices: Map<number, number>; locations: Set<number>; itemIds: Set<number> }>()
    for (const item of legacyItems) {
      const sourceName = String(item.Name ?? "").trim()
      if (!sourceName) continue
      const key = normalizeProductName(sourceName)
      const entry = legacyProductStats.get(key)
        ?? { sourceName, prices: new Map(), locations: new Set(), itemIds: new Set() }
      const cents = priceToCents(item.Price)
      if (cents != null) entry.prices.set(cents, (entry.prices.get(cents) ?? 0) + 1)
      const locationId = item.CategoryID == null ? null : categoryLocation.get(Number(item.CategoryID))
      if (locationId != null) entry.locations.add(Number(locationId))
      entry.itemIds.add(Number(item.ID))
      legacyProductStats.set(key, entry)
    }
    const historyNames = new Set(legacyPriceHistory.map((row) => normalizeProductName(String(row.ItemName ?? ""))).filter(Boolean))
    // How often each product appears on legacy order lines and on DB items.
    const legacyLineUse = new Map<string, { orders: number; qty: number }>()
    for (const detail of detailsById.values()) {
      const seen = new Set<string>()
      for (const line of detail.OrderDetailsList ?? []) {
        const key = normalizeProductName(String(line.Name ?? ""))
        if (!key) continue
        const entry = legacyLineUse.get(key) ?? { orders: 0, qty: 0 }
        if (!seen.has(key)) { entry.orders += 1; seen.add(key) }
        entry.qty += Number(line.Quantity ?? 0)
        legacyLineUse.set(key, entry)
      }
    }
    const dbLineUse = new Map<number, { orders: number; qty: number }>()
    for (const row of itemRows) {
      const id = Number(row.global_product_id)
      const entry = dbLineUse.get(id) ?? { orders: 0, qty: 0 }
      entry.orders += 1
      entry.qty += Number(row.quantity ?? 0)
      dbLineUse.set(id, entry)
    }
    const productRegister: Row[] = []
    const productIssues: Row[] = []
    const allLegacyProductNames = new Set<string>([
      ...legacyProductStats.keys(), ...historyNames,
      ...productPlan.creates.map((create) => create.normalizedName),
      ...productPlan.existing.map((existing) => existing.normalizedName),
    ])
    const createByName = new Map(productPlan.creates.map((create) => [create.normalizedName, create]))
    const existingByName = new Map(productPlan.existing.map((existing) => [existing.normalizedName, existing]))
    const driftByName = new Map(productPlan.priceDrift.map((drift) => [drift.normalizedName, drift]))
    const skippedProductByName = new Map(productPlan.skipped.map((skip) => [skip.normalizedName, skip]))
    for (const name of [...allLegacyProductNames].sort()) {
      const stats = legacyProductStats.get(name)
      const create = createByName.get(name)
      const existing = existingByName.get(name)
      const skipped = skippedProductByName.get(name)
      const mapping = mappingByName.get(name)
      const modal = existing?.legacyModalCents ?? create?.basePriceCents
        ?? (stats ? [...stats.prices.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] : undefined)
      const distinctPrices = stats ? [...stats.prices.keys()].sort((a, b) => a - b) : []
      const effectiveCents = mapping
        ? (mapping.custom_price_cents ?? mapping.base_price_cents)
        : null
      const issues: string[] = []
      const notes: string[] = []
      if (!mapping) {
        issues.push(skipped
          ? `MISSING IN DB (sync skips: ${skipped.reason} — ${skipped.detail})`
          : "MISSING IN DB (no legacy_product_mappings row)")
      } else {
        if (mapping.inventory_deleted_at) issues.push("mapped organization_inventory row is deleted")
        if (modal != null && effectiveCents != null && effectiveCents !== modal) {
          issues.push(`PRICE DIFFERS: K-Electric pays ${money(effectiveCents)} here vs legacy ${money(modal)}`)
        }
        // The global base price is shared by every tenant; K-Electric's own
        // organization override is what it is charged, so a base-price gap
        // with the override in place is information, not a discrepancy.
        const drift = driftByName.get(name)
        if (drift && effectiveCents === modal) {
          notes.push(`global base price ${money(drift.currentCents)} differs from legacy ${money(drift.legacyModalCents)}; org override ${money(effectiveCents)} matches`)
        }
      }
      if (distinctPrices.length > 1) {
        notes.push(`legacy prices this differently per branch: ${distinctPrices.map((cents) => money(cents)).join(", ")} (modal used)`)
      }
      const use = legacyLineUse.get(name)
      const dbUse = mapping ? dbLineUse.get(Number(mapping.global_product_id)) : undefined
      const record = {
        legacy_product: stats?.sourceName ?? create?.sourceName ?? mapping?.source_name ?? name,
        normalized_name: name,
        legacy_source: stats ? "item list (currently sold)" : historyNames.has(name) ? "price history only (retired)" : "order lines only",
        legacy_branches_stocking: stats?.locations.size ?? "",
        legacy_item_rows: stats?.itemIds.size ?? "",
        legacy_modal_price: money(modal),
        legacy_distinct_prices: distinctPrices.length,
        legacy_orders_using: use?.orders ?? 0,
        legacy_qty_ordered: use?.qty ?? 0,
        db_global_product_id: mapping ? Number(mapping.global_product_id) : "",
        db_product_code: mapping?.product_code ?? "",
        db_product_name: mapping?.product_name ?? "",
        db_global_base_price: mapping ? money(mapping.base_price_cents) : "",
        db_org_price_override: mapping && mapping.custom_price_cents != null ? money(mapping.custom_price_cents) : "",
        db_effective_org_price: effectiveCents == null ? "" : money(effectiveCents),
        db_inventory_active: mapping ? (mapping.inventory_active ? "yes" : "no") : "",
        db_order_lines_using: dbUse?.orders ?? 0,
        db_qty_ordered: dbUse?.qty ?? 0,
        result: issues.length ? "ISSUE" : "OK",
        issues: issues.join(" | "),
        notes: notes.join(" | "),
      }
      productRegister.push(record)
      if (issues.length) productIssues.push(record)
    }
    const mappedProductIds = new Set(mappingRows.map((row) => Number(row.global_product_id)))
    const productsOnlyInDb = inventoryRows
      .filter((row) => !mappedProductIds.has(Number(row.global_product_id)))
      .map((row) => ({
        db_organization_inventory_id: Number(row.id),
        db_global_product_id: Number(row.global_product_id),
        db_product_name: row.name,
        db_product_code: row.product_code ?? "",
        db_global_base_price: money(row.base_price_cents),
        db_org_price_override: row.custom_price_cents == null ? "" : money(row.custom_price_cents),
        db_inventory_active: row.is_active ? "yes" : "no",
        db_order_lines_using: dbLineUse.get(Number(row.global_product_id))?.orders ?? 0,
        legacy_match_by_name: legacyProductStats.has(normalizeProductName(String(row.name)))
          ? "name matches a legacy product but no mapping row exists"
          : "no legacy product with this name",
      }))

    // ================================================================
    // Budgets (current tenure only — legacy exposes nothing older)
    // ================================================================
    const budgetPlan = planBranchBudgets(
      legacyLocations as any,
      new Map(branchPlan.pins.map((pin) => [pin.legacyLocationId, { branchId: pin.branchId, name: pin.legacyName }])),
      currentBudgets,
    )
    // This report compares; it never applies. A row the sync would raise and
    // one it would only report are both "differs" here.
    const budgetDifferences = [
      ...budgetPlan.raises.map((entry) => ({ ...entry, legacyCents: entry.amountAllocatedCents })),
      ...budgetPlan.drift,
    ]
    const budgetSheet: Row[] = [
      ...budgetPlan.creates.map((entry) => ({
        legacy_location_id: entry.legacyLocationId, branch: entry.branchName, db_branch_id: entry.branchId,
        period: entry.period, legacy_monthly_budget: money(entry.amountAllocatedCents), db_allocated: "",
        result: "MISSING IN DB", detail: "no budgets row for this branch and period",
      })),
      ...budgetDifferences.map((entry) => ({
        legacy_location_id: "", branch: entry.branchName, db_branch_id: entry.branchId,
        period: entry.period, legacy_monthly_budget: money(entry.legacyCents), db_allocated: money(entry.currentCents),
        result: "AMOUNT DIFFERS", detail: `difference ${money(entry.legacyCents - entry.currentCents)}`,
      })),
      ...budgetPlan.skipped.map((entry) => ({
        legacy_location_id: entry.legacyLocationId, branch: entry.branchName, db_branch_id: "",
        period: "", legacy_monthly_budget: "", db_allocated: "",
        result: `SKIPPED (${entry.reason})`, detail: entry.detail,
      })),
    ]

    // ================================================================
    // Orders
    // ================================================================
    const ledgerByLegacyId = new Map<number, Row>()
    const ledgerByIdentity = new Map<string, Row>()
    const ordersNotInLedger: Row[] = []
    for (const row of orderRows) {
      if (row.legacy_order_id == null) { ordersNotInLedger.push(row); continue }
      ledgerByLegacyId.set(Number(row.legacy_order_id), row)
      const header = row.source_payload?.header ?? row.source_payload?.sourceHeader
      if (header) {
        ledgerByIdentity.set(orderIdentityKey({
          locationName: header.LocationName, transactionNo: header.TransactionNo,
          orderNo: header.OrderNo, date: header.OrderCreatedDT,
        }), row)
      }
    }
    const identitiesByTaker = new Map<number, string[]>()
    for (const subUser of legacySubUsers) {
      identitiesByTaker.set(Number(subUser.ID),
        [contestedIdentityFor(Number(subUser.ID)), String(subUser.Passcode ?? "").trim()].filter(Boolean).map((v) => v.toLowerCase()))
    }
    const legacySubUserById = new Map(legacySubUsers.map((subUser) => [Number(subUser.ID), subUser]))

    const orderRegister: Row[] = []
    const ordersMissing: Row[] = []
    const orderMismatches: Row[] = []
    const itemMismatches: Row[] = []
    const matchedLegacyIds = new Set<number>()
    /**
     * DB lines aggregated by product, at their gross (tax-inclusive) value.
     *
     * Two conventions exist side by side: the first one-off migration stored
     * the unit price net and added `tax_cents` on top, every later import
     * stored the unit price gross with `tax_cents` split out of it. Whichever
     * reproduces the order's own `total_cents` is the one in use.
     */
    const dbLinesFor = (order: Row) => {
      const items = itemsByOrderId.get(Number(order.id)) ?? []
      const total = Number(order.total_cents)
      const inclusive = items.reduce((sum, item) => sum + Math.round(Number(item.price_cents) * Number(item.quantity)), 0)
      const itemTax = items.reduce((sum, item) => sum + Number(item.tax_cents ?? 0), 0)
      // Three shapes: price gross (later imports); price net with tax on each
      // item; price net with the tax held only on the order row (the first
      // migration), in which case the lines are grossed up proportionally,
      // exactly as the importer grosses up a VAT-on-top legacy order.
      let convention: "gross" | "net + item tax" | "net + order tax" = "gross"
      if (inclusive !== total && inclusive + itemTax === total) convention = "net + item tax"
      else if (inclusive !== total && inclusive + Number(order.tax_cents ?? 0) === total && inclusive > 0) convention = "net + order tax"
      const aggregated = new Map<string, { name: string; qty: number; grossCents: number }>()
      const zeroLines: string[] = []
      for (const item of items) {
        if (Number(item.quantity) === 0) {
          zeroLines.push(String(item.product_name))
          continue
        }
        const key = item.global_product_id != null
          ? `p${Number(item.global_product_id)}`
          : `n${normalizeProductName(String(item.product_name))}`
        const entry = aggregated.get(key) ?? { name: String(item.product_name), qty: 0, grossCents: 0 }
        const net = Math.round(Number(item.price_cents) * Number(item.quantity))
        entry.qty += Number(item.quantity)
        entry.grossCents += convention === "net + item tax"
          ? net + Number(item.tax_cents ?? 0)
          : convention === "net + order tax"
            ? Math.round((net * total) / inclusive)
            : net
        aggregated.set(key, entry)
      }
      const grossCents = [...aggregated.values()].reduce((sum, line) => sum + line.grossCents, 0)
      return { lines: aggregated, grossCents, convention, zeroLines }
    }
    const legacyLinesFor = (legacyOrderId: number, prepared: PreparedApiOrder | undefined) => {
      const aggregated = new Map<string, { name: string; qty: number; grossCents: number }>()
      const keyFor = (normalized: string) => {
        const mapping = mappingByName.get(normalized)
        return mapping ? `p${Number(mapping.global_product_id)}` : `n${normalized}`
      }
      if (prepared) {
        for (const line of prepared.lines) {
          const key = keyFor(line.normalizedName)
          const entry = aggregated.get(key) ?? { name: line.sourceName, qty: 0, grossCents: 0 }
          entry.qty += line.quantity
          entry.grossCents += line.lineTotalCents
          aggregated.set(key, entry)
        }
        return aggregated
      }
      for (const line of detailsById.get(legacyOrderId)?.OrderDetailsList ?? []) {
        const name = String(line.Name ?? "").trim()
        if (!name) continue
        const qty = Number(line.Quantity ?? 0)
        const gross = Math.abs(centsFrom(line.Price, "line"))
        if (qty === 0 && gross === 0) continue
        const key = keyFor(normalizeProductName(name))
        const entry = aggregated.get(key) ?? { name, qty: 0, grossCents: 0 }
        entry.qty += qty
        entry.grossCents += gross
        aggregated.set(key, entry)
      }
      return aggregated
    }

    for (const header of listRows) {
      const legacyOrderId = Number(header.ID)
      const statusId = Number(header.StatusID)
      const prepared = preparedById.get(legacyOrderId)
      const rejected = rejectedById.get(legacyOrderId)
      const detail = detailsById.get(legacyOrderId)
      const expected = mapDeliveryStatus(Number(header.DeliveryStatus))
      const dbOrder = ledgerByLegacyId.get(legacyOrderId) ?? ledgerByIdentity.get(identityKeyForListRow(header))
      if (dbOrder) matchedLegacyIds.add(legacyOrderId)
      const pin = pinByLegacyId.get(Number(header.LocationID))
      const taker = legacySubUserById.get(Number(header.OrderTakerID))
      const creator = dbOrder ? userById.get(String(dbOrder.created_by_user_id)) : undefined
      const legacyTotalCents = header.GrandTotal == null ? null : centsFrom(header.GrandTotal, "total")
      const legacyLines = legacyLinesFor(legacyOrderId, prepared)
      const legacyLineCount = legacyLines.size
      const legacyLinesGross = [...legacyLines.values()].reduce((sum, line) => sum + line.grossCents, 0)

      const shouldExist = statusId === LEGACY_STATUS_LIVE
      const policy = statusId === LEGACY_STATUS_CANCELLED ? "cancelled — not imported by design"
        : statusId === LEGACY_STATUS_DRAFT ? "unsubmitted draft — not imported by design"
          : statusId === LEGACY_STATUS_TEST ? "StatusID 4 (legacy shows Refunded; importer skips it as TEST_ORDER)"
            : statusId === LEGACY_STATUS_LIVE ? "live — must exist in DB"
              : `unknown StatusID ${statusId}`

      const issues: string[] = []
      let result: string
      if (!dbOrder) {
        if (shouldExist) {
          result = "MISSING IN DB"
          if (rejected) issues.push(`importer would reject: ${rejected.reason} — ${rejected.detail}`)
          else if (detailFailures.has(legacyOrderId)) issues.push(`detail fetch failed: ${detailFailures.get(legacyOrderId)}`)
          else if (prepared) {
            const blockers: string[] = []
            if (!pin) blockers.push(`branch "${header.LocationName}" not in DB`)
            const identities = identitiesByTaker.get(Number(header.OrderTakerID)) ?? []
            const hasUser = identities.some((identity) => (accountsByExternalId.get(identity) ?? [])
              .some((account) => String(account.role_name) === "ORDER_PORTAL"))
            if (!hasUser) blockers.push(`orderer "${header.UserDetails}" (taker ${header.OrderTakerID}) has no ORDER_PORTAL account`)
            const unmapped = prepared.lines.filter((line) => !mappingByName.has(line.normalizedName))
            if (unmapped.length) blockers.push(`product(s) not in catalogue: ${[...new Set(unmapped.map((line) => line.sourceName))].join("; ")}`)
            issues.push(blockers.length ? `import blocked by: ${blockers.join(" / ")}` : "importable as-is (run import:ke-orders)")
          }
        } else {
          result = "NOT IN DB (by design)"
        }
      } else {
        result = "IN DB"
        if (!shouldExist) issues.push(`in DB although legacy status is: ${policy}`)
        if (legacyTotalCents != null && Number(dbOrder.total_cents) !== legacyTotalCents) {
          issues.push(`TOTAL DIFFERS: DB ${money(dbOrder.total_cents)} vs legacy ${money(legacyTotalCents)}`)
        }
        if (expected && shouldExist) {
          const dbPair = `${dbOrder.status}/${dbOrder.fulfillment_status}`
          const expectedPair = `${expected.status}/${expected.fulfillmentStatus}`
          if (dbPair !== expectedPair) {
            issues.push(dbOrder.status === "REFUNDED"
              ? `STATUS: DB REFUNDED (${money(dbOrder.refund_amount_cents)}), legacy ${legacyStatusText(header)}`
              : `STATUS DIFFERS: DB ${dbPair} vs legacy ${legacyStatusText(header)} (${expectedPair})`)
          }
        }
        if (pin && Number(dbOrder.branch_id) !== pin.branchId) {
          issues.push(`BRANCH DIFFERS: DB "${branchById.get(Number(dbOrder.branch_id))?.name ?? dbOrder.branch_id}" vs legacy "${header.LocationName}"`)
        } else if (!pin) {
          issues.push(`legacy branch "${header.LocationName}" (${header.LocationID}) is not pinned to any DB branch`)
        }
        const identities = identitiesByTaker.get(Number(header.OrderTakerID)) ?? []
        const creatorExternal = String(creator?.external_id ?? "").toLowerCase()
        const creatorIsTaker = creatorExternal && identities.includes(creatorExternal)
        if (!creatorIsTaker) {
          const legacyUser = normalizeLegacyText(String(header.UserDetails ?? "").replace(/\s-$/, ""))
          const dbUser = normalizeLegacyText(creator?.full_name)
          const nameAgrees = legacyUser && dbUser && (dbUser.includes(legacyUser) || legacyUser.includes(dbUser))
          if (!nameAgrees) {
            issues.push(`ORDERER DIFFERS: DB ${creator?.username ?? "?"} "${creator?.full_name ?? ""}" `
              + `vs legacy "${header.UserDetails}" (taker ${header.OrderTakerID}${taker ? `, code ${taker.Passcode}` : ", not in legacy user list"})`)
          }
        }
        const distance = dayDistance(karachiDay(dbOrder.created_at), legacyDay(header.CreatedOn ?? header.OrderCreatedDT))
        if (distance != null && distance > 1) {
          issues.push(`DATE DIFFERS: DB ${karachiDay(dbOrder.created_at)} vs legacy ${legacyDay(header.CreatedOn ?? header.OrderCreatedDT)}`)
        }
        const refundedBothSides = statusId === LEGACY_STATUS_TEST && String(dbOrder.status) === "REFUNDED"
        if (refundedBothSides) {
          issues.push("refunded in both systems (legacy zeroes refunded lines, so lines are not compared)")
        } else if (detail) {
          const { lines: dbLines, grossCents: dbGross, zeroLines } = dbLinesFor(dbOrder)
          for (const name of zeroLines) {
            itemMismatches.push({
              legacy_order_id: legacyOrderId, db_order_id: Number(dbOrder.id), branch: header.LocationName,
              order_date: legacyDay(header.CreatedOn ?? header.OrderCreatedDT),
              legacy_product: "", db_product: name, problem: "ZERO-VALUE LINE ONLY IN DB (no qty, no value — harmless)",
              legacy_qty: "", db_qty: 0, legacy_line_total: "", db_line_total: 0,
            })
          }
          if (dbLines.size !== legacyLineCount) {
            issues.push(`LINE COUNT DIFFERS: DB ${dbLines.size} product(s) vs legacy ${legacyLineCount}`)
          }
          if (legacyLinesGross !== dbGross) {
            issues.push(`ITEMS TOTAL DIFFERS: DB lines ${money(dbGross)} vs legacy lines ${money(legacyLinesGross)}`)
          }
          const base = {
            legacy_order_id: legacyOrderId, db_order_id: Number(dbOrder.id), branch: header.LocationName,
            order_date: legacyDay(header.CreatedOn ?? header.OrderCreatedDT),
          }
          const missingLines: Array<{ key: string; line: { name: string; qty: number; grossCents: number } }> = []
          const extraLines: Array<{ key: string; line: { name: string; qty: number; grossCents: number } }> = []
          for (const [key, legacyLine] of legacyLines) {
            const dbLine = dbLines.get(key)
            if (!dbLine) { missingLines.push({ key, line: legacyLine }); continue }
            if (dbLine.qty !== legacyLine.qty || dbLine.grossCents !== legacyLine.grossCents) {
              itemMismatches.push({
                ...base,
                legacy_product: legacyLine.name, db_product: dbLine.name,
                problem: dbLine.qty !== legacyLine.qty ? "QUANTITY DIFFERS"
                  : legacyLine.grossCents === 0 ? "LEGACY LINE PRICED AT ZERO" : "LINE TOTAL DIFFERS",
                legacy_qty: legacyLine.qty, db_qty: dbLine.qty,
                legacy_line_total: money(legacyLine.grossCents), db_line_total: money(dbLine.grossCents),
              })
            }
          }
          for (const [key, dbLine] of dbLines) {
            if (!legacyLines.has(key)) extraLines.push({ key, line: dbLine })
          }
          // A legacy line absent here while a DB line of identical quantity
          // and value is present is the same purchase recorded under another
          // catalogue entry — report it as one row, not as missing plus extra.
          for (const missing of [...missingLines]) {
            const twin = extraLines.find((extra) =>
              extra.line.qty === missing.line.qty && extra.line.grossCents === missing.line.grossCents)
            if (!twin) continue
            extraLines.splice(extraLines.indexOf(twin), 1)
            missingLines.splice(missingLines.indexOf(missing), 1)
            itemMismatches.push({
              ...base,
              legacy_product: missing.line.name, db_product: twin.line.name,
              problem: "PRODUCT DIFFERS (same qty & value)",
              legacy_qty: missing.line.qty, db_qty: twin.line.qty,
              legacy_line_total: money(missing.line.grossCents), db_line_total: money(twin.line.grossCents),
            })
          }
          for (const { line } of missingLines) {
            itemMismatches.push({
              ...base, legacy_product: line.name, db_product: "", problem: "LINE MISSING IN DB",
              legacy_qty: line.qty, db_qty: "", legacy_line_total: money(line.grossCents), db_line_total: "",
            })
          }
          for (const { line } of extraLines) {
            itemMismatches.push({
              ...base, legacy_product: "", db_product: line.name, problem: "LINE ONLY IN DB",
              legacy_qty: "", db_qty: line.qty, legacy_line_total: "", db_line_total: money(line.grossCents),
            })
          }
        } else if (shouldExist) {
          issues.push("legacy detail unavailable; lines not compared")
        }
      }

      const record = {
        legacy_order_id: legacyOrderId,
        legacy_transaction_no: header.TransactionNo,
        legacy_order_no: header.OrderNo,
        legacy_date: legacyDay(header.CreatedOn ?? header.OrderCreatedDT),
        legacy_branch: header.LocationName,
        legacy_group: header.LocationGroup,
        legacy_orderer: String(header.UserDetails ?? "").trim(),
        legacy_orderer_code: taker?.Passcode ?? "",
        legacy_status: legacyStatusText(header),
        legacy_status_ids: `${header.StatusID}/${header.DeliveryStatus}`,
        legacy_policy: policy,
        legacy_grand_total: money(legacyTotalCents),
        legacy_lines: legacyLineCount,
        legacy_lines_total: detail ? money(legacyLinesGross) : "",
        db_order_id: dbOrder ? Number(dbOrder.id) : "",
        db_date: dbOrder ? karachiDay(dbOrder.created_at) : "",
        db_branch: dbOrder ? branchById.get(Number(dbOrder.branch_id))?.name ?? "" : "",
        db_orderer: creator ? `${creator.username} (${creator.full_name ?? ""})` : "",
        db_status: dbOrder ? `${dbOrder.status}/${dbOrder.fulfillment_status}` : "",
        db_payment_status: dbOrder?.payment_status ?? "",
        db_total: dbOrder ? money(dbOrder.total_cents) : "",
        db_refund: dbOrder && dbOrder.refund_amount_cents != null ? money(dbOrder.refund_amount_cents) : "",
        db_lines: dbOrder ? Number(dbOrder.item_count) : "",
        db_lines_total: dbOrder ? money(dbLinesFor(dbOrder).grossCents) : "",
        db_price_convention: dbOrder ? dbLinesFor(dbOrder).convention : "",
        result,
        issues: issues.join(" | "),
      }
      orderRegister.push(record)
      if (result === "MISSING IN DB") ordersMissing.push(record)
      else if (result === "IN DB" && issues.length) orderMismatches.push(record)
    }
    const ordersOnlyInDb: Row[] = [
      ...orderRows
        .filter((row) => row.legacy_order_id != null && !matchedLegacyIds.has(Number(row.legacy_order_id))),
      ...ordersNotInLedger,
    ].map((row) => {
      const creator = userById.get(String(row.created_by_user_id))
      return {
        db_order_id: Number(row.id),
        ledger_legacy_order_id: row.legacy_order_id ?? "",
        db_date: karachiDay(row.created_at),
        db_branch: branchById.get(Number(row.branch_id))?.name ?? "",
        db_orderer: creator ? `${creator.username} (${creator.full_name ?? ""})` : "",
        db_status: `${row.status}/${row.fulfillment_status}`,
        db_total: money(row.total_cents),
        db_lines: Number(row.item_count),
        group_order: row.group_order_id ? "yes" : "",
        note: row.legacy_order_id == null
          ? "Placed in OneFlowe directly (no legacy import record)"
          : "Import ledger points at a legacy order id the legacy list no longer returns",
      }
    })

    // ================================================================
    // Summary
    // ================================================================
    const liveLegacy = listRows.filter((row) => Number(row.StatusID) === LEGACY_STATUS_LIVE)
    const liveMissing = ordersMissing.length
    const liveInDb = liveLegacy.filter((row) => matchedLegacyIds.has(Number(row.ID))).length
    const nonLiveInDb = listRows.filter((row) => Number(row.StatusID) !== LEGACY_STATUS_LIVE && matchedLegacyIds.has(Number(row.ID))).length
    const totalLegacyLive = liveLegacy.reduce((sum, row) => sum + (row.GrandTotal == null ? 0 : centsFrom(row.GrandTotal, "t")), 0)
    const totalMissing = ordersMissing.reduce((sum, row) => sum + (row.legacy_grand_total === "" ? 0 : Number(row.legacy_grand_total) * 100), 0)
    const totalDb = orderRows.reduce((sum, row) => sum + Number(row.total_cents), 0)
    const summary: Row[] = [
      { entity: "Generated", legacy: new Date().toISOString(), oneflowe: "", matched: "", missing_in_db: "", only_in_db: "", with_differences: "", note: "" },
      { entity: "Legacy source", legacy: KE_LOGISTICS_BASE_URL, oneflowe: `organization ${org.id} / ${org.code} / ${org.name}`, matched: "", missing_in_db: "", only_in_db: "", with_differences: "", note: "" },
      { entity: "", legacy: "", oneflowe: "", matched: "", missing_in_db: "", only_in_db: "", with_differences: "", note: "" },
      {
        entity: "Orders — all legacy statuses", legacy: listRows.length, oneflowe: orderRows.length,
        matched: matchedLegacyIds.size, missing_in_db: listRows.length - matchedLegacyIds.size,
        only_in_db: ordersOnlyInDb.length, with_differences: orderMismatches.length,
        note: "Cancelled, draft and test orders are deliberately not imported; see the live row for what must match.",
      },
      {
        entity: "Orders — LIVE (StatusID 2)", legacy: liveLegacy.length, oneflowe: liveInDb + nonLiveInDb,
        matched: liveInDb, missing_in_db: liveMissing, only_in_db: "", with_differences: "",
        note: `${nonLiveInDb} DB order(s) sit on a legacy row that is no longer live. Legacy live value PKR ${Number(money(totalLegacyLive)).toLocaleString("en-US")}; value of the missing orders PKR ${Number(money(totalMissing)).toLocaleString("en-US")}; all DB orders PKR ${Number(money(totalDb)).toLocaleString("en-US")}.`,
      },
      {
        entity: "Order lines (matched orders)", legacy: "", oneflowe: "", matched: "", missing_in_db: itemMismatches.filter((row) => row.problem === "LINE MISSING IN DB").length,
        only_in_db: itemMismatches.filter((row) => row.problem === "LINE ONLY IN DB").length,
        with_differences: itemMismatches.filter((row) => row.problem !== "LINE MISSING IN DB" && row.problem !== "LINE ONLY IN DB" && !row.problem.startsWith("ZERO-VALUE")).length,
        note: "Compared per product per order: quantity and gross (tax-inclusive) line total. 'with differences' includes lines recorded under a different catalogue entry.",
      },
      {
        entity: "Branches", legacy: legacyLocations.length, oneflowe: branchRows.length,
        matched: branchPlan.pins.length, missing_in_db: branchPlan.creates.length + branchPlan.ambiguous.length,
        only_in_db: branchesOnlyInDb.length, with_differences: branchIssues.length - branchPlan.creates.length - branchPlan.ambiguous.length,
        note: "Matched by external_id, then the confirmed name overrides, then exact name.",
      },
      {
        entity: "Groups", legacy: legacyGroups.length, oneflowe: groupRows.length,
        matched: groupRegister.filter((row) => row.legacy_group_id !== "" && row.db_group_id !== "").length,
        missing_in_db: groupPlan.missingGroups.length,
        only_in_db: groupRegister.filter((row) => row.issues === "ONLY IN DB").length,
        with_differences: groupMembership.length, note: "Differences are membership: a branch in one group here and another in legacy.",
      },
      {
        entity: "Users (legacy people)", legacy: legacySubUsers.length, oneflowe: userRows.length,
        matched: userRegister.filter((row) => row.db_accounts !== "").length,
        missing_in_db: userRegister.filter((row) => row.db_accounts === "").length,
        only_in_db: usersOnlyInDb.length,
        with_differences: userIssues.filter((row) => row.db_accounts !== "").length,
        note: "Each legacy person should hold two DB accounts (-ba approver, -op orderer) at the legacy branch. 'Only in DB' includes native, synthetic and soft-deleted accounts.",
      },
      {
        entity: "Products", legacy: allLegacyProductNames.size, oneflowe: inventoryRows.length,
        matched: productRegister.filter((row) => row.db_global_product_id !== "").length,
        missing_in_db: productRegister.filter((row) => row.db_global_product_id === "").length,
        only_in_db: productsOnlyInDb.length,
        with_differences: productIssues.filter((row) => row.db_global_product_id !== "").length,
        note: "Legacy has one item row per product per branch; compared by normalized product name, as the import does.",
      },
      {
        entity: "Branch budgets (current tenure)", legacy: legacyLocations.filter((location) => location.MonthlyBudget != null).length,
        oneflowe: budgetRows.length, matched: budgetPlan.unchanged,
        missing_in_db: budgetPlan.creates.length, only_in_db: "", with_differences: budgetDifferences.length,
        note: `${budgetPlan.skipped.length} legacy location(s) skipped. Legacy exposes only the current month's budget.`,
      },
    ]

    XLSX.utils.book_append_sheet(book, sheet(summary), "0-Summary")
    index.push({ sheet: "0-Summary", rows: summary.length, meaning: "Counts per entity" })
    add("1-Orders missing in DB", ordersMissing,
      "Legacy LIVE orders with no OneFlowe order. 'issues' says whether the importer can take them as-is or what blocks them.",
      "every live legacy order is in the database")
    add("2-Orders only in DB", ordersOnlyInDb,
      "OneFlowe orders for K-Electric that legacy does not list (placed natively, or legacy removed the row).")
    add("3-Orders with differences", orderMismatches,
      "Orders present in both systems whose total, status, branch, orderer, date or lines differ.")
    add("4-Order line differences", itemMismatches,
      "Per product per order: missing lines, extra lines, quantity or line-total differences.")
    add("5-Order register (all)", orderRegister,
      "Every legacy order side by side with its OneFlowe counterpart, including cancelled/draft/test rows.")
    add("6-Branch issues", branchIssues, "Legacy locations missing here, or matched with a different name/group/status.")
    add("7-Branches only in DB", branchesOnlyInDb, "OneFlowe branches with no legacy location.")
    add("8-Branch register (all)", branchRegister, "Every legacy location with its OneFlowe branch.")
    add("9-Groups", groupRegister, "Legacy groups vs OneFlowe groups.")
    add("10-Group membership diffs", groupMembership, "Branches whose group differs between the two systems.")
    add("11-User issues", userIssues, "Legacy people with no account, a missing role account, wrong branch, or drifted name/email.")
    add("12-Users only in DB", usersOnlyInDb, "OneFlowe accounts no legacy person claims (native, synthetic, soft-deleted, or stale mirrors).")
    add("13-User register (all)", userRegister, "Every legacy person with the OneFlowe accounts matched to them.")
    add("14-Product issues", productIssues, "Legacy products missing here, or mapped with a different price.")
    add("15-Products only in DB", productsOnlyInDb, "Organization inventory rows with no legacy mapping.")
    add("16-Product register (all)", productRegister, "Every legacy product with its OneFlowe catalogue entry.")
    add("17-Branch budgets", budgetSheet, "Current-month legacy budget vs the budgets row here.", "every current-month legacy budget matches")

    XLSX.utils.book_append_sheet(book, sheet(index), "Index")
    book.SheetNames = ["0-Summary", ...book.SheetNames.filter((name) => name !== "0-Summary")]

    mkdirSync(dirname(output), { recursive: true })
    XLSX.writeFile(book, output)
    console.log(`\nWorkbook: ${output}`)
    for (const row of summary.slice(3)) {
      console.log(`  ${String(row.entity).padEnd(36)} legacy ${String(row.legacy).padStart(5)}  db ${String(row.oneflowe).padStart(5)}`
        + `  matched ${String(row.matched).padStart(5)}  missing ${String(row.missing_in_db).padStart(4)}`
        + `  only-db ${String(row.only_in_db).padStart(4)}  diffs ${String(row.with_differences).padStart(4)}`)
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
