#!/usr/bin/env tsx
/**
 * Repairs the legacy identity (`external_source` / `external_id`) of
 * K-Electric accounts so that every mirrored account carries the employee code
 * the legacy platform holds for that person. Three repairs, each derived from
 * the legacy staff list and the current rows — nothing is hard-coded:
 *
 * 1. **Truncated stamps.** An active account whose username carries the full
 *    legacy code but whose `external_id` is a damaged copy of it (`9418` for
 *    `09418`, `15377` for `15377084`). The soft-deleted duplicate that still
 *    holds the correct code is re-tagged `KE_LOGISTICS_RETIRED` so the unique
 *    identity index frees up, then the live account is stamped.
 * 2. **Recycled codes** (`--include-recycled-codes`). Legacy reissued a login
 *    code to a new person; production kept the code on the previous holder and
 *    gave the new holder a `ke<legacy id>` placeholder. The previous holder is
 *    retired — deactivated and re-tagged, keeping its username and every order
 *    — and the new holder is stamped with the real code. Opt-in because it
 *    removes sign-in from real accounts.
 * 3. **Restores** (`--restore=<username,...>`). Soft-deleted accounts the
 *    hand-out still names are brought back. With `--handout=<file>` the
 *    hand-out password is verified against the stored hash and, only when it
 *    does not verify, written — an account nobody could sign in to cannot
 *    have had its password changed by its owner.
 *
 * Scope is organization 10 only and is asserted by name before anything is
 * read. Default mode is a read-only preflight. Commit is digest-gated, runs in
 * one transaction under an advisory lock, re-verifies every target row under
 * `FOR UPDATE`, writes a `system_logs` row per account, and produces a
 * committed report that `--rollback` reverses (a reset password stays reset;
 * the previous hash is deliberately not recorded).
 *
 *   npx tsx scripts/repair-ke-account-identities.ts
 *   npx tsx scripts/repair-ke-account-identities.ts --include-recycled-codes --restore=head-1734549-op --handout=user-logins-handout.xlsx
 *   npx tsx scripts/repair-ke-account-identities.ts ... --commit --confirm-plan-sha256=<digest> --operator=you@example.com
 *   npx tsx scripts/repair-ke-account-identities.ts --rollback=deliverables/<committed report>.json --operator=you@example.com
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"
import * as XLSX from "xlsx"

import { hashMirroredLegacyPassword } from "../lib/password-cli"
import {
  KE_SYNC_ORGANIZATION,
  KE_SYNC_SOURCE,
  contestedIdentityFor,
  isSamePerson,
  isSyntheticAccount,
  normalizeName,
  type CurrentUser,
  type LegacySubUser,
} from "../lib/legacy-import/ke-sync"
import { canonicalJson, text } from "../lib/user-name-correction"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const LEGACY_BASE_URL = "https://logistics.oneflowe.com"
const LEGACY_ACCOUNT_ID = 1
const RETIRED_SOURCE = "KE_LOGISTICS_RETIRED"
const ADVISORY_LOCK = 700021
const AUDIT_ACTION = "KE_ACCOUNT_IDENTITY_REPAIR"
const DELETED_EMAIL_PREFIX = /^deleted_\d+_/

type JsonRow = Record<string, unknown>

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function rows<T = JsonRow>(client: PoolClient, query: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(query, params)).rows as T[]
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

/* -------------------------------------------------------------------- types */

interface Account {
  id: string
  username: string | null
  email: string
  fullName: string | null
  firstName: string | null
  roleName: string
  branchId: number | null
  branchName: string | null
  isActive: boolean
  deletedAt: string | null
  externalSource: string | null
  externalId: string | null
  orders: number
  passwordHash: string
}

interface FieldChange {
  externalSource?: string | null
  externalId?: string | null
  isActive?: boolean
  deletedAt?: string | null
  email?: string
  /** True when the hand-out password will be written; never the password itself. */
  passwordReset?: boolean
}

interface PlanRow {
  step: "TRUNCATED_STAMP" | "RETIRE_DELETED_DUPLICATE" | "RETIRE_PREVIOUS_HOLDER" | "STAMP_CURRENT_HOLDER" | "RESTORE"
  userId: string
  username: string | null
  roleName: string
  legacySubUserId: number | null
  legacyCode: string
  before: FieldChange
  after: FieldChange
  reason: string
  orders: number
}

interface Plan {
  organization: { id: number; code: string; name: string }
  rows: PlanRow[]
  notes: string[]
  /** Hand-out passwords by user id, held in memory only; never reported. */
  passwords: Map<string, string>
}

