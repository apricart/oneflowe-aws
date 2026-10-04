#!/usr/bin/env tsx
/**
 * Creates the pair of multi-branch accounts a person needs to run several
 * branches at once — a GROUP_USER (approves) and a GROUP_ORDER_PORTAL
 * (orders) — with the given branches assigned individually, on top of an
 * email that already belongs to that person's mirrored per-branch accounts.
 *
 * The Users API cannot do this: it refuses an email that is already
 * registered, and a mirrored person's email is on every one of their
 * accounts. The pair is therefore written here, and marked with an
 * `external_source` so that — exactly like the accounts it sits beside — it
 * can sign in by username only; an email shared by twenty accounts cannot say
 * which one is meant. The marker carries no legacy id, so `sync:ke` neither
 * recognises nor touches the pair. Nothing existing is changed.
 *
 * Passwords are generated, printed once by the commit, and must be changed on
 * first sign-in. Default mode is a read-only preflight. Commit is
 * checksum-gated, runs in one transaction, re-verifies every row under lock,
 * and writes a `system_logs` entry per account.
 *
 *   npm run create:group-accounts -- --organization-code=0001 --email=person@example.com \
 *     --full-name="Full Name" --approver-username=first.last-group --orderer-username=first.last-group-op \
 *     --branch-ids=156,157,158
 *   npm run create:group-accounts -- ... --commit --confirm-plan-sha256=<digest> --operator=you@example.com
 */

import { createHash } from "node:crypto"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import { generateImportPassword, hashImportPassword } from "../lib/password-cli"
import { canonicalJson } from "../lib/user-name-correction"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ADVISORY_LOCK = 700015
const AUDIT_ACTION = "USER_GROUP_PAIR_CREATE"
/**
 * Marks the pair username-only, like its mirrored siblings; never a legacy
 * identity. The schema requires an id with the source, so the shared email —
 * the very thing that makes email login ambiguous — is the id.
 */
const EXTERNAL_SOURCE = "SHARED_EMAIL"
const USERNAME_SHAPE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const ROLES = { approver: "GROUP_USER", orderer: "GROUP_ORDER_PORTAL" } as const

type JsonRow = Record<string, unknown>
type Slot = keyof typeof ROLES

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

interface Branch { id: number; name: string; code: string | null; status: string | null }

interface Plan {
  organization: { id: number; code: string; name: string }
  email: string
  fullName: string
  firstName: string
  lastName: string
  /** The person's existing accounts on this email — evidence it is theirs. */
  siblings: { username: string; role: string; branch: string | null }[]
  accountsInOtherOrganizations: number
  accounts: Record<Slot, { username: string; role: string; roleId: number }>
  branches: Branch[]
}

