#!/usr/bin/env tsx
/**
 * Corrects `users.full_name`, `users.first_name` and `users.last_name` from a
 * reviewed copy of the portal's own user-directory export (Users -> Export ->
 * Export as Excel).
 *
 * The export carries no user id, and an email is not unique in a mirrored
 * tenant — one K-Electric address can front nine different people, one account
 * per role. Rows are therefore matched on (email, role, branch), refused unless
 * that key resolves to exactly one row on both sides, and confirmed against
 * `phone` before anything is written. The rules live in
 * `lib/user-name-correction.ts` and are unit-tested there; this script only
 * supplies rows, gates the tenant, and performs the write.
 *
 * Default mode is a read-only preflight. Commit is checksum-gated, runs in one
 * transaction, re-verifies every target row under lock before writing, and
 * records a `system_logs` entry per corrected account. A committed report feeds
 * the guarded --rollback mode.
 *
 *   npm run fix:user-names
 *   npm run fix:user-names -- --commit --confirm-plan-sha256=<digest> --operator=you@example.com
 *   npm run fix:user-names -- --rollback=deliverables/<committed report>.json --operator=you@example.com
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"
import * as XLSX from "xlsx"

import {
  buildNameCorrectionPlan,
  canonicalJson,
  branchKey,
  emailKey,
  text,
  type NameCorrectionPlan,
  type PlanRow,
  type SheetRow,
  type UserRow,
} from "../lib/user-name-correction"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const DEFAULT_ORGANIZATION_CODE = "0001"
const DEFAULT_SHEET = "users-export-1788975177804.xlsx"
const ADVISORY_LOCK = 700011
const AUDIT_ACTION = "USER_NAME_CORRECTION"

type JsonRow = Record<string, unknown>

interface Organization {
  id: number
  code: string
  name: string
}

interface Sheet {
  rows: SheetRow[]
  /** The single tenant the sheet describes; gated against the target organization. */
  organization: string
}

/* ------------------------------------------------------------------ helpers */

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function rows<T>(client: PoolClient, query: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(query, params)).rows as T[]
}

function planDigest(plan: PlanRow[]): string {
  return sha256(canonicalJson(plan))
}

/* -------------------------------------------------------------------- input */

function readSheet(path: string): Sheet {
  assert(existsSync(path), `Spreadsheet not found: ${path}`)
  const workbook = XLSX.readFile(path)
  const sheetName = workbook.SheetNames[0]
  assert(sheetName, "Workbook contains no sheets")
  const raw = XLSX.utils.sheet_to_json<JsonRow>(workbook.Sheets[sheetName]!, { defval: "" })
  assert(raw.length > 0, "Workbook first sheet is empty")

  for (const column of ["Name", "Email", "Role", "Branch", "Phone", "Organization"]) {
    assert(column in raw[0]!, `Sheet is missing the "${column}" column — is this the user-directory export?`)
  }

  const organizations = new Set(raw.map((row) => text(row.Organization)))
  assert(organizations.size === 1,
    `Sheet spans ${organizations.size} organizations (${[...organizations].join(", ")}); this script writes one tenant at a time`)

  return {
    organization: [...organizations][0]!,
    rows: raw.map((row, index) => ({
      index,
      name: text(row.Name),
      email: text(row.Email),
      role: text(row.Role).toUpperCase(),
      branch: text(row.Branch),
      phone: text(row.Phone),
    })),
  }
}

/* --------------------------------------------------------------- tenant gate */

async function organization(client: PoolClient, code: string, expectedName: string): Promise<Organization> {
  const [row] = await rows<JsonRow>(client,
    "select id, code, name, status from organizations where code = $1", [code])
  assert(row, `No organization with code ${code}`)
  assert(text(row.name).toLowerCase() === expectedName.toLowerCase(),
    `Organization ${code} is "${String(row.name)}" but the sheet describes "${expectedName}" — refusing to touch a different tenant`)
  return { id: Number(row.id), code: String(row.code), name: String(row.name) }
}

const USER_COLUMNS = `
  u.id, u.email, u.username, u.employee_id, u.full_name, u.first_name, u.last_name,
  u.phone, r.name as role, b.name as branch
`