/* ------------------------------------------------------------------ reading */

async function fetchLegacyStaff(): Promise<LegacySubUser[]> {
  const response = await fetch(`${LEGACY_BASE_URL}/api/SubUser/0/${LEGACY_ACCOUNT_ID}`, {
    headers: { Accept: "application/json" },
  })
  assert(response.ok, `Legacy staff list: HTTP ${response.status}`)
  const staff = await response.json() as LegacySubUser[]
  assert(Array.isArray(staff) && staff.length > 0, "Legacy staff list is empty")
  return staff
}

async function readOrganization(client: PoolClient): Promise<Plan["organization"]> {
  const [org] = await rows(client, `select id, code, name from organizations where id = $1`, [KE_SYNC_ORGANIZATION.id])
  assert(org && normalizeName(org.name) === normalizeName(KE_SYNC_ORGANIZATION.name),
    `Organization ${KE_SYNC_ORGANIZATION.id} is not ${KE_SYNC_ORGANIZATION.name} in this database; refusing.`)
  return { id: Number(org.id), code: String(org.code), name: String(org.name) }
}

async function readAccounts(client: PoolClient, organizationId: number): Promise<Account[]> {
  return (await rows(client, `
    select u.id, u.username, u.email, u.full_name, u.first_name, u.branch_id, b.name as branch_name,
           u.is_active, u.deleted_at, u.external_source, u.external_id, u.password_hash, r.name as role_name,
           (select count(*)::int from orders o where o.created_by_user_id = u.id) as orders
      from users u
      join roles r on r.id = u.role_id
      left join branches b on b.id = u.branch_id
     where u.organization_id = $1
     order by u.username`, [organizationId]))
    .map((row): Account => ({
      id: String(row.id),
      username: (row.username as string | null) ?? null,
      email: String(row.email),
      fullName: (row.full_name as string | null) ?? null,
      firstName: (row.first_name as string | null) ?? null,
      roleName: String(row.role_name),
      branchId: row.branch_id == null ? null : Number(row.branch_id),
      branchName: (row.branch_name as string | null) ?? null,
      isActive: Boolean(row.is_active),
      deletedAt: row.deleted_at == null ? null : new Date(String(row.deleted_at)).toISOString(),
      externalSource: (row.external_source as string | null) ?? null,
      externalId: (row.external_id as string | null) ?? null,
      orders: Number(row.orders ?? 0),
      passwordHash: String(row.password_hash ?? ""),
    }))
}

function asCurrentUser(account: Account): CurrentUser {
  return {
    id: account.id, username: account.username, email: account.email, fullName: account.fullName,
    firstName: account.firstName, roleName: account.roleName, branchId: account.branchId,
    isActive: account.isActive, externalSource: account.externalSource, externalId: account.externalId,
  }
}

function readHandoutPasswords(path: string): Map<string, string> {
  assert(existsSync(path), `Hand-out not found: ${path}`)
  const book = XLSX.readFile(path)
  const sheet = book.Sheets[book.SheetNames[0]]
  const byUsername = new Map<string, string>()
  for (const row of XLSX.utils.sheet_to_json<JsonRow>(sheet)) {
    const username = text(row.Username).toLowerCase()
    if (username) byUsername.set(username, text(row.Password))
  }
  return byUsername
}

/* ----------------------------------------------------------------- planning */

