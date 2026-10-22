#!/usr/bin/env tsx
/**
 * Import organizations from the reviewed customer workbook.
 *
 * Safety properties:
 * - production environment is loaded only from `.env.prod.local` (or an
 *   explicit shell override) and is checked with the migration target guard;
 * - default mode is read-only and prints a digest-bound plan;
 * - K-Electric and organizations already present by name/canonical name/NTN
 *   are skipped;
 * - the commit rebuilds the plan under an advisory lock and uses one
 *   serializable transaction, so any failure rolls back every insert;
 * - every created organization is `managed_ordering = true`;
 * - the post-commit report supports a non-destructive compensating rollback
 *   that deactivates only untouched rows created by that exact report.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

import { Client, type PoolClient } from "pg"
import * as XLSX from "xlsx"

import {
  assertTargetMatchesEnvironment,
  describeMigrationTarget,
  migrationSslFor,
  selectMigrationUrl,
} from "../lib/migration-target"
import { invalidateCachePrefixes } from "../lib/cache-cli"
import { readMigrationEnvFor } from "../lib/server/migration-env"

type Status = "active" | "inactive" | "suspended"
type DbRow = Record<string, unknown>

type SourceOrganization = {
  rowNumber: number
  name: string
  status: Status
  ntnNumber: string | null
}

type ExistingOrganization = {
  id: number
  name: string
  code: string | null
  ntnNumber: string | null
  status: string | null
  managedOrdering: boolean
}

type PlannedOrganization = SourceOrganization & {
  code: string
  managedOrdering: true
}

type SkippedOrganization = SourceOrganization & {
  existingId: number | null
  existingName: string | null
  reason: string
}

type ReviewMatch = SourceOrganization & {
  possibleExisting: Array<{ id: number; name: string; code: string | null; reason: string }>
}

type ImportPlan = {
  sourceFile: string
  sourceSha256: string
  target: string
  existingOrganizationCount: number
  creates: PlannedOrganization[]
  skips: SkippedOrganization[]
  reviews: ReviewMatch[]
}

type CreatedOrganization = PlannedOrganization & { id: number }

type CommitReport = {
  kind: "organization-spreadsheet-import"
  committedAt: string
  sourceFile: string
  sourceSha256: string
  target: string
  planSha256: string
  operator: string
  created: CreatedOrganization[]
  skipped: SkippedOrganization[]
  cacheInvalidation: unknown[]
}

const ADVISORY_LOCK = "oneflowe:organization-spreadsheet-import"
const EXPLICIT_SKIP_NAMES = new Set(["K ELECTRIC LIMITED"])
const REVIEWED_EXISTING_ALIASES = new Map([
  ["INTERNATIONAL PACKAGING FILMS LIMITED", "INTERNATIONAL PACKAGING PVT LTD"],
])
const REQUIRED_ORGANIZATION_COLUMNS = [
  "name",
  "code",
  "ntn_number",
  "status",
  "order_approver_role",
  "order_approval_required",
  "block_ordering_on_unpaid_invoices",
  "block_ordering_on_unacknowledged_deliveries",
  "unpaid_invoice_block_threshold",
  "unacknowledged_delivery_block_threshold",
  "budgets_enabled",
  "managed_ordering",
  "private_network_login_enabled",
  "order_approval_levels_enabled",
] as const

const LEGAL_NAME_WORDS = new Set([
  "CO",
  "COMPANY",
  "LIMITED",
  "LTD",
  "PRIVATE",
  "PVT",
])

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function normalizedWords(value: string): string[] {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function normalizedName(value: string): string {
  return normalizedWords(value).join(" ")
}

function canonicalName(value: string): string {
  const words = normalizedWords(value).filter((word) => !LEGAL_NAME_WORDS.has(word))
  while (words.at(-1) === "AND") words.pop()
  return words.join(" ")
}

function acronym(value: string): string {
  return canonicalName(value)
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
}

function normalizedTaxId(value: string | null): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function textCell(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ")
}

function extractNtn(value: unknown): string | null {
  const match = textCell(value).match(/\bNTN[^A-Za-z0-9]*([A-Za-z0-9][A-Za-z0-9-]*)/i)
  return match?.[1]?.trim() || null
}

function sheetStatus(value: unknown, rowNumber: number): Status {
  const normalized = textCell(value).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")
  if (normalized === "active") return "active"
  if (normalized === "inactive" || normalized === "non active") return "inactive"
  if (normalized === "suspended") return "suspended"
  throw new Error(`Unsupported status at workbook row ${rowNumber}: ${textCell(value) || "(blank)"}`)
}

function readSource(filePath: string): { rows: SourceOrganization[]; sourceSha256: string } {
  assert(existsSync(filePath), `Workbook not found: ${filePath}`)
  const sourceSha256 = sha256(readFileSync(filePath))
  const workbook = XLSX.readFile(filePath, { cellDates: false })
  const sheetName = workbook.SheetNames.includes("Customer List")
    ? "Customer List"
    : workbook.SheetNames[0]
  assert(sheetName, "Workbook has no worksheets")
  const grid = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
    header: 1,
    defval: "",
    raw: false,
  })
  assert(grid.length > 1, "Workbook has no organization rows")
  assert(normalizedName(textCell(grid[0]?.[1])) === "COMPANY NAME", "Column B must be Company Name")
  assert(normalizedName(textCell(grid[0]?.[3])) === "STATUS", "Column D must be Status")

  const rows = grid.slice(1).map((line, index): SourceOrganization | null => {
    const rowNumber = index + 2
    const name = textCell(line[1])
    if (!name) return null
    assert(name.length >= 2 && name.length <= 100,
      `Organization name at workbook row ${rowNumber} must be 2-100 characters`)
    const ntnNumber = extractNtn(line[4])
    assert(ntnNumber === null || (/^[A-Za-z0-9-]+$/.test(ntnNumber) && ntnNumber.length <= 32),
      `NTN at workbook row ${rowNumber} is not valid for the application`)
    return { rowNumber, name, status: sheetStatus(line[3], rowNumber), ntnNumber }
  }).filter((row): row is SourceOrganization => row !== null)

  const duplicateNames = rows.filter((row, index) =>
    rows.findIndex((candidate) => normalizedName(candidate.name) === normalizedName(row.name)) !== index)
  assert(duplicateNames.length === 0,
    `Workbook repeats organization name(s): ${duplicateNames.map((row) => row.name).join(", ")}`)
  // The Customer List holds 45; a smaller follow-up workbook names its own count.
  const expectedRows = Number(argument("expected-rows") ?? 45)
  assert(Number.isInteger(expectedRows) && expectedRows > 0, "--expected-rows must be a positive integer")
  assert(rows.length === expectedRows, `Expected ${expectedRows} organization rows, found ${rows.length}`)
  return { rows, sourceSha256 }
}

function suspiciousMatches(source: SourceOrganization, existing: ExistingOrganization[]): ReviewMatch["possibleExisting"] {
  const sourceCanonical = canonicalName(source.name)
  const sourceWords = new Set(sourceCanonical.split(" ").filter(Boolean))
  const sourceAcronym = acronym(source.name)
  return existing.flatMap((organization) => {
    const existingCanonical = canonicalName(organization.name)
    const existingWords = new Set(existingCanonical.split(" ").filter(Boolean))
    const shared = [...sourceWords].filter((word) => existingWords.has(word)).length
    const smaller = Math.min(sourceWords.size, existingWords.size)
    const strongTokenOverlap = smaller >= 2 && shared / smaller >= 0.8
    const acronymMatch = sourceAcronym.length >= 3 && (
      normalizedName(organization.name).replace(/ /g, "") === sourceAcronym
      || acronym(organization.name) === normalizedName(source.name).replace(/ /g, "")
    )
    if (!strongTokenOverlap && !acronymMatch) return []
    return [{
      id: organization.id,
      name: organization.name,
      code: organization.code,
      reason: acronymMatch ? "acronym match" : "strong name-token overlap",
    }]
  })
}

function exactExistingMatch(
  source: SourceOrganization,
  existing: ExistingOrganization[],
): { organization: ExistingOrganization; reason: string } | null {
  const exact = existing.find((organization) => normalizedName(organization.name) === normalizedName(source.name))
  if (exact) return { organization: exact, reason: "existing normalized name" }

  const canonical = canonicalName(source.name)
  const legalName = existing.find((organization) => canonicalName(organization.name) === canonical)
  if (legalName) return { organization: legalName, reason: "existing legal-name equivalent" }

  const ntn = normalizedTaxId(source.ntnNumber)
  const taxMatch = ntn
    ? existing.find((organization) => normalizedTaxId(organization.ntnNumber) === ntn)
    : undefined
  if (taxMatch) return { organization: taxMatch, reason: "existing NTN" }
  return null
}

function nextSequentialCodes(existing: ExistingOrganization[], count: number): string[] {
  const used = new Set(existing.map((organization) => String(organization.code ?? "").toUpperCase()))
  const numeric = [...used]
    .filter((code) => /^\d{4}$/.test(code))
    .map(Number)
  let next = Math.max(0, ...numeric) + 1
  const result: string[] = []
  while (result.length < count) {
    assert(next <= 9999, "No four-digit organization codes remain")
    const code = String(next).padStart(4, "0")
    next += 1
    if (used.has(code)) continue
    used.add(code)
    result.push(code)
  }
  return result
}

async function rows(client: Client | PoolClient, sql: string, parameters: unknown[] = []): Promise<DbRow[]> {
  return (await client.query(sql, parameters)).rows
}

async function assertProductionSchema(client: Client | PoolClient): Promise<void> {
  const columns = await rows(client, `
    select column_name
      from information_schema.columns
     where table_schema = current_schema() and table_name = 'organizations'
  `)
  const available = new Set(columns.map((row) => String(row.column_name)))
  const missing = REQUIRED_ORGANIZATION_COLUMNS.filter((column) => !available.has(column))
  assert(missing.length === 0,
    `Production schema is missing required organization columns: ${missing.join(", ")}`)

  const supportingTables = await rows(client, `
    select table_name
      from information_schema.tables
     where table_schema = current_schema()
       and table_name = any($1::text[])
  `, [["organization_settings", "audit_logs"]])
  const tableNames = new Set(supportingTables.map((row) => String(row.table_name)))
  assert(tableNames.has("organization_settings") && tableNames.has("audit_logs"),
    "Production schema is missing organization_settings or audit_logs")
}

async function loadExisting(client: Client | PoolClient): Promise<ExistingOrganization[]> {
  const result = await rows(client, `
    select id, name, code, ntn_number, status, managed_ordering
      from organizations
     order by id
  `)
  return result.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    code: row.code == null ? null : String(row.code),
    ntnNumber: row.ntn_number == null ? null : String(row.ntn_number),
    status: row.status == null ? null : String(row.status),
    managedOrdering: row.managed_ordering === true,
  }))
}

async function buildPlan(
  client: Client | PoolClient,
  filePath: string,
  target: string,
): Promise<ImportPlan> {
  await assertProductionSchema(client)
  const { rows: sourceRows, sourceSha256 } = readSource(filePath)
  const existing = await loadExisting(client)
  const skips: SkippedOrganization[] = []
  const reviews: ReviewMatch[] = []
  const pending: SourceOrganization[] = []

  for (const source of sourceRows) {
    if (EXPLICIT_SKIP_NAMES.has(normalizedName(source.name))) {
      skips.push({ ...source, existingId: null, existingName: null, reason: "explicit K-Electric skip" })
      continue
    }
    const reviewedAlias = REVIEWED_EXISTING_ALIASES.get(normalizedName(source.name))
    if (reviewedAlias) {
      const aliasMatch = existing.find((organization) => normalizedName(organization.name) === reviewedAlias)
      assert(aliasMatch,
        `Reviewed existing alias for ${source.name} is no longer present; refusing to create it`)
      skips.push({
        ...source,
        existingId: aliasMatch.id,
        existingName: aliasMatch.name,
        reason: "reviewed existing organization alias",
      })
      continue
    }
    const match = exactExistingMatch(source, existing)
    if (match) {
      skips.push({
        ...source,
        existingId: match.organization.id,
        existingName: match.organization.name,
        reason: match.reason,
      })
      continue
    }
    const possibleExisting = suspiciousMatches(source, existing)
    if (possibleExisting.length > 0) {
      reviews.push({ ...source, possibleExisting })
      continue
    }
    pending.push(source)
  }

  const codes = nextSequentialCodes(existing, pending.length)
  return {
    sourceFile: basename(filePath),
    sourceSha256,
    target,
    existingOrganizationCount: existing.length,
    creates: pending.map((source, index) => ({ ...source, code: codes[index], managedOrdering: true })),
    skips,
    reviews,
  }
}

function planDigest(plan: ImportPlan): string {
  return sha256(canonicalJson(plan)).slice(0, 24)
}

async function insertOrganization(
  client: Client | PoolClient,
  organization: PlannedOrganization,
  digest: string,
  sourceFile: string,
  sourceSha256: string,
  operator: string,
): Promise<CreatedOrganization> {
  const result = await rows(client, `
    insert into organizations (
      name, code, ntn_number, status, order_approver_role,
      order_approval_required, block_ordering_on_unpaid_invoices,
      block_ordering_on_unacknowledged_deliveries,
      unpaid_invoice_block_threshold, unacknowledged_delivery_block_threshold,
      budgets_enabled, managed_ordering, private_network_login_enabled,
      order_approval_levels_enabled, created_at, updated_at
    ) values (
      $1, $2, $3, $4, 'BRANCH_ADMIN',
      true, false, false, 2, 2,
      false, true, false, false, now(), now()
    )
    returning id
  `, [organization.name, organization.code, organization.ntnNumber, organization.status])
  assert(result.length === 1, `Insert did not return an id for ${organization.name}`)
  const id = Number(result[0].id)

  for (const [key, value] of [
    ["budget_allocation_mode", "money"],
    ["hide_prices_for_branch_admin", false],
    ["hide_prices_for_order_portal", false],
  ] as const) {
    await client.query(`
      insert into organization_settings (organization_id, key, value, updated_at)
      values ($1, $2, $3::jsonb, now())
    `, [id, key, JSON.stringify(value)])
  }

  await client.query(`
    insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata, created_at)
    values (null, $1::int, 'CREATE_ORGANIZATION', 'organization', ($1::int)::text, $2::jsonb, now())
  `, [id, JSON.stringify({
    source: "Customer List.xlsx",
    sourceFile,
    sourceSha256,
    sourceRow: organization.rowNumber,
    planSha256: digest,
    operator,
    managedOrdering: true,
    budgetsEnabled: false,
    orderApprovalRequired: true,
    orderApproverRole: "BRANCH_ADMIN",
  })])
  return { ...organization, id }
}

async function verifyCreated(client: Client | PoolClient, created: CreatedOrganization[]): Promise<void> {
  if (created.length === 0) return
  const ids = created.map((organization) => organization.id)
  const stored = await rows(client, `
    select id, name, code, ntn_number, status, managed_ordering, budgets_enabled
      from organizations
     where id = any($1::int[])
     order by id
  `, [ids])
  assert(stored.length === created.length, "Post-insert organization count does not match the plan")
  for (const expected of created) {
    const actual = stored.find((row) => Number(row.id) === expected.id)
    assert(actual, `Created organization ${expected.id} is missing`)
    assert(actual.name === expected.name && actual.code === expected.code,
      `Stored identity differs for organization ${expected.id}`)
    assert((actual.ntn_number ?? null) === expected.ntnNumber && actual.status === expected.status,
      `Stored NTN/status differs for organization ${expected.id}`)
    assert(actual.managed_ordering === true,
      `Managed by Apricart is not enabled for organization ${expected.id}`)
    assert(actual.budgets_enabled === false,
      `Application create default for budgets is not preserved for organization ${expected.id}`)
  }

  const settings = await rows(client, `
    select organization_id, key, value
      from organization_settings
     where organization_id = any($1::int[])
  `, [ids])
  assert(settings.length === created.length * 3, "Created organization settings are incomplete")
  const audits = await rows(client, `
    select organization_id
      from audit_logs
     where organization_id = any($1::int[])
       and action = 'CREATE_ORGANIZATION'
       and metadata ->> 'planSha256' is not null
  `, [ids])
  assert(audits.length === created.length, "Created organization audit trail is incomplete")
}

async function commitPlan(
  client: Client,
  filePath: string,
  target: string,
  confirmedDigest: string,
  expectedCreate: number,
  operator: string,
): Promise<{ plan: ImportPlan; created: CreatedOrganization[] }> {
  await client.query("begin isolation level serializable")
  try {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [ADVISORY_LOCK])
    const plan = await buildPlan(client, filePath, target)
    const digest = planDigest(plan)
    assert(plan.reviews.length === 0,
      "Possible existing-organization matches need review; transaction rolled back")
    assert(digest === confirmedDigest,
      `Production plan changed after preflight (current ${digest}); transaction rolled back`)
    assert(plan.creates.length === expectedCreate,
      `Expected ${expectedCreate} creates but current plan has ${plan.creates.length}; transaction rolled back`)

    const created: CreatedOrganization[] = []
    for (const organization of plan.creates) {
      created.push(await insertOrganization(
        client,
        organization,
        digest,
        plan.sourceFile,
        plan.sourceSha256,
        operator,
      ))
    }
    await verifyCreated(client, created)
    await client.query("commit")
    return { plan, created }
  } catch (error) {
    await client.query("rollback")
    throw error
  }
}

function reportPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return resolve("backups", `organization-import-production-${stamp}.json`)
}

async function rollbackPlan(
  client: Client,
  report: CommitReport,
  confirmedDigest: string,
  operator: string,
): Promise<void> {
  const rollbackDigest = sha256(canonicalJson({
    target: report.target,
    planSha256: report.planSha256,
    created: report.created,
    action: "deactivate-and-disable-managed-ordering",
  })).slice(0, 24)
  assert(confirmedDigest === rollbackDigest,
    `Rollback confirmation does not match; required ${rollbackDigest}`)

  await client.query("begin isolation level serializable")
  try {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [ADVISORY_LOCK])
    const ids = report.created.map((organization) => organization.id)
    const dependentCounts = await rows(client, `
      select organization_id, sum(total)::int as total
        from (
          select organization_id, count(*)::int as total from branches where organization_id = any($1::int[]) group by organization_id
          union all select organization_id, count(*)::int from users where organization_id = any($1::int[]) group by organization_id
          union all select organization_id, count(*)::int from orders where organization_id = any($1::int[]) group by organization_id
          union all select organization_id, count(*)::int from groups where organization_id = any($1::int[]) group by organization_id
        ) dependencies
       group by organization_id
      having sum(total) > 0
    `, [ids])
    assert(dependentCounts.length === 0,
      "Rollback refused because at least one imported organization now has branches, users, orders, or groups")

    const stored = await rows(client, `
      select id, name, code, ntn_number, status, managed_ordering
        from organizations
       where id = any($1::int[])
       for update
    `, [ids])
    assert(stored.length === report.created.length,
      "Rollback refused because an imported organization is missing")
    for (const expected of report.created) {
      const actual = stored.find((row) => Number(row.id) === expected.id)
      assert(actual && actual.name === expected.name && actual.code === expected.code,
        `Rollback refused because organization ${expected.id} changed identity`)
      assert((actual.ntn_number ?? null) === expected.ntnNumber,
        `Rollback refused because organization ${expected.id} changed NTN`)
    }

    await client.query(`
      update organizations
         set status = 'inactive', managed_ordering = false, updated_at = now()
       where id = any($1::int[])
    `, [ids])
    for (const id of ids) {
      await client.query(`
        insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata, created_at)
        values (null, $1::int, 'ROLLBACK_ORGANIZATION_SPREADSHEET_IMPORT', 'organization', ($1::int)::text, $2::jsonb, now())
      `, [id, JSON.stringify({
        originalPlanSha256: report.planSha256,
        rollbackPlanSha256: rollbackDigest,
        operator,
        action: "deactivated organization and disabled managed ordering",
      })])
    }
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }
}

function applyCacheEnvironment(env: Record<string, string | undefined>): void {
  for (const key of ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const) {
    if (env[key]) process.env[key] = env[key]
  }
}

async function main(): Promise<void> {
  const { env, filesRead } = readMigrationEnvFor("production")
  const selected = selectMigrationUrl("production", env)
  assertTargetMatchesEnvironment("production", selected.url)
  const target = describeMigrationTarget(selected.url)
  const filePath = resolve(argument("sheet") ?? "")
  const rollbackReport = argument("rollback-report")
  assert(rollbackReport || argument("sheet"), "--sheet=<Customer List.xlsx> is required")

  const client = new Client({
    connectionString: selected.url,
    ssl: migrationSslFor("production", selected.url),
    application_name: "oneflowe-organization-spreadsheet-import",
    statement_timeout: 60_000,
  })
  await client.connect()
  try {
    if (rollbackReport) {
      const path = resolve(rollbackReport)
      assert(existsSync(path), `Commit report not found: ${path}`)
      const report = JSON.parse(readFileSync(path, "utf8")) as CommitReport
      assert(report.kind === "organization-spreadsheet-import", "Not an organization import report")
      assert(report.target === target, "Commit report belongs to a different production target")
      const rollbackDigest = sha256(canonicalJson({
        target: report.target,
        planSha256: report.planSha256,
        created: report.created,
        action: "deactivate-and-disable-managed-ordering",
      })).slice(0, 24)
      if (!flag("commit")) {
        console.log(JSON.stringify({
          mode: "ROLLBACK_DRY_RUN",
          target,
          report: basename(path),
          organizationsToDeactivate: report.created.map(({ id, name, code }) => ({ id, name, code })),
          rollbackPlanSha256: rollbackDigest,
          note: "No rows are deleted. The compensating rollback sets status inactive and managed ordering false.",
          requiredCommitArguments: [
            "--commit",
            `--confirm-rollback=${rollbackDigest}`,
            "--operator=<name-or-email>",
          ],
        }, null, 2))
        return
      }
      const operator = argument("operator")
      assert(operator, "--operator=<name-or-email> is required")
      await rollbackPlan(client, report, argument("confirm-rollback") ?? "", operator)
      applyCacheEnvironment(env)
      const cacheInvalidation = await invalidateCachePrefixes(["organizations", "settings"])
      console.log(JSON.stringify({
        mode: "ROLLBACK_COMMITTED",
        target,
        count: report.created.length,
        cacheInvalidation,
      }, null, 2))
      return
    }

    const plan = await buildPlan(client, filePath, target)
    const digest = planDigest(plan)
    const planOutput = {
      target,
      environmentFiles: filesRead,
      planSha256: digest,
      sourceFile: plan.sourceFile,
      sourceSha256: plan.sourceSha256,
      existingOrganizationCount: plan.existingOrganizationCount,
      createCount: plan.creates.length,
      skipCount: plan.skips.length,
      reviewCount: plan.reviews.length,
      creates: plan.creates,
      skips: plan.skips,
      reviews: plan.reviews,
    }
    if (!flag("commit")) {
      console.log(JSON.stringify({
        mode: "DRY_RUN",
        ...planOutput,
        requiredCommitArguments: plan.reviews.length === 0
          ? [
            "--commit",
            `--confirm-plan=${digest}`,
            `--expected-create=${plan.creates.length}`,
            "--operator=<name-or-email>",
          ]
          : [],
      }, null, 2))
      return
    }

    assert(plan.reviews.length === 0,
      "Commit refused because possible existing-organization matches need review")
    const operator = argument("operator")
    assert(operator, "--operator=<name-or-email> is required")
    const expectedCreate = Number(argument("expected-create"))
    assert(Number.isInteger(expectedCreate) && expectedCreate >= 0,
      "--expected-create=<non-negative integer> is required")
    const confirmedDigest = argument("confirm-plan") ?? ""
    assert(confirmedDigest === digest,
      `--confirm-plan must equal the current production plan digest ${digest}`)

    const committed = await commitPlan(
      client,
      filePath,
      target,
      confirmedDigest,
      expectedCreate,
      operator,
    )
    await verifyCreated(client, committed.created)
    applyCacheEnvironment(env)
    const cacheInvalidation = await invalidateCachePrefixes(["organizations", "settings"])
    const report: CommitReport = {
      kind: "organization-spreadsheet-import",
      committedAt: new Date().toISOString(),
      sourceFile: committed.plan.sourceFile,
      sourceSha256: committed.plan.sourceSha256,
      target,
      planSha256: digest,
      operator,
      created: committed.created,
      skipped: committed.plan.skips,
      cacheInvalidation,
    }
    const output = reportPath()
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" })
    console.log(JSON.stringify({
      mode: "COMMITTED",
      ...planOutput,
      created: committed.created,
      commitReport: output,
      cacheInvalidation,
      rollback: {
        automatic: "Any pre-commit or in-transaction failure rolled back the entire transaction.",
        compensating: `npx tsx scripts/import-organizations-from-xlsx.ts --rollback-report="${output}"`,
      },
    }, null, 2))
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
