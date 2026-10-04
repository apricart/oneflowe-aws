#!/usr/bin/env tsx
/**
 * Sets the email address of named accounts in one tenant — used to bring a
 * mirrored account back in line with what the legacy platform records for
 * that login. Nothing else on the row changes.
 *
 * Email is not a login credential for a mirrored account (they sign in by
 * username), so this never changes how anyone signs in; it changes where
 * notifications go. For a non-mirrored account the new address becomes a
 * usable login, so the script refuses to give one an address another live
 * account already holds.
 *
 * Default mode is a read-only preflight. Commit is checksum-gated, runs in one
 * transaction, re-verifies every row under lock, and writes a `system_logs`
 * entry per account.
 *
 *   npm run fix:emails -- --organization-code=0001 --set=ramsha-16291-ba:ramsha.javaid@ke.com,ramsha-16291-op:ramsha.javaid@ke.com
 *   npm run fix:emails -- ... --commit --confirm-plan-sha256=<digest> --operator=you@example.com --reason="matches legacy login 16291"
 */

import { createHash } from "node:crypto"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import { canonicalJson } from "../lib/user-name-correction"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ADVISORY_LOCK = 700016
const AUDIT_ACTION = "USER_EMAIL_CORRECTION"
// local@domain, the domain holding a dot that is neither its first nor last
// character. The first dot after the domain's first character is pinned so the
// pattern cannot backtrack across every dot in a long input.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@][^\s@.]*\.[^\s@]+$/

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

interface Change {
  id: string
  username: string
  role: string
  externalIdentity: string | null
  before: string
  after: string
}

interface Plan {
  organization: { id: number; code: string; name: string }
  changes: Change[]
}

async function loadPlan(client: PoolClient): Promise<Plan> {
  const code = arg("--organization-code")
  const raw = arg("--set")
  assert(code && raw, "--organization-code and --set=<username>:<email>,... are required")
  const [org] = await rows<JsonRow>(client, "select id, code, name from organizations where code = $1", [code])
  assert(org, `No organization with code ${code}`)
  const organization = { id: Number(org.id), code: String(org.code), name: String(org.name) }

  const changes: Change[] = []
  for (const entry of raw.split(",")) {
    const [username, email] = entry.split(":").map((s) => s.trim())
    assert(username && email && EMAIL_SHAPE.test(email), `Bad --set entry ${JSON.stringify(entry)}; expected <username>:<email>`)
    const [row] = await rows<JsonRow>(client, `
      select u.id, u.username, u.email, r.name as role, u.external_source, u.external_id
        from users u join roles r on r.id = u.role_id
       where u.organization_id = $1 and u.username = $2 and u.deleted_at is null
    `, [organization.id, username])
    assert(row, `No active account ${JSON.stringify(username)} in organization ${code}`)
    assert(!changes.some((c) => c.id === String(row.id)), `Account ${username} listed twice`)
    const mirrored = Boolean(row.external_source && row.external_id)
    if (!mirrored) {
      const [holder] = await rows<JsonRow>(client,
        "select username from users where lower(email) = lower($1) and deleted_at is null and id <> $2", [email, row.id])
      assert(!holder, `${username} signs in by email and ${email} is already held by ${holder?.username}`)
    }
    changes.push({
      id: String(row.id), username, role: String(row.role),
      externalIdentity: mirrored ? `${row.external_source}/${row.external_id}` : null,
      before: String(row.email), after: email,
    })
  }
  assert(changes.some((c) => c.before.toLowerCase() !== c.after.toLowerCase()), "Every account already carries the requested email")
  return { organization, changes }
}

function digestOf(plan: Plan): string {
  return createHash("sha256").update(canonicalJson(plan.changes.map((c) => ({ id: c.id, before: c.before, after: c.after })))).digest("hex")
}

async function commit(client: PoolClient, plan: Plan, digest: string, operator: string, reason: string): Promise<void> {
  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    for (const change of plan.changes) {
      const result = await client.query(`
        update users set email = $2, updated_at = now()
         where id = $1 and organization_id = $3 and deleted_at is null and email = $4
      `, [change.id, change.after, plan.organization.id, change.before])
      assert(result.rowCount === 1, `Account ${change.username} changed since the plan was built; aborting`)
      await client.query(`
        insert into system_logs (user_id, user_role, user_email, organization_id, action, resource_type, resource_id, details, success)
        values (null, 'SUPER_ADMIN', $1, $2, $3, 'user', $4, $5::jsonb, true)
      `, [operator, plan.organization.id, AUDIT_ACTION, change.id,
        JSON.stringify({ planSha256: digest, username: change.username, before: change.before, after: change.after, reason })])
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
    const describe = { organization: plan.organization, planSha256: digest, changes: plan.changes }
    if (!process.argv.includes("--commit")) {
      console.log(JSON.stringify({ mode: "DRY_RUN", ...describe,
        requiredCommitArguments: ["--commit", `--confirm-plan-sha256=${digest}`, "--operator=<your email>", "--reason=<why>"] }, null, 2))
      return
    }
    const operator = arg("--operator")
    const reason = arg("--reason")
    assert(operator && /.@./.test(operator), "--operator=<your email> is required so the audit trail names a person")
    assert(reason, "--reason=<why> is required so the audit trail says why the address changed")
    assert(arg("--confirm-plan-sha256") === digest,
      `--confirm-plan-sha256 does not match the current plan (${digest}). Re-run the preflight and pass the digest it prints.`)
    await commit(client, plan, digest, operator, reason)
    console.log(JSON.stringify({ mode: "COMMITTED", ...describe, operator, reason }, null, 2))
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
