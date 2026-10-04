#!/usr/bin/env tsx
/**
 * Aligns one tenant's accounts to a credential hand-out so that every person
 * can sign in with exactly what the hand-out says: sets `users.username` to the
 * hand-out username and `full_name` / `first_name` / `last_name` to the
 * hand-out name.
 *
 * A row is matched to an account by Login Code (`users.external_id`) plus the
 * portal suffix of its username, or by email and role where the tenant's
 * `external_id` does not carry the code. The row's password is then verified
 * against the stored bcrypt hash and **only a verified row is written** — the
 * password is what proves the row describes that account. The rules are pure
 * and unit-tested in `lib/handout-alignment.ts`.
 *
 * `users_username_idx` is unique over the whole table and immediate, so
 * renames are staged through a per-id parking value, as `regenerate-usernames`
 * does.
 *
 * Default mode is a read-only preflight. Commit is checksum-gated, runs in one
 * transaction, re-verifies every target under lock, and records a
 * `system_logs` entry per account. A committed report feeds the guarded
 * --rollback. Every run also writes an Excel report: planned, blocked,
 * accounts not in the hand-out, and what is deliberately left alone.
 *
 *   npm run align:handout -- --organization-code=0001 --file=user-logins-handout.xlsx
 *   npm run align:handout -- --organization-code=0001 --commit --confirm-plan-sha256=<digest> --operator=you@example.com
 *   npm run align:handout -- --rollback=deliverables/<committed report>.json --operator=you@example.com
 *
 * `--trust-login-codes=<code,code>` plans a row for the named login codes even
 * when its password does not verify, provided the row matched its account by
 * login code (never by the email fallback). This is for a person who has
 * already changed their password: the hand-out username and name still apply,
 * and the password is never written by this script anyway. Each such row is
 * reported as `trusted` in the plan so the exception is visible.
 *
 * `--rollback` accepts `--flag-prefix=<prefix>`: the restored username is
 * written as `<prefix><previous username>` (names are restored as-is), which
 * parks an account that turned out to belong to somebody else under a visible
 * marker — `checking-18716-ba` — until its owner is resolved.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"
import * as XLSX from "xlsx"

import {
  buildAlignmentPlan,
  matchHandoutRows,
  type AlignmentAccount,
  type AlignmentPlan,
  type AlignmentPlanRow,
  type HandoutRow,
  type MatchResult,
  type VerifiedMatch,
} from "../lib/handout-alignment"
import { sanitizeSpreadsheetRecords } from "../lib/spreadsheet"
import { canonicalJson, text } from "../lib/user-name-correction"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const DEFAULT_ORGANIZATION_CODE = "0001"
const DEFAULT_HANDOUT = "user-logins-handout.xlsx"
const ADVISORY_LOCK = 700013
const AUDIT_ACTION = "USER_HANDOUT_ALIGNMENT"
/** Parking value used between the two write phases; never a real username. */
const STAGING_PREFIX = "pending-rename-"

type JsonRow = Record<string, unknown>

interface Organization {
  id: number
  code: string
  name: string
}

interface LoadedPlan {
  org: Organization
  handoutRows: number
  matched: MatchResult
  built: AlignmentPlan
  /** Rows planned on `--trust-login-codes` although their password did not verify. */
  trusted: Array<{ sheetIndex: number; username: string; loginCode: string }>
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

function planDigest(plan: AlignmentPlanRow[]): string {
  return sha256(canonicalJson(plan))
}

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function rows<T>(client: PoolClient, query: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(query, params)).rows as T[]
}

/* -------------------------------------------------------------------- input */

interface HandoutInput {
  rows: HandoutRow[]
  /** Passwords are kept apart from the rows so nothing downstream can print them. */
  passwordByIndex: Map<number, string>
}

function readHandout(path: string): HandoutInput {
  assert(existsSync(path), `Hand-out not found: ${path}`)
  const workbook = XLSX.readFile(path)
  const sheet = workbook.Sheets.Logins ?? workbook.Sheets[workbook.SheetNames[0]!]
  assert(sheet, "Workbook contains no sheets")
  const raw = XLSX.utils.sheet_to_json<JsonRow>(sheet, { defval: "" })
  assert(raw.length > 0, "Hand-out is empty")
  for (const column of ["Name", "Email", "Username", "Password", "Login Code"]) {
    assert(column in raw[0]!, `Hand-out is missing the "${column}" column — is this the credential hand-out?`)
  }

  const passwordByIndex = new Map<number, string>()
  const handoutRows = raw.map((row, index): HandoutRow => {
    passwordByIndex.set(index, String(row.Password ?? ""))
    return {
      index,
      name: text(row.Name),
      email: text(row.Email),
      branch: text(row.Branch),
      username: text(row.Username),
      loginCode: text(row["Login Code"]),
      accountCode: text(row["Account code"]) || undefined,
      mustChangePassword: text(row["Must change password at next login"]).toLowerCase() === "yes",
    }
  })
  return { rows: handoutRows, passwordByIndex }
}

