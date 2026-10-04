#!/usr/bin/env tsx
/**
 * Rebuilds `users.username` as `<first name>-<employee code>-<ba|op>` for the
 * Branch Admin and Order Portal accounts of one tenant.
 *
 * This changes how people sign in. A mirrored account (`external_source` set)
 * cannot authenticate by email address at all, so its username is the only
 * credential it has — every account this touches needs to be told its new one.
 * The committed report is the old -> new mapping to hand out.
 *
 * Two database facts drive the implementation:
 *
 * - `users_username_idx` is unique over the whole table with no partial
 *   predicate, so a generated name must be free across every tenant *and*
 *   across soft-deleted rows. The plan is built against all of them.
 * - That index is immediate, not deferrable. Renames are therefore staged: all
 *   targets are parked on a per-id temporary value first, then given their
 *   final name, so one account can take a name another is giving up without a
 *   transient collision.
 *
 * The rules are pure and unit-tested in `lib/username-generation.ts`; this
 * script supplies rows, gates the tenant, and performs the write.
 *
 * Default mode is a read-only preflight. Commit is checksum-gated, runs in one
 * transaction, re-verifies every target under lock, and records a `system_logs`
 * entry per renamed account. A committed report feeds the guarded --rollback.
 *
 *   npm run fix:usernames -- --organization-code=KE-TEST
 *   npm run fix:usernames -- --organization-code=KE-TEST --commit --confirm-plan-sha256=<digest> --operator=you@example.com
 *   npm run fix:usernames -- --rollback=deliverables/<committed report>.json --operator=you@example.com
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import { employeeCodeOf } from "../lib/legacy-import/ke-sync"
import { canonicalJson } from "../lib/user-name-correction"
import {
  buildUsernamePlan,
  type ExistingUsername,
  type UsernamePlan,
  type UsernamePlanRow,
  type UsernameSourceRow,
} from "../lib/username-generation"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ADVISORY_LOCK = 700012
const AUDIT_ACTION = "USER_USERNAME_REGENERATION"
/** Parking value used between the two write phases; never a real username. */
const STAGING_PREFIX = "pending-rename-"

type JsonRow = Record<string, unknown>

