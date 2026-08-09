#!/usr/bin/env tsx
/**
 * Guarded K-Electric migration for orders created strictly after 2026-07-10.
 *
 * Dry-run is the default. Commit mode requires the exact tenant, source and
 * plan digests plus the printed mutation counts. The transaction creates one
 * branch, stable branch identities, missing historical users/mappings, source
 * budget allocations, operational money holds, orders/items and audit ledgers.
 * It never changes stock, quantity budgets, invoice sequences or other tenants.
 */

import { randomBytes } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, relative, resolve, sep } from "path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"
import {
  KE_POST_CUTOFF_EXPECTED,
  KE_POST_CUTOFF_SOURCE,
  budgetRowCents,
  canonicalJson,
  normalizeLegacyProduct,
  normalizeLegacyText,
  preparePostCutoffOrders,
  sha256,
  validateBudgetRows,
  validateExpectedPostCutoffTotals,
  type LegacyBudgetRow,
  type LegacyOrderDetail,
  type LegacyOrderListRow,
  type PreparedPostCutoffOrder,
} from "../lib/legacy-import/ke-post-cutoff"
import { generateApprovalToken, hashApprovalToken, verifyApprovalToken } from "../lib/approval-token"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
const ORGANIZATION_CONFIRMATION = "10:0001:K-Electric"
const NEW_BRANCH = {
  legacyLocationId: 148,
  name: "Johar Technical",
  province: "Sindh",
  city: "Karachi",
  address: "Cluster 3 (Johar)",
} as const
const EXISTING_BRANCH_ALIASES: Record<number, { id: number; name: string; address: string }> = {
  109: { id: 207, name: "liyari I", address: "IBC Lyari 01" },
  110: { id: 208, name: "BALDIA", address: "IBC Baldia" },
}
const BUDGET_ALIAS_LOCATION_IDS: Record<string, number> = {
  "baldia ibc": 110,
  "johar technical": 148,
}
const MILLAC_OVERRIDE = {
  sourceNormalizedName: "millac tea whitener 850gm",
  globalProductId: 238,
  productCode: "PRD--93",
  productName: "Milac Instant Tea whitener (850gm)",
} as const

type Row = Record<string, any>

interface Options {
  sourceRoot: string
  outputPath: string
  commit: boolean
  rollbackTest: boolean
  actorUserId?: string
  confirmOrganization?: string
  confirmSource?: string
  confirmPlan?: string
  expectedOrders?: number
  expectedApproved?: number
  expectedBudgetInserts?: number
  expectedHistoricalUsers?: number
  allowJoharTechnical: boolean
  allowBranchIdentityUpdates: boolean
  allowHistoricalUsers: boolean
}

interface LoadedSource {
  root: string
  manifest: Row
  digest: string
  prepared: PreparedPostCutoffOrder[]
  cancelledIds: number[]
  budgets: LegacyBudgetRow[]
}

interface BranchPlan {
  key: string
  legacyLocationId: number
  sourceName: string
  sourceGroupName: string
  action: "EXISTING" | "CREATE"
  id: number | null
  currentName: string | null
  code: string
  address: string | null
  externalIdentityAction: "NONE" | "ATTACH"
  groupId: number
  groupName: string
  groupAction: "NONE" | "ASSIGN"
  currentBaselineCents: number
  targetBaselineCents: number
}

interface ProductPlan {
  normalizedName: string
  sourceName: string
  globalProductId: number
  organizationInventoryId: number
  productCode: string
  unit: string
  mappingAction: "NONE" | "CREATE"
}

interface UserPlan {
  key: string
  legacyLocationId: number
  legacyOrderTakerId: number
  branchKey: string
  sourceName: string
  action: "LEDGER" | "EXACT" | "HISTORICAL"
  userId: string | null
  username: string | null
  email: string | null
  mappingAction: "NONE" | "CREATE"
  orderIds: number[]
}

interface BudgetPlan {
  key: string
  branchKey: string
  period: string
  action: "EXISTING" | "INSERT"
  budgetId: number | null
  allocatedCents: number
  creditedCents: number
  currentSpentCents: number
  currentHeldCents: number
  holdDeltaCents: number
  sourceLocation: string | null
  sourceUsedCents: number | null
  sourceRemainingCents: number | null
}

interface BranchInventoryPlan {
  branchKey: string
  organizationInventoryId: number
  globalProductId: number
}

interface OrderPlan {
  legacyOrderId: number
  branchKey: string
  userKey: string
  status: "APPROVED" | "FULFILLED"
  fulfillmentStatus: "NOT_STARTED" | "IN_PROCESS" | "OUT_FOR_DELIVERY" | "DELIVERED"
  totalCents: number
  sourceChecksum: string
}

interface MigrationPlan {
  sourceDigest: string
  planDigest: string
  blockingIssues: string[]
  branches: BranchPlan[]
  products: ProductPlan[]
  users: UserPlan[]
  budgets: BudgetPlan[]
  branchInventory: BranchInventoryPlan[]
  orders: OrderPlan[]
  counts: Record<string, number>
  totalsCents: Record<string, number>
  stateEvidence: Row
}

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function numericArgument(name: string): number | undefined {
  const value = argument(name)
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`)
  return number
}

function parseOptions(): Options {
  const commit = process.argv.includes("--commit")
  const rollbackTest = process.argv.includes("--rollback-test")
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  return {
    sourceRoot: resolve(argument("--source-root") ?? "updatedReports/ke-post-cutoff-2026-08-07"),
    outputPath: resolve(argument("--output") ?? (commit || rollbackTest
      ? `backups/ke-post-cutoff-import-${rollbackTest ? "rollback-test" : "commit"}-${timestamp}.json`
      : "updatedReports/ke-post-cutoff-2026-08-07/preflight.json")),
    commit,
    rollbackTest,
    actorUserId: argument("--actor-user-id"),
    confirmOrganization: argument("--confirm-organization"),
    confirmSource: argument("--confirm-source"),
    confirmPlan: argument("--confirm-plan"),
    expectedOrders: numericArgument("--expected-orders"),
    expectedApproved: numericArgument("--expected-approved"),
    expectedBudgetInserts: numericArgument("--expected-budget-inserts"),
    expectedHistoricalUsers: numericArgument("--expected-historical-users"),
    allowJoharTechnical: process.argv.includes("--allow-create-johar-technical"),
    allowBranchIdentityUpdates: process.argv.includes("--allow-branch-identity-updates"),
    allowHistoricalUsers: process.argv.includes("--allow-historical-users"),
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function rows<T extends Row = Row>(client: PoolClient | { query: Function }, text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

function integer(value: unknown, context: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`${context}: expected a safe integer, got ${String(value)}`)
  return number
}

function chunksOf<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function sourceFile(root: string, path: string): string {
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || resolve(absolute) === resolve(root)) {
    throw new Error(`Unsafe source manifest path ${path}`)
  }
  return absolute
}

function loadSource(root: string): LoadedSource {
  const manifestPath = resolve(root, "source-manifest.json")
  assert(existsSync(manifestPath), `Source manifest not found: ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Row
  const { digest, ...unsigned } = manifest
  assert(typeof digest === "string" && digest === sha256(canonicalJson(unsigned)), "Source manifest digest is invalid")
  assert(manifest.organization?.id === ORGANIZATION.id
    && manifest.organization?.code === ORGANIZATION.code
    && manifest.organization?.name === ORGANIZATION.name, "Source manifest is not fixed to K-Electric")
  for (const [name, metadata] of Object.entries(manifest.files ?? {}) as Array<[string, Row]>) {
    const path = sourceFile(root, String(metadata.path))
    const body = readFileSync(path)
    assert(body.length === Number(metadata.bytes), `${name}: source file byte length changed`)
    assert(sha256(body) === metadata.sha256, `${name}: source file checksum changed`)
  }
  const listRows = JSON.parse(readFileSync(sourceFile(root, manifest.files["legacy-order-list.json"].path), "utf8")) as LegacyOrderListRow[]
  const details = JSON.parse(readFileSync(sourceFile(root, manifest.files["legacy-order-details.json"].path), "utf8")) as LegacyOrderDetail[]
  const budgets = JSON.parse(readFileSync(sourceFile(root, manifest.files["budget-source.json"].path), "utf8")) as LegacyBudgetRow[]
  validateBudgetRows(budgets)
  const { prepared, cancelledIds } = preparePostCutoffOrders(listRows, details)
  validateExpectedPostCutoffTotals(prepared, cancelledIds)
  assert(Number(manifest.counts?.importable) === prepared.length, "Manifest importable count changed")
  assert(Number(manifest.totalsCents?.all) === KE_POST_CUTOFF_EXPECTED.totalCents, "Manifest grand total changed")
  return { root, manifest, digest, prepared, cancelledIds, budgets }
}