async function organization(client: PoolClient, code: string): Promise<Organization> {
  const [row] = await rows<JsonRow>(client, "select id, code, name, status from organizations where code = $1", [code])
  assert(row, `No organization with code ${code}`)
  assert(String(row.status).toLowerCase() === "active", `Organization ${code} is not active`)
  return { id: Number(row.id), code: String(row.code), name: String(row.name) }
}

const ACCOUNT_COLUMNS = `
  u.id, u.email, r.name as role, b.name as branch, u.username, u.external_id,
  u.full_name, u.first_name, u.last_name, u.is_active, u.must_change_password, u.password_hash
`

interface AccountWithHash extends AlignmentAccount {
  passwordHash: string
}

function toAccount(row: JsonRow): AccountWithHash {
  return {
    id: String(row.id),
    email: String(row.email ?? ""),
    role: String(row.role ?? ""),
    branch: (row.branch as string | null) ?? null,
    username: (row.username as string | null) ?? null,
    externalId: (row.external_id as string | null) ?? null,
    fullName: (row.full_name as string | null) ?? null,
    firstName: (row.first_name as string | null) ?? null,
    lastName: (row.last_name as string | null) ?? null,
    isActive: Boolean(row.is_active),
    mustChangePassword: Boolean(row.must_change_password),
    passwordHash: String(row.password_hash ?? ""),
  }
}

async function readAccounts(client: PoolClient, organizationId: number): Promise<AccountWithHash[]> {
  const result = await rows<JsonRow>(client, `
    select ${ACCOUNT_COLUMNS}
      from users u
      join roles r on r.id = u.role_id
      left join branches b on b.id = u.branch_id
     where u.organization_id = $1 and u.deleted_at is null
       -- A retired account (a previous holder of a reissued legacy login) still
       -- carries the code it once signed in with; it is not a hand-out target.
       and coalesce(u.external_source, '') !~ '_RETIRED$'
     order by u.id
  `, [organizationId])
  return result.map(toAccount)
}

/* ---------------------------------------------------------------- planning */

async function loadPlan(client: PoolClient, code: string, handoutPath: string): Promise<LoadedPlan> {
  const handout = readHandout(handoutPath)
  const org = await organization(client, code)
  const accounts = await readAccounts(client, org.id)
  const hashById = new Map(accounts.map((account) => [account.id, account.passwordHash]))

  const staged = accounts.filter((account) => String(account.username ?? "").startsWith(STAGING_PREFIX))
  assert(staged.length === 0,
    `${staged.length} account(s) are parked on a ${STAGING_PREFIX}* username, which means an earlier run did not finish. ` +
    `Resolve those before running again: ${staged.map((account) => account.id).join(", ")}`)

  // Strip the hash before the rows reach the planner or any report.
  const matched = matchHandoutRows(handout.rows, accounts.map(({ passwordHash: _hash, ...account }) => account))

  // Same reasoning as build-credential-handout.ts: the app hasher is
  // `server-only`, and bcrypt verification is fully specified, so bcryptjs
  // directly checks exactly what a login would.
  const bcrypt = (await import("bcryptjs")).default
  const trustedCodes = new Set(
    (arg("--trust-login-codes") ?? "").split(",").map((value) => codeKeyOf(value)).filter(Boolean))
  const verified: VerifiedMatch[] = []
  const trusted: Array<{ sheetIndex: number; username: string; loginCode: string }> = []
  for (const match of matched.matches) {
    const hash = hashById.get(match.account.id) ?? ""
    const password = handout.passwordByIndex.get(match.row.index) ?? ""
    let passwordVerified = hash !== "" && password !== "" && await bcrypt.compare(password, hash)
    if (!passwordVerified && match.matchedBy === "login_code" && trustedCodes.has(codeKeyOf(match.row.loginCode))) {
      passwordVerified = true
      trusted.push({ sheetIndex: match.row.index, username: match.row.username, loginCode: match.row.loginCode })
    }
    verified.push({ ...match, passwordVerified })
  }

  const existing = await rows<JsonRow>(client, "select id, username from users")
  const built = buildAlignmentPlan(verified,
    existing.map((row) => ({ id: String(row.id), username: (row.username as string | null) ?? null })))

  return { org, handoutRows: handout.rows.length, matched, built, trusted }
}