interface Organization {
  id: number
  code: string
  name: string
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

function planDigest(plan: UsernamePlanRow[]): string {
  return sha256(canonicalJson(plan))
}

/* --------------------------------------------------------------- reading in */

async function organization(client: PoolClient, code: string): Promise<Organization> {
  const [row] = await rows<JsonRow>(client,
    "select id, code, name, status from organizations where code = $1", [code])
  assert(row, `No organization with code ${code}`)
  assert(String(row.status).toLowerCase() === "active", `Organization ${code} is not active`)
  return { id: Number(row.id), code: String(row.code), name: String(row.name) }
}

/** Where an account's employee code was found; carried into the report. */
type CodeSource = "external_id" | "employee_id" | "username_stem" | "none"

/**
 * The employee code, which the rule uses to make a username unique.
 *
 * `employee_id` is empty on every mirrored K-Electric account, so the code has
 * to come from where the sync actually put it: `external_id`, or failing that
 * the stem of the current username, which `employeeCodeOf` already knows how to
 * read — reusing it rather than re-deriving the suffix rules here.
 */
function resolveEmployeeCode(row: JsonRow): { code: string | null; source: CodeSource } {
  const externalSource = String(row.external_source ?? "").trim()
  const externalId = String(row.external_id ?? "").trim()
  if (externalSource && externalId) return { code: externalId, source: "external_id" }

  const employeeId = String(row.employee_id ?? "").trim()
  if (employeeId) return { code: employeeId, source: "employee_id" }

  const stem = employeeCodeOf(row.username as string | null)
  if (stem) return { code: stem, source: "username_stem" }

  return { code: null, source: "none" }
}

async function readTargets(
  client: PoolClient,
  organizationId: number,
): Promise<{ targets: UsernameSourceRow[]; codeSourceById: Map<string, CodeSource> }> {
  const result = await rows<JsonRow>(client, `
    select u.id, u.email, r.name as role, u.first_name, u.full_name,
           u.employee_id, u.external_source, u.external_id, u.username, b.name as branch
      from users u
      join roles r on r.id = u.role_id
      left join branches b on b.id = u.branch_id
     where u.organization_id = $1
       and u.deleted_at is null
     order by u.id
  `, [organizationId])

  const codeSourceById = new Map<string, CodeSource>()
  const targets = result.map((row) => {
    const { code, source } = resolveEmployeeCode(row)
    codeSourceById.set(String(row.id), source)
    return {
      id: String(row.id),
      email: String(row.email ?? ""),
      role: String(row.role ?? ""),
      firstName: (row.first_name as string | null) ?? null,
      fullName: (row.full_name as string | null) ?? null,
      employeeId: code,
      username: (row.username as string | null) ?? null,
      branch: (row.branch as string | null) ?? null,
    }
  })

  return { targets, codeSourceById }
}

/**
 * Every row in the table, soft-deleted and other tenants included: the unique
 * index carries no predicate, so all of them can block a generated name.
 */
async function readAllUsernames(client: PoolClient): Promise<ExistingUsername[]> {
  const result = await rows<JsonRow>(client, "select id, username from users")
  return result.map((row) => ({ id: String(row.id), username: (row.username as string | null) ?? null }))
}

/* ------------------------------------------------------------------- report */

function baseReport(org: Organization, built: UsernamePlan, codeSourceById: Map<string, CodeSource>): JsonRow {
  const digest = planDigest(built.plan)
  const codeSources: Record<string, number> = {}
  for (const row of [...built.plan, ...built.skipped]) {
    const source = codeSourceById.get(row.userId) ?? "none"
    codeSources[source] = (codeSources[source] ?? 0) + 1
  }
  return {
    generatedAt: new Date().toISOString(),
    organization: org,
    planSha256: digest,
    rule: "<first name>-<employee code>-<ba|op>",
    summary: {
      accountsConsidered: built.plan.length + built.skipped.length + built.unchanged,
      toRename: built.plan.length,
      alreadyCorrect: built.unchanged,
      skipped: built.skipped.length,
      employeeCodeReadFrom: codeSources,
    },
    warning:
      "Mirrored accounts sign in by username only. Every renamed account must be told its new username before it can log in again.",
    requiredCommitArguments: ["--commit", `--confirm-plan-sha256=${digest}`, "--operator=<your email>"],
    plan: built.plan,
    skipped: built.skipped,
  }
}

/* ------------------------------------------------------------------ actions */

interface LoadedPlan {
  org: Organization
  built: UsernamePlan
  codeSourceById: Map<string, CodeSource>
}

async function loadPlan(client: PoolClient, code: string): Promise<LoadedPlan> {
  const org = await organization(client, code)
  const [{ targets, codeSourceById }, allAccounts] = await Promise.all([
    readTargets(client, org.id),
    readAllUsernames(client),
  ])

  const staged = allAccounts.filter((account) => String(account.username ?? "").startsWith(STAGING_PREFIX))
  assert(staged.length === 0,
    `${staged.length} account(s) are parked on a ${STAGING_PREFIX}* username, which means an earlier run did not finish. ` +
    `Resolve those before running again: ${staged.map((account) => account.id).join(", ")}`)

  return { org, built: buildUsernamePlan(targets, allAccounts), codeSourceById }
}

async function preflight(client: PoolClient, code: string): Promise<void> {
  const { org, built, codeSourceById } = await loadPlan(client, code)
  const report = baseReport(org, built, codeSourceById)
  const output = resolve(arg("--output") ?? "deliverables/username-regeneration-preflight.json")
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

/**
 * Applies a set of username changes, parking every target on a temporary value
 * first so the immediate unique index cannot fire on an intermediate state.
 * Each write is conditional on the value the plan expects to replace.
 */
async function applyRenames(
  client: PoolClient,
  organizationId: number,
  changes: Array<{ userId: string; from: string | null; to: string }>,
): Promise<void> {
  for (const change of changes) {
    const parked = await client.query(`
      update users set username = $2, updated_at = now()
       where id = $1 and organization_id = $3 and deleted_at is null
         and username is not distinct from $4
    `, [change.userId, `${STAGING_PREFIX}${change.userId}`, organizationId, change.from])
    assert(parked.rowCount === 1,
      `Account ${change.userId} did not hold ${JSON.stringify(change.from)}; aborting before any final name is written`)
  }

  for (const change of changes) {
    const applied = await client.query(`
      update users set username = $2, updated_at = now()
       where id = $1 and organization_id = $3 and deleted_at is null
         and username = $4
    `, [change.userId, change.to, organizationId, `${STAGING_PREFIX}${change.userId}`])
    assert(applied.rowCount === 1, `Account ${change.userId} could not be given ${JSON.stringify(change.to)}`)
  }
}

async function commit(client: PoolClient, code: string): Promise<void> {
  const operator = arg("--operator")
  assert(operator && /.@./.test(operator), "--operator=<your email> is required so the audit trail names a person")

  const { org, built, codeSourceById } = await loadPlan(client, code)
  const digest = planDigest(built.plan)
  assert(arg("--confirm-plan-sha256") === digest,
    `--confirm-plan-sha256 does not match the current plan (${digest}). Re-run the preflight and pass the digest it prints.`)
  assert(built.plan.length > 0, "Nothing to rename")

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])

