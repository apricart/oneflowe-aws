#!/usr/bin/env tsx
/**
 * Turns one mistakenly-created Branch Admin / Order Portal pair into the single
 * HEAD_OFFICE account the person should have had: the account named by --keep
 * becomes HEAD_OFFICE with no branch and the username given by --username; the
 * account named by --remove is soft-deleted the way `DELETE /api/v1/users/:id`
 * does. The external identity stays on the kept account so `sync:ke` still
 * recognises the person, and because that account carries no branch the sync
 * will not backfill a portal pair for them.
 *
 * Refuses if either account has any activity (orders raised or decided, audit
 * rows) — such an account is not a mistake to undo but a history to keep.
 *
 * Default mode is a read-only preflight. Commit is checksum-gated, runs in one
 * transaction, re-verifies both rows under lock, and writes a `system_logs`
 * entry per account.
 *
 *   npm run fix:head-office -- --organization-code=0001 --keep=head-1734549-ba --remove=head-1734549-op --username=head-1734549
 *   npm run fix:head-office -- ... --commit --confirm-plan-sha256=<digest> --operator=you@example.com
 */

import { createHash } from "node:crypto"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import { canonicalJson } from "../lib/user-name-correction"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ADVISORY_LOCK = 700014
const AUDIT_ACTION = "USER_HEAD_OFFICE_CONVERSION"
const USERNAME_SHAPE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/

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

interface Account {
  id: string
  email: string
  username: string
  role: string
  branch: string | null
  branchId: number | null
  externalSource: string | null
  externalId: string | null
  isActive: boolean
  activity: { ordersRaised: number; ordersDecided: number; auditRows: number }
}

async function readAccount(client: PoolClient, organizationId: number, username: string): Promise<Account> {
  const [row] = await rows<JsonRow>(client, `
    select u.id, u.email, u.username, r.name as role, b.name as branch, u.branch_id, u.external_source, u.external_id, u.is_active,
           (select count(*) from orders o where o.created_by_user_id = u.id) as orders_raised,
           (select count(*) from orders o where o.approved_by_user_id = u.id or o.rejected_by_user_id = u.id
               or o.fulfilled_by_user_id = u.id or o.refunded_by_user_id = u.id or o.paid_by_user_id = u.id) as orders_decided,
           (select count(*) from system_logs s where s.user_id = u.id::text) as audit_rows
      from users u
      join roles r on r.id = u.role_id
      left join branches b on b.id = u.branch_id
     where u.organization_id = $1 and u.username = $2 and u.deleted_at is null
  `, [organizationId, username])
  assert(row, `No active account ${JSON.stringify(username)} in organization ${organizationId}`)
  return {
    id: String(row.id),
    email: String(row.email),
    username: String(row.username),
    role: String(row.role),
    branch: (row.branch as string | null) ?? null,
    branchId: row.branch_id == null ? null : Number(row.branch_id),
    externalSource: (row.external_source as string | null) ?? null,
    externalId: (row.external_id as string | null) ?? null,
    isActive: Boolean(row.is_active),
    activity: { ordersRaised: Number(row.orders_raised), ordersDecided: Number(row.orders_decided), auditRows: Number(row.audit_rows) },
  }
}

interface Plan {
  organization: { id: number; code: string; name: string }
  keep: Account & { after: { role: "HEAD_OFFICE"; branch: null; username: string } }
  remove: Account
}

async function loadPlan(client: PoolClient): Promise<Plan> {
  const code = arg("--organization-code")
  const keepUsername = arg("--keep")
  const removeUsername = arg("--remove")
  const username = arg("--username")
  assert(code && keepUsername && removeUsername && username,
    "--organization-code, --keep=<username>, --remove=<username> and --username=<new username> are all required")
  assert(USERNAME_SHAPE.test(username), `--username ${JSON.stringify(username)} must be lowercase letters, digits and single separators`)
  assert(keepUsername !== removeUsername, "--keep and --remove name the same account")

  const [org] = await rows<JsonRow>(client, "select id, code, name from organizations where code = $1", [code])
  assert(org, `No organization with code ${code}`)
  const organization = { id: Number(org.id), code: String(org.code), name: String(org.name) }

  const keep = await readAccount(client, organization.id, keepUsername)
  const remove = await readAccount(client, organization.id, removeUsername)
  assert(keep.email.toLowerCase() === remove.email.toLowerCase(),
    `The two accounts carry different emails (${keep.email} / ${remove.email}); they are not one person's pair`)
  for (const account of [keep, remove]) {
    const { ordersRaised, ordersDecided, auditRows } = account.activity
    assert(ordersRaised === 0 && ordersDecided === 0 && auditRows === 0,
      `Account ${account.username} has activity (raised ${ordersRaised}, decided ${ordersDecided}, audit ${auditRows}); refusing to treat it as a mistake`)
  }
  assert(keep.role !== "HEAD_OFFICE", `${keep.username} is already HEAD_OFFICE`)

  const [holder] = await rows<JsonRow>(client, "select id from users where username = $1 and id <> $2", [username, keep.id])
  assert(!holder, `Username ${JSON.stringify(username)} is already held by account ${holder?.id}`)

  return { organization, keep: { ...keep, after: { role: "HEAD_OFFICE", branch: null, username } }, remove }
}