async function loadPlan(client: PoolClient): Promise<Plan> {
  const code = arg("--organization-code")
  const email = arg("--email")?.trim().toLowerCase()
  const fullName = arg("--full-name")?.trim()
  const usernames = { approver: arg("--approver-username"), orderer: arg("--orderer-username") }
  const branchIdsArg = arg("--branch-ids")
  assert(code && email && fullName && usernames.approver && usernames.orderer && branchIdsArg,
    "--organization-code, --email, --full-name, --approver-username, --orderer-username and --branch-ids are all required")
  for (const username of Object.values(usernames)) {
    assert(USERNAME_SHAPE.test(username ?? ""), `Username ${JSON.stringify(username)} must be lowercase letters, digits and single separators`)
  }
  assert(usernames.approver !== usernames.orderer, "The two usernames must differ")
  const branchIds = [...new Set(branchIdsArg.split(",").map((value) => Number(value.trim())))]
  assert(branchIds.length > 0 && branchIds.every((id) => Number.isInteger(id) && id > 0),
    "--branch-ids must be a comma-separated list of branch ids")

  const [org] = await rows<JsonRow>(client, "select id, code, name from organizations where code = $1", [code])
  assert(org, `No organization with code ${code}`)
  const organization = { id: Number(org.id), code: String(org.code), name: String(org.name) }

  // The email must already be the person's: a brand-new person goes through
  // the Users API, which enforces uniqueness and sends the welcome mail.
  const siblings = await rows<JsonRow>(client, `
    select u.username, r.name as role, b.name as branch, u.external_source
      from users u join roles r on r.id = u.role_id left join branches b on b.id = u.branch_id
     where u.organization_id = $1 and lower(u.email) = $2 and u.deleted_at is null
     order by u.username
  `, [organization.id, email])
  assert(siblings.length > 0, `No existing account carries ${email} in ${organization.name}; create a new person through the Users page instead`)
  assert(siblings.every((row) => row.external_source != null),
    `${email} is on an account that signs in by email; adding a second account behind it would make that login ambiguous`)
  const heldRoles = new Set(siblings.map((row) => String(row.role)))
  for (const role of Object.values(ROLES)) {
    assert(!heldRoles.has(role), `${email} already has a ${role} account (${siblings.find((row) => row.role === role)?.username})`)
  }
  // Another tenant may legitimately mirror the same people (K-E-Demo does);
  // those rows are reported for the record and never touched.
  const [other] = await rows<JsonRow>(client,
    "select count(*)::int as n from users where lower(email) = $1 and organization_id <> $2 and deleted_at is null", [email, organization.id])

  for (const username of Object.values(usernames)) {
    const [holder] = await rows<JsonRow>(client, `
      select 'user' as kind from users where username = $1
      union all select 'employee' from employee_credentials where username = $1
    `, [username])
    assert(!holder, `Username ${JSON.stringify(username)} is already taken`)
  }

  const roleRows = await rows<JsonRow>(client, "select id, name from roles where name = any($1::text[])", [Object.values(ROLES)])
  const roleId = (name: string) => {
    const row = roleRows.find((r) => r.name === name)
    assert(row, `Role ${name} is missing; run db:seed`)
    return Number(row.id)
  }

  const branches = await rows<Branch>(client, `
    select id, name, code, status from branches where organization_id = $1 and id = any($2::int[]) order by id
  `, [organization.id, branchIds])
  const missing = branchIds.filter((id) => !branches.some((b) => b.id === id))
  assert(missing.length === 0, `Branch ids not in ${organization.name}: ${missing.join(", ")}`)
  const inactive = branches.filter((b) => b.status !== "active")
  assert(inactive.length === 0, `Inactive branches: ${inactive.map((b) => `${b.id} ${b.name}`).join(", ")}`)

  const [firstName, ...rest] = fullName.split(/\s+/)
  return {
    organization,
    email,
    fullName,
    firstName,
    lastName: rest.join(" "),
    siblings: siblings.map((row) => ({ username: String(row.username), role: String(row.role), branch: (row.branch as string | null) ?? null })),
    accountsInOtherOrganizations: Number(other?.n ?? 0),
    accounts: {
      approver: { username: usernames.approver, role: ROLES.approver, roleId: roleId(ROLES.approver) },
      orderer: { username: usernames.orderer, role: ROLES.orderer, roleId: roleId(ROLES.orderer) },
    },
    branches,
  }
}

function digestOf(plan: Plan): string {
  return createHash("sha256").update(canonicalJson({
    organizationId: plan.organization.id,
    email: plan.email,
    fullName: plan.fullName,
    accounts: Object.fromEntries(Object.entries(plan.accounts).map(([slot, a]) => [slot, { username: a.username, role: a.role }])),
    branchIds: plan.branches.map((b) => b.id),
  })).digest("hex")
}

function describe(plan: Plan, digest: string): JsonRow {
  return {
    organization: plan.organization,
    planSha256: digest,
    email: plan.email,
    fullName: plan.fullName,
    existingAccountsOnThisEmail: plan.siblings,
    accountsInOtherOrganizations: plan.accountsInOtherOrganizations,
    create: Object.values(plan.accounts).map((a) => ({
      username: a.username, role: a.role, branch: null, externalIdentity: `${EXTERNAL_SOURCE}/${plan.email}`, mustChangePassword: true,
    })),
    assignBranches: plan.branches.map((b) => ({ id: b.id, code: b.code, name: b.name })),
    note: "Both accounts sign in by username only. Existing accounts are not changed.",
  }
}

