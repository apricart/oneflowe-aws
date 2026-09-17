#!/usr/bin/env tsx
/** Import the K-Electric imprest sheet's branches and portal accounts.
 *
 * Default mode reads the database and prints a plan. A live write requires the
 * exact current plan digest, tenant identity, and expected insert counts.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import { Client } from "pg"
import * as XLSX from "xlsx"

import { generateImportPassword, hashImportPassword } from "../lib/password-cli"
import {
  planImprestAccounts,
  type ImprestAccount,
  type ImprestPlanOptions,
  type ImprestPortalRow,
} from "../lib/ke-imprest-portal-plan"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
const CONFIRM_ORGANIZATION = "10:0001:K-Electric"
const EXTERNAL_SOURCE = "KE_IMPREST_PORTAL"
const CITY = "Karachi"
const PROVINCE = "Sindh"

type BranchPlan = {
  rowNumber: number
  name: string
  address: string
  code: string | null
  existingId: number | null
  status: "create" | "existing"
}

type Plan = {
  sourceFile: string
  sourceSha256: string
  organization: typeof ORGANIZATION
  options: ImprestPlanOptions
  branches: BranchPlan[]
  accounts: Array<ImprestAccount & { roleId: number }>
  sourceCorrection: { rowNumber: number; employeeNumber: string }
}

type DbRow = Record<string, any>

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function normalizedHeader(value: unknown): string {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "")
}

function cell(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ")
}

function readWorkbook(file: string): { rows: ImprestPortalRow[]; sourceSha256: string } {
  assert(existsSync(file), `Workbook not found: ${file}`)
  const sourceSha256 = sha256(readFileSync(file))
  const workbook = XLSX.readFile(file, { cellDates: false })
  assert(workbook.SheetNames.length === 1, "Expected one worksheet")
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false })
  const expected = ["sno", "department", "employee", "branchadminname", "branchadminemail", "address", "contactdetails", "orderportalusername", "orderportaluseremail"]
  assert(grid.length > 1 && expected.every((header, i) => normalizedHeader(grid[0]?.[i]) === header),
    "Workbook columns differ from the reviewed K-Electric imprest sheet")
  const rows = grid.slice(1).map((line, index): ImprestPortalRow => ({
    rowNumber: index + 2,
    branchName: cell(line[1]),
    employeeNumber: cell(line[2]),
    adminName: cell(line[3]),
    adminEmail: cell(line[4]).toLowerCase(),
    address: cell(line[5]),
    contact: cell(line[6]),
    ordererName: cell(line[7]),
    ordererEmail: cell(line[8]).toLowerCase(),
  })).filter((row) => row.branchName || row.adminEmail || row.ordererEmail)
  assert(rows.length === 31, `Expected 31 reviewed rows, found ${rows.length}`)
  const uthal = rows.find((row) => row.rowNumber === 27)
  assert(uthal?.branchName === "Uthal- Customer Service" && uthal.employeeNumber === "80013796-0",
    "The reviewed Uthal row changed; check the user's employee-number correction")
  // Employee numbers are evidence only: repeated people may carry different
  // row values, so this import does not write users.employee_id.
  return { rows, sourceSha256 }
}

async function query(client: Client, sql: string, parameters: unknown[] = []): Promise<DbRow[]> {
  return (await client.query(sql, parameters)).rows
}

function options(): ImprestPlanOptions {
  const repeatedAdminOrderer = arg("--repeated-admin-orderer") ?? "yes"
  const separateRepeatedNamedOrderer = arg("--separate-repeated-named-orderer") ?? "no"
  const groupContact = arg("--group-contact") ?? "first"
  assert(["yes", "no"].includes(repeatedAdminOrderer), "--repeated-admin-orderer must be yes or no")
  assert(["yes", "no"].includes(separateRepeatedNamedOrderer), "--separate-repeated-named-orderer must be yes or no")
  assert(["blank", "first"].includes(groupContact), "--group-contact must be blank or first")
  return {
    repeatedAdminOrderer: repeatedAdminOrderer === "yes",
    separateRepeatedNamedOrderer: separateRepeatedNamedOrderer === "yes",
    groupContact: groupContact as "blank" | "first",
  }
}

async function buildPlan(client: Client, file: string, importOptions: ImprestPlanOptions): Promise<Plan> {
  const { rows, sourceSha256 } = readWorkbook(file)
  const accounts = planImprestAccounts(rows, importOptions)
  const [organization] = await query(client,
    "select id, code, name, status from organizations where id = $1", [ORGANIZATION.id])
  assert(organization?.id === ORGANIZATION.id && organization.code === ORGANIZATION.code
    && organization.name === ORGANIZATION.name && organization.status === "active",
  "Database is not the active K-Electric tenant 10/0001")

  const liveBranches = await query(client,
    "select id, name, code, status from branches where organization_id = $1 order by id", [ORGANIZATION.id])
  const roles = await query(client, "select id, name from roles where name = any($1::text[])",
    [["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "GROUP_ORDER_PORTAL"]])
  const liveUsernames = await query(client, `select username, 'user' as source from users where username = any($1::text[])
      union all select username, 'employee' from employee_credentials where username = any($1::text[])`,
  [accounts.map((account) => account.username)])
  const liveEmails = await query(client,
    "select email, organization_id, external_source, username from users where lower(email) = any($1::text[]) and deleted_at is null",
    [[...new Set(accounts.map((account) => account.email))]])
  assert(liveUsernames.length === 0,
    `Planned username already exists: ${liveUsernames.map((row) => row.username).join(", ")}`)
  const sameTenantEmails = liveEmails.filter((row) => row.organization_id === ORGANIZATION.id)
  assert(sameTenantEmails.length === 0,
    `K-Electric already has accounts on workbook email(s): ${[...new Set(sameTenantEmails.map((row) => row.email))].join(", ")}`)
  const otherTenantEmailLogins = liveEmails.filter((row) => row.organization_id !== ORGANIZATION.id && row.external_source == null)
  assert(otherTenantEmailLogins.length === 0,
    `An account in another tenant signs in by a workbook email: ${[...new Set(otherTenantEmailLogins.map((row) => row.email))].join(", ")}`)

  const roleIds = new Map(roles.map((row) => [String(row.name), Number(row.id)]))
  for (const account of accounts) assert(roleIds.has(account.role), `Missing database role ${account.role}`)
  const existingCodes = new Set(liveBranches.map((row) => String(row.code ?? "")))
  let nextCode = liveBranches.length + 1
  const branches: BranchPlan[] = rows.map((row) => {
    const matching = liveBranches.filter((branch) => String(branch.name).trim().toLowerCase() === row.branchName.toLowerCase())
    assert(matching.length <= 1, `More than one branch matches ${row.branchName}`)
    if (matching.length) {
      assert(matching[0].status === "active", `Existing branch ${row.branchName} is not active`)
      return { rowNumber: row.rowNumber, name: row.branchName, address: row.address,
        code: matching[0].code ?? null, existingId: Number(matching[0].id), status: "existing" }
    }
    let code = `${ORGANIZATION.code}-${String(nextCode++).padStart(2, "0")}`
    while (existingCodes.has(code)) code = `${ORGANIZATION.code}-${String(nextCode++).padStart(2, "0")}`
    existingCodes.add(code)
    return { rowNumber: row.rowNumber, name: row.branchName, address: row.address,
      code, existingId: null, status: "create" }
  })
  return {
    sourceFile: basename(file), sourceSha256, organization: ORGANIZATION, options: importOptions,
    branches, accounts: accounts.map((account) => ({ ...account, roleId: roleIds.get(account.role)! })),
    sourceCorrection: { rowNumber: 27, employeeNumber: "80013796-0" },
  }
}

function summary(plan: Plan) {
  const roleCounts = Object.fromEntries(["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "GROUP_ORDER_PORTAL"]
    .map((role) => [role, plan.accounts.filter((account) => account.role === role).length]))
  return {
    branchesToCreate: plan.branches.filter((branch) => branch.status === "create").length,
    branchesToReuse: plan.branches.filter((branch) => branch.status === "existing").length,
    usersToCreate: plan.accounts.length,
    roleCounts,
    branchAssignments: plan.accounts.filter((account) => account.role.startsWith("GROUP_"))
      .reduce((total, account) => total + account.branchNames.length, 0),
  }
}

async function audit(client: Client, action: string, resourceType: string, resourceId: string,
  branchId: number | null, details: Record<string, unknown>): Promise<void> {
  await client.query(`insert into system_logs
    (user_role, organization_id, branch_id, action, resource_type, resource_id, details, success)
    values ('SYSTEM', $1, $2, $3, $4, $5, $6::jsonb, true)`,
  [ORGANIZATION.id, branchId, action, resourceType, resourceId, JSON.stringify(details)])
}

async function commit(client: Client, file: string, importOptions: ImprestPlanOptions, digest: string,
  credentialsPath: string, reviewedPlan: Plan) {
  const passwords = new Map(reviewedPlan.accounts.map((account) => [account.username, generateImportPassword(20)]))
  const hashes = new Map<string, string>()
  for (const [username, password] of passwords) hashes.set(username, await hashImportPassword(password))
  let credentialsCreated = false
  let commitAttempted = false
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
  try {
    await client.query("select pg_advisory_xact_lock(hashtext('oneflowe:branch-creation'), $1::integer)", [ORGANIZATION.id])
    await client.query("select pg_advisory_xact_lock(hashtext('oneflowe:user-import'))")
    const plan = await buildPlan(client, file, importOptions)
    assert(sha256(canonical(plan)) === digest, "Live plan changed after dry run; no records created")
    assert(!existsSync(credentialsPath), `Credential file already exists: ${credentialsPath}`)
    mkdirSync(dirname(credentialsPath), { recursive: true })
    writeFileSync(credentialsPath, `${JSON.stringify({
      organization: ORGANIZATION, sourceFile: plan.sourceFile, planSha256: digest,
      warning: "Accounts sign in by username and must change their password on first sign-in.",
      accounts: plan.accounts.map((account) => ({ username: account.username, password: passwords.get(account.username),
        email: account.email, role: account.role, branches: account.branchNames })),
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    credentialsCreated = true

    const branchIds = new Map<string, number>()
    const createdBranches: Array<{ id: number; name: string; code: string | null }> = []
    for (const branch of plan.branches) {
      if (branch.existingId != null) {
        branchIds.set(branch.name, branch.existingId)
        continue
      }
      const [created] = await query(client, `insert into branches
        (organization_id, name, province, city, address, code, status, baseline_budget_cents)
        values ($1, $2, $3, $4, $5, $6, 'active', 0) returning id`,
      [ORGANIZATION.id, branch.name, PROVINCE, CITY, branch.address, branch.code])
      assert(created, `Failed to create branch ${branch.name}`)
      const id = Number(created.id)
      branchIds.set(branch.name, id)
      createdBranches.push({ id, name: branch.name, code: branch.code })
      await client.query(`insert into audit_logs
        (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
        values (null, $1, $2, 'CREATE_BRANCH', 'BRANCH', $3, $4::jsonb)`,
      [ORGANIZATION.id, id, String(id), JSON.stringify({ source: EXTERNAL_SOURCE,
        sourceFile: plan.sourceFile, sourceRow: branch.rowNumber, planSha256: digest,
        name: branch.name, code: branch.code })])
    }

    let assignmentsCreated = 0
    const createdUsers: Array<{ id: string; username: string; role: string; branchIds: number[] }> = []
    for (const account of plan.accounts) {
      const isGroup = account.role === "GROUP_USER" || account.role === "GROUP_ORDER_PORTAL"
      const singleBranchId = isGroup ? null : branchIds.get(account.branchNames[0]) ?? null
      assert(isGroup || singleBranchId != null, `Missing branch assignment for ${account.username}`)
      const [created] = await query(client, `insert into users
        (email, username, password_hash, role_id, is_active, full_name, first_name, last_name,
         phone, organization_id, branch_id, address, location, must_change_password, external_source, external_id)
        values ($1,$2,$3,$4,true,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14) returning id`,
      [account.email, account.username, hashes.get(account.username), account.roleId, account.fullName,
        account.firstName, account.lastName, account.phone, ORGANIZATION.id, singleBranchId,
        account.address, isGroup ? null : account.branchNames[0], EXTERNAL_SOURCE, account.email])
      assert(created, `Failed to create user ${account.username}`)
      const userId = String(created.id)
      const assignedBranchIds: number[] = []
      if (isGroup) {
        for (const branchName of account.branchNames) {
          const branchId = branchIds.get(branchName)
          assert(branchId != null, `Missing group branch ${branchName}`)
          await client.query(`insert into user_branch_assignments
            (user_id, branch_id, organization_id, created_by_user_id) values ($1,$2,$3,null)`,
          [userId, branchId, ORGANIZATION.id])
          assignmentsCreated++
          assignedBranchIds.push(branchId)
        }
      } else if (singleBranchId != null) {
        assignedBranchIds.push(singleBranchId)
      }
      createdUsers.push({ id: userId, username: account.username, role: account.role, branchIds: assignedBranchIds })
      await audit(client, "KE_IMPREST_USER_CREATE", "user", userId, singleBranchId,
        { sourceFile: plan.sourceFile, sourceRows: account.sourceRows, planSha256: digest,
          role: account.role, username: account.username, assignedBranchNames: account.branchNames })
    }
    const [verified] = await query(client, `select count(*)::int as users_created from users
      where organization_id=$1 and external_source=$2 and username=any($3::text[])`,
    [ORGANIZATION.id, EXTERNAL_SOURCE, plan.accounts.map((account) => account.username)])
    assert(Number(verified?.users_created) === plan.accounts.length, "User verification failed before commit")
    commitAttempted = true
    await client.query("COMMIT")
    return { branchesCreated: createdBranches.length, usersCreated: createdUsers.length,
      assignmentsCreated, createdBranches, createdUsers }
  } catch (error) {
    try { await client.query("ROLLBACK") } catch { /* Preserve the original error. */ }
    if (credentialsCreated && !commitAttempted && existsSync(credentialsPath)) {
      try { unlinkSync(credentialsPath) } catch { /* Report the original import error. */ }
    }
    if (commitAttempted) {
      throw new Error(`Commit result is uncertain; inspect live records before retrying. Credentials retained at ${credentialsPath}.`, { cause: error })
    }
    throw error
  }
}