function toUserRow(row: JsonRow): UserRow {
  return {
    id: String(row.id),
    email: String(row.email ?? ""),
    username: (row.username as string | null) ?? null,
    employeeId: (row.employee_id as string | null) ?? null,
    fullName: (row.full_name as string | null) ?? null,
    firstName: (row.first_name as string | null) ?? null,
    lastName: (row.last_name as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    role: String(row.role ?? ""),
    branch: (row.branch as string | null) ?? null,
  }
}

async function readUsers(client: PoolClient, organizationId: number): Promise<UserRow[]> {
  const result = await rows<JsonRow>(client, `
    select ${USER_COLUMNS}
      from users u
      join roles r on r.id = u.role_id
      left join branches b on b.id = u.branch_id
     where u.organization_id = $1
       and u.deleted_at is null
     order by u.id
  `, [organizationId])
  return result.map(toUserRow)
}

/* ------------------------------------------------------------------- report */

function baseReport(org: Organization, sheetPath: string, built: NameCorrectionPlan): JsonRow {
  const digest = planDigest(built.plan)
  return {
    generatedAt: new Date().toISOString(),
    source: sheetPath,
    organization: org,
    planSha256: digest,
    summary: {
      sheetRows: built.plan.length + built.skipped.length + built.unchanged,
      toUpdate: built.plan.length,
      alreadyCorrect: built.unchanged,
      skipped: built.skipped.length,
      databaseAccountsNotInSheet: built.unmatchedDbUsers.length,
      singleTokenNames: built.plan.filter((row) => row.after.lastName === null).length,
    },
    requiredCommitArguments: ["--commit", `--confirm-plan-sha256=${digest}`, "--operator=<your email>"],
    plan: built.plan,
    skipped: built.skipped,
    unmatchedDbUsers: built.unmatchedDbUsers,
  }
}

/* ------------------------------------------------------------------ actions */

async function preflight(client: PoolClient, sheetPath: string, code: string): Promise<void> {
  const sheet = readSheet(sheetPath)
  const org = await organization(client, code, sheet.organization)
  const built = buildNameCorrectionPlan(sheet.rows, await readUsers(client, org.id))
  const report = baseReport(org, sheetPath, built)
  const output = resolve(arg("--output") ?? "deliverables/user-name-correction-preflight.json")
  saveJson(output, report)
  console.log(JSON.stringify({
    mode: "DRY_RUN",
    output,
    organization: `${org.id}:${org.code}:${org.name}`,
    planSha256: report.planSha256,
    summary: report.summary,
    requiredCommitArguments: report.requiredCommitArguments,
  }, null, 2))
}

async function auditWrite(
  client: PoolClient,
  action: string,
  operator: string,
  organizationId: number,
  userId: string,
  details: JsonRow,
): Promise<void> {
  await client.query(`
    insert into system_logs (user_id, user_role, user_email, organization_id, action, resource_type, resource_id, details, success)
    values (null, 'SUPER_ADMIN', $1, $2, $3, 'user', $4, $5::jsonb, true)
  `, [operator, organizationId, action, userId, JSON.stringify(details)])
}

async function commit(client: PoolClient, sheetPath: string, code: string): Promise<void> {
  const operator = arg("--operator")
  assert(operator && /.+@.+/.test(operator), "--operator=<your email> is required so the audit trail names a person")

  const sheet = readSheet(sheetPath)
  const org = await organization(client, code, sheet.organization)
  const built = buildNameCorrectionPlan(sheet.rows, await readUsers(client, org.id))
  const digest = planDigest(built.plan)
  assert(arg("--confirm-plan-sha256") === digest,
    `--confirm-plan-sha256 does not match the current plan (${digest}). Re-run the preflight and pass the digest it prints.`)
  assert(built.plan.length > 0, "Nothing to update")

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])

    // Re-read under lock: the plan must still describe the rows about to change.
    const locked = (await rows<JsonRow>(client, `
      select ${USER_COLUMNS}
        from users u
        join roles r on r.id = u.role_id
        left join branches b on b.id = u.branch_id
       where u.id = any($1::uuid[])
         and u.organization_id = $2
         and u.deleted_at is null
       for update of u
    `, [built.plan.map((row) => row.userId), org.id])).map(toUserRow)

    const lockedById = new Map(locked.map((user) => [user.id, user]))
    assert(lockedById.size === built.plan.length,
      `Expected ${built.plan.length} target accounts under lock but found ${lockedById.size}`)

    for (const row of built.plan) {
      const user = lockedById.get(row.userId)
      assert(user, `Account ${row.userId} disappeared between plan and commit`)
      assert(
        emailKey(user.email) === emailKey(row.email)
          && text(user.role).toUpperCase() === row.role
          && branchKey(user.branch) === branchKey(row.branch),
        `Account ${row.userId} no longer matches its planned identity; aborting`)
      assert(
        user.fullName === row.before.fullName
          && user.firstName === row.before.firstName
          && user.lastName === row.before.lastName,
        `Account ${row.userId} changed after the plan was built; aborting`)
    }

    for (const row of built.plan) {
      const result = await client.query(`
        update users
           set full_name = $2, first_name = $3, last_name = $4, updated_at = now()
         where id = $1
           and organization_id = $5
           and deleted_at is null
           and full_name is not distinct from $6
           and first_name is not distinct from $7
           and last_name is not distinct from $8
      `, [row.userId, row.after.fullName, row.after.firstName, row.after.lastName, org.id,
        row.before.fullName, row.before.firstName, row.before.lastName])
      assert(result.rowCount === 1, `Update of account ${row.userId} affected ${result.rowCount} rows`)

      await auditWrite(client, AUDIT_ACTION, operator, org.id, row.userId, {
        source: sheetPath,
        planSha256: digest,
        before: row.before,
        after: row.after,
        matchedOn: { email: row.email, role: row.role, branch: row.branch },
      })
    }

    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }

  const output = resolve(arg("--output") ?? `deliverables/user-name-correction-committed-${Date.now()}.json`)
  saveJson(output, {
    ...baseReport(org, sheetPath, built),
    mode: "COMMITTED",
    committedAt: new Date().toISOString(),
    operator,
  })
  console.log(JSON.stringify({
    mode: "COMMITTED",
    output,
    organization: `${org.id}:${org.code}:${org.name}`,
    planSha256: digest,
    updated: built.plan.length,
    skipped: built.skipped.length,
    rollbackWith: `--rollback=${output} --operator=${operator}`,
  }, null, 2))
}