async function commit(client: PoolClient, plan: Plan, digest: string, operator: string): Promise<Record<Slot, { username: string; password: string }>> {
  const passwords = { approver: generateImportPassword(), orderer: generateImportPassword() }
  const hashes = { approver: await hashImportPassword(passwords.approver), orderer: await hashImportPassword(passwords.orderer) }

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    // Re-check under the lock: a username or role claimed since the preflight
    // must abort rather than half-apply.
    const usernames = Object.values(plan.accounts).map((a) => a.username)
    const [taken] = await rows<JsonRow>(client, `
      select count(*)::int as n from (
        select username from users where username = any($1::text[])
        union all select username from employee_credentials where username = any($1::text[])
      ) t
    `, [usernames])
    assert(Number(taken?.n) === 0, "A username was taken since the plan was built; aborting")
    const [held] = await rows<JsonRow>(client, `
      select count(*)::int as n from users u join roles r on r.id = u.role_id
       where u.organization_id = $1 and lower(u.email) = $2 and u.deleted_at is null and r.name = any($3::text[])
    `, [plan.organization.id, plan.email, Object.values(ROLES)])
    assert(Number(held?.n) === 0, "A group-role account appeared on this email since the plan was built; aborting")
    const live = await rows<JsonRow>(client,
      "select id from branches where organization_id = $1 and id = any($2::int[]) and status = 'active' for share",
      [plan.organization.id, plan.branches.map((b) => b.id)])
    assert(live.length === plan.branches.length, "A branch changed since the plan was built; aborting")

    for (const slot of Object.keys(plan.accounts) as Slot[]) {
      const account = plan.accounts[slot]
      const [created] = await rows<JsonRow>(client, `
        insert into users
          (email, username, password_hash, role_id, is_active, full_name, first_name, last_name,
           organization_id, branch_id, must_change_password, external_source, external_id)
        values ($1, $2, $3, $4, true, $5, $6, $7, $8, null, true, $9, $1)
        returning id
      `, [plan.email, account.username, hashes[slot], account.roleId, plan.fullName, plan.firstName, plan.lastName || null,
        plan.organization.id, EXTERNAL_SOURCE])
      const userId = String(created.id)
      // Same rows replaceMultiBranchScope() writes for a portal-created group user.
      for (const branch of plan.branches) {
        await client.query(`
          insert into user_branch_assignments (user_id, branch_id, organization_id, created_by_user_id)
          values ($1, $2, $3, null)
        `, [userId, branch.id, plan.organization.id])
      }
      await client.query(`
        insert into system_logs (user_id, user_role, user_email, organization_id, action, resource_type, resource_id, details, success)
        values (null, 'SUPER_ADMIN', $1, $2, $3, 'user', $4, $5::jsonb, true)
      `, [operator, plan.organization.id, AUDIT_ACTION, userId, JSON.stringify({
        planSha256: digest, createdUserEmail: plan.email, createdUserUsername: account.username, createdUserRole: account.role,
        createdUserOrgId: plan.organization.id, createdUserBranchId: null, assignedBranchIds: plan.branches.map((b) => b.id),
      })])
    }
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }
  return {
    approver: { username: plan.accounts.approver.username, password: passwords.approver },
    orderer: { username: plan.accounts.orderer.username, password: passwords.orderer },
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
    assert(operator && /.@./.test(operator), "--operator=<your email> is required so the audit trail names a person")
    assert(arg("--confirm-plan-sha256") === digest,
      `--confirm-plan-sha256 does not match the current plan (${digest}). Re-run the preflight and pass the digest it prints.`)
    const credentials = await commit(client, plan, digest, operator)
    console.log(JSON.stringify({ mode: "COMMITTED", ...describe(plan, digest), operator }, null, 2))
    // Printed once, never stored: hand these over out of band.
    console.log("\nInitial passwords (must be changed at first sign-in):")
    for (const { username, password } of Object.values(credentials)) console.log(`  ${username}\t${password}`)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
