#!/usr/bin/env tsx
/**
 * Restores soft-deleted accounts of one tenant that were removed by mistake:
 * clears `deleted_at`, reactivates, strips the `deleted_<ts>_` email prefix the
 * app's delete adds (when present), and optionally gives each account a new
 * username. Password hash, role, branch and external identity are untouched.
 *
 * Refuses when the target username is held by anybody, or when a live account
 * already carries the same external identity and role (the restored row would
 * be a duplicate). A shared email is reported, not refused: a mirrored person
 * holds one account per legacy login behind a single email and signs in by
 * username.
 *
 * Default mode is a read-only preflight. Commit is checksum-gated, runs in one
 * transaction, re-verifies every row under lock, and writes a `system_logs`
 * entry per account.
 *
 *   npm run restore:accounts -- --organization-code=0001 --restore=12297-ba:ramsha-12297-ba,12297-op:ramsha-12297-op
 *   npm run restore:accounts -- ... --commit --confirm-plan-sha256=<digest> --operator=you@example.com
 */

import { createHash } from "node:crypto"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import { canonicalJson } from "../lib/user-name-correction"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ADVISORY_LOCK = 700015
const AUDIT_ACTION = "USER_RESTORE_DELETED"
const USERNAME_SHAPE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
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

async function rows<T>(client: PoolClient, query: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(query, params)).rows as T[]
}

interface Restore {
  id: string
  role: string
  branch: string | null
  externalSource: string | null
  externalId: string | null
  deletedAt: string
  /** Live accounts of the same role on the same email under another code — one person, several logins. */
  sharesEmailWith: string[]
  before: { username: string; email: string; isActive: boolean }
  after: { username: string; email: string; isActive: true }
}

interface Plan {
  organization: { id: number; code: string; name: string }
  restores: Restore[]
}

function parseRequests(): Array<{ username: string; newUsername: string }> {
  const raw = arg("--restore")
  assert(raw, "--restore=<deleted username>[:<new username>],... is required")
  return raw.split(",").map((entry) => {
    const [username, newUsername] = entry.split(":").map((s) => s.trim())
    assert(username, `Empty entry in --restore`)
    const target = newUsername || username
    assert(USERNAME_SHAPE.test(target), `Username ${JSON.stringify(target)} must be lowercase letters, digits and single separators`)
    return { username, newUsername: target }
  })
}

async function loadPlan(client: PoolClient): Promise<Plan> {
  const code = arg("--organization-code")
  assert(code, "--organization-code is required")
  const [org] = await rows<JsonRow>(client, "select id, code, name from organizations where code = $1", [code])
  assert(org, `No organization with code ${code}`)
  const organization = { id: Number(org.id), code: String(org.code), name: String(org.name) }

  const restores: Restore[] = []
  const claimed = new Set<string>()
  for (const request of parseRequests()) {
    const matches = await rows<JsonRow>(client, `
      select u.id, u.username, u.email, u.is_active, u.deleted_at, r.name as role, b.name as branch, u.external_source, u.external_id, u.role_id
        from users u join roles r on r.id = u.role_id left join branches b on b.id = u.branch_id
       where u.organization_id = $1 and u.username = $2 and u.deleted_at is not null
    `, [organization.id, request.username])
    assert(matches.length === 1, `${matches.length} soft-deleted accounts carry username ${JSON.stringify(request.username)} in organization ${code}; expected exactly one`)
    const row = matches[0]!
    const id = String(row.id)
    assert(!claimed.has(id), `Account ${request.username} listed twice`)
    claimed.add(id)

    const email = String(row.email).replace(DELETED_EMAIL_PREFIX, "")

    const [usernameHolder] = await rows<JsonRow>(client, "select id from users where username = $1 and id <> $2", [request.newUsername, id])
    assert(!usernameHolder, `Username ${JSON.stringify(request.newUsername)} is already held by account ${usernameHolder?.id}`)

    if (row.external_source && row.external_id) {
      const [identityHolder] = await rows<JsonRow>(client, `
        select id, username from users where organization_id = $1 and external_source = $2 and external_id = $3 and role_id = $4 and deleted_at is null and id <> $5
      `, [organization.id, row.external_source, row.external_id, row.role_id, id])
      assert(!identityHolder, `A live ${row.role} account (${identityHolder?.username}) already carries ${row.external_source}/${row.external_id}; restoring would duplicate it`)
    }

    const emailClash = await rows<JsonRow>(client, `
      select id, username, external_id from users where organization_id = $1 and lower(email) = lower($2) and deleted_at is null and role_id = $3 and id <> $4
        and (external_id is distinct from $5)
    `, [organization.id, email, row.role_id, id, row.external_id])

    restores.push({
      id, role: String(row.role), branch: (row.branch as string | null) ?? null,
      externalSource: (row.external_source as string | null) ?? null, externalId: (row.external_id as string | null) ?? null,
      deletedAt: new Date(String(row.deleted_at)).toISOString(),
      sharesEmailWith: emailClash.map((c) => `${c.username} (${c.external_id})`),
      before: { username: String(row.username), email: String(row.email), isActive: Boolean(row.is_active) },
      after: { username: request.newUsername, email, isActive: true },
    })
  }
  return { organization, restores }
}

