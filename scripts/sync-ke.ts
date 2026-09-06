#!/usr/bin/env tsx
/**
 * Bring K-Electric reference data across from the legacy logistics platform.
 *
 * `import-ke-orders.ts` already imports the orders themselves, but it can only
 * place an order whose branch, ordering user and products already exist. This
 * command syncs those, so run it first and the order import second:
 *
 *     npm run sync:ke                      # dry run — prints the plan, writes nothing
 *     npm run sync:ke -- --commit ...      # applies it, with the confirmations it printed
 *     npm run import:ke-orders -- ...      # then the orders
 *
 * Read-only unless `--commit` is given, and `--commit` requires every value the
 * dry run printed back. A plan that has moved since the dry run is refused
 * rather than silently applied.
 *
 * It syncs, in dependency order: the organization (only with
 * `--create-organization`), branches, groups, the catalogue, then users.
 *
 * The organization is resolved by `--organization-code` rather than compiled
 * in, so the same script serves a production run against K-Electric (10/0001)
 * and a rehearsal on a test database where that code is taken.
 *
 * What it will not do, deliberately:
 *   - touch any organization but the one whose code was given, and it refuses
 *     outright if that code belongs to a differently-named tenant. Organization
 *     2, "K-E-Demo", shares many K-Electric email addresses and must stay
 *     untouched.
 *   - change the price of a product that already exists. Legacy prices per
 *     branch and OneFlowe has no per-branch tier, so a new product takes the
 *     price most of its branches agree on and every disagreement is reported
 *     rather than applied. See `lib/legacy-import/ke-products.ts`.
 *   - delete or deactivate anything. A branch or account that legacy no longer
 *     has is reported, never removed.
 *
 * Catalogue and group creation were previously refused here because both carry
 * pricing scope. They are now in scope because the order import cannot resolve
 * a single line without them; groups are created with no price of their own, so
 * nothing a Super Admin set is overridden.
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import * as dotenv from "dotenv"

import {
  KE_SYNC_ORGANIZATION as ORGANIZATION,
  KE_SYNC_SOURCE as SOURCE_SYSTEM,
  ROLE_BRANCH_ADMIN,
  ROLE_ORDER_PORTAL,
  planBranches,
  planDigest,
  planGroups,
  planUsernameMigration,
  planUsers,
  summarize,
  type CurrentBranch,
  type CurrentGroup,
  type CurrentUser,
  type LegacyLocation,
  type LegacyLocationGroup,
  type LegacySubUser,
  type SyncPlan,
} from "../lib/legacy-import/ke-sync"
import {
  planProducts,
  summarizeProducts,
  type CurrentProductMapping,
  type LegacyCategory,
  type LegacyItem,
  type LegacyPriceHistoryRow,
  type ProductPlan,
} from "../lib/legacy-import/ke-products"
import {
  planBranchBudgets,
  summarizeBudgets,
  type BudgetPlan,
  type CurrentBudget,
} from "../lib/legacy-import/ke-budgets"
import { hashMirroredLegacyPassword } from "../lib/password-cli"
import { resolveWorkspacePath } from "./lib/resolve-workspace-path"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const BASE_URL = "https://logistics.oneflowe.com"
/** The K-Electric account id on the legacy platform; every read is scoped by it. */
const LEGACY_ACCOUNT_ID = 1
const FETCH_ATTEMPTS = 4
/**
 * The organization this run targets.
 *
 * Production is the constant K-Electric (10 / 0001). A test database has no
 * K-Electric row at all, and cannot reuse code "0001" because
 * `organizations.code` is unique and the fixture organization already holds it.
 * So the target is resolved at run time rather than compiled in, and the
 * confirmation string is derived from whatever was resolved — a confirmation
 * copied from a test run therefore cannot authorise a production commit.
 */
type TargetOrganization = { id: number; code: string; name: string }
let target: TargetOrganization = { ...ORGANIZATION }

/** Stands in for the id an organization does not have yet. */
const NEW_ORGANIZATION_ID = -1

function organizationConfirmation(org: TargetOrganization): string {
  const id = org.id === NEW_ORGANIZATION_ID ? "new" : String(org.id)
  return `${id}:${org.code}:${org.name}`
}

type Row = Record<string, any>
interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>
}

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
  commit: boolean
  rollbackTest: boolean
  actorUserId?: string
  confirmOrganization?: string
  confirmPlan?: string
  organizationCode: string
  organizationName: string
  createOrganization: boolean
  skipProducts: boolean
  outputPath: string
}