function branchKey(locationId: number): string {
  return `legacy:${locationId}`
}

function groupKey(value: string): string {
  const normalized = normalizeLegacyText(value).replace(/ group$/, "")
  return normalized === "transmission" ? "tranmission" : normalized
}

function exactBranchName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
}

function userKey(locationId: number, orderTakerId: number): string {
  return `${locationId}:${orderTakerId}`
}

function budgetKey(key: string, period: string): string {
  return `${key}|${period}`
}

function nextBranchCode(branches: Row[]): string {
  const used = new Set(branches.map((branch) => String(branch.code ?? "")).filter(Boolean))
  let number = Math.max(branches.length + 1, ...branches.map((branch) => {
    const match = /^0001-(\d+)$/.exec(String(branch.code ?? ""))
    return match ? Number(match[1]) + 1 : 1
  }))
  while (used.has(`0001-${String(number).padStart(2, "0")}`)) number += 1
  return `0001-${String(number).padStart(2, "0")}`
}

function receipt(order: PreparedPostCutoffOrder, branch: BranchPlan, productByName: Map<string, ProductPlan>) {
  const items = order.lines.map((line) => {
    const product = productByName.get(line.normalizedName)!
    return {
      id: product.globalProductId,
      description: line.sourceName,
      quantity: line.quantity,
      rate: line.priceCents / 100,
      tax: 0,
      total: line.lineTotalCents / 100,
      unit: product.unit,
    }
  })
  return {
    invoiceNumber: `KE-LEGACY-${order.legacyOrderId}`,
    date: order.createdAt.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }),
    status: order.status,
    fulfillmentStatus: order.fulfillmentStatus,
    buyerName: branch.action === "CREATE" ? NEW_BRANCH.name : branch.currentName,
    buyerAddress: branch.address ?? "",
    organizationName: ORGANIZATION.name,
    items: [{
      mainCategoryName: "General",
      subCategories: [{ subCategoryName: "General", items, subtotal: order.subtotalCents / 100 }],
      total: order.subtotalCents / 100,
    }],
    subtotal: order.subtotalCents / 100,
    discount: 0,
    tax: order.taxCents / 100,
    deliveryCharges: 0,
    refund: 0,
    totalAmount: order.totalCents / 100,
  }
}