async function buildPlan(client: PoolClient, staff: LegacySubUser[]): Promise<Plan> {
  const organization = await readOrganization(client)
  const accounts = await readAccounts(client, organization.id)
  const includeRecycled = process.argv.includes("--include-recycled-codes")
  const restoreNames = new Set((arg("--restore") ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean))
  const handoutPath = arg("--handout")
  const handoutPasswords = handoutPath ? readHandoutPasswords(resolve(handoutPath)) : null

  const live = accounts.filter((a) => a.deletedAt == null && !isSyntheticAccount(a.email))
  const liveByExternalId = new Map<string, Account[]>()
  for (const account of live) {
    if (account.externalSource !== KE_SYNC_SOURCE || !account.externalId) continue
    const key = account.externalId.toLowerCase()
    liveByExternalId.set(key, [...(liveByExternalId.get(key) ?? []), account])
  }
  const legacyEmails = new Set(staff.map((s) => text(s.Email).toLowerCase()).filter(Boolean))

  const plan: PlanRow[] = []
  const notes: string[] = []
  const passwords = new Map<string, string>()
  const planned = new Set<string>()
  const push = (row: PlanRow) => {
    assert(!planned.has(`${row.step}:${row.userId}`), `Account ${row.userId} planned twice for ${row.step}`)
    planned.add(`${row.step}:${row.userId}`)
    plan.push(row)
  }

  for (const person of [...staff].sort((a, b) => Number(a.ID) - Number(b.ID))) {
    const legacyId = Number(person.ID)
    const code = text(person.Passcode)
    if (!code) continue
    const stripped = code.replace(/^0+/, "")
    const holders = liveByExternalId.get(code.toLowerCase()) ?? []
    const own = liveByExternalId.get(contestedIdentityFor(legacyId).toLowerCase()) ?? []

    // 1. Truncated stamps: nobody live holds the code, but an account whose
    //    username carries it (or its zero-stripped form) is this person.
    if (holders.length === 0 && own.length === 0) {
      const shape = new RegExp(`-(${code}|${stripped})-(ba|op)$`, "i")
      const candidates = live.filter((a) =>
        a.externalSource === KE_SYNC_SOURCE && shape.test(String(a.username ?? ""))
        && a.externalId !== code && isSamePerson(person, asCurrentUser(a)))
      for (const account of candidates) {
        for (const duplicate of accounts.filter((a) =>
          a.deletedAt != null && a.externalSource === KE_SYNC_SOURCE && a.externalId === code && a.roleName === account.roleName)) {
          push({
            step: "RETIRE_DELETED_DUPLICATE", userId: duplicate.id, username: duplicate.username, roleName: duplicate.roleName,
            legacySubUserId: legacyId, legacyCode: code,
            before: { externalSource: duplicate.externalSource }, after: { externalSource: RETIRED_SOURCE },
            reason: `soft-deleted since ${duplicate.deletedAt?.slice(0, 10)}; frees code ${code} for ${account.username}`,
            orders: duplicate.orders,
          })
        }
        push({
          step: "TRUNCATED_STAMP", userId: account.id, username: account.username, roleName: account.roleName,
          legacySubUserId: legacyId, legacyCode: code,
          before: { externalId: account.externalId }, after: { externalId: code },
          reason: `external_id "${account.externalId}" is a damaged copy of legacy code "${code}"`,
          orders: account.orders,
        })
      }
      continue
    }

    // 2. Recycled codes: the person has a placeholder identity while somebody
    //    else — not the same person — holds the real code.
    const strangers = holders.filter((a) => !isSamePerson(person, asCurrentUser(a)))
    if (own.length > 0 && strangers.length > 0) {
      const inLegacy = strangers.some((a) => legacyEmails.has(a.email.toLowerCase()))
      if (!includeRecycled) {
        notes.push(`code ${code}: current holder ${own.map((a) => a.username).join("/")} carries a placeholder; `
          + `previous holder ${strangers.map((a) => a.username).join("/")} still has the code `
          + `(${strangers.reduce((n, a) => n + a.orders, 0)} orders, ${inLegacy ? "still" : "not"} in legacy). `
          + "Pass --include-recycled-codes to retire the previous holder and stamp the current one.")
        continue
      }
      for (const account of strangers) {
        push({
          step: "RETIRE_PREVIOUS_HOLDER", userId: account.id, username: account.username, roleName: account.roleName,
          legacySubUserId: null, legacyCode: code,
          before: { externalSource: account.externalSource, isActive: account.isActive },
          after: { externalSource: RETIRED_SOURCE, isActive: false },
          reason: `legacy now issues code ${code} to legacy person ${legacyId}; this account (${account.fullName ?? ""}) is `
            + `${inLegacy ? "in legacy under another code" : "not in the legacy staff list"} — retired, orders kept`,
          orders: account.orders,
        })
      }
      for (const account of own) {
        push({
          step: "STAMP_CURRENT_HOLDER", userId: account.id, username: account.username, roleName: account.roleName,
          legacySubUserId: legacyId, legacyCode: code,
          before: { externalId: account.externalId }, after: { externalId: code },
          reason: `placeholder ${account.externalId} replaced by the legacy code`,
          orders: account.orders,
        })
      }
    }
  }

  // 3. Restores.
  for (const name of restoreNames) {
    const account = accounts.find((a) => String(a.username ?? "").toLowerCase() === name)
    assert(account, `--restore: no account named "${name}" in ${organization.name}`)
    assert(account.deletedAt != null, `--restore: "${name}" is not soft-deleted`)
    const clash = live.find((a) => a.roleName === account.roleName && a.externalSource === account.externalSource
      && a.externalId === account.externalId && a.externalId != null)
    assert(!clash, `--restore: a live ${account.roleName} account (${clash?.username}) already carries identity ${account.externalId}`)
    const after: FieldChange = { deletedAt: null, isActive: true, email: account.email.replace(DELETED_EMAIL_PREFIX, "") }
    let reason = `soft-deleted since ${account.deletedAt.slice(0, 10)}; the hand-out still names this account`
    if (handoutPasswords) {
      const password = handoutPasswords.get(name)
      assert(password, `--restore: the hand-out has no row for "${name}"`)
      const bcrypt = (await import("bcryptjs")).default
      const verifies = account.passwordHash !== "" && await bcrypt.compare(password, account.passwordHash)
      if (!verifies) {
        after.passwordReset = true
        passwords.set(account.id, password)
        reason += "; stored hash does not verify the hand-out password, so it is written"
      } else {
        reason += "; hand-out password already verifies"
      }
    }
    push({
      step: "RESTORE", userId: account.id, username: account.username, roleName: account.roleName,
      legacySubUserId: null, legacyCode: account.externalId ?? "",
      before: { deletedAt: account.deletedAt, isActive: account.isActive, email: account.email }, after,
      reason, orders: account.orders,
    })
  }

  plan.sort((a, b) => a.step.localeCompare(b.step) || a.userId.localeCompare(b.userId))
  return { organization, rows: plan, notes, passwords }
}