    const locked = await rows<JsonRow>(client, `
      select u.id, u.username, r.name as role
        from users u
        join roles r on r.id = u.role_id
       where u.id = any($1::uuid[]) and u.organization_id = $2 and u.deleted_at is null
       for update of u
    `, [built.plan.map((row) => row.userId), org.id])

    const lockedById = new Map(locked.map((row) => [String(row.id), row]))
    assert(lockedById.size === built.plan.length,
      `Expected ${built.plan.length} target accounts under lock but found ${lockedById.size}`)

    for (const row of built.plan) {
      const current = lockedById.get(row.userId)
      assert(current, `Account ${row.userId} disappeared between plan and commit`)
      assert(String(current.role).toUpperCase() === row.role,
        `Account ${row.userId} changed role after the plan was built; aborting`)
      assert(((current.username as string | null) ?? null) === row.before,
        `Account ${row.userId} username changed after the plan was built; aborting`)
    }

    await applyRenames(client, org.id,
      built.plan.map((row) => ({ userId: row.userId, from: row.before, to: row.after })))

    for (const row of built.plan) {
      await auditWrite(client, AUDIT_ACTION, operator, org.id, row.userId, {
        planSha256: digest,
        rule: "<first name>-<employee code>-<ba|op>",
        before: row.before,
        after: row.after,
        account: { email: row.email, role: row.role, branch: row.branch, fullName: row.fullName },
      })
    }

    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }

  const output = resolve(arg("--output") ?? `deliverables/username-regeneration-committed-${Date.now()}.json`)
  saveJson(output, { ...baseReport(org, built, codeSourceById), mode: "COMMITTED", committedAt: new Date().toISOString(), operator })
  console.log(JSON.stringify({
    mode: "COMMITTED",
    output,
    organization: `${org.id}:${org.code}:${org.name}`,
    planSha256: digest,
    renamed: built.plan.length,
    skipped: built.skipped.length,
    rollbackWith: `--rollback=${output} --operator=${operator}`,
  }, null, 2))
}

async function rollback(client: PoolClient, reportPath: string): Promise<void> {
  const operator = arg("--operator")
  assert(operator && /.@./.test(operator), "--operator=<your email> is required for a rollback")

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    plan: UsernamePlanRow[]
    organization: Organization
    planSha256: string
  }
  assert(Array.isArray(report.plan) && report.plan.length > 0, "Report contains no plan to reverse")

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])

    await applyRenames(client, report.organization.id,
      report.plan
        .filter((row) => row.before !== null)
        .map((row) => ({ userId: row.userId, from: row.after, to: row.before as string })))

    const withoutPrevious = report.plan.filter((row) => row.before === null)
    for (const row of withoutPrevious) {
      const cleared = await client.query(`
        update users set username = null, updated_at = now()
         where id = $1 and organization_id = $2 and deleted_at is null and username = $3
      `, [row.userId, report.organization.id, row.after])
      assert(cleared.rowCount === 1, `Account ${row.userId} no longer holds ${JSON.stringify(row.after)}`)
    }

    for (const row of report.plan) {
      await auditWrite(client, `${AUDIT_ACTION}_ROLLBACK`, operator, report.organization.id, row.userId, {
        reversedPlanSha256: report.planSha256, restored: row.before, from: row.after,
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
  const code = arg("--organization-code")
  const rollbackPath = arg("--rollback")
  assert(code || rollbackPath, "--organization-code=<code> is required (use scripts/check-orgs.ts to list them)")

  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    if (rollbackPath) await rollback(client, resolve(rollbackPath))
    else if (process.argv.includes("--commit")) await commit(client, code!)
    else await preflight(client, code!)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