async function buildPlan(client: PoolClient | { query: Function }, source: LoadedSource): Promise<MigrationPlan> {
  const issues: string[] = []
  const orderIds = source.prepared.map((order) => order.legacyOrderId)
  const tids = orderIds.map((id) => `KE-LEGACY-${id}`)
  const [organizations, dbBranches, dbGroups, dbUsers, dbUserMappings, allUsernames, dbProducts, dbOrgInventory,
    dbProductMappings, dbBudgets, dbImports, dbTids, protectedState, schemaState] = await Promise.all([
    rows(client, "select id, code, name, status from organizations where id=$1", [ORGANIZATION.id]),
    rows(client, `select id, organization_id, name, address, code, external_source, external_id, status, group_id,
                         baseline_budget_cents from branches where organization_id=$1 order by id`, [ORGANIZATION.id]),
    rows(client, "select id, name, status from groups where organization_id=$1 and status <> 'deleted' order by id", [ORGANIZATION.id]),
    rows(client, `select u.id,u.full_name,u.first_name,u.last_name,u.username,u.organization_id,u.branch_id,u.is_active,
                         u.deleted_at,r.name as role_name
                  from users u join roles r on r.id=u.role_id where u.organization_id=$1`, [ORGANIZATION.id]),
    rows(client, `select organization_id,source_system,legacy_order_taker_id,branch_id,source_name,user_id,is_synthetic
                  from legacy_user_mappings where organization_id=$1 and source_system=$2`, [ORGANIZATION.id, KE_POST_CUTOFF_SOURCE]),
    rows(client, "select id,username from users where username is not null"),
    rows(client, `select id,product_code,name,unit,status,deleted_at,stock_quantity from global_products
                  where deleted_at is null order by id`),
    rows(client, `select id,organization_id,global_product_id,is_active,deleted_at from organization_inventory
                  where organization_id=$1 order by id`, [ORGANIZATION.id]),
    rows(client, `select normalized_name,source_name,global_product_id,organization_inventory_id
                  from legacy_product_mappings where organization_id=$1 and source_system=$2`, [ORGANIZATION.id, KE_POST_CUTOFF_SOURCE]),
    rows(client, `select id,branch_id,period,amount_allocated_cents,amount_spent_cents,amount_held_cents,amount_credited_cents
                  from budgets where organization_id=$1 order by branch_id,period`, [ORGANIZATION.id]),
    rows(client, `select legacy_order_id,source_checksum,order_id from legacy_order_imports
                  where organization_id=$1 and source_system=$2 and legacy_order_id=any($3::int[])`, [ORGANIZATION.id, KE_POST_CUTOFF_SOURCE, orderIds]),
    rows(client, "select id,tid,organization_id from orders where tid=any($1::text[])", [tids]),
    rows(client, `select
      (select count(*)::int from orders where organization_id<>$1) as other_tenant_orders,
      (select count(*)::int from branches where organization_id<>$1) as other_tenant_branches,
      (select coalesce(sum(amount_spent_cents),0)::text from budgets where organization_id=$1) as spent,
      (select coalesce(sum(amount_held_cents),0)::text from budgets where organization_id=$1) as held,
      (select coalesce(sum(stock_quantity),0)::text from global_products where deleted_at is null) as global_stock,
      (select coalesce(sum(held_quantity),0)::text from product_quantity_budgets where organization_id=$1) as quantity_held,
      (select coalesce(sum(used_quantity),0)::text from product_quantity_budgets where organization_id=$1) as quantity_used,
      (select last_value::text from invoice_sequences where organization_id=$1) as invoice_sequence`, [ORGANIZATION.id]),
    rows(client, `select
      to_regclass('public.legacy_import_batches') is not null as import_ledger,
      exists(select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='fulfillment_status') as fulfillment_status,
      exists(select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='approval_token_hash') as approval_tokens,
      exists(select 1 from information_schema.columns where table_schema='public' and table_name='branches' and column_name='external_source') as branch_identity`),
  ])

  const organization = organizations[0]
  if (!organization || Number(organization.id) !== ORGANIZATION.id || organization.code !== ORGANIZATION.code
    || organization.name !== ORGANIZATION.name || normalizeLegacyText(organization.status) !== "active") {
    issues.push("Tenant safety gate failed for organization 10 / K-Electric")
  }
  if (!schemaState[0]?.import_ledger || !schemaState[0]?.fulfillment_status || !schemaState[0]?.approval_tokens || !schemaState[0]?.branch_identity) {
    issues.push("Required legacy ledger, fulfillment, token, or branch-identity migration is missing")
  }
  if (dbImports.length > 0) {
    if (dbImports.length !== source.prepared.length) issues.push(`Partial prior import detected (${dbImports.length}/${source.prepared.length})`)
    for (const imported of dbImports) {
      const expected = source.prepared.find((order) => order.legacyOrderId === Number(imported.legacy_order_id))
      if (!expected || imported.source_checksum !== expected.sourceChecksum) issues.push(`Legacy order ${imported.legacy_order_id} checksum changed after import`)
    }
    if (dbImports.length === source.prepared.length) issues.push("All 111 orders are already imported; no new commit is allowed")
  }
  if (dbTids.length > 0 && dbImports.length === 0) issues.push(`${dbTids.length} target TID(s) exist without matching legacy ledger rows`)

  const sourceLocations = new Map<number, { names: Set<string>; groups: Set<string> }>()
  for (const order of source.prepared) {
    const location = sourceLocations.get(order.legacyLocationId) ?? { names: new Set(), groups: new Set() }
    location.names.add(order.branchName)
    location.groups.add(order.groupName)
    sourceLocations.set(order.legacyLocationId, location)
  }
  const groupByKey = new Map<string, Row[]>()
  for (const group of dbGroups) {
    const key = groupKey(String(group.name))
    groupByKey.set(key, [...(groupByKey.get(key) ?? []), group])
  }
  const newCode = nextBranchCode(dbBranches)
  const branches: BranchPlan[] = []
  for (const [locationId, facts] of [...sourceLocations].sort(([a], [b]) => a - b)) {
    if (facts.names.size !== 1 || facts.groups.size !== 1) {
      issues.push(`Legacy location ${locationId} has conflicting names or groups`)
      continue
    }
    const sourceName = [...facts.names][0]
    const sourceGroupName = [...facts.groups][0]
    const groupMatches = groupByKey.get(groupKey(sourceGroupName)) ?? []
    if (groupMatches.length !== 1) {
      issues.push(`Location ${locationId}: group ${sourceGroupName} matched ${groupMatches.length}`)
      continue
    }
    const group = groupMatches[0]
    const externalMatches = dbBranches.filter((branch) => branch.external_source === KE_POST_CUTOFF_SOURCE && String(branch.external_id) === String(locationId))
    let branch: Row | undefined
    if (externalMatches.length === 1) branch = externalMatches[0]
    else if (externalMatches.length > 1) issues.push(`Location ${locationId}: duplicate external branch identities`)
    if (!branch && EXISTING_BRANCH_ALIASES[locationId]) {
      const alias = EXISTING_BRANCH_ALIASES[locationId]
      const candidate = dbBranches.find((item) => Number(item.id) === alias.id)
      if (!candidate || normalizeLegacyText(candidate.name) !== normalizeLegacyText(alias.name)
        || normalizeLegacyText(candidate.address) !== normalizeLegacyText(alias.address)) {
        issues.push(`Location ${locationId}: confirmed branch alias ${alias.id}:${alias.name} no longer matches`)
      } else branch = candidate
    }
    if (!branch && locationId !== NEW_BRANCH.legacyLocationId) {
      let nameMatches = dbBranches.filter((item) => exactBranchName(item.name) === exactBranchName(sourceName))
      if (nameMatches.length === 0 && exactBranchName(sourceName) === "1. GSO") {
        nameMatches = dbBranches.filter((item) => exactBranchName(item.name) === "GSO")
      }
      if (nameMatches.length === 1) branch = nameMatches[0]
      else issues.push(`Location ${locationId}: branch ${sourceName} matched ${nameMatches.length}`)
    }
    if (!branch && locationId !== NEW_BRANCH.legacyLocationId) continue
    if (!branch && locationId === NEW_BRANCH.legacyLocationId) {
      const nameCollision = dbBranches.filter((item) => exactBranchName(item.name) === exactBranchName(NEW_BRANCH.name))
      if (nameCollision.length) {
        issues.push("Johar Technical name exists without the expected legacy identity")
        continue
      }
      branches.push({
        key: branchKey(locationId), legacyLocationId: locationId, sourceName, sourceGroupName,
        action: "CREATE", id: null, currentName: null, code: newCode, address: NEW_BRANCH.address,
        externalIdentityAction: "ATTACH", groupId: Number(group.id), groupName: String(group.name), groupAction: "ASSIGN",
        currentBaselineCents: 0, targetBaselineCents: 0,
      })
      continue
    }
    assert(branch, `Location ${locationId}: internal branch resolution invariant failed`)
    const pairedIdentity = branch.external_source == null && branch.external_id == null
    const correctIdentity = branch.external_source === KE_POST_CUTOFF_SOURCE && String(branch.external_id) === String(locationId)
    if (!pairedIdentity && !correctIdentity) issues.push(`Location ${locationId}: branch ${branch.id} has conflicting external identity`)
    const currentGroup = branch.group_id == null ? null : Number(branch.group_id)
    if (currentGroup !== null && currentGroup !== Number(group.id)) issues.push(`Location ${locationId}: branch ${branch.id} belongs to group ${currentGroup}, expected ${group.id}`)
    const isReviewedExistingAlias = Object.prototype.hasOwnProperty.call(EXISTING_BRANCH_ALIASES, locationId)
    branches.push({
      key: branchKey(locationId), legacyLocationId: locationId, sourceName, sourceGroupName,
      action: "EXISTING", id: Number(branch.id), currentName: String(branch.name), code: String(branch.code), address: branch.address,
      externalIdentityAction: correctIdentity || !isReviewedExistingAlias ? "NONE" : "ATTACH",
      groupId: Number(group.id), groupName: String(group.name), groupAction: currentGroup === null ? "ASSIGN" : "NONE",
      currentBaselineCents: integer(branch.baseline_budget_cents, `Branch ${branch.id} baseline`), targetBaselineCents: integer(branch.baseline_budget_cents, `Branch ${branch.id} baseline`),
    })
  }
  const branchByKey = new Map(branches.map((branch) => [branch.key, branch]))
  if (branches.length !== sourceLocations.size) issues.push(`Resolved ${branches.length}/${sourceLocations.size} source locations`)

  const budgetLocationId = (location: string): number | undefined => {
    const exact = [...sourceLocations].filter(([, facts]) => [...facts.names].some((name) => name.trim().toLowerCase() === location.trim().toLowerCase()))
    if (exact.length === 1) return exact[0][0]
    return BUDGET_ALIAS_LOCATION_IDS[normalizeLegacyText(location)]
  }
  const sourceBudgetByKey = new Map<string, { row: LegacyBudgetRow; locationId: number; values: ReturnType<typeof budgetRowCents> }>()
  for (const row of source.budgets) {
    const locationId = budgetLocationId(row.Location)
    if (!locationId || !branchByKey.has(branchKey(locationId))) {
      issues.push(`Budget location ${row.Location} cannot be tied to a resolved import branch`)
      continue
    }
    const values = budgetRowCents(row)
    sourceBudgetByKey.set(budgetKey(branchKey(locationId), values.period), { row, locationId, values })
  }
  for (const branch of branches) {
    const august = sourceBudgetByKey.get(budgetKey(branch.key, "2026-08"))
    if (august) branch.targetBaselineCents = august.values.allocatedCents
  }

  const productById = new Map(dbProducts.map((product) => [Number(product.id), product]))
  const orgInventoryById = new Map(dbOrgInventory.map((inventory) => [Number(inventory.id), inventory]))
  const activeOrgInventoryByProduct = new Map<number, Row>()
  for (const inventory of dbOrgInventory) {
    if (inventory.deleted_at == null) activeOrgInventoryByProduct.set(Number(inventory.global_product_id), inventory)
  }
  const mappingByName = new Map(dbProductMappings.map((mapping) => [String(mapping.normalized_name), mapping]))
  const productFacts = new Map<string, { sourceName: string }>()
  for (const order of source.prepared) for (const line of order.lines) {
    if (!productFacts.has(line.normalizedName)) productFacts.set(line.normalizedName, { sourceName: line.sourceName })
  }
  const products: ProductPlan[] = []
  for (const [normalizedName, fact] of [...productFacts].sort(([a], [b]) => a.localeCompare(b))) {
    const mapping = mappingByName.get(normalizedName)
    let product: Row | undefined
    let inventory: Row | undefined
    let mappingAction: ProductPlan["mappingAction"] = "NONE"
    if (mapping) {
      product = productById.get(Number(mapping.global_product_id))
      inventory = orgInventoryById.get(Number(mapping.organization_inventory_id))
      if (!product || !inventory || inventory.deleted_at != null
        || Number(inventory.organization_id) !== ORGANIZATION.id
        || Number(inventory.global_product_id) !== Number(product.id)) {
        issues.push(`Product mapping ${normalizedName} points to an invalid K-Electric inventory row`)
        continue
      }
    } else if (normalizedName === MILLAC_OVERRIDE.sourceNormalizedName) {
      product = productById.get(MILLAC_OVERRIDE.globalProductId)
      inventory = activeOrgInventoryByProduct.get(MILLAC_OVERRIDE.globalProductId)
      if (!product || !inventory || product.product_code !== MILLAC_OVERRIDE.productCode
        || normalizeLegacyProduct(product.name) !== normalizeLegacyProduct(MILLAC_OVERRIDE.productName)) {
        issues.push("Millac override no longer matches product 238 / PRD--93")
        continue
      }
      mappingAction = "CREATE"
    } else {
      const matches = dbProducts.filter((item) => normalizeLegacyProduct(item.name) === normalizedName)
      if (matches.length !== 1) {
        issues.push(`Product ${fact.sourceName} has no ledger mapping and matched ${matches.length} global products`)
        continue
      }
      product = matches[0]
      inventory = activeOrgInventoryByProduct.get(Number(product.id))
      if (!inventory) {
        issues.push(`Product ${fact.sourceName} is not actively assigned to K-Electric`)
        continue
      }
      mappingAction = "CREATE"
    }
    products.push({
      normalizedName, sourceName: fact.sourceName, globalProductId: Number(product.id),
      organizationInventoryId: Number(inventory.id), productCode: String(product.product_code), unit: String(product.unit || "unit"), mappingAction,
    })
  }
  if (products.length !== productFacts.size) issues.push(`Resolved ${products.length}/${productFacts.size} products`)
  const productPlanByName = new Map(products.map((product) => [product.normalizedName, product]))

  const dbUserById = new Map(dbUsers.map((user) => [String(user.id), user]))
  const mappingByKey = new Map<string, Row>()
  for (const mapping of dbUserMappings) {
    const branch = dbBranches.find((item) => Number(item.id) === Number(mapping.branch_id))
    const user = dbUserById.get(String(mapping.user_id))
    if (!branch || !user || Number(user.organization_id) !== ORGANIZATION.id || Number(user.branch_id) !== Number(mapping.branch_id)
      || user.role_name !== "ORDER_PORTAL" || user.deleted_at != null) {
      issues.push(`Legacy user mapping ${mapping.legacy_order_taker_id}/${mapping.branch_id} is invalid`)
      continue
    }
    mappingByKey.set(`${Number(mapping.branch_id)}:${Number(mapping.legacy_order_taker_id)}`, mapping)
  }
  const activeUsers = dbUsers.filter((user) => user.is_active && user.deleted_at == null && user.role_name === "ORDER_PORTAL")
  const usernameSet = new Set(allUsernames.map((user) => normalizeLegacyText(user.username)))
  const userFacts = new Map<string, { locationId: number; takerId: number; sourceNames: Set<string>; orderIds: number[] }>()
  for (const order of source.prepared) {
    const key = userKey(order.legacyLocationId, order.legacyOrderTakerId)
    const fact = userFacts.get(key) ?? { locationId: order.legacyLocationId, takerId: order.legacyOrderTakerId, sourceNames: new Set(), orderIds: [] }
    fact.sourceNames.add(order.userName)
    fact.orderIds.push(order.legacyOrderId)
    userFacts.set(key, fact)
  }
  const users: UserPlan[] = []
  for (const [key, fact] of [...userFacts].sort(([a], [b]) => a.localeCompare(b))) {
    const branch = branchByKey.get(branchKey(fact.locationId))
    if (!branch) continue
    if (fact.sourceNames.size !== 1) {
      issues.push(`Legacy user ${key} has conflicting names: ${[...fact.sourceNames].join(", ")}`)
      continue
    }
    const sourceName = [...fact.sourceNames][0]
    const ledger = branch.id == null ? undefined : mappingByKey.get(`${branch.id}:${fact.takerId}`)
    if (ledger) {
      users.push({ key, legacyLocationId: fact.locationId, legacyOrderTakerId: fact.takerId, branchKey: branch.key,
        sourceName, action: "LEDGER", userId: String(ledger.user_id), username: null, email: null, mappingAction: "NONE", orderIds: fact.orderIds.sort((a, b) => a - b) })
      continue
    }
    const candidates = branch.id == null ? [] : activeUsers.filter((user) => {
      if (Number(user.branch_id) !== branch.id) return false
      const names = new Set([
        normalizeLegacyText(user.full_name),
        normalizeLegacyText(`${user.first_name ?? ""} ${user.last_name ?? ""}`),
        normalizeLegacyText(user.first_name),
      ].filter(Boolean))
      return names.has(normalizeLegacyText(sourceName))
    })
    const uniqueCandidates = [...new Map(candidates.map((user) => [String(user.id), user])).values()]
    if (uniqueCandidates.length > 1) {
      issues.push(`Legacy user ${key} / ${sourceName} matched ${uniqueCandidates.length} active users`)
      continue
    }
    if (uniqueCandidates.length === 1) {
      users.push({ key, legacyLocationId: fact.locationId, legacyOrderTakerId: fact.takerId, branchKey: branch.key,
        sourceName, action: "EXACT", userId: String(uniqueCandidates[0].id), username: String(uniqueCandidates[0].username ?? ""), email: null,
        mappingAction: "CREATE", orderIds: fact.orderIds.sort((a, b) => a - b) })
      continue
    }
    const username = `legacy_ke_loc${fact.locationId}_user${fact.takerId}`
    if (usernameSet.has(normalizeLegacyText(username))) {
      issues.push(`Historical username collision: ${username}`)
      continue
    }
    usernameSet.add(normalizeLegacyText(username))
    users.push({ key, legacyLocationId: fact.locationId, legacyOrderTakerId: fact.takerId, branchKey: branch.key,
      sourceName, action: "HISTORICAL", userId: null, username, email: `${username}@historical.invalid`, mappingAction: "CREATE",
      orderIds: fact.orderIds.sort((a, b) => a - b) })
  }
  if (users.length !== userFacts.size) issues.push(`Resolved ${users.length}/${userFacts.size} legacy user/branch pairs`)
  const userPlanByKey = new Map(users.map((user) => [user.key, user]))

  // These orders already consumed stock in the legacy system. Branch catalogue
  // assignments are not required by delivery progression or fulfilment, so the
  // migration deliberately leaves branch_inventory untouched as well as stock.
  const branchInventory = new Map<string, BranchInventoryPlan>()

  const holds = new Map<string, number>()
  for (const order of source.prepared.filter((item) => item.status === "APPROVED")) {
    const key = budgetKey(branchKey(order.legacyLocationId), order.period)
    holds.set(key, (holds.get(key) ?? 0) + order.totalCents)
  }
  const existingBudgetByKey = new Map<string, Row>()
  for (const budget of dbBudgets) {
    const branch = branches.find((item) => item.id === Number(budget.branch_id))
    if (branch) existingBudgetByKey.set(budgetKey(branch.key, String(budget.period)), budget)
  }
  const allBudgetKeys = new Set([...sourceBudgetByKey.keys(), ...holds.keys()])
  const budgets: BudgetPlan[] = []
  for (const key of [...allBudgetKeys].sort()) {
    const separator = key.lastIndexOf("|")
    const bKey = key.slice(0, separator)
    const period = key.slice(separator + 1)
    const sourceBudget = sourceBudgetByKey.get(key)
    const existing = existingBudgetByKey.get(key)
    const holdDeltaCents = holds.get(key) ?? 0
    if (!existing && !sourceBudget) {
      issues.push(`${key}: approved orders need a budget, but neither DB nor attachment has one`)
      continue
    }
    const allocatedCents = existing
      ? integer(existing.amount_allocated_cents, `${key} allocated`)
      : sourceBudget!.values.allocatedCents
    const creditedCents = existing
      ? integer(existing.amount_credited_cents, `${key} credited`)
      : sourceBudget!.values.creditedCents
    const spentCents = existing ? integer(existing.amount_spent_cents, `${key} spent`) : 0
    const heldCents = existing ? integer(existing.amount_held_cents, `${key} held`) : 0
    if (existing && sourceBudget && (allocatedCents !== sourceBudget.values.allocatedCents || creditedCents !== sourceBudget.values.creditedCents)) {
      issues.push(`${key}: existing allocation/credit differs from the attached budget source`)
    }
    if (holdDeltaCents > 0 && sourceBudget && sourceBudget.values.sourceUsedCents !== holdDeltaCents) {
      issues.push(`${key}: source UsedBudget ${sourceBudget.values.sourceUsedCents} does not equal approved-order hold ${holdDeltaCents}`)
    }
    if (allocatedCents + creditedCents - spentCents - heldCents < holdDeltaCents) {
      issues.push(`${key}: insufficient available money budget for hold ${holdDeltaCents}`)
    }
    budgets.push({
      key, branchKey: bKey, period, action: existing ? "EXISTING" : "INSERT", budgetId: existing ? Number(existing.id) : null,
      allocatedCents, creditedCents, currentSpentCents: spentCents, currentHeldCents: heldCents, holdDeltaCents,
      sourceLocation: sourceBudget?.row.Location ?? null, sourceUsedCents: sourceBudget?.values.sourceUsedCents ?? null,
      sourceRemainingCents: sourceBudget?.values.remainingCents ?? null,
    })
  }
  if (budgets.filter((budget) => budget.action === "INSERT").length !== 24) {
    issues.push(`Expected 24 new attached budget rows, planned ${budgets.filter((budget) => budget.action === "INSERT").length}`)
  }

  const orders: OrderPlan[] = source.prepared.map((order) => ({
    legacyOrderId: order.legacyOrderId,
    branchKey: branchKey(order.legacyLocationId),
    userKey: userKey(order.legacyLocationId, order.legacyOrderTakerId),
    status: order.status,
    fulfillmentStatus: order.fulfillmentStatus,
    totalCents: order.totalCents,
    sourceChecksum: order.sourceChecksum,
  }))
  for (const order of orders) {
    if (!branchByKey.has(order.branchKey)) issues.push(`Order ${order.legacyOrderId}: unresolved branch plan`)
    if (!userPlanByKey.has(order.userKey)) issues.push(`Order ${order.legacyOrderId}: unresolved user plan`)
  }

  const counts = {
    orders: orders.length,
    approved: orders.filter((order) => order.status === "APPROVED").length,
    fulfilled: orders.filter((order) => order.status === "FULFILLED").length,
    orderItems: source.prepared.reduce((sum, order) => sum + order.lines.length, 0),
    branchesCreated: branches.filter((branch) => branch.action === "CREATE").length,
    branchIdentitiesAttached: branches.filter((branch) => branch.externalIdentityAction === "ATTACH").length,
    branchGroupsAssigned: branches.filter((branch) => branch.groupAction === "ASSIGN").length,
    branchBaselinesChanged: branches.filter((branch) => branch.currentBaselineCents !== branch.targetBaselineCents).length,
    historicalUsersCreated: users.filter((user) => user.action === "HISTORICAL").length,
    userMappingsCreated: users.filter((user) => user.mappingAction === "CREATE").length,
    productMappingsCreated: products.filter((product) => product.mappingAction === "CREATE").length,
    branchInventoryAssignmentsCreated: branchInventory.size,
    budgetRowsInserted: budgets.filter((budget) => budget.action === "INSERT").length,
    budgetRowsHeld: budgets.filter((budget) => budget.holdDeltaCents > 0).length,
  }
  const totalsCents = {
    orders: orders.reduce((sum, order) => sum + order.totalCents, 0),
    approvedHeld: orders.filter((order) => order.status === "APPROVED").reduce((sum, order) => sum + order.totalCents, 0),
    fulfilled: orders.filter((order) => order.status === "FULFILLED").reduce((sum, order) => sum + order.totalCents, 0),
    sourceBudgetAllocationsInserted: budgets.filter((budget) => budget.action === "INSERT").reduce((sum, budget) => sum + budget.allocatedCents, 0),
    sourceBudgetCreditsInserted: budgets.filter((budget) => budget.action === "INSERT").reduce((sum, budget) => sum + budget.creditedCents, 0),
  }
  if (counts.orders !== KE_POST_CUTOFF_EXPECTED.importable || counts.approved !== KE_POST_CUTOFF_EXPECTED.approved
    || counts.fulfilled !== KE_POST_CUTOFF_EXPECTED.fulfilled || totalsCents.orders !== KE_POST_CUTOFF_EXPECTED.totalCents
    || totalsCents.approvedHeld !== KE_POST_CUTOFF_EXPECTED.approvedTotalCents) {
    issues.push("Prepared order counts/totals no longer equal the approved migration policy")
  }
  const digestInput = {
    sourceDigest: source.digest,
    branches,
    products,
    users,
    budgets,
    branchInventory: [...branchInventory.values()].sort((a, b) => `${a.branchKey}:${a.organizationInventoryId}`.localeCompare(`${b.branchKey}:${b.organizationInventoryId}`)),
    orders,
    counts,
    totalsCents,
  }
  const planDigest = sha256(canonicalJson(digestInput))
  return {
    sourceDigest: source.digest,
    planDigest,
    blockingIssues: [...new Set(issues)],
    branches,
    products,
    users,
    budgets,
    branchInventory: digestInput.branchInventory,
    orders,
    counts,
    totalsCents,
    stateEvidence: { protectedState: protectedState[0], schemaState: schemaState[0], existingKeBranches: dbBranches.length, existingImports: dbImports.length },
  }
}