function digestOf(plan: Plan): string {
  const { keep, remove } = plan
  return createHash("sha256").update(canonicalJson({
    keep: { id: keep.id, from: { role: keep.role, branchId: keep.branchId, username: keep.username }, to: keep.after },
    remove: { id: remove.id, username: remove.username, role: remove.role },
  })).digest("hex")
}

function describe(plan: Plan, digest: string): JsonRow {
  return {
    organization: plan.organization,
    planSha256: digest,
    keep: {
      id: plan.keep.id, email: plan.keep.email, externalIdentity: `${plan.keep.externalSource}/${plan.keep.externalId}`,
      before: { role: plan.keep.role, branch: plan.keep.branch, username: plan.keep.username },
      after: plan.keep.after,
    },
    remove: { id: plan.remove.id, role: plan.remove.role, branch: plan.remove.branch, username: plan.remove.username, action: "soft delete" },
    note: "External identity stays on the kept account, which carries no branch, so sync:ke recognises the person and does not backfill a portal pair.",
  }
}

async function commit(client: PoolClient, plan: Plan, digest: string, operator: string): Promise<void> {
  const roleRow = (await rows<JsonRow>(client, "select id from roles where name = 'HEAD_OFFICE'"))[0]
  assert(roleRow, "HEAD_OFFICE role is missing")
  const headOfficeRoleId = Number(roleRow.id)

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    const locked = await rows<JsonRow>(client, `
      select u.id, u.username, r.name as role, u.branch_id
        from users u join roles r on r.id = u.role_id
       where u.id = any($1::uuid[]) and u.organization_id = $2 and u.deleted_at is null
       for update of u
    `, [[plan.keep.id, plan.remove.id], plan.organization.id])
    assert(locked.length === 2, "One of the accounts changed or vanished since the plan was built")
    for (const account of [plan.keep, plan.remove]) {
      const current = locked.find((row) => String(row.id) === account.id)
      assert(current && String(current.username) === account.username && String(current.role) === account.role,
        `Account ${account.username} changed since the plan was built; aborting`)
    }

    const converted = await client.query(`
      update users set role_id = $2, branch_id = null, username = $3, updated_at = now()
       where id = $1 and username = $4
    `, [plan.keep.id, headOfficeRoleId, plan.keep.after.username, plan.keep.username])
    assert(converted.rowCount === 1, "Conversion did not apply")

    const removed = await client.query(`
      update users set deleted_at = now(), is_active = false, email = $2, updated_at = now()
       where id = $1 and username = $3 and deleted_at is null
    `, [plan.remove.id, `deleted_${Date.now()}_${plan.remove.email}`, plan.remove.username])
    assert(removed.rowCount === 1, "Soft delete did not apply")
    await client.query("delete from mfa_codes where user_id = $1", [plan.remove.id])
    await client.query("delete from sessions where user_id = $1", [plan.remove.id])
    await client.query("delete from notifications where user_id = $1", [plan.remove.id])

    for (const [userId, details] of [
      [plan.keep.id, { planSha256: digest, before: { role: plan.keep.role, branch: plan.keep.branch, username: plan.keep.username }, after: plan.keep.after }],
      [plan.remove.id, { planSha256: digest, action: "soft delete", reason: "duplicate portal account for a HEAD_OFFICE person", username: plan.remove.username, role: plan.remove.role }],
    ] as const) {
      await client.query(`
        insert into system_logs (user_id, user_role, user_email, organization_id, action, resource_type, resource_id, details, success)
        values (null, 'SUPER_ADMIN', $1, $2, $3, 'user', $4, $5::jsonb, true)
      `, [operator, plan.organization.id, AUDIT_ACTION, userId, JSON.stringify(details)])
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
    if (!process.argv.includes("--commit")) {
      console.log(JSON.stringify({ mode: "DRY_RUN", ...describe(plan, digest),
        requiredCommitArguments: ["--commit", `--confirm-plan-sha256=${digest}`, "--operator=<your email>"] }, null, 2))
      return
    }
    const operator = arg("--operator")
    assert(operator && /.+@.+/.test(operator), "--operator=<your email> is required so the audit trail names a person")
    assert(arg("--confirm-plan-sha256") === digest,
      `--confirm-plan-sha256 does not match the current plan (${digest}). Re-run the preflight and pass the digest it prints.`)
    await commit(client, plan, digest, operator)
    console.log(JSON.stringify({ mode: "COMMITTED", ...describe(plan, digest), operator }, null, 2))
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
