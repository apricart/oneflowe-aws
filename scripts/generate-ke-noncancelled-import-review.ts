import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, relative, resolve } from "node:path"
import * as dotenv from "dotenv"
import * as XLSX from "xlsx"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type JsonRow = Record<string, any>

type ReportCategory = {
  code: string
  title: string
  reason: string
  requiredEvidence: string
  legacyOrderIds: number[]
}

type RemainingReport = {
  organization: { id: number; code: string; name: string }
  counts: {
    knownLegacyOrderIds: number
    importedLegacyOrderIds: number
    remainingNotSafeToImport: number
  }
  categories: ReportCategory[]
}

const KE = { id: 10, code: "0001", name: "K-Electric" } as const
const LEGACY_SOURCE = "KE_LOGISTICS"
const REQUIRED = "Required"
const NOT_APPLICABLE = "N/A"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function normalizeUser(value: unknown): string {
  return normalizeText(value).replace(/\s+-\s*$/, "").trim()
}

function normalizeBranch(value: unknown): string {
  const normalized = normalizeText(value)
  return normalized === "1. gso" ? "gso" : normalized
}

function normalizeItem(value: unknown): string {
  return normalizeText(value)
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)\s*/g, ")")
    .replace(/\s*-\s*/g, "-")
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function dateKey(value: unknown): string {
  if (!value) return ""
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10)
}

function asDate(value: unknown): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

function cents(value: unknown): number | null {
  const number = asNumber(value)
  return number === null ? null : Math.round((number + Number.EPSILON) * 100)
}

function joinUnique(values: unknown[]): string {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))].sort().join(", ")
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function sheetRows(workbook: XLSX.WorkBook, sheetName: string): JsonRow[] {
  const sheet = workbook.Sheets[sheetName]
  assert(sheet, `Workbook is missing sheet: ${sheetName}`)
  return XLSX.utils.sheet_to_json<JsonRow>(sheet, { defval: null, raw: true })
}

function indexById(rows: JsonRow[], field = "Legacy Order ID"): Map<number, JsonRow[]> {
  const index = new Map<number, JsonRow[]>()
  for (const row of rows) {
    const id = Number(row[field])
    if (!Number.isSafeInteger(id)) continue
    const values = index.get(id) ?? []
    values.push(row)
    index.set(id, values)
  }
  return index
}

function mapById(rows: JsonRow[], field: string): Map<number, JsonRow> {
  return new Map(rows.map((row) => [Number(row[field]), row]).filter(([id]) => Number.isSafeInteger(id)))
}

function isCancelledOrder(row: JsonRow): boolean {
  const statuses = [
    row["Current Interpretation"],
    row["Updated Order Status"],
    row["Prior Order Status"],
  ].map(normalizeText)
  return statuses.some((status) => status === "cancelled" || status === "canceled")
    || Number(row.StatusID) === 5
    || (Number(row.StatusID) === 4 && Number(row.DeliveryStatus) === 508)
}

function autoWidth(rows: JsonRow[], headers: string[]): XLSX.ColInfo[] {
  return headers.map((header) => {
    const maximum = rows.reduce((width, row) => {
      const value = row[header]
      const text = value instanceof Date ? value.toISOString() : String(value ?? "")
      return Math.max(width, text.length)
    }, header.length)
    return { wch: Math.min(Math.max(maximum + 2, 11), header === "Comment" ? 70 : 48) }
  })
}

function addSheet(
  workbook: XLSX.WorkBook,
  name: string,
  rows: JsonRow[],
  options: {
    dateHeaders?: string[]
    moneyHeaders?: string[]
    integerHeaders?: string[]
  } = {},
) {
  const headers = rows[0] ? Object.keys(rows[0]) : []
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers })
  sheet["!cols"] = autoWidth(rows, headers)
  if (headers.length > 0) {
    sheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: Math.max(rows.length, 1), c: headers.length - 1 },
      }),
    }
  }
  sheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft" }

  const headerIndex = new Map(headers.map((header, index) => [header, index]))
  const applyFormat = (selectedHeaders: string[], format: string) => {
    for (const header of selectedHeaders) {
      const column = headerIndex.get(header)
      if (column === undefined) continue
      for (let row = 1; row <= rows.length; row += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
        if (cell && typeof cell.v === "number") cell.z = format
      }
    }
  }
  applyFormat(options.dateHeaders ?? [], "yyyy-mm-dd hh:mm")
  applyFormat(options.moneyHeaders ?? [], "#,##0.00")
  applyFormat(options.integerHeaders ?? [], "0")

  XLSX.utils.book_append_sheet(workbook, sheet, name)
}

function recursiveFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name)
    return entry.isDirectory() ? recursiveFiles(path) : [path]
  })
}

function fileAuditRow(root: string, path: string): JsonRow {
  const stat = statSync(path)
  const extension = path.toLowerCase().split(".").pop() ?? ""
  let structure = "Binary/supporting file"
  let rows = ""
  let role = "Supporting evidence"
  let linkQuality = "See role/comment"

  if (basename(path).startsWith("~$")) {
    structure = "Temporary Excel lock file"
    role = "Ignored"
    linkQuality = "Not evidence"
  } else if (extension === "json") {
    const parsed = readJson<any>(path)
    structure = Array.isArray(parsed)
      ? `JSON array (${parsed.length} rows)`
      : `JSON object (${Object.keys(parsed).join(", ")})`
    rows = Array.isArray(parsed) ? parsed.length : 1
  } else if (extension === "xls" || extension === "xlsx") {
    const workbook = XLSX.readFile(path, { cellDates: false })
    const sheetCounts = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName]
      const sheetRows = XLSX.utils.sheet_to_json(sheet, { defval: null }).length
      return `${sheetName}: ${sheetRows}`
    })
    structure = `Workbook (${sheetCounts.join("; ")})`
    rows = sheetCounts.join("; ")
  } else if (extension === "md") {
    structure = "Markdown documentation"
  }

  const name = basename(path)
  if (/refundreport/i.test(name)) {
    role = "Authoritative refund header and amount evidence"
    linkQuality = /\.json$/i.test(name) ? "Exact legacy ID" : "Validated companion workbook"
  } else if (/orderpurchasereport|sales report/i.test(name)) {
    role = "Item-level sales evidence"
    linkQuality = /\.json$/i.test(name) ? "Exact legacy ID" : "Validated companion workbook"
  } else if (/orders \(8\)|remaining-orders/i.test(name)) {
    role = "Order header, status, and remaining-population evidence"
    linkQuality = "Exact header identity in compiled review"
  } else if (/groupwise/i.test(name)) {
    role = "Candidate item code, rate, and delivered quantity evidence"
    linkQuality = "Candidate only; no legacy order ID"
  } else if (/productsummer|userproductsummary/i.test(name)) {
    role = "Candidate product, quantity, price, and status evidence"
    linkQuality = "Candidate only; no legacy order ID"
  } else if (/budget/i.test(name)) {
    role = "Historical budget context only; not imported or mutated"
    linkQuality = "Branch/period candidate context"
  } else if (/user list/i.test(name)) {
    role = "Legacy user lookup evidence"
    linkQuality = "Name/location lookup; no order ID"
  } else if (/ke-safe-import/i.test(path)) {
    role = "Evidence for the completed 51-order incremental import"
    linkQuality = "Checksum/manifest protected"
  } else if (/unimported-orders-details/i.test(name)) {
    role = "Compiled order and item evidence used as the review baseline"
    linkQuality = "Exact IDs where source rows expose IDs; candidate references are labeled"
  }

  return {
    "File": relative(root, path),
    "Bytes": stat.size,
    "SHA-256": createHash("sha256").update(readFileSync(path)).digest("hex"),
    "Structure / Rows": structure,
    "Role": role,
    "Order Link Quality": linkQuality,
    "Comment": basename(path).startsWith("~$")
      ? "Temporary lock artifact; excluded from all analysis."
      : "Reviewed as part of the updatedReports inventory.",
  }
}