function parseOptions(): Options {
  return {
    commit: flag("commit"),
    rollbackTest: flag("rollback-test"),
    actorUserId: argument("actor-user-id"),
    confirmOrganization: argument("confirm-organization"),
    confirmPlan: argument("confirm-plan"),
    organizationCode: argument("organization-code") ?? ORGANIZATION.code,
    organizationName: argument("organization-name") ?? ORGANIZATION.name,
    createOrganization: flag("create-organization"),
    skipProducts: flag("skip-products"),
    outputPath: resolveWorkspacePath(
      argument("output") ?? `updatedReports/ke-sync-${new Date().toISOString().slice(0, 10)}.json`,
    ),
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`
  let lastError: unknown
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as T
    } catch (error) {
      lastError = error
      if (attempt < FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/**
 * The full price history, in one POST.
 *
 * Retired products live only here: the item list is what K-Electric sells now,
 * this is everything they have ever sold, and historical orders reference the
 * difference. The window is deliberately wide-open — the endpoint returns a few
 * thousand rows for the whole period, so paging it would buy nothing.
 */
async function fetchPriceHistory(): Promise<LegacyPriceHistoryRow[]> {
  const url = `${BASE_URL}/api/ProductSummary/GetSummaryItemHistory`
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          UserID: LEGACY_ACCOUNT_ID,
          LocationIDs: null,
          StartDate: "2020-01-01",
          EndDate: new Date().toISOString().slice(0, 10),
        }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as LegacyPriceHistoryRow[]
    } catch (error) {
      if (attempt === FETCH_ATTEMPTS) {
        throw new Error(
          `${url}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt))
    }
  }
  return []
}