function planReport(source: LoadedSource, plan: MigrationPlan, mode: string, result?: Row) {
  return {
    generatedAt: new Date().toISOString(),
    mode,
    organization: ORGANIZATION,
    sourceManifestDigest: source.digest,
    planDigest: plan.planDigest,
    blockingIssueCount: plan.blockingIssues.length,
    blockingIssues: plan.blockingIssues,
    counts: plan.counts,
    totalsCents: plan.totalsCents,
    sourcePolicies: source.manifest.policies,
    branchPlan: plan.branches,
    budgetPlan: plan.budgets,
    userPlan: plan.users,
    productPlan: plan.products,
    branchInventoryPlan: plan.branchInventory,
    orderPlan: plan.orders,
    stateEvidence: plan.stateEvidence,
    result,
    requiredCommitArguments: {
      actorUserId: "<active K-Electric SUPER_ADMIN UUID>",
      confirmOrganization: ORGANIZATION_CONFIRMATION,
      confirmSource: source.digest,
      confirmPlan: plan.planDigest,
      expectedOrders: plan.counts.orders,
      expectedApproved: plan.counts.approved,
      expectedBudgetInserts: plan.counts.budgetRowsInserted,
      expectedHistoricalUsers: plan.counts.historicalUsersCreated,
      flags: ["--allow-create-johar-technical", "--allow-branch-identity-updates", "--allow-historical-users"],
    },
  }
}

