#!/usr/bin/env tsx
/**
 * Adds the four K-Electric locations that exist in the supplied legacy branch
 * list but are missing from OneFlowe. The default mode is read-only.
 *
 * Commit mode is fixed to organization 10 / K-Electric and requires an exact
 * tenant confirmation, a digest of the current live plan, and the expected
 * number of inserts. Branch creation is serialized with the same advisory lock
 * used by the branch API. No users, orders, budgets, or inventory are changed.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import { Client, type PoolClient } from "pg"
import * as XLSX from "xlsx"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type JsonRow = Record<string, any>

const ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
const CONFIRM_ORGANIZATION = `${ORGANIZATION.id}:${ORGANIZATION.code}:${ORGANIZATION.name}`
const SOURCE_SYSTEM = "KE_LOGISTICS"
const SOURCE_LOCATIONS = [
  {
    externalId: "164",
    name: "Risk Management",
    province: "Sindh",
    city: "Karachi",
    address: "1st Floor, Block F, Elander Complex, Karachi",
  },
  {
    externalId: "165",
    name: "Digital Payments (DPLA)",
    province: "Sindh",
    city: "Karachi",
    address: "K-Electric Elander Complex, 1st Floor, Block B, Karachi",
  },
  {
    externalId: "166",
    name: "Marcomm",
    province: "Sindh",
    city: "Karachi",
    address: "Marketing Department, Elander Block B, Ground Floor, Karachi",
  },
  {
    externalId: "167",
    name: "Health And Wellbeing",
    province: "Sindh",
    city: "Karachi",
    address: "K-Electric Health & Wellbeing, Block M, 1st Floor, Karachi",
  },
] as const

interface Options {
  commit: boolean
  verify: boolean
  confirmOrganization?: string
  confirmPlanSha256?: string
  expectedCreatedBranches?: number
  outputPath: string
  branchListPath: string
  investigationPath: string
}

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function options(): Options {
  const commit = process.argv.includes("--commit")
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const expected = arg("--expected-created-branches")
  return {
    commit,
    verify: process.argv.includes("--verify"),
    confirmOrganization: arg("--confirm-organization"),
    confirmPlanSha256: arg("--confirm-plan-sha256"),
    expectedCreatedBranches: expected === undefined ? undefined : Number(expected),
    outputPath: resolve(arg("--output") ?? (commit
      ? `backups/ke-missing-branches-commit-${timestamp}.json`
      : "deliverables/ke-missing-branches-preflight.json")),
    branchListPath: resolve(arg("--branch-list") ?? "Branch List (1).xls"),
    investigationPath: resolve(arg("--investigation") ?? "updatedReports/ke-legacy-source-live-audit-2026-08-03.json"),
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

async function rows<T extends JsonRow = JsonRow>(
  client: PoolClient | Client,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

function loadSourceEvidence(opts: Options): JsonRow {
  assert(existsSync(opts.branchListPath), `Branch list not found: ${opts.branchListPath}`)
  assert(existsSync(opts.investigationPath), `Investigation source not found: ${opts.investigationPath}`)

  const workbook = XLSX.readFile(opts.branchListPath)
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
  assert(firstSheet, "The supplied branch list has no worksheet")
  const sheetRows = XLSX.utils.sheet_to_json<JsonRow>(firstSheet, { defval: null })
  const branchListNames = new Set(sheetRows.map((row) => String(row.Name ?? "").trim()).filter(Boolean))

  const investigation = JSON.parse(readFileSync(opts.investigationPath, "utf8")) as JsonRow
  const locationRows = investigation?.perLocationModules?.inventories?.countsByLocation
  assert(Array.isArray(locationRows), "Legacy location identity evidence is missing")

  const verifiedLocations = SOURCE_LOCATIONS.map((expected) => {
    assert(branchListNames.has(expected.name), `Supplied branch list is missing exact name ${expected.name}`)
    const sourceMatches = locationRows.filter((row: JsonRow) =>
      String(row.locationId) === expected.externalId && row.locationName === expected.name)
    assert(sourceMatches.length === 1, `Legacy identity ${expected.externalId}:${expected.name} is missing or ambiguous`)
    return { externalId: expected.externalId, name: expected.name }
  })

  return {
    branchListSha256: sha256File(opts.branchListPath),
    investigationSha256: sha256File(opts.investigationPath),
    verifiedLocations,
  }
}

async function loadState(client: PoolClient | Client): Promise<JsonRow> {
  const [organization] = await rows(client,
    "select id, code, name, status from organizations where id = $1",
    [ORGANIZATION.id],
  )
  const branches = await rows(client, `
    select id, organization_id, name, province, city, address, cost_center_id,
           admin_user_id, code, external_source, external_id, status, group_id,
           baseline_budget_cents, created_at, updated_at
    from branches where organization_id = $1 order by id
  `, [ORGANIZATION.id])
  const protectedCounts = (await rows(client, `
    select json_build_object(
      'users', (select count(*)::int from users),
      'orders', (select count(*)::int from orders),
      'budgets', (select count(*)::int from budgets),
      'branchInventory', (select count(*)::int from branch_inventory),
      'otherTenantBranches', (select count(*)::int from branches where organization_id <> $1)
    ) as counts
  `, [ORGANIZATION.id]))[0]?.counts
  return { organization, branches, protectedCounts }
}

function buildPlan(state: JsonRow, evidence: JsonRow): JsonRow {
  assert(state.organization, "K-Electric organization was not found")
  assert(
    state.organization.id === ORGANIZATION.id
      && state.organization.code === ORGANIZATION.code
      && state.organization.name === ORGANIZATION.name,
    "Organization 10 no longer matches the fixed K-Electric tenant identity",
  )
  assert(state.organization.status === "active", "K-Electric organization is not active")

  const existingBranches = state.branches as JsonRow[]
  const planned = SOURCE_LOCATIONS.map((source, index) => {
    const nameMatches = existingBranches.filter((branch) =>
      String(branch.name).trim().toLocaleLowerCase("en") === source.name.toLocaleLowerCase("en"))
    assert(nameMatches.length === 0, `Branch name already exists in K-Electric: ${source.name}`)

    const identityMatches = existingBranches.filter((branch) =>
      branch.external_source === SOURCE_SYSTEM && String(branch.external_id) === source.externalId)
    assert(identityMatches.length === 0, `Legacy branch identity already exists: ${source.externalId}`)

    const number = existingBranches.length + index + 1
    const code = `${ORGANIZATION.code}-${String(number).padStart(2, "0")}`
    assert(!existingBranches.some((branch) => branch.code === code), `Generated branch code already exists: ${code}`)

    return {
      organizationId: ORGANIZATION.id,
      name: source.name,
      province: source.province,
      city: source.city,
      address: source.address,
      costCenterId: null,
      adminUserId: null,
      code,
      externalSource: SOURCE_SYSTEM,
      externalId: source.externalId,
      status: "active",
      groupId: null,
      baselineBudgetCents: 0,
    }
  })

  return {
    organization: ORGANIZATION,
    preconditions: {
      existingTenantBranchCount: existingBranches.length,
      protectedCounts: state.protectedCounts,
      sourceEvidence: evidence,
    },
    branchesToCreate: planned,
    explicitlyUnchanged: ["users", "orders", "budgets", "branch_inventory", "other tenants"],
  }
}

async function applyPlan(client: Client, plan: JsonRow): Promise<JsonRow> {
  const createdBranches: JsonRow[] = []
  const auditLogIds: number[] = []
  for (const branch of plan.branchesToCreate as JsonRow[]) {
    const [created] = await rows(client, `
      insert into branches (
        organization_id, name, province, city, address, cost_center_id,
        admin_user_id, code, external_source, external_id, status, group_id,
        baseline_budget_cents
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      returning id, organization_id, name, code, external_source, external_id, status
    `, [
      branch.organizationId,
      branch.name,
      branch.province,
      branch.city,
      branch.address,
      branch.costCenterId,
      branch.adminUserId,
      branch.code,
      branch.externalSource,
      branch.externalId,
      branch.status,
      branch.groupId,
      branch.baselineBudgetCents,
    ])
    assert(created, `Failed to create branch ${branch.name}`)
    createdBranches.push(created)

    const [audit] = await rows(client, `
      insert into audit_logs (
        user_id, organization_id, branch_id, action, entity, entity_id, metadata
      ) values (null,$1,$2,'CREATE_BRANCH','BRANCH',$3,$4::jsonb)
      returning id
    `, [
      ORGANIZATION.id,
      created.id,
      String(created.id),
      JSON.stringify({
        performedBy: "guarded K-Electric legacy branch import",
        sourceSystem: SOURCE_SYSTEM,
        externalId: branch.externalId,
        name: branch.name,
        code: branch.code,
        status: branch.status,
      }),
    ])
    assert(audit, `Failed to audit branch ${branch.name}`)
    auditLogIds.push(audit.id)
  }
  return { createdBranches, auditLogIds }
}

async function validateCommittedState(
  client: Client,
  before: JsonRow,
  plan: JsonRow,
  commitResult: JsonRow,
): Promise<JsonRow> {
  const after = await loadState(client)
  const createdIds = new Set((commitResult.createdBranches as JsonRow[]).map((branch) => branch.id))
  const afterBranches = after.branches as JsonRow[]
  const created = afterBranches.filter((branch) => createdIds.has(branch.id))
  assert(created.length === SOURCE_LOCATIONS.length, `Expected ${SOURCE_LOCATIONS.length} created branches, found ${created.length}`)
  assert(afterBranches.length === (before.branches as JsonRow[]).length + SOURCE_LOCATIONS.length, "Unexpected K-Electric branch count after insert")
  assert(stable(after.protectedCounts) === stable(before.protectedCounts), "A protected table or another tenant changed during branch creation")

  const previousBranchesAfter = afterBranches.filter((branch) => !createdIds.has(branch.id))
  assert(stable(previousBranchesAfter) === stable(before.branches), "An existing K-Electric branch changed unexpectedly")

  for (const expected of plan.branchesToCreate as JsonRow[]) {
    const match = created.filter((branch) =>
      branch.organization_id === expected.organizationId
        && branch.name === expected.name
        && branch.code === expected.code
        && branch.external_source === expected.externalSource
        && branch.external_id === expected.externalId
        && branch.status === expected.status)
    assert(match.length === 1, `Committed branch does not exactly match the plan: ${expected.name}`)
  }

  return {
    createdBranchCount: created.length,
    tenantBranchCountBefore: (before.branches as JsonRow[]).length,
    tenantBranchCountAfter: afterBranches.length,
    protectedCountsUnchanged: true,
    existingTenantBranchesUnchanged: true,
    otherTenantsWritten: 0,
  }
}

function safeSnapshot(state: JsonRow): JsonRow {
  return {
    organization: state.organization,
    branches: state.branches,
    protectedCounts: state.protectedCounts,
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
    if (opts.verify) {
      const liveBranches = (state.branches as JsonRow[]).filter((branch) =>
        branch.external_source === SOURCE_SYSTEM
          && SOURCE_LOCATIONS.some((source) => source.externalId === String(branch.external_id)))
      assert(liveBranches.length === SOURCE_LOCATIONS.length, `Expected ${SOURCE_LOCATIONS.length} live branches, found ${liveBranches.length}`)
      for (const expected of SOURCE_LOCATIONS) {
        const matches = liveBranches.filter((branch) =>
          branch.organization_id === ORGANIZATION.id
            && branch.name === expected.name
            && branch.external_id === expected.externalId
            && branch.status === "active")
        assert(matches.length === 1, `Live branch verification failed for ${expected.externalId}:${expected.name}`)
      }
      await client.query("ROLLBACK")
      console.log(JSON.stringify({
        mode: "VERIFIED",
        organization: ORGANIZATION,
        tenantBranchCount: (state.branches as JsonRow[]).length,
        branches: liveBranches.map((branch) => ({
          id: branch.id,
          name: branch.name,
          code: branch.code,
          externalSource: branch.external_source,
          externalId: branch.external_id,
          status: branch.status,
        })),
      }, null, 2))
      return
    }
    const plan = buildPlan(state, evidence)
    await client.query("ROLLBACK")

    const planSha256 = sha256(plan)
    const preflight = {
      kind: "KE_MISSING_BRANCHES_ADD",
      mode: opts.commit ? "COMMIT_REQUESTED" : "DRY_RUN",
      generatedAt: new Date().toISOString(),
      organization: ORGANIZATION,
      planSha256,
      summary: {
        createdBranches: plan.branchesToCreate.length,
        changedUsers: 0,
        changedOrders: 0,
        changedBudgets: 0,
        changedInventoryAssignments: 0,
        otherTenantsWritten: 0,
      },
      requiredCommitArguments: {
        confirmOrganization: CONFIRM_ORGANIZATION,
        confirmPlanSha256: planSha256,
        expectedCreatedBranches: SOURCE_LOCATIONS.length,
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
        branchesToCreate: plan.branchesToCreate,
        requiredCommitArguments: preflight.requiredCommitArguments,
      }, null, 2))
      return
    }

    assert(opts.confirmOrganization === CONFIRM_ORGANIZATION, `--confirm-organization must equal ${CONFIRM_ORGANIZATION}`)
    assert(opts.confirmPlanSha256 === planSha256, "--confirm-plan-sha256 does not match the current live plan")
    assert(opts.expectedCreatedBranches === SOURCE_LOCATIONS.length, `--expected-created-branches must equal ${SOURCE_LOCATIONS.length}`)

    const snapshotPath = resolve(`backups/ke-missing-branches-pre-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
    writeJson(snapshotPath, safeSnapshot(state))

    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
    try {
      await client.query("select pg_advisory_xact_lock(hashtext('oneflowe:branch-creation'), $1::integer)", [ORGANIZATION.id])
      const lockedState = await loadState(client)
      const lockedPlan = buildPlan(lockedState, evidence)
      assert(sha256(lockedPlan) === planSha256, "Live branch plan changed after confirmation")
      const commitResult = await applyPlan(client, lockedPlan)
      const validation = await validateCommittedState(client, lockedState, lockedPlan, commitResult)
      await client.query("COMMIT")

      try {
        const { invalidateByPrefix } = await import("../lib/cache-utils")
        await invalidateByPrefix("branches")
      } catch {
        // The database is authoritative; normal cache TTL remains a fallback.
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
        validation,
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