function planDigest(plan: Plan): string {
  return sha256(canonicalJson({
    organization: plan.organization.id,
    rows: plan.rows.map((row) => [row.step, row.userId, row.before, row.after]),
  }))
}

function report(plan: Plan, extra: JsonRow = {}): JsonRow {
  const counts: Record<string, number> = {}
  for (const row of plan.rows) counts[row.step] = (counts[row.step] ?? 0) + 1
  return {
    generatedAt: new Date().toISOString(),
    organization: plan.organization,
    planSha256: planDigest(plan),
    counts,
    notes: plan.notes,
    rows: plan.rows,
    ...extra,
  }
}

/* ------------------------------------------------------------------- writes */

function writeReport(path: string, body: JsonRow): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8")
}

async function applyRow(client: PoolClient, organizationId: number, userId: string, change: FieldChange, passwordHash?: string): Promise<void> {
  const sets: string[] = ["updated_at = now()"]
  const params: unknown[] = [userId, organizationId]
  const set = (column: string, value: unknown) => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  if ("externalSource" in change) set("external_source", change.externalSource ?? null)
  if ("externalId" in change) set("external_id", change.externalId ?? null)
  if ("isActive" in change) set("is_active", change.isActive)
  if ("deletedAt" in change) set("deleted_at", change.deletedAt ?? null)
  if ("email" in change && change.email) set("email", change.email)
  if (passwordHash) set("password_hash", passwordHash)
  await client.query(`update users set ${sets.join(", ")} where id = $1 and organization_id = $2`, params)
}

async function commit(client: PoolClient, plan: Plan, output: string): Promise<void> {
  const operator = arg("--operator")
  assert(operator && /.+@.+/.test(operator), "--operator=<your email> is required so the audit trail names a person")
  const digest = planDigest(plan)
  assert(arg("--confirm-plan-sha256") === digest,
    `--confirm-plan-sha256 does not match the current plan (${digest}). Re-run the preflight and pass the digest it prints.`)
  assert(plan.rows.length > 0, "Nothing to change")

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    const locked = await rows(client, `
      select id, username, external_source, external_id, is_active, deleted_at
        from users where id = any($1::uuid[]) and organization_id = $2 for update`,
      [[...new Set(plan.rows.map((row) => row.userId))], plan.organization.id])
    const byId = new Map(locked.map((row) => [String(row.id), row]))
    for (const row of plan.rows) {
      const current = byId.get(row.userId)
      assert(current, `Account ${row.userId} disappeared between plan and commit`)
      assert((current.username ?? null) === row.username, `Account ${row.userId} was renamed after the plan was built; aborting`)
      if ("externalSource" in row.before) assert(current.external_source === row.before.externalSource, `Account ${row.userId} external_source moved; aborting`)
      if ("externalId" in row.before) assert(current.external_id === row.before.externalId, `Account ${row.userId} external_id moved; aborting`)
      if ("isActive" in row.before) assert(Boolean(current.is_active) === row.before.isActive, `Account ${row.userId} is_active moved; aborting`)
      if ("deletedAt" in row.before) assert((current.deleted_at == null) === (row.before.deletedAt == null), `Account ${row.userId} deleted_at moved; aborting`)
    }

    // Order matters: a code must be released before it is claimed.
    const order: PlanRow["step"][] = ["RETIRE_DELETED_DUPLICATE", "RETIRE_PREVIOUS_HOLDER", "TRUNCATED_STAMP", "STAMP_CURRENT_HOLDER", "RESTORE"]
    for (const step of order) {
      for (const row of plan.rows.filter((r) => r.step === step)) {
        const password = plan.passwords.get(row.userId)
        const hash = row.after.passwordReset && password ? await hashMirroredLegacyPassword(password) : undefined
        await applyRow(client, plan.organization.id, row.userId, row.after, hash)
        await client.query(`
          insert into system_logs (user_id, user_role, user_email, organization_id, action, resource_type, resource_id, details, success)
          values (null, 'SUPER_ADMIN', $1, $2, $3, 'user', $4, $5::jsonb, true)`,
          [operator, plan.organization.id, AUDIT_ACTION, row.userId, JSON.stringify({
            planSha256: digest, step: row.step, username: row.username, legacyCode: row.legacyCode,
            before: row.before, after: row.after, reason: row.reason,
          })])
      }
    }
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }
  writeReport(output, report(plan, { committedAt: new Date().toISOString(), operator, rollbackWith: `--rollback=${output} --operator=${operator}` }))
  console.log(JSON.stringify({ committed: plan.rows.length, output }, null, 2))
}