async function applyPlan(
  client: PoolClient,
  source: LoadedSource,
  plan: MigrationPlan,
  actorUserId: string,
  tokenByOrder: Map<number, { plain: string; hash: string }>,
  passwordHashByUser: Map<string, string>,
): Promise<Row> {
  const before = (await rows(client, `select
    (select coalesce(sum(amount_allocated_cents),0)::text from budgets where organization_id=$1) as allocated,
    (select coalesce(sum(amount_credited_cents),0)::text from budgets where organization_id=$1) as credited,
    (select coalesce(sum(amount_spent_cents),0)::text from budgets where organization_id=$1) as spent,
    (select coalesce(sum(amount_held_cents),0)::text from budgets where organization_id=$1) as held,
    (select coalesce(sum(stock_quantity),0)::text from global_products where deleted_at is null) as global_stock,
    (select coalesce(sum(held_quantity),0)::text from product_quantity_budgets where organization_id=$1) as quantity_held,
    (select coalesce(sum(used_quantity),0)::text from product_quantity_budgets where organization_id=$1) as quantity_used,
    (select last_value::text from invoice_sequences where organization_id=$1) as invoice_sequence`, [ORGANIZATION.id]))[0]

  const [batch] = await rows(client, `insert into legacy_import_batches
    (organization_id,source_system,source_manifest,status,counts,imported_by_user_id)
    values ($1,$2,$3::jsonb,'RUNNING','{}'::jsonb,$4) returning id`, [
    ORGANIZATION.id, KE_POST_CUTOFF_SOURCE,
    JSON.stringify({ sourceDigest: source.digest, planDigest: plan.planDigest, files: source.manifest.files, policies: source.manifest.policies }),
    actorUserId,
  ])
  assert(batch?.id, "Failed to create migration batch")
  const branchIdByKey = new Map<string, number>()
  for (const branch of plan.branches) {
    let id = branch.id
    if (branch.action === "CREATE") {
      const [created] = await rows(client, `insert into branches
        (organization_id,name,province,city,address,code,external_source,external_id,status,group_id,baseline_budget_cents)
        values ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10) returning id`, [
        ORGANIZATION.id, NEW_BRANCH.name, NEW_BRANCH.province, NEW_BRANCH.city, NEW_BRANCH.address,
        branch.code, KE_POST_CUTOFF_SOURCE, String(branch.legacyLocationId), branch.groupId, branch.targetBaselineCents,
      ])
      id = Number(created.id)
      await client.query(`insert into audit_logs(user_id,organization_id,branch_id,action,entity,entity_id,metadata)
        values($1,$2,$3,'MIGRATION_BRANCH_CREATED','branch',$4,$5::jsonb)`, [actorUserId, ORGANIZATION.id, id, String(id), JSON.stringify({ batchId: batch.id, legacyLocationId: branch.legacyLocationId, name: NEW_BRANCH.name, address: NEW_BRANCH.address })])
    } else {
      assert(id, `Missing existing branch ID for ${branch.key}`)
      if (branch.externalIdentityAction === "ATTACH") {
        const updated = await rows(client, `update branches set external_source=$1,external_id=$2,updated_at=now()
          where id=$3 and organization_id=$4 and external_source is null and external_id is null returning id`,
        [KE_POST_CUTOFF_SOURCE, String(branch.legacyLocationId), id, ORGANIZATION.id])
        assert(updated.length === 1, `Could not attach branch identity ${branch.key}`)
      }
      if (branch.groupAction === "ASSIGN" || branch.currentBaselineCents !== branch.targetBaselineCents) {
        const updated = await rows(client, `update branches set
          group_id=case when group_id is null then $1 else group_id end,
          baseline_budget_cents=$2,updated_at=now()
          where id=$3 and organization_id=$4 and (group_id is null or group_id=$1) returning id`,
        [branch.groupId, branch.targetBaselineCents, id, ORGANIZATION.id])
        assert(updated.length === 1, `Could not update group/baseline for ${branch.key}`)
      }
      if (branch.externalIdentityAction === "ATTACH" || branch.groupAction === "ASSIGN" || branch.currentBaselineCents !== branch.targetBaselineCents) {
        await client.query(`insert into audit_logs(user_id,organization_id,branch_id,action,entity,entity_id,metadata)
          values($1,$2,$3,'MIGRATION_BRANCH_RECONCILED','branch',$4,$5::jsonb)`, [actorUserId, ORGANIZATION.id, id, String(id),
          JSON.stringify({ batchId: batch.id, legacyLocationId: branch.legacyLocationId, externalIdentityAction: branch.externalIdentityAction,
            groupAction: branch.groupAction, baselineBefore: branch.currentBaselineCents, baselineAfter: branch.targetBaselineCents })])
      }
    }
    assert(id && Number.isSafeInteger(id), `Failed to resolve committed branch ID for ${branch.key}`)
    branchIdByKey.set(branch.key, id)
  }

  const [orderPortalRole] = await rows(client, "select id from roles where name='ORDER_PORTAL'")
  assert(orderPortalRole, "ORDER_PORTAL role is missing")
  const userIdByKey = new Map<string, string>()
  for (const user of plan.users) {
    const branchId = branchIdByKey.get(user.branchKey)!
    let userId = user.userId
    if (user.action === "HISTORICAL") {
      const [created] = await rows(client, `insert into users
        (email,username,password_hash,role_id,is_active,full_name,first_name,last_name,employee_id,
         organization_id,branch_id,mfa_enabled,must_change_password,session_version)
        values($1,$2,$3,$4,false,$5,$5,null,$6,$7,$8,false,true,1) returning id`, [
        user.email, user.username, passwordHashByUser.get(user.key), orderPortalRole.id, user.sourceName,
        `LEGACY-${user.legacyLocationId}-${user.legacyOrderTakerId}`, ORGANIZATION.id, branchId,
      ])
      userId = String(created.id)
    }
    assert(userId, `No committed user ID for ${user.key}`)
    userIdByKey.set(user.key, userId)
    if (user.mappingAction === "CREATE") {
      await client.query(`insert into legacy_user_mappings
        (organization_id,source_system,legacy_order_taker_id,branch_id,source_name,user_id,is_synthetic,created_by_batch_id)
        values($1,$2,$3,$4,$5,$6,$7,$8)`, [
        ORGANIZATION.id, KE_POST_CUTOFF_SOURCE, user.legacyOrderTakerId, branchId, user.sourceName, userId,
        user.action === "HISTORICAL", batch.id,
      ])
    }
  }

  for (const product of plan.products.filter((item) => item.mappingAction === "CREATE")) {
    await client.query(`insert into legacy_product_mappings
      (organization_id,source_system,normalized_name,source_name,source_codes,global_product_id,organization_inventory_id)
      values($1,$2,$3,$4,'[]'::jsonb,$5,$6)`, [ORGANIZATION.id, KE_POST_CUTOFF_SOURCE, product.normalizedName,
      product.sourceName, product.globalProductId, product.organizationInventoryId])
  }
  for (const assignment of plan.branchInventory) {
    await client.query(`insert into branch_inventory
      (branch_id,organization_id,organization_inventory_id,assigned_by_user_id,is_visible,is_active)
      values($1,$2,$3,$4,false,false)`, [branchIdByKey.get(assignment.branchKey), ORGANIZATION.id,
      assignment.organizationInventoryId, actorUserId])
  }

  for (const budget of plan.budgets) {
    const branchId = branchIdByKey.get(budget.branchKey)!
    if (budget.action === "INSERT") {
      await client.query(`insert into budgets
        (organization_id,branch_id,period,amount_allocated_cents,amount_spent_cents,amount_held_cents,amount_credited_cents)
        values($1,$2,$3,$4,0,$5,$6)`, [ORGANIZATION.id, branchId, budget.period, budget.allocatedCents,
        budget.holdDeltaCents, budget.creditedCents])
    } else if (budget.holdDeltaCents > 0) {
      const updated = await rows(client, `update budgets set amount_held_cents=amount_held_cents+$1,updated_at=now()
        where id=$2 and organization_id=$3 and branch_id=$4
          and amount_allocated_cents+amount_credited_cents-amount_spent_cents-amount_held_cents >= $1
        returning id`, [budget.holdDeltaCents, budget.budgetId, ORGANIZATION.id, branchId])
      assert(updated.length === 1, `Budget hold concurrency gate failed for ${budget.key}`)
    }
  }

  const preparedById = new Map(source.prepared.map((order) => [order.legacyOrderId, order]))
  const productByName = new Map(plan.products.map((product) => [product.normalizedName, product]))
  const branchByKey = new Map(plan.branches.map((branch) => [branch.key, branch]))
  const tokenCreatedAt = new Date().toISOString()
  const orderInsertRows = plan.orders.map((orderPlan) => {
    const order = preparedById.get(orderPlan.legacyOrderId)!
    const branch = branchByKey.get(orderPlan.branchKey)!
    const token = tokenByOrder.get(order.legacyOrderId)
    const isApproved = order.status === "APPROVED"
    return {
      tid: `KE-LEGACY-${order.legacyOrderId}`,
      organization_id: ORGANIZATION.id,
      branch_id: branchIdByKey.get(orderPlan.branchKey),
      status: order.status,
      fulfillment_status: order.fulfillmentStatus,
      subtotal_cents: order.subtotalCents,
      tax_cents: order.taxCents,
      total_cents: order.totalCents,
      notes: `Legacy K-Electric migration; source order ${order.legacyOrderId}; source status ${order.sourceStatus}`,
      created_by_user_id: userIdByKey.get(orderPlan.userKey),
      created_at: order.createdAt.toISOString(),
      delivered_at: isApproved ? null : order.sourceUpdatedAt.toISOString(),
      fulfilled_at: isApproved ? null : order.sourceUpdatedAt.toISOString(),
      updated_at: order.sourceUpdatedAt.toISOString(),
      approved_by_user_id: isApproved ? actorUserId : null,
      approved_at: isApproved ? order.sourceUpdatedAt.toISOString() : null,
      approval_token: token?.plain ?? null,
      approval_token_hash: token?.hash ?? null,
      approval_token_created_at: isApproved ? tokenCreatedAt : null,
      receipt_data: receipt(order, branch, productByName),
    }
  })
  const createdOrders = await rows(client, `insert into orders (
    tid,organization_id,branch_id,status,fulfillment_status,payment_status,
    subtotal_cents,tax_cents,total_cents,notes,created_by_user_id,created_at,
    delivered_at,fulfilled_at,updated_at,approved_by_user_id,approved_at,
    approval_token,approval_token_hash,approval_token_created_at,receipt_data
  ) select
    x.tid,x.organization_id,x.branch_id,x.status,x.fulfillment_status,'UNPAID',
    x.subtotal_cents,x.tax_cents,x.total_cents,x.notes,x.created_by_user_id,x.created_at,
    x.delivered_at,x.fulfilled_at,x.updated_at,x.approved_by_user_id,x.approved_at,
    x.approval_token,x.approval_token_hash,x.approval_token_created_at,x.receipt_data
  from jsonb_to_recordset($1::jsonb) as x(
    tid text,organization_id integer,branch_id integer,status text,fulfillment_status text,
    subtotal_cents bigint,tax_cents bigint,total_cents bigint,notes text,created_by_user_id uuid,
    created_at timestamptz,delivered_at timestamptz,fulfilled_at timestamptz,updated_at timestamptz,
    approved_by_user_id uuid,approved_at timestamptz,approval_token text,approval_token_hash text,
    approval_token_created_at timestamptz,receipt_data jsonb
  ) returning id,tid`, [JSON.stringify(orderInsertRows)])
  const orderIdByLegacy = new Map<number, number>()
  for (const created of createdOrders) {
    const legacyOrderId = Number(String(created.tid).replace(/^KE-LEGACY-/, ""))
    assert(Number.isSafeInteger(legacyOrderId), `Unexpected inserted order TID ${created.tid}`)
    orderIdByLegacy.set(legacyOrderId, Number(created.id))
  }
  assert(orderIdByLegacy.size === plan.orders.length, "Bulk order insert count mismatch")

  const itemInsertRows = plan.orders.flatMap((orderPlan) => {
    const order = preparedById.get(orderPlan.legacyOrderId)!
    return order.lines.map((line) => {
      const product = productByName.get(line.normalizedName)!
      return {
        organization_id: ORGANIZATION.id,
        organization_inventory_id: product.organizationInventoryId,
        order_id: orderIdByLegacy.get(order.legacyOrderId),
        global_product_id: product.globalProductId,
        product_name: line.sourceName,
        product_code: product.productCode,
        unit: product.unit,
        quantity: line.quantity,
        price_cents: line.priceCents,
        created_at: order.createdAt.toISOString(),
      }
    })
  })
  for (const chunk of chunksOf(itemInsertRows, 500)) {
    await client.query(`insert into order_items
      (organization_id,organization_inventory_id,order_id,global_product_id,product_name,product_code,unit,quantity,price_cents,created_at)
      select x.organization_id,x.organization_inventory_id,x.order_id,x.global_product_id,x.product_name,x.product_code,x.unit,x.quantity,x.price_cents,x.created_at
      from jsonb_to_recordset($1::jsonb) as x(
        organization_id integer,organization_inventory_id integer,order_id integer,global_product_id integer,
        product_name text,product_code text,unit text,quantity numeric,price_cents bigint,created_at timestamptz
      )`, [JSON.stringify(chunk)])
  }

  const legacyImportRows = plan.orders.map((orderPlan) => {
    const order = preparedById.get(orderPlan.legacyOrderId)!
    const isApproved = order.status === "APPROVED"
    return {
      batch_id: batch.id,
      organization_id: ORGANIZATION.id,
      source_system: KE_POST_CUTOFF_SOURCE,
      legacy_order_id: order.legacyOrderId,
      order_id: orderIdByLegacy.get(order.legacyOrderId),
      source_checksum: order.sourceChecksum,
      source_payload: {
        sourceHeader: order.sourceHeader,
        legacyStatus: { statusId: order.sourceHeader.StatusID, deliveryStatus: order.sourceHeader.DeliveryStatus, text: order.sourceStatus },
        migrationPolicy: { targetStatus: order.status, targetFulfillmentStatus: order.fulfillmentStatus,
          checkoutPolicy: order.checkoutPolicy, omittedZeroValueLines: order.omittedZeroValueLines,
          approvalProvenance: isApproved ? "MIGRATION_ACTOR_WITH_LEGACY_LAST_UPDATE_TIMESTAMP" : null,
          stockChanged: false, quantityBudgetsChanged: false },
      },
    }
  })
  await client.query(`insert into legacy_order_imports
    (batch_id,organization_id,source_system,legacy_order_id,order_id,source_checksum,source_payload)
    select x.batch_id,x.organization_id,x.source_system,x.legacy_order_id,x.order_id,x.source_checksum,x.source_payload
    from jsonb_to_recordset($1::jsonb) as x(
      batch_id uuid,organization_id integer,source_system text,legacy_order_id integer,order_id integer,
      source_checksum text,source_payload jsonb
    )`, [JSON.stringify(legacyImportRows)])

  const orderAuditRows = plan.orders.map((orderPlan) => {
    const order = preparedById.get(orderPlan.legacyOrderId)!
    const orderId = orderIdByLegacy.get(order.legacyOrderId)!
    const isApproved = order.status === "APPROVED"
    return {
      user_id: actorUserId,
      organization_id: ORGANIZATION.id,
      branch_id: branchIdByKey.get(orderPlan.branchKey),
      action: isApproved ? "MIGRATION_ORDER_APPROVED" : "MIGRATION_ORDER_FULFILLED",
      entity: "order",
      entity_id: String(orderId),
      metadata: {
        batchId: batch.id, legacyOrderId: order.legacyOrderId, tid: `KE-LEGACY-${order.legacyOrderId}`,
        legacyStatus: order.sourceStatus, targetStatus: order.status, fulfillmentStatus: order.fulfillmentStatus,
        budgetHoldCents: isApproved ? order.totalCents : 0, approvalTokenCreated: isApproved,
        checkoutPolicy: order.checkoutPolicy,
      },
    }
  })
  await client.query(`insert into audit_logs(user_id,organization_id,branch_id,action,entity,entity_id,metadata)
    select x.user_id,x.organization_id,x.branch_id,x.action,x.entity,x.entity_id,x.metadata
    from jsonb_to_recordset($1::jsonb) as x(
      user_id uuid,organization_id integer,branch_id integer,action text,entity text,entity_id text,metadata jsonb
    )`, [JSON.stringify(orderAuditRows)])

  await client.query(`insert into audit_logs(user_id,organization_id,action,entity,entity_id,metadata)
    values($1,$2,'KE_POST_CUTOFF_ORDER_IMPORT','legacy_import_batch',$3,$4::jsonb)`, [actorUserId, ORGANIZATION.id, batch.id,
    JSON.stringify({ sourceDigest: source.digest, planDigest: plan.planDigest, counts: plan.counts, totalsCents: plan.totalsCents,
      budgetPolicy: "ALLOCATIONS_FROM_ATTACHMENT_AND_OPERATIONAL_HOLDS_ONLY", stockChanged: false, quantityBudgetsChanged: false, notificationsSent: false })])
  await client.query(`update legacy_import_batches set status='COMPLETED',counts=$1::jsonb,completed_at=now() where id=$2`,
    [JSON.stringify(plan.counts), batch.id])

  const validation = (await rows(client, `select
    count(*)::int as orders,
    count(*) filter(where o.status='APPROVED')::int as approved,
    count(*) filter(where o.status='FULFILLED')::int as fulfilled,
    coalesce(sum(o.total_cents),0)::text as total,
    count(*) filter(where o.status='APPROVED' and o.approval_token is not null and o.approval_token_hash is not null and o.approved_by_user_id=$2)::int as valid_tokens,
    count(*) filter(where o.status='FULFILLED' and o.fulfillment_status='DELIVERED' and o.approval_token is null and o.approval_token_hash is null)::int as valid_fulfilled
    from legacy_order_imports li join orders o on o.id=li.order_id
    where li.batch_id=$1 and li.organization_id=$3 and o.organization_id=$3`, [batch.id, actorUserId, ORGANIZATION.id]))[0]
  assert(Number(validation.orders) === plan.counts.orders && Number(validation.approved) === plan.counts.approved
    && Number(validation.fulfilled) === plan.counts.fulfilled && integer(validation.total, "Committed total") === plan.totalsCents.orders
    && Number(validation.valid_tokens) === plan.counts.approved && Number(validation.valid_fulfilled) === plan.counts.fulfilled,
  "Post-insert order/status/token validation failed")
  const itemValidation = (await rows(client, `select count(*)::int as items,
    coalesce(sum(round(oi.quantity*oi.price_cents)),0)::text as subtotal
    from legacy_order_imports li join order_items oi on oi.order_id=li.order_id
    where li.batch_id=$1 and li.organization_id=$2 and oi.organization_id=$2`, [batch.id, ORGANIZATION.id]))[0]
  const expectedSubtotal = source.prepared.reduce((sum, order) => sum + order.subtotalCents, 0)
  assert(Number(itemValidation.items) === plan.counts.orderItems && integer(itemValidation.subtotal, "Committed item subtotal") === expectedSubtotal,
    "Post-insert item validation failed")
  const after = (await rows(client, `select
    (select coalesce(sum(amount_allocated_cents),0)::text from budgets where organization_id=$1) as allocated,
    (select coalesce(sum(amount_credited_cents),0)::text from budgets where organization_id=$1) as credited,
    (select coalesce(sum(amount_spent_cents),0)::text from budgets where organization_id=$1) as spent,
    (select coalesce(sum(amount_held_cents),0)::text from budgets where organization_id=$1) as held,
    (select coalesce(sum(stock_quantity),0)::text from global_products where deleted_at is null) as global_stock,
    (select coalesce(sum(held_quantity),0)::text from product_quantity_budgets where organization_id=$1) as quantity_held,
    (select coalesce(sum(used_quantity),0)::text from product_quantity_budgets where organization_id=$1) as quantity_used,
    (select last_value::text from invoice_sequences where organization_id=$1) as invoice_sequence`, [ORGANIZATION.id]))[0]
  assert(integer(after.allocated, "After allocations") - integer(before.allocated, "Before allocations") === plan.totalsCents.sourceBudgetAllocationsInserted,
    "Budget allocation delta validation failed")
  assert(integer(after.credited, "After credits") - integer(before.credited, "Before credits") === plan.totalsCents.sourceBudgetCreditsInserted,
    "Budget credit delta validation failed")
  assert(integer(after.held, "After holds") - integer(before.held, "Before holds") === plan.totalsCents.approvedHeld,
    "Budget hold delta validation failed")
  assert(after.spent === before.spent, "Migration changed money-budget spending")
  assert(after.global_stock === before.global_stock, "Migration changed global stock")
  assert(after.quantity_held === before.quantity_held && after.quantity_used === before.quantity_used, "Migration changed quantity budgets")
  assert(after.invoice_sequence === before.invoice_sequence, "Migration changed invoice sequence")
  return { batchId: batch.id, validation, itemValidation, beforeOperationalLedgers: before, afterOperationalLedgers: after }
}