async function rollback(client: PoolClient, reportPath: string): Promise<void> {
  const operator = arg("--operator")
  assert(operator && /.+@.+/.test(operator), "--operator=<your email> is required for a rollback")

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    plan: PlanRow[]
    organization: Organization
    planSha256: string
  }
  assert(Array.isArray(report.plan) && report.plan.length > 0, "Report contains no plan to reverse")

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    for (const row of report.plan) {
      const result = await client.query(`
        update users
           set full_name = $2, first_name = $3, last_name = $4, updated_at = now()
         where id = $1
           and organization_id = $5
           and deleted_at is null
           and full_name is not distinct from $6
           and first_name is not distinct from $7
           and last_name is not distinct from $8
      `, [row.userId, row.before.fullName, row.before.firstName, row.before.lastName, report.organization.id,
        row.after.fullName, row.after.firstName, row.after.lastName])
      assert(result.rowCount === 1,
        `Account ${row.userId} no longer holds the values this report wrote; refusing to overwrite a later change`)

      await auditWrite(client, `${AUDIT_ACTION}_ROLLBACK`, operator, report.organization.id, row.userId, {
        reversedPlanSha256: report.planSha256,
        restored: row.before,
        from: row.after,
      })
    }
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }

  console.log(JSON.stringify({ mode: "ROLLED_BACK", report: reportPath, restored: report.plan.length }, null, 2))
}

async function main(): Promise<void> {
  const sheetPath = resolve(arg("--file") ?? DEFAULT_SHEET)
  const code = arg("--organization-code") ?? DEFAULT_ORGANIZATION_CODE
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    const rollbackPath = arg("--rollback")
    if (rollbackPath) await rollback(client, resolve(rollbackPath))
    else if (process.argv.includes("--commit")) await commit(client, sheetPath, code)
    else await preflight(client, sheetPath, code)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
