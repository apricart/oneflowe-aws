#!/usr/bin/env tsx
/**
 * Repairs the two K-Electric legacy branch-name collisions that differ only by
 * capitalization. Default mode is read-only. Commit mode is guarded by an
 * exact tenant identity, source evidence, a deterministic plan digest, and a
 * serializable transaction with post-mutation validation.
 *
 * Scope is fixed to organization 10 / K-Electric. No other tenant is written.
 */

import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { hash } from "bcryptjs"
import * as dotenv from "dotenv"
import { Client, type PoolClient } from "pg"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type JsonRow = Record<string, any>

const ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
const CONFIRM_ORGANIZATION = `${ORGANIZATION.id}:${ORGANIZATION.code}:${ORGANIZATION.name}`
const SOURCE_SYSTEM = "KE_LOGISTICS"
const SOURCE_LOCATIONS = {
  distributionUpper: { id: 85, name: "DISTRIBUTION STRATEGY", existingBranchId: 184 },
  distributionTitle: { id: 86, name: "Distribution Strategy", code: "0001-128" },
  societyLower: { id: 128, name: "society cluster", existingBranchId: 226 },
  societyTitle: { id: 132, name: "Society Cluster", code: "0001-129" },
} as const
const ORDERS = {
  societyLower: { legacyId: 634, liveId: 751, totalCents: 3_726_400, orderTakerId: 142 },
  societyTitle: { legacyId: 1154, liveId: 1178, totalCents: 4_959_500, orderTakerId: 116 },
} as const
const TARIQ_USERNAMES = ["103766", "103766_op"] as const
const HISTORICAL_USERNAME = "legacy_ke_226_142"
const HISTORICAL_EMAIL = `${HISTORICAL_USERNAME}@historical.invalid`

interface Options {
  commit: boolean
  confirmOrganization?: string
  confirmPlanSha256?: string
  expectedCreatedBranches?: number
  expectedMovedOrders?: number
  outputPath: string
  budgetSourcePath: string
  investigationPath: string
}

interface SourceBudgetRow {
  Location: string
  TenureFrom: string
  MonthlyBudget: number
  AdditionalBudget: number
}

