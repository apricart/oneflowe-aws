#!/usr/bin/env tsx
/**
 * Repeatable K-Electric order import from the legacy logistics API.
 *
 * Unlike the one-off migrations beside it, this script takes a date range
 * rather than a prepared snapshot directory, and can be re-run as often as new
 * orders appear. Everything it needs comes from the legacy API: the list
 * endpoint supplies order headers, the detail endpoint supplies the line items
 * that the "Orders (N).xls" export omits entirely.
 *
 * Read-only by default:
 *   npx tsx scripts/import-ke-orders.ts --start-date=2026-07-01 --end-date=2026-08-25
 *
 * A live import requires every value the dry run prints:
 *   npx tsx scripts/import-ke-orders.ts --start-date=... --end-date=... --commit \
 *     --actor-user-id=<active-super-admin-uuid> \
 *     --confirm-organization=10:0001:K-Electric \
 *     --confirm-plan=<printed-plan-digest> \
 *     --expected-orders=<printed-ready-count>
 *
 * Ledger policy — deliberately *not* the live order API's behaviour. Creating
 * these through `POST /api/v1/orders` would consume this month's budget for
 * purchases made weeks ago, advance the shared invoice sequence, decrement
 * present-day stock, and email every branch about orders they already received.
 * Instead this writes the order and its items exactly as the existing 820
 * K-Electric orders were written — same statuses, same tax treatment, same
 * `KE-LEGACY-<id>` invoice number — and leaves the operational ledgers alone.
 * Budget consumption is applied afterwards by `backfill-ke-budget-spend.ts`,
 * which recomputes spend and holds from `orders.created_at` and so produces the
 * same result as charging at import time, but only once the periods are funded.
 */

import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import * as dotenv from "dotenv"

import { generateApprovalToken, hashApprovalToken } from "../lib/approval-token"
import {
  KE_ORDERS_ORGANIZATION as ORGANIZATION,
  KE_ORDERS_SOURCE as SOURCE_SYSTEM,
  KE_LOGISTICS_BASE_URL,
  KE_ORDERS_LIST_PATH,
  computeOrderTax,
  identityKeyForListRow,
  monthWindows,
  type LegacyRefund,
  orderIdentityKey,
  prepareApiOrders,
  reconcileAgainstSheet,
  type PreparedApiOrder,
  type SheetRow,
} from "../lib/legacy-import/ke-orders-api"
import {
  canonicalJson,
  normalizeLegacyProduct,
  normalizeLegacyText,
  sha256,
  type LegacyOrderDetail,
  type LegacyOrderListRow,
} from "../lib/legacy-import/ke-post-cutoff"
import {
  indexBranches,
  resolveLegacyBranch,
  type CatalogueBranch,
} from "../lib/legacy-import/ke-order-branches"
import { contestedIdentityFor, type LegacySubUser } from "../lib/legacy-import/ke-sync"
import { resolveWorkspacePath } from "./lib/resolve-workspace-path"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

/**
 * The organization this run targets.
 *
 * Resolved at run time rather than compiled in, so the same script serves a
 * production import against K-Electric (10/0001) and a rehearsal on a test
 * database, where that organization has a different id and code. Mirrors
 * `sync-ke.ts`, and the two must agree or the orders land in a tenant whose
 * branches and users the sync never created.
 */
type TargetOrganization = { id: number; code: string; name: string }
let target: TargetOrganization = { ...ORGANIZATION }