async function rollback(client: PoolClient, path: string): Promise<void> {
  const operator = arg("--operator")
  assert(operator && /.+@.+/.test(operator), "--operator=<your email> is required for a rollback")
  const committed = JSON.parse(readFileSync(resolve(path), "utf8")) as { organization: Plan["organization"]; rows: PlanRow[]; committedAt?: string }
  assert(committed.committedAt, "Only a committed report can be rolled back")
  const organization = await readOrganization(client)
  assert(organization.id === committed.organization.id, "Report belongs to a different organization")

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    // Reverse order of the commit, so a claimed code is released before the
    // previous holder takes it back.
    const order: PlanRow["step"][] = ["RESTORE", "STAMP_CURRENT_HOLDER", "TRUNCATED_STAMP", "RETIRE_PREVIOUS_HOLDER", "RETIRE_DELETED_DUPLICATE"]
    let count = 0
    for (const step of order) {
      for (const row of committed.rows.filter((r) => r.step === step)) {
        const { passwordReset: _ignored, ...before } = row.before
        await applyRow(client, organization.id, row.userId, before)
        await client.query(`
          insert into system_logs (user_id, user_role, user_email, organization_id, action, resource_type, resource_id, details, success)
          values (null, 'SUPER_ADMIN', $1, $2, $3, 'user', $4, $5::jsonb, true)`,
          [operator, organization.id, `${AUDIT_ACTION}_ROLLBACK`, row.userId,
            JSON.stringify({ step: row.step, username: row.username, restored: before, from: path })])
        count += 1
      }
    }
    await client.query("commit")
    console.log(JSON.stringify({ rolledBack: count }, null, 2))
  } catch (error) {
    await client.query("rollback")
    throw error
  }
}

/* --------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const { pool, closePool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    const rollbackPath = arg("--rollback")
    if (rollbackPath) {
      await rollback(client, rollbackPath)
      return
    }
    const staff = await fetchLegacyStaff()
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)
    if (process.argv.includes("--commit")) {
      await client.query("begin")
      const plan = await buildPlan(client, staff)
      await client.query("commit")
      await commit(client, plan, resolve(arg("--output") ?? `deliverables/ke-identity-repair-committed-${stamp}.json`))
      return
    }
    await client.query("begin transaction read only")
    const plan = await buildPlan(client, staff)
    await client.query("commit")
    const output = resolve(arg("--output") ?? `deliverables/ke-identity-repair-preflight-${stamp}.json`)
    const body = report(plan, {
      requiredCommitArguments: ["--commit", `--confirm-plan-sha256=${planDigest(plan)}`, "--operator=<your email>",
        ...process.argv.filter((v) => v.startsWith("--include-recycled-codes") || v.startsWith("--restore") || v.startsWith("--handout"))],
    })
    writeReport(output, body)
    console.log(JSON.stringify({ output, planSha256: body.planSha256, counts: body.counts, notes: body.notes }, null, 2))
    for (const row of plan.rows) {
      console.log(`  ${row.step.padEnd(26)} ${String(row.username).padEnd(34)} ${JSON.stringify(row.before)} -> ${JSON.stringify(row.after)}  [${row.orders} orders] ${row.reason}`)
    }
  } finally {
    client.release()
    await closePool()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