interface BudgetPlan {
  branch: "societyLower" | "societyTitle" | "distributionTitle"
  period: string
  amountAllocatedCents: number
  amountCreditedCents: number
  operation: "UPDATE" | "INSERT"
  existingBudgetId?: number
  previousAllocatedCents?: number
  previousCreditedCents?: number
}

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function options(): Options {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const commit = process.argv.includes("--commit")
  const expectedBranches = arg("--expected-created-branches")
  const expectedOrders = arg("--expected-moved-orders")
  return {
    commit,
    confirmOrganization: arg("--confirm-organization"),
    confirmPlanSha256: arg("--confirm-plan-sha256"),
    expectedCreatedBranches: expectedBranches === undefined ? undefined : Number(expectedBranches),
    expectedMovedOrders: expectedOrders === undefined ? undefined : Number(expectedOrders),
    outputPath: resolve(arg("--output") ?? (commit
      ? `backups/ke-case-sensitive-branch-repair-commit-${timestamp}.json`
      : "deliverables/ke-case-sensitive-branch-repair-preflight.json")),
    budgetSourcePath: resolve(arg("--budget-source") ?? "deliverables/ke-electric-budget-source-history-through-2026-08-05.json"),
    investigationPath: resolve(arg("--investigation") ?? "updatedReports/ke-comprehensive-source-investigation-2026-08-03.json"),
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex")
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function currentKarachiPeriod(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date())
  const year = parts.find((part) => part.type === "year")?.value
  const month = parts.find((part) => part.type === "month")?.value
  assert(year && month, "Unable to determine the current Asia/Karachi period")
  return `${year}-${month}`
}

function periodFromSource(row: SourceBudgetRow): string {
  const match = /^(\d{4}-\d{2})-\d{2}/.exec(String(row.TenureFrom))
  assert(match, `Invalid source budget period: ${String(row.TenureFrom)}`)
  return match[1]
}

function periodRange(start: string, end: string): string[] {
  assert(/^\d{4}-\d{2}$/.test(start) && /^\d{4}-\d{2}$/.test(end) && start <= end, `Invalid period range ${start}..${end}`)
  const [startYear, startMonth] = start.split("-").map(Number)
  const [endYear, endMonth] = end.split("-").map(Number)
  const result: string[] = []
  for (let year = startYear, month = startMonth; year < endYear || (year === endYear && month <= endMonth);) {
    result.push(`${year}-${String(month).padStart(2, "0")}`)
    month += 1
    if (month > 12) {
      year += 1
      month -= 12
    }
  }
  return result
}

async function rows<T extends JsonRow = JsonRow>(client: PoolClient | Client, text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

function loadSourceEvidence(opts: Options): {
  budgetSha256: string
  investigationSha256: string
  budgets: SourceBudgetRow[]
  locations: Array<{ locationId: number; locationName: string }>
} {
  assert(existsSync(opts.budgetSourcePath), `Budget source not found: ${opts.budgetSourcePath}`)
  assert(existsSync(opts.investigationPath), `Investigation source not found: ${opts.investigationPath}`)
  const budgetDocument = JSON.parse(readFileSync(opts.budgetSourcePath, "utf8")) as { rows?: SourceBudgetRow[] }
  const investigation = JSON.parse(readFileSync(opts.investigationPath, "utf8")) as JsonRow
  assert(Array.isArray(budgetDocument.rows), "Budget source rows are missing")
  const locations = investigation?.perLocationModules?.inventories?.countsByLocation
  assert(Array.isArray(locations), "Source location evidence is missing")
  return {
    budgetSha256: sha256File(opts.budgetSourcePath),
    investigationSha256: sha256File(opts.investigationPath),
    budgets: budgetDocument.rows,
    locations,
  }
}

async function loadState(client: PoolClient | Client): Promise<JsonRow> {
  const [organization] = await rows(client, "select id, code, name, status from organizations where id = $1", [ORGANIZATION.id])
  const branches = await rows(client, `
    select id, organization_id, name, province, city, address, cost_center_id,
           admin_user_id, code, external_source, external_id, status, group_id,
           baseline_budget_cents, created_at, updated_at
    from branches where organization_id = $1 order by id
  `, [ORGANIZATION.id])
  const indexes = await rows(client, `
    select indexname, indexdef from pg_indexes
    where schemaname = 'public' and tablename = 'branches' order by indexname
  `)
  const constraints = await rows(client, `
    select conname from pg_constraint
    where conrelid = 'public.branches'::regclass order by conname
  `)
  const users = await rows(client, `
    select u.id, u.email, u.username, u.full_name, u.organization_id, u.branch_id,
           u.is_active, u.deleted_at, u.session_version, r.name as role_name
    from users u join roles r on r.id = u.role_id
    where u.organization_id = $1 and (u.username = any($2::text[]) or u.username = $3)
    order by u.username
  `, [ORGANIZATION.id, [...TARIQ_USERNAMES], HISTORICAL_USERNAME])
  const orders = await rows(client, `
    select o.id, o.tid, o.organization_id, o.branch_id, o.created_by_user_id,
           o.status, o.fulfillment_status, o.total_cents, o.receipt_data,
           loi.legacy_order_id, loi.source_payload,
           u.branch_id as creator_branch_id, u.organization_id as creator_organization_id
    from orders o
    join legacy_order_imports loi on loi.order_id = o.id
    join users u on u.id = o.created_by_user_id
    where o.organization_id = $1 and loi.legacy_order_id = any($2::int[])
    order by loi.legacy_order_id
  `, [ORGANIZATION.id, [ORDERS.societyLower.legacyId, ORDERS.societyTitle.legacyId]])
  const mappings = await rows(client, `
    select m.id, m.legacy_order_taker_id, m.branch_id, m.source_name, m.user_id,
           m.is_synthetic, m.created_by_batch_id,
           u.branch_id as user_branch_id, u.organization_id as user_organization_id
    from legacy_user_mappings m join users u on u.id = m.user_id
    where m.organization_id = $1 and m.source_system = $2
      and m.legacy_order_taker_id = any($3::int[])
    order by m.legacy_order_taker_id, m.branch_id
  `, [ORGANIZATION.id, SOURCE_SYSTEM, [ORDERS.societyLower.orderTakerId, ORDERS.societyTitle.orderTakerId]])
  const budgets = await rows(client, `
    select id, organization_id, branch_id, period, amount_allocated_cents,
           amount_spent_cents, amount_held_cents, amount_credited_cents
    from budgets where organization_id = $1 and branch_id = any($2::int[])
    order by branch_id, period
  `, [ORGANIZATION.id, [SOURCE_LOCATIONS.distributionUpper.existingBranchId, SOURCE_LOCATIONS.societyLower.existingBranchId]])
  const inventoryForTitleOrder = await rows(client, `
    select distinct oi.organization_inventory_id, bi.assigned_by_user_id,
           bi.is_visible, bi.is_active, bi.deleted_at
    from order_items oi
    left join branch_inventory bi
      on bi.branch_id = $1 and bi.organization_inventory_id = oi.organization_inventory_id
    where oi.organization_id = $2 and oi.order_id = $3
    order by oi.organization_inventory_id
  `, [SOURCE_LOCATIONS.societyLower.existingBranchId, ORGANIZATION.id, ORDERS.societyTitle.liveId])
  const sessionCounts = await rows(client, `
    select user_id, count(*)::int as session_count
    from sessions where user_id = any($1::uuid[]) group by user_id order by user_id
  `, [users.filter((user) => TARIQ_USERNAMES.includes(user.username as any)).map((user) => user.id)])
  const otherTenantFingerprint = (await rows(client, `
    select json_build_object(
      'branches', (select count(*)::int from branches where organization_id <> $1),
      'users', (select count(*)::int from users where organization_id <> $1),
      'orders', (select count(*)::int from orders where organization_id is distinct from $1),
      'budgets', (select count(*)::int from budgets where organization_id <> $1),
      'branchInventory', (select count(*)::int from branch_inventory where organization_id <> $1),
      'legacyMappings', (select count(*)::int from legacy_user_mappings where organization_id <> $1)
    ) as fingerprint
  `, [ORGANIZATION.id]))[0]?.fingerprint
  return {
    organization,
    branches,
    indexes,
    constraints,
    users,
    orders,
    mappings,
    budgets,
    inventoryForTitleOrder,
    sessionCounts,
    otherTenantFingerprint,
  }
}

function buildPlan(state: JsonRow, evidence: ReturnType<typeof loadSourceEvidence>): JsonRow {
  const organization = state.organization
  assert(
    organization?.id === ORGANIZATION.id
      && organization?.code === ORGANIZATION.code
      && organization?.name === ORGANIZATION.name
      && organization?.status === "active",
    `K-Electric tenant identity gate failed: ${JSON.stringify(organization)}`,
  )
  const indexNames = new Set(state.indexes.map((row: JsonRow) => row.indexname))
  const constraintNames = new Set(state.constraints.map((row: JsonRow) => row.conname))
  for (const required of [
    "branches_org_name_exact_uq",
    "branches_org_name_normalized_unmapped_uq",
    "branches_org_external_identity_uq",
  ]) assert(indexNames.has(required), `Required branch identity index is missing: ${required}`)
  assert(constraintNames.has("branches_external_identity_pair_ck"), "External branch identity constraint is missing")

  for (const expected of Object.values(SOURCE_LOCATIONS)) {
    const matches = evidence.locations.filter((row) => Number(row.locationId) === expected.id && row.locationName === expected.name)
    assert(matches.length === 1, `Source location evidence mismatch for ${expected.id}:${expected.name}`)
  }

  const branchById = new Map<number, JsonRow>(
    state.branches.map((branch: JsonRow) => [Number(branch.id), branch] as const),
  )
  const distributionUpper = branchById.get(SOURCE_LOCATIONS.distributionUpper.existingBranchId)
  const societyLower = branchById.get(SOURCE_LOCATIONS.societyLower.existingBranchId)
  assert(distributionUpper?.name === SOURCE_LOCATIONS.distributionUpper.name && distributionUpper?.code === "0001-52", "Existing uppercase Distribution branch identity changed")
  assert(societyLower?.name === SOURCE_LOCATIONS.societyLower.name && societyLower?.code === "0001-94", "Existing lowercase Society branch identity changed")
  assert(distributionUpper.external_source == null && distributionUpper.external_id == null, "Uppercase Distribution branch is already externally mapped; inspect before retrying")
  assert(societyLower.external_source == null && societyLower.external_id == null, "Lowercase Society branch is already externally mapped; inspect before retrying")
  for (const expected of [SOURCE_LOCATIONS.distributionTitle, SOURCE_LOCATIONS.societyTitle]) {
    assert(!state.branches.some((branch: JsonRow) => branch.name === expected.name), `${expected.name} already exists; inspect before retrying`)
    assert(!state.branches.some((branch: JsonRow) => branch.code === expected.code), `Branch code ${expected.code} is already used`)
  }

  const tariqUsers = state.users.filter((user: JsonRow) => TARIQ_USERNAMES.includes(user.username))
  assert(tariqUsers.length === 2, "Expected exactly the Tariq branch-admin and order-portal users")
  assert(tariqUsers.every((user: JsonRow) => user.organization_id === ORGANIZATION.id && user.branch_id === societyLower.id && user.is_active === true && user.deleted_at === null), "Tariq user tenant/branch/active state changed")
  assert(tariqUsers.some((user: JsonRow) => user.role_name === "BRANCH_ADMIN" && user.username === "103766"), "Tariq branch-admin user is missing")
  assert(tariqUsers.some((user: JsonRow) => user.role_name === "ORDER_PORTAL" && user.username === "103766_op"), "Tariq order-portal user is missing")
  assert(!state.users.some((user: JsonRow) => user.username === HISTORICAL_USERNAME), "Historical lower-Society user already exists")
  const tariqOrderPortal = tariqUsers.find((user: JsonRow) => user.username === "103766_op")!

  const lowerOrder = state.orders.find((order: JsonRow) => Number(order.legacy_order_id) === ORDERS.societyLower.legacyId)
  const titleOrder = state.orders.find((order: JsonRow) => Number(order.legacy_order_id) === ORDERS.societyTitle.legacyId)
  assert(lowerOrder?.id === ORDERS.societyLower.liveId && lowerOrder?.branch_id === societyLower.id && Number(lowerOrder?.total_cents) === ORDERS.societyLower.totalCents, "Lowercase Society order identity changed")
  assert(titleOrder?.id === ORDERS.societyTitle.liveId && titleOrder?.branch_id === societyLower.id && Number(titleOrder?.total_cents) === ORDERS.societyTitle.totalCents, "Title-case Society order identity changed")
  assert(lowerOrder?.source_payload?.sourceHeader?.LocationID === SOURCE_LOCATIONS.societyLower.id && lowerOrder?.source_payload?.sourceHeader?.LocationName === SOURCE_LOCATIONS.societyLower.name, "Legacy order 634 source identity mismatch")
  assert(titleOrder?.source_payload?.sourceHeader?.LocationID === SOURCE_LOCATIONS.societyTitle.id && titleOrder?.source_payload?.sourceHeader?.LocationName === SOURCE_LOCATIONS.societyTitle.name, "Legacy order 1154 source identity mismatch")
  assert(lowerOrder.created_by_user_id === tariqOrderPortal.id && titleOrder.created_by_user_id === tariqOrderPortal.id, "Affected order creator identity changed")
  assert(titleOrder.receipt_data?.buyerName === SOURCE_LOCATIONS.societyLower.name, "Order 1154 receipt no longer has the expected pre-repair branch snapshot")

  const mapping116 = state.mappings.find((mapping: JsonRow) => Number(mapping.legacy_order_taker_id) === ORDERS.societyTitle.orderTakerId)
  const mapping142 = state.mappings.find((mapping: JsonRow) => Number(mapping.legacy_order_taker_id) === ORDERS.societyLower.orderTakerId)
  assert(mapping116?.branch_id === societyLower.id && mapping116?.user_id === tariqOrderPortal.id, "Legacy user mapping 116 changed")
  assert(mapping142?.branch_id === societyLower.id && mapping142?.user_id === tariqOrderPortal.id, "Legacy user mapping 142 changed")

  assert(state.inventoryForTitleOrder.length > 0, "Order 1154 has no organization-inventory evidence")
  assert(state.inventoryForTitleOrder.every((row: JsonRow) => row.organization_inventory_id && row.assigned_by_user_id && row.deleted_at === null), "Order 1154 branch inventory evidence is incomplete or deleted")

  const sourceBudget = new Map<string, SourceBudgetRow>()
  for (const row of evidence.budgets) {
    if (![SOURCE_LOCATIONS.societyLower.name, SOURCE_LOCATIONS.societyTitle.name, SOURCE_LOCATIONS.distributionTitle.name].includes(row.Location as any)) continue
    const key = `${row.Location}\u0000${periodFromSource(row)}`
    assert(!sourceBudget.has(key), `Duplicate exact source budget row ${key}`)
    sourceBudget.set(key, row)
  }
  const currentPeriod = currentKarachiPeriod()
  const lowerBudgetRows = state.budgets.filter((row: JsonRow) => row.branch_id === societyLower.id)
  assert(lowerBudgetRows.length > 0, "Lowercase Society live budgets are missing")
  assert(lowerBudgetRows.every((row: JsonRow) => Number(row.amount_spent_cents) === 0 && Number(row.amount_held_cents) === 0), "Operational Society budget spend/holds changed; refusing historical split")
  const budgetPlan: BudgetPlan[] = []
  for (const live of lowerBudgetRows) {
    const source = sourceBudget.get(`${SOURCE_LOCATIONS.societyLower.name}\u0000${live.period}`)
    const titleSource = sourceBudget.get(`${SOURCE_LOCATIONS.societyTitle.name}\u0000${live.period}`)
    assert(source, `Missing lowercase Society source budget for ${live.period}`)
    assert(titleSource, `Missing title-case Society source budget for ${live.period}`)
    const expectedMergedAllocation = Math.round((Number(source.MonthlyBudget) + Number(titleSource.MonthlyBudget)) * 100)
    const expectedMergedCredit = Math.round((Number(source.AdditionalBudget) + Number(titleSource.AdditionalBudget)) * 100)
    assert(Number(live.amount_allocated_cents) === expectedMergedAllocation, `Live Society budget ${live.period} no longer equals the verified merged source allocation`)
    assert(Number(live.amount_credited_cents) === expectedMergedCredit, `Live Society budget ${live.period} no longer equals the verified merged source credit`)
    budgetPlan.push({
      branch: "societyLower",
      period: live.period,
      amountAllocatedCents: Math.round(Number(source.MonthlyBudget) * 100),
      amountCreditedCents: Math.round(Number(source.AdditionalBudget) * 100),
      operation: "UPDATE",
      existingBudgetId: Number(live.id),
      previousAllocatedCents: Number(live.amount_allocated_cents),
      previousCreditedCents: Number(live.amount_credited_cents),
    })
  }
  for (const period of periodRange("2026-06", currentPeriod)) {
    const source = sourceBudget.get(`${SOURCE_LOCATIONS.societyTitle.name}\u0000${period}`)
    assert(source, `Missing title-case Society source budget for ${period}`)
    budgetPlan.push({
      branch: "societyTitle",
      period,
      amountAllocatedCents: Math.round(Number(source.MonthlyBudget) * 100),
      amountCreditedCents: Math.round(Number(source.AdditionalBudget) * 100),
      operation: "INSERT",
    })
  }
  const distributionCurrent = sourceBudget.get(`${SOURCE_LOCATIONS.distributionTitle.name}\u0000${currentPeriod}`)
  assert(distributionCurrent, `Missing title-case Distribution source budget for ${currentPeriod}`)
  budgetPlan.push({
    branch: "distributionTitle",
    period: currentPeriod,
    amountAllocatedCents: Math.round(Number(distributionCurrent.MonthlyBudget) * 100),
    amountCreditedCents: Math.round(Number(distributionCurrent.AdditionalBudget) * 100),
    operation: "INSERT",
  })

  return {
    organization: ORGANIZATION,
    externalBranchMappings: [
      { branchId: distributionUpper.id, sourceSystem: SOURCE_SYSTEM, sourceLocationId: SOURCE_LOCATIONS.distributionUpper.id },
      { branchId: societyLower.id, sourceSystem: SOURCE_SYSTEM, sourceLocationId: SOURCE_LOCATIONS.societyLower.id },
    ],
    branchesToCreate: [
      {
        sourceLocationId: SOURCE_LOCATIONS.distributionTitle.id,
        name: SOURCE_LOCATIONS.distributionTitle.name,
        code: SOURCE_LOCATIONS.distributionTitle.code,
        cloneFromBranchId: distributionUpper.id,
        address: "Business Strategy - Distribution",
      },
      {
        sourceLocationId: SOURCE_LOCATIONS.societyTitle.id,
        name: SOURCE_LOCATIONS.societyTitle.name,
        code: SOURCE_LOCATIONS.societyTitle.code,
        cloneFromBranchId: societyLower.id,
        address: "Society Cluster",
      },
    ],
    usersToMove: tariqUsers.map((user: JsonRow) => ({ id: user.id, username: user.username, fromBranchId: societyLower.id, toSourceLocationId: SOURCE_LOCATIONS.societyTitle.id })),
    historicalUser: { username: HISTORICAL_USERNAME, branchId: societyLower.id, legacyOrderTakerId: ORDERS.societyLower.orderTakerId, active: false },
    orderRepairs: [
      { orderId: lowerOrder.id, legacyOrderId: ORDERS.societyLower.legacyId, branch: "societyLower", creator: HISTORICAL_USERNAME },
      { orderId: titleOrder.id, legacyOrderId: ORDERS.societyTitle.legacyId, branch: "societyTitle", creator: "103766_op", receiptBuyerName: SOURCE_LOCATIONS.societyTitle.name },
    ],
    userMappingRepairs: [
      { mappingId: mapping116.id, legacyOrderTakerId: ORDERS.societyTitle.orderTakerId, branch: "societyTitle", user: "103766_op", synthetic: false },
      { mappingId: mapping142.id, legacyOrderTakerId: ORDERS.societyLower.orderTakerId, branch: "societyLower", user: HISTORICAL_USERNAME, synthetic: true },
    ],
    inventoryAssignmentsToClone: state.inventoryForTitleOrder.map((row: JsonRow) => ({
      organizationInventoryId: Number(row.organization_inventory_id),
      assignedByUserId: row.assigned_by_user_id,
      isVisible: row.is_visible,
      isActive: row.is_active,
    })),
    budgetPlan,
    sessionsToRevoke: state.sessionCounts,
    sourceEvidence: {
      budgetSha256: evidence.budgetSha256,
      investigationSha256: evidence.investigationSha256,
    },
    expected: { createdBranches: 2, movedOrders: 1 },
  }
}

async function applyPlan(client: PoolClient | Client, plan: JsonRow): Promise<JsonRow> {
  const branchById = new Map<number, JsonRow>(
    (await rows(client, "select * from branches where organization_id = $1", [ORGANIZATION.id]))
      .map((branch) => [Number(branch.id), branch] as const),
  )
  const distributionUpper = branchById.get(SOURCE_LOCATIONS.distributionUpper.existingBranchId)!
  const societyLower = branchById.get(SOURCE_LOCATIONS.societyLower.existingBranchId)!

  await client.query(`
    update branches set external_source = $1, external_id = $2, updated_at = now()
    where id = $3 and organization_id = $4 and name = $5
  `, [SOURCE_SYSTEM, String(SOURCE_LOCATIONS.distributionUpper.id), distributionUpper.id, ORGANIZATION.id, SOURCE_LOCATIONS.distributionUpper.name])
  await client.query(`
    update branches set external_source = $1, external_id = $2, updated_at = now()
    where id = $3 and organization_id = $4 and name = $5
  `, [SOURCE_SYSTEM, String(SOURCE_LOCATIONS.societyLower.id), societyLower.id, ORGANIZATION.id, SOURCE_LOCATIONS.societyLower.name])

  const [distributionTitle] = await rows(client, `
    insert into branches (
      organization_id, name, province, city, address, cost_center_id, admin_user_id,
      code, external_source, external_id, status, group_id, baseline_budget_cents
    ) values ($1,$2,$3,$4,$5,$6,null,$7,$8,$9,$10,$11,$12)
    returning id, name, code, external_source, external_id
  `, [
    ORGANIZATION.id,
    SOURCE_LOCATIONS.distributionTitle.name,
    distributionUpper.province,
    distributionUpper.city,
    "Business Strategy - Distribution",
    distributionUpper.cost_center_id,
    SOURCE_LOCATIONS.distributionTitle.code,
    SOURCE_SYSTEM,
    String(SOURCE_LOCATIONS.distributionTitle.id),
    distributionUpper.status,
    distributionUpper.group_id,
    0,
  ])
  const [societyTitle] = await rows(client, `
    insert into branches (
      organization_id, name, province, city, address, cost_center_id, admin_user_id,
      code, external_source, external_id, status, group_id, baseline_budget_cents
    ) values ($1,$2,$3,$4,$5,$6,null,$7,$8,$9,$10,$11,$12)
    returning id, name, code, external_source, external_id
  `, [
    ORGANIZATION.id,
    SOURCE_LOCATIONS.societyTitle.name,
    societyLower.province,
    societyLower.city,
    "Society Cluster",
    societyLower.cost_center_id,
    SOURCE_LOCATIONS.societyTitle.code,
    SOURCE_SYSTEM,
    String(SOURCE_LOCATIONS.societyTitle.id),
    societyLower.status,
    societyLower.group_id,
    0,
  ])

  const tariqUsers = await rows(client, `
    update users
    set branch_id = $1, session_version = session_version + 1, updated_at = now()
    where organization_id = $2 and branch_id = $3 and username = any($4::text[])
    returning id, username, branch_id, session_version
  `, [societyTitle.id, ORGANIZATION.id, societyLower.id, [...TARIQ_USERNAMES]])
  assert(tariqUsers.length === 2, `Expected to move 2 Tariq users, moved ${tariqUsers.length}`)
  await client.query("delete from sessions where user_id = any($1::uuid[])", [tariqUsers.map((user) => user.id)])

  const orderPortalRole = (await rows(client, "select id from roles where name = 'ORDER_PORTAL'"))[0]
  assert(orderPortalRole, "ORDER_PORTAL role is missing")
  const historicalPasswordHash = await hash(randomBytes(48).toString("base64url"), 12)
  const [historicalUser] = await rows(client, `
    insert into users (
      email, username, password_hash, role_id, is_active, full_name, first_name,
      employee_id, organization_id, branch_id, mfa_enabled, must_change_password,
      session_version
    ) values ($1,$2,$3,$4,false,$5,$5,$6,$7,$8,false,true,1)
    returning id, username, organization_id, branch_id, is_active
  `, [
    HISTORICAL_EMAIL,
    HISTORICAL_USERNAME,
    historicalPasswordHash,
    orderPortalRole.id,
    "tariq.shan",
    `LEGACY-${ORDERS.societyLower.orderTakerId}-${societyLower.id}`,
    ORGANIZATION.id,
    societyLower.id,
  ])

  const tariqOrderPortal = tariqUsers.find((user) => user.username === "103766_op")
  assert(tariqOrderPortal, "Moved Tariq ORDER_PORTAL user is missing")
  const mapping116 = await rows(client, `
    update legacy_user_mappings
    set branch_id = $1, updated_at = now()
    where organization_id = $2 and source_system = $3
      and legacy_order_taker_id = $4 and branch_id = $5 and user_id = $6
    returning id
  `, [societyTitle.id, ORGANIZATION.id, SOURCE_SYSTEM, ORDERS.societyTitle.orderTakerId, societyLower.id, tariqOrderPortal.id])
  assert(mapping116.length === 1, "Failed to move legacy user mapping 116")
  const mapping142 = await rows(client, `
    update legacy_user_mappings
    set user_id = $1, is_synthetic = true, updated_at = now()
    where organization_id = $2 and source_system = $3
      and legacy_order_taker_id = $4 and branch_id = $5 and user_id = $6
    returning id
  `, [historicalUser.id, ORGANIZATION.id, SOURCE_SYSTEM, ORDERS.societyLower.orderTakerId, societyLower.id, tariqOrderPortal.id])
  assert(mapping142.length === 1, "Failed to remap legacy user mapping 142")

  const lowerOrderUpdate = await rows(client, `
    update orders set created_by_user_id = $1, updated_at = now()
    where id = $2 and organization_id = $3 and branch_id = $4
      and tid = $5 and created_by_user_id = $6
    returning id
  `, [historicalUser.id, ORDERS.societyLower.liveId, ORGANIZATION.id, societyLower.id, `KE-LEGACY-${ORDERS.societyLower.legacyId}`, tariqOrderPortal.id])
  assert(lowerOrderUpdate.length === 1, "Failed to repair legacy order 634 creator")
  const titleOrderUpdate = await rows(client, `
    update orders
    set branch_id = $1,
        receipt_data = jsonb_set(
          jsonb_set(receipt_data, '{buyerName}', to_jsonb($2::text), true),
          '{buyerAddress}', to_jsonb($3::text), true
        ),
        updated_at = now()
    where id = $4 and organization_id = $5 and branch_id = $6
      and tid = $7 and created_by_user_id = $8
    returning id
  `, [societyTitle.id, SOURCE_LOCATIONS.societyTitle.name, "Society Cluster", ORDERS.societyTitle.liveId, ORGANIZATION.id, societyLower.id, `KE-LEGACY-${ORDERS.societyTitle.legacyId}`, tariqOrderPortal.id])
  assert(titleOrderUpdate.length === 1, "Failed to move legacy order 1154")

  let clonedInventoryAssignments = 0
  for (const assignment of plan.inventoryAssignmentsToClone as JsonRow[]) {
    const inserted = await rows(client, `
      insert into branch_inventory (
        branch_id, organization_id, organization_inventory_id, assigned_by_user_id,
        is_visible, is_active, deleted_at
      ) values ($1,$2,$3,$4,$5,$6,null)
      on conflict (branch_id, organization_inventory_id) do nothing
      returning id
    `, [societyTitle.id, ORGANIZATION.id, assignment.organizationInventoryId, assignment.assignedByUserId, assignment.isVisible, assignment.isActive])
    clonedInventoryAssignments += inserted.length
  }
  assert(clonedInventoryAssignments === plan.inventoryAssignmentsToClone.length, "Failed to clone every Society Cluster historical inventory assignment")

  let updatedBudgets = 0
  let insertedBudgets = 0
  for (const budget of plan.budgetPlan as BudgetPlan[]) {
    const branchId = (() => {
      if (budget.branch === "societyLower") {
        return societyLower.id
      }
      if (budget.branch === "societyTitle") {
        return societyTitle.id
      }
      return distributionTitle.id
    })()
    if (budget.operation === "UPDATE") {
      const updated = await rows(client, `
        update budgets
        set amount_allocated_cents = $1, amount_credited_cents = $2, updated_at = now()
        where id = $3 and organization_id = $4 and branch_id = $5 and period = $6
          and amount_allocated_cents = $7 and amount_credited_cents = $8
          and amount_spent_cents = 0 and amount_held_cents = 0
        returning id
      `, [
        budget.amountAllocatedCents,
        budget.amountCreditedCents,
        budget.existingBudgetId,
        ORGANIZATION.id,
        branchId,
        budget.period,
        budget.previousAllocatedCents,
        budget.previousCreditedCents,
      ])
      assert(updated.length === 1, `Failed to split lowercase Society budget ${budget.period}`)
      updatedBudgets += 1
    } else {
      const inserted = await rows(client, `
        insert into budgets (
          organization_id, branch_id, period, amount_allocated_cents,
          amount_spent_cents, amount_held_cents, amount_credited_cents
        ) values ($1,$2,$3,$4,0,0,$5)
        returning id
      `, [ORGANIZATION.id, branchId, budget.period, budget.amountAllocatedCents, budget.amountCreditedCents])
      assert(inserted.length === 1, `Failed to insert ${budget.branch} budget ${budget.period}`)
      insertedBudgets += 1
    }
  }

  const [audit] = await rows(client, `
    insert into audit_logs (
      user_id, organization_id, branch_id, action, entity, entity_id, metadata
    ) values (null,$1,null,$2,$3,$4,$5::jsonb)
    returning id
  `, [
    ORGANIZATION.id,
    "KE_CASE_SENSITIVE_BRANCH_REPAIR",
    "branches",
    String(societyTitle.id),
    JSON.stringify({
      sourceSystem: SOURCE_SYSTEM,
      distributionTitleBranchId: distributionTitle.id,
      societyTitleBranchId: societyTitle.id,
      movedOrderIds: [ORDERS.societyTitle.liveId],
      remappedHistoricalCreatorOrderIds: [ORDERS.societyLower.liveId],
      updatedBudgets,
      insertedBudgets,
      clonedInventoryAssignments,
    }),
  ])

  return {
    distributionTitle,
    societyTitle,
    historicalUser: { ...historicalUser, email: HISTORICAL_EMAIL },
    movedUsers: tariqUsers,
    updatedBudgets,
    insertedBudgets,
    clonedInventoryAssignments,
    auditLogId: audit.id,
  }
}

async function validateCommittedState(client: PoolClient | Client, before: JsonRow, plan: JsonRow): Promise<JsonRow> {
  const externalBranches = await rows(client, `
    select id, name, code, external_source, external_id, organization_id
    from branches where organization_id = $1 and external_source = $2
      and external_id = any($3::text[]) order by external_id
  `, [ORGANIZATION.id, SOURCE_SYSTEM, Object.values(SOURCE_LOCATIONS).map((location) => String(location.id))])
  assert(externalBranches.length === 4, `Expected 4 externally mapped K-Electric branches, found ${externalBranches.length}`)
  for (const expected of Object.values(SOURCE_LOCATIONS)) {
    assert(externalBranches.some((branch) => branch.name === expected.name && branch.external_id === String(expected.id)), `Missing committed external branch ${expected.id}:${expected.name}`)
  }
  const societyTitle = externalBranches.find((branch) => branch.external_id === String(SOURCE_LOCATIONS.societyTitle.id))!
  const societyLower = externalBranches.find((branch) => branch.external_id === String(SOURCE_LOCATIONS.societyLower.id))!
  const orders = await rows(client, `
    select o.id, o.branch_id, o.created_by_user_id, o.receipt_data,
           u.branch_id as creator_branch_id, loi.source_payload
    from orders o join users u on u.id = o.created_by_user_id
    join legacy_order_imports loi on loi.order_id = o.id
    where o.organization_id = $1 and o.id = any($2::int[]) order by o.id
  `, [ORGANIZATION.id, [ORDERS.societyLower.liveId, ORDERS.societyTitle.liveId]])
  const lowerOrder = orders.find((order) => order.id === ORDERS.societyLower.liveId)!
  const titleOrder = orders.find((order) => order.id === ORDERS.societyTitle.liveId)!
  assert(lowerOrder.branch_id === societyLower.id && lowerOrder.creator_branch_id === societyLower.id, "Order 634 is not internally consistent after repair")
  assert(titleOrder.branch_id === societyTitle.id && titleOrder.creator_branch_id === societyTitle.id, "Order 1154 is not internally consistent after repair")
  assert(titleOrder.receipt_data?.buyerName === SOURCE_LOCATIONS.societyTitle.name && titleOrder.receipt_data?.buyerAddress === "Society Cluster", "Order 1154 receipt snapshot was not repaired")
  assert(lowerOrder.source_payload?.sourceHeader?.LocationID === SOURCE_LOCATIONS.societyLower.id, "Order 634 source ledger changed unexpectedly")
  assert(titleOrder.source_payload?.sourceHeader?.LocationID === SOURCE_LOCATIONS.societyTitle.id, "Order 1154 source ledger changed unexpectedly")

  const repairedUsers = await rows(client, `
    select u.id, u.username, u.branch_id, u.organization_id, u.is_active, r.name as role_name
    from users u join roles r on r.id = u.role_id
    where u.organization_id = $1 and u.username = any($2::text[])
    order by u.username
  `, [ORGANIZATION.id, [...TARIQ_USERNAMES, HISTORICAL_USERNAME]])
  assert(repairedUsers.length === 3, "Expected three repaired Society user identities")
  assert(repairedUsers.filter((user) => TARIQ_USERNAMES.includes(user.username as any)).every((user) => user.branch_id === societyTitle.id && user.is_active === true), "Tariq users were not moved to title-case Society Cluster")
  const historicalUser = repairedUsers.find((user) => user.username === HISTORICAL_USERNAME)
  assert(historicalUser?.branch_id === societyLower.id && historicalUser?.is_active === false && historicalUser?.role_name === "ORDER_PORTAL", "Historical lower-Society user is invalid")

  const mappingIntegrity = (await rows(client, `
    select count(*) filter (
      where m.organization_id <> $1 or b.organization_id <> $1
         or u.organization_id <> $1 or u.branch_id <> m.branch_id
    )::int as mismatches
    from legacy_user_mappings m
    join branches b on b.id = m.branch_id
    join users u on u.id = m.user_id
    where m.organization_id = $1 and m.source_system = $2
  `, [ORGANIZATION.id, SOURCE_SYSTEM]))[0]
  assert(Number(mappingIntegrity.mismatches) === 0, "K-Electric legacy user mapping integrity failed after repair")
  const orderIntegrity = (await rows(client, `
    select count(*) filter (
      where o.organization_id <> $1 or b.organization_id <> $1
         or u.organization_id <> $1 or u.branch_id <> o.branch_id
    )::int as mismatches
    from legacy_order_imports loi
    join orders o on o.id = loi.order_id
    join branches b on b.id = o.branch_id
    join users u on u.id = o.created_by_user_id
    where loi.organization_id = $1 and loi.source_system = $2
  `, [ORGANIZATION.id, SOURCE_SYSTEM]))[0]
  assert(Number(orderIntegrity.mismatches) === 0, "K-Electric legacy order tenant/branch integrity failed after repair")

  const repairedMappings = await rows(client, `
    select m.legacy_order_taker_id, m.branch_id, m.user_id, m.is_synthetic,
           u.branch_id as user_branch_id, u.username
    from legacy_user_mappings m join users u on u.id = m.user_id
    where m.organization_id = $1 and m.source_system = $2
      and m.legacy_order_taker_id = any($3::int[])
    order by m.legacy_order_taker_id
  `, [ORGANIZATION.id, SOURCE_SYSTEM, [ORDERS.societyLower.orderTakerId, ORDERS.societyTitle.orderTakerId]])
  const repaired116 = repairedMappings.find((mapping) => mapping.legacy_order_taker_id === ORDERS.societyTitle.orderTakerId)
  const repaired142 = repairedMappings.find((mapping) => mapping.legacy_order_taker_id === ORDERS.societyLower.orderTakerId)
  assert(repaired116?.branch_id === societyTitle.id && repaired116?.username === "103766_op" && repaired116?.is_synthetic === false, "Legacy user mapping 116 was not moved correctly")
  assert(repaired142?.branch_id === societyLower.id && repaired142?.username === HISTORICAL_USERNAME && repaired142?.is_synthetic === true, "Legacy user mapping 142 was not isolated correctly")

  const distributionTitle = externalBranches.find((branch) => branch.external_id === String(SOURCE_LOCATIONS.distributionTitle.id))!
  const repairedBudgets = await rows(client, `
    select branch_id, period, amount_allocated_cents, amount_credited_cents,
           amount_spent_cents, amount_held_cents
    from budgets where organization_id = $1 and branch_id = any($2::int[])
    order by branch_id, period
  `, [ORGANIZATION.id, [societyLower.id, societyTitle.id, distributionTitle.id]])
  for (const expected of plan.budgetPlan as BudgetPlan[]) {
    const branchId = (() => {
      if (expected.branch === "societyLower") {
        return societyLower.id
      }
      if (expected.branch === "societyTitle") {
        return societyTitle.id
      }
      return distributionTitle.id
    })()
    const actual = repairedBudgets.find((budget) => budget.branch_id === branchId && budget.period === expected.period)
    assert(actual, `Missing repaired budget ${expected.branch}:${expected.period}`)
    assert(Number(actual.amount_allocated_cents) === expected.amountAllocatedCents && Number(actual.amount_credited_cents) === expected.amountCreditedCents, `Repaired budget amount mismatch ${expected.branch}:${expected.period}`)
    assert(Number(actual.amount_spent_cents) === 0 && Number(actual.amount_held_cents) === 0, `Operational budget ledger changed ${expected.branch}:${expected.period}`)
  }
  const clonedInventory = await rows(client, `
    select organization_inventory_id, is_visible, is_active, deleted_at
    from branch_inventory where organization_id = $1 and branch_id = $2
    order by organization_inventory_id
  `, [ORGANIZATION.id, societyTitle.id])
  assert(clonedInventory.length === plan.inventoryAssignmentsToClone.length, "Title-case Society historical inventory assignment count mismatch")
  assert(clonedInventory.every((assignment) => assignment.deleted_at === null), "Title-case Society received a deleted inventory assignment")

  const otherTenantAfter = (await rows(client, `
    select json_build_object(
      'branches', (select count(*)::int from branches where organization_id <> $1),
      'users', (select count(*)::int from users where organization_id <> $1),
      'orders', (select count(*)::int from orders where organization_id is distinct from $1),
      'budgets', (select count(*)::int from budgets where organization_id <> $1),
      'branchInventory', (select count(*)::int from branch_inventory where organization_id <> $1),
      'legacyMappings', (select count(*)::int from legacy_user_mappings where organization_id <> $1)
    ) as fingerprint
  `, [ORGANIZATION.id]))[0]?.fingerprint
  assert(stable(otherTenantAfter) === stable(before.otherTenantFingerprint), "A non-K-Electric tenant count changed during the repair")
  return {
    externalBranches,
    orders,
    repairedUsers,
    repairedMappings,
    repairedBudgets,
    clonedInventory,
    mappingIntegrity,
    orderIntegrity,
    otherTenantFingerprint: otherTenantAfter,
  }
}

function safeSnapshot(state: JsonRow): JsonRow {
  return {
    capturedAt: new Date().toISOString(),
    organization: state.organization,
    branches: state.branches.filter((branch: JsonRow) => [184, 226].includes(Number(branch.id))),
    users: state.users.map((user: JsonRow) => ({
      id: user.id,
      email: user.email,
      username: user.username,
      fullName: user.full_name,
      organizationId: user.organization_id,
      branchId: user.branch_id,
      role: user.role_name,
      isActive: user.is_active,
      sessionVersion: user.session_version,
    })),
    orders: state.orders,
    mappings: state.mappings,
    budgets: state.budgets,
    inventoryForTitleOrder: state.inventoryForTitleOrder,
    sessionCounts: state.sessionCounts,
    otherTenantFingerprint: state.otherTenantFingerprint,
  }
}

async function main(): Promise<void> {
  const opts = options()
  assert(process.env.DATABASE_URL, "DATABASE_URL is required")
  const evidence = loadSourceEvidence(opts)
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    await client.query("BEGIN READ ONLY")
    const state = await loadState(client)
    const plan = buildPlan(state, evidence)
    await client.query("ROLLBACK")
    const planSha256 = sha256(plan)
    const preflight = {
      kind: "KE_CASE_SENSITIVE_BRANCH_REPAIR",
      mode: opts.commit ? "COMMIT_REQUESTED" : "DRY_RUN",
      generatedAt: new Date().toISOString(),
      organization: ORGANIZATION,
      planSha256,
      summary: {
        createdBranches: plan.branchesToCreate.length,
        movedOrders: 1,
        remappedHistoricalOrderCreators: 1,
        movedUsers: plan.usersToMove.length,
        updatedBudgets: (plan.budgetPlan as BudgetPlan[]).filter((row) => row.operation === "UPDATE").length,
        insertedBudgets: (plan.budgetPlan as BudgetPlan[]).filter((row) => row.operation === "INSERT").length,
        clonedInventoryAssignments: plan.inventoryAssignmentsToClone.length,
        otherTenantsWritten: 0,
      },
      requiredCommitArguments: {
        confirmOrganization: CONFIRM_ORGANIZATION,
        confirmPlanSha256: planSha256,
        expectedCreatedBranches: 2,
        expectedMovedOrders: 1,
      },
      plan,
    }
    if (!opts.commit) {
      writeJson(opts.outputPath, preflight)
      console.log(JSON.stringify({
        mode: "DRY_RUN",
        output: opts.outputPath,
        planSha256,
        summary: preflight.summary,
        requiredCommitArguments: preflight.requiredCommitArguments,
      }, null, 2))
      return
    }

    assert(opts.confirmOrganization === CONFIRM_ORGANIZATION, `--confirm-organization must equal ${CONFIRM_ORGANIZATION}`)
    assert(opts.confirmPlanSha256 === planSha256, "--confirm-plan-sha256 does not match the current live plan")
    assert(opts.expectedCreatedBranches === 2, "--expected-created-branches must equal 2")
    assert(opts.expectedMovedOrders === 1, "--expected-moved-orders must equal 1")

    const snapshotPath = resolve(`backups/ke-case-sensitive-branch-repair-pre-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
    writeJson(snapshotPath, safeSnapshot(state))

    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
    try {
      await client.query("select pg_advisory_xact_lock(hashtext('oneflowe:ke-case-sensitive-branch-repair'), $1)", [ORGANIZATION.id])
      const lockedState = await loadState(client)
      const lockedPlan = buildPlan(lockedState, evidence)
      assert(sha256(lockedPlan) === planSha256, "Live repair plan changed after the confirmation preflight")
      const commitResult = await applyPlan(client, lockedPlan)
      const validation = await validateCommittedState(client, lockedState, lockedPlan)
      await client.query("COMMIT")

      for (const user of commitResult.movedUsers) {
        try {
          const { invalidateSessionValidationCache } = await import("../lib/session-validation-cache")
          await invalidateSessionValidationCache(user.id)
        } catch {
          // sessionVersion was already incremented transactionally; cache entries
          // also carry the old tuple and cannot validate a reassigned branch.
        }
      }
      try {
        const { invalidateByPrefix } = await import("../lib/cache-utils")
        for (const prefix of ["branches", "users", "orders", "budgets"]) await invalidateByPrefix(prefix)
      } catch {
        // Database state is authoritative; normal cache TTL remains a fallback.
      }

      const report = {
        ...preflight,
        mode: "COMMITTED",
        committedAt: new Date().toISOString(),
        snapshotPath,
        commitResult,
        validation,
      }
      writeJson(opts.outputPath, report)
      console.log(JSON.stringify({
        mode: "COMMITTED",
        output: opts.outputPath,
        snapshotPath,
        planSha256,
        commitResult,
      }, null, 2))
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