function digestOf(plan: Plan): string {
  return createHash("sha256").update(canonicalJson(plan.restores.map((r) => ({ id: r.id, before: r.before, after: r.after })))).digest("hex")
}

async function commit(client: PoolClient, plan: Plan, digest: string, operator: string): Promise<void> {
  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    const locked = await rows<JsonRow>(client, `
      select id, username, email from users where id = any($1::uuid[]) and organization_id = $2 and deleted_at is not null for update
    `, [plan.restores.map((r) => r.id), plan.organization.id])
    assert(locked.length === plan.restores.length, "One of the accounts changed or was already restored since the plan was built")
    for (const restore of plan.restores) {
      const current = locked.find((row) => String(row.id) === restore.id)
      assert(current && String(current.username) === restore.before.username && String(current.email) === restore.before.email,
        `Account ${restore.before.username} changed since the plan was built; aborting`)
      const result = await client.query(`
        update users set deleted_at = null, is_active = true, username = $2, email = $3, updated_at = now()
         where id = $1 and deleted_at is not null
      `, [restore.id, restore.after.username, restore.after.email])
      assert(result.rowCount === 1, `Restore of ${restore.before.username} did not apply`)
      await client.query(`
        insert into system_logs (user_id, user_role, user_email, organization_id, action, resource_type, resource_id, details, success)
        values (null, 'SUPER_ADMIN', $1, $2, $3, 'user', $4, $5::jsonb, true)
      `, [operator, plan.organization.id, AUDIT_ACTION, restore.id, JSON.stringify({ planSha256: digest, deletedAt: restore.deletedAt, before: restore.before, after: restore.after,
        reason: "soft-deleted by mistake; the person holds this legacy login in addition to another" })])
    }
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }
}

async function main(): Promise<void> {
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    const plan = await loadPlan(client)
    const digest = digestOf(plan)
    const describe = { organization: plan.organization, planSha256: digest, restores: plan.restores }
    if (!process.argv.includes("--commit")) {
      console.log(JSON.stringify({ mode: "DRY_RUN", ...describe,
        requiredCommitArguments: ["--commit", `--confirm-plan-sha256=${digest}`, "--operator=<your email>"] }, null, 2))
      return
    }
    const operator = arg("--operator")
    assert(operator && /.@./.test(operator), "--operator=<your email> is required so the audit trail names a person")
    assert(arg("--confirm-plan-sha256") === digest,
      `--confirm-plan-sha256 does not match the current plan (${digest}). Re-run the preflight and pass the digest it prints.`)
    await commit(client, plan, digest, operator)
    console.log(JSON.stringify({ mode: "COMMITTED", ...describe, operator }, null, 2))
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