async function rows<T extends Row = Row>(client: QueryClient, text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

async function readCurrent(client: QueryClient) {
  const branches = (await rows(client,
    `select id, name, external_source, external_id, group_id
       from branches where organization_id = $1 order by id`, [target.id]))
    .map((row): CurrentBranch => ({
      id: Number(row.id),
      name: String(row.name),
      externalSource: row.external_source ?? null,
      externalId: row.external_id ?? null,
      groupId: row.group_id == null ? null : Number(row.group_id),
    }))

  const groups = (await rows(client,
    `select id, name from groups where organization_id = $1 order by id`, [target.id]))
    .map((row): CurrentGroup => ({ id: Number(row.id), name: String(row.name) }))

  const users = (await rows(client,
    `select u.id, u.username, u.email, u.full_name, u.branch_id, u.is_active,
            u.external_source, u.external_id, r.name as role_name
       from users u join roles r on r.id = u.role_id
      where u.organization_id = $1 and u.deleted_at is null
      order by u.username`, [target.id]))
    .map((row): CurrentUser => ({
      id: String(row.id),
      username: row.username ?? null,
      email: String(row.email),
      fullName: row.full_name ?? null,
      roleName: String(row.role_name),
      branchId: row.branch_id == null ? null : Number(row.branch_id),
      isActive: Boolean(row.is_active),
      externalSource: row.external_source ?? null,
      externalId: row.external_id ?? null,
    }))

  return { branches, groups, users }
}

/**
 * Find the organization this run targets, creating it only when asked to.
 *
 * Matched on `code`, which is unique, rather than on the id: a fresh database
 * assigns ids from its own sequence and nothing guarantees K-Electric lands on
 * 10. Creation is opt-in (`--create-organization`) so a typo in the code on a
 * production run fails loudly instead of quietly starting a second, empty
 * K-Electric alongside the real one.
 */
async function resolveOrganization(
  client: QueryClient,
  options: Options,
): Promise<{ organization: TargetOrganization; created: boolean }> {
  const [existing] = await rows(client,
    `select id, code, name from organizations where code = $1`, [options.organizationCode])

  if (existing) {
    const organization = { id: Number(existing.id), code: String(existing.code), name: String(existing.name) }
    assert(
      normalizeOrgName(organization.name) === normalizeOrgName(options.organizationName),
      `Organization code ${options.organizationCode} belongs to "${organization.name}", not `
        + `"${options.organizationName}". Refusing to sync K-Electric data into another tenant.`,
    )
    return { organization, created: false }
  }

  assert(options.createOrganization,
    `No organization with code "${options.organizationCode}". Pass --create-organization to create `
      + `"${options.organizationName}", or --organization-code=<code> to target an existing one.`)

  const [created] = await rows(client,
    `insert into organizations (name, code, status) values ($1, $2, 'active') returning id, code, name`,
    [options.organizationName, options.organizationCode])
  return {
    organization: { id: Number(created.id), code: String(created.code), name: String(created.name) },
    created: true,
  }
}

function normalizeOrgName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * Legacy location id -> the OneFlowe branch pinned to it.
 *
 * Built from the branch plan's pins, which is the only trustworthy link between
 * the two systems. Branches this run is about to create are deliberately absent:
 * they have no id yet, so their budget is planned on the next run, exactly as
 * their people are.
 */
function branchPinMap(
  branches: SyncPlan["branches"],
  current: readonly CurrentBranch[],
): Map<number, { branchId: number; name: string }> {
  const nameById = new Map(current.map((branch) => [branch.id, branch.name]))
  return new Map(branches.pins.map((pin) => [
    pin.legacyLocationId,
    { branchId: pin.branchId, name: nameById.get(pin.branchId) ?? pin.currentName },
  ]))
}

/** Budget rows this organization already holds, for the periods legacy funds. */
async function readBudgets(client: QueryClient): Promise<CurrentBudget[]> {
  return (await rows(client,
    `select branch_id, period, amount_allocated_cents
       from budgets where organization_id = $1`, [target.id]))
    .map((row): CurrentBudget => ({
      branchId: Number(row.branch_id),
      period: String(row.period),
      amountAllocatedCents: Number(row.amount_allocated_cents ?? 0),
    }))
}

/** Catalogue already mapped to legacy names, with its current price for drift reporting. */
async function readProductMappings(client: QueryClient): Promise<CurrentProductMapping[]> {
  return (await rows(client,
    `select lpm.normalized_name, lpm.global_product_id, lpm.organization_inventory_id,
            gp.base_price_cents
       from legacy_product_mappings lpm
       join global_products gp on gp.id = lpm.global_product_id
      where lpm.organization_id = $1 and lpm.source_system = $2
      order by lpm.normalized_name`, [target.id, SOURCE_SYSTEM]))
    .map((row): CurrentProductMapping => ({
      normalizedName: String(row.normalized_name),
      globalProductId: Number(row.global_product_id),
      organizationInventoryId: Number(row.organization_inventory_id),
      basePriceCents: Number(row.base_price_cents ?? 0),
    }))
}

function describe(plan: SyncPlan): string[] {
  const lines: string[] = []
  const pinsNeeded = plan.branches.pins.filter((pin) => pin.needsPin)
  const renames = plan.branches.pins.filter((pin) => pin.rename)

  lines.push("BRANCHES")
  lines.push(`  pin to legacy id ....... ${pinsNeeded.length}`)
  for (const pin of renames) {
    lines.push(`  rename ................. branch ${pin.branchId} "${pin.rename!.from}" -> "${pin.rename!.to}" (legacy ${pin.legacyLocationId})`)
  }
  for (const create of plan.branches.creates) {
    lines.push(`  create ................. "${create.name}" (legacy ${create.legacyLocationId})`)
  }
  for (const branch of plan.branches.unmatched) {
    lines.push(`  no legacy counterpart .. branch ${branch.id} "${branch.name}" (left alone)`)
  }
  for (const entry of plan.branches.ambiguous) {
    lines.push(`  AMBIGUOUS .............. legacy ${entry.legacyLocationId} "${entry.legacyName}" -> branches ${entry.candidates.join(", ")}`)
  }

  lines.push("")
  lines.push("GROUPS")
  lines.push(`  branch assignments ..... ${plan.groups.assignments.length}`)
  for (const name of plan.groups.missingGroups) lines.push(`  create ................. "${name}" (no price of its own; branches keep resolving to the organization price)`)

  lines.push("")
  lines.push("USERNAMES")
  lines.push(`  move to -ba / -op ...... ${plan.usernames.renames.length}`)
  for (const collision of plan.usernames.collisions) {
    lines.push(`  COLLISION .............. "${collision.to}" wanted by ${collision.userIds.length} account(s)`)
  }

  lines.push("")
  lines.push("USERS")
  lines.push(`  already present ........ ${plan.users.alreadyPresent}`)
  for (const move of plan.users.branchMoves) {
    lines.push(`  move to right branch ... ${move.username} -> ${move.toBranchName} `
      + `(legacy assigns them there; they are on branch ${move.fromBranchId})`)
  }
  lines.push(`  stamp external identity  ${plan.users.stamps.length}`)
  lines.push(`  new people ............. ${plan.users.people.length} (${plan.users.people.length * 2} accounts)`)
  for (const person of plan.users.people) {
    lines.push(`    ${person.accounts.map((account) => account.username).join(" + ")}  ${person.email}${person.emailIsDerived ? " (derived)" : ""}  "${person.fullName}"  @ ${person.branchName}`)
  }
  for (const conflict of plan.users.conflicts) {
    lines.push(`  EMPLOYEE CODE CLASH .... ${conflict.employeeCode} is K-Electric's code for "${conflict.legacyName}"`)
    lines.push(`                           <${conflict.legacyEmail ?? "no email"}>, but OneFlowe has it on `
      + `"${conflict.heldByName}" <${conflict.heldByEmail}>`)
    lines.push(`                           -> creating "${conflict.legacyName}" as ${conflict.assignedIdentity}; sitting account untouched`)
  }
  for (const entry of plan.users.backfill) {
    lines.push(`  backfill ............... ${entry.username} (${entry.roleName}) for ${entry.email}`)
  }
  for (const skip of plan.users.skipped) {
    lines.push(`  skipped ................ legacy ${skip.legacySubUserId} [${skip.reason}] ${skip.detail}`)
  }
  return lines
}

function describeProducts(plan: ProductPlan, legacyRowCount: number): string[] {
  const counts = summarizeProducts(plan, legacyRowCount)
  const lines: string[] = ["PRODUCTS"]
  lines.push(`  legacy rows ............ ${counts.legacyRows} (one per product per location)`)
  const fromHistory = plan.creates.filter((entry) => entry.source === "price-history").length
  lines.push(`  create ................. ${counts.toCreate}`
    + (fromHistory ? `  (${counts.toCreate - fromHistory} still sold, ${fromHistory} retired, from price history)` : ""))
  lines.push(`  already mapped ......... ${counts.alreadyMapped}`)
  lines.push(`  categories to ensure ... ${plan.categories.length}`)
  for (const skip of plan.skipped) {
    lines.push(`  skipped ................ "${skip.sourceName}" [${skip.reason}] ${skip.detail}`)
  }
  for (const drift of plan.priceDrift) {
    lines.push(`  PRICE DIFFERS .......... "${drift.normalizedName}" ours ${drift.currentCents}c, `
      + `legacy ${drift.legacyModalCents}c (reported only — never overwritten)`)
  }
  if (counts.productsWithPriceOutliers > 0) {
    lines.push(`  BRANCH PRICE OUTLIERS .. ${counts.productsWithPriceOutliers} product(s), ${counts.outlierRows} legacy row(s)`)
    lines.push("                           legacy prices per branch; OneFlowe has no per-branch tier, so the")
    lines.push("                           most common price is used and these rows are listed in the report.")
  }
  return lines
}

function describeBudgets(plan: BudgetPlan): string[] {
  const counts = summarizeBudgets(plan)
  const lines: string[] = ["BUDGETS"]
  lines.push(`  funded in legacy ....... ${counts.fundedLocations}`)
  lines.push(`  create ................. ${counts.toCreate}` +
    (counts.periods.length ? `  period(s) ${counts.periods.join(", ")}` : ""))
  lines.push(`  already correct ........ ${counts.unchanged}`)
  if (counts.toCreate > 0) {
    lines.push(`  total to allocate ...... ${(counts.totalAllocatedCents / 100).toLocaleString("en-US")}`)
  }
  for (const drift of plan.drift) {
    lines.push(`  DIFFERS ................ ${drift.branchName} ${drift.period}: ours `
      + `${drift.currentCents / 100}, legacy ${drift.legacyCents / 100} (reported only — never overwritten)`)
  }
  const byReason = new Map<string, number>()
  for (const skip of plan.skipped) byReason.set(skip.reason, (byReason.get(skip.reason) ?? 0) + 1)
  for (const [reason, n] of byReason) lines.push(`  skipped ................ ${n} [${reason}]`)
  return lines
}

interface CommitResult {
  batchId: string
  counts: Record<string, number>
}

/**
 * Product code for a synced catalogue entry.
 *
 * `global_products_code_active_normalized_uq` is unique across every tenant, not
 * per organization, so the code has to be globally unique. The legacy item id
 * already is, and keeping it in the code means any row can be traced back to
 * the source without consulting `legacy_product_mappings`.
 */
function productCodeFor(legacyItemId: string): string {
  return `KE-${legacyItemId}`
}

/**
 * One digest covering everything the commit would write.
 *
 * `planDigest` only sees the reference-data plan, so a catalogue that changed
 * between the dry run and the commit would slip through a confirmation taken
 * from the earlier run. Folding the product plan and the organization's
 * existence into the same hash means any of them moving invalidates it.
 */
function combinedDigest(
  plan: SyncPlan,
  products: ProductPlan | null,
  budgets: BudgetPlan,
  organizationExists: boolean,
): string {
  return createHash("sha256")
    .update(planDigest(plan))
    .update("|org-exists:")
    .update(String(organizationExists))
    .update("|products:")
    .update(products
      ? JSON.stringify({
          creates: products.creates.map((entry) => [entry.normalizedName, entry.basePriceCents, entry.unit]),
          categories: products.categories,
          skipped: products.skipped.map((entry) => [entry.normalizedName, entry.reason]),
        })
      : "skipped")
    .update("|budgets:")
    .update(JSON.stringify(budgets.creates.map((entry) => [entry.branchId, entry.period, entry.amountAllocatedCents])))
    .digest("hex")
}

/**
 * Create the catalogue the order import resolves its lines against.
 *
 * Three rows per product, and all three are needed: `global_products` holds the
 * product and its base price, `organization_inventory` is what makes it
 * available to this organization (and what `import-ke-orders.ts` joins
 * through), and `legacy_product_mappings` is the name-based bridge that lets a
 * legacy order line find it.
 *
 * Prices of products that already exist are never touched — see the header of
 * `lib/legacy-import/ke-products.ts`.
 */
async function applyProducts(
  client: QueryClient,
  plan: ProductPlan,
  actorUserId: string,
  counts: Record<string, number>,
): Promise<void> {
  const categoryIdByName = new Map<string, number>()
  for (const name of plan.categories) {
    const [existing] = await rows(client,
      `select id from categories where organization_id = $1 and lower(btrim(name)) = lower(btrim($2)) limit 1`,
      [target.id, name])
    if (existing) {
      categoryIdByName.set(name, Number(existing.id))
      continue
    }
    const [created] = await rows(client,
      `insert into categories (organization_id, name) values ($1, $2) returning id`, [target.id, name])
    categoryIdByName.set(name, Number(created.id))
    counts.categoriesCreated += 1
  }

  for (const product of plan.creates) {
    const categoryId = product.categoryName ? categoryIdByName.get(product.categoryName) ?? null : null

    const [globalProduct] = await rows(client,
      `insert into global_products
         (product_code, name, description, category_id, base_price_cents, unit, status, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6, 'active', $7)
       returning id`,
      [
        productCodeFor(product.sourceCodes[0]),
        product.sourceName,
        product.description,
        categoryId,
        product.basePriceCents,
        product.unit,
        actorUserId,
      ])
    counts.productsCreated += 1

    const [inventory] = await rows(client,
      `insert into organization_inventory
         (organization_id, global_product_id, assigned_by_user_id, is_active)
       values ($1, $2, $3, true)
       returning id`,
      [target.id, Number(globalProduct.id), actorUserId])
    counts.productsAssigned += 1

    await client.query(
      `insert into organization_products (organization_id, global_product_id, is_enabled)
       values ($1, $2, true)
       on conflict (organization_id, global_product_id) do nothing`,
      [target.id, Number(globalProduct.id)])

    await client.query(
      `insert into legacy_product_mappings
         (organization_id, source_system, normalized_name, source_name, source_codes,
          global_product_id, organization_inventory_id)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        target.id,
        SOURCE_SYSTEM,
        product.normalizedName,
        product.sourceName,
        JSON.stringify(product.sourceCodes),
        Number(globalProduct.id),
        Number(inventory.id),
      ])
    counts.productsMapped += 1
  }
}

/**
 * Write the branch budget legacy states for the period it funds.
 *
 * Insert-only. An allocation already present is left exactly as it is — see the
 * header of `lib/legacy-import/ke-budgets.ts` for why rewriting one can fail
 * the `budgets_values_valid_ck` constraint outright.
 *
 * `on conflict do nothing` against `budgets_branch_period_uq` makes a
 * concurrent run harmless rather than a duplicate-key failure.
 */
async function applyBudgets(
  client: QueryClient,
  plan: BudgetPlan,
  counts: Record<string, number>,
): Promise<void> {
  for (const entry of plan.creates) {
    const result = await client.query(
      `insert into budgets (organization_id, branch_id, period, amount_allocated_cents)
       values ($1, $2, $3, $4)
       on conflict (branch_id, period) do nothing`,
      [target.id, entry.branchId, entry.period, entry.amountAllocatedCents])
    if (result.rowCount ?? 0) counts.budgetsCreated += 1
  }
}

/**
 * Create the groups legacy has that OneFlowe does not.
 *
 * Previously refused because a group carries pricing scope. It is created here
 * with no price of its own, so every branch in it continues to resolve to the
 * organization or global price until a Super Admin sets one deliberately —
 * which keeps the "a price change never reaches past a tier that set its own"
 * rule intact.
 */
async function applyGroupCreates(
  client: QueryClient,
  names: readonly string[],
  actorUserId: string,
  counts: Record<string, number>,
): Promise<Map<string, number>> {
  const created = new Map<string, number>()
  for (const name of names) {
    const [existing] = await rows(client,
      `select id from groups where organization_id = $1 and lower(btrim(name)) = lower(btrim($2)) limit 1`,
      [target.id, name])
    if (existing) {
      created.set(name, Number(existing.id))
      continue
    }
    const [row] = await rows(client,
      `insert into groups (organization_id, name, status, created_by_user_id)
       values ($1, $2, 'active', $3) returning id`,
      [target.id, name, actorUserId])
    created.set(name, Number(row.id))
    counts.groupsCreated += 1
  }
  return created
}

async function apply(
  client: QueryClient,
  plan: SyncPlan,
  options: Options,
  products: ProductPlan | null,
  budgets: BudgetPlan | null,
): Promise<CommitResult> {
  const counts: Record<string, number> = {
    branchesPinned: 0,
    branchesRenamed: 0,
    branchesCreated: 0,
    groupsCreated: 0,
    groupAssignments: 0,
    budgetsCreated: 0,
    categoriesCreated: 0,
    productsCreated: 0,
    productsAssigned: 0,
    productsMapped: 0,
    usernamesRenamed: 0,
    usersMovedToLegacyBranch: 0,
    accountsStamped: 0,
    peopleCreated: 0,
    accountsCreated: 0,
    accountsBackfilled: 0,
  }

  const [batch] = await rows(client,
    `insert into legacy_import_batches
       (organization_id, source_system, source_manifest, status, imported_by_user_id)
     values ($1, $2, $3::jsonb, 'RUNNING', $4)
     returning id`,
    [
      target.id,
      SOURCE_SYSTEM,
      JSON.stringify({
        importer: "sync-ke",
        planDigest: planDigest(plan),
        generatedAt: new Date().toISOString(),
      }),
      options.actorUserId,
    ])
  const batchId = String(batch.id)

  // 1. Branch identity. Pinning first means every later step can address a
  //    branch by its legacy id instead of by a name that may be about to change.
  for (const pin of plan.branches.pins) {
    if (!pin.needsPin && !pin.rename) continue
    await client.query(
      `update branches
          set external_source = $1, external_id = $2,
              name = case when $3::text is null then name else $3::text end,
              updated_at = now()
        where id = $4 and organization_id = $5`,
      [SOURCE_SYSTEM, String(pin.legacyLocationId), pin.rename?.to ?? null, pin.branchId, target.id])
    if (pin.needsPin) counts.branchesPinned += 1
    if (pin.rename) counts.branchesRenamed += 1
  }

  for (const create of plan.branches.creates) {
    await client.query(
      `insert into branches (organization_id, name, address, external_source, external_id, status)
       values ($1, $2, $3, $4, $5, 'active')
       on conflict do nothing`,
      [target.id, create.name, create.address, SOURCE_SYSTEM, String(create.legacyLocationId)])
    counts.branchesCreated += 1
  }

  // 2. Groups: create the ones legacy has and we do not, then membership.
  //    Creation runs first so an assignment planned against a missing group has
  //    somewhere to land on the very first run of an empty database.
  await applyGroupCreates(client, plan.groups.missingGroups, options.actorUserId!, counts)

  for (const assignment of plan.groups.assignments) {
    await client.query(
      `update branches set group_id = $1, updated_at = now() where id = $2 and organization_id = $3`,
      [assignment.groupId, assignment.branchId, target.id])
    counts.groupAssignments += 1
  }

  // 3. Budgets. After branches, because a budget row needs its branch id.
  if (budgets) await applyBudgets(client, budgets, counts)

  // 4. Catalogue. Independent of branches and users, but it must exist before
  //    `import-ke-orders.ts` runs or every order line fails PRODUCT_NOT_FOUND.
  if (products) await applyProducts(client, products, options.actorUserId!, counts)

  // Correct anyone sitting at a branch legacy does not assign them to. Applied
  // before the username work so a moved account is already in the right place
  // if anything below reads its branch.
  for (const move of plan.users.branchMoves) {
    await client.query(
      `update users set branch_id = $1, updated_at = now() where id = $2 and organization_id = $3`,
      [move.toBranchId, move.userId, target.id])
    counts.usersMovedToLegacyBranch += 1
  }

  // 5. Usernames. Applied in two passes through a temporary name, because
  //    `users_username_idx` is unique platform-wide and a direct rename could
  //    collide with a name another row in the same batch is about to give up.
  for (const rename of plan.usernames.renames) {
    await client.query(
      `update users set username = $1, updated_at = now() where id = $2 and organization_id = $3`,
      [`tmp:${rename.userId}`, rename.userId, target.id])
  }
  for (const rename of plan.usernames.renames) {
    await client.query(
      `update users set username = $1, updated_at = now() where id = $2 and organization_id = $3`,
      [rename.to, rename.userId, target.id])
    counts.usernamesRenamed += 1
  }

  // 4. External identity. This is what stops these accounts accepting an email
  //    address at the login screen, so it must land for every mirrored account.
  for (const stamp of plan.users.stamps) {
    await client.query(
      `update users set external_source = $1, external_id = $2, updated_at = now()
        where id = $3 and organization_id = $4`,
      [SOURCE_SYSTEM, stamp.externalId, stamp.userId, target.id])
    counts.accountsStamped += 1
  }

  // 5. People. Both accounts share one hash of the password they already know,
  //    and both must change it on first sign-in.
  const roleIds = new Map<string, number>()
  for (const role of await rows(client, `select id, name from roles where name = any($1)`, [[ROLE_BRANCH_ADMIN, ROLE_ORDER_PORTAL]])) {
    roleIds.set(String(role.name), Number(role.id))
  }
  assert(roleIds.has(ROLE_BRANCH_ADMIN) && roleIds.has(ROLE_ORDER_PORTAL), "BRANCH_ADMIN and ORDER_PORTAL roles must exist")

  for (const person of plan.users.people) {
    const passwordHash = await hashMirroredLegacyPassword(person.legacyPassword)
    for (const account of person.accounts) {
      await client.query(
        `insert into users
           (email, username, password_hash, role_id, is_active, full_name, first_name, last_name,
            phone, organization_id, branch_id, must_change_password, external_source, external_id)
         values ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, true, $11, $12)`,
        [
          person.email, account.username, passwordHash, roleIds.get(account.roleName),
          person.fullName, person.firstName, person.lastName, person.phone,
          target.id, person.branchId, SOURCE_SYSTEM, person.employeeCode,
        ])
      counts.accountsCreated += 1
    }
    counts.peopleCreated += 1
  }

  // 6. The missing half of an incomplete pair, reusing the hash the person
  //    already signs in with so the two accounts stay in step.
  for (const entry of plan.users.backfill) {
    const [source] = await rows(client,
      `select password_hash, full_name, first_name, last_name, phone, must_change_password, external_id
         from users
        where organization_id = $1 and external_source = $2
          and external_id = $3 and deleted_at is null
        limit 1`,
      [target.id, SOURCE_SYSTEM, entry.username.replace(/(-ba|-op)$/i, "")])
    assert(source, `no existing account to copy credentials from for ${entry.username}`)
    await client.query(
      `insert into users
         (email, username, password_hash, role_id, is_active, full_name, first_name, last_name,
          phone, organization_id, branch_id, must_change_password, external_source, external_id)
       values ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        entry.email, entry.username, source.password_hash, roleIds.get(entry.roleName),
        source.full_name, source.first_name, source.last_name, source.phone,
        target.id, entry.branchId, source.must_change_password, SOURCE_SYSTEM, source.external_id,
      ])
    counts.accountsBackfilled += 1
  }

  await client.query(
    `update legacy_import_batches set status = 'COMPLETED', counts = $1::jsonb, completed_at = now() where id = $2`,
    [JSON.stringify(counts), batchId])

  return { batchId, counts }
}