async function rehearseAllApprovedFulfillments(
  client: PoolClient,
  batchId: string,
  beforeOperationalLedgers: Row,
  tokenByOrder: Map<number, { plain: string; hash: string }>,
): Promise<Row> {
  for (const [legacyOrderId, token] of tokenByOrder) {
    assert(await verifyApprovalToken(token.plain, token.hash), `Order ${legacyOrderId}: generated approval token does not verify`)
  }
  const approved = await rows(client, `select o.id,o.branch_id,o.total_cents,o.created_at,li.legacy_order_id
    from legacy_order_imports li join orders o on o.id=li.order_id
    where li.batch_id=$1 and o.organization_id=$2 and o.status='APPROVED'
    order by li.legacy_order_id`, [batchId, ORGANIZATION.id])
  assert(approved.length === KE_POST_CUTOFF_EXPECTED.approved, "Fulfilment rehearsal did not find all approved orders")
  for (const order of approved) {
    const legacyOrderId = Number(order.legacy_order_id)
    const token = tokenByOrder.get(legacyOrderId)
    assert(token, `Order ${legacyOrderId}: fulfilment rehearsal token is missing`)
    const [stored] = await rows(client, "select approval_token_hash from orders where id=$1 and status='APPROVED'", [order.id])
    assert(stored && await verifyApprovalToken(token.plain, String(stored.approval_token_hash)),
      `Order ${legacyOrderId}: stored approval token hash does not verify`)
    const transitioned = await rows(client, `update orders set status='FULFILLED',fulfillment_status='DELIVERED',
      delivered_at=now(),fulfilled_at=now(),updated_at=now() where id=$1 and status='APPROVED' returning id`, [order.id])
    assert(transitioned.length === 1, `Order ${legacyOrderId}: fulfilment transition failed`)
    const period = new Date(order.created_at).toISOString().slice(0, 7)
    const moved = await rows(client, `update budgets set amount_held_cents=amount_held_cents-$1,
      amount_spent_cents=amount_spent_cents+$1,updated_at=now()
      where organization_id=$2 and branch_id=$3 and period=$4 and amount_held_cents >= $1 returning id`, [
      integer(order.total_cents, `Order ${legacyOrderId} total`), ORGANIZATION.id, Number(order.branch_id), period,
    ])
    assert(moved.length === 1, `Order ${legacyOrderId}: held-to-spent budget transition failed`)
  }
  const after = (await rows(client, `select
    (select count(*)::int from legacy_order_imports li join orders o on o.id=li.order_id
      where li.batch_id=$2 and o.status='FULFILLED' and o.fulfillment_status='DELIVERED') as fulfilled,
    (select coalesce(sum(amount_spent_cents),0)::text from budgets where organization_id=$1) as spent,
    (select coalesce(sum(amount_held_cents),0)::text from budgets where organization_id=$1) as held,
    (select coalesce(sum(stock_quantity),0)::text from global_products where deleted_at is null) as global_stock,
    (select coalesce(sum(held_quantity),0)::text from product_quantity_budgets where organization_id=$1) as quantity_held,
    (select coalesce(sum(used_quantity),0)::text from product_quantity_budgets where organization_id=$1) as quantity_used,
    (select last_value::text from invoice_sequences where organization_id=$1) as invoice_sequence`, [ORGANIZATION.id, batchId]))[0]
  assert(Number(after.fulfilled) === KE_POST_CUTOFF_EXPECTED.importable, "Fulfilment rehearsal did not deliver all imported orders")
  assert(integer(after.spent, "Rehearsal spent") - integer(beforeOperationalLedgers.spent, "Pre-import spent")
    === KE_POST_CUTOFF_EXPECTED.approvedTotalCents, "Fulfilment rehearsal spent delta is wrong")
  assert(after.held === beforeOperationalLedgers.held, "Fulfilment rehearsal did not consume exactly the imported holds")
  assert(after.global_stock === beforeOperationalLedgers.global_stock, "Fulfilment rehearsal changed stock")
  assert(after.quantity_held === beforeOperationalLedgers.quantity_held && after.quantity_used === beforeOperationalLedgers.quantity_used,
    "Fulfilment rehearsal changed quantity budgets")
  assert(after.invoice_sequence === beforeOperationalLedgers.invoice_sequence, "Fulfilment rehearsal changed invoice sequence")
  return { approvedOrdersRehearsed: approved.length, afterOperationalLedgers: after }
}