/** Login codes are compared as digits-and-letters, case-insensitively. */
function codeKeyOf(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "")
}

/* ------------------------------------------------------------------- report */

function summary(loaded: LoadedPlan): JsonRow {
  const { matched, built } = loaded
  const remaining: Record<string, number> = {}
  for (const row of [...built.plan, ...built.unchanged]) {
    for (const issue of row.remaining) remaining[issue] = (remaining[issue] ?? 0) + 1
  }
  const blocked: Record<string, number> = {}
  for (const row of matched.skipped) blocked[row.reason] = (blocked[row.reason] ?? 0) + 1
  for (const row of built.skipped) blocked[row.reason] = (blocked[row.reason] ?? 0) + 1
  return {
    handoutRows: loaded.handoutRows,
    accountsInOrganization: matched.matches.length + matched.unmatchedAccounts.length,
    matched: matched.matches.length,
    matchedByEmailFallback: matched.matches.filter((m) => m.matchedBy === "email").length,
    toUpdate: built.plan.length,
    usernameChanges: built.plan.filter((row) => row.usernameChanges).length,
    nameChanges: built.plan.filter((row) => row.nameChanges).length,
    alreadyAligned: built.unchanged.length,
    blocked,
    accountsNotInHandout: matched.unmatchedAccounts.length,
    remainingAfterAlignment: remaining,
  }
}

function baseReport(loaded: LoadedPlan, handoutPath: string): JsonRow {
  const digest = planDigest(loaded.built.plan)
  return {
    generatedAt: new Date().toISOString(),
    source: handoutPath,
    organization: loaded.org,
    planSha256: digest,
    summary: summary(loaded),
    warning:
      "Mirrored accounts sign in by username only. Every renamed account must be told its new username — the hand-out is that notice.",
    requiredCommitArguments: ["--commit", `--confirm-plan-sha256=${digest}`, "--operator=<your email>"],
    trustedWithoutPasswordProof: loaded.trusted,
    plan: loaded.built.plan,
    unchanged: loaded.built.unchanged,
    blocked: { unmatched: loaded.matched.skipped, notPlanned: loaded.built.skipped },
    accountsNotInHandout: loaded.matched.unmatchedAccounts.map((a) => ({
      userId: a.id, email: a.email, role: a.role, branch: a.branch, username: a.username, fullName: a.fullName, isActive: a.isActive,
    })),
  }
}

const REMAINING_TEXT: Record<string, string> = {
  BRANCH_DIFFERS: "Branch in hand-out differs from the account's branch; not moved",
  EXTERNAL_ID_DIFFERS_FROM_LOGIN_CODE: "Account external_id is not the legacy login code; not changed",
  MUST_CHANGE_PASSWORD_DIFFERS: "Must-change-password flag differs from the hand-out; not changed",
  ACCOUNT_INACTIVE: "Account is inactive; alignment applied but the person cannot sign in until it is activated",
}

function writeExcel(path: string, loaded: LoadedPlan, mode: string): void {
  const { matched, built } = loaded
  const nameOf = (row: AlignmentPlanRow) => row.after.fullName

  const planned = built.plan.map((row) => ({
    Mode: mode,
    "Sheet row": row.sheetIndex + 2,
    Name: nameOf(row),
    Email: row.email,
    Role: row.role,
    Branch: row.branch,
    "Matched by": row.matchedBy,
    "Username before": row.before.username ?? "",
    "Username after": row.after.username,
    "Full name before": row.before.fullName ?? "",
    "Full name after": row.after.fullName,
    "First name before": row.before.firstName ?? "",
    "First name after": row.after.firstName,
    "Last name before": row.before.lastName ?? "",
    "Last name after": row.after.lastName ?? "",
    "Left alone": row.remaining.join(", "),
  }))

  const blocked = [
    ...matched.skipped.map((row) => ({
      "Sheet row": row.sheetIndex + 2, Username: row.username, Name: row.name, Role: "", Issue: row.reason, Detail: row.detail,
      "Can sign in with hand-out": "No",
    })),
    ...built.skipped.map((row) => ({
      "Sheet row": row.sheetIndex + 2, Username: row.username, Name: row.name, Role: row.role, Issue: row.reason, Detail: row.detail,
      "Can sign in with hand-out": "No",
    })),
  ].sort((a, b) => a["Sheet row"] - b["Sheet row"])

  const remaining = [...built.plan, ...built.unchanged]
    .flatMap((row) => row.remaining.map((issue) => ({
      "Sheet row": row.sheetIndex + 2,
      Name: nameOf(row),
      Email: row.email,
      Role: row.role,
      Username: row.after.username,
      Issue: issue,
      Detail: REMAINING_TEXT[issue] ?? issue,
      "Can sign in with hand-out": issue === "ACCOUNT_INACTIVE" ? "No (inactive)" : "Yes",
    })))
    .sort((a, b) => a["Sheet row"] - b["Sheet row"])

  const notInHandout = matched.unmatchedAccounts.map((a) => ({
    Name: a.fullName ?? "", Email: a.email, Role: a.role, Branch: a.branch ?? "", Username: a.username ?? "",
    "External id": a.externalId ?? "", Active: a.isActive ? "Yes" : "No",
    Detail: "No hand-out row addresses this account; nothing changed and no password is known for it",
  }))

  const empty = (message: string) => [{ Result: message }]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords<Record<string, unknown>>(
    planned.length > 0 ? planned : empty("Nothing to change"))), mode === "COMMITTED" ? "Applied" : "Planned")
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords<Record<string, unknown>>(
    blocked.length > 0 ? blocked : empty("Every hand-out row was aligned"))), "Blocked")
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords<Record<string, unknown>>(
    remaining.length > 0 ? remaining : empty("Nothing left alone"))), "Left alone")
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords<Record<string, unknown>>(
    notInHandout.length > 0 ? notInHandout : empty("Every account appears in the hand-out"))), "Not in handout")
  mkdirSync(dirname(path), { recursive: true })
  XLSX.writeFile(workbook, path)
}