async function main() {
  const options = parseOptions()

  const [legacyLocations, legacyGroups, legacySubUsers, legacyItems, legacyCategories, legacyPriceHistory] = await Promise.all([
    fetchJson<LegacyLocation[]>(`/api/Location/GetLocation/${LEGACY_ACCOUNT_ID}`),
    fetchJson<LegacyLocationGroup[]>(`/api/LocationGroup/GetLocationGroups/${LEGACY_ACCOUNT_ID}`),
    fetchJson<LegacySubUser[]>(`/api/SubUser/0/${LEGACY_ACCOUNT_ID}`),
    options.skipProducts ? Promise.resolve([]) : fetchJson<LegacyItem[]>(`/api/Item/0/null/${LEGACY_ACCOUNT_ID}`),
    options.skipProducts ? Promise.resolve([]) : fetchJson<LegacyCategory[]>(`/api/Category/0/${LEGACY_ACCOUNT_ID}`),
    options.skipProducts ? Promise.resolve([]) : fetchPriceHistory(),
  ])
  assert(Array.isArray(legacyLocations) && legacyLocations.length > 0, "Legacy locations endpoint returned nothing")
  assert(Array.isArray(legacyGroups), "Legacy groups endpoint did not return an array")
  assert(Array.isArray(legacySubUsers) && legacySubUsers.length > 0, "Legacy users endpoint returned nothing")
  assert(Array.isArray(legacyItems), "Legacy items endpoint did not return an array")
  assert(Array.isArray(legacyCategories), "Legacy categories endpoint did not return an array")
  assert(Array.isArray(legacyPriceHistory), "Legacy price history endpoint did not return an array")
  if (!options.skipProducts) {
    assert(legacyItems.length > 0, "Legacy items endpoint returned nothing; pass --skip-products to sync without the catalogue")
  }

  const { pool } = await import("../lib/db-cli")
  try {
    // The organization must be known before anything is read, and may not exist
    // yet. On a dry run against an empty database it is planned, not created —
    // creation happens inside the commit transaction so a rollback undoes it.
    const [existingOrg] = await rows(pool,
      `select id, code, name from organizations where code = $1`, [options.organizationCode])
    const organizationExists = Boolean(existingOrg)
    if (organizationExists) {
      target = { id: Number(existingOrg.id), code: String(existingOrg.code), name: String(existingOrg.name) }
      assert(
        normalizeOrgName(target.name) === normalizeOrgName(options.organizationName),
        `Organization code ${options.organizationCode} belongs to "${target.name}", not `
          + `"${options.organizationName}". Refusing to sync K-Electric data into another tenant.`,
      )
    } else {
      assert(options.createOrganization,
        `No organization with code "${options.organizationCode}". Pass --create-organization to create `
          + `"${options.organizationName}", or --organization-code=<code> to target an existing one.`)
      target = { id: NEW_ORGANIZATION_ID, code: options.organizationCode, name: options.organizationName }
    }

    const current = organizationExists
      ? await readCurrent(pool)
      : { branches: [], groups: [], users: [] }
    const currentMappings = organizationExists ? await readProductMappings(pool) : []
    const products = options.skipProducts
      ? null
      : planProducts(legacyItems, legacyCategories, currentMappings, legacyPriceHistory)
    const branches = planBranches(legacyLocations, current.branches)
    // Budgets key off the branch pins, so they can only be planned for branches
    // that already exist. Ones created in this same run are picked up next time,
    // exactly as their people are.
    const budgets = planBranchBudgets(
      legacyLocations,
      branchPinMap(branches, current.branches),
      organizationExists ? await readBudgets(pool) : [],
    )
    const groups = planGroups(legacyGroups, current.groups, branches.pins, current.branches)
    const usernames = planUsernameMigration(current.users)
    const users = planUsers(legacySubUsers, branches.pins, current.users, { renames: usernames.renames })
    const plan: SyncPlan = { branches, groups, usernames, users }
    const digest = combinedDigest(plan, products, budgets, organizationExists)
    const counts = summarize(plan)
    const productCounts = products ? summarizeProducts(products, legacyItems.length) : null

    const report = {
      generatedAt: new Date().toISOString(),
      mode: options.commit ? "COMMIT" : options.rollbackTest ? "ROLLBACK_TEST" : "DRY_RUN",
      organization: target,
      organizationWillBeCreated: !organizationExists,
      source: { system: SOURCE_SYSTEM, baseUrl: BASE_URL },
      sourceCounts: {
        locations: legacyLocations.length,
        groups: legacyGroups.length,
        subUsers: legacySubUsers.length,
        items: legacyItems.length,
        categories: legacyCategories.length,
      },
      planDigest: digest,
      counts,
      productCounts,
      budgetCounts: summarizeBudgets(budgets),
      plan,
      products,
      budgets,
    }
    mkdirSync(dirname(options.outputPath), { recursive: true })
    writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")

    if (!organizationExists) {
      console.log(`ORGANIZATION\n  create ................. "${target.name}" (code ${target.code})\n`)
    }
    console.log(describe(plan).join("\n"))
    if (products) console.log(`\n${describeProducts(products, legacyItems.length).join("\n")}`)
    console.log("")
    console.log(JSON.stringify(
      { output: options.outputPath, planDigest: digest, counts, productCounts,
        budgetCounts: summarizeBudgets(budgets) }, null, 2))

    assert(branches.ambiguous.length === 0,
      `${branches.ambiguous.length} legacy location(s) match more than one branch; resolve them before syncing`)
    assert(usernames.collisions.length === 0,
      `${usernames.collisions.length} username collision(s); resolve them before syncing`)

    const nothingToDo = organizationExists
      && (counts.branchesToPin + counts.branchesToRename + counts.branchesToCreate + counts.groupAssignments
        + counts.usernameRenames + counts.peopleToCreate + counts.accountsToBackfill + counts.accountsToStamp
        + plan.groups.missingGroups.length + (products?.creates.length ?? 0)
        + plan.users.branchMoves.length
        + budgets.creates.length) === 0

    if (!options.commit && !options.rollbackTest) {
      if (nothingToDo) {
        console.log("\nNothing to sync: OneFlowe already matches the legacy platform.")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npm run sync:ke -- --commit \\\n    --actor-user-id=<active-super-admin-uuid> \\\n    --confirm-organization=${organizationConfirmation(target)} \\\n    --confirm-plan=${digest}`)
        if (counts.branchesToCreate > 0) {
          console.log(`\nNote: ${counts.branchesToCreate} branch(es) will be created. People at those branches are`)
          console.log("skipped this run (BRANCH_NOT_PINNED) — run the sync again afterwards to pick them up.")
        }
      }
      return
    }

    assert(options.actorUserId, "Commit requires --actor-user-id=<active-super-admin-uuid>")
    assert(options.confirmOrganization === organizationConfirmation(target),
      `Commit requires --confirm-organization=${organizationConfirmation(target)}`)
    assert(options.confirmPlan === digest, `Commit requires --confirm-plan=${digest}`)

    const [actor] = await rows(pool,
      `select u.id from users u join roles r on r.id = u.role_id
        where u.id = $1 and r.name = 'SUPER_ADMIN' and u.is_active = true and u.deleted_at is null`,
      [options.actorUserId])
    assert(actor, "--actor-user-id must be an active SUPER_ADMIN")

    const client = await (pool as any).connect()
    try {
      await client.query("begin")
      await client.query(`select pg_advisory_xact_lock(hashtext('oneflowe:ke-sync'))`)

      // Created inside the transaction so a failure anywhere below leaves no
      // half-built tenant behind. `target` is repointed before anything is read
      // under the lock, so every subsequent statement is scoped to it.
      if (!organizationExists) {
        const { organization } = await resolveOrganization(client, options)
        target = organization
      }

      // The plan is rebuilt inside the transaction from rows read under the
      // lock. If anything moved between the dry run and now, the digest differs
      // and nothing is written.
      const locked = await readCurrent(client)
      const lockedBranches = planBranches(legacyLocations, locked.branches)
      const lockedUsernames = planUsernameMigration(locked.users)
      const lockedPlan: SyncPlan = {
        branches: lockedBranches,
        groups: planGroups(legacyGroups, locked.groups, lockedBranches.pins, locked.branches),
        usernames: lockedUsernames,
        users: planUsers(legacySubUsers, lockedBranches.pins, locked.users, { renames: lockedUsernames.renames }),
      }
      const lockedProducts = options.skipProducts
        ? null
        : planProducts(legacyItems, legacyCategories, await readProductMappings(client), legacyPriceHistory)
      const lockedBudgets = planBranchBudgets(
        legacyLocations,
        branchPinMap(lockedPlan.branches, locked.branches),
        await readBudgets(client),
      )
      assert(
        combinedDigest(lockedPlan, lockedProducts, lockedBudgets, organizationExists) === digest,
        "Plan changed between confirmation and commit; re-run the dry run",
      )

      const result = await apply(client, lockedPlan, options, lockedProducts, lockedBudgets)
      if (options.rollbackTest) {
        await client.query("rollback")
        console.log(`\nRollback test: applied and rolled back. Counts: ${JSON.stringify(result.counts)}`)
      } else {
        await client.query("commit")
        console.log(`\nCommitted batch ${result.batchId}. Counts: ${JSON.stringify(result.counts)}`)
        console.log("Next: npm run import:ke-orders -- --start-date=<YYYY-MM-DD> --end-date=<YYYY-MM-DD>")
      }
    } catch (error) {
      await client.query("rollback").catch(() => {})
      throw error
    } finally {
      client.release()
    }
  } finally {
    const { closePool } = await import("../lib/db-cli")
    await closePool()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