async function main() {
  const options = parseOptions()
  const source = loadSource(options.sourceRoot)
  const { pool } = await import("../lib/db-cli")
  try {
    const initialPlan = await buildPlan(pool, source)
    writeJson(options.outputPath, planReport(source, initialPlan, "PREFLIGHT"))
    console.log(JSON.stringify({
      output: options.outputPath,
      sourceDigest: source.digest,
      planDigest: initialPlan.planDigest,
      blockingIssues: initialPlan.blockingIssues.length,
      counts: initialPlan.counts,
      totalsCents: initialPlan.totalsCents,
    }, null, 2))
    if (!options.commit && !options.rollbackTest) {
      console.log("Nothing was written to the database.")
      return
    }
    assert(initialPlan.blockingIssues.length === 0, `Commit refused: ${initialPlan.blockingIssues.length} blocking issue(s)`)
    assert(options.actorUserId, "Commit requires --actor-user-id")
    assert(options.confirmOrganization === ORGANIZATION_CONFIRMATION, `Commit requires --confirm-organization=${ORGANIZATION_CONFIRMATION}`)
    assert(options.confirmSource === source.digest, "Commit source digest confirmation does not match")
    assert(options.confirmPlan === initialPlan.planDigest, "Commit plan digest confirmation does not match")
    assert(options.expectedOrders === initialPlan.counts.orders, `Commit requires --expected-orders=${initialPlan.counts.orders}`)
    assert(options.expectedApproved === initialPlan.counts.approved, `Commit requires --expected-approved=${initialPlan.counts.approved}`)
    assert(options.expectedBudgetInserts === initialPlan.counts.budgetRowsInserted, `Commit requires --expected-budget-inserts=${initialPlan.counts.budgetRowsInserted}`)
    assert(options.expectedHistoricalUsers === initialPlan.counts.historicalUsersCreated,
      `Commit requires --expected-historical-users=${initialPlan.counts.historicalUsersCreated}`)
    assert(options.allowJoharTechnical || initialPlan.counts.branchesCreated === 0, "Commit requires --allow-create-johar-technical")
    assert(options.allowBranchIdentityUpdates || initialPlan.counts.branchIdentitiesAttached === 0, "Commit requires --allow-branch-identity-updates")
    assert(options.allowHistoricalUsers || initialPlan.counts.historicalUsersCreated === 0, "Commit requires --allow-historical-users")

    const actorRows = await rows(pool, `select u.id,u.organization_id,u.is_active,u.deleted_at,r.name as role_name
      from users u join roles r on r.id=u.role_id where u.id=$1`, [options.actorUserId])
    const actor = actorRows[0]
    assert(actor && (actor.organization_id == null || Number(actor.organization_id) === ORGANIZATION.id)
      && actor.is_active && actor.deleted_at == null && actor.role_name === "SUPER_ADMIN",
    "Actor must be an active, non-deleted global or K-Electric SUPER_ADMIN")
    const tokenByOrder = new Map<number, { plain: string; hash: string }>()
    for (const order of source.prepared.filter((item) => item.status === "APPROVED")) {
      const plain = generateApprovalToken(10)
      tokenByOrder.set(order.legacyOrderId, { plain, hash: await hashApprovalToken(plain) })
    }
    const bcrypt = await import("bcryptjs")
    const passwordHashByUser = new Map<string, string>()
    for (const user of initialPlan.users.filter((item) => item.action === "HISTORICAL")) {
      passwordHashByUser.set(user.key, await bcrypt.default.hash(randomBytes(48).toString("base64url"), 12))
    }

    const client = await pool.connect()
    try {
      await client.query("begin isolation level serializable")
      await client.query("select pg_advisory_xact_lock($1,$2)", [1263482710, ORGANIZATION.id])
      await client.query("select pg_advisory_xact_lock($1,$2)", [914202607, ORGANIZATION.id])
      const lockedPlan = await buildPlan(client, source)
      assert(lockedPlan.blockingIssues.length === 0, "Locked preflight developed blocking issues")
      assert(lockedPlan.planDigest === initialPlan.planDigest, "Locked plan changed after confirmation")
      const result = await applyPlan(client, source, lockedPlan, options.actorUserId, tokenByOrder, passwordHashByUser)
      const fulfilmentRehearsal = options.rollbackTest
        ? await rehearseAllApprovedFulfillments(client, String(result.batchId), result.beforeOperationalLedgers, tokenByOrder)
        : null
      if (options.rollbackTest) await client.query("rollback")
      else await client.query("commit")
      writeJson(options.outputPath, planReport(source, lockedPlan, options.rollbackTest ? "ROLLBACK_TEST" : "COMMIT", {
        ...result,
        fulfilmentRehearsal,
        transaction: options.rollbackTest ? "ROLLED_BACK_AS_REQUESTED" : "COMMITTED",
        approvalTokens: "Stored in application order records; deliberately omitted from reports and logs",
      }))
      console.log(JSON.stringify({ transaction: options.rollbackTest ? "ROLLED_BACK_AS_REQUESTED" : "COMMITTED", batchId: result.batchId,
        orders: lockedPlan.counts.orders, approved: lockedPlan.counts.approved, heldCents: lockedPlan.totalsCents.approvedHeld }, null, 2))
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