function organizationConfirmation(org: TargetOrganization): string {
  return `${org.id}:${org.code}:${org.name}`
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The earliest date any K-Electric order exists on the legacy platform.
 * Used as the default lower bound so a bare run sweeps the whole history.
 */
const LEGACY_EPOCH = "2025-01-01"
/**
 * Detail fetches run in parallel, but gently: at six the legacy platform began
 * answering 403 partway through a full-history sweep. Three keeps a ~1,000-order
 * run inside its tolerance, and `backoffMs` recovers if it still trips.
 */
const DETAIL_CONCURRENCY = 3
const FETCH_ATTEMPTS = 6

type Row = Record<string, any>
interface QueryClient { query(text: string, params?: unknown[]): Promise<{ rows: Row[] }> }

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

interface Options {
  startDate: string
  endDate: string
  commit: boolean
  rollbackTest: boolean
  actorUserId?: string
  confirmOrganization?: string
  confirmPlan?: string
  expectedOrders?: number
  sheetPath?: string
  organizationCode: string
  organizationName: string
  outputPath: string
}

function parseOptions(): Options {
  // Both bounds default to a full sweep, because the common case is "bring
  // across everything K-Electric has that we do not". Orders already present
  // are recognised by `alreadyImported` and skipped, so a full sweep on a
  // populated database is cheap and writes nothing new — which makes the wide
  // default safe rather than merely convenient. Narrow it only to inspect a
  // particular window.
  const startDate = argument("start-date") ?? LEGACY_EPOCH
  const endDate = argument("end-date") ?? new Date().toISOString().slice(0, 10)
  assert(ISO_DATE.test(startDate), "--start-date must be YYYY-MM-DD")
  assert(ISO_DATE.test(endDate), "--end-date must be YYYY-MM-DD")
  assert(startDate <= endDate, "--start-date must not be after --end-date")
  const expected = argument("expected-orders")
  return {
    startDate,
    endDate,
    commit: flag("commit"),
    rollbackTest: flag("rollback-test"),
    actorUserId: argument("actor-user-id"),
    confirmOrganization: argument("confirm-organization"),
    confirmPlan: argument("confirm-plan"),
    expectedOrders: expected === undefined ? undefined : Number(expected),
    sheetPath: argument("sheet"),
    organizationCode: argument("organization-code") ?? ORGANIZATION.code,
    organizationName: argument("organization-name") ?? ORGANIZATION.name,
    outputPath: resolveWorkspacePath(
      argument("output") ?? `updatedReports/ke-orders-import-${startDate}-to-${endDate}.json`,
    ),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Back-off for one failed attempt, in milliseconds.
 *
 * A full history sweep is ~1,000 detail calls, and the legacy platform starts
 * answering 403 partway through. That is throttling, not a transient network
 * blip: retrying it half a second later fails again and burns the budget, so
 * the whole run dies on one order. Throttling therefore gets a much longer,
 * exponential wait (5s, 15s, 45s, ...) while ordinary errors keep the short one.
 */
function backoffMs(status: number | null, attempt: number): number {
  const throttled = status === 403 || status === 429 || status === 503
  return throttled ? 5_000 * 3 ** (attempt - 1) : 500 * attempt
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    let status: number | null = null
    try {
      const response = await fetch(url, init)
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

/**
 * The order list, fetched one calendar month at a time.
 *
 * A single request for the whole history asks the legacy platform for ~1MB in
 * one response, and it answers by dropping the connection or throttling. Month
 * windows keep each response small, and a window that fails no longer costs the
 * entire sweep. Rows are de-duplicated by legacy order id because the windows
 * are inclusive at both ends.
 */
async function fetchOrderList(startDate: string, endDate: string): Promise<LegacyOrderListRow[]> {
  const url = `${KE_LOGISTICS_BASE_URL}${KE_ORDERS_LIST_PATH}`
  const byId = new Map<number, LegacyOrderListRow>()
  for (const window of monthWindows(startDate, endDate)) {
    const rows = await fetchJson<LegacyOrderListRow[]>(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        UserID: 1,
        StartDate: window.start,
        EndDate: window.end,
        LocationIDs: null,
        LocationGroupIDs: null,
        IsMulti: true,
      }),
    })
    assert(Array.isArray(rows), `Legacy list endpoint did not return an array for ${window.start}..${window.end}`)
    for (const row of rows) byId.set(Number(row.ID), row)
  }
  return [...byId.values()]
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
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

/** The sheet K-Electric exports is a BOM'd CSV despite its .xls extension. */
function parseSheet(path: string): SheetRow[] {
  let raw = readFileSync(resolveWorkspacePath(path), "utf-8")
  if (raw.codePointAt(0) === 0xfeff) raw = raw.slice(1)
  const lines = raw.split(/\r?\n/).filter((line) => line.trim())
  assert(lines.length > 1, "Sheet has no data rows")
  const headers = lines[0].split(",").map((header) => header.trim())
  return lines.slice(1).map((line) => {
    const columns = line.split(",")
    const row: SheetRow = {}
    headers.forEach((header, index) => { row[header] = (columns[index] ?? "").trim() })
    return row
  })
}

async function rows<T extends Row = Row>(client: QueryClient, text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

interface ResolvedOrder {
  order: PreparedApiOrder
  branchId: number
  branchName: string
  branchAddress: string | null
  userId: string
  /** Historical identities are inactive by design; recorded so the report shows it. */
  userIsActive: boolean
  /** Historical products are inactive by design; recorded so the report shows it. */
  inactiveProducts: string[]
  subtotalCents: number
  taxCents: number
  totalCents: number
  lines: Array<{
    globalProductId: number
    organizationInventoryId: number
    productName: string
    productCode: string | null
    unit: string
    quantity: number
    priceCents: number
    taxRateBp: number
    taxCents: number
    netCents: number
    grossCents: number
  }>
}

interface UnresolvedOrder {
  legacyOrderId: number
  reason: "BRANCH_NOT_FOUND" | "BRANCH_AMBIGUOUS" | "USER_NOT_FOUND" | "USER_AMBIGUOUS"
    | "PRODUCT_NOT_FOUND" | "PRODUCT_AMBIGUOUS" | "TAX_SPLIT_MISMATCH"
  detail: string
  branchName: string
  userName: string
  totalCents: number
}

interface Plan {
  resolved: ResolvedOrder[]
  unresolved: UnresolvedOrder[]
  planDigest: string
}

async function buildPlan(
  client: QueryClient,
  prepared: readonly PreparedApiOrder[],
  legacySubUsers: readonly LegacySubUser[],
): Promise<Plan> {
  // Branches are matched by legacy location id, never by name once pinned.
  // Legacy has twins whose names differ only in punctuation or case (`Johar |`
  // / `Johar ||`), and a name-keyed map kept one twin and filed the other's
  // orders at it. See lib/legacy-import/ke-order-branches.ts.
  const branchRows = await rows(client,
    `select id, name, address, external_source, external_id
       from branches where organization_id = $1`, [target.id])
  const branchIndex = indexBranches(branchRows.map((row): CatalogueBranch => ({
    id: Number(row.id),
    name: String(row.name),
    address: row.address ?? null,
    externalSource: row.external_source ?? null,
    externalId: row.external_id == null ? null : String(row.external_id),
  })), SOURCE_SYSTEM)

  // Inactive users are eligible on purpose. Earlier imports created historical
  // ORDER_PORTAL identities deactivated so they cannot sign in, and the orders
  // those people placed still have to be attributed to them rather than to
  // whoever happens to be active at that branch today.
  const userRows = await rows(client,
    `select u.id, u.full_name, u.branch_id, u.is_active, u.external_id
       from users u
       join roles r on r.id = u.role_id
      where u.organization_id = $1 and u.deleted_at is null
        and r.name = 'ORDER_PORTAL'`, [target.id])
  const usersByBranchAndName = new Map<string, Row[]>()
  /** Every order-portal account at a branch, for the unresolvable-name fallback. */
  const usersByBranch = new Map<number, Row[]>()
  for (const user of userRows) {
    const key = `${user.branch_id}|${normalizeLegacyText(user.full_name)}`
    const bucket = usersByBranchAndName.get(key) ?? []
    bucket.push(user)
    usersByBranchAndName.set(key, bucket)

    const branchKey = Number(user.branch_id)
    const branchBucket = usersByBranch.get(branchKey) ?? []
    branchBucket.push(user)
    usersByBranch.set(branchKey, branchBucket)
  }

  // Identity beats spelling. The order carries an `OrderTakerID`, which names a
  // legacy person exactly, whereas the `UserDetails` string on the same order is
  // free text that disagrees with that person's own record in a dozen ways —
  // trailing "-", a doubled name, an appended department. Matching on the name
  // left eleven orders unattributable to people who were sitting in the
  // database the whole time, so the legacy id is resolved to an account first
  // and the name is only a fallback for orders whose taker is not in the
  // legacy user list at all.
  const usersByExternalId = new Map<string, Row[]>()
  for (const user of userRows) {
    if (!user.external_id) continue
    const key = String(user.external_id).toLowerCase()
    const bucket = usersByExternalId.get(key) ?? []
    bucket.push(user)
    usersByExternalId.set(key, bucket)
  }
  const identitiesByTakerId = new Map<number, string[]>()
  for (const subUser of legacySubUsers) {
    const id = Number(subUser.ID)
    if (!Number.isFinite(id)) continue
    const passcode = String(subUser.Passcode ?? "").trim()
    // A person whose employee code OneFlowe holds for somebody else was created
    // under a derived identity by `sync-ke.ts`; that identity is checked first.
    identitiesByTakerId.set(id, [contestedIdentityFor(id), passcode].filter(Boolean))
  }

  // Catalogue: the org's own inventory by name, then the mapping ledger that
  // earlier imports built for legacy names the catalogue has since renamed.
  //
  // Inactive inventory is eligible on purpose. 134 of K-Electric's 148 items are
  // historical products the legacy imports deactivated so they stay out of the
  // live shop; the live order API rightly refuses them for a *new* order, but an
  // order that already happened must reference the product it actually used.
  // Only deletion disqualifies a product here.
  const productRows = await rows(client,
    `select oi.id as organization_inventory_id, gp.id as global_product_id,
            gp.name, gp.product_code, gp.unit, gp.tax_rate_bp,
            oi.is_active as inventory_active
       from organization_inventory oi
       join global_products gp on gp.id = oi.global_product_id
      where oi.organization_id = $1
        and oi.deleted_at is null and gp.deleted_at is null`, [target.id])
  // Two catalogue rows that normalize to one name cannot be told apart from a
  // legacy line, so neither is usable: picking either would guess which product
  // a branch actually bought.
  const productCandidates = new Map<string, Row[]>()
  for (const product of productRows) {
    const key = normalizeLegacyProduct(product.name)
    const bucket = productCandidates.get(key) ?? []
    bucket.push(product)
    productCandidates.set(key, bucket)
  }
  const productByName = new Map<string, Row>()
  const ambiguousProductNames = new Set<string>()
  for (const [key, candidates] of productCandidates) {
    if (candidates.length === 1) productByName.set(key, candidates[0])
    else ambiguousProductNames.add(key)
  }

  const mappingRows = await rows(client,
    `select lpm.normalized_name, lpm.global_product_id
       from legacy_product_mappings lpm
      where lpm.organization_id = $1 and lpm.source_system = $2`, [target.id, SOURCE_SYSTEM])
  const productById = new Map<number, Row>()
  for (const product of productRows) productById.set(Number(product.global_product_id), product)
  for (const mapping of mappingRows) {
    const key = normalizeLegacyProduct(mapping.normalized_name)
    if (productByName.has(key)) continue
    const product = productById.get(Number(mapping.global_product_id))
    if (product) productByName.set(key, product)
  }

  const settingRows = await rows(client,
    `select value from organization_settings where organization_id = $1 and key = 'tax_rate'`, [target.id])
  const rawRate = settingRows[0]?.value
  const organizationTaxRateBp = typeof rawRate === "number" ? rawRate : null

  const resolved: ResolvedOrder[] = []
  const unresolved: UnresolvedOrder[] = []

  for (const order of prepared) {
    const reject = (reason: UnresolvedOrder["reason"], detail: string) => unresolved.push({
      legacyOrderId: order.legacyOrderId,
      reason,
      detail,
      branchName: order.branchName,
      userName: order.userName,
      totalCents: order.totalCents,
    })

    const resolution = resolveLegacyBranch(branchIndex,
      { legacyLocationId: order.legacyLocationId, branchName: order.branchName })
    if (resolution.kind === "NOT_FOUND") { reject("BRANCH_NOT_FOUND", resolution.detail); continue }
    if (resolution.kind === "AMBIGUOUS") { reject("BRANCH_AMBIGUOUS", resolution.detail); continue }
    const branch = resolution.branch

    let candidates: Row[] = []
    for (const identity of identitiesByTakerId.get(Number(order.legacyOrderTakerId)) ?? []) {
      const byIdentity = usersByExternalId.get(identity.toLowerCase()) ?? []
      if (byIdentity.length === 0) continue
      // One person can hold an account at more than one branch; prefer the one
      // at the branch that actually placed this order.
      const atBranch = byIdentity.filter((user) => Number(user.branch_id) === Number(branch.id))
      candidates = atBranch.length > 0 ? atBranch : byIdentity
      break
    }
    if (candidates.length === 0) {
      candidates = usersByBranchAndName.get(`${branch.id}|${normalizeLegacyText(order.userName)}`) ?? []
    }
    // Legacy names an orderer this branch has no account for — orders 200-202
    // are placed by a literal "test branch". Rather than drop a real order over
    // a name we cannot resolve, attribute it to the branch's own order-portal
    // account: the branch is what the order actually belongs to, and the
    // legacy name is preserved in `legacy_order_imports.source_payload`.
    let attributedToBranchFallback = false
    if (candidates.length === 0) {
      const branchUsers = usersByBranch.get(Number(branch.id)) ?? []
      const activeBranchUsers = branchUsers.filter((user) => user.is_active)
      const pool = activeBranchUsers.length > 0 ? activeBranchUsers : branchUsers
      if (pool.length > 0) {
        candidates = [pool.slice().sort((a, b) =>
          String(a.username ?? "").localeCompare(String(b.username ?? "")))[0]]
        attributedToBranchFallback = true
      }
    }
    if (candidates.length === 0) {
      reject("USER_NOT_FOUND", `no ORDER_PORTAL user "${order.userName}" at ${branch.name}, `
        + "and the branch has no order-portal account to attribute it to")
      continue
    }
    // A person who now holds a real account and still has the historical
    // placeholder an earlier import made for them matches twice. The live
    // account wins: the placeholder exists only to attribute orders placed
    // before that person had one, so it must not outrank them once they do.
    // With no live account, the placeholder is still the right answer.
    const active = candidates.filter((candidate) => candidate.is_active)
    const matched = active.length > 0 ? active : candidates
    if (matched.length > 1) {
      reject("USER_AMBIGUOUS",
        `${matched.length} ${active.length > 0 ? "active" : "historical"} users named `
          + `"${order.userName}" at ${branch.name}`)
      continue
    }

    const ambiguousProduct = order.lines.find((line) => ambiguousProductNames.has(line.normalizedName))
    if (ambiguousProduct) {
      reject("PRODUCT_AMBIGUOUS",
        `${productCandidates.get(ambiguousProduct.normalizedName)!.length} catalogue entries match `
          + `"${ambiguousProduct.sourceName}"`)
      continue
    }
    const missingProduct = order.lines.find((line) => !productByName.has(line.normalizedName))
    if (missingProduct) {
      reject("PRODUCT_NOT_FOUND", `no catalogue entry for "${missingProduct.sourceName}"`)
      continue
    }

    const tax = computeOrderTax(
      order.lines,
      (line) => productByName.get(line.normalizedName)?.tax_rate_bp ?? null,
      organizationTaxRateBp,
    )
    // Refused, not fatal: see TAX_SPLIT_MISMATCH in ke-orders-api.ts. One order
    // whose money does not reconcile must not stop the other nine hundred.
    if (tax.totalCents !== order.totalCents) {
      reject("TAX_SPLIT_MISMATCH",
        `lines total ${tax.totalCents} but the order states ${order.totalCents}; `
          + "legacy appears to add VAT on top for this order rather than pricing inclusive of it")
      continue
    }

    resolved.push({
      order,
      branchId: Number(branch.id),
      branchName: String(branch.name),
      branchAddress: branch.address ?? null,
      userId: String(matched[0].id),
      userIsActive: matched[0].is_active === true,
      inactiveProducts: order.lines
        .filter((line) => productByName.get(line.normalizedName)?.inventory_active !== true)
        .map((line) => line.sourceName),
      subtotalCents: tax.subtotalCents,
      taxCents: tax.taxCents,
      totalCents: tax.totalCents,
      lines: order.lines.map((line, index) => {
        const product = productByName.get(line.normalizedName)!
        return {
          globalProductId: Number(product.global_product_id),
          organizationInventoryId: Number(product.organization_inventory_id),
          productName: line.sourceName,
          productCode: product.product_code ?? null,
          unit: String(product.unit ?? "Unit"),
          quantity: line.quantity,
          priceCents: line.priceCents,
          taxRateBp: tax.lines[index].taxRateBp,
          taxCents: tax.lines[index].taxCents,
          netCents: tax.lines[index].netCents,
          grossCents: tax.lines[index].grossCents,
        }
      }),
    })
  }

  const planDigest = sha256(canonicalJson({
    orders: resolved.map((entry) => ({
      legacyOrderId: entry.order.legacyOrderId,
      branchId: entry.branchId,
      userId: entry.userId,
      status: entry.order.status,
      fulfillmentStatus: entry.order.fulfillmentStatus,
      subtotalCents: entry.subtotalCents,
      taxCents: entry.taxCents,
      totalCents: entry.totalCents,
      lines: entry.lines.map((line) => [line.globalProductId, line.quantity, line.priceCents, line.taxCents]),
    })),
  }))

  return { resolved, unresolved, planDigest }
}

function receiptData(entry: ResolvedOrder) {
  const items = entry.lines.map((line) => ({
    id: line.globalProductId,
    description: line.productName,
    quantity: line.quantity,
    rate: line.priceCents / 100,
    netRate: line.quantity > 0 ? line.netCents / 100 / line.quantity : 0,
    tax: line.taxCents / 100,
    taxPercent: line.taxRateBp / 100,
    total: line.grossCents / 100,
    netAmount: line.netCents / 100,
    unit: line.unit,
  }))
  return {
    invoiceNumber: `KE-LEGACY-${entry.order.legacyOrderId}`,
    date: entry.order.createdAt.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }),
    status: entry.order.status,
    fulfillmentStatus: entry.order.fulfillmentStatus,
    buyerName: entry.branchName,
    buyerAddress: entry.branchAddress ?? "",
    organizationName: target.name,
    items: [{
      categoryName: "General",
      items,
      subtotal: entry.subtotalCents / 100,
    }],
    subtotal: entry.subtotalCents / 100,
    discount: 0,
    tax: entry.taxCents / 100,
    deliveryCharges: 0,
    refund: 0,
    totalAmount: entry.totalCents / 100,
  }
}

async function applyPlan(
  client: QueryClient,
  plan: Plan,
  actorUserId: string,
  tokenByOrder: ReadonlyMap<number, { plain: string; hash: string }>,
  sourceManifest: Record<string, unknown>,
) {
  const [batch] = await rows(client,
    `insert into legacy_import_batches
       (id, organization_id, source_system, source_manifest, status, counts, imported_by_user_id, completed_at)
     values ($1, $2, $3, $4::jsonb, 'COMPLETED', $5::jsonb, $6, now())
     returning id`,
    [
      randomUUID(), target.id, SOURCE_SYSTEM,
      JSON.stringify(sourceManifest),
      JSON.stringify({ orders: plan.resolved.length, unresolved: plan.unresolved.length }),
      actorUserId,
    ])

  const orderRows = plan.resolved.map((entry) => {
    const token = tokenByOrder.get(entry.order.legacyOrderId)
    const isDelivered = entry.order.fulfillmentStatus === "DELIVERED"
    return {
      tid: `KE-LEGACY-${entry.order.legacyOrderId}`,
      organization_id: target.id,
      branch_id: entry.branchId,
      status: entry.order.status,
      fulfillment_status: entry.order.fulfillmentStatus,
      subtotal_cents: entry.subtotalCents,
      tax_cents: entry.taxCents,
      total_cents: entry.totalCents,
      created_by_user_id: entry.userId,
      created_at: entry.order.createdAt.toISOString(),
      delivered_at: isDelivered ? entry.order.sourceUpdatedAt.toISOString() : null,
      fulfilled_at: entry.order.status === "FULFILLED" ? entry.order.sourceUpdatedAt.toISOString() : null,
      updated_at: entry.order.sourceUpdatedAt.toISOString(),
      approved_by_user_id: actorUserId,
      approved_at: entry.order.sourceUpdatedAt.toISOString(),
      approval_token: token?.plain ?? null,
      approval_token_hash: token?.hash ?? null,
      approval_token_created_at: token ? entry.order.sourceUpdatedAt.toISOString() : null,
      receipt_data: receiptData(entry),
    }
  })

  // `created_by_role` is the literal ORDER_PORTAL because that is the only role
  // this importer will resolve a legacy order's user to — see the user lookup
  // above, which joins `r.name = 'ORDER_PORTAL'`. Recording it keeps imported
  // history attributed to a requester even if that account's role is changed
  // later. `lib/server/order-creator-role-sql.ts` explains the column.
  const createdOrders = await rows(client, `insert into orders (
      tid, organization_id, branch_id, status, fulfillment_status, payment_status,
      subtotal_cents, tax_cents, total_cents, created_by_user_id, created_by_role, created_at,
      delivered_at, fulfilled_at, updated_at, approved_by_user_id, approved_at,
      approval_token, approval_token_hash, approval_token_created_at, receipt_data
    ) select
      x.tid, x.organization_id, x.branch_id, x.status, x.fulfillment_status, 'UNPAID',
      x.subtotal_cents, x.tax_cents, x.total_cents, x.created_by_user_id, 'ORDER_PORTAL', x.created_at,
      x.delivered_at, x.fulfilled_at, x.updated_at, x.approved_by_user_id, x.approved_at,
      x.approval_token, x.approval_token_hash, x.approval_token_created_at, x.receipt_data
    from jsonb_to_recordset($1::jsonb) as x(
      tid text, organization_id integer, branch_id integer, status text, fulfillment_status text,
      subtotal_cents bigint, tax_cents bigint, total_cents bigint, created_by_user_id uuid,
      created_at timestamptz, delivered_at timestamptz, fulfilled_at timestamptz, updated_at timestamptz,
      approved_by_user_id uuid, approved_at timestamptz, approval_token text, approval_token_hash text,
      approval_token_created_at timestamptz, receipt_data jsonb
    ) returning id, tid`, [JSON.stringify(orderRows)])
  assert(createdOrders.length === plan.resolved.length, "Order insert count mismatch")

  const orderIdByLegacy = new Map<number, number>()
  for (const created of createdOrders) {
    orderIdByLegacy.set(Number(String(created.tid).replace(/^KE-LEGACY-/, "")), Number(created.id))
  }

  const itemRows = plan.resolved.flatMap((entry) => entry.lines.map((line) => ({
    organization_id: target.id,
    organization_inventory_id: line.organizationInventoryId,
    order_id: orderIdByLegacy.get(entry.order.legacyOrderId),
    global_product_id: line.globalProductId,
    product_name: line.productName,
    product_code: line.productCode,
    unit: line.unit,
    quantity: line.quantity,
    price_cents: line.priceCents,
    tax_rate_bp: line.taxRateBp,
    tax_cents: line.taxCents,
    created_at: entry.order.createdAt.toISOString(),
  })))
  await client.query(`insert into order_items
    (organization_id, organization_inventory_id, order_id, global_product_id, product_name,
     product_code, unit, quantity, price_cents, tax_rate_bp, tax_cents, created_at)
    select x.organization_id, x.organization_inventory_id, x.order_id, x.global_product_id, x.product_name,
           x.product_code, x.unit, x.quantity, x.price_cents, x.tax_rate_bp, x.tax_cents, x.created_at
    from jsonb_to_recordset($1::jsonb) as x(
      organization_id integer, organization_inventory_id integer, order_id integer, global_product_id integer,
      product_name text, product_code text, unit text, quantity numeric, price_cents bigint,
      tax_rate_bp integer, tax_cents bigint, created_at timestamptz
    )`, [JSON.stringify(itemRows)])

  const importRows = plan.resolved.map((entry) => ({
    batch_id: batch.id,
    organization_id: target.id,
    source_system: SOURCE_SYSTEM,
    legacy_order_id: entry.order.legacyOrderId,
    order_id: orderIdByLegacy.get(entry.order.legacyOrderId),
    source_checksum: entry.order.sourceChecksum,
    source_payload: {
      sourceHeader: entry.order.sourceHeader,
      legacyStatus: {
        statusId: entry.order.sourceHeader.StatusID,
        deliveryStatus: entry.order.sourceHeader.DeliveryStatus,
        text: entry.order.sourceStatus,
      },
      migrationPolicy: {
        importer: "import-ke-orders",
        targetStatus: entry.order.status,
        targetFulfillmentStatus: entry.order.fulfillmentStatus,
        approvalProvenance: "MIGRATION_ACTOR_WITH_LEGACY_LAST_UPDATE_TIMESTAMP",
        budgetPeriod: entry.order.period,
        // Ledger-neutral by design; see the header comment.
        stockChanged: false,
        quantityBudgetsChanged: false,
        budgetsChanged: false,
        invoiceSequenceAdvanced: false,
        notificationsSent: false,
      },
    },
  }))
  await client.query(`insert into legacy_order_imports
    (batch_id, organization_id, source_system, legacy_order_id, order_id, source_checksum, source_payload)
    select x.batch_id, x.organization_id, x.source_system, x.legacy_order_id, x.order_id, x.source_checksum, x.source_payload
    from jsonb_to_recordset($1::jsonb) as x(
      batch_id uuid, organization_id integer, source_system text, legacy_order_id integer,
      order_id integer, source_checksum text, source_payload jsonb
    )`, [JSON.stringify(importRows)])

  return { batchId: String(batch.id), orders: createdOrders.length, items: itemRows.length }
}

function summarize(plan: Plan) {
  const byStatus = new Map<string, number>()
  const byPeriod = new Map<string, number>()
  for (const entry of plan.resolved) {
    const status = `${entry.order.status}/${entry.order.fulfillmentStatus}`
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
    byPeriod.set(entry.order.period, (byPeriod.get(entry.order.period) ?? 0) + 1)
  }
  return {
    byStatus: Object.fromEntries([...byStatus].sort()),
    byPeriod: Object.fromEntries([...byPeriod].sort()),
    totalCents: plan.resolved.reduce((sum, entry) => sum + entry.totalCents, 0),
    taxCents: plan.resolved.reduce((sum, entry) => sum + entry.taxCents, 0),
    ordersAttributedToInactiveUser: plan.resolved.filter((entry) => !entry.userIsActive).length,
    ordersReferencingInactiveProduct: plan.resolved.filter((entry) => entry.inactiveProducts.length > 0).length,
  }
}

async function main() {
  const options = parseOptions()
  const listRows = await fetchOrderList(options.startDate, options.endDate)
  assert(Array.isArray(listRows), "Legacy list endpoint did not return an array")

  // The people directory, used to turn each order's `OrderTakerID` into the
  // account that person holds here. Read-only, and the same endpoint sync-ke.ts
  // reads, so the two commands agree on who is who.
  const legacySubUsers = await fetchJson<LegacySubUser[]>(
    `${KE_LOGISTICS_BASE_URL}/api/SubUser/0/1`)
  assert(Array.isArray(legacySubUsers) && legacySubUsers.length > 0,
    "Legacy user endpoint returned nothing")

  const sheetReconciliation = options.sheetPath
    ? reconcileAgainstSheet(parseSheet(options.sheetPath), listRows)
    : null
  if (sheetReconciliation) {
    assert(
      sheetReconciliation.onlyInSheet.length === 0 && sheetReconciliation.onlyInApi.length === 0,
      `Sheet and API disagree: ${sheetReconciliation.onlyInSheet.length} row(s) only in the sheet, `
        + `${sheetReconciliation.onlyInApi.length} only in the API`,
    )
  }

  const { pool } = await import("../lib/db-cli")
  try {
    // Resolved before any scoped read. Matched on code, and refused if that
    // code belongs to a differently-named tenant, so an order can never be
    // written into an organization this import was not aimed at.
    const [organization] = await rows(pool,
      `select id, code, name from organizations where code = $1`, [options.organizationCode])
    assert(organization,
      `No organization with code "${options.organizationCode}". Run sync-ke.ts first, `
        + `or pass --organization-code=<code>.`)
    assert(
      String(organization.name).normalize("NFKC").trim().toLowerCase()
        === options.organizationName.normalize("NFKC").trim().toLowerCase(),
      `Organization code ${options.organizationCode} belongs to "${organization.name}", not `
        + `"${options.organizationName}". Refusing to import K-Electric orders into another tenant.`,
    )
    target = { id: Number(organization.id), code: String(organization.code), name: String(organization.name) }

    const importedRows = await rows(pool,
      `select li.legacy_order_id,
              coalesce(li.source_payload->'sourceHeader', li.source_payload->'header') as header
         from legacy_order_imports li
        where li.organization_id = $1 and li.source_system = $2`, [target.id, SOURCE_SYSTEM])
    const alreadyImported = {
      legacyOrderIds: new Set(importedRows.map((row) => Number(row.legacy_order_id))),
      identityKeys: new Set(
        importedRows
          .filter((row) => row.header?.LocationName)
          .map((row) => orderIdentityKey({
            locationName: row.header.LocationName,
            transactionNo: row.header.TransactionNo,
            orderNo: row.header.OrderNo,
            date: row.header.OrderCreatedDT ?? row.header.CreatedOn,
          })),
      ),
    }

    const candidates = listRows.filter((row) =>
      Number(row.StatusID) !== 5
      && Number(row.StatusID) !== 1
      && !alreadyImported.legacyOrderIds.has(Number(row.ID))
      && !alreadyImported.identityKeys.has(identityKeyForListRow(row)))

    const details = await mapConcurrent(candidates, DETAIL_CONCURRENCY, (row) =>
      fetchJson<LegacyOrderDetail>(
        `${KE_LOGISTICS_BASE_URL}/api/OrderDetailController/${Number(row.LocationID)}/${Number(row.ID)}`))
    const detailsById = new Map(details.map((entry) => [Number(entry.ID), entry]))

    // A refunded line is zeroed on the order but kept on the refund record, so
    // an order whose lines sum short of its own checkout subtotal needs that
    // record to be restored to its pre-refund value. Fetched only for those
    // orders — seventeen of a thousand — rather than for every one.
    const needRefund = candidates.filter((row) => {
      const detail = detailsById.get(Number(row.ID))
      const checkout = detail?.OrderCheckoutList?.[0]
      if (!detail || !checkout) return false
      const lineSum = (detail.OrderDetailsList ?? []).reduce(
        (sum: number, line: any) => sum + Math.abs(Math.round((Number(line.Price ?? 0) + Number.EPSILON) * 100)), 0)
      const subtotal = Math.round((Number(checkout.AmountTotal ?? 0) + Number.EPSILON) * 100)
      return lineSum !== subtotal
    })
    const refunds = await mapConcurrent(needRefund, DETAIL_CONCURRENCY, (row) =>
      fetchJson<LegacyRefund>(
        `${KE_LOGISTICS_BASE_URL}/api/RefundModal/${Number(row.LocationID)}`
          + `/${encodeURIComponent(String(row.TransactionNo))}`)
        .catch(() => ({} as LegacyRefund)))
    const refundsByOrderId = new Map(needRefund.map((row, index) => [Number(row.ID), refunds[index]]))
    if (needRefund.length > 0) {
      console.log(`Fetched ${needRefund.length} refund record(s) for orders whose lines sum short of their subtotal.`)
    }

    const preparation = prepareApiOrders(listRows, detailsById, alreadyImported, refundsByOrderId)
    const plan = await buildPlan(pool, preparation.prepared, legacySubUsers)

    const sourceManifest = {
      importer: "import-ke-orders",
      listUrl: `${KE_LOGISTICS_BASE_URL}${KE_ORDERS_LIST_PATH}`,
      listFetchedInMonthWindows: true,
      startDate: options.startDate,
      endDate: options.endDate,
      listRowCount: listRows.length,
      listDigest: sha256(canonicalJson(listRows)),
      detailDigest: sha256(canonicalJson(details)),
      sheet: options.sheetPath ? { path: options.sheetPath, reconciliation: sheetReconciliation } : null,
    }

    const report = {
      generatedAt: new Date().toISOString(),
      mode: options.commit ? "COMMIT" : options.rollbackTest ? "ROLLBACK_TEST" : "DRY_RUN",
      organization: target,
      range: { startDate: options.startDate, endDate: options.endDate },
      sourceManifest,
      planDigest: plan.planDigest,
      counts: {
        listRows: listRows.length,
        alreadyImported: preparation.skipped.filter((row) => row.reason === "ALREADY_IMPORTED").length,
        cancelled: preparation.skipped.filter((row) => row.reason === "CANCELLED").length,
        drafts: preparation.skipped.filter((row) => row.reason === "DRAFT").length,
        rejected: preparation.rejected.length,
        unresolved: plan.unresolved.length,
        ready: plan.resolved.length,
      },
      summary: summarize(plan),
      rejected: preparation.rejected,
      unresolved: plan.unresolved,
      ready: plan.resolved.map((entry) => ({
        legacyOrderId: entry.order.legacyOrderId,
        branch: entry.branchName,
        user: entry.order.userName,
        createdAt: entry.order.createdAt.toISOString(),
        period: entry.order.period,
        status: `${entry.order.status}/${entry.order.fulfillmentStatus}`,
        lines: entry.lines.length,
        subtotalCents: entry.subtotalCents,
        taxCents: entry.taxCents,
        totalCents: entry.totalCents,
      })),
    }

    mkdirSync(dirname(options.outputPath), { recursive: true })
    writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
    console.log(JSON.stringify({
      output: options.outputPath,
      planDigest: plan.planDigest,
      counts: report.counts,
      summary: report.summary,
    }, null, 2))

    if (!options.commit && !options.rollbackTest) {
      console.log("\nDry run: nothing was written. Re-run with --commit plus the confirmations above to import.")
      return
    }

    assert(options.actorUserId, "Commit requires --actor-user-id")
    assert(options.confirmOrganization === organizationConfirmation(target),
      `Commit requires --confirm-organization=${organizationConfirmation(target)}`)
    assert(options.confirmPlan === plan.planDigest,
      `Commit requires --confirm-plan=${plan.planDigest}`)
    assert(options.expectedOrders === plan.resolved.length,
      `Commit requires --expected-orders=${plan.resolved.length}`)
    assert(plan.resolved.length > 0, "Nothing to import")

    const [actor] = await rows(pool,
      `select u.id, u.organization_id, u.is_active, u.deleted_at, r.name as role_name
         from users u join roles r on r.id = u.role_id where u.id = $1`, [options.actorUserId])
    assert(
      actor && actor.is_active && actor.deleted_at == null && actor.role_name === "SUPER_ADMIN"
        && (actor.organization_id == null || Number(actor.organization_id) === target.id),
      "Actor must be an active, non-deleted global or K-Electric SUPER_ADMIN",
    )

    const tokenByOrder = new Map<number, { plain: string; hash: string }>()
    for (const entry of plan.resolved.filter((item) => item.order.status === "APPROVED")) {
      const plain = generateApprovalToken(10)
      tokenByOrder.set(entry.order.legacyOrderId, { plain, hash: await hashApprovalToken(plain) })
    }

    const client = await pool.connect()
    try {
      await client.query("begin isolation level serializable")
      await client.query("select pg_advisory_xact_lock($1,$2)", [1263482710, target.id])
      const lockedPlan = await buildPlan(client, preparation.prepared, legacySubUsers)
      assert(lockedPlan.planDigest === plan.planDigest, "Plan changed between confirmation and commit")

      const result = await applyPlan(client, lockedPlan, options.actorUserId, tokenByOrder, sourceManifest)
      if (options.rollbackTest) await client.query("rollback")
      else await client.query("commit")

      const outcome = options.rollbackTest ? "ROLLED_BACK_AS_REQUESTED" : "COMMITTED"
      writeFileSync(options.outputPath,
        `${JSON.stringify({ ...report, mode: outcome, result: { ...result, transaction: outcome } }, null, 2)}\n`, "utf8")
      console.log(JSON.stringify({
        transaction: outcome,
        batchId: result.batchId,
        orders: result.orders,
        items: result.items,
        rollback: `npx tsx scripts/rollback-ke-legacy-import.ts --batch-id=${result.batchId} `
          + `--actor-user-id=${options.actorUserId} --confirm=ROLLBACK:${result.batchId}:KE-ONLY`,
      }, null, 2))
    } catch (error) {
      await client.query("rollback").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