async function main() {
  const repoRoot = process.cwd()
  const updatedRoot = resolve(repoRoot, "updatedReports")
  const baselineWorkbookPath = resolve(updatedRoot, "ke-unimported-orders-details-2026-07-23.xlsx")
  const remainingReportPath = resolve(updatedRoot, "ke-remaining-orders-report-2026-07-23.json")
  const refundJsonPath = resolve(updatedRoot, "refundReport.json")
  const salesJsonPath = resolve(updatedRoot, "orderPurchaseReport.json")
  const productSummaryPath = resolve(updatedRoot, "productSummery.json")
  const userProductSummaryPath = resolve(updatedRoot, "UserProductSummary.json")
  const outputPath = resolve(
    repoRoot,
    process.argv[2] || "deliverables/KE_Non-Cancelled_Unimported_Orders_Import_Requirements_2026-08-03.xlsx",
  )

  const baseline = XLSX.readFile(baselineWorkbookPath, { cellDates: true })
  const allOrderRows = sheetRows(baseline, "Unimported Orders")
  const baselineItemRows = sheetRows(baseline, "Order Items")
  const baselineRefundRows = sheetRows(baseline, "Refund Details")
  const remainingReport = readJson<RemainingReport>(remainingReportPath)
  const refundHeaders = readJson<JsonRow[]>(refundJsonPath)
  const exactSalesRows = readJson<JsonRow[]>(salesJsonPath)
  const productSummary = readJson<JsonRow[]>(productSummaryPath)
  const userProductSummary = readJson<JsonRow[]>(userProductSummaryPath)

  assert(remainingReport.organization.id === KE.id, "Remaining report is not scoped to K-Electric organization 10")
  assert(remainingReport.organization.code === KE.code && remainingReport.organization.name === KE.name, "Remaining report organization identity mismatch")
  assert(allOrderRows.length === 166, `Expected 166 remaining order rows, found ${allOrderRows.length}`)
  assert(new Set(allOrderRows.map((row) => Number(row["Legacy Order ID"]))).size === 166, "Remaining workbook has duplicate order IDs")
  assert(refundHeaders.length === 25 && baselineRefundRows.length === 25, "Refund evidence count mismatch")

  const categoryById = new Map<number, ReportCategory>()
  for (const category of remainingReport.categories) {
    for (const id of category.legacyOrderIds) categoryById.set(Number(id), category)
  }

  const itemsByOrderId = indexById(baselineItemRows)
  const exactSalesByOrderId = indexById(exactSalesRows, "ID")
  const refundHeaderById = mapById(refundHeaders, "ID")
  const refundWorkbookById = mapById(baselineRefundRows, "Legacy Order ID")

  const cancelledRows = allOrderRows.filter(isCancelledOrder)
  const reportNonCancelledRows = allOrderRows.filter((row) => !isCancelledOrder(row))

  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  let organizationRows: JsonRow[] = []
  let liveCountRows: JsonRow[] = []
  let liveImportRows: JsonRow[] = []
  let liveOrderRows: JsonRow[] = []
  let branches: JsonRow[] = []
  let users: JsonRow[] = []
  let userMappings: JsonRow[] = []
  let productMappings: JsonRow[] = []
  let organizationProducts: JsonRow[] = []
  let branchInventoryRows: JsonRow[] = []
  let liveSchemaRows: JsonRow[] = []

  try {
    await client.query("begin transaction isolation level repeatable read read only")
    const allIds = allOrderRows.map((row) => Number(row["Legacy Order ID"]))
    organizationRows = (await client.query(
      "select id, code, name, status from organizations where id = $1",
      [KE.id],
    )).rows
    liveCountRows = (await client.query(
      `select
         (select count(distinct legacy_order_id)::int from legacy_order_imports where organization_id = $1) as imported_legacy_ids,
         (select count(*)::int from orders where organization_id = $1) as organization_orders`,
      [KE.id],
    )).rows
    liveImportRows = (await client.query(
      `select legacy_order_id, order_id, source_checksum
       from legacy_order_imports
       where organization_id = $1 and legacy_order_id = any($2::int[])
       order by legacy_order_id`,
      [KE.id, allIds],
    )).rows
    liveOrderRows = (await client.query(
      `select id, tid, branch_id, status, refund_amount_cents
       from orders
       where organization_id = $1 and tid = any($2::text[])
       order by tid`,
      [KE.id, allIds.map((id) => `KE-LEGACY-${id}`)],
    )).rows
    branches = (await client.query(
      `select id, name, code, status, group_id
       from branches where organization_id = $1 order by id`,
      [KE.id],
    )).rows
    users = (await client.query(
      `select u.id, u.branch_id, u.username, u.full_name, u.first_name, u.last_name,
              u.employee_id, u.is_active, u.deleted_at, r.name as role_name
       from users u join roles r on r.id = u.role_id
       where u.organization_id = $1 order by u.branch_id, u.id`,
      [KE.id],
    )).rows
    userMappings = (await client.query(
      `select lum.legacy_order_taker_id, lum.branch_id, lum.source_name, lum.user_id,
              lum.is_synthetic, u.is_active, u.deleted_at, r.name as role_name
       from legacy_user_mappings lum
       join users u on u.id = lum.user_id and u.organization_id = lum.organization_id
       join roles r on r.id = u.role_id
       where lum.organization_id = $1 and lum.source_system = $2
       order by lum.legacy_order_taker_id, lum.branch_id`,
      [KE.id, LEGACY_SOURCE],
    )).rows
    productMappings = (await client.query(
      `select lpm.normalized_name, lpm.source_name, lpm.source_codes,
              lpm.global_product_id, lpm.organization_inventory_id,
              gp.name as product_name, gp.product_code, gp.unit, gp.deleted_at as product_deleted_at,
              oi.is_active as assignment_is_active, oi.deleted_at as assignment_deleted_at
       from legacy_product_mappings lpm
       join global_products gp on gp.id = lpm.global_product_id
       join organization_inventory oi
         on oi.id = lpm.organization_inventory_id
        and oi.organization_id = lpm.organization_id
        and oi.global_product_id = lpm.global_product_id
       where lpm.organization_id = $1 and lpm.source_system = $2
       order by lpm.normalized_name`,
      [KE.id, LEGACY_SOURCE],
    )).rows
    organizationProducts = (await client.query(
      `select oi.id as organization_inventory_id, oi.is_active as assignment_is_active,
              oi.deleted_at as assignment_deleted_at, gp.id as global_product_id,
              gp.name as product_name, gp.product_code, gp.unit,
              gp.deleted_at as product_deleted_at
       from organization_inventory oi
       join global_products gp on gp.id = oi.global_product_id
       where oi.organization_id = $1
       order by gp.id, oi.id`,
      [KE.id],
    )).rows
    branchInventoryRows = (await client.query(
      `select branch_id, organization_inventory_id, is_active, is_visible, deleted_at
       from branch_inventory where organization_id = $1
       order by branch_id, organization_inventory_id`,
      [KE.id],
    )).rows
    liveSchemaRows = (await client.query(
      `select table_name, column_name, data_type, is_nullable
       from information_schema.columns
       where table_schema = 'public'
         and table_name in ('orders', 'order_items', 'refunds', 'refund_items', 'legacy_import_batches', 'legacy_order_imports')
       order by table_name, ordinal_position`,
    )).rows
    await client.query("commit")
  } catch (error) {
    await client.query("rollback").catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }

  assert(organizationRows.length === 1, "Live K-Electric organization was not found")
  const liveOrganization = organizationRows[0]
  assert(
    Number(liveOrganization.id) === KE.id
      && liveOrganization.code === KE.code
      && liveOrganization.name === KE.name
      && normalizeText(liveOrganization.status) === "active",
    "Live K-Electric organization identity/status safety gate failed",
  )

  const liveImportedIds = new Set(liveImportRows.map((row) => Number(row.legacy_order_id)))
  const liveOrderIdByLegacyId = new Map<number, JsonRow>()
  for (const row of liveOrderRows) {
    const match = /^KE-LEGACY-(\d+)$/.exec(String(row.tid))
    if (match) liveOrderIdByLegacyId.set(Number(match[1]), row)
  }
  const selectedOrderRows = reportNonCancelledRows.filter((row) => {
    const id = Number(row["Legacy Order ID"])
    return !liveImportedIds.has(id) && !liveOrderIdByLegacyId.has(id)
  })
  const selectedIds = new Set(selectedOrderRows.map((row) => Number(row["Legacy Order ID"])))

  const branchByNormalizedName = new Map<string, JsonRow[]>()
  for (const branch of branches) {
    const key = normalizeBranch(branch.name)
    const values = branchByNormalizedName.get(key) ?? []
    values.push(branch)
    branchByNormalizedName.set(key, values)
  }
  const usersByBranch = new Map<number, JsonRow[]>()
  for (const user of users) {
    const values = usersByBranch.get(Number(user.branch_id)) ?? []
    values.push(user)
    usersByBranch.set(Number(user.branch_id), values)
  }
  const mappingsByProduct = new Map<string, JsonRow[]>()
  for (const mapping of productMappings) {
    const key = normalizeItem(mapping.normalized_name)
    const values = mappingsByProduct.get(key) ?? []
    values.push(mapping)
    mappingsByProduct.set(key, values)
  }
  const orgProductsByName = new Map<string, JsonRow[]>()
  for (const product of organizationProducts) {
    const key = normalizeItem(product.product_name)
    const values = orgProductsByName.get(key) ?? []
    values.push(product)
    orgProductsByName.set(key, values)
  }
  const branchInventoryKeys = new Set(
    branchInventoryRows
      .filter((row) => row.deleted_at === null)
      .map((row) => `${row.branch_id}:${row.organization_inventory_id}`),
  )

  function resolveBranch(name: unknown): { row?: JsonRow; status: string } {
    const matches = (branchByNormalizedName.get(normalizeBranch(name)) ?? [])
      .filter((branch) => normalizeText(branch.status) === "active")
    if (matches.length === 1) return { row: matches[0], status: "Exact active K-Electric branch" }
    if (matches.length === 0) return { status: "Required: no exact active K-Electric branch match" }
    return { status: "Required: multiple active K-Electric branch matches" }
  }

  function resolveCreator(order: JsonRow, branch?: JsonRow): { row?: JsonRow; status: string; source: string } {
    if (!branch) return { status: "Required: branch must be resolved first", source: "None" }
    const id = Number(order["Legacy Order ID"])
    const refund = refundHeaderById.get(id)
    const exactSales = exactSalesByOrderId.get(id) ?? []
    const legacyOrderTakerId = asNumber(refund?.OrderTakerID ?? exactSales[0]?.OrderTakerID)
    const branchId = Number(branch.id)
    if (legacyOrderTakerId !== null) {
      const ledgerMatches = userMappings.filter((mapping) =>
        Number(mapping.legacy_order_taker_id) === legacyOrderTakerId
          && Number(mapping.branch_id) === branchId
          && mapping.deleted_at === null
          && normalizeText(mapping.role_name) === "order_portal",
      )
      if (ledgerMatches.length === 1) {
        return { row: ledgerMatches[0], status: "Existing KE legacy user mapping", source: `OrderTakerID ${legacyOrderTakerId}` }
      }
    }

    const sourceUser = normalizeUser(order["User Details"])
    const ledgerNameMatches = userMappings.filter((mapping) =>
      Number(mapping.branch_id) === branchId
        && normalizeUser(mapping.source_name) === sourceUser
        && mapping.deleted_at === null
        && normalizeText(mapping.role_name) === "order_portal",
    )
    if (sourceUser && ledgerNameMatches.length === 1) {
      return { row: ledgerNameMatches[0], status: "Existing KE legacy user mapping by source name", source: "User Details" }
    }

    const liveMatches = (usersByBranch.get(branchId) ?? []).filter((user) => {
      const names = [
        user.full_name,
        user.username,
        `${user.first_name ?? ""} ${user.last_name ?? ""}`,
      ].map(normalizeUser).filter(Boolean)
      return sourceUser
        && names.includes(sourceUser)
        && user.deleted_at === null
        && Boolean(user.is_active)
        && normalizeText(user.role_name) === "order_portal"
    })
    if (liveMatches.length === 1) {
      return { row: { ...liveMatches[0], user_id: liveMatches[0].id }, status: "Unique active KE ORDER_PORTAL user match", source: "User Details" }
    }
    return {
      status: liveMatches.length > 1
        ? "Required: multiple KE user matches"
        : "Required: no safe KE creator mapping",
      source: legacyOrderTakerId === null ? "User Details" : `OrderTakerID ${legacyOrderTakerId} + User Details`,
    }
  }

  function resolveProduct(name: unknown): { row?: JsonRow; status: string; kind: string } {
    const normalized = normalizeItem(name)
    const ledgerMatches = (mappingsByProduct.get(normalized) ?? []).filter((mapping) =>
      mapping.product_deleted_at === null && mapping.assignment_deleted_at === null,
    )
    if (ledgerMatches.length === 1) return { row: ledgerMatches[0], status: "Existing KE legacy product mapping", kind: "LEDGER" }
    if (ledgerMatches.length > 1) return { status: "Required: conflicting KE legacy product mappings", kind: "CONFLICT" }

    const nameMatches = (orgProductsByName.get(normalized) ?? []).filter((product) =>
      product.product_deleted_at === null && product.assignment_deleted_at === null,
    )
    if (nameMatches.length === 1) return { row: nameMatches[0], status: "Unique KE organization product name match", kind: "NAME" }
    return {
      status: nameMatches.length > 1
        ? "Required: multiple KE product name matches"
        : "Required: no KE product mapping",
      kind: nameMatches.length > 1 ? "CONFLICT" : "MISSING",
    }
  }

  function candidateSummaryRows(order: JsonRow): JsonRow[] {
    const id = Number(order["Legacy Order ID"])
    const refund = refundHeaderById.get(id)
    const day = dateKey(order["Order Date"])
    const branch = normalizeBranch(order["Branch / Location"])
    const user = normalizeUser(order["User Details"])
    const group = normalizeText(order["Location Group"])
    const matches = productSummary.filter((row) =>
      dateKey(row.OrderCreatedDT) === day
        && normalizeBranch(row.Location) === branch
        && normalizeUser(row.UserName) === user
        && normalizeText(row.Group) === group,
    )
    if (!refund) return matches
    const refunded = matches.filter((row) => normalizeText(row.OrderStatus) === "refunded")
    return refunded.length > 0 ? refunded : matches
  }

  function candidateCorroboration(candidate: JsonRow): string {
    const matches = userProductSummary.filter((row) =>
      dateKey(row.OrderCreatedDT) === dateKey(candidate.OrderCreatedDT)
        && normalizeBranch(row.Location) === normalizeBranch(candidate.Location)
        && normalizeUser(row.UserName) === normalizeUser(candidate.UserName)
        && normalizeText(row.Group) === normalizeText(candidate.Group)
        && normalizeItem(row.Name) === normalizeItem(candidate.Name)
        && Number(row.Item_Qty) === Number(candidate.Item_Qty)
        && Number(row.SaleRevenue) === Number(candidate.SaleRevenue)
        && normalizeText(row.OrderStatus) === normalizeText(candidate.OrderStatus),
    )
    return matches.length === 1 ? "Yes - exact summary corroboration" : `Required - ${matches.length} corroborating rows`
  }

  const productRows: JsonRow[] = []
  const orderResolution = new Map<number, {
    branch?: JsonRow
    branchStatus: string
    creator?: JsonRow
    creatorStatus: string
    creatorSource: string
    exactItems: JsonRow[]
    candidates: JsonRow[]
    itemMissing: string[]
    allProductsResolved: boolean
    branchAssignmentsToCreate: number
  }>()

  for (const order of selectedOrderRows) {
    const id = Number(order["Legacy Order ID"])
    const category = categoryById.get(id)
    assert(category, `No blocker category found for order ${id}`)
    const branchResolution = resolveBranch(order["Branch / Location"])
    const creatorResolution = resolveCreator(order, branchResolution.row)
    const exactItems = itemsByOrderId.get(id) ?? []
    const candidates = exactItems.length === 0 ? candidateSummaryRows(order) : []
    const sourceItems: Array<{ source: "EXACT" | "CANDIDATE" | "MISSING"; row: JsonRow }> = exactItems.length > 0
      ? exactItems.map((row) => ({ source: "EXACT" as const, row }))
      : candidates.length > 0
        ? candidates.map((row) => ({ source: "CANDIDATE" as const, row }))
        : [{ source: "MISSING" as const, row: {} }]

    const itemMissing = new Set<string>()
    let allProductsResolved = true
    let branchAssignmentsToCreate = 0
    const refund = refundHeaderById.get(id)
    const grossRefund = refund ? Number(refund.RefundAmount || 0) + Number(refund.TaxRefund || 0) : 0
    const orderGrandTotal = asNumber(order["Grand Total"]) ?? asNumber(refund?.GrandTotal)
    const fullRefund = Boolean(refund && orderGrandTotal !== null && Math.abs(grossRefund - orderGrandTotal) < 0.005)

    sourceItems.forEach(({ source, row }, lineIndex) => {
      const itemName = source === "EXACT" ? row.Item : source === "CANDIDATE" ? row.Name : null
      const quantity = source === "EXACT" ? asNumber(row.Quantity) : source === "CANDIDATE" ? asNumber(row.Item_Qty) : null
      const rawPrice = source === "EXACT" ? asNumber(row["Raw Unit Price (JSON)"]) : source === "CANDIDATE" ? asNumber(row.UnitPrice) : null
      const candidateRevenue = source === "CANDIDATE" ? asNumber(row.SaleRevenue) : null
      const effectivePrice = source === "CANDIDATE" && quantity && candidateRevenue !== null
        ? candidateRevenue / quantity
        : rawPrice
      const productResolution = itemName ? resolveProduct(itemName) : { status: "Required: product name is missing", kind: "MISSING" }
      const dbProduct = productResolution.row
      const organizationInventoryId = dbProduct?.organization_inventory_id
      const branchInventoryExists = branchResolution.row && organizationInventoryId
        ? branchInventoryKeys.has(`${branchResolution.row.id}:${organizationInventoryId}`)
        : false
      if (branchResolution.row && organizationInventoryId && !branchInventoryExists) branchAssignmentsToCreate += 1

      const missing = new Set<string>()
      if (source === "MISSING") {
        missing.add("Exact item rows")
        missing.add("Product name")
        missing.add("Quantity")
        missing.add("Unit price")
      }
      if (source === "CANDIDATE") missing.add("Exact order-to-product link confirmation")
      if (!itemName) missing.add("Product name")
      if (quantity === null || quantity <= 0) missing.add("Positive quantity")
      if (effectivePrice === null || effectivePrice < 0) missing.add("Resolved unit price")
      if (category.code === "ITEM_SUBTOTAL_MISMATCH" || category.code === "UNRESOLVED_ITEM_PRICE") {
        missing.add("Corrected/reconciled unit price")
      }
      if (!dbProduct) {
        missing.add("DB global product ID")
        missing.add("DB organization inventory ID")
        allProductsResolved = false
      }
      if (refund && !fullRefund) missing.add("Refunded quantity/item allocation or approved unitemized-refund policy")
      for (const value of missing) itemMissing.add(value)

      const resolvedUnitPriceCents = effectivePrice !== null
        && !missing.has("Corrected/reconciled unit price")
        ? Math.round(effectivePrice * 100)
        : REQUIRED
      const lineTotal = quantity !== null && effectivePrice !== null ? quantity * effectivePrice : REQUIRED
      const refundedQuantity = refund
        ? fullRefund && quantity !== null ? quantity : REQUIRED
        : NOT_APPLICABLE
      const refundedAmount = refund
        ? fullRefund && lineTotal !== REQUIRED ? lineTotal : REQUIRED
        : NOT_APPLICABLE

      productRows.push({
        "Legacy Order ID": id,
        "Order Number": order["Order No"] ?? REQUIRED,
        "Transaction Number": order["Transaction No"] ?? REQUIRED,
        "Order Date": asDate(order["Order Date"]) ?? REQUIRED,
        "Branch / Location": order["Branch / Location"] ?? REQUIRED,
        "DB Branch ID": branchResolution.row?.id ?? REQUIRED,
        "Blocker Code": category.code,
        "Refund Classification": refund ? (fullRefund ? "FULL" : "PARTIAL") : "NONE",
        "Line Number": lineIndex + 1,
        "Product Evidence Type": source === "EXACT"
          ? `Exact legacy-ID item row (${row["Line Source"] ?? "compiled sales source"})`
          : source === "CANDIDATE"
            ? "Candidate summary row - no legacy order ID"
            : "Missing item evidence",
        "Exact Link Confirmation": source === "EXACT" ? "Confirmed" : REQUIRED,
        "Product Name": itemName ?? REQUIRED,
        "Source Product / SKU": source === "EXACT"
          ? (row["GroupWise Item Code"] || "Not supplied")
          : source === "CANDIDATE"
            ? (row.SKU || row.Barcode || "Not supplied")
            : "Not supplied",
        "Quantity": quantity ?? REQUIRED,
        "Source Unit Price PKR": rawPrice ?? REQUIRED,
        "Source Sale Revenue PKR": candidateRevenue ?? (lineTotal === REQUIRED ? REQUIRED : lineTotal),
        "Resolved Unit Price Cents": resolvedUnitPriceCents,
        "Resolved Line Total PKR": lineTotal,
        "Unit": dbProduct?.unit || REQUIRED,
        "DB Global Product ID": dbProduct?.global_product_id ?? REQUIRED,
        "DB Organization Inventory ID": organizationInventoryId ?? REQUIRED,
        "DB Product Code": dbProduct?.product_code ?? REQUIRED,
        "DB Product Mapping Status": productResolution.status,
        "DB Branch Inventory Assignment": !branchResolution.row || !organizationInventoryId
          ? REQUIRED
          : branchInventoryExists
            ? "Exists"
            : "Create historical inactive assignment during import",
        "Candidate Corroborated by UserProductSummary": source === "CANDIDATE"
          ? candidateCorroboration(row)
          : NOT_APPLICABLE,
        "Refunded Quantity": refundedQuantity,
        "Refund Item Amount PKR": refundedAmount,
        "Missing Required Product Values": missing.size > 0 ? [...missing].join("; ") : "None",
        "Comment": source === "EXACT"
          ? `Exact ID-linked item evidence. ${productResolution.status}.`
          : source === "CANDIDATE"
            ? "The product summary has no legacy order ID. Confirm that this row belongs to this exact order before importing it."
            : "No item row was found in the supplied exact or candidate reports; all product fields must be supplied.",
      })
    })

    orderResolution.set(id, {
      branch: branchResolution.row,
      branchStatus: branchResolution.status,
      creator: creatorResolution.row,
      creatorStatus: creatorResolution.status,
      creatorSource: creatorResolution.source,
      exactItems,
      candidates,
      itemMissing: [...itemMissing],
      allProductsResolved,
      branchAssignmentsToCreate,
    })
  }

  const orderReviewRows: JsonRow[] = selectedOrderRows.map((order) => {
    const id = Number(order["Legacy Order ID"])
    const category = categoryById.get(id)!
    const resolution = orderResolution.get(id)!
    const refund = refundHeaderById.get(id)
    const refundWorkbook = refundWorkbookById.get(id)
    const grossRefund = refund ? Number(refund.RefundAmount || 0) + Number(refund.TaxRefund || 0) : 0
    const subtotal = asNumber(order["Reported Subtotal"]) ?? asNumber(refund?.AmountTotal)
    const tax = asNumber(order.Tax) ?? asNumber(refund?.Tax)
    const grandTotal = asNumber(order["Grand Total"]) ?? asNumber(refund?.GrandTotal)
    const discount = asNumber(order.Discount) ?? asNumber(refund?.AmountDiscount)
    const service = asNumber(order["Service Charges"]) ?? asNumber(refund?.ServiceCharges)
    const fullRefund = Boolean(refund && grandTotal !== null && Math.abs(grossRefund - grandTotal) < 0.005)
    const exactItemValue = resolution.exactItems.reduce((sum, row) =>
      sum + Number(row.Quantity || 0) * Number(row["Raw Unit Price (JSON)"] || 0), 0)
    const candidateItemValue = resolution.candidates.reduce((sum, row) => sum + Number(row.SaleRevenue || 0), 0)
    const selectedItemValue = resolution.exactItems.length > 0 ? exactItemValue : candidateItemValue
    const missing = new Set<string>()

    if (!resolution.branch) missing.add("DB branch ID")
    if (!resolution.creator) missing.add("DB created-by user ID")
    if (subtotal === null) missing.add("Order subtotal")
    if (tax === null) missing.add("Order tax")
    if (grandTotal === null) missing.add("Order grand total")
    if (resolution.exactItems.length === 0) missing.add("Exact ID-linked item rows")
    resolution.itemMissing.forEach((value) => missing.add(value))
    if (!resolution.allProductsResolved) missing.add("DB product mapping")

    let targetStatus: string = "FULFILLED"
    let targetFulfillmentStatus: string = "DELIVERED"
    let statusBeforeRefund: string = NOT_APPLICABLE
    let refundedAt: string | Date = NOT_APPLICABLE
    let candidateRefundedAt: string | Date = NOT_APPLICABLE

    if (category.code === "WORKFLOW_NOT_FINAL") {
      targetStatus = REQUIRED
      targetFulfillmentStatus = REQUIRED
      missing.add("Approved final status/fulfillment policy")
    }
    if (["OMITTED_FROM_UPDATED_ORDER_EXPORT", "MISSING_AUTHORITATIVE_ORDER_HEADER"].includes(category.code)) {
      targetStatus = REQUIRED
      targetFulfillmentStatus = REQUIRED
      missing.add("Authoritative order header/final status")
    }
    if (refund) {
      targetStatus = fullRefund ? "REFUNDED" : "FULFILLED"
      const sourceStatus = normalizeText(order["Updated Order Status"] || order["Prior Order Status"])
      statusBeforeRefund = sourceStatus === "delivered" ? "FULFILLED" : REQUIRED
      if (statusBeforeRefund === REQUIRED) missing.add("Status immediately before refund")
      candidateRefundedAt = asDate(refund.LastUpdateDT) ?? REQUIRED
      refundedAt = REQUIRED
      missing.add("Confirmation that LastUpdateDT is the refund timestamp")
      if (!fullRefund) missing.add("Refund item allocation or approved unitemized-refund policy")
    }

    if (category.code === "ITEM_SUBTOTAL_MISMATCH") missing.add("Corrected item quantities/prices that reconcile")
    if (category.code === "UNRESOLVED_ITEM_PRICE") missing.add("Authoritative unit price")
    if (category.code === "ZERO_QUANTITY_ITEM_LINES") missing.add("Positive item quantity or approved artifact-removal policy")
    if (category.code === "NO_ITEM_LINES") missing.add("Complete item lines")

    const componentTotal = subtotal !== null && tax !== null
      ? subtotal - (discount ?? 0) + (service ?? 0) + tax
      : null
    const headerReconciles = componentTotal !== null && grandTotal !== null
      ? Math.abs(componentTotal - grandTotal) < 0.005
      : false
    const itemReconciles = subtotal !== null && (resolution.exactItems.length > 0 || resolution.candidates.length > 0)
      ? Math.abs(selectedItemValue - subtotal) < 0.005
      : false

    const onlyPolicyMissing = [...missing].every((value) => [
      "Confirmation that LastUpdateDT is the refund timestamp",
      "Status immediately before refund",
    ].includes(value))
    const readiness = missing.size === 0
      ? "READY FOR GUARDED PREFLIGHT"
      : onlyPolicyMissing
        ? "CONDITIONAL - POLICY CONFIRMATION REQUIRED"
        : "BLOCKED - REQUIRED VALUES MISSING"

    const commentParts = [
      category.reason,
      `Needed: ${category.requiredEvidence}`,
      resolution.exactItems.length > 0
        ? `${resolution.exactItems.length} exact ID-linked item row(s) available.`
        : resolution.candidates.length > 0
          ? `${resolution.candidates.length} candidate summary item row(s) found, but they have no legacy order ID.`
          : "No product/item evidence was found.",
      resolution.branchAssignmentsToCreate > 0
        ? `${resolution.branchAssignmentsToCreate} KE branch-product assignment(s) would need historical inactive creation.`
        : "No new branch-product assignment identified from resolved rows.",
      refund
        ? `${fullRefund ? "Full" : "Partial"} refund evidence: PKR ${grossRefund.toFixed(2)}. Standard refund APIs must not be used because they would alter current budgets/quantities.`
        : "No refund evidence for this order.",
    ]

    return {
      "Legacy Order ID": id,
      "Currently Imported in Live DB": "No",
      "Target Organization ID": KE.id,
      "Target Organization Code": KE.code,
      "Target Organization Name": KE.name,
      "Blocker Code": category.code,
      "Blocker": category.title,
      "Current Interpretation": order["Current Interpretation"],
      "Updated Order Status": order["Updated Order Status"],
      "Prior Order Status": order["Prior Order Status"],
      "Legacy StatusID": order.StatusID,
      "Legacy DeliveryStatus": order.DeliveryStatus,
      "Order Number": order["Order No"] ?? REQUIRED,
      "Transaction Number": order["Transaction No"] ?? REQUIRED,
      "Generated TID": `KE-LEGACY-${id}`,
      "Order Date": asDate(order["Order Date"]) ?? REQUIRED,
      "Created At": asDate(order["Created On"]) ?? REQUIRED,
      "Last Updated At": asDate(order["Last Updated"]) ?? REQUIRED,
      "Branch / Location": order["Branch / Location"] ?? REQUIRED,
      "Location Group": order["Location Group"] ?? REQUIRED,
      "DB Branch ID": resolution.branch?.id ?? REQUIRED,
      "DB Branch Code": resolution.branch?.code ?? REQUIRED,
      "DB Branch Match Status": resolution.branchStatus,
      "User Details": order["User Details"] ?? REQUIRED,
      "Registration Number(s)": order["Registration No(s)"] || "Not supplied",
      "DB Created By User ID": resolution.creator?.user_id ?? resolution.creator?.id ?? REQUIRED,
      "DB Creator Match Status": resolution.creatorStatus,
      "Creator Match Source": resolution.creatorSource,
      "Order Type": order["Order Type"] ?? REQUIRED,
      "Payment Mode Code": order["Payment Mode Code"] ?? refund?.PaymentMode ?? "Not supplied",
      "Payment Status to Import": "UNPAID - historical policy; confirm if different",
      "Order Subtotal PKR": subtotal ?? REQUIRED,
      "Discount PKR": discount ?? 0,
      "Service Charges PKR": service ?? 0,
      "Tax PKR": tax ?? REQUIRED,
      "Grand Total PKR": grandTotal ?? REQUIRED,
      "Header Totals Reconcile": headerReconciles ? "Yes" : REQUIRED,
      "Selected Item Value PKR": resolution.exactItems.length > 0 || resolution.candidates.length > 0 ? selectedItemValue : REQUIRED,
      "Item Value Reconciles to Subtotal": itemReconciles ? "Yes" : REQUIRED,
      "Exact ID-linked Product Rows": resolution.exactItems.length,
      "Candidate Summary Product Rows": resolution.candidates.length,
      "Product Mapping Status": resolution.allProductsResolved ? "All resolved" : REQUIRED,
      "Refund Evidence": refund ? "Yes" : "No",
      "Refund Classification": refund ? (fullRefund ? "FULL" : "PARTIAL") : "NONE",
      "Refund Amount Before Tax PKR": refund ? Number(refund.RefundAmount || 0) : NOT_APPLICABLE,
      "Refund Tax PKR": refund ? Number(refund.TaxRefund || 0) : NOT_APPLICABLE,
      "Total Refund PKR": refund ? grossRefund : NOT_APPLICABLE,
      "Status to Import": targetStatus,
      "Fulfillment Status to Import": targetFulfillmentStatus,
      "Status Immediately Before Refund": statusBeforeRefund,
      "Candidate Refund Timestamp (LastUpdateDT)": candidateRefundedAt,
      "Refunded At to Import": refundedAt,
      "Refund Reason": refund?.Remarks || (refund ? "Optional - not supplied" : NOT_APPLICABLE),
      "Refund Processor User ID": refund ? "Optional - unknown legacy processor" : NOT_APPLICABLE,
      "Refund XLS Row": refundWorkbook?.["Refund XLS Row"] ?? NOT_APPLICABLE,
      "Primary Source Lookup": order["Primary Excel Lookup"] || REQUIRED,
      "Updated Orders XLS Row": order["Updated Orders XLS Row"] || NOT_APPLICABLE,
      "Updated Sales XLS Rows": order["Updated Sales XLS Rows"] || NOT_APPLICABLE,
      "Prior Orders XLS Row": order["Prior Orders XLS Row"] || NOT_APPLICABLE,
      "Prior Sales XLS Rows": order["Prior Sales XLS Rows"] || NOT_APPLICABLE,
      "Import Readiness": readiness,
      "Missing Required Values": missing.size > 0 ? [...missing].join("; ") : "None",
      "Comment": commentParts.join(" "),
    }
  })

  const readinessCounts = orderReviewRows.reduce<Record<string, number>>((counts, row) => {
    counts[row["Import Readiness"]] = (counts[row["Import Readiness"]] ?? 0) + 1
    return counts
  }, {})
  const categoryCounts = orderReviewRows.reduce<Record<string, number>>((counts, row) => {
    counts[row["Blocker Code"]] = (counts[row["Blocker Code"]] ?? 0) + 1
    return counts
  }, {})
  const orderIdsWithExactItems = new Set(productRows.filter((row) => String(row["Product Evidence Type"]).startsWith("Exact")).map((row) => Number(row["Legacy Order ID"])))
  const orderIdsWithCandidatesOnly = new Set(productRows.filter((row) => String(row["Product Evidence Type"]).startsWith("Candidate")).map((row) => Number(row["Legacy Order ID"])))
  const orderIdsWithNoItems = new Set(productRows.filter((row) => row["Product Evidence Type"] === "Missing item evidence").map((row) => Number(row["Legacy Order ID"])))

  const summaryRows: JsonRow[] = [
    { "Metric": "Workbook purpose", "Value": "Non-cancelled, live-unimported K-Electric legacy order import requirements", "Comment": "Every included order is organization 10 only. Cancelled orders are excluded." },
    { "Metric": "Live organization safety gate", "Value": `${liveOrganization.id} / ${liveOrganization.code} / ${liveOrganization.name} / ${liveOrganization.status}`, "Comment": "Must remain exactly 10 / 0001 / K-Electric / active before any future import." },
    { "Metric": "Known legacy order IDs", "Value": remainingReport.counts.knownLegacyOrderIds, "Comment": "From the reviewed remaining-order report." },
    { "Metric": "Verified imported legacy IDs in report baseline", "Value": remainingReport.counts.importedLegacyOrderIds, "Comment": "594 original plus 51 incremental." },
    { "Metric": "Current live K-Electric imported legacy IDs", "Value": liveCountRows[0]?.imported_legacy_ids ?? REQUIRED, "Comment": "Read directly from legacy_order_imports where organization_id = 10." },
    { "Metric": "Current live K-Electric orders", "Value": liveCountRows[0]?.organization_orders ?? REQUIRED, "Comment": "Read directly from orders where organization_id = 10." },
    { "Metric": "Remaining report IDs before exclusions", "Value": allOrderRows.length, "Comment": "The compiled review workbook contains every remaining ID exactly once." },
    { "Metric": "Cancelled orders excluded", "Value": cancelledRows.length, "Comment": "Cancellation is based on current/prior human status, StatusID 5, or StatusID 4 with DeliveryStatus 508. Refund-report ID 640 is excluded because the Orders report says Cancelled." },
    { "Metric": "Non-cancelled report IDs", "Value": reportNonCancelledRows.length, "Comment": "This is 77, not the estimated 66." },
    { "Metric": "Already imported/colliding IDs removed using live DB", "Value": reportNonCancelledRows.length - selectedOrderRows.length, "Comment": "Live checks are restricted to organization 10 and KE-LEGACY TIDs." },
    { "Metric": "Orders included in this workbook", "Value": selectedOrderRows.length, "Comment": "Non-cancelled and absent from the live K-Electric import ledger/orders." },
    { "Metric": "Orders with exact ID-linked item rows", "Value": orderIdsWithExactItems.size, "Comment": "These item rows originate from updated or prior sales evidence linked by legacy ID." },
    { "Metric": "Orders with candidate summary items only", "Value": orderIdsWithCandidatesOnly.size, "Comment": "Candidate rows do not expose legacy order ID and require confirmation." },
    { "Metric": "Orders with no item evidence", "Value": orderIdsWithNoItems.size, "Comment": "Product, quantity, and price columns are marked Required." },
    { "Metric": "Product/detail rows in workbook", "Value": productRows.length, "Comment": "At least one product or Required placeholder row exists for every included order." },
    { "Metric": "READY FOR GUARDED PREFLIGHT", "Value": readinessCounts["READY FOR GUARDED PREFLIGHT"] ?? 0, "Comment": "Still requires a separate dry run and manifest review before any database write." },
    { "Metric": "CONDITIONAL - POLICY CONFIRMATION REQUIRED", "Value": readinessCounts["CONDITIONAL - POLICY CONFIRMATION REQUIRED"] ?? 0, "Comment": "Source values exist, but a historical mapping policy must be explicitly approved." },
    { "Metric": "BLOCKED - REQUIRED VALUES MISSING", "Value": readinessCounts["BLOCKED - REQUIRED VALUES MISSING"] ?? 0, "Comment": "See Missing Required Values and Comment columns." },
    ...Object.entries(categoryCounts).sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({
      "Metric": `Included blocker: ${code}`,
      "Value": count,
      "Comment": remainingReport.categories.find((category) => category.code === code)?.title ?? "",
    })),
    { "Metric": "Historical side-effect rule", "Value": "No current budget, stock, quantity budget, notification, or invoice-sequence mutations", "Comment": "Future import must use a dedicated atomic historical migration, not standard order/refund APIs." },
  ]

  const requiredFields: JsonRow[] = [
    { table: "orders", field: "tid", db_type: "varchar(26)", nullable: "NO", tracker_column: "Generated TID", source_rule: "KE-LEGACY-{Legacy Order ID}", validation: "Unique and ledger-protected" },
    { table: "orders", field: "organization_id", db_type: "integer", nullable: "Schema YES; migration requires value", tracker_column: "Target Organization ID", source_rule: "Fixed to 10", validation: "Organization must remain 10/0001/K-Electric" },
    { table: "orders", field: "branch_id", db_type: "integer", nullable: "NO", tracker_column: "DB Branch ID", source_rule: "Exact active K-Electric branch match", validation: "Branch organization_id = 10" },
    { table: "orders", field: "status", db_type: "varchar(32)", nullable: "NO", tracker_column: "Status to Import", source_rule: "Final-state evidence or approved mapping", validation: "Do not guess non-final/refund origin state" },
    { table: "orders", field: "fulfillment_status", db_type: "varchar(32)", nullable: "NO", tracker_column: "Fulfillment Status to Import", source_rule: "Authoritative delivery state", validation: "Historical status mapping required" },
    { table: "orders", field: "payment_status", db_type: "varchar(16)", nullable: "NO", tracker_column: "Payment Status to Import", source_rule: "Historical policy currently UNPAID", validation: "Confirm any exception" },
    { table: "orders", field: "subtotal_cents", db_type: "bigint", nullable: "NO", tracker_column: "Order Subtotal PKR", source_rule: "Header/item evidence", validation: "Nonnegative and reconciles" },
    { table: "orders", field: "tax_cents", db_type: "bigint", nullable: "NO", tracker_column: "Tax PKR", source_rule: "Header evidence", validation: "Nonnegative" },
    { table: "orders", field: "total_cents", db_type: "bigint", nullable: "NO", tracker_column: "Grand Total PKR", source_rule: "Header evidence", validation: "Subtotal - discount + service + tax" },
    { table: "orders", field: "created_by_user_id", db_type: "uuid", nullable: "NO", tracker_column: "DB Created By User ID", source_rule: "KE ledger or unique branch user", validation: "User/branch/organization relationship" },
    { table: "orders", field: "created_at", db_type: "timestamptz", nullable: "Physical YES; migration requires value", tracker_column: "Created At", source_rule: "CreatedOn", validation: "Valid historical timestamp" },
    { table: "orders", field: "refunded_at", db_type: "timestamptz", nullable: "YES", tracker_column: "Refunded At to Import", source_rule: "Explicit refund timestamp", validation: "LastUpdateDT requires confirmation" },
    { table: "orders", field: "status_at_refund", db_type: "varchar(32)", nullable: "YES", tracker_column: "Status Immediately Before Refund", source_rule: "Pre-refund state evidence", validation: "Required for faithful refund reporting" },
    { table: "orders", field: "refund_amount_cents", db_type: "bigint", nullable: "YES", tracker_column: "Total Refund PKR", source_rule: "RefundAmount + TaxRefund", validation: "0 <= refund <= total" },
    { table: "orders", field: "receipt_data", db_type: "jsonb", nullable: "YES", tracker_column: "Order + Order Products sheets", source_rule: "Historical snapshot", validation: "Items/totals/refund must agree" },
    { table: "order_items", field: "organization_id", db_type: "integer", nullable: "YES", tracker_column: "Target Organization ID", source_rule: "Fixed to 10", validation: "Must equal parent organization" },
    { table: "order_items", field: "organization_inventory_id", db_type: "integer", nullable: "YES", tracker_column: "DB Organization Inventory ID", source_rule: "KE product mapping", validation: "Must belong to organization 10" },
    { table: "order_items", field: "global_product_id", db_type: "integer", nullable: "NO", tracker_column: "DB Global Product ID", source_rule: "KE legacy product mapping", validation: "Existing nondeleted product" },
    { table: "order_items", field: "product_name", db_type: "varchar(255)", nullable: "NO", tracker_column: "Product Name", source_rule: "Exact sales line", validation: "No placeholder names" },
    { table: "order_items", field: "product_code", db_type: "varchar(128)", nullable: "YES", tracker_column: "DB Product Code", source_rule: "Current mapped product snapshot", validation: "Preserve current canonical code" },
    { table: "order_items", field: "unit", db_type: "varchar(64)", nullable: "NO", tracker_column: "Unit", source_rule: "Mapped DB product unit", validation: "Required" },
    { table: "order_items", field: "quantity", db_type: "numeric(12,3)", nullable: "NO", tracker_column: "Quantity", source_rule: "Exact item line", validation: "> 0 and <= 1,000,000" },
    { table: "order_items", field: "price_cents", db_type: "bigint", nullable: "NO", tracker_column: "Resolved Unit Price Cents", source_rule: "Reconciled effective unit price", validation: ">= 0 and item subtotal reconciles" },
    { table: "refunds", field: "order_id", db_type: "integer", nullable: "NO", tracker_column: "Generated after order insert", source_rule: "Parent imported order", validation: "Same organization 10" },
    { table: "refunds", field: "amount_cents", db_type: "bigint", nullable: "NO", tracker_column: "Total Refund PKR", source_rule: "Approved historical refund amount", validation: "> 0" },
    { table: "refunds", field: "status", db_type: "varchar(16)", nullable: "NO", tracker_column: "Refund Evidence", source_rule: "APPROVED for authoritative historical refunds", validation: "No current workflow notifications/budget changes" },
    { table: "refund_items", field: "order_item_id", db_type: "integer", nullable: "NO", tracker_column: "DB item created from Order Products row", source_rule: "Exact refunded item allocation", validation: "Must belong to parent order" },
    { table: "refund_items", field: "quantity", db_type: "numeric(12,3)", nullable: "NO", tracker_column: "Refunded Quantity", source_rule: "Full item quantity or authoritative partial allocation", validation: "> 0 and <= ordered quantity" },
    { table: "refund_items", field: "amount_cents", db_type: "bigint", nullable: "NO", tracker_column: "Refund Item Amount PKR", source_rule: "Quantity x reconciled effective price", validation: ">= 0" },
    { table: "legacy_order_imports", field: "legacy_order_id", db_type: "integer", nullable: "NO", tracker_column: "Legacy Order ID", source_rule: "Legacy ID", validation: "Unique for organization 10 + KE_LOGISTICS" },
    { table: "legacy_order_imports", field: "source_checksum", db_type: "varchar(64)", nullable: "NO", tracker_column: "Generated by future importer", source_rule: "Canonical header + item + refund evidence", validation: "Manifest/checksum protected" },
  ].map((row) => {
    const physical = liveSchemaRows.find((column) => column.table_name === row.table && column.column_name === row.field)
    return {
      "Table": row.table,
      "Database Field": row.field,
      "Local Schema / Expected Type": row.db_type,
      "Live DB Type": physical?.data_type ?? REQUIRED,
      "Live DB Nullable": physical?.is_nullable ?? REQUIRED,
      "Tracker Column": row.tracker_column,
      "Source / Entry Rule": row.source_rule,
      "Validation": row.validation,
      "Comment": physical ? "Field exists in the live schema." : "Required live-schema field was not found; migration must stop.",
    }
  })

  const dbComparisonRows: JsonRow[] = [
    { "Check": "Organization identity", "Live Result": `${liveOrganization.id}/${liveOrganization.code}/${liveOrganization.name}/${liveOrganization.status}`, "Expected": "10/0001/K-Electric/active", "Status": "PASS", "Comment": "All data queries were organization-10 scoped." },
    { "Check": "Total imported K-Electric legacy IDs", "Live Result": liveCountRows[0]?.imported_legacy_ids ?? REQUIRED, "Expected": remainingReport.counts.importedLegacyOrderIds, "Status": Number(liveCountRows[0]?.imported_legacy_ids) === remainingReport.counts.importedLegacyOrderIds ? "PASS" : "REVIEW", "Comment": "Live ledger count compared with the reviewed 645-order baseline." },
    { "Check": "Total live K-Electric orders", "Live Result": liveCountRows[0]?.organization_orders ?? REQUIRED, "Expected": "Informational", "Status": "INFO", "Comment": "Organization-10 order count only; no other organization was queried." },
    { "Check": "Live ledger collisions in 166 remaining IDs", "Live Result": liveImportRows.length, "Expected": 0, "Status": liveImportRows.length === 0 ? "PASS" : "REVIEW", "Comment": "Any live-imported ID is excluded from the workbook." },
    { "Check": "Live KE-LEGACY order collisions in 166 remaining IDs", "Live Result": liveOrderRows.length, "Expected": 0, "Status": liveOrderRows.length === 0 ? "PASS" : "REVIEW", "Comment": "Any live order collision is excluded from the workbook." },
    { "Check": "Selected orders with resolved DB branch", "Live Result": orderReviewRows.filter((row) => row["DB Branch ID"] !== REQUIRED).length, "Expected": selectedOrderRows.length, "Status": orderReviewRows.every((row) => row["DB Branch ID"] !== REQUIRED) ? "PASS" : "REQUIRED", "Comment": "Only active K-Electric branches count as resolved." },
    { "Check": "Selected orders with resolved DB creator", "Live Result": orderReviewRows.filter((row) => row["DB Created By User ID"] !== REQUIRED).length, "Expected": selectedOrderRows.length, "Status": orderReviewRows.every((row) => row["DB Created By User ID"] !== REQUIRED) ? "PASS" : "REQUIRED", "Comment": "Uses KE legacy mappings first, then a unique active branch ORDER_PORTAL user." },
    { "Check": "Product rows with resolved DB product IDs", "Live Result": productRows.filter((row) => row["DB Global Product ID"] !== REQUIRED).length, "Expected": productRows.length, "Status": productRows.every((row) => row["DB Global Product ID"] !== REQUIRED) ? "PASS" : "REQUIRED", "Comment": "Candidate/placeholder rows still require exact order linkage even when catalog mapping exists." },
    { "Check": "Cancelled orders included", "Live Result": 0, "Expected": 0, "Status": "PASS", "Comment": `${cancelledRows.length} cancelled rows were excluded.` },
    { "Check": "Other-organization rows queried for comparison", "Live Result": 0, "Expected": 0, "Status": "PASS", "Comment": "No other organization's operational data was read or written." },
  ]

  const sourceAuditRows = recursiveFiles(updatedRoot)
    .sort((a, b) => a.localeCompare(b))
    .map((path) => fileAuditRow(updatedRoot, path))

  const workbook = XLSX.utils.book_new()
  workbook.Props = {
    Title: "K-Electric Non-Cancelled Unimported Orders - Import Requirements",
    Subject: `${selectedOrderRows.length} non-cancelled K-Electric legacy orders compared with the live database and schema`,
    Author: "OneFlow",
    CreatedDate: new Date(),
  }

  addSheet(workbook, "Summary", summaryRows, { integerHeaders: ["Value"] })
  addSheet(workbook, "Import Review", orderReviewRows, {
    dateHeaders: ["Order Date", "Created At", "Last Updated At", "Candidate Refund Timestamp (LastUpdateDT)"],
    moneyHeaders: [
      "Order Subtotal PKR", "Discount PKR", "Service Charges PKR", "Tax PKR", "Grand Total PKR",
      "Selected Item Value PKR", "Refund Amount Before Tax PKR", "Refund Tax PKR", "Total Refund PKR",
    ],
    integerHeaders: ["Legacy Order ID", "Target Organization ID", "Order Number", "Transaction Number", "DB Branch ID", "Exact ID-linked Product Rows", "Candidate Summary Product Rows"],
  })
  addSheet(workbook, "Order Products", productRows, {
    dateHeaders: ["Order Date"],
    moneyHeaders: ["Source Unit Price PKR", "Source Sale Revenue PKR", "Resolved Line Total PKR", "Refund Item Amount PKR"],
    integerHeaders: ["Legacy Order ID", "Order Number", "Transaction Number", "DB Branch ID", "Line Number", "Resolved Unit Price Cents", "DB Global Product ID", "DB Organization Inventory ID"],
  })
  addSheet(workbook, "Schema Requirements", requiredFields)
  addSheet(workbook, "Database Comparison", dbComparisonRows)
  addSheet(workbook, "Source Audit", sourceAuditRows, { integerHeaders: ["Bytes"] })

  XLSX.writeFile(workbook, outputPath, { bookType: "xlsx", compression: true })

  const validation = XLSX.readFile(outputPath, { cellDates: true })
  const expectedSheets = ["Summary", "Import Review", "Order Products", "Schema Requirements", "Database Comparison", "Source Audit"]
  assert(expectedSheets.every((sheet) => validation.SheetNames.includes(sheet)), "Output workbook is missing required sheets")
  const validatedOrders = sheetRows(validation, "Import Review")
  const validatedProducts = sheetRows(validation, "Order Products")
  assert(validatedOrders.length === selectedOrderRows.length, "Validated order row count mismatch")
  assert(new Set(validatedOrders.map((row) => Number(row["Legacy Order ID"]))).size === selectedOrderRows.length, "Validated order IDs are not unique")
  assert(validatedOrders.every((row) => !isCancelledOrder(row)), "Cancelled order leaked into Import Review")
  assert(new Set(validatedProducts.map((row) => Number(row["Legacy Order ID"]))).size === selectedOrderRows.length, "Every selected order must have a product or Required placeholder row")
  assert(validatedOrders.every((row) => Object.prototype.hasOwnProperty.call(row, "Comment")), "Order review is missing Comment column")
  assert(validatedProducts.every((row) => Object.prototype.hasOwnProperty.call(row, "Comment")), "Product review is missing Comment column")

  console.log(JSON.stringify({
    status: "PASS",
    outputPath,
    organization: liveOrganization,
    counts: {
      knownLegacyIds: remainingReport.counts.knownLegacyOrderIds,
      importedBaseline: remainingReport.counts.importedLegacyOrderIds,
      liveImportedLegacyIds: Number(liveCountRows[0]?.imported_legacy_ids),
      liveOrganizationOrders: Number(liveCountRows[0]?.organization_orders),
      remainingBeforeExclusions: allOrderRows.length,
      cancelledExcluded: cancelledRows.length,
      reportNonCancelled: reportNonCancelledRows.length,
      liveImportedOrOrderCollisionsExcluded: reportNonCancelledRows.length - selectedOrderRows.length,
      workbookOrders: validatedOrders.length,
      workbookProductRows: validatedProducts.length,
      exactItemOrders: orderIdsWithExactItems.size,
      candidateOnlyItemOrders: orderIdsWithCandidatesOnly.size,
      noItemEvidenceOrders: orderIdsWithNoItems.size,
      readiness: readinessCounts,
      sourceFilesReviewed: sourceAuditRows.length,
    },
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