async function main(): Promise<void> {
  const file = resolve(arg("--file") ?? "")
  assert(arg("--file"), "--file <reviewed workbook path> is required")
  assert(process.env.DATABASE_URL, "DATABASE_URL is missing")
  const importOptions = options()
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    await client.query("BEGIN READ ONLY")
    const plan = await buildPlan(client, file, importOptions)
    await client.query("ROLLBACK")
    const digest = sha256(canonical(plan))
    const counts = summary(plan)
    if (!process.argv.includes("--commit")) {
      console.log(JSON.stringify({ mode: "DRY_RUN", planSha256: digest, summary: counts,
        sourceFile: plan.sourceFile, sourceSha256: plan.sourceSha256, options: importOptions,
        branches: plan.branches, accounts: plan.accounts.map(({ roleId: _roleId, ...account }) => account),
        sourceCorrection: plan.sourceCorrection,
        requiredCommitArguments: ["--commit", `--confirm-organization=${CONFIRM_ORGANIZATION}`,
          `--confirm-plan-sha256=${digest}`, `--expected-branches=${counts.branchesToCreate}`,
          `--expected-users=${counts.usersToCreate}`, "--credentials-output=<path under tmp>"],
      }, null, 2))
      return
    }
    assert(arg("--confirm-organization") === CONFIRM_ORGANIZATION,
      `--confirm-organization must be ${CONFIRM_ORGANIZATION}`)
    assert(arg("--confirm-plan-sha256") === digest, "Plan digest differs from dry run")
    assert(Number(arg("--expected-branches")) === counts.branchesToCreate, "Branch insert count differs from dry run")
    assert(Number(arg("--expected-users")) === counts.usersToCreate, "User insert count differs from dry run")
    const output = arg("--credentials-output")
    assert(output, "--credentials-output is required")
    const credentialsPath = resolve(output)
    const tmpRoot = resolve("tmp")
    assert(credentialsPath.startsWith(`${tmpRoot}\\`) && credentialsPath.endsWith(".json"),
      "Credential output must be a new .json file under this workspace's tmp directory")
    const result = await commit(client, file, importOptions, digest, credentialsPath, plan)
    const reportPath = resolve("tmp", `ke-imprest-commit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
    try {
      writeFileSync(reportPath, `${JSON.stringify({ planSha256: digest, sourceSha256: plan.sourceSha256,
        organization: ORGANIZATION, summary: counts, result }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    } catch (error) {
      console.error(`Committed successfully, but could not save the report: ${String(error)}`)
    }
    try {
      const { invalidateCachePrefixes } = await import("../lib/cache-cli")
      await invalidateCachePrefixes(["branches", "users"])
    } catch {
      // The database is authoritative; cache entries expire normally.
    }
    console.log(JSON.stringify({ mode: "COMMITTED", planSha256: digest,
      summary: { branchesCreated: result.branchesCreated, usersCreated: result.usersCreated,
        assignmentsCreated: result.assignmentsCreated }, reportPath, credentialsPath }, null, 2))
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