/* ------------------------------------------------------------------ actions */

async function preflight(client: PoolClient, code: string, handoutPath: string): Promise<void> {
  const loaded = await loadPlan(client, code, handoutPath)
  const report = baseReport(loaded, handoutPath)
  const output = resolve(arg("--output") ?? "deliverables/handout-alignment-preflight.json")
  const excel = output.replace(/\.json$/, "") + ".xlsx"
  saveJson(output, report)
  writeExcel(excel, loaded, "DRY_RUN")
  console.log(JSON.stringify({
    mode: "DRY_RUN",
    output,
    excel,
    organization: `${loaded.org.id}:${loaded.org.code}:${loaded.org.name}`,
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

interface Rename {
  userId: string
  from: string | null
  to: string
}

/**
 * Applies username changes, parking every target on a temporary value first so
 * the immediate unique index cannot fire on an intermediate state. Each write
 * is conditional on the value it expects to replace.
 */
async function applyRenames(client: PoolClient, organizationId: number, changes: Rename[]): Promise<void> {
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

interface NameWrite {
  userId: string
  fullName: string
  firstName: string
  lastName: string | null
}

async function applyNames(client: PoolClient, organizationId: number, writes: NameWrite[]): Promise<void> {
  for (const write of writes) {
    const result = await client.query(`
      update users set full_name = $2, first_name = $3, last_name = $4, updated_at = now()
       where id = $1 and organization_id = $5 and deleted_at is null
    `, [write.userId, write.fullName, write.firstName, write.lastName, organizationId])
    assert(result.rowCount === 1, `Account ${write.userId} could not be renamed`)
  }
}

async function commit(client: PoolClient, code: string, handoutPath: string): Promise<void> {
  const operator = arg("--operator")
  assert(operator && /.@./.test(operator), "--operator=<your email> is required so the audit trail names a person")

  const loaded = await loadPlan(client, code, handoutPath)
  const { org, built } = loaded
  const digest = planDigest(built.plan)
  assert(arg("--confirm-plan-sha256") === digest,
    `--confirm-plan-sha256 does not match the current plan (${digest}). Re-run the preflight and pass the digest it prints.`)
  assert(built.plan.length > 0, "Nothing to change")

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])

    const locked = await rows<JsonRow>(client, `
      select u.id, u.username, u.full_name, u.first_name, u.last_name, r.name as role
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
      assert(String(current.role).toUpperCase() === row.role, `Account ${row.userId} changed role after the plan was built; aborting`)
      assert(((current.username as string | null) ?? null) === row.before.username,
        `Account ${row.userId} username changed after the plan was built; aborting`)
      assert(((current.full_name as string | null) ?? null) === row.before.fullName
        && ((current.first_name as string | null) ?? null) === row.before.firstName
        && ((current.last_name as string | null) ?? null) === row.before.lastName,
        `Account ${row.userId} name changed after the plan was built; aborting`)
    }

    await applyRenames(client, org.id, built.plan
      .filter((row) => row.usernameChanges)
      .map((row) => ({ userId: row.userId, from: row.before.username, to: row.after.username })))
    await applyNames(client, org.id, built.plan
      .filter((row) => row.nameChanges)
      .map((row) => ({ userId: row.userId, fullName: row.after.fullName, firstName: row.after.firstName, lastName: row.after.lastName })))

    for (const row of built.plan) {
      await auditWrite(client, AUDIT_ACTION, operator, org.id, row.userId, {
        planSha256: digest,
        source: "credential hand-out",
        matchedBy: row.matchedBy,
        before: row.before,
        after: row.after,
        account: { email: row.email, role: row.role, branch: row.branch },
      })
    }

    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }

  const output = resolve(arg("--output") ?? `deliverables/handout-alignment-committed-${Date.now()}.json`)
  const excel = output.replace(/\.json$/, "") + ".xlsx"
  saveJson(output, { ...baseReport(loaded, handoutPath), mode: "COMMITTED", committedAt: new Date().toISOString(), operator })
  writeExcel(excel, loaded, "COMMITTED")
  console.log(JSON.stringify({
    mode: "COMMITTED",
    output,
    excel,
    organization: `${org.id}:${org.code}:${org.name}`,
    planSha256: digest,
    updated: built.plan.length,
    summary: summary(loaded),
    rollbackWith: `--rollback=${output} --operator=${operator}`,
  }, null, 2))
}

async function rollback(client: PoolClient, reportPath: string): Promise<void> {
  const operator = arg("--operator")
  assert(operator && /.@./.test(operator), "--operator=<your email> is required for a rollback")

  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    plan: AlignmentPlanRow[]
    organization: Organization
    planSha256: string
    mode?: string
  }
  assert(report.mode === "COMMITTED", "Only a committed report can be rolled back")
  assert(Array.isArray(report.plan) && report.plan.length > 0, "Report contains no plan to reverse")

  const flagPrefix = arg("--flag-prefix") ?? ""
  assert(/^[a-z0-9]*-?$/.test(flagPrefix), `--flag-prefix must be lowercase letters/digits, optionally ending in "-" (got ${JSON.stringify(flagPrefix)})`)
  const restoredUsername = (row: AlignmentPlanRow): string => `${flagPrefix}${row.before.username as string}`

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])

    await applyRenames(client, report.organization.id, report.plan
      .filter((row) => row.usernameChanges && row.before.username !== null)
      .map((row) => ({ userId: row.userId, from: row.after.username, to: restoredUsername(row) })))

    for (const row of report.plan.filter((r) => r.usernameChanges && r.before.username === null)) {
      const cleared = await client.query(`
        update users set username = null, updated_at = now()
         where id = $1 and organization_id = $2 and deleted_at is null and username = $3
      `, [row.userId, report.organization.id, row.after.username])
      assert(cleared.rowCount === 1, `Account ${row.userId} no longer holds ${JSON.stringify(row.after.username)}`)
    }

    for (const row of report.plan.filter((r) => r.nameChanges)) {
      const restored = await client.query(`
        update users set full_name = $2, first_name = $3, last_name = $4, updated_at = now()
         where id = $1 and organization_id = $5 and deleted_at is null
           and full_name is not distinct from $6 and first_name is not distinct from $7 and last_name is not distinct from $8
      `, [row.userId, row.before.fullName, row.before.firstName, row.before.lastName, report.organization.id,
        row.after.fullName, row.after.firstName, row.after.lastName])
      assert(restored.rowCount === 1, `Account ${row.userId} no longer carries the aligned name; not restoring blindly`)
    }

    for (const row of report.plan) {
      await auditWrite(client, `${AUDIT_ACTION}_ROLLBACK`, operator, report.organization.id, row.userId, {
        reversedPlanSha256: report.planSha256, restored: row.before, from: row.after,
        ...(flagPrefix && row.usernameChanges && row.before.username !== null
          ? { usernameParkedAs: restoredUsername(row), reason: "account belongs to a previous holder of this login code; owner to be resolved" }
          : {}),
      })
    }

    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }

  console.log(JSON.stringify({ mode: "ROLLED_BACK", report: reportPath, restored: report.plan.length,
    ...(flagPrefix ? { usernamesParkedWithPrefix: flagPrefix } : {}) }, null, 2))
}

async function main(): Promise<void> {
  const code = arg("--organization-code") ?? DEFAULT_ORGANIZATION_CODE
  const handoutPath = resolve(arg("--file") ?? DEFAULT_HANDOUT)
  const rollbackPath = arg("--rollback")

  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    if (rollbackPath) await rollback(client, resolve(rollbackPath))
    else if (process.argv.includes("--commit")) await commit(client, code, handoutPath)
    else await preflight(client, code, handoutPath)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
